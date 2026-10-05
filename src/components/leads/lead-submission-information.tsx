import { MapPin } from "lucide-react";
import { formatCapturedAt } from "@/components/leads/lead-captured-event";
import { hasIpLocation } from "@/components/security/ip-location";
import { LeadIpReveal } from "@/components/leads/lead-ip-reveal";

export type LeadSubmissionDetails = {
  /** Whether an IP address was captured — the address itself never reaches this component. */
  hasIp: boolean;
  ipVersion: "v4" | "v6" | null;
  /** "203.x.x.x" — first octet / hextet only. */
  ipMasked: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** ISO 4217 code the customer chose for their budget — only set when they entered one. */
  budgetCurrency?: string | null;
};

/** A website lead younger than this may simply not have had its submission details written yet. */
const RECENT_LEAD_MS = 10 * 60 * 1000;

/** Kept out of the component body: it reads the clock, and a render must stay pure. */
export function isRecentlyCaptured(createdAt: Date, now: number = Date.now()): boolean {
  return now - createdAt.getTime() < RECENT_LEAD_MS;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/**
 * "Submission & IP Information": what the server learned about the request that
 * created the lead. "Submitted" is the lead row's own creation time (the same
 * canonical, never-rewritten timestamp the Lead Captured entry above uses), not an
 * acceptance, reassignment or update time. The IP address is what the server's
 * trusted request path received — shown MASKED, with a permission-gated, audited Reveal for the
 * full value (it is sensitive personal data); the city/country/region/time zone are the
 * platform's APPROXIMATE, IP-derived estimate of where that network is — never the
 * visitor's exact position — and each is shown only when it exists (nothing is
 * invented for a missing one).
 *
 * Only ever rendered for a viewer who passed the lead's own access check
 * (queries/lead-submission-info.ts); it is a separate query so these values are
 * never part of a list or an ordinary lead payload.
 */
export function LeadSubmissionInformation({ leadId, createdAt, info, fromWebsite, canRevealIp }: { leadId: string; createdAt: Date; info: LeadSubmissionDetails | null; fromWebsite: boolean; canRevealIp: boolean }) {
  if (!info) {
    if (!fromWebsite) return null;
    // The website records this a moment AFTER it saves the lead (best-effort, after its response), so
    // a brand-new lead can legitimately have no row yet. Say that neutrally instead of claiming nothing
    // was recorded; an older lead without one really has none.
    if (isRecentlyCaptured(createdAt)) {
      return (
        <div className="mb-5 rounded-lg border border-dashed px-4 py-3" data-testid="lead-submission-information">
          <p className="text-sm font-medium">Submission &amp; IP Information</p>
          <p className="text-xs text-muted-foreground">Submission information is not available yet — it may still be being recorded. Refresh in a moment.</p>
        </div>
      );
    }
    return (
      <div className="mb-5 rounded-lg border border-dashed px-4 py-3" data-testid="lead-submission-information">
        <p className="text-sm font-medium">Submission &amp; IP Information</p>
        <p className="text-xs text-muted-foreground">No IP address or location was recorded for this submission.</p>
      </div>
    );
  }
  const located = hasIpLocation({ city: info.city, region: info.region, country: info.country, countryCode: info.countryCode, timeZone: info.timeZone });
  return (
    <section className="mb-5 rounded-lg border px-4 py-3" aria-labelledby="lead-submission-heading" data-testid="lead-submission-information">
      <h3 id="lead-submission-heading" className="mb-2 flex items-center gap-2 text-sm font-medium">
        <MapPin className="h-3.5 w-3.5 text-primary" /> Submission &amp; IP Information
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        <Field label="Submitted">
          <time dateTime={createdAt.toISOString()}>{formatCapturedAt(createdAt)}</time>
        </Field>
        {info.hasIp && info.ipMasked && (
          <Field label="IP Address (masked)">
            <LeadIpReveal leadId={leadId} masked={info.ipMasked} canReveal={canRevealIp} />
          </Field>
        )}
        {info.hasIp && info.ipVersion && <Field label="IP Version">{info.ipVersion === "v6" ? "IPv6" : "IPv4"}</Field>}
        {info.city && <Field label="Approximate City">{info.city}</Field>}
        {info.region && <Field label="Approximate Region">{info.region}</Field>}
        {info.country && <Field label="Approximate Country">{info.country}</Field>}
        {info.countryCode && <Field label="Country Code">{info.countryCode}</Field>}
        {info.timeZone && <Field label="Time Zone">{info.timeZone}</Field>}
        {info.budgetCurrency && <Field label="Budget currency">{info.budgetCurrency}</Field>}
      </dl>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {located ? "Location is approximate and derived from the submitting IP address." : "No location could be determined for this IP address."}
      </p>
    </section>
  );
}
