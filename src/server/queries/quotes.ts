import { prisma } from "@/lib/prisma";
import type { Prisma, QuoteStatus } from "@/generated/prisma/client";
import { quoteVisibilityWhere, type Viewer } from "@/server/visibility";
import { SEGMENT_SELECT } from "@/server/queries/segment-select";
import { resolvePageSize } from "@/lib/pagination";

export async function getQuotes(params: {
  status?: QuoteStatus | QuoteStatus[];
  agentId?: string;
  page?: number;
  pageSize?: number;
  viewer: Viewer;
}) {
  const page = Math.max(1, Math.trunc(params.page ?? 1) || 1);
  // Pass 7 §18/§31, Pass 12 §28/§30 — 25/50/75/100 rows/page, validated
  // server-side against a strict allow-list.
  const pageSize = resolvePageSize(params.pageSize);

  const statusFilter: Prisma.QuoteWhereInput = !params.status
    ? {}
    : Array.isArray(params.status)
      ? { status: { in: params.status } }
      : { status: params.status };

  const where: Prisma.QuoteWhereInput = {
    ...quoteVisibilityWhere(params.viewer),
    ...statusFilter,
    // Manual narrowing (matches the displayed "Agent" column, Quote.agentId
    // directly) — never a widening grant; see leads/queries.ts's identical
    // reasoning on its own `?agent=` filter.
    ...(params.agentId ? { agentId: params.agentId } : {}),
  };

  const [quotes, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: {
        contact: true,
        agent: true,
        itinerary: { include: { segments: { include: { departureAirport: true, arrivalAirport: true }, orderBy: { sequence: "asc" }, take: 1 } } },
      },
      // Most-recently-active first (any status change — sent, opened,
      // viewed, signed, booked, canceled — bumps lastActivityAt via
      // transitionQuoteStatus), not creation order, so a quote a customer
      // just engaged with visibly floats to the top. `id` tiebreaker for
      // deterministic pagination (Pass 7 §25).
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.quote.count({ where }),
  ]);

  return { quotes, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

// See contactRecordExists in queries/contacts.ts for why this exists —
// unscoped existence check for the not-found vs. not-visible distinction.
export async function quoteRecordExists(quoteId: string): Promise<boolean> {
  const row = await prisma.quote.findUnique({ where: { id: quoteId }, select: { id: true } });
  return row !== null;
}

export async function getQuoteDetail(quoteId: string, viewer: Viewer) {
  return prisma.quote.findFirst({
    where: { id: quoteId, ...quoteVisibilityWhere(viewer) },
    include: {
      // emails included so the quote-sending UI can offer a recipient
      // picker when the contact has more than one on file (Part 17-19).
      contact: { include: { emails: { orderBy: { isPrimary: "desc" } } } },
      lead: true,
      agent: true,
      itinerary: {
        include: {
          segments: {
            select: SEGMENT_SELECT,
            orderBy: { sequence: "asc" },
          },
        },
      },
      statusHistory: { orderBy: { changedAt: "desc" }, include: { changedBy: { select: { id: true, fullName: true } } } },
      // Exchange workflow — only ever non-null when THIS quote itself is
      // an exchange proposal (see Quote.originalQuoteId); powers "this is
      // an exchange against Q-XXXX" plus rendering the original itinerary
      // alongside the proposed one on the CRM detail page.
      originalQuote: {
        select: {
          id: true,
          quoteNumber: true,
          status: true,
          itinerary: { include: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } } },
        },
      },
      // The reverse direction — every exchange ever proposed AGAINST this
      // quote (there can be more than one over time: a disapproved one
      // followed by a later new attempt), most recent first.
      exchangeQuotes: {
        orderBy: { createdAt: "desc" },
        select: { id: true, quoteNumber: true, status: true, createdAt: true, agent: { select: { id: true, fullName: true } }, reviewedBy: { select: { id: true, fullName: true } }, reviewedAt: true },
      },
      reviewedBy: { select: { id: true, fullName: true } },
      cancellationRequests: {
        orderBy: { createdAt: "desc" },
        include: { createdBy: { select: { id: true, fullName: true } }, reviewedBy: { select: { id: true, fullName: true } } },
      },
      // Part 13 — the signed booking form's own data, shown on the quote
      // page below the itinerary once a customer has signed. Passengers/
      // signature included in full (no sensitive fields on either model —
      // see their schema doc comments); paymentMethods explicitly
      // allow-listed to the same safe display fields used everywhere else
      // in this app (last4/brand/expiry/amount) — never encryptedPan, never
      // a CVV column (none exists in this schema at all).
      booking: {
        include: {
          passengers: true,
          signature: true,
          paymentMethods: {
            select: { id: true, cardholderName: true, cardBrand: true, last4: true, expiryMonth: true, expiryYear: true, amountAllocated: true, status: true },
          },
        },
      },
      emailLogs: { orderBy: { createdAt: "desc" } },
    },
  });
}

