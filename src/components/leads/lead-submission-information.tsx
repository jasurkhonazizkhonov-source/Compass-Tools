import { MapPin } from "lucide-react";
import { formatCapturedAt } from "@/components/leads/lead-captured-event";
import { hasIpLocation } from "@/components/security/ip-location";

export type LeadSubmissionDetails = {
  ipAddress: string | null;
  ipVersion: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** ISO 4217 code the customer chose for their budget — only set when they entered one. */
  budgetCurrency?: string | null;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/**
 * "Lead Submission Information": what the server learned about the request that
 * created the lead. "Submitted" is the lead row's own creation time (the same
 * canonical, never-rewritten timestamp the Lead Captured entry above uses), not an
 * acceptance, reassignment or update time. The IP address is what the server's
 * trusted request path received; the city/country/region/time zone are the
 * platform's APPROXIMATE, IP-derived estimate of where that network is — never the
 * visitor's exact position — and each is shown only when it exists (nothing is
 * invented for a missing one).
 *
 * Only ever rendered for a viewer who passed the lead's own access check
 * (queries/lead-submission-info.ts); it is a separate query so these values are
 * never part of a list or an ordinary lead payload.
 */
export function LeadSubmissionInformation({ createdAt, info, fromWebsite }: { createdAt: Date; info: LeadSubmissionDetails | null; fromWebsite: boolean }) {
  if (!info) {
    if (!fromWebsite) return null;
    return (
      <div className="mb-5 rounded-lg border border-dashed px-4 py-3" data-testid="lead-submission-information">
        <p className="text-sm font-medium">Lead Submission Information</p>
        <p className="text-xs text-muted-foreground">No IP address or location was recorded for this submission.</p>
      </div>
    );
  }
  const country = info.country ? (info.countryCode ? `${info.country} (${info.countryCode})` : info.country) : info.countryCode;
  const located = hasIpLocation({ city: info.city, region: info.region, country: info.country, countryCode: info.countryCode, timeZone: info.timeZone });
  return (
    <section className="mb-5 rounded-lg border px-4 py-3" aria-labelledby="lead-submission-heading" data-testid="lead-submission-information">
      <h3 id="lead-submission-heading" className="mb-2 flex items-center gap-2 text-sm font-medium">
        <MapPin className="h-3.5 w-3.5 text-primary" /> Lead Submission Information
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        <Field label="Submitted">
          <time dateTime={createdAt.toISOString()}>{formatCapturedAt(createdAt)}</time>
        </Field>
        {info.ipAddress && (
          <Field label="IP Address">
            <span className="font-mono break-all">{info.ipAddress}</span>
            {info.ipVersion && <span className="ml-2 rounded border px-1 text-[10px] uppercase text-muted-foreground">{info.ipVersion}</span>}
          </Field>
        )}
        {info.city && <Field label="Approximate City">{info.city}</Field>}
        {country && <Field label="Approximate Country">{country}</Field>}
        {info.region && <Field label="Region">{info.region}</Field>}
        {info.timeZone && <Field label="Timezone">{info.timeZone}</Field>}
        {info.budgetCurrency && <Field label="Budget currency">{info.budgetCurrency}</Field>}
      </dl>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {located ? "Location is estimated from the IP address and shows roughly where the network is, not the customer's exact position." : "No location could be determined for this IP address."}
      </p>
    </section>
  );
}
