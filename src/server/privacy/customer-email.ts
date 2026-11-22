// Customer-email privacy policy - the ONE server-side place that decides who sees a customer's complete email address.
//
// Policy
//   - Administrators: always complete addresses, no allowance.
//   - Users whose Account.unlimitedCustomerEmailAccess is on (an Administrator's per-user switch): complete addresses, no allowance. Read FRESH from the database on every
//     decision, so revoking the switch takes effect on the very next request.
//   - Everyone else (managers, travel agents, ...): a masked address (see lib/customer-email-mask) until they Reveal. A reveal of a customer costs one of
//     DAILY_EMAIL_REVEAL_LIMIT per business day (America/Los_Angeles day); revealing the SAME customer again that day is free and stays revealed.
//
// What a "customer email" is: an address stored on a Contact (ContactEmail rows / Contact.primaryEmail) - the customer a lead, quote or booking belongs to. Staff
// addresses (Account.email), the company's own addresses and supplier/airline addresses are NOT customer emails and are never masked here.
//
// Enforcement: masking happens where the data is shaped for the browser (server components / server actions) - a restricted viewer's payload simply never contains
// the address, so there is nothing to un-hide in the browser. The reveal is an atomic database operation (below), not a client-side counter.
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { businessDayKey } from "@/lib/business-time";
import { DAILY_EMAIL_REVEAL_LIMIT, maskCustomerEmail, type RecipientOption } from "@/lib/customer-email-mask";

export type EmailViewerActor = { id: string; role: string; companyId: string };

export type EmailViewer = {
  id: string;
  companyId: string;
  /** true -> must see masked addresses unless a reveal exists for the day. */
  restricted: boolean;
  unlimited: boolean;
  isAdmin: boolean;
};

/** Reads the viewer's CURRENT privilege from the database (never from a cached session object), so a revocation is immediate. */
export async function getEmailViewer(actor: EmailViewerActor): Promise<EmailViewer> {
  if (actor.role === "ADMIN") return { id: actor.id, companyId: actor.companyId, restricted: false, unlimited: true, isAdmin: true };
  let flag = false;
  try {
    const row = await prisma.account.findUnique({ where: { id: actor.id }, select: { unlimitedCustomerEmailAccess: true } });
    flag = row?.unlimitedCustomerEmailAccess === true;
  } catch {
    flag = false; // fail closed: an unreadable permission means masked
  }
  return { id: actor.id, companyId: actor.companyId, restricted: !flag, unlimited: flag, isAdmin: false };
}

/**
 * For an INTERNAL notification email: true only when EVERY named recipient is allowed to see complete customer addresses (an Administrator, or a user with Unlimited Customer
 * Email Access). Read fresh from the database; an unknown account, a missing id or an unreadable answer is "no" (fail closed). A notification that goes to several people
 * as one message therefore shows the address only if all of them may see it.
 */
export async function recipientsMaySeeCustomerEmail(accountIds: Array<string | null | undefined>): Promise<boolean> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0 || ids.some((i) => !i)) return false;
  try {
    const rows = await prisma.account.findMany({ where: { id: { in: ids as string[] } }, select: { id: true, role: true, unlimitedCustomerEmailAccess: true } });
    if (rows.length !== ids.length) return false;
    return rows.every((r) => r.role === "ADMIN" || r.unlimitedCustomerEmailAccess === true);
  } catch {
    return false;
  }
}

type MaybeViewer ={ id: string; role: string; companyId: string } | null | undefined;

/** Whether this (possibly missing) viewer must not search by / see full customer emails. A missing viewer is treated as restricted - fail closed. */
export async function isEmailRestricted(actor: MaybeViewer): Promise<boolean> {
  if (!actor) return true;
  return (await getEmailViewer(actor)).restricted;
}

/**
 * For list queries: returns copies of the rows whose contact's `primaryEmail` is replaced by the masked form when this viewer may not see it (and has not revealed that
 * customer today). Contacts are identified with `pick`, so the same helper serves leads (row.contact), contacts (the row itself), quotes, and so on.
 */
