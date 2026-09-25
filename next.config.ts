import type { NextConfig } from "next";

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
const CSP = [
  "default-src 'self'",
  // js.stripe.com: the payment provider's browser library. The card number,
  // expiry and security code are typed into ITS iframes, so they never pass
  // through this app's own scripts, server or database.
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://js.stripe.com",
  // https://accounts.google.com is required here too: Google's Sign-In
  // button loads its own stylesheet (accounts.google.com/gsi/style) — a
  // real CSP violation caught by testing this in production, not just the
  // script origin already allowed above.
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com https://www.googleapis.com https://api.stripe.com https://r.stripe.com https://q.stripe.com https://m.stripe.network",
  "frame-src https://accounts.google.com https://js.stripe.com https://hooks.stripe.com https://m.stripe.network",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
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
