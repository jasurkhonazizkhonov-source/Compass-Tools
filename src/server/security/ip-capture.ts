// Shared internal helper — NOT a "use server" action file — used by both
// submitBooking (src/server/actions/booking.ts, covers both a first-time
// booking and an exchange's own signing step, since both flow through this
// same function) and confirmCancellationByCustomer
// (src/server/actions/cancellation.ts) to write one IpCapture "vault" row
// per signing event, and — new in this pass — compute its internal,
// no-external-API fraud risk score (see ip-risk.ts) and alert company
// Admins/Managers when it's high. Kept out of a "use server" file
// specifically because it's an internal write helper, not itself an
// action callable from the client.
import { prisma } from "@/lib/prisma";
import { isValidIpAddress, normalizeIp } from "@/lib/request-ip";
import { encryptIp, hashIpForSearch, hashSubnetForSearch } from "./ip-encryption";
import { assessRisk, HIGH_RISK_THRESHOLD, VELOCITY_WINDOW_MS } from "./ip-risk";
import type { IpCaptureFormType } from "@/generated/prisma/client";

export async function recordIpCapture(params: {
  ip: string | undefined;
  userAgent: string | undefined;
  formType: IpCaptureFormType;
  bookingId: string;
  signerName?: string | null;
  signerEmail?: string | null;
  /** Optional — needed only to route a high-risk Notification to the
   * right company's Admins/Managers and to link it to the quote. Risk is
   * still computed and stored on the row either way; omitting these two
   * simply means a high-risk capture is silently recorded without an
   * alert (better than failing the booking over a missing convenience
   * param). */
  companyId?: string | null;
  quoteId?: string | null;
}): Promise<void> {
  // Nothing to capture — matches getClientIp()'s own "undefined means no
  // trustworthy value" contract (see request-ip.ts). Never stores a
  // placeholder/garbage value just to have a row.
  if (!params.ip || !isValidIpAddress(params.ip)) return;
  // Collapses an IPv4-mapped IPv6 form ("::ffff:203.0.113.9") to plain
  // IPv4 BEFORE encrypting/hashing — otherwise the exact same real client
  // could silently produce two different stored values depending on which
  // proxy hop shaped the header, breaking exact-match search and every
  // fraud signal below (all of which key on an exact ipHash/subnetHash
  // match). See normalizeIp()'s own doc comment.
  const ip = normalizeIp(params.ip);
  if (!isValidIpAddress(ip)) return;

  try {
    const ipVersion: "v4" | "v6" = ip.includes(":") ? "v6" : "v4";
    const ipHash = hashIpForSearch(ip);
    const subnetHash = hashSubnetForSearch(ip, ipVersion);
    const windowStart = new Date(Date.now() - VELOCITY_WINDOW_MS);

    // Every fraud signal below is derived ONLY from this app's own prior
    // IpCapture rows plus the manual `suspicious` analyst flag — no
    // external IP-reputation/geolocation service is called. Run as one
    // batch of independent reads; none of these six queries depends on
    // another's result.
    const [priorVelocityCount, emailsForIpRows, ipsForEmailRows, emailsForSubnetRows, flaggedIp, flaggedEmail] = await Promise.all([
      prisma.ipCapture.count({ where: { ipHash, softDeletedAt: null, capturedAt: { gte: windowStart } } }),
      prisma.ipCapture.findMany({ where: { ipHash, softDeletedAt: null }, select: { signerEmail: true }, distinct: ["signerEmail"] }),
      params.signerEmail
        ? prisma.ipCapture.findMany({ where: { signerEmail: params.signerEmail, softDeletedAt: null }, select: { ipHash: true }, distinct: ["ipHash"] })
        : Promise.resolve([] as { ipHash: string }[]),
      prisma.ipCapture.findMany({ where: { subnetHash, softDeletedAt: null }, select: { signerEmail: true }, distinct: ["signerEmail"] }),
      prisma.ipCapture.findFirst({ where: { ipHash, suspicious: true, softDeletedAt: null }, select: { id: true } }),
      params.signerEmail
        ? prisma.ipCapture.findFirst({ where: { signerEmail: params.signerEmail, suspicious: true, softDeletedAt: null }, select: { id: true } })
        : Promise.resolve(null),
    ]);

    // "Including this capture" — the row being scored doesn't exist yet at
    // query time, so its own email/ipHash is unioned in by hand.
    const emailsForIp = new Set(emailsForIpRows.map((r) => r.signerEmail).filter((e): e is string => !!e));
    if (params.signerEmail) emailsForIp.add(params.signerEmail);

    const ipsForEmail = new Set(ipsForEmailRows.map((r) => r.ipHash));
    ipsForEmail.add(ipHash);

    const emailsForSubnet = new Set(emailsForSubnetRows.map((r) => r.signerEmail).filter((e): e is string => !!e));
    if (params.signerEmail) emailsForSubnet.add(params.signerEmail);

    const assessment = assessRisk({
      velocityCount: priorVelocityCount + 1,
      distinctEmailsForIp: emailsForIp.size,
      distinctIpsForEmail: ipsForEmail.size,
      distinctEmailsForSubnet: emailsForSubnet.size,
      previouslyFlagged: !!flaggedIp || !!flaggedEmail,
    });

    await prisma.ipCapture.create({
      data: {
        encryptedIp: encryptIp(ip),
        ipHash,
        subnetHash,
        ipVersion,
        formType: params.formType,
        bookingId: params.bookingId,
        signerName: params.signerName ?? null,
        signerEmail: params.signerEmail ?? null,
        userAgent: params.userAgent ?? null,
        riskScore: assessment.score,
      },
    });

    if (assessment.score >= HIGH_RISK_THRESHOLD && params.companyId) {
      const admins = await prisma.account.findMany({
        where: { companyId: params.companyId, status: "ACTIVE", role: { in: ["ADMIN", "MANAGER"] } },
        select: { id: true },
      });
      if (admins.length > 0) {
        await prisma.notification.createMany({
          data: admins.map((a) => ({
            accountId: a.id,
            quoteId: params.quoteId ?? undefined,
            type: "IP_VAULT_HIGH_RISK",
            title: "High-risk IP signing detected",
            body: `A booking signing was flagged (risk ${assessment.score}/100): ${assessment.signals.map((s) => s.label).join("; ")}.`,
          })),
        });
      }
    }
  } catch (err) {
    // Best-effort, ADDITIVE forensic record — Signature.ipAddress (for a
    // new/exchange booking) is already the system of record for the core
    // operation, and a cancellation confirmation has no core dependency on
    // this row at all. A vault write failure (e.g. IP_ENCRYPTION_KEY
    // missing/misconfigured in a given environment) must never block or
    // roll back the real booking/cancellation it's attached to. Logs only
    // the error message (never the plaintext IP — see the module comment
    // on "never log raw IPs in application logs").
    console.error("IP vault capture failed (non-fatal, booking/cancellation still succeeded):", err instanceof Error ? err.message : err);
  }
}