export async function withEmailPrivacy<T>(actor: MaybeViewer, rows: T[], pick: (row: T) => { id: string; primaryEmail: string | null } | null | undefined, apply: (row: T, email: string | null) => T): Promise<T[]> {
  if (rows.length === 0) return rows;
  const viewer = actor ? await getEmailViewer(actor) : null;
  if (viewer && !viewer.restricted) return rows;
  const ids = rows.map((r) => pick(r)?.id).filter((i): i is string => !!i);
  const revealed = viewer ? await revealedContactIdsToday(viewer, ids) : new Set<string>();
  return rows.map((row) => {
    const c = pick(row);
    if (!c || revealed.has(c.id)) return row;
    return apply(row, c.primaryEmail ? maskCustomerEmail(c.primaryEmail) : null);
  });
}

/** Contact ids whose complete address this viewer has already revealed on the current business day. */
export async function revealedContactIdsToday(viewer: EmailViewer, contactIds: string[], now = new Date()): Promise<Set<string>> {
  if (!viewer.restricted || contactIds.length === 0) return new Set(contactIds);
  try {
    const rows = await prisma.customerEmailRevealEvent.findMany({
      where: { userId: viewer.id, dayKey: businessDayKey(now), contactId: { in: contactIds } },
      select: { contactId: true },
    });
    return new Set(rows.map((r) => r.contactId));
  } catch {
    // Fail closed: if the reveal record cannot be read (for example the migration has not been applied yet), nothing counts as revealed - addresses stay masked and
    // the page still renders.
    return new Set();
  }
}

export type EmailUsage = { used: number; limit: number; remaining: number; unlimited: boolean };

export async function getEmailUsage(viewer: EmailViewer, now = new Date()): Promise<EmailUsage> {
  if (!viewer.restricted) return { used: 0, limit: DAILY_EMAIL_REVEAL_LIMIT, remaining: DAILY_EMAIL_REVEAL_LIMIT, unlimited: true };
  let count = 0;
  try {
    const row = await prisma.customerEmailRevealUsage.findUnique({ where: { userId_dayKey: { userId: viewer.id, dayKey: businessDayKey(now) } }, select: { count: true } });
    count = row?.count ?? 0;
  } catch {
    count = 0; // unreadable: show 0 used; the reveal itself is authoritative and still enforces the limit atomically
  }
  const used = Math.min(count, DAILY_EMAIL_REVEAL_LIMIT);
  return { used, limit: DAILY_EMAIL_REVEAL_LIMIT, remaining: DAILY_EMAIL_REVEAL_LIMIT - used, unlimited: false };
}

/** What a page/prop may carry for one stored address. `address` is present ONLY when this viewer may see the full value. */
export type PrivateEmail = { id: string; display: string; address: string | null; masked: boolean };

export function presentEmail(id: string, address: string, full: boolean): PrivateEmail {
  return full ? { id, display: address, address, masked: false } : { id, display: maskCustomerEmail(address), address: null, masked: true };
}

export type RevealOutcome =
  | { ok: true; addresses: Array<{ id: string; address: string }>; charged: boolean; usage: EmailUsage }
  | { ok: false; code: "LIMIT_REACHED" | "NOT_FOUND" | "ERROR"; error: string; usage?: EmailUsage };

class LimitReached extends Error {}

/**
 * Reveals the addresses of ONE customer (contact) to a restricted viewer. The caller has already proven the viewer may see this contact at all.
 *
 * Atomicity - everything below happens in one database transaction:
 *   1. INSERT the (user, contact, day) reveal event ON CONFLICT DO NOTHING. A row came back -> this is a NEW reveal; none -> the same customer was already revealed today (a
 *      repeat, a second tab, a second device, a retried request): free, nothing is charged, and concurrent duplicates all land here.
 *   2. For a new reveal, advance the per-user per-day counter with a single INSERT .. ON CONFLICT DO UPDATE .. WHERE count < limit. Row locking makes concurrent reveals of
 *      DIFFERENT customers queue up; the WHERE is re-evaluated after the lock, so the sixth can never succeed.
 *   3. If the counter refused (limit), the whole transaction - including the event row from step 1 - is rolled back, so a refused reveal leaves nothing behind.
 * A failure anywhere (e.g. the contact's addresses cannot be read) also rolls everything back, so a failed reveal never consumes allowance.
 */
