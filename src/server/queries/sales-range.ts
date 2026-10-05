import { Prisma } from "@/generated/prisma/client";
import { civilRangeToInstants, resolveReportRange, type CivilDate, type ResolvedReportRange } from "@/lib/pay-period";

/**
 * The date window every sales report (Salesboard, Commissions) filters on: [start, endExclusive) as real instants. Either end
 * may be absent ("all time" has neither). Produced from a resolved report range by `toSalesRange`, so the business-zone calendar
 * logic lives in ONE place (lib/pay-period.ts).
 */
export type SalesRange = { start?: Date; endExclusive?: Date };

/** The legacy Salesboard period names accepted by getSalesboard's second argument (kept so old callers and links keep working). */
export type LegacySalesPeriod = "today" | "week" | "month" | "year" | "all";

export function toSalesRange(input: SalesRange | ResolvedReportRange | LegacySalesPeriod | undefined, now: Date = new Date()): SalesRange {
  if (input === undefined) return {};
  if (typeof input === "string") return toSalesRange(resolveReportRange({ period: input }, now));
  if ("kind" in input) {
    if (!input.from || !input.to) return {};
    const { start, endExclusive } = civilRangeToInstants(input.from, input.to);
    return { start, endExclusive };
  }
  return input;
}

/**
 * THE date a sale counts on: the moment the booking was (last) moved to CONFIRMED, from its status history — the same event the
 * commission rule already depends on ("a booking counts once it is saved as Confirmed with a profit").
 *
 * It is deliberately NOT Booking.updatedAt. That column moves on every later save (ticket numbers, notes, the airline-confirmation
 * email claim, a profit recompute …), so anchoring pay periods on it would silently move a confirmed sale into a LATER period
 * the next time anyone touched the booking — and a closed period's totals would change after the fact. A booking confirmed before
 * status history existed has no history row; for those the previous behaviour (updatedAt) is kept as the fallback, so nothing
 * disappears from reporting. Alias `b` must be the Booking table in the surrounding query.
 */
export const SALE_AT_SQL = Prisma.sql`COALESCE((SELECT MAX(h."changedAt") FROM "BookingStatusHistory" h WHERE h."bookingId" = b."id" AND h."toStatus" = 'CONFIRMED'), b."updatedAt")`;

/** `AND <sale date> >= start AND <sale date> < endExclusive` for whichever ends are present; empty for "all time". */
export function saleDateConditions(range: SalesRange): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (range.start) parts.push(Prisma.sql`AND ${SALE_AT_SQL} >= ${range.start}`);
  if (range.endExclusive) parts.push(Prisma.sql`AND ${SALE_AT_SQL} < ${range.endExclusive}`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

/** An inclusive civil-day range (business zone) as the database window — used for the "previous equivalent period". */
export function salesRangeForDays(from: CivilDate, to: CivilDate): SalesRange {
  const { start, endExclusive } = civilRangeToInstants(from, to);
  return { start, endExclusive };
}
