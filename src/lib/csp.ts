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
//    customer's card-entry page under /quote/*, every signed-in CRM page, and the
//    sign-in page /login, which is rendered per request and is the one public page
//    that loads a third-party script (Google's):
//    scripts run only if they carry this request's random nonce (Next.js applies
//    it to its own scripts during server rendering), and 'strict-dynamic' lets
//    those trusted scripts load what they need. Injected inline script — the way
//    a cross-site-scripting bug would read a card number as it is typed — is
//    refused. STYLES are split in two (CSP level 3): style ELEMENTS and stylesheets
//    (style-src) must carry the nonce in the nonce policy, and are 'self'-only in the
//    base policy, so an injected <style> block (the way CSS can be used to read page
//    content through attribute selectors) is refused; style ATTRIBUTES
//    (style-src-attr 'unsafe-inline') stay allowed because the UI libraries position
//    popovers, charts and menus with them and an attribute cannot carry a nonce. An
//    attribute holds declarations only (no selectors), cannot run code, and cannot
//    read other elements: that is the residual, documented risk (docs/CSP.md).
// Lead documents are uploaded to this same origin (PUT /api/attachments/{id}/upload) and downloaded from it, so connect-src needs no storage
// origin.
function common(): string[] {
  return [
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
}

/**
 * `dev` (default: running under `next dev`) adds 'unsafe-eval' to script-src, exactly as buildNonceCsp already does: React's development
 * build uses eval() to reconstruct call stacks and logs "eval() is not supported in this environment" when the policy forbids it. React
 * never uses eval() in production, and a production build (NODE_ENV=production) and the test suite get the unchanged policy.
 */
/** Style ATTRIBUTES (see the header comment): the one place 'unsafe-inline' remains for styles, because an attribute cannot carry a nonce. */
const STYLE_ATTR = "style-src-attr 'unsafe-inline'";

/**
 * Sonner (the toast library) adds ONE <style> element with its own fixed stylesheet when it loads, and offers no way to give it a nonce. Rather than reopen 'unsafe-inline' for every
 * <style> element, exactly that stylesheet is allowed by its SHA-256. The hash is of the text inside node_modules/sonner (version 2.0.8); a test recomputes it from the installed
 * package, so upgrading sonner fails that test (with the new value) instead of silently leaving toasts unstyled under the policy.
 */
export const SONNER_STYLE_HASH = "'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY='";

export function buildBaseCsp(dev: boolean = process.env.NODE_ENV === "development"): string {
  return [
    ...common().slice(0, 1),
    `script-src 'self' 'unsafe-inline' https://accounts.google.com${dev ? " 'unsafe-eval'" : ""}`,
    // Style elements/stylesheets: this site's own files and Google's Sign-In button stylesheet only - no injected <style>. (The static marketing pages that use this policy
    // have no <style> element of their own; checked in a real browser, docs/CSP.md.)
    `style-src 'self' ${SONNER_STYLE_HASH} https://accounts.google.com`,
    STYLE_ATTR,
    ...common().slice(1),
  ].join("; ");
}

export function buildNonceCsp(nonce: string, dev = false, options: { googleSignIn?: boolean } = {}): string {
  return [
    ...common().slice(0, 1),
    // 'strict-dynamic' makes browsers ignore host allow-lists and trust only nonce'd
    // scripts (and what they load); 'self' is the fallback for very old browsers.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Style elements need this request's nonce (Next.js, TipTap and the theme switch carry it). The sign-in page also needs Google's own button stylesheet: a stylesheet is not a
    // script, so 'strict-dynamic' does not cover it and it must be named; nothing else is added.
    // Google's sign-in script adds an inline <style> to the page. It copies the nonce of its own <script> tag onto that element (verified in a real browser 2026-11-25), which is why
    // the sign-in page hands its nonce to that tag (components/layout/google-sign-in-button.tsx) and needs NO 'unsafe-inline' for styles. Without the nonce on the tag the button
    // renders as a giant logo with doubled text.
    options.googleSignIn ? `style-src 'self' 'nonce-${nonce}' ${SONNER_STYLE_HASH} https://accounts.google.com` : `style-src 'self' 'nonce-${nonce}' ${SONNER_STYLE_HASH}`,
    STYLE_ATTR,
    ...common().slice(1),
  ].join("; ");
}

/** A fresh, unpredictable, per-request nonce (128 random bits, base64). */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
