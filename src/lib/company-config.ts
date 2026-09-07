// URL utilities shared by every branding-aware module, plus the shared
// resolved-branding shape. Company branding itself (name/logo/website/
// signature) is no longer a hardcoded constant here — see
// src/server/queries/company.ts, which resolves it per-Company from the
// database (Compass Tools serves many travel agencies; each has its own).
//
// PRODUCT_NAME is the one deliberate exception: it names Compass Tools
// itself (the CRM platform), never a customer's own company, and is never
// configurable — used only for internal-CRM chrome and pre-authentication
// pages (e.g. the login screen), which by definition can't yet know which
// company a visitor belongs to.
export const PRODUCT_NAME = "Compass Tools";

/** Resolved, ready-to-render company branding — every field has a sensible
 * default except logoEmailUrl, so callers never need to null-check before
 * rendering name/website/phone/brandColor/signature. See
 * src/server/queries/company.ts. */
export type ResolvedCompanyBranding = {
  id: string;
  name: string;
  website: string | null;
  phone: string | null;
  brandColor: string;
  /** Absolute URL or data: URI, already resolved via absoluteUrl() — ready
   * to drop straight into an <img src>. logoWebUrl/logoIconUrl only ever
   * render inside an authenticated, same-origin CRM tab, so they always
   * have a value even in the worst case (the app's own static /logo.png
   * route, reachable from that tab regardless of the file's presence on
   * disk at request time). logoEmailUrl is different: it's embedded in
   * outgoing email HTML for external mail clients, so it can genuinely be
   * unavailable (no company upload AND the bundled fallback file — if for
   * some reason it's missing from this deployment — couldn't be read
   * either) — null means "omit the logo from this email/signature
   * entirely," never a broken-image URL. See resolveBranding's doc
   * comment for the exact fallback chain. */
  logoEmailUrl: string | null;
  logoWebUrl: string;
  logoIconUrl: string;
  signatureTemplate: string;
};

// Resolves the app's own base URL for building absolute links/images (email
// content has no "current page" to resolve a relative URL against, so this
// must never be relative). Prefers an explicitly configured APP_BASE_URL,
// then falls back to Vercel's auto-provided deployment URLs so production
// emails work correctly without requiring APP_BASE_URL to be set manually
// per environment — VERCEL_PROJECT_PRODUCTION_URL/VERCEL_URL are injected
// by Vercel automatically and never include a protocol prefix.
// Exported so every customer-facing link (quote emails, booking emails,
// tracking pixels — see src/server/actions/quotes.ts and booking.ts) shares
// this one resolution chain instead of each hardcoding its own fallback,
// which is exactly how a customer-facing link previously ended up starting
// with http:// in a misconfigured environment: a duplicated, less-complete
// fallback that skipped the Vercel-aware branches below.
export function resolveBaseUrl(): string {
  // Pass 36 — strips a trailing slash: every caller (getGmailRedirectUri(),
  // absoluteUrl(), and any future one) appends its own leading-slash path
  // directly onto this return value, so an operator setting
  // APP_BASE_URL="https://example.com/" (a common, easy copy-paste mistake)
  // previously produced a double-slash URL like
  // "https://example.com//api/auth/gmail/callback" — which does not match
  // the single-slash redirect URI actually registered in Google Cloud
  // Console, failing the "Connect Gmail" flow with a confusing
  // redirect_uri_mismatch for a purely cosmetic env-var typo. A bare
  // APP_BASE_URL="https://example.com" is unaffected either way.
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.trim().replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NODE_ENV === "production") {
    // Every real deployment target this app supports (an explicit
    // APP_BASE_URL, or Vercel's auto-injected URL vars) is covered above —
    // reaching this branch in production means neither is set, so every
    // customer-facing link is about to be built as http://localhost:3000,
    // unreachable by any real customer/mail client. Surfaced loudly rather
    // than silently degrading, since this is exactly the misconfiguration
    // that produces "insecure connection" warnings on the booking page.
    console.warn(
      "resolveBaseUrl(): NODE_ENV=production but neither APP_BASE_URL nor a Vercel URL env var is set — falling back to http://localhost:3000. Customer-facing links will be broken/insecure. Set APP_BASE_URL to this deployment's real https:// URL."
    );
  }
  return "http://localhost:3000";
}

export function absoluteUrl(path: string): string {
  // Idempotent — a caller (e.g. a DB-configured logo URL already pointing
  // at an external CDN) may already hand us an absolute URL; never
  // double-prefix it.
  if (/^https?:\/\//i.test(path)) return path;
  const base = resolveBaseUrl();
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
