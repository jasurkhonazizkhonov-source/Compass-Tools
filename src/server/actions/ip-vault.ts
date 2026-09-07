"use server";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canRevealBookingIp } from "@/lib/permissions";
import { bookingVisibilityWhere } from "@/server/visibility";
import { requireRecentAuthentication } from "@/server/security/privileged-access";
import { getClientIp, trustedProxyMode } from "@/lib/request-ip";
import { decryptIp, maskIp } from "@/server/security/ip-encryption";

const GENERIC_DENIAL = "You are not authorized to search the IP vault";

// Same category of access as revealBookingIp (booking-security.ts) — a
// signer's IP, whether viewed one booking at a time or across its full
// history, so it's gated by the exact same permission rather than a new
// one. There is no distinct "Fraud Prevention Team" role in this app's
// AccountRole enum (ADMIN/TRAVEL_AGENT/TICKETING_AGENT/FLIGHT_EXPERT/
// MANAGER/MARKETING_AGENT — confirmed against the actual schema); ADMIN/
// MANAGER/TICKETING_AGENT (canRevealBookingIp's existing eligible roles)
// already cover exactly the "back-office fraud/chargeback review" roles
// this was built for, so no new role or migration was added for this.
//
// This module previously also backed a standalone, cross-booking "IP
// Vault" search/browse page (search-by-IP-or-email, CSV export, bulk
// suspicious-flagging, its own access audit log). That page and its
// vault-only server actions/queries were removed as a dedicated feature;
// the functions below are the subset that the per-booking "Submission IP"
// UI on the Booking detail page (BookingIpReveal, booking-ip-reveal.tsx)
// still legitimately depends on, and are kept here unchanged.

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ACTIONS = 20;

const IP_VAULT_ACTIONS = ["IP_VAULT_HISTORY_VIEWED"] as const;

async function checkIpVaultRateLimit(actorId: string): Promise<boolean> {
  const count = await prisma.auditLog.count({
    where: {
      actorId,
      action: { in: [...IP_VAULT_ACTIONS, "BOOKING_IP_REVEALED"] },
      createdAt: { gte: new Date(Date.now() - RATE_LIMIT_WINDOW_MS) },
    },
  });
  return count < RATE_LIMIT_MAX_ACTIONS;
}

async function auditIpVaultAccess(params: {
  actorId: string | undefined;
  action: (typeof IP_VAULT_ACTIONS)[number];
  entityId: string;
  success: boolean;
  reason?: string;
  resultCount?: number;
}) {
  let requestingIp: string | undefined;
  try {
    requestingIp = getClientIp(await headers());
  } catch {
    // headers() can throw outside a request context — audit logging must never block on it.
  }
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId,
      action: params.success ? params.action : `${params.action}_DENIED`,
      entityType: "IpCapture",
      entityId: params.entityId,
      metadata: {
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        resultCount: params.resultCount ?? null,
        requestingIp: requestingIp ?? null,
      },
    },
  });
}

async function authorizeIpVaultAccess(entityId: string, action: (typeof IP_VAULT_ACTIONS)[number]) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") {
    await auditIpVaultAccess({ actorId: actor?.id, action, entityId, success: false, reason: "NO_ACTIVE_SESSION" });
    throw new Error(GENERIC_DENIAL);
  }
  if (!canRevealBookingIp(actor)) {
    await auditIpVaultAccess({ actorId: actor.id, action, entityId, success: false, reason: "MISSING_PERMISSION" });
    throw new Error(GENERIC_DENIAL);
  }
  const withinLimit = await checkIpVaultRateLimit(actor.id);
  if (!withinLimit) {
    await auditIpVaultAccess({ actorId: actor.id, action, entityId, success: false, reason: "RATE_LIMITED" });
    throw new Error("Too many IP lookups in a short period — please wait a few minutes and try again");
  }
  const stepUp = requireRecentAuthentication();
  if (!stepUp.ok) {
    await auditIpVaultAccess({ actorId: actor.id, action, entityId, success: false, reason: stepUp.reason });
    throw new Error(GENERIC_DENIAL);
  }
  return actor;
}

export type IpVaultEntry = {
  id: string;
  ipAddress: string;
  ipVersion: string;
  formType: string;
  signerName: string | null;
  signerEmail: string | null;
  userAgent: string | null;
  capturedAt: Date;
  riskScore: number;
  suspicious: boolean;
  notes: string | null;
  booking: { id: string; bookingReference: string } | null;
};