/**
 * Customer-facing — powers /quote/[token], /quote/[token]/book, and
 * /quote/[token]/confirmation. Uses an explicit field allow-list (not
 * `include`) so any agent/internal-only column added to Quote in the
 * future (internalNotes, netTicketCost, ...) is excluded by construction
 * rather than by remembering to strip it out. If a new field genuinely
 * needs to reach the customer, add it here explicitly.
 */
export async function getQuoteByToken(token: string) {
  return prisma.quote.findUnique({
    where: { secureToken: token },
    select: {
      // contactId is used server-side only, to resolve which Company owns
      // this quote for branding purposes (getCompanyForContactId) — never
      // rendered/passed to any client component.
      contactId: true,
      status: true,
      adults: true,
      children: true,
      infants: true,
      adultPrice: true,
      childPrice: true,
      infantPrice: true,
      taxes: true,
      serviceFee: true,
      total: true,
      currency: true,
      exchangeRate: true,
      pricingSnapshot: true,
      contact: {
        select: { firstName: true, lastName: true, primaryPhone: true, primaryEmail: true },
      },
      itinerary: {
        select: {
          // Same canonical segment shape every other itinerary-reading
          // query uses (see segment-select.ts) — isExtraLeg is
          // intentionally included here too: it's the one flag on
          // FlightSegment that's meant to reach the customer (as a
          // labeled "Bonus Flight" on View Deal/the booking form).
          segments: {
            select: SEGMENT_SELECT,
            orderBy: { sequence: "asc" },
          },
        },
      },
      booking: {
        select: {
          bookingReference: true,
          status: true,
          // Pass 13 §33 — the cancellation signing page's own passenger
          // prefill source: THIS quote's own already-booked passengers
          // (never another quote's — this select is scoped through
          // `getQuoteByToken`'s own secureToken WHERE clause, the same
          // security boundary every other field on this page already
          // relies on). Never selects anything payment/PNR-related.
          passengers: {
            select: {
              id: true,
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
      },
      // Exchange workflow — only the ORIGINAL itinerary's segments/pricing
      // (never internal notes, PNR, or anything else off the original
      // quote) — this is what lets the customer-facing quote/booking pages
      // show "Original Itinerary" alongside the proposed one, plus the
      // original price for context, without leaking anything internal.
      // Null for every ordinary (non-exchange) quote.
      originalQuoteId: true,
      originalQuote: {
        select: {
          total: true,
          currency: true,
          exchangeRate: true,
          itinerary: { select: { segments: { select: SEGMENT_SELECT, orderBy: { sequence: "asc" } } } },
        },
      },
      // exchangeFee/fareDifference: customer-facing on an exchange quote
      // specifically (the whole point of these two fields is the amount
      // the customer is being asked to pay for the exchange — withholding
      // them left the customer with no real total, only the new
      // itinerary's own full retail price under a generic "Total price"
      // label). Still meaningless/unset on an ordinary quote. Unlike
      // internalNotes/pnr (still never selected here), these were never
      // actually sensitive — just previously unwired to any customer view.
      exchangeFee: true,
      fareDifference: true,
      // Cancellation workflow — ONLY confirmed requests, and their fee —
      // never internalNotes/pnr/reviewedBy/PENDING or DISREGARDED
      // requests, which must never reach a customer-facing query. An empty
      // array here (the common case) means nothing about this quote has
      // been cancelled.
      cancellationRequests: {
        where: { status: "CONFIRMED" },
        select: { segmentIds: true, cancellationFee: true },
      },
    },
  });
}
