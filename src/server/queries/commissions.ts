import { prisma } from "@/lib/prisma";
import type { AccountRole, Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/server/visibility";
import { resolveExchangeRate, convertToUsd } from "@/lib/currency";
import { resolvePageSize } from "@/lib/pagination";

// Part 16 — only Admin sees every commission company-wide now; Manager is
// row-scoped to their own sales just like Travel Agent. Distinct from
// canViewCommissions (src/lib/permissions.ts), which only gates whether the
// role can reach the page at all — this is the row-level scope within it.
function canViewAllCommissions(role: AccountRole) {
  return role === "ADMIN";
}

export type CommissionFilters = {
  from?: Date;
  to?: Date;
  /** Part 16 — "Specific User" filter. Only ever honored for a viewer who
   * already has company-wide visibility (canViewAllCommissions) — a
   * row-scoped viewer (Manager/Travel Agent) is ALWAYS restricted to their
   * own id regardless of what's passed here; never trust this from the
   * client for a restricted viewer. */
  userId?: string;
};

/** Shared by both the full per-row mapper and the lightweight summary query
 * below — the ONE place commission/tip math is computed, so the two can
 * never drift apart (Pass 24). */
function computeCommissionMath(row: {
  profitAmount: Prisma.Decimal | null;
  gratuityAmount: Prisma.Decimal;
  currency: string;
  exchangeRate: Prisma.Decimal | null;
  commissionPercent: Prisma.Decimal | null;
  tipPercent: Prisma.Decimal | null;
}) {
  const profit = Number(row.profitAmount ?? 0);
  const commissionPercent = row.commissionPercent != null ? Number(row.commissionPercent) : 0;
  const commissionAmount = profit * (commissionPercent / 100);
  const tipPercent = row.tipPercent != null ? Number(row.tipPercent) : 0;
  // Booking.gratuityAmount is persisted in the quote's own customer-facing
  // currency (see convertToUsd's doc comment) — converted back to USD so
  // it's comparable with profit/commission, both internal USD figures.
  const rate = resolveExchangeRate(row.currency, row.exchangeRate ? Number(row.exchangeRate) : null);
  const grossTip = convertToUsd(Number(row.gratuityAmount), rate);
  const tipEarned = grossTip * (tipPercent / 100);
  return { profit, commissionPercent, commissionAmount, tipPercent, grossTip, tipEarned };
}

function commissionsWhere(viewer: Viewer, filters: CommissionFilters): Prisma.BookingWhereInput {
  const canViewAll = viewer ? canViewAllCommissions(viewer.role) : false;
  const scopedAgentId = canViewAll ? filters.userId : viewer?.id;
  return {
    status: "CONFIRMED",
    profitAmount: { not: null },
    contact: { companyId: viewer?.companyId },
    ...(scopedAgentId ? { quote: { sentByAgentId: scopedAgentId } } : {}),
    ...(filters.from || filters.to
      ? { updatedAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
  };
}

/**
 * Part 14/16 — commission is computed at query time from existing data
 * (booking.profitAmount × quote.sentByAgent.commissionPercent), never
 * stored in its own table — avoids a second source of truth that could
 * drift from the underlying booking/account rows. Only CONFIRMED bookings
 * with a known profit generate a row at all (an unsigned quote or a
 * booking that never reached CONFIRMED generates nothing — Part 14's
 * explicit requirement). Travel Agent AND Manager see only commissions
 * credited to THEM (quote.sentByAgentId, not the booking's ticketing
 * agent); only Admin sees every commission company-wide, optionally
 * narrowed to one specific user via filters.userId.
 *
 * Pass 24 — now paginated (same skip/take + count() convention as every
 * other list query in this app — see contacts.ts). The heavy joins here
 * (contact, itinerary+segments, statusHistory) are only ever needed to
 * render the CURRENT PAGE's rows — see getCommissionsSummary below for the
 * separate, much lighter query that computes company-wide totals across
 * every matching booking regardless of which page is being viewed.
 */
export async function getCommissions(viewer: Viewer, filters: CommissionFilters = {}, page = 1, pageSize?: number) {
  if (!viewer) return { rows: [], total: 0, page: 1, pageSize: resolvePageSize(pageSize), pageCount: 1 };

  const resolvedPage = Math.max(1, Math.trunc(page) || 1);
  const resolvedPageSize = resolvePageSize(pageSize);
  const where = commissionsWhere(viewer, filters);

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        contact: { select: { firstName: true, lastName: true } },
        quote: {
          select: {
            id: true,
            quoteNumber: true,
            currency: true,
            exchangeRate: true,
            // Part 1 — the two existing, already-derivable signals for what
            // generated this profit: a non-null originalQuoteId means this
            // booking's quote is itself an approved Exchange's own quote (see
            // exchange.ts's sendExchangeForApproval), and CANCELLATION_CONFIRMED
            // means a cancellation was later confirmed against this same
            // quote/booking (see cancellation.ts's confirmCancellation, which
            // never touches profitAmount itself — the figure below is still
            // just the original sale's profit, now labeled for visibility).
            originalQuoteId: true,
            status: true,
            sentByAgent: { select: { id: true, fullName: true, commissionPercent: true, tipPercent: true } },
            itinerary: {
              select: {
                segments: {
                  select: { arrivalAirport: { select: { city: true, country: true } }, isExtraLeg: true, sequence: true },
                  orderBy: { sequence: "asc" },
                },
              },
            },
          },
        },
        // "Ticketing agent/admin" for audit — whoever most recently moved
        // this booking TO CONFIRMED, distinct from quote.sentByAgent (who
        // gets the actual commission — see Part 16).
        statusHistory: {
          where: { toStatus: "CONFIRMED" },
          orderBy: { changedAt: "desc" },
          take: 1,
          select: { changedBy: { select: { id: true, fullName: true } } },
        },
      },
      // `id` tiebreaker — same Pass 7 §25 reasoning as contacts.ts's own
      // paginated list: several bookings can share the exact same
      // updatedAt, which without a deterministic secondary key could let a
      // row appear on two pages or be skipped between page loads.
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (resolvedPage - 1) * resolvedPageSize,
      take: resolvedPageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  const rows = bookings.map((b) => {
    const math = computeCommissionMath({
      profitAmount: b.profitAmount,
      gratuityAmount: b.gratuityAmount,
      currency: b.quote.currency,
      exchangeRate: b.quote.exchangeRate,
      commissionPercent: b.quote.sentByAgent?.commissionPercent ?? null,
      tipPercent: b.quote.sentByAgent?.tipPercent ?? null,
    });
    const realSegments = (b.quote.itinerary?.segments ?? []).filter((s) => !s.isExtraLeg);
    const lastSegment = realSegments[realSegments.length - 1] ?? b.quote.itinerary?.segments[b.quote.itinerary.segments.length - 1];
    const ticketingAgent = b.statusHistory[0]?.changedBy ?? null;
    // Part 1 — purely additive labeling, derived from existing data, never
    // affecting `profit`/`commissionAmount`/`totalEarnings` below. A
    // cancellation never creates its own Booking (see cancellation.ts) or
    // touches this one's profitAmount — CANCELLATION means "this row's
    // existing profit belongs to a sale that was later partially/fully
    // cancelled," not a separate, computed cancellation-profit figure (see
    // this session's plan for why no such figure is invented here).
    //
    // Bug fix (live-caught during QA) — CANCELLATION_CONFIRMED must be
    // checked FIRST, ahead of originalQuoteId. A quote that was itself an
    // approved Exchange (originalQuoteId set) can later also be cancelled —
    // that combination is a normal, expected real-world sequence, not an
    // edge case — and once cancelled, the cancellation is the most recent,
    // most final financial event against this booking. The previous
    // ordering permanently mislabeled every such booking as "Exchange"
    // forever, silently hiding that it was actually later cancelled.
    const transactionType: "NEW_SALE" | "EXCHANGE" | "CANCELLATION" =
      b.quote.status === "CANCELLATION_CONFIRMED" ? "CANCELLATION" : b.quote.originalQuoteId != null ? "EXCHANGE" : "NEW_SALE";
    return {
      bookingId: b.id,
      bookingReference: b.bookingReference,
      quoteId: b.quote.id,
      quoteNumber: b.quote.quoteNumber,
      customerName: `${b.contact.firstName} ${b.contact.lastName}`,
      transactionType,
      ...math,
      quoteOwnerId: b.quote.sentByAgent?.id ?? null,
      quoteOwnerName: b.quote.sentByAgent?.fullName ?? "Unknown",
      ticketingAgentName: ticketingAgent?.fullName ?? "Unknown",
      destination: lastSegment ? `${lastSegment.arrivalAirport.city}, ${lastSegment.arrivalAirport.country}` : "—",
      status: b.status,
      confirmedAt: b.updatedAt,
    };
  });

  return { rows, total, page: resolvedPage, pageSize: resolvedPageSize, pageCount: Math.max(1, Math.ceil(total / resolvedPageSize)) };
}

export type CommissionSummary = {
  bookingCount: number;
  totalProfit: number;
  totalCommission: number;
  totalTips: number;
  tipEarnings: number;
  totalEarnings: number;
  /** Only meaningful when every row shares the same agent (own view, or a
   * single "Specific User" selected) — null for a mixed "All Users" board
   * where different agents may have different tip rates. */
  uniformTipPercent: number | null;
};

/**
 * Part 15 — Commission Summary: bookings/profit/commission/tips/tip
 * earnings/total earnings, computed across the ENTIRE filtered dataset
 * (every matching booking, regardless of page), independent of
 * getCommissions' own pagination.
 *
 * Pass 24 — previously computed by summing the exact same rows
 * getCommissions() returned, which meant paginating that query would have
 * silently made the summary reflect only the current page rather than the
 * true totals (the actual reason this couldn't be fixed with a naive
 * `take`). This is a SEPARATE query with a deliberately minimal select —
 * only the fields computeCommissionMath needs (profitAmount,
 * gratuityAmount, quote.currency/exchangeRate,
 * quote.sentByAgent.commissionPercent/tipPercent) — dropping the
 * contact/itinerary+segments/statusHistory joins that getCommissions
 * needs only for per-row DISPLAY fields never used in the summary math.
 * Reuses the exact same commissionsWhere()/computeCommissionMath() as
 * getCommissions, so the two can never disagree on which bookings are
 * eligible or how the numbers are computed — only what's SELECTED differs.
 */
export async function getCommissionsSummary(viewer: Viewer, filters: CommissionFilters = {}): Promise<CommissionSummary> {
  if (!viewer) return { bookingCount: 0, totalProfit: 0, totalCommission: 0, totalTips: 0, tipEarnings: 0, totalEarnings: 0, uniformTipPercent: null };

  const where = commissionsWhere(viewer, filters);
  const bookings = await prisma.booking.findMany({
    where,
    select: {
      profitAmount: true,
      gratuityAmount: true,
      quote: { select: { currency: true, exchangeRate: true, sentByAgent: { select: { commissionPercent: true, tipPercent: true } } } },
    },
  });

  let totalProfit = 0;
  let totalCommission = 0;
  let totalTips = 0;
  let tipEarnings = 0;
  const distinctTipPercents = new Set<number>();
  for (const b of bookings) {
    const math = computeCommissionMath({
      profitAmount: b.profitAmount,
      gratuityAmount: b.gratuityAmount,
      currency: b.quote.currency,
      exchangeRate: b.quote.exchangeRate,
      commissionPercent: b.quote.sentByAgent?.commissionPercent ?? null,
      tipPercent: b.quote.sentByAgent?.tipPercent ?? null,
    });
    totalProfit += math.profit;
    totalCommission += math.commissionAmount;
    totalTips += math.grossTip;
    tipEarnings += math.tipEarned;
    distinctTipPercents.add(math.tipPercent);
  }

  return {
    bookingCount: bookings.length,
    totalProfit,
    totalCommission,
    totalTips,
    tipEarnings,
    totalEarnings: totalCommission + tipEarnings,
    uniformTipPercent: distinctTipPercents.size === 1 ? [...distinctTipPercents][0] : null,
  };
}