const IP_VAULT_ENTRY_SELECT = {
  id: true,
  encryptedIp: true,
  ipVersion: true,
  formType: true,
  signerName: true,
  signerEmail: true,
  userAgent: true,
  capturedAt: true,
  riskScore: true,
  suspicious: true,
  notes: true,
  booking: { select: { id: true, bookingReference: true } },
} as const;

type IpVaultRow = {
  id: string;
  encryptedIp: string;
  ipVersion: string;
  formType: string;
  signerName: string | null;
  signerEmail: string | null;
  userAgent: string | null;
  capturedAt: Date;
  riskScore: number;
  suspicious: boolean;
  notes: string | null;
  booking: { id: string; bookingReference: string } | null;
};

function toIpVaultEntry(r: IpVaultRow): IpVaultEntry {
  return {
    id: r.id,
    ipAddress: decryptIp(r.encryptedIp),
    ipVersion: r.ipVersion,
    formType: r.formType,
    signerName: r.signerName,
    signerEmail: r.signerEmail,
    userAgent: r.userAgent,
    capturedAt: r.capturedAt,
    riskScore: r.riskScore,
    suspicious: r.suspicious,
    notes: r.notes,
    booking: r.booking,
  };
}

/**
 * Complete signing-event IP history for one specific booking (every
 * NEW_BOOKING/EXCHANGE_BOOKING/CANCELLATION_CONFIRMATION row captured
 * against it, not just the latest) — same permission/IDOR/step-up/audit
 * gating as revealBookingIp, extended to return every event rather than
 * only the original Signature. Used by BookingIpReveal's "View full IP
 * history" panel on the Booking detail page.
 */
export async function getIpHistoryForBooking(bookingId: string): Promise<IpVaultEntry[]> {
  const actor = await authorizeIpVaultAccess(bookingId, "IP_VAULT_HISTORY_VIEWED");

  const booking = await prisma.booking.findFirst({ where: { id: bookingId, ...bookingVisibilityWhere(actor) }, select: { id: true } });
  if (!booking) {
    await auditIpVaultAccess({ actorId: actor.id, action: "IP_VAULT_HISTORY_VIEWED", entityId: bookingId, success: false, reason: "BOOKING_NOT_ACCESSIBLE" });
    throw new Error(GENERIC_DENIAL);
  }

  const rows = await prisma.ipCapture.findMany({
    where: { bookingId, softDeletedAt: null },
    select: IP_VAULT_ENTRY_SELECT,
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
  });

  await auditIpVaultAccess({ actorId: actor.id, action: "IP_VAULT_HISTORY_VIEWED", entityId: bookingId, success: true, resultCount: rows.length });

  return rows.map(toIpVaultEntry);
}

/**
 * Non-privileged masked preview for a booking's captured IP(s) — visible
 * to ANY authenticated staff account who can already see the booking at
 * all (ordinary bookingVisibilityWhere row-level scope, not the stricter
 * canRevealBookingIp gate). Not rate-limited or step-up gated — it
 * discloses a /8 (IPv4) or /16 (IPv6) block at most. Not audit-logged for
 * the same reason revealBookingIp's own denial path isn't logged per
 * masked view — only an actual full-value reveal is a privileged event
 * worth an audit row.
 */
export type IpVaultMaskedPreview =
  | { masked: string; count: number; ipVersion: "v4" | "v6"; reason?: undefined }
  | { masked: null; count: 0; ipVersion?: undefined; reason: string };

export async function getBookingIpMaskedPreview(bookingId: string): Promise<IpVaultMaskedPreview | null> {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") return null;
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, ...bookingVisibilityWhere(actor) }, select: { id: true } });
  if (!booking) return null;

  const latest = await prisma.ipCapture.findFirst({
    where: { bookingId, softDeletedAt: null },
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    select: { encryptedIp: true, ipVersion: true },
  });
  const count = await prisma.ipCapture.count({ where: { bookingId, softDeletedAt: null } });
  if (!latest) {
    // Distinguishes the common local-dev/no-reverse-proxy case (see
    // request-ip.ts's own module comment) from any other reason nothing
    // was captured, so the UI can explain rather than just say "missing".
    const reason =
      trustedProxyMode() === "none"
        ? 'No trusted reverse proxy is configured for this environment (TRUSTED_PROXY is unset) — see docs/DEPLOYMENT.md (section 5, "Set TRUSTED_PROXY").'
        : "No IP address was captured for this booking's signing event.";
    return { masked: null, count: 0, reason };
  }

  const plain = decryptIp(latest.encryptedIp);
  const ipVersion = latest.ipVersion === "v6" ? "v6" : "v4";
  return { masked: maskIp(plain, ipVersion), count, ipVersion };
}
