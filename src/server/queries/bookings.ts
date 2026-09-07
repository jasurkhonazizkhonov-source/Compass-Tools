import { prisma } from "@/lib/prisma";
import type { BookingStatus, Prisma } from "@/generated/prisma/client";
import { bookingVisibilityWhere, type Viewer } from "@/server/visibility";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { resolvePageSize } from "@/lib/pagination";

export async function getBookings(params: {
  status?: BookingStatus | BookingStatus[];
  agentId?: string;
  page?: number;
  pageSize?: number;
  viewer: Viewer;
}) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  // Pass 7 §18/§31, Pass 12 §28/§30 — 25/50/75/100 rows/page, validated
  // server-side against a strict allow-list.
  const pageSize = resolvePageSize(params.pageSize);
  const statusFilter: Prisma.BookingWhereInput = !params.status
    ? {}
    : Array.isArray(params.status)
      ? { status: { in: params.status } }
      : { status: params.status };
  const where: Prisma.BookingWhereInput = {
    ...bookingVisibilityWhere(params.viewer),
    ...statusFilter,
    // Manual narrowing — matches the displayed "Agent" column
    // (lead.assignedAgent, see bookings/page.tsx), never a widening grant;
    // see leads/queries.ts's identical reasoning on its own `?agent=` filter.
    ...(params.agentId ? { lead: { assignedAgentId: params.agentId } } : {}),
  };

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        contact: true,
        lead: { include: { assignedAgent: true } },
        quote: { include: { itinerary: { include: { segments: { include: { departureAirport: true, arrivalAirport: true, airline: true }, orderBy: { sequence: "asc" }, take: 1 } } } } },
      },
      // `id` tiebreaker for deterministic pagination (Pass 7 §25).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  return { bookings, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// See contactRecordExists in queries/contacts.ts for why this exists —
// unscoped existence check for the not-found vs. not-visible distinction.
export async function bookingRecordExists(bookingId: string): Promise<boolean> {
  const row = await prisma.booking.findUnique({ where: { id: bookingId }, select: { id: true } });
  return row !== null;
}

export async function getBookingDetail(bookingId: string, viewer: Viewer) {
  return prisma.booking.findFirst({
    where: { id: bookingId, ...bookingVisibilityWhere(viewer) },
    include: {
      contact: true,
      lead: { include: { assignedAgent: true } },
      quote: {
        include: {
          itinerary: {
            include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } },
          },
        },
      },
      passengers: true,
      // Explicit select — deliberately NOT `include: true` — so
      // `ipAddress` (the booking's submission IP) can never leak into an
      // ordinary booking-detail read by construction. It's only ever
      // selected inside the dedicated, audited revealBookingIp() action.
      signature: {
        select: { id: true, signedName: true, signedAt: true },
      },
      // Explicit field allow-list — deliberately NOT `include: true` — so
      // `encryptedPan` can never leak into an ordinary booking-detail read
      // by construction, even if a future field is added to PaymentMethod.
      // The full PAN is only ever selected inside the dedicated, audited
      // revealPaymentMethod() action. A booking may have multiple payment
      // methods (split payment across cards) — ordered so "Payment Method
      // 1"/"2"/… labels in the UI stay stable across reloads.
      paymentMethods: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          cardholderName: true,
          last4: true,
          cardBrand: true,
          expiryMonth: true,
          expiryYear: true,
          amountAllocated: true,
          status: true,
          workflowStatus: true,
          consentGivenAt: true,
          createdAt: true,
          updatedAt: true,
          charges: { orderBy: { createdAt: "desc" }, include: { initiatedBy: true } },
        },
      },
      statusHistory: { orderBy: { changedAt: "desc" }, include: { changedBy: true } },
      emailLogs: { orderBy: { createdAt: "desc" } },
    },
  });
}

/**
 * Pass 13 §33/§36/§37 — the ONE authoritative source every customer-facing
 * prefill (Exchange Form, Cancellation signing form) reads from: this
 * specific contact's most recent charged booking — never "the latest quote
 * regardless of status", "the latest draft", or any booking not owned by
 * this exact contactId. The `where: { quote: { contactId } }` clause is
 * the actual security boundary here, not a filter applied after the fact
 * — there is structurally no way for this function to return another
 * customer's data, since the query itself can only ever match rows whose
 * quote belongs to the given contact. `orderBy: { createdAt: "desc" }`
 * picks the MOST RECENT charged transaction when a contact has more than
 * one (e.g. a repeat customer), matching "the last charged quote/booking"
 * requirement exactly.
 */
export async function getLastChargedBookingForContact(contactId: string) {
  return prisma.booking.findFirst({
    where: { quote: { contactId } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      contactPhone: true,
      contactEmail: true,
      airlineConfirmationNumber: true,
      passengers: {
        select: {
          firstName: true,
          middleName: true,
          lastName: true,
          type: true,
          dateOfBirth: true,
          gender: true,
          tsaKnownTravelerNumber: true,
          globalEntryNumber: true,
        },
      },
    },
  });
}

