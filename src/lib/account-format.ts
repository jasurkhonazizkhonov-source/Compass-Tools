import { differenceInCalendarMonths } from "date-fns";
import type { AccountRole } from "@/generated/prisma/client";
import type { SidebarAccount } from "@/components/layout/sidebar-user-panel";

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** First/last name split for DISPLAY ONLY — Account has a single `fullName`
 * field in the schema, so this never persists anywhere. */
export function splitName(fullName: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = fullName.split(" ");
  return { firstName: firstName ?? "", lastName: rest.join(" ") };
}

/** Computed fresh on every call from `hiredAt` — never store the result,
 * since tenure keeps changing as long as the employee stays. */
export function formatTenure(hiredAt: Date | null): string {
  if (!hiredAt) return "Hire date not set";
  const now = new Date();
  if (hiredAt > now) return `Starts ${hiredAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}`;

  const totalMonths = differenceInCalendarMonths(now, hiredAt);
  if (totalMonths < 1) return "Less than a month";

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** Compact Y/M/D "hire age" for the booking-profit-notification email
 * subject (Part 17), e.g. "6Y6M28D" — distinct from formatTenure's prose
 * style, which reads naturally in a sentence but is too verbose for a
 * subject line. Computed from `hiredAt`, NOT the account holder's actual
 * age — null (hire date never set) returns null; the caller decides how to
 * degrade the subject line in that case. */
export function formatHireAgeCompact(hiredAt: Date | null, now: Date = new Date()): string | null {
  if (!hiredAt || Number.isNaN(hiredAt.getTime())) return null;

  // Hire dates are stored as UTC-midnight calendar dates (see AccountHiredAtEditor, and every
  // display of the date uses timeZone "UTC"), so both sides are compared as UTC calendar days —
  // the result never shifts with the server's or viewer's local zone, nor with the time of day.
  const hireDay = Date.UTC(hiredAt.getUTCFullYear(), hiredAt.getUTCMonth(), hiredAt.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (hireDay > today) return null;

  // The anniversary `monthsSinceHire` months after the hire date, clamped to the last day of a
  // shorter month (hired Jan 31 -> Feb 28/29 -> Mar 31 ...).
  const anniversary = (monthsSinceHire: number): number => {
    const total = hiredAt.getUTCMonth() + monthsSinceHire;
    const year = hiredAt.getUTCFullYear() + Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(hiredAt.getUTCDate(), lastDay));
  };

  // Largest whole number of months whose anniversary is not after today (an upper bound from the
  // calendar-month difference, stepped down at most once), then the leftover days.
  let months = (now.getUTCFullYear() - hiredAt.getUTCFullYear()) * 12 + (now.getUTCMonth() - hiredAt.getUTCMonth());
  while (months > 0 && anniversary(months) > today) months--;
  const days = Math.round((today - anniversary(months)) / (24 * 60 * 60 * 1000));

  return `${Math.floor(months / 12)}Y${months % 12}M${days}D`;
}

/**
 * The one place a full Account row (as returned by getCurrentAccount(),
 * used server-side throughout this app for authorization — visibility.ts,
 * permissions.ts, etc.) gets narrowed down to only what the nav chrome
 * (SidebarShell/Topbar/AccountMenu, all Client Components) actually
 * renders, before it crosses the Server -> Client boundary. This is
 * required, not just tidy: Account.commissionPercent is a Prisma Decimal
 * instance (a class, not a plain value) — React Server Components can only
 * pass plain serializable data to Client Components (string/number/
 * boolean/null/undefined/Date/plain objects/arrays), and handing the raw
 * Account row to a Client Component prop throws "Only plain objects can be
 * passed to Client Components... Decimal objects are not supported" the
 * moment commissionPercent is actually set on the signed-in account. Date
 * fields (hiredAt) are fine as-is — Date is natively supported by RSC
 * serialization, unlike Decimal.
 *
 * Deliberately kept in this plain (non-"use client") module rather than
 * alongside the SidebarAccount type in sidebar-user-panel.tsx: a "use
 * client" file's exports are ALL treated as client references by Next.js's
 * RSC boundary, even a pure non-component helper like this one — calling
 * it from a Server Component (layout.tsx) throws "Attempted to call
 * toSidebarAccount() from the server but toSidebarAccount is on the
 * client." Only the TYPE is imported back from that file (types are
 * erased at compile time, so re-exporting one across the boundary is fine
 * — only runtime function/value exports from a "use client" module are
 * restricted this way).
 */
export function toSidebarAccount(account: {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: AccountRole;
  hiredAt: Date | null;
}): SidebarAccount {
  return {
    id: account.id,
    fullName: account.fullName,
    email: account.email,
    phone: account.phone,
    role: account.role,
    hiredAt: account.hiredAt,
  };
}
