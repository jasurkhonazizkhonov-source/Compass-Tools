// Plain (non-"use client") home for status-filter URL-param parsing —
// deliberately NOT inside status-filter-select.tsx, which is a "use
// client" file: every export from a client-component file becomes a
// client reference, so even a pure, non-React utility function placed
// there can never be called from a Server Component (the exact RSC
// boundary error this file exists to avoid). Server list pages (Quotes,
// Bookings, ...) call this directly; StatusFilterSelect (the client-side
// multi-select control) reads/writes the same "A,B,C" URL shape itself.

/** Parses a comma-separated status-list URL param ("A,B,C") into a typed
 * array for a query function's `status: T[]` filter — returns undefined
 * (not an empty array) when nothing is selected, so callers can spread it
 * straight into a Prisma `where` without an extra "is this empty" check. */
export function parseStatusListParam<T extends string>(raw: string | undefined): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").filter(Boolean) as T[];
  return values.length > 0 ? values : undefined;
}
