"use server";

import { prisma } from "@/lib/prisma";

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

  const [contacts, leads, quotes, bookings] = await Promise.all([
    prisma.contact.findMany({
      where: {
        OR: [
          { firstName: { contains: query, mode: "insensitive" } },
          { lastName: { contains: query, mode: "insensitive" } },
          { primaryEmail: { contains: query, mode: "insensitive" } },
          { primaryPhone: { contains: query, mode: "insensitive" } },
        ],
      },
      take: 5,
    }),
    prisma.lead.findMany({
      where: {
        OR: [
          { contact: { firstName: { contains: query, mode: "insensitive" } } },
          { contact: { lastName: { contains: query, mode: "insensitive" } } },
          { departureAirport: { OR: [{ iata: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }] } },
          { arrivalAirport: { OR: [{ iata: { contains: query, mode: "insensitive" } }, { city: { contains: query, mode: "insensitive" } }] } },
        ],
      },
      include: { contact: true, departureAirport: true, arrivalAirport: true },
      take: 5,
    }),
    prisma.quote.findMany({
      where: {
        OR: [
          { quoteNumber: { contains: query, mode: "insensitive" } },
          { contact: { firstName: { contains: query, mode: "insensitive" } } },
          { contact: { lastName: { contains: query, mode: "insensitive" } } },
        ],
      },
      include: { contact: true },
      take: 5,
    }),
    prisma.booking.findMany({
      where: {
        OR: [
          { bookingReference: { contains: query, mode: "insensitive" } },
          { pnr: { contains: query, mode: "insensitive" } },
          { contact: { firstName: { contains: query, mode: "insensitive" } } },
          { contact: { lastName: { contains: query, mode: "insensitive" } } },
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
