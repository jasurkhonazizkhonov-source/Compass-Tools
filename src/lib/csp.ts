// Content-Security-Policy builders.
//
// Two policies exist on purpose:
//
//  • BASE (next.config.ts, every route): the long-standing pragmatic policy. Its
//    script-src still needs 'unsafe-inline' because statically generated public
//    pages (the marketing site) carry Next.js's inline hydration scripts and no
//    per-request nonce can exist for a page built at deploy time.
//
//  • NONCE (src/proxy.ts, the routes that show or accept card data — the
//    customer's card-entry page under /quote/* and every signed-in CRM page):
//    scripts run only if they carry this request's random nonce (Next.js applies
//    it to its own scripts during server rendering), and 'strict-dynamic' lets
//    those trusted scripts load what they need. Injected inline script — the way
//    a cross-site-scripting bug would read a card number as it is typed — is
//    refused. Styles still allow 'unsafe-inline' (inline style attributes from
//    the UI libraries cannot carry a nonce); a style-only injection cannot run
//    code, which is the residual, documented risk.
const COMMON = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com https://www.googleapis.com",
  "frame-src https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
];

export function buildBaseCsp(): string {
  return [
    ...COMMON.slice(0, 1),
    "script-src 'self' 'unsafe-inline' https://accounts.google.com",
    // https://accounts.google.com is required for Google's Sign-In button stylesheet.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    ...COMMON.slice(1),
  ].join("; ");
}

export function buildNonceCsp(nonce: string, dev = false): string {
  return [
    ...COMMON.slice(0, 1),
    // 'strict-dynamic' makes browsers ignore host allow-lists and trust only nonce'd
    // scripts (and what they load); 'self' is the fallback for very old browsers.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    ...COMMON.slice(1),
  ].join("; ");
}

/** A fresh, unpredictable, per-request nonce (128 random bits, base64). */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
