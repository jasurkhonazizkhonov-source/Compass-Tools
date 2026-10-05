import { prisma } from "@/lib/prisma";
import type { Viewer } from "@/server/visibility";
import { ROLE_LABELS } from "@/lib/permissions";

import { Prisma } from "@/generated/prisma/client";
import { saleDateConditions, toSalesRange, type LegacySalesPeriod, type SalesRange } from "@/server/queries/sales-range";
import type { ResolvedReportRange } from "@/lib/pay-period";

// Kept for callers that still pass a legacy period name. The calendar logic (business time zone, pay periods, custom ranges)
// lives in lib/pay-period.ts; this module only asks the database for the agents' totals inside one date window.
export type SalesboardPeriod = LegacySalesPeriod;

type SalesboardRow = { agentId: string; fullName: string; role: keyof typeof ROLE_LABELS; profit: number; bookingCount: number };

/**
 * Part 18 — leaderboard of confirmed-booking profit by user. Displayed rows
 * are agents (a small, headcount-bounded set — never paginated, and don't
 * need to be), but the INPUT this aggregates over is every CONFIRMED
 * booking the company has ever had, which grows without bound over time.
 *
 * Pass 24 — previously fetched every matching Booking row into application
 * memory and summed them in JS. `Booking.profitAmount` is already a
 * server-computed, final USD figure (see computeBookingProfitUsd) — no
 * currency conversion or other per-row business logic is needed to sum it,
 * unlike Commissions (see commissions.ts's own Pass 24 note for why THAT
 * one can't move to a pure DB-side aggregate the same way). That makes
 * this a genuine, safe candidate for a real SQL SUM/COUNT ... GROUP BY: the
 * database now does the aggregation, and only one row per AGENT (not per
 * booking) ever crosses into application memory, regardless of how many
 * thousands of bookings a company accumulates.
 */
export async function getSalesboard(viewer: Viewer, period: SalesRange | ResolvedReportRange | SalesboardPeriod = "all") {
  if (!viewer) return [];

  const range = toSalesRange(period);
  // Company scoping (c."companyId"), the CONFIRMED/profitAmount-not-null filter, and the inner join to Account (which drops any
  // quote with no recorded sender) are the same row eligibility as always; the date window is the only thing that varies, and
  // it is the shared sale-date rule (sales-range.ts) — so Salesboard, Commissions, "current period" and "custom range" all use
  // exactly one definition of when a sale counts.
  const rows = await prisma.$queryRaw<SalesboardRow[]>(Prisma.sql`
    SELECT a."id" AS "agentId", a."fullName", a."role",
           COALESCE(SUM(b."profitAmount"), 0)::float8 AS "profit",
           COUNT(*)::int AS "bookingCount"
    FROM "Booking" b
    JOIN "Quote" q ON q."id" = b."quoteId"
    JOIN "Contact" c ON c."id" = b."contactId"
    JOIN "Account" a ON a."id" = q."sentByAgentId"
    WHERE b."status" = 'CONFIRMED' AND b."profitAmount" IS NOT NULL
      AND c."companyId" = ${viewer.companyId}
      AND a."accountsVisible" = true
      ${saleDateConditions(range)}
    GROUP BY a."id", a."fullName", a."role"
  `);

  // Hidden accounts (Account.accountsVisible = false) are left off the board — the same operational-visibility rule as the
  // Accounts directory and the Lead Acceptance roster. Nothing is deleted: their bookings, profit and quotes are untouched and
  // still reachable everywhere else; a hidden user simply is not shown as a current salesperson. Hidden is a different state
  // from inactive (blocks login) and paused (queue only), which this does not look at.
  //
  // Part 13 — Commission is private and deliberately never computed or exposed here; the Salesboard shows sales/profit only.
  return rows
    .map((r) => ({ id: r.agentId, fullName: r.fullName, role: ROLE_LABELS[r.role], profit: r.profit, bookingCount: r.bookingCount }))
    .sort((a, b) => b.profit - a.profit);
}

/** Company-visible totals for a set of Salesboard rows (what the KPI cards show). */
export function summarizeSalesboard(rows: { profit: number; bookingCount: number }[]) {
  const totalProfit = rows.reduce((sum, r) => sum + r.profit, 0);
  const bookingCount = rows.reduce((sum, r) => sum + r.bookingCount, 0);
  return { totalProfit, bookingCount, averageProfit: bookingCount > 0 ? totalProfit / bookingCount : null };
}
