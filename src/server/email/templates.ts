// Maintainable email-template architecture: each template is a small pure
// function returning { subject, html }. Built with table-based layouts and
// inline styles throughout — Outlook/Gmail/Apple Mail don't reliably
// support modern CSS (flexbox, grid, custom properties), so this
// deliberately avoids all of it in favor of the classic email-safe subset.
//
// Branding rule: customer-facing templates (quote, booking confirmation)
// use the SENDING RECORD's OWN Company branding (name/logo/website/phone)
// — every exported builder below takes a `company: ResolvedCompanyBranding`
// parameter for this, resolved by the caller via
// src/server/queries/company.ts. Never a hardcoded name. The internal-only
// templates (agent/staff notifications) use the product name "Compass
// Tools" for their chrome (see internalWrapper) since only CRM users ever
// see them, but still show the relevant Company's own logo where useful.

import { PRODUCT_NAME, type ResolvedCompanyBranding } from "@/lib/company-config";
import { formatAirportDate, formatAirportTime } from "@/lib/airport-datetime";
import { CURRENCY_SYMBOLS, type SupportedCurrency } from "@/lib/currency";
import { resolveSignature, splitFullName } from "@/lib/email-signature";
import { calculateJourneyDuration, type JourneyLegInput } from "@/lib/flight-duration";
import { customerGreeting, firstNameGreeting } from "@/lib/customer-name";

// Timezone used to render internal-notification date/times (e.g. task due
// dates) consistently regardless of what timezone the server process
// happens to run in — a display formatting concern, not per-company
// branding, so it isn't part of the Company model.
const DISPLAY_TIMEZONE = "America/New_York";

export type EmailAgent = {
  fullName: string;
  email: string;
  phone: string | null;
};

export type EmailSegment = {
  /** FlightSegment.id — optional only because a few older/synthetic call
   * sites never had a reason to carry it; every real DB-backed segment
   * (via toEmailSegments) always sets it. Used to mark specific segments
   * as cancelled (see renderItineraryHtml's cancelledSegmentIds param). */
  id?: string;
  airlineName: string;
  airlineCode: string;
  airlineLogoUrl: string | null;
  flightNumber: string;
  cabin: string;
  bookingClass: string | null;
  aircraft: string | null;
  /** e.g. "Operated by PAL Express" — null when not a codeshare/no
   * operating-carrier line was present. See canonical-segment.ts. */
  operatingCarrierLabel: string | null;
  departureAirportCode: string;
  departureCity: string;
  arrivalAirportCode: string;
  arrivalCity: string;
  departureAt: Date;
  arrivalAt: Date;
  durationMinutes: number | null;
  /** Pass 11 Part 2 — Airport.timezone (IANA identifier) for each side,
   * used exclusively by calculateJourneyDuration for a timezone-aware
   * "Total journey time"/Connection calculation. Optional/nullable only
   * for older/synthetic call sites; toEmailSegments (segment-mapper.ts)
   * always sets both for real DB-backed segments. */
  departureTimezone?: string | null;
  arrivalTimezone?: string | null;
  connectionType: "LAYOVER" | "MULTI_CITY" | null;
  /** A "bonus" leg included at no extra charge. Only meaningfully set on
   * emails that show the full itinerary (booking confirmation) — the
   * initial quote email excludes extra-leg segments entirely before ever
   * reaching this type, so this is always false/undefined there. */
  isExtraLeg?: boolean;
};

export type EmailPricing = {
  adults: number;
  children: number;
  infants: number;
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  taxes: number;
  serviceFee: number;
  gratuity: number;
  total: number;
  /** Customer-facing currency this breakdown is already denominated in
   * (the amounts above are the FROZEN converted values, not raw USD — see
   * Quote.pricingSnapshot / buildPricingSnapshot). Defaults to USD so
   * existing call sites that haven't been updated yet still render
   * correctly. */
  currency?: SupportedCurrency;
};

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Pass 24 — a currency-symbol-prefixed amount that may legitimately be
 * negative (profit, e.g. a loss-making sale) formats the sign BEFORE the
 * symbol ("-$150.00"), never after it. `${symbol}${fmtMoney(n)}` alone
 * produces "$-150.00" for a negative `n`, because `toLocaleString` puts
 * the minus sign on the number itself — this is the one place that gets
 * the sign placement right, used anywhere a possibly-negative amount
 * (profit) is shown with its currency symbol.
 */
function fmtSignedMoney(symbol: string, n: number): string {
  return n < 0 ? `-${symbol}${fmtMoney(Math.abs(n))}` : `${symbol}${fmtMoney(n)}`;
}

/**
 * Shared "| {Company Name}" suffix for every CUSTOMER-facing email subject
 * — the one place that owns this formatting so every customer subject
 * builder below stays consistent instead of each hand-rolling its own
 * `${subject} | ${company.name}` append. Never used for internal/staff
 * notification subjects (buildBookingProfitNotificationEmail,
 * buildBookingSignedNotificationEmail, buildTaskReminderEmail,
 * buildReassignmentEmail) — those keep their existing, unbranded subject
 * format untouched by design (only CRM staff ever see them).
 *
 * A subject that already names the company (e.g.
 * buildCvvRecollectionEmail's "... — {company.name}") is returned
 * unchanged rather than double-appended.
 */
function withCompanySuffix(subject: string, company: ResolvedCompanyBranding): string {
  if (!company.name || subject.includes(company.name)) return subject;
  return `${subject} | ${company.name}`;
}

