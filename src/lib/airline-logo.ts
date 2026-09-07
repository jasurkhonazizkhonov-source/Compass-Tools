// Centralized fallback source for airline logos. `Airline.logoUrl` in the
// database is never populated by anything in this codebase (the seed
// script omits it, and there is no backfill) — every airline falls back to
// this before landing on the boxed-code display, instead of showing no
// logo at all for airlines nobody has manually patched in the DB.
//
// Uses a public, widely-hotlinked airline-logo image CDN, keyed by IATA
// code — no API key, no new npm dependency. An explicit `Airline.logoUrl`
// value (if one is ever set) always takes precedence over this; see
// resolveAirlineDisplay in canonical-segment.ts, the single call site that
// wires this in. If the CDN doesn't have a given airline, the existing
// AirlineLogo component's onError fallback (the boxed IATA-code box) still
// applies — this never introduces a broken-image state, only a possible
// logo miss that degrades to the same fallback as before this existed.
const IATA_CODE_PATTERN = /^[A-Za-z0-9]{2}$/;

export function airlineLogoUrl(iata: string | null | undefined): string | null {
  if (!iata || !IATA_CODE_PATTERN.test(iata)) return null;
  // Matches the exact URL shape already stored (correctly) on ~1,100
  // Airline rows in this database — standardizing on the pattern already
  // proven to work here rather than a differently-shaped guess.
  return `https://images.kiwi.com/airlines/64x64/${iata.toUpperCase()}.png`;
}
