// Credit lines the geolocation data's licences ask for, chosen from the "source" stored beside each location
// (e.g. "DBIP-City-Lite (2026-11-01)"). Shown on the Admin Users page where the approximate locations are displayed.
// A source that needs no credit (the edge's own country header, or no source) contributes nothing.
const DBIP = "IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0.";
const MAXMIND = "This product includes GeoLite data created by MaxMind, available from https://www.maxmind.com.";

export function geoAttributionFor(sources: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    if (/dbip|db-ip/i.test(s)) out.add(DBIP);
    else if (/geolite|geoip2/i.test(s)) out.add(MAXMIND);
  }
  return [...out];
}

/** One-line explanation for the location cell's tooltip: where it came from and that it is approximate. */
export function describeLocationSource(source: string | null | undefined, resolvedAt: Date | null | undefined): string | null {
  if (!source) return null;
  const when = resolvedAt ? `, looked up ${resolvedAt.toISOString().slice(0, 10)}` : "";
  return `Approximate, estimated from the sign-in IP address (${source}${when})`;
}
