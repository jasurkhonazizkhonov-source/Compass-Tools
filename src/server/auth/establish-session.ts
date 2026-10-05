import { randomBytes, randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { DEV_ACCOUNT_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/dev-session";
import { captureSignInContext } from "@/server/auth/sign-in-context";

// NOT a "use server" module on purpose. This used to be an exported Server Action, which makes a function reachable over the
// network by anyone able to name it — and this one takes an account id and returns a session for it. It is only ever called
// from the sign-in action AFTER Google has verified the identity and the CRM has authorized the account, so it must not be
// callable from anywhere else.

const isProd = process.env.NODE_ENV === "production";

/**
 * Issues a real CRM session for an already-authorized account. Never call this with an accountId that has not just cleared
 * Google identity verification AND the CRM's own authorization check (see actions/google-auth.ts).
 *
 * One statement, atomic, race-safe:
 *   • the account row is locked (FOR UPDATE), so two near-simultaneous sign-ins for the same account run one after the other
 *     in the order they reach the database — the LAST to commit holds the only valid token, never two;
 *   • the new token replaces the old one (single active device), and the token that was replaced is recorded by hash in
 *     RevokedSession so the old device can be told why ("signed in on another device") on its next request;
 *   • the sign-in time and the trusted-path IP / approximate location are written in the same statement — only a SUCCESSFUL
 *     sign-in ever reaches here, so a failed attempt can never overwrite the last good one, and ordinary activity never does.
 * sessionCreatedAt starts the ABSOLUTE 24-hour lifetime; nothing else ever moves it.
 */
export async function establishSession(accountId: string, headerList?: Headers) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const ctx = captureSignInContext(headerList ?? (await headers()));

  await prisma.$executeRaw`
    WITH locked AS (
      SELECT "id", "activeSessionId" AS "previous" FROM "Account" WHERE "id" = ${accountId} FOR UPDATE
    ),
    updated AS (
      UPDATE "Account" a SET
        "activeSessionId" = ${token},
        "sessionCreatedAt" = ${now},
        "lastSignInAt" = ${now},
        "lastSignInIp" = ${ctx.ip},
        "lastSignInCity" = ${ctx.city},
        "lastSignInRegion" = ${ctx.region},
        "lastSignInCountry" = ${ctx.country},
        "lastSignInCountryCode" = ${ctx.countryCode},
        "lastSignInTimeZone" = ${ctx.timeZone},
        "updatedAt" = ${now}
      FROM locked WHERE a."id" = locked."id"
      RETURNING locked."previous" AS "previous"
    )
    INSERT INTO "RevokedSession" ("id", "tokenHash", "accountId", "reason", "createdAt")
    SELECT ${randomUUID()}, encode(sha256(convert_to("previous", 'UTF8')), 'hex'), ${accountId}, 'SUPERSEDED'::"SessionRevocationReason", ${now}
      FROM updated WHERE "previous" IS NOT NULL
    ON CONFLICT ("tokenHash") DO NOTHING`;

  // Housekeeping: a revocation record only matters while the session it describes could still be valid.
  await prisma.revokedSession.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - SESSION_MAX_AGE_MS - 60 * 60 * 1000) } } }).catch(() => undefined);

  const cookieStore = await cookies();
  cookieStore.set(DEV_ACCOUNT_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000, // seconds; mirrors the server-side 24h absolute expiry as defense-in-depth, not the authoritative check
  });
  revalidatePath("/", "layout");
}
