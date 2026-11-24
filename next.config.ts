import type { NextConfig } from "next";
import { buildBaseCsp } from "./src/lib/csp";

// Content-Security-Policy, two tiers (src/lib/csp.ts). Every signed-in CRM page, the customer card-entry pages and the sign-in page get the STRICT per-request-nonce
// policy from src/proxy.ts: no 'unsafe-inline' and no 'unsafe-eval' for scripts. This BASE policy is what remains for the routes proxy.ts does not run on: the public
// marketing pages, which Next.js pre-renders at build time, so no per-request nonce can exist for their inline hydration scripts - 'unsafe-inline' on script-src is the one
// documented, unavoidable exception there (they show no customer data, accept no card data and are covered by frame-ancestors, object-src and base-uri restrictions).
// Every other directive is scoped as tightly as verified to still work. Re-verify this policy (via the browser tools,
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
  // Everything the CRM does not use is switched off for the page and any frame in it (Google's sign-in frame needs none of these).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), display-capture=(), interest-cohort=()" },
  // Isolates the page from windows it did not open, while still letting Google's sign-in popup talk back to it (same-origin-allow-popups; plain same-origin would break Google sign-in).
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
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
  "/failed-signins/:path*",
  "/leads/:path*",
  "/quotes/:path*",
  "/subscriptions/:path*",
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

// Self-hosted Docker image (the Dockerfile sets NEXT_OUTPUT=standalone): trace only the files the server needs into
// .next/standalone so the runtime image does not carry the whole dependency tree. Off by default, so the Vercel build and the
// Cloudflare/OpenNext build (which sets its own standalone mode) are unaffected.
const standaloneOutput = process.env.NEXT_OUTPUT === "standalone";

const nextConfig: NextConfig = {
  // outputFileTracingRoot is pinned (not inferred from lockfiles found in parent directories) so server.js is always at the top of
  // .next/standalone, which is where the Dockerfile expects it. The build always runs from the project root.
  ...(standaloneOutput ? { output: "standalone" as const, outputFileTracingRoot: process.cwd() } : {}),
  // Do not advertise the framework in an `X-Powered-By: Next.js` response header: it tells a scanner which stack (and which advisories) to try. This
  // is the whole fix - every response (pages, API routes, redirects, error pages) is served by Next, which adds the header from this one switch.
  poweredByHeader: false,
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
