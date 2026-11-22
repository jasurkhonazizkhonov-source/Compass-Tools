// The "Last sign-in location" cell of the Administrator-only Users table. Presentational only: it is given what the Administrator-only query returned (queries/accounts.ts
// getAccountSignInDetails, which returns nothing at all to any other role), so it can never widen who sees a location.
//
// What it shows, only where it exists (nothing is invented): "City, Region, Country (CC)", the time zone, and the source of the estimate. A location that is only a country says
// so ("City not determined") instead of leaving the reader to wonder whether the city was lost. It is an estimate of where the NETWORK is, never of where a person is.

export type SignInLocationDetails = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** e.g. "DBIP-City-Lite (2026-11-01)". */
  source: string | null;
  /** Tooltip sentence: approximate, and where it came from. */
  note: string | null;
};

/** "Frankfurt am Main, Hesse, Germany (DE)": the parts that exist, a repeated neighbour dropped ("Singapore, Singapore"), the country code beside the country name. */
export function formatLocationLine(d: Pick<SignInLocationDetails, "city" | "region" | "country" | "countryCode">): string | null {
  const countryPart = d.country && d.countryCode ? `${d.country} (${d.countryCode})` : d.country ?? d.countryCode;
  const parts = [d.city, d.region, countryPart]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .filter((p, i, all) => i === 0 || p.toLowerCase() !== all[i - 1].toLowerCase());
  return parts.length > 0 ? parts.join(", ") : null;
}

export function SignInLocationCell({ details, signedIn }: { details: SignInLocationDetails | undefined; signedIn: boolean }) {
  const line = details ? formatLocationLine(details) : null;
  if (!details || !line) {
    return <span className="text-muted-foreground">{signedIn ? "Location unavailable" : "—"}</span>;
  }
  const cityKnown = !!details.city;
  return (
    <div className="space-y-0.5" title={details.note ? `${line} — ${details.note}` : line}>
      <div data-testid="last-sign-in-place">{line}</div>
      {!cityKnown && (
        <div className="text-[11px] text-muted-foreground" data-testid="last-sign-in-city-missing">
          City not determined (country-level result)
        </div>
      )}
      {details.timeZone && (
        <div className="text-[11px] text-muted-foreground" data-testid="last-sign-in-timezone">
          Time zone: {details.timeZone}
        </div>
      )}
      {details.source && (
        <div className="text-[11px] text-muted-foreground" data-testid="last-sign-in-source">
          Source: {details.source}
        </div>
      )}
    </div>
  );
}
