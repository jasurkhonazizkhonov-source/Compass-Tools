import { createHash } from "node:crypto";
import { headers as nextHeaders } from "next/headers";
import { prisma } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import { resolveSignInContext } from "@/server/auth/sign-in-context";
import {
  FAILED_SIGNIN_DUPLICATE_WINDOW_MS,
  FAILED_SIGNIN_LIMIT_PER_IP,
  FAILED_SIGNIN_LIMIT_WINDOW_MS,
  type FailedSignInMethod,
  type FailedSignInReason,
} from "@/lib/failed-signin";

// Records ONE security event per actual failed authentication attempt. Called from the trusted server-side points of the sign-in flow (actions/google-auth.ts).
//
//  - Identity: only what the authentication provider VERIFIED is stored as verified (verifiedEmail / verifiedFullName). attemptedEmail is for an identifier whose
//    owner could not be verified. Nothing is ever parsed out of an unverified credential, and a name is never invented from an email address.
//  - Secrets: no password, token, cookie or credential is stored. The credential only feeds a hash PREFIX used to recognise a duplicate delivery of the same attempt.
//  - IP: the trusted-path address (lib/request-ip.ts: honours TRUSTED_PROXY, ignores forged forwarding headers), complete and canonical; location is the existing
//    approximate lookup and is optional - a failed lookup never prevents the event.
//  - Flooding: at most FAILED_SIGNIN_LIMIT_PER_IP individual rows per address per window; further attempts are folded into ONE roll-up row with a count, so volume is
//    bounded but no attempt is silently invisible.
//  - It NEVER throws: a failure to record must not change the sign-in outcome.

const control = /[\u0000-\u001f\u007f]/g;
function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.replace(control, " ").trim().slice(0, max);
  return v.length ? v : null;
}

export type FailedSignInInput = {
  method: FailedSignInMethod;
  reasonCode: FailedSignInReason;
  /** The raw credential presented (e.g. the Google ID token): used ONLY to derive a short hash for duplicate-delivery detection; never stored. */
  credential?: string;
  verifiedEmail?: string | null;
  verifiedFullName?: string | null;
  attemptedEmail?: string | null;
  headers?: Headers;
  now?: Date;
};

export async function recordFailedSignIn(input: FailedSignInInput): Promise<void> {
  try {
    const now = input.now ?? new Date();
    const h = input.headers ?? (await nextHeaders());
    const ctx = await resolveSignInContext(h);
    const verifiedEmail = clean(input.verifiedEmail, 254)?.toLowerCase() ?? null;
    const attemptKey = input.credential ? createHash("sha256").update(input.credential).digest("hex").slice(0, 32) : null;

    if (attemptKey) {
      const duplicate = await prisma.failedSignInEvent.findFirst({
        where: { attemptKey, occurredAt: { gte: new Date(now.getTime() - FAILED_SIGNIN_DUPLICATE_WINDOW_MS) } },
        select: { id: true },
      });
      if (duplicate) return; // the same attempt delivered again (a retried callback), not a new one
    }

    const account = verifiedEmail ? await prisma.account.findFirst({ where: { email: { equals: verifiedEmail, mode: "insensitive" } }, select: { companyId: true } }) : null;

    const since = new Date(now.getTime() - FAILED_SIGNIN_LIMIT_WINDOW_MS);
    const sameAddress = { ipAddress: ctx.ip ?? null, occurredAt: { gte: since } };
    const recent = await prisma.failedSignInEvent.count({ where: { ...sameAddress, NOT: { reasonCode: "EVENTS_SUPPRESSED" } } });
    if (recent >= FAILED_SIGNIN_LIMIT_PER_IP) {
      const rollup = await prisma.failedSignInEvent.findFirst({ where: { ...sameAddress, reasonCode: "EVENTS_SUPPRESSED" }, select: { id: true } });
      if (rollup) await prisma.failedSignInEvent.update({ where: { id: rollup.id }, data: { repeatCount: { increment: 1 }, occurredAt: now } });
      else
        await prisma.failedSignInEvent.create({
          data: { occurredAt: now, method: input.method, reasonCode: "EVENTS_SUPPRESSED", ipAddress: ctx.ip, ipVersion: ctx.ip ? (ctx.ip.includes(":") ? "v6" : "v4") : null, repeatCount: 1, ...locationColumns(ctx) },
        });
      return;
    }

    await prisma.failedSignInEvent.create({
      data: {
        occurredAt: now,
        companyId: account?.companyId ?? null,
        method: input.method,
        reasonCode: input.reasonCode,
        attemptedEmail: clean(input.attemptedEmail, 254),
        verifiedEmail,
        verifiedFullName: clean(input.verifiedFullName, 200),
        ipAddress: ctx.ip,
        ipVersion: ctx.ip ? (ctx.ip.includes(":") ? "v6" : "v4") : null,
        attemptKey,
        ...locationColumns(ctx),
      },
    });
  } catch (err) {
    // Category only - an error object can carry a connection string or an address.
    console.error(`[failed-sign-in] could not record an event (${safeErrorTag(err)})`);
  }
}

function locationColumns(ctx: { city: string | null; region: string | null; country: string | null; countryCode: string | null; locationSource: string | null }) {
  return { city: clean(ctx.city, 120), region: clean(ctx.region, 120), country: clean(ctx.country, 120), countryCode: clean(ctx.countryCode, 2), geoSource: clean(ctx.locationSource, 120) };
}