export type PreviousPassenger = {
  firstName: string;
  middleName: string | null;
  lastName: string;
  type: "ADULT" | "CHILD" | "INFANT";
  dateOfBirth: Date | null;
  gender: string | null;
  tsaKnownTravelerNumber: string | null;
  globalEntryNumber: string | null;
  frequentFlyerAirline: string | null;
  frequentFlyerNumber: string | null;
};

/**
 * Pass 24/25 — passenger-autofill selector for the NEW (non-exchange)
 * booking form. Same security boundary as getLastChargedBookingForContact
 * directly above (`where: { booking: { quote: { contactId } } }` — the
 * query itself can only ever match passenger rows belonging to THIS
 * contact's own bookings; there is structurally no way to return another
 * customer's passengers), but spans every past booking, not just the most
 * recent one, since the customer should be able to pick from anyone
 * they've ever traveled with, not only their last trip.
 *
 * Deduplication: this schema has no cross-booking Passenger identity (each
 * `Passenger` row belongs to exactly one `Booking`) — first+last name and
 * date of birth together are the best available proxy for "the same
 * person across trips," used here ONLY to collapse duplicate selector
 * entries, never as a security boundary. Keeps the MOST RECENT booking's
 * values when the same apparent person appears more than once (their
 * latest-known KTN/Global Entry/frequent-flyer info is more likely to
 * still be current), and never merges two people who happen to share a
 * name but have different (or missing) dates of birth into one entry.
 */
export async function getPreviousPassengersForContact(contactId: string): Promise<PreviousPassenger[]> {
  const rows = await prisma.passenger.findMany({
    where: { booking: { quote: { contactId } } },
    orderBy: { booking: { createdAt: "desc" } },
    select: {
      firstName: true,
      middleName: true,
      lastName: true,
      type: true,
      dateOfBirth: true,
      gender: true,
      tsaKnownTravelerNumber: true,
      globalEntryNumber: true,
      frequentFlyerAirline: true,
      frequentFlyerNumber: true,
    },
  });

  const seen = new Map<string, PreviousPassenger>();
  for (const p of rows) {
    const key = `${p.firstName.trim().toLowerCase()}|${p.lastName.trim().toLowerCase()}|${p.dateOfBirth?.toISOString() ?? "unknown-dob"}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

export type PreviousBillingAddress = {
  billingAddress: string;
  billingApt: string | null;
  billingCity: string;
  billingState: string;
  billingZip: string;
  billingCountry: string;
};

/**
 * Pass 25 — billing-address autofill selector for the booking form, same
 * security boundary and dedup approach as getPreviousPassengersForContact
 * directly above (`where: { quote: { contactId } }` is the actual
 * boundary; equivalent-looking addresses are collapsed to one option by
 * their normalized field values, most-recent booking first).
 */
export async function getPreviousBillingAddressesForContact(contactId: string): Promise<PreviousBillingAddress[]> {
  const rows = await prisma.booking.findMany({
    where: { quote: { contactId } },
    orderBy: { createdAt: "desc" },
    select: {
      billingAddress: true,
      billingApt: true,
      billingCity: true,
      billingState: true,
      billingZip: true,
      billingCountry: true,
    },
  });

  const seen = new Map<string, PreviousBillingAddress>();
  for (const r of rows) {
    const key = [r.billingAddress, r.billingApt ?? "", r.billingCity, r.billingState, r.billingZip, r.billingCountry]
      .map((v) => v.trim().toLowerCase())
      .join("|");
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

export type PreviousPaymentMethodOption = {
  id: string;
  cardholderName: string;
  last4: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
};

/**
 * Pass 25 §3-6 — "previously used card" SELECTOR for the booking form.
 * Deliberately excludes `encryptedPan` (explicit `select`, never
 * `include: true` — same isolation guarantee as getBookingDetail's own
 * PaymentMethod select in this same file) — the full card number is
 * genuinely NOT retrievable through this path, by design, not by
 * oversight. See docs/PAYMENT_AUTOFILL_SECURITY.md for the full reasoning:
 * this app's card vault (payment-vault.ts) is explicitly dev-only and
 * FAILS CLOSED in production — re-exposing a decrypted PAN into a NEW,
 * unrelated booking form merely for autofill convenience would (a) be
 * architecturally impossible in any real production deployment of this
 * app, since the vault refuses to reveal anything there, and (b) even in
 * dev, re-exposing a stored PAN to a new transaction is exactly the kind
 * of unnecessary re-exposure PCI scope-reduction principles exist to
 * prevent. Selecting an option here can only ever autofill the
 * customer-safe fields already returned by this query (cardholder name,
 * expiry) — the customer must always manually re-enter the card number
 * and security code; neither is ever offered for autofill.
 */
export async function getPreviousPaymentMethodsForContact(contactId: string): Promise<PreviousPaymentMethodOption[]> {
  return prisma.paymentMethod.findMany({
    where: { contactId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    select: { id: true, cardholderName: true, last4: true, cardBrand: true, expiryMonth: true, expiryYear: true },
  });
}
