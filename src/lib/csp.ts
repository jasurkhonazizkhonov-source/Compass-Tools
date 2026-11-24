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
//    refused. Styles still allow 'unsafe-inline' (inline style attributes from
//    the UI libraries cannot carry a nonce); a style-only injection cannot run
//    code, which is the residual, documented risk.
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
export function buildBaseCsp(dev: boolean = process.env.NODE_ENV === "development"): string {
  return [
    ...common().slice(0, 1),
    `script-src 'self' 'unsafe-inline' https://accounts.google.com${dev ? " 'unsafe-eval'" : ""}`,
    // https://accounts.google.com is required for Google's Sign-In button stylesheet.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    ...common().slice(1),
  ].join("; ");
}

export function buildNonceCsp(nonce: string, dev = false, options: { googleSignIn?: boolean } = {}): string {
  return [
    ...common().slice(0, 1),
    // 'strict-dynamic' makes browsers ignore host allow-lists and trust only nonce'd
    // scripts (and what they load); 'self' is the fallback for very old browsers.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // The sign-in page also needs Google's own button stylesheet. A stylesheet is not a script, so 'strict-dynamic' does not cover it and it must be named; nothing else is added.
    `style-src 'self' 'unsafe-inline'${options.googleSignIn ? " https://accounts.google.com" : ""}`,
    ...common().slice(1),
  ].join("; ");
}

/** A fresh, unpredictable, per-request nonce (128 random bits, base64). */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}
