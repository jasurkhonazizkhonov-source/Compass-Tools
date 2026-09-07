// Plain server-only module — deliberately NOT a "use server" file. Every
// exported async function in a "use server" file becomes an RPC endpoint
// any client can call directly; resolveContactForNewLead has no internal
// authentication/authorization check of its own (it trusts the caller to
// have already resolved the correct companyId), so it must never be
// reachable directly from client code. Shared by createLead (an
// authenticated server action) and the public website lead-capture route
// (src/app/api/public/lead-capture/route.ts, unauthenticated by design but
// which resolves companyId from the request payload itself) so both go
// through the exact same dedup/create logic rather than two
// implementations that could drift and create duplicate Contacts.
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { normalizePhoneNumberWithRecovery } from "@/lib/phone";
import { duplicateContactWhere } from "@/lib/contact-matching";

export async function resolveContactForNewLead(
  phone: string,
  email: string | undefined,
  newContactFields: { firstName: string; middleName?: string; lastName: string },
  companyId: string
): Promise<{ contactId: string; isNewContact: boolean }> {
  // A brand-new Contact is always stored with its normalized (E.164) phone
  // — attempts the unambiguous Excel-mangled-NANP recovery (Part 10; e.g.
  // "1 415 325 8565" with no leading "+") before falling back to the raw
  // value, which only happens if it genuinely doesn't parse as a real
  // number even with that recovery attempted (this never silently drops a
  // phone number over a normalization failure — both callers of this
  // shared function decide independently whether an unparseable phone
  // should block the request or not; this function's job is only to store
  // the best value it can, never to reject).
  const storedPhone = normalizePhoneNumberWithRecovery(phone) ?? phone;
  // Trimmed once here so a brand-new Contact's stored value never carries
  // stray leading/trailing whitespace from a sloppy submission (the public
  // website route's own zod schema already trims, but this function is the
  // one place that actually writes the value, and duplicateContactWhere's
  // matching already assumes a trimmed comparison — storage should match).
  // Never changes casing — only insensitive matching does that, at query
  // time, not at rest.
  const trimmedEmail = email?.trim() || undefined;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const orConditions = duplicateContactWhere(phone, trimmedEmail);
          // Scoped to the caller's own company — a phone/email match
          // against another company's Contact must never be treated as the
          // same customer (data isolation, not just a UX nicety).
          const existing = orConditions.length > 0 ? await tx.contact.findFirst({ where: { companyId, OR: orConditions } }) : null;
          if (existing) return { contactId: existing.id, isNewContact: false };

          const contact = await tx.contact.create({
            data: {
              firstName: newContactFields.firstName,
              middleName: newContactFields.middleName || undefined,
              lastName: newContactFields.lastName,
              primaryPhone: storedPhone,
              primaryEmail: trimmedEmail,
              companyId,
              phones: { create: [{ number: storedPhone, type: "MOBILE", isPrimary: true }] },
              emails: trimmedEmail ? { create: [{ email: trimmedEmail, type: "PERSONAL", isPrimary: true }] } : undefined,
            },
          });
          return { contactId: contact.id, isNewContact: true };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (err) {
      const isSerializationConflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (isSerializationConflict && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
  throw new Error("Could not resolve contact for new lead after retries");
}
