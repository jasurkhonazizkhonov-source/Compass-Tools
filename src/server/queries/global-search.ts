"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { contactVisibilityWhere, leadVisibilityWhere, quoteVisibilityWhere, bookingVisibilityWhere } from "@/server/visibility";

export type GlobalSearchResult = {
  contacts: Array<{ id: string; label: string; sublabel: string }>;
  leads: Array<{ id: string; label: string; sublabel: string }>;
  quotes: Array<{ id: string; label: string; sublabel: string }>;
  bookings: Array<{ id: string; label: string; sublabel: string }>;
};

export async function globalSearch(rawQuery: string): Promise<GlobalSearchResult> {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return { contacts: [], leads: [], quotes: [], bookings: [] };
  }

  // Pass 34 — real bug found and fixed: this action (a "use server" file
  // callable directly by any authenticated client, same threat model
  // activity.ts's own doc comment describes) previously ran all four
  // searches with NO visibility scoping whatsoever — no company filter, no
  // ownerId/assignedAgentId restriction for roles that are normally
  // limited to their own records elsewhere in this app. A restricted
  // Travel Agent could search for, and see the name/email/phone/route/
  // reference of, any Contact/Lead/Quote/Booking company-wide (or, in a
  // database holding more than one Company, cross-company). Every other
  // list/detail query in this codebase merges one of visibility.ts's
  // `*VisibilityWhere` helpers into its own query — this now does the
  // same, `AND`-ed alongside the existing text-search OR clause.
  const actor = await getCurrentAccount();

  const [contacts, leads, quotes, bookings] = await Promise.all([
    prisma.contact.findMany({
      where: {
        AND: [
          contactVisibilityWhere(actor),
          {
            OR: [
              { firstName: { contains: query, mode: "insensitive" } },
              { lastName: { contains: query, mode: "insensitive" } },
              { primaryEmail: { contains: query, mode: "insensitive" } },
              { primaryPhone: { contains: query, mode: "insensitive" } },
            ],
          },
        ],
      },
      take: 5,
    }),
    prisma.lead.findMany({
      where: {
        AND: [
          leadVisibilityWhere(actor),
          {
            OR: [
              { contact: { firstName: { contains: query, mode: "insensitive" } } },
              { contact: { lastName: { contains: query, mode: "insensitive" } } },
              { departureAirport: { OR: [{ iata: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }] } },
              { arrivalAirport: { OR: [{ iata: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }] } },
            ],
          },
        ],
      },
      include: { contact: true, departureAirport: true, arrivalAirport: true },
      take: 5,
    }),
    prisma.quote.findMany({
      where: {
        AND: [
          quoteVisibilityWhere(actor),
          {
            OR: [
              { quoteNumber: { contains: query, mode: "insensitive" } },
              { contact: { firstName: { contains: query, mode: "insensitive" } } },
              { contact: { lastName: { contains: query, mode: "insensitive" } } },
            ],
          },
        ],
      },
      include: { contact: true },
      take: 5,
    }),
    prisma.booking.findMany({
      where: {
        AND: [
          bookingVisibilityWhere(actor),
          {
            OR: [
              { bookingReference: { contains: query, mode: "insensitive" } },
              { pnr: { contains: query, mode: "insensitive" } },
              { contact: { firstName: { contains: query, mode: "insensitive" } } },
              { contact: { lastName: { contains: query, mode: "insensitive" } } },
            ],
          },
        ],
      },
      include: { contact: true },
      take: 5,
    }),
  ]);

  return {
    contacts: contacts.map((c) => ({
      id: c.id,
      label: `${c.firstName} ${c.lastName}`,
      sublabel: c.primaryEmail || c.primaryPhone || "",
    })),
    leads: leads.map((l) => ({
      id: l.id,
      label: `${l.contact.firstName} ${l.contact.lastName}`,
      sublabel: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`,
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      label: q.quoteNumber,
      sublabel: `${q.contact.firstName} ${q.contact.lastName}`,
    })),
    bookings: bookings.map((b) => ({
      id: b.id,
      label: b.bookingReference,
      sublabel: `${b.contact.firstName} ${b.contact.lastName}`,
    })),
  };
}
