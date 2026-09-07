import { prisma } from "@/lib/prisma";
import type { Viewer } from "@/server/visibility";
import { ROLE_LABELS } from "@/lib/permissions";

export type SalesboardPeriod = "today" | "week" | "month" | "year" | "all";

// Same America/Los_Angeles convention as the Pacific clock (Part 22) — this
// app has no per-user timezone preference, so "Today"/"This Week" boundaries
// are computed against one consistent zone rather than the server process's
// ambient TZ (which would silently vary by deployment).
const BOARD_TIMEZONE = "America/Los_Angeles";

function zonedNow(): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOARD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return new Date(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`);
}

function periodStart(period: SalesboardPeriod): Date | undefined {
  if (period === "all") return undefined;
  const now = zonedNow();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return startOfToday;
  if (period === "week") {
    const dayOfWeek = startOfToday.getDay();
    return new Date(startOfToday.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
  }
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(now.getFullYear(), 0, 1); // "year"
}

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
export async function getSalesboard(viewer: Viewer, period: SalesboardPeriod = "all") {
  if (!viewer) return [];

  const start = periodStart(period);
  // Company scoping (c."companyId"), the CONFIRMED/profitAmount-not-null
  // filter, and the inner join to Account (which drops any quote with no
  // recorded sender — matching the old code's `if (!agent) continue`)
  // preserve the exact same row eligibility as before; only where the
  // summation happens has changed.
  const rows = start
    ? await prisma.$queryRaw<SalesboardRow[]>`
        SELECT a."id" AS "agentId", a."fullName", a."role",
               COALESCE(SUM(b."profitAmount"), 0)::float8 AS "profit",
               COUNT(*)::int AS "bookingCount"
        FROM "Booking" b
        JOIN "Quote" q ON q."id" = b."quoteId"
        JOIN "Contact" c ON c."id" = b."contactId"
        JOIN "Account" a ON a."id" = q."sentByAgentId"
        WHERE b."status" = 'CONFIRMED' AND b."profitAmount" IS NOT NULL
          AND c."companyId" = ${viewer.companyId} AND b."updatedAt" >= ${start}
        GROUP BY a."id", a."fullName", a."role"
      `
    : await prisma.$queryRaw<SalesboardRow[]>`
        SELECT a."id" AS "agentId", a."fullName", a."role",
               COALESCE(SUM(b."profitAmount"), 0)::float8 AS "profit",
               COUNT(*)::int AS "bookingCount"
        FROM "Booking" b
        JOIN "Quote" q ON q."id" = b."quoteId"
        JOIN "Contact" c ON c."id" = b."contactId"
        JOIN "Account" a ON a."id" = q."sentByAgentId"
        WHERE b."status" = 'CONFIRMED' AND b."profitAmount" IS NOT NULL
          AND c."companyId" = ${viewer.companyId}
        GROUP BY a."id", a."fullName", a."role"
      `;

  // Part 13 — Commission is private and deliberately never computed or
  // exposed here; the Salesboard shows sales/profit only.
  return rows
    .map((r) => ({ id: r.agentId, fullName: r.fullName, role: ROLE_LABELS[r.role], profit: r.profit, bookingCount: r.bookingCount }))
    .sort((a, b) => b.profit - a.profit);
}
