"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewGetInTouch, canRevealBookingIp } from "@/lib/permissions";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getClientIp } from "@/lib/request-ip";
import type { InquirySource } from "@/generated/prisma/client";

const GENERIC_DENIAL = "You are not authorized to reveal this inquiry's submission IP";
const SOURCES = z.enum(["BUSINESS_FLIGHTS_WEBSITE", "CRM_WEBSITE"]);

export type InquiryIpRevealResult = { ipAddress: string; ipVersion: "v4" | "v6" } | { error: string };

async function audit(params: { actorId: string | undefined; inquiryId: string; success: boolean; reason?: string }) {
  let requestingIp: string | undefined;
  try {
    requestingIp = getClientIp(await headers());
  } catch {
    // headers() can throw outside a request context - audit logging must never block on it.
  }
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.success ? "INQUIRY_IP_REVEALED" : "INQUIRY_IP_REVEAL_DENIED",
      entityType: "ContactInquiry",
      entityId: params.inquiryId,
      // Never the revealed address - only who asked (and from where) and why a request was refused.
      metadata: { result: params.success ? "SUCCESS" : "DENIED", reason: params.reason ?? null, requestingIp: requestingIp ?? null },
    },
  });
}

/**
 * Privileged reveal of the full IP address a public inquiry was submitted from. Same gate as a lead's / a booking signer's IP, plus the inbox's own
 * Admin-only rule:
 *   - an active, signed-in ADMIN (the inboxes are Admin-only: canViewGetInTouch) who also holds the IP-reveal permission;
 *   - the inquiry belongs to the viewer's own company AND to the inbox named by `source` (evaluated by the database against the requested id -
 *     IDOR-safe; an id from the other inbox or company is indistinguishable from "nothing captured");
 *   - a sign-in within the last 15 minutes (requireRecentLogin), returned as an actionable message because a thrown one is masked in production;
 *   - a per-account rate limit counting every attempt;
 *   - an audit row for success and for every refusal, never containing the address.
 * The caller shows it briefly (useTimedReveal); nothing here persists or logs it.
 */
export async function revealInquirySubmissionIp(inquiryId: string, source: InquirySource): Promise<InquiryIpRevealResult> {
  const actor = await getCurrentAccount();
  const parsedSource = SOURCES.safeParse(source);
  const idOk = typeof inquiryId === "string" && inquiryId.length > 0 && inquiryId.length <= 100;
  if (!actor || actor.status !== "ACTIVE" || !parsedSource.success || !idOk) {
    await audit({ actorId: actor?.id, inquiryId: idOk ? inquiryId : "invalid", success: false, reason: !actor || actor.status !== "ACTIVE" ? "NO_ACTIVE_SESSION" : "INVALID_REQUEST" });
    throw new Error(GENERIC_DENIAL);
  }

  const limit = await checkAccountRateLimit(actor.id, "IP_REVEAL", RATE_LIMITS.IP_REVEAL);
  if (!limit.allowed) {
    await audit({ actorId: actor.id, inquiryId, success: false, reason: "RATE_LIMITED" });
    return { error: `Too many Reveal attempts. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.` };
  }

  if (!canViewGetInTouch(actor.role) || !canRevealBookingIp(actor)) {
    await audit({ actorId: actor.id, inquiryId, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const info = await prisma.inquirySubmissionInfo.findFirst({
    where: { inquiryId, inquiry: { companyId: actor.companyId, source: parsedSource.data } },
    select: { ipAddress: true, ipVersion: true },
  });
  if (!info) {
    // Not this company's / this inbox's inquiry, or nothing was captured - indistinguishable on purpose.
    await audit({ actorId: actor.id, inquiryId, success: false, reason: "NOT_ACCESSIBLE_OR_NOT_CAPTURED" });
    throw new Error(GENERIC_DENIAL);
  }

  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await audit({ actorId: actor.id, inquiryId, success: false, reason: stepUp.reason });
    return { error: `For security, Reveal requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.` };
  }
  if (!info.ipAddress) {
    await audit({ actorId: actor.id, inquiryId, success: false, reason: "NO_IP_CAPTURED" });
    return { error: "No IP address was recorded for this submission." };
  }

  await audit({ actorId: actor.id, inquiryId, success: true });
  return { ipAddress: info.ipAddress, ipVersion: info.ipVersion === "v6" ? "v6" : "v4" };
}
