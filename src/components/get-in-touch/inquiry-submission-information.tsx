import { MapPin } from "lucide-react";
import { formatCapturedAt } from "@/components/leads/lead-captured-event";
import { hasIpLocation } from "@/components/security/ip-location";
import { LeadIpReveal } from "@/components/leads/lead-ip-reveal";
import { geoAttributionFor } from "@/server/geo/geoip-attribution";
import { revealInquirySubmissionIp } from "@/server/actions/inquiry-submission";
import type { InquirySource } from "@/generated/prisma/client";

export type InquirySubmissionDetails = {
  /** Whether an IP address was captured - the address itself never reaches this component. */
  hasIp: boolean;
  ipVersion: "v4" | "v6" | null;
  /** "203.x.x.x" - first octet / hextet only. */
  ipMasked: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** Where the location came from (e.g. "DBIP-City-Lite (2026-11-01)"); shown only next to a location. */
  geoSource?: string | null;
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
 * "Submission & IP Information" of a public inquiry (Admin inbox only - the caller has already passed canViewGetInTouch and the inquiry's own
 * company/source scoping). The IP is shown MASKED with the audited, recent-sign-in-gated Reveal; the location is the approximate, IP-derived
 * estimate and each part is shown only when it exists. An inquiry for which nothing trustworthy was known says so plainly instead of inventing it.
 */
export function InquirySubmissionInformation({ inquiryId, source, createdAt, info }: { inquiryId: string; source: InquirySource; createdAt: Date; info: InquirySubmissionDetails | null }) {
  if (!info) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-3" data-testid="inquiry-submission-information">
        <p className="text-sm font-medium">Submission &amp; IP Information</p>
        <p className="text-xs text-muted-foreground">No IP address or location was recorded for this inquiry.</p>
      </div>
    );
  }
  const located = hasIpLocation({ city: info.city, region: info.region, country: info.country, countryCode: info.countryCode, timeZone: info.timeZone });
  // CC BY 4.0 asks for a credit wherever the database's results are shown (the Users page already carries it).
  const geoCredit = geoAttributionFor([info.geoSource]);
  return (
    <section className="rounded-lg border px-4 py-3" aria-labelledby="inquiry-submission-heading" data-testid="inquiry-submission-information">
      <h3 id="inquiry-submission-heading" className="mb-2 flex items-center gap-2 text-sm font-medium">
        <MapPin className="h-3.5 w-3.5 text-primary" /> Submission &amp; IP Information
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        <Field label="Submitted">
          <time dateTime={createdAt.toISOString()}>{formatCapturedAt(createdAt)}</time>
        </Field>
        {info.hasIp && info.ipMasked && (
          <Field label="IP Address (masked)">
            <LeadIpReveal leadId={inquiryId} masked={info.ipMasked} canReveal revealAction={revealInquirySubmissionIp.bind(null, inquiryId, source)} />
          </Field>
        )}
        {info.hasIp && info.ipVersion && <Field label="IP Version">{info.ipVersion === "v6" ? "IPv6" : "IPv4"}</Field>}
        {info.city && <Field label="Approximate City">{info.city}</Field>}
        {info.region && <Field label="Approximate Region">{info.region}</Field>}
        {info.country && <Field label="Approximate Country">{info.country}</Field>}
        {info.countryCode && <Field label="Country Code">{info.countryCode}</Field>}
        {info.timeZone && <Field label="Time Zone">{info.timeZone}</Field>}
        {located && info.geoSource && <Field label="Location source">{info.geoSource}</Field>}
      </dl>
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {located ? "Location is approximate and derived from the submitting IP address." : "No location could be determined for this IP address."}
      </p>
      {located && geoCredit.length > 0 && (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground" data-testid="geoip-attribution">
          {geoCredit.join(" ")}
        </p>
      )}
    </section>
  );
}
