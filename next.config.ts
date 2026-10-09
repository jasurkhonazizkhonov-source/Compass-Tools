import type { NextConfig } from "next";
import { buildBaseCsp } from "./src/lib/csp";

// Content-Security-Policy is intentionally pragmatic, not maximal: this app
// (a) relies on Next.js App Router's own inline hydration/theme-init
// scripts (no nonce plumbing exists in proxy.ts today, and adding one is
// exactly the kind of broad, risky middleware change this pass avoids), and
// (b) loads Google's own Sign-In script/iframe from accounts.google.com.
// 'unsafe-inline' on script-src is therefore required for Next.js itself to
// keep working, not merely a convenience — removing it would break every
// page, not just this feature. Every other directive is scoped as tightly
// as verified to still work. Re-verify this policy (via the browser tools,
// checking read_console_messages for CSP violations) after any change to
// which third-party origins the app loads from.
// Built in src/lib/csp.ts. This is the BASE policy for every route; the routes that
// show or accept card data get the stricter per-request-nonce policy from
// src/proxy.ts instead (see that file and docs/CARD_VAULT_SECURITY.md).
const CSP = buildBaseCsp();

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Vercel already sends this on custom domains; stated here so the policy does
  // not depend on the platform. Deliberately no includeSubDomains/preload: this
  // app does not control every subdomain of its parent domain.
  { key: "Strict-Transport-Security", value: "max-age=63072000" },
];

// Pages and endpoints that show or accept customer/payment data must never be
// stored by a CDN, proxy or the browser cache. Next already marks dynamic
// pages private/no-store; this makes it an explicit, tested guarantee (and
// keeps it true if a page were ever made static by mistake). Static assets
// under /_next are intentionally NOT listed — they stay cacheable.
const NO_STORE_SOURCES = [
  "/quote/:path*",
  "/bookings/:path*",
  "/contacts/:path*",
  "/users/:path*",
  "/system-health/:path*",
  "/api/:path*",
];
const NO_STORE = [{ key: "Cache-Control", value: "private, no-cache, no-store, max-age=0, must-revalidate" }];

// Cloudflare Workers build only (scripts/cloudflare-build.mjs sets CLOUDFLARE_BUILD=1): `sharp` is a native Node addon that a Worker
// cannot load and that OpenNext's bundler cannot inline, so it is replaced by a stub that throws when called. Its only callers are
// the company-logo pipeline (src/lib/logo-processing.ts), which already handles failure. The Vercel / Node build is unaffected.
const cloudflareBuild = process.env.CLOUDFLARE_BUILD === "1";

// `pg-cloudflare` is the socket layer `pg` uses on Workers (it loads it only when it detects the Workers runtime). It ships two builds
// selected by export condition: `workerd` -> the real socket implementation, anything else -> an empty stub. Next traces files with the
// Node conditions, so the traced copy of the package contains only the empty stub, while OpenNext bundles the Worker with the
// `workerd` condition and then cannot find `./dist/index.js` ("Could not resolve pg-cloudflare"). OpenNext's fix for packages with a
// `workerd` condition is to copy them whole — it does that for packages named in `serverExternalPackages`. (It is NOT marked
// external in the Worker bundle: the bundle still inlines the real implementation.)
const CLOUDFLARE_WORKERD_PACKAGES = ["pg-cloudflare"];

const nextConfig: NextConfig = {
  ...(cloudflareBuild
    ? {
        serverExternalPackages: CLOUDFLARE_WORKERD_PACKAGES,
        turbopack: { resolveAlias: { sharp: "./src/lib/cloudflare/sharp-unavailable.ts" } },
      }
    : {}),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      ...NO_STORE_SOURCES.map((source) => ({ source, headers: NO_STORE })),
    ];
  },
  experimental: {
    serverActions: {
      // Default is 1MB, which a real-world Bulk Subscriber paste can
      // exceed (e.g. a messy multi-thousand-row Excel copy with extra
      // whitespace/columns) — Next then rejects the request at the
      // framework level before it ever reaches previewBulkSubscribers/
      // createBulkSubscribers (src/server/actions/subscribers.ts), which
      // the client can't parse as a normal action result and reports as
      // the generic "An unexpected response was received from the
      // server." Raised generously (well beyond MAX_BULK_SUBSCRIBERS'
      // 2000-email application-level ceiling) rather than just past
      // today's reported failure size.
      bodySizeLimit: "5mb",
    },
  },
};

export default nextConfig;
