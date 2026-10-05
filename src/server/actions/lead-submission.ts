"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealBookingIp, canViewLeadSubmissionInfo } from "@/lib/permissions";
import { leadVisibilityWhere } from "@/server/visibility";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { getClientIp } from "@/lib/request-ip";

const GENERIC_DENIAL = "You are not authorized to reveal this lead's submission IP";

export type LeadIpRevealResult = { ipAddress: string; ipVersion: "v4" | "v6" } | { error: string };

async function audit(params: { actorId: string | undefined; leadId: string; success: boolean; reason?: string }) {
  let requestingIp: string | undefined;
  try {
    requestingIp = getClientIp(await headers());
  } catch {
    // headers() can throw outside a request context — audit logging must never block on it.
  }
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.success ? "LEAD_IP_REVEALED" : "LEAD_IP_REVEAL_DENIED",
      entityType: "Lead",
      entityId: params.leadId,
      // Never the revealed address — only who asked (and from where) and why a request was refused.
      metadata: { result: params.success ? "SUCCESS" : "DENIED", reason: params.reason ?? null, requestingIp: requestingIp ?? null },
    },
  });
}

/**
 * Privileged reveal of the full IP address a lead was submitted from. The page shows only a masked
 * form (first octet / hextet) to everyone; the whole address is sensitive personal data, so it uses
 * the SAME gate as a booking signer's IP (booking-security.ts → revealBookingIp), not a looser one:
 *   • an active, signed-in account whose role has the Leads area;
 *   • the IP-reveal permission: Admin, or Manager / Ticketing with the explicit bookings.reveal_ip
 *     grant (canRevealBookingIp) — a Travel Agent never has it;
 *   • the lead is one this account may see (leadVisibilityWhere, evaluated by the database against
 *     the requested id — IDOR/BOLA-safe, and a Manager only reaches their own team's);
 *   • a sign-in within the last 15 minutes (requireRecentLogin) — returned as an actionable message,
 *     because a thrown one is masked in production;
 *   • a per-account rate limit counting every attempt;
 *   • an audit row for success and for every refusal, never containing the address.
 * The caller shows it briefly (useTimedReveal) and nothing here persists or logs it.
 */
export async function revealLeadSubmissionIp(leadId: string): Promise<LeadIpRevealResult> {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") {
    await audit({ actorId: actor?.id, leadId, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const limit = await checkAccountRateLimit(actor.id, "IP_REVEAL", RATE_LIMITS.IP_REVEAL);
  if (!limit.allowed) {
    await audit({ actorId: actor.id, leadId, success: false, reason: "RATE_LIMITED" });
    return { error: `Too many Reveal attempts. Please wait ${Math.max(1, Math.ceil(limit.retryAfterSeconds / 60))} minute(s) and try again.` };
  }

  if (!canViewLeadSubmissionInfo(actor.role) || !canRevealBookingIp(actor)) {
    await audit({ actorId: actor.id, leadId, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }

  const info = await prisma.leadSubmissionInfo.findFirst({
    where: { leadId, lead: leadVisibilityWhere(actor) },
    select: { ipAddress: true, ipVersion: true },
  });
  if (!info) {
    // Not this account's lead, or nothing was captured — indistinguishable on purpose.
    await audit({ actorId: actor.id, leadId, success: false, reason: "NOT_ACCESSIBLE_OR_NOT_CAPTURED" });
    throw new Error(GENERIC_DENIAL);
  }

  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await audit({ actorId: actor.id, leadId, success: false, reason: stepUp.reason });
    return { error: `For security, Reveal requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.` };
  }
  if (!info.ipAddress) {
    await audit({ actorId: actor.id, leadId, success: false, reason: "NO_IP_CAPTURED" });
    return { error: "No IP address was recorded for this submission." };
  }

  await audit({ actorId: actor.id, leadId, success: true });
  return { ipAddress: info.ipAddress, ipVersion: info.ipVersion === "v6" ? "v6" : "v4" };
}
