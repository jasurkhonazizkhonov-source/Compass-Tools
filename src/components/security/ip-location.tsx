import { Globe2 } from "lucide-react";

export type IpLocationValue = {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  countryCode?: string | null;
  timeZone?: string | null;
};

/** True when the location carries at least one real value. */
export function hasIpLocation(location: IpLocationValue | null | undefined): location is IpLocationValue {
  return !!location && !!(location.city || location.region || location.country || location.countryCode || location.timeZone);
}

/** "San Francisco, California, United States" — only the parts that exist. */
export function ipLocationSummary(location: IpLocationValue): string {
  return [location.city, location.region, location.country ?? location.countryCode].filter(Boolean).join(", ");
}

function Row({ label, value, fallback }: { label: string; value?: string | null; fallback?: string }) {
  if (!value && !fallback) return null;
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium break-words ${value ? "" : "text-muted-foreground"}`}>{value || fallback}</p>
    </div>
  );
}

/**
 * Approximate, IP-derived location. City and Country are always listed (as "Not
 * available" when the platform did not supply them — never invented); region and
 * time zone only when present. The wording says "approximate" and "IP-based" on
 * purpose: this estimates where the signer's NETWORK is, not where the person
 * was — VPNs, mobile networks, corporate gateways and privacy relays all make it
 * wrong or coarse.
 */
export function IpLocationFields({ location, emptyNote = "Location was not captured for this event." }: { location: IpLocationValue | null | undefined; emptyNote?: string }) {
  if (!hasIpLocation(location)) {
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Globe2 className="h-3.5 w-3.5" /> Approximate location (IP-based)
        </p>
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      </div>
    );
  }
  const country = location.country ? (location.countryCode ? `${location.country} (${location.countryCode})` : location.country) : location.countryCode;
  return (
    <div className="space-y-2" data-testid="ip-location">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Globe2 className="h-3.5 w-3.5" /> Approximate location (IP-based)
      </p>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <Row label="City" value={location.city} fallback="Not available" />
        <Row label="Country" value={country} fallback="Not available" />
        <Row label="Region / state" value={location.region} />
        <Row label="Time zone" value={location.timeZone} />
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">Estimated from the IP address. It indicates roughly where the network is, not the signer&apos;s exact position.</p>
    </div>
  );
}