export async function revealCustomerEmails(
  viewer: EmailViewer,
  input: { contactId: string; leadId?: string | null; now?: Date; correlationId?: string }
): Promise<RevealOutcome> {
  const now = input.now ?? new Date();
  const dayKey = businessDayKey(now);
  const readAddresses = async (db: Pick<typeof prisma, "contactEmail" | "contact">) => {
    const rows = await db.contactEmail.findMany({ where: { contactId: input.contactId }, select: { id: true, email: true }, orderBy: { createdAt: "asc" } });
    if (rows.length > 0) return rows.map((r) => ({ id: r.id, address: r.email }));
    const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { primaryEmail: true } });
    return contact?.primaryEmail ? [{ id: `primary:${input.contactId}`, address: contact.primaryEmail }] : [];
  };

  if (!viewer.restricted) {
    return { ok: true, addresses: await readAddresses(prisma), charged: false, usage: await getEmailUsage(viewer, now) };
  }

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "CustomerEmailRevealEvent" ("id", "userId", "companyId", "contactId", "leadId", "method", "dayKey", "correlationId", "createdAt")
        VALUES (${randomUUID()}, ${viewer.id}, ${viewer.companyId}, ${input.contactId}, ${input.leadId ?? null}, 'DAILY_ALLOWANCE', ${dayKey}, ${input.correlationId ?? null}, ${now})
        ON CONFLICT ("userId", "contactId", "dayKey") DO NOTHING
        RETURNING "id"`;
      const isNew = inserted.length > 0;
      if (isNew) {
        const advanced = await tx.$queryRaw<Array<{ count: number }>>`
          INSERT INTO "CustomerEmailRevealUsage" ("userId", "dayKey", "count") VALUES (${viewer.id}, ${dayKey}, 1)
          ON CONFLICT ("userId", "dayKey") DO UPDATE SET "count" = "CustomerEmailRevealUsage"."count" + 1
          WHERE "CustomerEmailRevealUsage"."count" < ${DAILY_EMAIL_REVEAL_LIMIT}
          RETURNING "count"`;
        if (advanced.length === 0) throw new LimitReached();
      }
      const addresses = await readAddresses(tx);
      if (isNew) {
        // The audit entry names who, which customer record and how it was charged - never the address.
        await tx.auditLog.create({
          data: {
            actorId: viewer.id,
            action: "CUSTOMER_EMAIL_REVEALED",
            entityType: "Contact",
            entityId: input.contactId,
            metadata: { method: "DAILY_ALLOWANCE", dayKey, addressCount: addresses.length, leadId: input.leadId ?? null },
          },
        });
      }
      return { addresses, charged: isNew };
    });
    return { ok: true, addresses: outcome.addresses, charged: outcome.charged, usage: await getEmailUsage(viewer, now) };
  } catch (err) {
    if (err instanceof LimitReached) {
      return { ok: false, code: "LIMIT_REACHED", error: `You have used all ${DAILY_EMAIL_REVEAL_LIMIT} customer email reveals for today. The allowance resets at midnight Pacific time.`, usage: await getEmailUsage(viewer, now).catch(() => undefined) };
    }
    console.error("[customer-email] reveal failed:", err instanceof Error ? err.name : "error");
    return { ok: false, code: "ERROR", error: "The email could not be revealed. Nothing was counted against your allowance." };
  }
}

export type { RecipientOption };

/** Builds the composer's recipient list for one customer. `full` = this viewer may see complete addresses for this customer right now. */
export function buildRecipientOptions(
  contactId: string,
  emails: Array<{ id: string; email: string; isPrimary?: boolean }>,
  primaryEmail: string | null | undefined,
  full: boolean
): RecipientOption[] {
  const rows = emails.length > 0 ? [...emails].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map((e) => ({ id: e.id, address: e.email })) : primaryEmail ? [{ id: `primary:${contactId}`, address: primaryEmail }] : [];
  return rows.map((r) => {
    const p = presentEmail(r.id, r.address, full);
    return { id: r.id, display: p.display, address: p.address };
  });
}

export type ContactEmailView<E extends { id: string; email: string; isPrimary: boolean }> = {
  /** The contact's email rows with `email` replaced by what this viewer may see (masked until revealed). */
  rows: E[];
  primaryDisplay: string | null;
  recipients: RecipientOption[];
  /** true -> addresses (and any address inside free text on this page) must be shown masked. */
  masked: boolean;
  /** Present only for a viewer subject to masking: drives the Reveal button + "n / 5 used today" indicator. */
  privacy?: { masked: boolean; used: number; limit: number };
};

/** One call for a detail page: decides masked vs complete for this viewer and customer, and returns display-safe rows, composer recipients and the indicator. */
export async function buildContactEmailView<E extends { id: string; email: string; isPrimary: boolean }>(
  actor: EmailViewerActor | null | undefined,
  contactId: string,
  emails: E[],
  primaryEmail: string | null | undefined
): Promise<ContactEmailView<E>> {
  const viewer = actor ? await getEmailViewer(actor) : null;
  let full = !!viewer && !viewer.restricted;
  let usage: EmailUsage | undefined;
  if (viewer && viewer.restricted) {
    full = (await revealedContactIdsToday(viewer, [contactId])).has(contactId);
    usage = await getEmailUsage(viewer);
  }
  const rows = emails.map((e) => ({ ...e, email: full ? e.email : maskCustomerEmail(e.email) }));
  return {
    rows,
    primaryDisplay: primaryEmail ? (full ? primaryEmail : maskCustomerEmail(primaryEmail)) : null,
    recipients: buildRecipientOptions(contactId, emails, primaryEmail, full),
    masked: !full,
    privacy: usage ? { masked: !full, used: usage.used, limit: usage.limit } : undefined,
  };
}

const REFUSED_RAW_ADDRESS = "Choose the recipient from the list.";

/**
 * The recipient string a send will use. Clients send opaque ids; the address is looked up HERE. A restricted viewer may never supply a raw address (that would turn the send
 * into a "is this address on file?" oracle); an unrestricted viewer may still use `to` (the established path), which the send core re-verifies against the customer's own
 * addresses.
 */
export async function resolveSendRecipients(
  viewer: EmailViewer,
  contactId: string,
  input: { to?: string; recipientIds?: string[] }
): Promise<string> {
  if (input.recipientIds && input.recipientIds.length > 0) {
    const addresses = await resolveRecipientIds(contactId, input.recipientIds);
    if (!addresses || addresses.length === 0) throw new Error("That recipient is not available for this customer.");
    return addresses.join(", ");
  }
  if (viewer.restricted) throw new Error(REFUSED_RAW_ADDRESS);
  if (!input.to) throw new Error("Select at least one recipient");
  return input.to;
}

/**
 * Turns "which customer-email rows may be sent to" into addresses, on the SERVER, for a restricted or unrestricted viewer alike. A restricted viewer's client only ever
 * holds ids; this resolves them and refuses an id that does not belong to the contact (so ids cannot be used to probe other customers).
 */
export async function resolveRecipientIds(contactId: string, ids: string[]): Promise<string[] | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const ownPrimary = `primary:${contactId}`;
  if (unique.some((i) => i.startsWith("primary:") && i !== ownPrimary)) return null;
  const rowIds = unique.filter((i) => i !== ownPrimary);
  const rows = rowIds.length > 0 ? await prisma.contactEmail.findMany({ where: { contactId, id: { in: rowIds } }, select: { id: true, email: true } }) : [];
  if (rows.length !== rowIds.length) return null; // an unknown / foreign id refuses the whole send
  const out = rows.map((r) => r.email);
  if (unique.includes(ownPrimary)) {
    const c = await prisma.contact.findUnique({ where: { id: contactId }, select: { primaryEmail: true } });
    if (!c?.primaryEmail) return null;
    out.push(c.primaryEmail);
  }
  return out;
}