function fmtDuration(minutes: number | null): string {
  if (minutes == null || minutes < 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

// fmtDate/fmtTime are thin local aliases for the shared airport-datetime
// formatters — kept so the many call sites below don't need renaming, but
// there is only one implementation (src/lib/airport-datetime.ts), shared
// with the CRM/View Deal/booking-page renderer, so the two can never drift
// apart again.
const fmtDate = formatAirportDate;
const fmtTime = formatAirportTime;

// Resolves the admin-configured Company.signatureTemplate against the
// ACTUAL sending person's own name/phone at render time — never a stored
// per-user copy, so an admin editing the template in Company settings
// immediately changes every future email's signature. A system-generated
// email with no personal sender (agent undefined) falls back to the
// company's own name/phone in place of a person's, per the spec's explicit
// "fall back to company/system branding for system-generated notifications
// with no personal sender" requirement.
function renderSignatureHtml(company: ResolvedCompanyBranding, agent?: EmailAgent): string {
  const { firstName, lastName } = agent ? splitFullName(agent.fullName) : { firstName: company.name, lastName: "" };
  const phone = (agent?.phone || company.phone) ?? "";
  const resolvedText = resolveSignature(company.signatureTemplate, { firstName, lastName, phone });
  const signatureLines = escapeHtml(resolvedText).replace(/\n/g, "<br/>");

  // Part 4 — signature text sized slightly larger than the surrounding
  // 12px email body copy for readability, without becoming disproportionate
  // (13px company name/contact line, 14px for the agent's own signature
  // block, which is the part a customer is most likely to actually read).
  const personalLines = agent
    ? `<p style="margin:0 0 8px; font-size:14px; color:#374151; line-height:1.7;">${signatureLines}</p>
       <p style="margin:0 0 14px; font-size:13px; color:#4b5563; line-height:1.8;">
         <a href="mailto:${agent.email}" style="color:#4b5563; text-decoration:none; word-break:break-all; overflow-wrap:anywhere;">${agent.email}</a>
       </p>`
    : `<p style="margin:0 0 14px; font-size:14px; color:#374151; line-height:1.7;">${signatureLines}</p>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px; border-top:1px solid #e5e7eb; padding-top:18px; table-layout:fixed;">
    <tr>
      <td>
        ${company.logoEmailUrl ? `<img src="${company.logoEmailUrl}" alt="${escapeHtml(company.name)}" width="110" height="46" style="display:block; width:110px; height:46px; object-fit:contain; object-position:left; border:0; margin:0 0 12px;" />` : ""}
        ${personalLines}
        <p style="margin:0 0 3px; font-size:13px; font-weight:700; color:#111827;">${escapeHtml(company.name)}</p>
        <p style="margin:0 0 10px; font-size:13px; color:#6b7280; line-height:1.7;">
          ${company.website ? `<a href="${company.website}" style="color:${company.brandColor}; text-decoration:none; word-break:break-all; overflow-wrap:anywhere;">${company.website.replace(/^https?:\/\//, "")}</a>` : ""}
          ${company.phone ? `<br/>${company.phone}` : ""}
        </p>
      </td>
    </tr>
  </table>`;
}

// ═══════════════════════════════════════════════════════════════════════
// Pass 12 §2-§7/§36 — Compass Tools Professional Email Design System.
// ONE shared shell every outbound email routes through (customerWrapper
// for every customer-facing send, internalWrapper for internal-CRM-only
// notifications, buildMarketingCampaignEmail for campaigns) — centralized
// here so the branded background, card treatment, typography, and footer
// can never drift apart between templates the way buildMarketingCampaignEmail
// previously did (it used to carry its own independent copy of this exact
// chrome — see git history / Pass 11 report — now it calls into the same
// renderEmailCard() every other customer-facing template already used).
//
// Design tokens (§36) — centralized here rather than scattered as ad hoc
// hex literals through every template function below. Email HTML can't
// read CSS custom properties reliably across clients (Outlook in
// particular), so these are plain TS constants interpolated at render
// time — the email-safe equivalent of a token file.
// ═══════════════════════════════════════════════════════════════════════
const EMAIL_TOKENS = {
  // A soft, restrained blue-gray page background (§3/§4) — not a plain
  // flat gray, not a gradient (explicitly avoided per §3's "do not overuse
  // gradients" — a gradient here would read as a generic SaaS/marketing
  // template, not a premium travel document), and never so dark it
  // competes with the white content card for attention.
  pageBackground: "#eef1f6",
  cardBackground: "#ffffff",
  cardBorder: "#e2e5eb",
  border: "#e5e7eb",
  mutedBackground: "#f9fafb",
  text: "#111827",
  textMuted: "#4b5563",
  textSubtle: "#6b7280",
  textFaint: "#9ca3af",
  success: "#15803d",
  successBackground: "#ecfdf5",
  successBorder: "#a7f3d0",
  warning: "#92400e",
  warningBackground: "#fffbeb",
  warningBorder: "#fde68a",
  danger: "#b91c1c",
  dangerBackground: "#fef2f2",
  dangerBorder: "#fecaca",
  radius: "14px",
  fontFamily: "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
} as const;

/**
 * §33/§34/§35 — mobile responsive stacking for the itinerary segment row.
 * A `<style>` block with a real `@media` query is the correct, standard
 * email technique for anything a plain inline `style=""` attribute can't
 * express (inline styles can't respond to viewport width at all) — modern
 * mail clients that read `<style>` in the body (Gmail, Apple Mail, the
 * Gmail/Outlook mobile apps, Yahoo) apply it; clients that don't (classic
 * desktop Outlook) simply keep the already-reasonable percentage-width
 * 3-column layout the inline styles already provide — a real, working
 * fallback, not a broken one, per §35's "degrade gracefully" requirement.
 * Emitted once per email (inside renderEmailCard, the one shared shell),
 * not per segment, so a multi-segment itinerary doesn't repeat it.
 *
 * Pass 15 §14/§19 — the `img { max-width: 100%; }` rule below is a generic
 * safety net, not a per-template concern: every image this app itself
 * renders already carries explicit inline width/height (which always wins
 * over this class-less rule, so nothing existing changes) — this exists
 * for content the app does not fully control the markup of, namely a
 * staff-authored marketing campaign's rich-text HTML (inserted as-is —
 * see buildMarketingCampaignEmail's own doc comment) and a free-text
 * sequence email body, either of which could otherwise paste in a
 * native-resolution image wide enough to force the whole responsive shell
 * wider than the viewport on mobile.
 *
 * IMPORTANT: everything inside the template literal below — including CSS
 * comments — is literal text in every outbound email's raw HTML (a CSS
 * `/* ... *\/` comment is NOT stripped before sending). An earlier draft
 * of this fix put internal engineering commentary inside that CSS comment
 * and one word of it ("CRM") got caught by this project's own
 * no-internal-leakage regression suite — correctly, since it would
 * otherwise have shipped in every customer-facing email. Keep any
 * explanation up here, in the real TS doc comment, never inside the
 * template literal itself.
 */
const EMAIL_RESPONSIVE_STYLE = `<style>
  img { max-width: 100%; height: auto; }
  @media only screen and (max-width: 480px) {
    .ct-seg-row .ct-seg-cell, .ct-seg-row .ct-seg-cell-mid { display:block !important; width:100% !important; box-sizing:border-box; text-align:left !important; padding:8px 14px !important; }
    .ct-seg-row .ct-seg-cell-right { text-align:left !important; }
  }
</style>`;

/**
 * Hidden preheader (§7) — the short summary text mail clients show next to
 * the subject line in the inbox list, BEFORE the recipient opens the
 * email. Rendered visually hidden (never shown in the email body itself)
 * via the standard email technique: zero-size, overflow-hidden, plus a
 * long run of soft-hyphens/zero-width-non-joiners so mail clients don't
 * fall through into pulling visible body text as a preview instead once
 * the preheader text itself runs out.
 */
function renderPreheader(text: string): string {
  const filler = "&#847; ".repeat(60); // U+034F COMBINING GRAPHEME JOINER — invisible, defeats "preview text" fallback
  return `<div style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0; font-size:1px; line-height:1px; color:${EMAIL_TOKENS.pageBackground};">${escapeHtml(text)}${filler}</div>`;
}

/**
 * The shared premium card chrome (§2/§3/§4) — a subtly-branded outer page
 * background with a centered, elevated "document" card: logo header with
 * a brand-colored accent bar, the caller's own body content, an optional
 * signature, and a professional footer (§6). This one function is what
 * customerWrapper/internalWrapper/buildMarketingCampaignEmail all
 * ultimately render through, so the branded shell can never independently
 * drift between them again.
 *
 * `variant` controls personality (§19): "transactional" (quotes, bookings,
 * exchanges, cancellations, direct agent emails, Get in Touch replies —
 * clean, restrained, information-focused) vs "marketing" (campaigns —
 * allows richer author-authored content, always carries an unsubscribe
 * line) vs "internal" (staff-only notifications — Compass Tools product
 * chrome, not the customer's own company branding as the masthead, since
 * these are never seen by a customer).
 */
function renderEmailCard(params: {
  bodyHtml: string;
  company: ResolvedCompanyBranding;
  variant: "transactional" | "marketing" | "internal";
  preheader?: string;
  footerHtml?: string;
  maxWidth?: number;
}): string {
  const { bodyHtml, company, variant, preheader, footerHtml, maxWidth = 700 } = params;
  const isInternal = variant === "internal";

  const headerHtml = isInternal
    ? `<td style="background:#111827; padding:18px 28px;">
        <span style="color:#ffffff; font-size:15px; font-weight:700;">${PRODUCT_NAME}</span>
        <span style="color:#9ca3af; font-size:12px; margin-left:8px;">Internal CRM Notification</span>
      </td>`
    : `<td style="background:${EMAIL_TOKENS.cardBackground}; padding:24px 32px 22px; border-bottom:3px solid ${company.brandColor};">
        ${company.logoEmailUrl ? `<img src="${company.logoEmailUrl}" alt="${escapeHtml(company.name)}" width="180" height="76" style="display:block; width:180px; height:76px; object-fit:contain; object-position:left; border:0;" />` : `<span style="font-size:19px; font-weight:700; color:${EMAIL_TOKENS.text}; letter-spacing:-0.01em;">${escapeHtml(company.name)}</span>`}
      </td>`;

  // Pass 15 §18/§19 — every email this app sends was previously a bare
  // HTML fragment (no <!DOCTYPE>, <html>, <head>, or viewport meta at
  // all): MailComposer (gmail-send.ts) passes whatever string this
  // function returns straight into the MIME message's text/html part
  // as-is, so that fragment WAS the literal HTML a recipient's client
  // received. Most mobile mail apps render inbox HTML in their own
  // already-device-width webview regardless, but some contexts (opening
  // an email as a raw HTML file, some webmail "view in browser" links,
  // classic desktop Outlook's Word rendering engine) genuinely do use the
  // viewport meta / honor a real document — and a correct, minimal HTML5
  // envelope costs nothing in every client that ignores it. Verified live
  // (Pass 15 §37): loading the previous bare-fragment output as a static
  // HTML file made a mobile-width browser fall back to Chromium's
  // "assume desktop site" 980px default layout instead of the already-
  // correct mobile-responsive content underneath it. Added once here, in
  // the one shared shell every template already routes through — no
  // per-template duplication, no change to the actual visual design.
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<![endif]-->
${EMAIL_RESPONSIVE_STYLE}
</head>
<body style="margin:0; padding:0; background:${EMAIL_TOKENS.pageBackground};">
${preheader ? renderPreheader(preheader) : ""}
<div style="font-family:${EMAIL_TOKENS.fontFamily}; background:${EMAIL_TOKENS.pageBackground}; padding:32px 12px;">
  ${!isInternal ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${maxWidth}px; margin:0 auto 14px;"><tr><td style="height:4px; background:${company.brandColor}; border-radius:4px; font-size:0; line-height:0;">&nbsp;</td></tr></table>` : ""}
  <!-- Pass 15 §19 — table-layout:fixed found and fixed live (Browser pane,
       375px viewport, a real HTTP-served render of the actual builder
       output — not a string assertion): without it, a company with a
       moderately long website domain in the footer/signature (a completely
       realistic real-world value, appears on EVERY customer email) forced
       this table's browser-computed auto-layout width past the viewport
       — the classic HTML-table "one long unbreakable word inflates the
       whole table's min-content width" behavior, which word-break/
       overflow-wrap on the anchor alone does not reliably prevent for
       table auto-sizing. Safe here specifically because this outer card
       table has exactly ONE column at every row (header/body/footer) with
       width already 100% — table-layout does not inherit into the many
       DIFFERENT nested multi-column tables inside bodyHtml (segment rows,
       pricing rows, etc.), which keep their default auto layout and their
       own correct wrapping untouched. -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${maxWidth}px; margin:0 auto; background:${EMAIL_TOKENS.cardBackground}; border-radius:${EMAIL_TOKENS.radius}; overflow:hidden; border:1px solid ${EMAIL_TOKENS.cardBorder}; box-shadow:0 1px 3px rgba(17,24,39,0.06), 0 8px 24px rgba(17,24,39,0.05); table-layout:fixed;">
    <tr>
      ${headerHtml}
    </tr>
    <tr>
      <td style="padding:28px 32px;">
        ${bodyHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:18px 32px; background:${EMAIL_TOKENS.mutedBackground}; border-top:1px solid ${EMAIL_TOKENS.border};">
        ${footerHtml ?? renderDefaultFooter(company, variant)}
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
}

/**
 * Professional footer (§6) — company name, website, and phone (used here
 * as the general business/customer-service contact number, since this
 * schema has no separate customer-service field — see Company model).
 * Deliberately does NOT fabricate a legal/registration line: no such
 * field exists on Company, and inventing one would violate §6's own "do
 * not invent company information" rule. Marketing sends carry the
 * required unsubscribe line; transactional/internal do not (nothing to
 * unsubscribe from — see §42).
 */
function renderDefaultFooter(company: ResolvedCompanyBranding, variant: "transactional" | "marketing" | "internal"): string {
  if (variant === "internal") {
    return `<p style="margin:0; font-size:11px; color:${EMAIL_TOKENS.textFaint};">${PRODUCT_NAME} — internal notification, not seen by any customer.</p>`;
  }
  const contactLine = [company.website ? `<a href="${company.website}" style="color:${company.brandColor}; text-decoration:none; word-break:break-all; overflow-wrap:anywhere;">${company.website.replace(/^https?:\/\//, "")}</a>` : null, company.phone ? escapeHtml(company.phone) : null]
    .filter(Boolean)
    .join(" &middot; ");
  return `
    <p style="margin:0 0 4px; font-size:12px; font-weight:600; color:${EMAIL_TOKENS.text};">${escapeHtml(company.name)}</p>
    ${contactLine ? `<p style="margin:0; font-size:12px; color:${EMAIL_TOKENS.textSubtle};">${contactLine}</p>` : ""}`;
}

function customerWrapper(
  bodyHtml: string,
  company: ResolvedCompanyBranding,
  agent?: EmailAgent,
  opts?: {
    preheader?: string;
    /** Pass 16 — set only by buildSequenceEmail's automated (drip) send
     * path, appended below the ordinary footer as its own small line, same
     * one-click-GET-link pattern as buildMarketingCampaignEmail's
     * unsubscribeUrl (see /api/public/unsubscribe's own doc comment).
     * Every other customerWrapper caller (quote/booking/cancellation
     * emails, and the Lead/Contact one-off composer's own use of
     * buildSequenceEmail via sendCrmEmail) omits this and renders exactly
     * as before — a deliberate human-to-human email has no "unsubscribe"
     * concept and must not carry one. */
    unsubscribeUrl?: string;
  }
): string {
  const footerHtml = opts?.unsubscribeUrl
    ? `${renderDefaultFooter(company, "transactional")}
       <p style="margin:8px 0 0; font-size:11px; color:${EMAIL_TOKENS.textFaint};">
         Don't want these updates? <a href="${opts.unsubscribeUrl}" style="color:${EMAIL_TOKENS.textFaint}; text-decoration:underline;">Unsubscribe</a>
       </p>`
    : undefined;
  return renderEmailCard({
    bodyHtml: `${bodyHtml}${renderSignatureHtml(company, agent)}`,
    company,
    variant: "transactional",
    preheader: opts?.preheader,
    footerHtml,
  });
}

function internalWrapper(bodyHtml: string, company?: ResolvedCompanyBranding): string {
  return renderEmailCard({
    bodyHtml,
    // internalWrapper's own callers never render the company masthead
    // (see renderEmailCard's "internal" header branch, which ignores
    // `company` entirely) — a placeholder is only needed to satisfy the
    // function's required parameter when a caller has no branding handy.
    company: company ?? { id: "internal", name: PRODUCT_NAME, website: null, phone: null, brandColor: "#111827", logoEmailUrl: null, logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" },
    variant: "internal",
    maxWidth: 600,
  });
}

function ctaButton(url: string, label: string, brandColor: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto;">
      <tr>
        <td style="border-radius:8px; background:${brandColor};">
          <a href="${url}" style="display:inline-block; padding:14px 36px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:8px;">${label}</a>
        </td>
      </tr>
    </table>`;
}

// Part 11 — "scheduled" (pre-confirmation, item 11's exact required
// wording: never claim the flight has already been cancelled) vs
// "cancelled" (the true final state, once a Ticketing-area action has
// actually confirmed it — see sendCancellationConfirmationEmail). Kept as
// one shared rendering function with a mode flag rather than two near-
// duplicate copies, matching this module's existing bonus-flight-banner
// pattern.
type CancellationBannerState = "scheduled" | "cancelled";

function renderSegmentRow(seg: EmailSegment, cancellationState?: CancellationBannerState | false, isNonstop?: boolean): string {
  const isCancelled = !!cancellationState;
  // Airline name/code, aircraft, operating-carrier name, and city names can
  // all trace back to raw pasted GDS text (airlineCodeRaw/aircraftRaw/
  // operatingCarrierName fallbacks, or agent-entered reference data) —
  // treated as untrusted input and escaped before going into this HTML
  // email, the same as any other user-influenced string this module emits.
  const airlineName = escapeHtml(seg.airlineName);
  const airlineCode = escapeHtml(seg.airlineCode);
  const aircraft = seg.aircraft ? escapeHtml(seg.aircraft) : null;
  const operatingCarrierLabel = seg.operatingCarrierLabel ? escapeHtml(seg.operatingCarrierLabel) : null;
  const departureCity = escapeHtml(seg.departureCity);
  const arrivalCity = escapeHtml(seg.arrivalCity);

  const logo = seg.airlineLogoUrl
    ? `<img src="${seg.airlineLogoUrl}" width="28" height="28" alt="${airlineName}" style="display:block; border-radius:4px; border:1px solid #e5e7eb;" />`
    : `<div style="width:28px; height:28px; border-radius:4px; background:#f3f4f6; text-align:center; line-height:28px; font-size:10px; font-weight:700; color:#6b7280;">${airlineCode}</div>`;
  const sameDay = fmtDate(seg.departureAt) === fmtDate(seg.arrivalAt);

  const bonusBanner = seg.isExtraLeg
    ? `<tr>
      <td colspan="3" style="padding:10px 14px; background:#ecfdf3; border-bottom:1px solid #bbf7d0; border-radius:10px 10px 0 0;">
        <p style="margin:0; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#15803d; text-transform:uppercase;">Bonus Flight — Included at no additional charge</p>
        <p style="margin:2px 0 0; font-size:11px; color:#4b5563;">This bonus flight is part of your package at no extra cost. It does not replace or change your main flight itinerary.</p>
      </td>
    </tr>`
    : "";

  // Part 11 — must never say "cancelled"/"confirmed" for the pre-
  // confirmation "scheduled" stage (a real, distinct customer-facing
  // claim about what's actually happened) — only the true final stage,
  // reached via sendCancellationConfirmationEmail once a Ticketing-area
  // action has actually confirmed it, uses that wording.
  const cancelledBanner = cancellationState
    ? cancellationState === "scheduled"
      ? `<tr>
      <td colspan="3" style="padding:10px 14px; background:#fef2f2; border-bottom:1px solid #fecaca; border-radius:10px 10px 0 0;">
        <p style="margin:0; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#b91c1c; text-transform:uppercase;">&#9888; Scheduled for Cancellation</p>
        <p style="margin:2px 0 0; font-size:11px; color:#7f1d1d;">This flight segment is scheduled to be cancelled, pending your confirmation. It has not been cancelled yet.</p>
      </td>
    </tr>`
      : `<tr>
      <td colspan="3" style="padding:10px 14px; background:#fef2f2; border-bottom:1px solid #fecaca; border-radius:10px 10px 0 0;">
        <p style="margin:0; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#b91c1c; text-transform:uppercase;">&#9888; Cancellation Confirmed</p>
        <p style="margin:2px 0 0; font-size:11px; color:#7f1d1d;">This flight segment has been cancelled and is no longer part of your active itinerary.</p>
      </td>
    </tr>`
    : "";

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${isCancelled ? "#fecaca" : "#e5e7eb"}; border-radius:10px; margin-bottom:4px; ${isCancelled ? "opacity:0.75;" : ""}">
    ${bonusBanner}${cancelledBanner}
    <tr>
      <td colspan="3" style="padding:10px 14px; background:#f9fafb; border-bottom:${seg.isExtraLeg || isCancelled ? "none" : "1px solid #e5e7eb"}; border-radius:${seg.isExtraLeg || isCancelled ? "0" : "10px 10px 0 0"};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="28">${logo}</td>
            <td style="padding-left:8px; font-size:13px; color:#111827;">
              <strong>${airlineName}</strong> <span style="color:#6b7280;">${airlineCode} ${escapeHtml(seg.flightNumber)}</span>
              ${operatingCarrierLabel ? `<br/><span style="font-size:11px; color:#9ca3af;">${operatingCarrierLabel}</span>` : ""}
            </td>
            <td align="right" style="font-size:11px; color:#6b7280; white-space:nowrap;">
              ${isNonstop ? `<span style="display:inline-block; padding:1px 7px; margin-right:6px; border-radius:999px; background:#ecfdf5; color:#15803d; font-size:10px; font-weight:700; letter-spacing:0.03em; text-transform:uppercase;">Nonstop</span>` : ""}${seg.cabin}${aircraft ? ` · ${aircraft}` : ""}
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr class="ct-seg-row">
      <td width="42%" class="ct-seg-cell" style="padding:14px; vertical-align:top;">
        <p style="margin:0; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Depart</p>
        <p style="margin:2px 0 0; font-size:12px; color:#6b7280;">${fmtDate(seg.departureAt)}</p>
        <p style="margin:1px 0 0; font-size:23px; font-weight:700; color:#111827;">${fmtTime(seg.departureAt)}</p>
        <p style="margin:2px 0 0; font-size:13px; color:#111827;">${formatAirportLabel(departureCity, seg.departureAirportCode)}</p>
      </td>
      <td width="16%" class="ct-seg-cell-mid" style="padding:14px 0; vertical-align:middle; text-align:center;">
        <p style="margin:0; font-size:9px; color:#9ca3af; text-transform:uppercase; letter-spacing:0.04em;">Flight duration</p>
        <p style="margin:1px 0 0; font-size:11px; color:#6b7280; font-weight:600;">${fmtDuration(seg.durationMinutes)}</p>
        <p style="margin:2px 0 0; font-size:14px; color:#9ca3af;">&#8594;</p>
      </td>
      <td width="42%" class="ct-seg-cell ct-seg-cell-right" style="padding:14px; vertical-align:top; text-align:right;">
        <p style="margin:0; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Arrive</p>
        <p style="margin:2px 0 0; font-size:12px; color:#6b7280;">${fmtDate(seg.arrivalAt)}${!sameDay ? " (+1 day)" : ""}</p>
        <p style="margin:1px 0 0; font-size:23px; font-weight:700; color:#111827;">${fmtTime(seg.arrivalAt)}</p>
        <p style="margin:2px 0 0; font-size:13px; color:#111827;">${formatAirportLabel(arrivalCity, seg.arrivalAirportCode)}</p>
      </td>
    </tr>
  </table>`;
}

function renderLayoverRow(city: string, minutes: number): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 2px 0 4px;">
    <tr><td style="padding-left:18px; font-size:12px; color:#6b7280;">&#8618; <strong style="color:#374151;">Connection</strong> — ${fmtDuration(minutes)} layover in <strong style="color:#374151;">${escapeHtml(city)}</strong></td></tr>
  </table>`;
}

/** "Atlanta (ATL) → London (LHR) — 15h 30m total journey time — 1
 * connection · Copenhagen (CPH)" — the same prominent summary block shown
 * at the top of the CRM/View Deal component (flight-itinerary-display.tsx's
 * TotalJourneySummary), rendered here as email-safe table HTML. Computed
 * via the ONE centralized, timezone-aware calculateJourneyDuration helper
 * — never a naive sum of displayed duration strings, never hardcoded. */
function renderTotalJourneySummary(group: EmailSegment[], brandColor: string): string {
  const legs: JourneyLegInput[] = group.map((seg) => ({
    departureAt: seg.departureAt,
    arrivalAt: seg.arrivalAt,
    departureTimezone: seg.departureTimezone,
    arrivalTimezone: seg.arrivalTimezone,
    durationMinutes: seg.durationMinutes,
  }));
  const journey = calculateJourneyDuration(legs);
  if (!journey) return "";

  const first = group[0];
  const last = group[group.length - 1];
  const connectionCities = group.slice(0, -1).map((seg) => escapeHtml(seg.arrivalCity));
  const connectionLabel =
    connectionCities.length > 0
      ? ` &middot; ${connectionCities.length} connection${connectionCities.length > 1 ? "s" : ""} &middot; ${connectionCities.join(", ")}`
      : ` &middot; Nonstop`;

  // A plain, universally-supported neutral background rather than an
  // alpha-blended tint of brandColor — 8-digit hex-with-alpha has poor
  // support across email clients (notably older Outlook), and brandColor
  // isn't guaranteed to be a 6-digit hex (a 3-digit value like "#000" is
  // valid input too). brandColor is instead used only via a plain solid
  // left accent bar, which every table-based email client renders fine.
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border:1px solid #e5e7eb; border-left:3px solid ${brandColor}; border-radius:8px; margin-bottom:8px;">
    <tr>
      <td style="padding:10px 14px;">
        <p style="margin:0; font-size:13px; font-weight:700; color:#111827;">${escapeHtml(formatAirportLabel(first.departureCity, first.departureAirportCode))} &rarr; ${escapeHtml(formatAirportLabel(last.arrivalCity, last.arrivalAirportCode))}</p>
        <p style="margin:2px 0 0; font-size:12px; color:#4b5563;"><strong style="color:#111827;">${fmtDuration(journey.totalJourneyMinutes)}</strong> total journey time${connectionLabel}</p>
      </td>
    </tr>
  </table>`;
}

/** "Los Angeles (LAX)" — factors out the one label format repeated
 * independently across this file's HTML strings. */
function formatAirportLabel(city: string, code: string): string {
  return `${city} (${code})`;
}

/** Groups a flat, ordered segment list into legs (outbound / return / each
 * connecting flight of a multi-city trip) — consecutive segments joined by
 * a LAYOVER connection stay in the same leg; anything else (or the first
 * segment) starts a new one. The single source of "what counts as one
 * leg" for this file — both the itinerary HTML (which leg headers/spacing
 * to render) and the subject/summary line (which segment is the trip's
 * OWN first departure vs. its own first arrival, not the flattened whole
 * itinerary's last segment, which — for a round trip — is the RETURN
 * flight's arrival back at the outbound's own departure airport) need the
 * exact same grouping to stay consistent with each other. */
function groupSegmentsByLeg(segments: EmailSegment[]): EmailSegment[][] {
  const groups: EmailSegment[][] = [];
  for (const seg of segments) {
    if (seg.connectionType === "LAYOVER" && groups.length > 0) groups[groups.length - 1].push(seg);
    else groups.push([seg]);
  }
  return groups;
}

/**
 * @param cancelledSegmentIds When provided, any segment whose `id` is in
 * this set renders with a red cancellation banner/dimmed styling instead
 * of the normal card — used by the Cancellation workflow's customer email/
 * View Deal/booking pages to show the COMPLETE itinerary with only the
 * specific cancelled segment(s) visually distinguished, per the "never
 * assume cancelling means cancelling everything" requirement. Omitted (or
 * empty) for every ordinary itinerary render — zero effect on any existing
 * caller.
 */
export function renderItineraryHtml(segments: EmailSegment[], cancelledSegmentIds?: Set<string>, cancellationState: CancellationBannerState = "cancelled", brandColor = "#111827"): string {
  const groups = groupSegmentsByLeg(segments);
  const isMultiLeg = groups.length > 1;

  return groups
    .map((group, gi) => {
      const legLabel = isMultiLeg
        ? `<p style="margin:${gi === 0 ? "0" : "16px"} 0 6px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Flight ${gi + 1} · ${group[0].departureAirportCode} → ${group[group.length - 1].arrivalAirportCode}</p>`
        : "";
      // Pass 11 Part 2 — ONE timezone-aware calculation for this whole
      // group, reused for the Total Journey Summary block AND every
      // Connection gap below it — replaces the previous naive
      // `Date.getTime()` subtraction, which was wrong across a
      // timezone-changing connection (see flight-duration.ts's header).
      const journey = calculateJourneyDuration(
        group.map((seg) => ({
          departureAt: seg.departureAt,
          arrivalAt: seg.arrivalAt,
          departureTimezone: seg.departureTimezone,
          arrivalTimezone: seg.arrivalTimezone,
          durationMinutes: seg.durationMinutes,
        }))
      );
      const summary = renderTotalJourneySummary(group, brandColor);
      const rows = group
        .map((seg, i) => {
          const prev = i > 0 ? group[i - 1] : null;
          const connectionMinutes = i > 0 ? (journey?.legs[i - 1].connectionMinutesAfter ?? null) : null;
          const isCancelled = !!(seg.id && cancelledSegmentIds?.has(seg.id));
          return (
            (prev && connectionMinutes != null && connectionMinutes >= 0 ? renderLayoverRow(prev.arrivalCity, connectionMinutes) : "") +
            renderSegmentRow(seg, isCancelled ? cancellationState : false, group.length === 1)
          );
        })
        .join("");
      return legLabel + summary + rows;
    })
    .join("");
}

export function renderPricingHtml(p: EmailPricing): string {
  const symbol = CURRENCY_SYMBOLS[p.currency ?? "USD"];
  const rows: string[] = [];
  const row = (label: string, value: string, bold = false) => `
    <tr>
      <td style="padding:6px 0; font-size:${bold ? "15" : "13"}px; color:${bold ? "#111827" : "#4b5563"}; font-weight:${bold ? "700" : "400"};">${label}</td>
      <td align="right" style="padding:6px 0; font-size:${bold ? "17" : "13"}px; color:${bold ? "#111827" : "#4b5563"}; font-weight:${bold ? "700" : "400"};">${symbol}${value}</td>
    </tr>`;

  rows.push(row(`Adult${p.adults !== 1 ? "s" : ""} × ${p.adults}`, fmtMoney(p.adults * p.adultPrice)));
  if (p.children > 0) rows.push(row(`Child${p.children !== 1 ? "ren" : ""} × ${p.children}`, fmtMoney(p.children * p.childPrice)));
  if (p.infants > 0) rows.push(row(`Infant${p.infants !== 1 ? "s" : ""} × ${p.infants}`, fmtMoney(p.infants * p.infantPrice)));
  if (p.taxes > 0) rows.push(row("Taxes", fmtMoney(p.taxes)));
  if (p.serviceFee > 0) rows.push(row("Service fee", fmtMoney(p.serviceFee)));
  if (p.gratuity > 0) rows.push(row("Gratuity", fmtMoney(p.gratuity)));

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
    ${rows.join("")}
    <tr><td colspan="2" style="border-top:1px solid #e5e7eb; padding-top:8px;"></td></tr>
    ${row("Total", fmtMoney(p.total), true)}
  </table>`;
}

export function buildQuoteEmail(params: {
  customerFirstName: string;
  /** §8/§41 — optional; the greeting degrades gracefully (customerGreeting)
   * when omitted rather than rendering a broken "undefined". */
  customerLastName?: string | null;
  agentFullName: string;
  agent?: EmailAgent;
  tripType: string;
  passengerCount: number;
  segments: EmailSegment[];
  pricing: EmailPricing;
  viewDealUrl: string;
  /** Absolute URL of the open-tracking pixel — omit to send without one
   * (e.g. re-sends where READ has already fired). */
  trackingPixelUrl?: string;
  /** The quote's own owning Company — see src/server/queries/company.ts. */
  company: ResolvedCompanyBranding;
  /** Set only when this quote is an EXCHANGE proposal (Quote.originalQuoteId
   * is non-null) — used only as the isExchange discriminator (subject,
   * intro copy, and itinerary heading). The original itinerary itself is
   * deliberately NOT rendered in this email — this is the proposal EMAIL,
   * distinct from the CRM exchange-builder UI and the customer's "View
   * Deal" quote page (quote/[token]/page.tsx), which both correctly keep
   * showing the original AND proposed itinerary side by side; the email
   * shows only the proposed replacement so a customer skimming on mobile
   * sees the new itinerary first, not their current one. Omit entirely for
   * an ordinary (non-exchange) quote — every existing call site is
   * unaffected. */
  originalItinerarySegments?: EmailSegment[];
}) {
  // The FIRST LEG's own first/last segment — not the flattened whole
  // itinerary's first/last, which for a round trip would be the outbound
  // departure paired with the RETURN flight's arrival (the same airport
  // as the outbound departure), producing a nonsensical "LAX to LAX"
  // subject. See groupSegmentsByLeg's own doc comment.
  const firstLeg = groupSegmentsByLeg(params.segments)[0] ?? [];
  const legFirst = firstLeg[0];
  const legLast = firstLeg[firstLeg.length - 1];
  const route = legFirst
    ? `${formatAirportLabel(legFirst.departureCity, legFirst.departureAirportCode)} → ${formatAirportLabel(legLast.arrivalCity, legLast.arrivalAirportCode)}`
    : "your trip";
  const isExchange = !!params.originalItinerarySegments;
  // §40 — meaningful route information, never an internal Quote ID, and
  // never a nonsensical "LAX to LAX" (see groupSegmentsByLeg's own doc
  // comment on why this uses the first LEG, not the flattened whole
  // itinerary). A round trip gets its own "...and Return" phrasing rather
  // than a route string that would otherwise only describe the outbound
  // half of the trip.
  const isRoundTrip = params.tripType.replace(/_/g, " ").trim().toUpperCase() === "ROUND TRIP";
  const routeSubjectPart = legFirst
    ? `${formatAirportLabel(legFirst.departureCity, legFirst.departureAirportCode)} to ${formatAirportLabel(legLast.arrivalCity, legLast.arrivalAirportCode)}${isRoundTrip ? " and Return" : ""}`
    : "your trip";
  const subject = withCompanySuffix(
    isExchange ? `Proposed Flight Exchange: ${routeSubjectPart}` : `Your Flight Option${isRoundTrip ? "s" : ""}: ${routeSubjectPart}`,
    params.company
  );
  const preheader = isExchange
    ? `Your proposed flight exchange for ${route} is ready to review.`
    : `Your personalized flight option from ${legFirst?.departureCity ?? "your departure city"} to ${legLast?.arrivalCity ?? "your destination"} is ready to review.`;
  const greetingName = customerGreeting(params.customerFirstName, params.customerLastName);

  const html = customerWrapper(`
    <p style="margin:0 0 4px; font-size:16px; color:#111827; font-weight:600;">${greetingName},</p>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      ${isExchange
        ? `${escapeHtml(params.agentFullName)} has prepared a proposed itinerary exchange for your existing booking with ${escapeHtml(params.company.name)}. This is <strong>not a new booking</strong> — please review the proposed replacement below and click <strong>View Deal</strong> to compare it with your current itinerary.`
        : `As discussed, the itinerary below is the best option based on your preferences. Please review it at your convenience, and if everything looks good, simply click <strong>View Deal</strong> to complete your booking through our secure link. Once your information is submitted, your reservation will be sent directly to our ticketing team for immediate processing. Let ${escapeHtml(params.agentFullName.split(" ")[0])} know if this works for you, or if you'd like to make any adjustments — happy to help!`}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border-radius:10px; margin-bottom:22px;">
      <tr>
        <td style="padding:16px 18px;">
          <p style="margin:0 0 8px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Trip Summary</p>
          <p style="margin:0; font-size:14px; color:#111827;"><strong>${route}</strong></p>
          <p style="margin:4px 0 0; font-size:13px; color:#4b5563;">${params.tripType} · ${params.passengerCount} passenger${params.passengerCount === 1 ? "" : "s"}</p>
        </td>
      </tr>
    </table>

    ${
      isExchange
        ? `
    <p style="margin:0 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:${params.company.brandColor}; text-transform:uppercase;">Proposed Exchange Itinerary</p>
    ${renderItineraryHtml(params.segments, undefined, undefined, params.company.brandColor)}
    `
        : `
    <p style="margin:0 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Flight Itinerary</p>
    ${renderItineraryHtml(params.segments, undefined, undefined, params.company.brandColor)}
    `
    }

    <p style="margin:22px 0 0; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Pricing</p>
    ${renderPricingHtml(params.pricing)}

    ${ctaButton(params.viewDealUrl, "View Deal", params.company.brandColor)}

    <p style="margin:16px 0 0; font-size:12px; color:#9ca3af; line-height:1.6; text-align:center;">
      This link is unique to you — please don't forward this email.<br />Questions? Just reply and ${escapeHtml(params.agentFullName.split(" ")[0])} will help.
    </p>
    ${params.trackingPixelUrl ? `<img src="${params.trackingPixelUrl}" width="1" height="1" alt="" style="display:block; border:0; width:1px; height:1px;" />` : ""}
  `, params.company, params.agent, { preheader });
  return { subject, html };
}

/**
 * Cancellation workflow, stage 1 of 2 — sent by sendCancellationForm once
 * an Admin/Manager has approved a cancellation request but BEFORE anything
 * is actually cancelled (item 10's explicit requirement: this must
 * communicate a REQUEST/scheduled state, a cancellation fee may apply, and
 * must never claim the segment(s) have already been cancelled). Links to
 * the customer's own View Deal page (now reachable for this quote again
 * mid-cancellation — see the redirect fix in quote/[token]/page.tsx) where
 * they review and click Confirm Cancellation. The TRUE final email —
 * buildCancellationConfirmedEmail below — is a separate function, sent
 * only once a Ticketing-area action has actually confirmed the segment(s)
 * are cancelled.
 */
export function buildCancellationScheduledEmail(params: {
  customerFirstName: string;
  agentFullName: string;
  agent?: EmailAgent;
  segments: EmailSegment[];
  cancelledSegmentIds: Set<string>;
  cancellationFee?: number | null;
  currency?: SupportedCurrency;
  viewDealUrl: string;
  company: ResolvedCompanyBranding;
}) {
  const scheduledCount = params.segments.filter((s) => s.id && params.cancelledSegmentIds.has(s.id)).length;
  const subject = withCompanySuffix(`Cancellation Requested — Please Confirm ${scheduledCount} Flight Segment${scheduledCount === 1 ? "" : "s"}`, params.company);
  const preheader = "Your cancellation request and itinerary details are ready for review.";
  const symbol = CURRENCY_SYMBOLS[params.currency ?? "USD"];

  const html = customerWrapper(`
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:${EMAIL_TOKENS.dangerBackground}; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${EMAIL_TOKENS.danger};">Cancellation Notice — Going to Be Cancelled</span>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px; font-size:16px; color:#111827; font-weight:600;">${firstNameGreeting(params.customerFirstName)},</p>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      You've requested to cancel ${scheduledCount === 1 ? "the flight segment" : "the flight segments"} highlighted below on your itinerary with ${escapeHtml(params.company.name)}. ${scheduledCount === 1 ? "It has" : "They have"} <strong>not been cancelled yet</strong> — please review and confirm below. The rest of your itinerary is unaffected.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_TOKENS.dangerBackground}; border:1px solid ${EMAIL_TOKENS.dangerBorder}; border-radius:10px; margin-bottom:22px;">
      <tr>
        <td style="padding:14px 18px;">
          <p style="margin:0; font-size:13px; color:#991b1b;"><strong>&#9888; ${scheduledCount} of ${params.segments.length} flight segment${params.segments.length === 1 ? "" : "s"} scheduled for cancellation</strong> — not yet cancelled, pending your confirmation.</p>
          ${params.cancellationFee != null ? `<p style="margin:6px 0 0; font-size:13px; color:#991b1b;">A cancellation fee of <strong>${symbol}${fmtMoney(params.cancellationFee)}</strong> may apply.</p>` : ""}
        </td>
      </tr>
    </table>

    <p style="margin:0 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Your Itinerary</p>
    ${renderItineraryHtml(params.segments, params.cancelledSegmentIds, "scheduled", params.company.brandColor)}

    ${ctaButton(params.viewDealUrl, "Review & Confirm Cancellation", params.company.brandColor)}

    <p style="margin:16px 0 0; font-size:12px; color:#9ca3af; line-height:1.6; text-align:center;">
      Questions? Just reply and ${escapeHtml(params.agentFullName.split(" ")[0])} will help.
    </p>
  `, params.company, params.agent, { preheader });
  return { subject, html };
}

/**
 * Cancellation workflow, stage 2 of 2 (the TRUE final email) — sent only
 * by sendCancellationConfirmationEmail (src/server/actions/bookings.ts),
 * once a Ticketing-area action has actually confirmed the segment(s) are
 * cancelled (never for a merely-pending, disregarded, or customer-
 * submitted-but-not-yet-processed request). Shows the COMPLETE itinerary
 * with the specific cancelled segment(s) visually distinguished (a red
 * "Cancellation Confirmed" banner via renderItineraryHtml's
 * cancelledSegmentIds) — every unaffected segment renders exactly as
 * normal. Never includes internal notes, PNR, or approval information —
 * this function's params don't even accept those, by construction.
 */
export function buildCancellationConfirmedEmail(params: {
  customerFirstName: string;
  agentFullName: string;
  agent?: EmailAgent;
  segments: EmailSegment[];
  cancelledSegmentIds: Set<string>;
  company: ResolvedCompanyBranding;
}) {
  const cancelledCount = params.segments.filter((s) => s.id && params.cancelledSegmentIds.has(s.id)).length;
  const subject = withCompanySuffix(`Cancellation Confirmed — ${cancelledCount} Flight Segment${cancelledCount === 1 ? "" : "s"}`, params.company);
  const preheader = "Your cancellation has been completed — see the updated itinerary details below.";

  const html = customerWrapper(`
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:${EMAIL_TOKENS.dangerBackground}; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${EMAIL_TOKENS.danger};">Cancellation Completed</span>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px; font-size:16px; color:#111827; font-weight:600;">${firstNameGreeting(params.customerFirstName)},</p>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      This confirms that ${cancelledCount === 1 ? "the flight segment" : "the flight segments"} highlighted below on your itinerary with ${escapeHtml(params.company.name)} ${cancelledCount === 1 ? "has" : "have"} been cancelled. The rest of your itinerary remains active and unchanged.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_TOKENS.dangerBackground}; border:1px solid ${EMAIL_TOKENS.dangerBorder}; border-radius:10px; margin-bottom:22px;">
      <tr>
        <td style="padding:14px 18px;">
          <p style="margin:0; font-size:13px; color:#991b1b;"><strong>&#9888; ${cancelledCount} of ${params.segments.length} flight segment${params.segments.length === 1 ? "" : "s"} cancelled</strong> — see below for details.</p>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Your Itinerary</p>
    ${renderItineraryHtml(params.segments, params.cancelledSegmentIds, undefined, params.company.brandColor)}

    <p style="margin:16px 0 0; font-size:12px; color:#9ca3af; line-height:1.6; text-align:center;">
      Questions? Just reply and ${escapeHtml(params.agentFullName.split(" ")[0])} will help.
    </p>
  `, params.company, params.agent, { preheader });
  return { subject, html };
}

/**
 * CVV recollection follow-up — sent when an authorized agent needs to
 * charge a card more than the existing ~24h post-booking window allows
 * (see src/server/security/cvv-cache.ts's own header for why that window
 * is deliberately not extended). Asks the customer to confirm their
 * security code again, once, via a short-lived link — the PCI-compliant
 * alternative to retaining the original CVV any longer. Deliberately
 * minimal: no itinerary, no pricing, nothing beyond "confirm your card's
 * security code" — the less this email contains, the less there is to
 * get wrong on a page whose entire purpose is collecting a CVV safely.
 */
export function buildCvvRecollectionEmail(params: {
  customerFirstName: string;
  agentFullName: string;
  agent?: EmailAgent;
  cardBrand: string | null;
  last4: string;
  confirmUrl: string;
  company: ResolvedCompanyBranding;
}) {
  const subject = withCompanySuffix(`Please confirm your card's security code — ${params.company.name}`, params.company);
  const preheader = "One quick step to finish processing your payment.";

  const html = customerWrapper(`
    <p style="margin:0 0 4px; font-size:16px; color:#111827; font-weight:600;">${firstNameGreeting(params.customerFirstName)},</p>
    <p style="margin:0 0 20px; font-size:14px; color:#4b5563; line-height:1.6;">
      ${escapeHtml(params.agentFullName.split(" ")[0])} is ready to process your payment on the card ending in <strong>${escapeHtml(params.last4)}</strong>. For your security, we ask you to confirm the card's security code (CVV) again before we finish processing it.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_TOKENS.mutedBackground}; border-radius:10px; margin-bottom:8px;">
      <tr>
        <td style="padding:14px 18px;">
          <p style="margin:0; font-size:13px; color:#111827;"><strong>${escapeHtml(params.cardBrand ?? "Card")} •••• ${escapeHtml(params.last4)}</strong></p>
        </td>
      </tr>
    </table>

    ${ctaButton(params.confirmUrl, "Confirm Security Code", params.company.brandColor)}

    <p style="margin:16px 0 0; font-size:12px; color:#9ca3af; line-height:1.6; text-align:center;">
      This link is unique to you, expires shortly, and can only be used once.<br />Didn't expect this? Just reply and ${escapeHtml(params.agentFullName.split(" ")[0])} will help.
    </p>
  `, params.company, params.agent, { preheader });
  return { subject, html };
}

export function buildReassignmentEmail(params: {
  recipientFullName: string;
  contactFullName: string;
  previousOwnerName: string;
  newOwnerName: string;
  reassignedByName: string;
  reason: string | null;
  reassignedAt: Date;
  // Pass 7 — explicit, not inferred from `leads.length`: a CONTACT-scope
  // reassignment no longer touches any Lead's ownership (Contact and Lead
  // ownership are independent), so `leads` is always empty for that scope
  // now. Inferring "contact-level" from "more than one lead" was the old
  // (now-incorrect) signal from when a Contact reassignment cascaded to
  // every attached Lead.
  scope: "LEAD" | "CONTACT";
  // Only meaningful for scope "LEAD" — the single reassigned lead, for the
  // "View Lead" link. Always empty for scope "CONTACT".
  leads: { label: string; url: string }[];
  contactUrl?: string;
  company: ResolvedCompanyBranding;
}) {
  const isContactLevel = params.scope === "CONTACT";
  const subject = isContactLevel
    ? `Contact Reassigned — ${params.contactFullName}`
    : `Lead Reassigned — ${params.contactFullName}`;

  const html = internalWrapper(`
    <p style="margin:0 0 4px; font-size:16px; color:#111827;">Hi ${params.recipientFullName.split(" ")[0]},</p>
    <p style="margin:0 0 18px; font-size:14px; color:#4b5563; line-height:1.6;">
      ${isContactLevel
        ? `The contact <strong>${escapeHtml(params.contactFullName)}</strong> has been reassigned from your account. Any leads you own for this contact are unaffected — only the contact record itself has moved.`
        : `The following lead has been reassigned from your account.`}
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border-radius:10px; margin-bottom:18px;">
      <tr><td style="padding:14px 18px; font-size:13px; color:#374151; line-height:1.9;">
        <strong>${isContactLevel ? "Contact" : "Lead"}:</strong> ${escapeHtml(params.contactFullName)}<br/>
        <strong>Previous owner:</strong> ${escapeHtml(params.previousOwnerName)}<br/>
        <strong>New owner:</strong> ${escapeHtml(params.newOwnerName)}<br/>
        <strong>Reassigned by:</strong> ${escapeHtml(params.reassignedByName)}<br/>
        <strong>Reassigned:</strong> ${params.reassignedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
      </td></tr>
    </table>
    ${params.reason ? `
    <p style="margin:0 0 4px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Reason</p>
    <p style="margin:0 0 18px; font-size:13px; color:#374151; line-height:1.6;">${escapeHtml(params.reason)}</p>` : ""}
    ${ctaButton(isContactLevel ? (params.contactUrl ?? "#") : (params.leads[0]?.url ?? params.contactUrl ?? "#"), isContactLevel ? "View Contact" : "View Lead", params.company.brandColor)}
  `);
  return { subject, html };
}

const PRIORITY_COLOR: Record<"LOW" | "MEDIUM" | "HIGH", string> = {
  LOW: "#6b7280",
  MEDIUM: "#b45309",
  HIGH: "#b91c1c",
};
const PRIORITY_LABEL: Record<"LOW" | "MEDIUM" | "HIGH", string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

export function buildTaskReminderEmail(params: {
  agentFullName: string;
  taskTitle: string;
  taskNotes: string | null;
  dueAt: Date | null;
  priority: "LOW" | "MEDIUM" | "HIGH";
  overdue: boolean;
  relatedName: string | null;
  taskUrl: string;
  leadUrl: string | null;
  /** e.g. "Related Quote" / "Related Booking" — omitted entirely when neither exists. */
  referenceLabel: string | null;
  referenceValue: string | null;
  referenceUrl: string | null;
  company: ResolvedCompanyBranding;
}) {
  const subject = params.overdue ? `Overdue Task: ${params.taskTitle}` : `Task Due: ${params.taskTitle}`;
  const dateLine = params.dueAt
    ? params.dueAt.toLocaleDateString("en-US", { dateStyle: "long", timeZone: DISPLAY_TIMEZONE })
    : "No due date";
  const timeLine = params.dueAt
    ? params.dueAt.toLocaleTimeString("en-US", { timeStyle: "short", timeZone: DISPLAY_TIMEZONE })
    : null;

  const html = internalWrapper(`
    ${params.company.logoEmailUrl ? `<img src="${params.company.logoEmailUrl}" alt="${escapeHtml(params.company.name)}" width="96" height="40" style="display:block; width:96px; height:40px; object-fit:contain; object-position:left; border:0; margin:0 0 18px;" />` : ""}

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
      <tr>
        <td style="background:${params.overdue ? "#fef2f2" : "#eff6ff"}; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${params.overdue ? "#b91c1c" : params.company.brandColor};">
            ${params.overdue ? "Your Task Is Overdue" : "Your Task Is Due"}
          </span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 4px; font-size:16px; color:#111827;">Hi ${escapeHtml(params.agentFullName.split(" ")[0])},</p>
    <p style="margin:0 0 18px; font-size:14px; color:#4b5563; line-height:1.6;">
      ${params.overdue ? "Your scheduled task is now overdue." : "Your scheduled task is now due."}
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px; margin-bottom:22px;">
      <tr>
        <td style="padding:16px 18px; border-bottom:1px solid #e5e7eb;">
          <p style="margin:0; font-size:15px; font-weight:700; letter-spacing:0.01em; color:#111827; text-transform:uppercase;">${params.taskTitle}</p>
          ${params.taskNotes ? `<p style="margin:6px 0 0; font-size:13px; color:#6b7280; line-height:1.6;">${params.taskNotes}</p>` : ""}
        </td>
      </tr>
      <tr>
        <td style="padding:14px 18px; font-size:13px; color:#374151; line-height:1.9;">
          ${params.relatedName ? `<p style="margin:0 0 10px;"><span style="color:#9ca3af;">Customer</span><br/><strong>${params.relatedName}</strong></p>` : ""}
          <p style="margin:0 0 10px;"><span style="color:#9ca3af;">Due</span><br/><strong>${dateLine}</strong>${timeLine ? `<br/><strong>${timeLine}</strong>` : ""}</p>
          <p style="margin:0 0 ${params.referenceValue ? "10px" : "0"};"><span style="color:#9ca3af;">Priority</span><br/><strong style="color:${PRIORITY_COLOR[params.priority]};">${PRIORITY_LABEL[params.priority]}</strong></p>
          ${
            params.referenceValue
              ? `<p style="margin:0;"><span style="color:#9ca3af;">${params.referenceLabel}</span><br/><strong>${params.referenceUrl ? `<a href="${params.referenceUrl}" style="color:${params.company.brandColor}; text-decoration:none;">${params.referenceValue}</a>` : params.referenceValue}</strong></p>`
              : ""
          }
        </td>
      </tr>
    </table>

    ${ctaButton(params.taskUrl, "Open Task", params.company.brandColor)}
    ${params.leadUrl ? ctaButton(params.leadUrl, "Open Lead", params.company.brandColor) : ""}

    <p style="margin:22px 0 0; font-size:13px; color:#6b7280;">Please take action when convenient.</p>
    <p style="margin:14px 0 0; font-size:12px; font-weight:700; color:#111827;">${escapeHtml(params.company.name)}</p>
  `);
  return { subject, html };
}

function renderContactCard(name: string, email: string, phone: string): string {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px;">
    <tr>
      <td style="padding:12px 16px;">
        <p style="margin:0; font-size:14px; font-weight:600; color:#111827;">${name}</p>
        <p style="margin:6px 0 0; font-size:12px; color:#6b7280; line-height:1.7;">
          <span style="color:#9ca3af;">Email</span> · ${email}<br/>
          <span style="color:#9ca3af;">Phone</span> · ${phone}
        </p>
      </td>
    </tr>
  </table>`;
}

function renderPassengerCards(passengers: Array<{ firstName: string; middleName: string | null; lastName: string; dateOfBirth: Date | null; type: "ADULT" | "CHILD" | "INFANT" }>): string {
  const typeLabel: Record<(typeof passengers)[number]["type"], string> = { ADULT: "Adult", CHILD: "Child", INFANT: "Infant" };
  return passengers
    .map(
      (p, i) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px; margin-bottom:8px;">
        <tr>
          <td style="padding:12px 16px;">
            <p style="margin:0; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Passenger ${i + 1}</p>
            <p style="margin:3px 0 0; font-size:14px; font-weight:600; color:#111827;">${p.firstName}${p.middleName ? ` ${p.middleName}` : ""} ${p.lastName}</p>
            <p style="margin:2px 0 0; font-size:12px; color:#6b7280;">${typeLabel[p.type]}${p.dateOfBirth ? ` · DOB ${p.dateOfBirth.toLocaleDateString("en-US", { timeZone: "UTC" })}` : ""}</p>
          </td>
        </tr>
      </table>`
    )
    .join("");
}

export type EmailPaymentMethod = { cardBrand: string | null; last4: string | null; expiryMonth: number | null; expiryYear: number | null; amountAllocated: number };

function renderPaymentCard(params: {
  pricing: EmailPricing;
  paymentMethods: EmailPaymentMethod[];
  paid: boolean;
  /** The internal staff "booking signed" notification deliberately omits
   * the expiration date even though it's non-PAN, non-sensitive data — the
   * customer confirmation email (this flag left false) still shows it,
   * since a cardholder seeing their own card's expiry back is normal. */
  hideExpiry?: boolean;
}): string {
  const cardLines = params.paymentMethods.length
    ? params.paymentMethods
        .map((pm) => {
          const label =
            pm.last4 && pm.cardBrand
              ? `${pm.cardBrand} •••• ${pm.last4}${!params.hideExpiry && pm.expiryMonth && pm.expiryYear ? ` · Expires ${String(pm.expiryMonth).padStart(2, "0")}/${String(pm.expiryYear).slice(-2)}` : ""}`
              : "On file";
          const cardCurrencySymbol = CURRENCY_SYMBOLS[params.pricing.currency ?? "USD"];
          const amountLabel = params.paymentMethods.length > 1 ? ` — ${cardCurrencySymbol}${pm.amountAllocated.toFixed(2)}` : "";
          return `<tr><td style="padding-top:10px; font-size:12px; color:#6b7280;">Card on file</td><td align="right" style="padding-top:10px; font-size:12px; color:#374151;">${label}${amountLabel}</td></tr>`;
        })
        .join("")
    : `<tr><td style="padding-top:10px; font-size:12px; color:#6b7280;">Card on file</td><td align="right" style="padding-top:10px; font-size:12px; color:#374151;">On file</td></tr>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px;">
    <tr>
      <td style="padding:16px 18px;">
        ${renderPricingHtml(params.pricing)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px; border-top:1px solid #e5e7eb; padding-top:10px;">
          ${cardLines}
          <tr>
            <td style="padding-top:6px; font-size:12px; color:#6b7280;">Payment Status</td>
            <td align="right" style="padding-top:6px;">
              <span style="display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:700; letter-spacing:0.02em; ${
                params.paid ? "background:#ecfdf5; color:#065f46;" : "background:#fffbeb; color:#92400e;"
              }">${params.paid ? "PAID" : "PENDING"}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

/** One row of the customer-facing confirmation block — deliberately
 * distinct from `EmailPricing`/internal booking fields: only what's safe
 * and meaningful to show a customer. `airlineName` is null when no airline
 * was associated with this entry — the block must never invent one. */
export type EmailAirlineConfirmation = {
  id: string;
  airlineName: string | null;
  confirmationNumber: string;
  eTicketNumbers: string[];
};

export function buildBookingConfirmationEmail(params: {
  customerFirstName: string;
  agent?: EmailAgent;
  bookingReference: string;
  segments: EmailSegment[];
  pricing: EmailPricing;
  paymentMethods: EmailPaymentMethod[];
  paymentPaid: boolean;
  passengers: Array<{ firstName: string; middleName: string | null; lastName: string; dateOfBirth: Date | null; type: "ADULT" | "CHILD" | "INFANT" }>;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  // Deliberately no `pnr` param — PNR Information is internal-only and must
  // never reach any customer-facing surface, including this email.
  // Pass 23 — replaces the old single `airlineConfirmationNumber`/
  // `ticketNumbers` params with a structured, ordered list so a booking
  // with multiple PNRs/airlines (codeshares, separate outbound/return,
  // multiple tickets) can be represented honestly instead of collapsed
  // into one string. Entry order is preserved exactly as entered — never
  // resorted.
  confirmations: EmailAirlineConfirmation[];
  company: ResolvedCompanyBranding;
  /** §11 — set only when this booking was signed from an EXCHANGE quote
   * (Quote.originalQuoteId non-null) — switches the heading to "Exchange
   * Confirmed" and adds the Exchange Fee + Fare Difference = Total
   * Exchange Amount breakdown, same numbers/formula already shown on the
   * customer quote page (never re-derived here). Omitted entirely for an
   * ordinary (non-exchange) booking — every existing call site unaffected. */
  exchange?: { exchangeFee: number; fareDifference: number; currency: SupportedCurrency };
}) {
  const isExchange = !!params.exchange;
  const subject = withCompanySuffix(isExchange ? `Your Flight Exchange is Confirmed` : `Your Booking is Confirmed`, params.company);
  const hasConfirmation = params.confirmations.length > 0;
  const preheader = hasConfirmation
    ? "Your flight booking is confirmed. Your complete itinerary and confirmation details are below."
    : "Your flight booking has been received and is being processed — your confirmation details will follow shortly.";

  // §10 — a dedicated visual confirmation block, clearly separated from
  // the "Booking Confirmed" heading above it, so the customer never has
  // to search through a paragraph to find their confirmation number(s).
  // Pass 23 — one row per entry, in entered order; a single entry keeps
  // the original compact "Confirmation #:" wording, multiple entries get
  // a "Airline Confirmation Numbers" heading with each row visually
  // separated. E-ticket numbers are per-entry and simply omitted (no
  // "Not provided" placeholder) when that entry has none.
  const confirmationRows = params.confirmations
    .map((c, i) => {
      const label = c.airlineName ? `${escapeHtml(c.airlineName)} — Confirmation:` : "Confirmation #:";
      const eTicketLine = c.eTicketNumbers.length
        ? `<br/><strong>E-ticket${c.eTicketNumbers.length > 1 ? "s" : ""}:</strong> ${c.eTicketNumbers.map(escapeHtml).join(", ")}`
        : "";
      const separator = i > 0 ? `border-top:1px solid ${EMAIL_TOKENS.successBorder}; padding-top:8px; margin-top:8px;` : "";
      return `<p style="margin:0; font-size:13px; color:#065f46; line-height:1.7; ${separator}"><strong>${label}</strong> ${escapeHtml(c.confirmationNumber)}${eTicketLine}</p>`;
    })
    .join("");
  const confirmationBlock = hasConfirmation
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_TOKENS.successBackground}; border:1px solid ${EMAIL_TOKENS.successBorder}; border-radius:10px; margin:0 0 18px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 6px; font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${EMAIL_TOKENS.success};">${params.confirmations.length > 1 ? "Airline Confirmation Numbers" : "Airline Confirmation"}</p>
          ${confirmationRows}
        </td></tr>
      </table>`
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_TOKENS.warningBackground}; border:1px solid ${EMAIL_TOKENS.warningBorder}; border-radius:10px; margin:0 0 18px;">
        <tr><td style="padding:14px 18px; font-size:13px; color:${EMAIL_TOKENS.warning}; line-height:1.6;">
          We are currently working on your ticket issuance. Your airline confirmation number will be sent to you as soon as it's available.
        </td></tr>
      </table>`;

  // The intro line must match reality: once tickets are actually issued
  // (hasConfirmation), telling the customer their booking "is being
  // processed" and staff are "working on the ticket issuance" directly
  // contradicts the confirmation details shown right below it. Only the
  // still-pending case (no confirmation number/ticket numbers yet) says
  // anything is still in progress.
  const introText = hasConfirmation
    ? `Thank you for booking with us! Below is your complete flight itinerary and confirmation number${params.confirmations.length > 1 ? "s" : ""}. Please let us know if you need any further assistance. It has been a pleasure working with you, and we look forward to booking your next flight soon. Have a wonderful trip, and enjoy your flight!`
    : `Thank you for booking with ${escapeHtml(params.company.name)}. Your flight booking is being processed, and we are working on the ticket issuance.`;
  const passengerCount = params.passengers.length;
  // §11 — Exchange Fee + Fare Difference = Total Exchange Amount, same
  // formula/numbers already shown on the customer quote page — never
  // re-derived here, just displayed.
  //
  // Pass 28 — Fare Difference (and therefore the Total) may legitimately
  // be negative (a lower-priced replacement fare — see
  // Quote.fareDifference's own schema doc comment). This previously used
  // `${symbol}${fmtMoney(n)}` directly, which renders a negative amount as
  // "$-50.00" instead of "-$50.00" — this file's own fmtSignedMoney() a
  // few lines above already exists specifically to get this right, but
  // this customer-facing exchange summary wasn't using it. Real bug, real
  // customer email, now fixed at every one of the three rows below.
  const exchangeBlock = params.exchange
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${EMAIL_TOKENS.border}; border-radius:10px; margin:0 0 18px;">
        <tr><td style="padding:14px 18px;">
          <p style="margin:0 0 8px; font-size:10px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${EMAIL_TOKENS.textFaint};">Exchange Summary</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px; color:${EMAIL_TOKENS.textMuted};">
            <tr><td style="padding:2px 0;">Exchange Fee</td><td align="right">${fmtSignedMoney(CURRENCY_SYMBOLS[params.exchange.currency], params.exchange.exchangeFee)}</td></tr>
            <tr><td style="padding:2px 0;">Fare Difference</td><td align="right">${fmtSignedMoney(CURRENCY_SYMBOLS[params.exchange.currency], params.exchange.fareDifference)}</td></tr>
            <tr><td style="padding:6px 0 0; border-top:1px solid ${EMAIL_TOKENS.border}; font-weight:700; color:${EMAIL_TOKENS.text};">Total Exchange Amount</td><td align="right" style="padding:6px 0 0; border-top:1px solid ${EMAIL_TOKENS.border}; font-weight:700; color:${EMAIL_TOKENS.text};">${fmtSignedMoney(CURRENCY_SYMBOLS[params.exchange.currency], params.exchange.exchangeFee + params.exchange.fareDifference)}</td></tr>
          </table>
        </td></tr>
      </table>`
    : "";

  const html = customerWrapper(`
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:${EMAIL_TOKENS.successBackground}; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${EMAIL_TOKENS.success};">${isExchange ? "Exchange Confirmed" : "Booking Confirmed"}</span>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px; font-size:16px; color:#111827; font-weight:600;">${firstNameGreeting(params.customerFirstName)},</p>
    <p style="margin:0 0 4px; font-size:14px; color:#4b5563; line-height:1.6;">
      ${introText}
    </p>
    ${confirmationBlock}
    ${exchangeBlock}

    <p style="margin:22px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Flight Itinerary</p>
    <p style="margin:0 0 10px; font-size:13px; color:#4b5563;">${passengerCount} passenger${passengerCount === 1 ? "" : "s"}</p>
    ${renderItineraryHtml(params.segments, undefined, undefined, params.company.brandColor)}

    <p style="margin:22px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Passengers</p>
    ${renderPassengerCards(params.passengers)}

    <p style="margin:18px 0 6px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Contact</p>
    ${renderContactCard(params.contactName, params.contactEmail, params.contactPhone)}

    <p style="margin:22px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Payment</p>
    ${renderPaymentCard({
      pricing: params.pricing,
      paymentMethods: params.paymentMethods,
      paid: params.paymentPaid,
    })}

    <p style="margin:22px 0 0; font-size:13px; color:#6b7280; line-height:1.6;">Thank you for choosing ${escapeHtml(params.company.name)}.</p>
  `, params.company, params.agent, { preheader });
  return { subject, html };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Recognizes a bare URL so an agent's plain-text sequence copy (e.g. a quote
// link they pasted in) still renders as a clickable, styled link rather
// than dead text in the final HTML email.
const URL_RE = /(https?:\/\/[^\s<]+)/gi;

function linkify(escapedText: string, brandColor: string): string {
  return escapedText.replace(
    URL_RE,
    (url) => `<a href="${url}" style="color:${brandColor}; text-decoration:underline;">${url}</a>`
  );
}

/**
 * Wraps a sequence step's plain-text subject/body (already variable-
 * substituted) in the same professional branded layout used for quote and
 * booking emails. The content itself stays whatever the agent wrote —
 * this only supplies structure, typography, and spacing around it. Applies
 * uniformly to every sequence, existing and new, since it's the shared
 * rendering path every sequence send goes through.
 *
 * Pass 16 §4/§5 — `unsubscribeUrl` is optional and BLANK by default: the
 * Lead/Contact one-off composer (sendCrmEmail/sendLeadEmail/
 * sendInquiryEmail) and this pass's own Get-in-Touch reply all call this
 * function too, for a single deliberate human-authored email — those must
 * never carry an unsubscribe link. Only processDueSequenceSteps (the
 * unattended, automated, multi-touch drip send — genuinely the kind of
 * commercial email CAN-SPAM/CASL-style opt-out rules are aimed at) passes
 * one, built from that specific enrollment's own opaque, unguessable id
 * (see /api/public/sequence-unsubscribe/route.ts) — no new schema field
 * needed, same "id itself is the token" shape SequenceEnrollment already
 * has. Previously this function had NO unsubscribe mechanism at all for
 * an automated drip sequence — the only way to stop one was a staff
 * member manually unenrolling the lead — a real, non-hypothetical gap for
 * unattended commercial email, fixed here.
 */
export function buildSequenceEmail(params: { subject: string; bodyText: string; agent?: EmailAgent; company: ResolvedCompanyBranding; unsubscribeUrl?: string }) {
  const paragraphs = params.bodyText
    .split(/\n{2,}/)
    .filter((p) => p.trim().length > 0)
    .map((para) => `<p style="margin:0 0 16px; font-size:14px; color:#374151; line-height:1.7;">${linkify(escapeHtml(para), params.company.brandColor).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  const html = customerWrapper(`
    ${paragraphs}
  `, params.company, params.agent, { unsubscribeUrl: params.unsubscribeUrl });
  return { subject: params.subject, html };
}

/**
 * Internal "Booking Form Signed" staff notification — sent the moment a
 * customer signs and submits the booking form (see submitBooking() in
 * src/server/actions/booking.ts, which IS the signing action). Laid out to
 * mirror the booking form's own field order (customer → itinerary →
 * payment) so staff can compare this email against the signed form at a
 * glance. Uses only fields that genuinely exist on the booking's data
 * model — no invented fields. Payment section is deliberately minimal and
 * safe: card brand/last 4/status/total only, via renderPaymentCard's
 * hideExpiry — never the PAN, CVV, or expiration date. A "View Booking
 * Securely" link sends an authorized recipient into the CRM's own
 * permission-gated booking/payment record rather than putting anything
 * more sensitive in the email body itself.
 */
export function buildBookingSignedNotificationEmail(params: {
  bookingReference: string;
  customerFullName: string;
  contactEmail: string;
  contactPhone: string;
  signedName: string;
  signedAt: Date;
  ipAddress: string | null;
  segments: EmailSegment[];
  passengers: Array<{ firstName: string; middleName: string | null; lastName: string; dateOfBirth: Date | null; type: "ADULT" | "CHILD" | "INFANT" }>;
  pricing: EmailPricing;
  paymentMethods: EmailPaymentMethod[];
  paymentPaid: boolean;
  bookingUrl: string;
  company: ResolvedCompanyBranding;
}) {
  const subject = `Booking Form Signed — ${params.bookingReference}`;

  const html = internalWrapper(`
    ${params.company.logoEmailUrl ? `<img src="${params.company.logoEmailUrl}" alt="${escapeHtml(params.company.name)}" width="110" height="46" style="display:block; width:110px; height:46px; object-fit:contain; object-position:left; border:0; margin:0 0 18px;" />` : ""}

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:#ecfdf5; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:#065f46;">Booking Form Signed</span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 18px; font-size:14px; color:#4b5563; line-height:1.6;">
      <strong>${escapeHtml(params.customerFullName)}</strong> has signed and submitted the booking form for <strong>${params.bookingReference}</strong>. Ticketing is now pending in the CRM.
    </p>

    <p style="margin:0 0 6px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Customer</p>
    ${renderContactCard(escapeHtml(params.customerFullName), escapeHtml(params.contactEmail), escapeHtml(params.contactPhone))}

    <p style="margin:18px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Flight Itinerary</p>
    ${renderItineraryHtml(params.segments, undefined, undefined, params.company.brandColor)}

    <p style="margin:18px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Passengers</p>
    ${renderPassengerCards(params.passengers)}

    <p style="margin:18px 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Payment</p>
    ${renderPaymentCard({ pricing: params.pricing, paymentMethods: params.paymentMethods, paid: params.paymentPaid, hideExpiry: true })}

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px; margin-top:18px;">
      <tr>
        <td style="padding:14px 18px; font-size:12px; color:#374151; line-height:1.9;">
          <p style="margin:0 0 4px; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Signature Audit</p>
          <strong>Signed name:</strong> ${escapeHtml(params.signedName)}<br/>
          <strong>Signed at:</strong> ${params.signedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: DISPLAY_TIMEZONE })}<br/>
          <strong>IP address:</strong> ${params.ipAddress ? escapeHtml(params.ipAddress) : "Not captured"}
        </td>
      </tr>
    </table>

    ${ctaButton(params.bookingUrl, "View Booking Securely", params.company.brandColor)}
  `);
  return { subject, html };
}

/**
 * Part 17 — internal "booking confirmed / profit" notification, sent when a
 * Ticketing Agent or Admin saves a booking as CONFIRMED. Subject format is
 * fixed: "[Agent] ([Location], Hire Age: [Age]) made $[Profit]" — e.g.
 * "George Osborne (Tashknet, Hire Age: 0Y3M8D) made $551.85". No
 * destination clause and no booking/quote reference number anywhere in the
 * subject or body — this is an internal notification and must never expose
 * an identifier a recipient could use to look up the record directly (see
 * the body below, which also deliberately omits `bookingReference`).
 * `agentLocation`/`hireAgeCompact` are both nullable (Account.location and
 * Account.hiredAt are both optional) — the subject degrades gracefully
 * (omitting the parenthetical entirely, or just the hire-age clause) rather
 * than showing "null" or an empty pair of parens. Deliberately excludes
 * CVV/raw card numbers — this template never receives that data in the
 * first place (see updateBookingTicketing's explicit-select query, which
 * never selects encryptedPan).
 */
export function buildBookingProfitNotificationEmail(params: {
  agentFullName: string;
  /** Display label for the agent's role (e.g. "Travel Agent") — reuses
   * ROLE_LABELS from src/lib/permissions.ts, same Name(Role) convention
   * already shown elsewhere in this CRM (quote/booking agent lines). Omitted
   * only when the booking has no agent on file at all. */
  agentRole?: string | null;
  agentLocation: string | null;
  hireAgeCompact: string | null;
  profit: number;
  /** "{city}, {country}" — now rendered in the subject itself (previously
   * body-only); see this function's own subject-format comment below. */
  destination: string;
  currency: SupportedCurrency;
  /** Accepted but deliberately never rendered in the subject or body (see
   * this function's own doc comment) — kept only because the caller
   * (sendBookingProfitNotification) still needs the value in scope for its
   * own EmailLog/idempotency bookkeeping, and threading a separate
   * booking-reference-less params type through just for this one field
   * would be more churn than it's worth. */
  bookingReference: string;
  passengerCount: number;
  ticketBookingCost: number;
  sellingCost: number;
  segments: EmailSegment[];
  company: ResolvedCompanyBranding;
  /** Set when this profit is from an approved EXCHANGE booking rather than
   * a normal new sale — the subject/body clearly label it as such rather
   * than reading like an unrelated fresh booking to the team. Superseded by
   * `transactionLabel` below when both are provided; kept only so existing
   * call sites (Item 17) keep working unchanged. */
  isExchange?: boolean;
  /** Part 16 — explicit transaction classification for the team
   * notification. `"CANCELLATION"` is used by the new "Notify Team of
   * Cancellation" action; `"EXCHANGE"` is equivalent to (and takes
   * precedence over) the older `isExchange: true`. Omitted/undefined means
   * a normal new sale. */
  transactionLabel?: "EXCHANGE" | "CANCELLATION";
}) {
  const symbol = CURRENCY_SYMBOLS[params.currency] ?? "$";
  const label = params.transactionLabel ?? (params.isExchange ? "EXCHANGE" : undefined);
  // Pass 13 §9-§11 — the EXACT required subject structure, verbatim:
  // "{Agent Full Name} ({Location}, hire age: {Y}Y{M}M{D}D) made
  // ${Profit} to {Destination City}, {Destination Country}", with an
  // " on Exchange"/" on Cancellation" suffix for those two transaction
  // types (nothing appended for a plain new sale). Deliberately NO role
  // parenthetical — an earlier version of this subject included one
  // (`params.agentRole`, still accepted as a param for potential future
  // body-only use, but never read here), which violated the exact
  // required format; fixed as part of this pass's notification-reliability
  // audit. Location/hire-age are each included only when actually known —
  // never fabricated (see formatHireAgeCompact's own null-safe contract).
  // No booking/quote/internal ID anywhere in the subject.
  const metaParts = [params.agentLocation, params.hireAgeCompact ? `hire age: ${params.hireAgeCompact}` : null].filter(Boolean);
  const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";
  const labelSuffix = label === "EXCHANGE" ? " on Exchange" : label === "CANCELLATION" ? " on Cancellation" : "";
  const subject = `${params.agentFullName}${meta} made ${fmtSignedMoney(symbol, params.profit)} to ${params.destination}${labelSuffix}`;
  // Pass 17 §15/§36 — a short, at-a-glance CATEGORY label (matching the
  // task's own requested example: "NEW SALE" / "EXCHANGE" / "CANCELLATION"),
  // not a full sentence — this is an internal ops inbox a staff member
  // scans quickly, distinct from buildBookingConfirmationEmail's own
  // "Booking Confirmed"/"Exchange Confirmed" CUSTOMER-facing heading (left
  // untouched — a customer's confirmation email should read warm and
  // complete, not like an internal category tag). Cancellation now gets
  // its own red/warning-toned badge instead of the same green "success"
  // color every other transaction type used — a cancellation is not a
  // revenue win, and looking identical to one at a glance was a real,
  // if minor, inconsistency (reusing the exact danger tokens the
  // customer-facing cancellation banners already use, not a new color).
  const badgeText = label === "EXCHANGE" ? "EXCHANGE" : label === "CANCELLATION" ? "CANCELLATION" : "NEW SALE";
  const badgeBg = label === "CANCELLATION" ? EMAIL_TOKENS.dangerBackground : "#ecfdf5";
  const badgeColor = label === "CANCELLATION" ? EMAIL_TOKENS.danger : "#065f46";
  const bodyNoun = label === "EXCHANGE" ? "an exchange booking" : label === "CANCELLATION" ? "a cancellation" : "a booking";

  const html = internalWrapper(`
    ${params.company.logoEmailUrl ? `<img src="${params.company.logoEmailUrl}" alt="${escapeHtml(params.company.name)}" width="110" height="46" style="display:block; width:110px; height:46px; object-fit:contain; object-position:left; border:0; margin:0 0 18px;" />` : ""}

    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;">
      <tr>
        <td style="background:${badgeBg}; border-radius:6px; padding:5px 12px;">
          <span style="font-size:11px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${badgeColor};">${badgeText}</span>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 18px; font-size:14px; color:#4b5563; line-height:1.6;">
      <strong>${escapeHtml(params.agentFullName)}</strong> confirmed ${bodyNoun} to <strong>${escapeHtml(params.destination)}</strong> for ${params.passengerCount} passenger${params.passengerCount === 1 ? "" : "s"}.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px; margin-bottom:18px;">
      <tr>
        <td style="padding:14px 18px; font-size:13px; color:#374151; line-height:2.1;">
          <p style="margin:0 0 6px; font-size:10px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Financial Summary</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td>Ticket Booking Cost</td><td align="right">${symbol}${fmtMoney(params.ticketBookingCost)}</td></tr>
            <tr><td>Selling Cost</td><td align="right">${symbol}${fmtMoney(params.sellingCost)}</td></tr>
            <tr><td style="font-weight:700; color:#065f46;">Profit</td><td align="right" style="font-weight:700; color:#065f46;">${fmtSignedMoney(symbol, params.profit)}</td></tr>
          </table>
        </td>
      </tr>
    </table>

    <p style="margin:0 0 10px; font-size:11px; font-weight:700; letter-spacing:0.04em; color:#9ca3af; text-transform:uppercase;">Flight Itinerary</p>
    ${renderItineraryHtml(params.segments, undefined, undefined, params.company.brandColor)}
  `);
  return { subject, html };
}

/**
 * Part 10 — Marketing Campaigns email. Deliberately its own small wrapper,
 * not customerWrapper() itself: no agent signature block (marketing
 * campaigns have no "sending agent" concept and explicitly don't use CRM
 * variables/signature tokens — a separate system from CRM Sequences), but
 * the same professional branding conventions (logo, brand-color accent,
 * footer) so a subscriber sees a consistent look across every email this
 * company sends. htmlContent is the campaign author's own rich-text HTML
 * (from the TipTap editor) — inserted as-is, since it was authored by an
 * Admin/Marketing Agent inside the CRM, not user-submitted from an
 * untrusted public form.
 */
export function buildMarketingCampaignEmail(params: {
  subject: string;
  htmlContent: string;
  unsubscribeUrl: string;
  company: ResolvedCompanyBranding;
  /** §7 — optional hidden preheader summary; campaigns don't have one
   * generated automatically (there's no single "route"/"confirmation
   * number" to summarize from free-form marketing content), so this is
   * left to the caller to supply if desired. */
  preheader?: string;
}) {
  const footerHtml = `
    <p style="margin:0 0 6px; font-size:12px; font-weight:600; color:${EMAIL_TOKENS.text};">${escapeHtml(params.company.name)}</p>
    <p style="margin:0; font-size:11px; color:${EMAIL_TOKENS.textFaint};">
      You're receiving this because you subscribed to updates from ${escapeHtml(params.company.name)}.
      <a href="${params.unsubscribeUrl}" style="color:${EMAIL_TOKENS.textFaint}; text-decoration:underline;">Unsubscribe</a>
    </p>`;
  const html = renderEmailCard({
    bodyHtml: params.htmlContent,
    company: params.company,
    variant: "marketing",
    preheader: params.preheader,
    footerHtml,
  });
  return { subject: params.subject, html };
}
