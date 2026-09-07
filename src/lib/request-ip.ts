// Server-side client IP resolution for security-sensitive records (booking
// submission signature, privileged-reveal audit trail). Never trust a
// client-submitted IP value — this module only ever reads from the
// server-received request `Headers`, never from a request body/form field.
//
// ─────────────────────────────────────────────────────────────────────────
// Trusted-proxy gating (TRUSTED_PROXY env var) — this is the actual fix for
// the historical "captures ::1 / could be spoofed" problem, not a cosmetic
// rename. Forwarded-for style headers (`X-Forwarded-For`, `Forwarded`,
// `CF-Connecting-IP`) are only ever *set correctly* by a proxy that sits in
// front of this app and overwrites/appends them itself. If this app is
// reachable directly (no proxy in front, e.g. local `next dev`, or a
// production deployment that isn't actually behind the proxy it thinks it
// is), an attacker can set `X-Forwarded-For: 8.8.8.8` on a direct request
// and this module would have no way to distinguish that from a real proxy
// hop unless it knows, out of band, that a trusted proxy is genuinely there.
//
// So: `getClientIp` trusts NONE of these headers unless `TRUSTED_PROXY` is
// explicitly set to describe the real infrastructure in front of the app:
//   - "vercel"      — Vercel's edge network sets X-Forwarded-For itself.
//   - "cloudflare"  — trust CF-Connecting-IP (Cloudflare's own edge header).
//   - "nginx"       — a self-managed reverse proxy that has been configured
//                      to set X-Forwarded-For/Forwarded from the real peer
//                      address (e.g. `proxy_set_header X-Forwarded-For
//                      $proxy_add_x_forwarded_for;`) and strip/overwrite
//                      any such header a client tried to send directly.
//   - "generic"     — any other reverse proxy/load balancer that has been
//                      configured the same way (sets/overwrites, never
//                      blindly forwards a client-supplied value).
//   - unset / "none" (default) — no trusted proxy is configured, so no
//                      forwarded-for header is trusted at all. `getClientIp`
//                      returns `undefined` in this mode, every time,
//                      regardless of what headers are present. This is the
//                      secure default and it is also the correct dev-mode
//                      behavior: `next dev` has no proxy in front, so there
//                      is no real hop to read, and the caller's fallback
//                      (typically the literal string "::1", the IPv6
//                      loopback address, when the raw connection is used
//                      instead) is expected, not a bug. The fix for a real
//                      deployment is to configure TRUSTED_PROXY to describe
//                      the actual infrastructure — never to keep guessing at
//                      an untrusted header, and never to paper over ::1 with
//                      a hardcoded substitute value.
//
// Request path this module assumes once TRUSTED_PROXY is configured:
//   Browser → [reverse proxy / edge network — sets the forwarded header] →
//   Next.js (this app, reads that header via `getClientIp`) → CRM record.
// ─────────────────────────────────────────────────────────────────────────

import { isProductionEnvironment } from "@/lib/env";

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// A pragmatic (not exhaustively RFC-4291-complete) IPv6 matcher: full
// 8-group form, "::" zero-compression, and an embedded-IPv4 tail — enough
// to validate real client addresses without accepting garbage strings.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d))$/;

export function isValidIpAddress(value: string): boolean {
  return IPV4_RE.test(value) || IPV6_RE.test(value);
}

/**
 * Collapses an IPv4-mapped IPv6 address (e.g. "::ffff:203.0.113.9",
 * emitted by some load balancers/proxies for an underlying IPv4 peer, and
 * already accepted as valid by isValidIpAddress's own IPV6_RE branch) down
 * to its plain IPv4 form. Every other address — including a genuine IPv6
 * address and the deprecated IPv4-COMPATIBLE "::203.0.113.9" form (no
 * "ffff:" marker, intentionally NOT touched here) — is returned unchanged.
 * Without this, the exact same real client could be captured/stored as two
 * different strings depending on which proxy hop produced the header,
 * which would silently break the vault's exact-match blind-index search
 * and velocity/pattern fraud detection (both key on an exact string
 * match) — so every caller that captures/stores/searches an IP should
 * normalize through this first, not just validate it.
 */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  return mapped ? mapped[1] : ip;
}

export type TrustedProxyMode = "none" | "vercel" | "cloudflare" | "nginx" | "generic";

const VALID_MODES: ReadonlySet<string> = new Set(["vercel", "cloudflare", "nginx", "generic"]);

/** Reads and validates TRUSTED_PROXY, defaulting to "none" (trust nothing). */
export function trustedProxyMode(): TrustedProxyMode {
  const raw = process.env.TRUSTED_PROXY?.trim().toLowerCase();
  return raw && VALID_MODES.has(raw) ? (raw as TrustedProxyMode) : "none";
}

/**
 * Strips an optional port suffix and IPv6 brackets from a `for=` token, e.g.
 * `"[2001:db8::1]:4711"` → `"2001:db8::1"`, `"203.0.113.9:51820"` →
 * `"203.0.113.9"`. Leaves a bare address (no port) untouched.
 */
function stripForwardedPort(candidate: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) return bracketed[1];
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(candidate);
  if (ipv4WithPort) return ipv4WithPort[1];
  return candidate;
}

/**
 * Parses the `for=` parameter of the first element in an RFC 7239
 * `Forwarded` header, e.g. `Forwarded: for=192.0.2.60;proto=https, for=...`
 * or the quoted-IPv6 form `for="[2001:db8:cafe::17]:4711"`.
 */
function parseForwardedHeader(value: string): string | undefined {
  const firstElement = value.split(",")[0];
  if (!firstElement) return undefined;
  const match = /for="?([^;,"]+)"?/i.exec(firstElement);
  if (!match) return undefined;
  return stripForwardedPort(match[1].trim());
}

let warnedMissingTrustedProxyInProduction = false;

/** Best-effort HINT only, derived from platform-identifying env vars those
 * platforms themselves set — NEVER used to silently trust a header or
 * change getClientIp()'s own trust decision. Only feeds the production
 * warning message below. Auto-TRUSTING based on a detected platform (as
 * opposed to merely suggesting one in a warning) would reintroduce exactly
 * the spoofing risk TRUSTED_PROXY's explicit, human-set configuration
 * exists to prevent — an env var can be present for unrelated reasons
 * (leftover from a previous host, a misconfigured CI runner, etc.), so
 * this deliberately never becomes a trust decision on its own. */
function detectLikelyPlatformHint(): TrustedProxyMode | undefined {
  if (process.env.VERCEL) return "vercel";
  if (process.env.CF_PAGES) return "cloudflare";
  return undefined;
}

/** Fires once per server process (not once per request — this app has no
 * real "on startup" hook without a custom server, so the first actual
 * getClientIp() call in a production process is the earliest reliable
 * point to check). A production deployment with TRUSTED_PROXY unset isn't
 * broken — it's the same secure "trust nothing" default local dev already
 * uses — but it silently means every booking-signer IP capture resolves to
 * nothing, which is worth a loud one-time log line rather than staying
 * invisible. See docs/DEPLOYMENT.md (section 5, "Set TRUSTED_PROXY") for per-platform setup. */
function warnIfTrustedProxyMissingInProduction(mode: TrustedProxyMode) {
  if (warnedMissingTrustedProxyInProduction || mode !== "none" || !isProductionEnvironment()) return;
  warnedMissingTrustedProxyInProduction = true;
  const hint = detectLikelyPlatformHint();
  console.warn(
    `[request-ip] TRUSTED_PROXY is not configured in this production environment — every booking-signer IP capture will resolve to nothing until it is set.` +
      (hint ? ` This looks like a ${hint} deployment — consider TRUSTED_PROXY="${hint}".` : "") +
      ` See docs/DEPLOYMENT.md (section 5, "Set TRUSTED_PROXY").`
  );
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  const [a, b] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 — loopback (the original "::1 problem", IPv4 form)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 — unique local (RFC 4193)
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 — link-local
  return false;
}

/**
 * Whether an address is a private/reserved range (RFC 1918, loopback,
 * link-local, "this network", or IPv6 unique-local/link-local/loopback) —
 * never a real customer's own public IP. getClientIp() treats a resolved
 * value in one of these ranges as untrustworthy, for the same reason it
 * already refused a bare ::1: such a value only ever indicates a
 * misconfigured proxy chain leaking an internal hop's address (or a
 * client's own machine talking to itself in dev), not a genuine signer.
 * This generalizes that one specific historical case (see the module
 * comment) into the general rule, rather than only special-casing ::1.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  return ip.includes(":") ? isPrivateOrReservedIpv6(ip) : isPrivateOrReservedIpv4(ip);
}

/**
 * Resolves the originating client IP from trusted request headers, or
 * `undefined` if no trusted proxy is configured, no header is present, the
 * value doesn't parse as a valid IPv4/IPv6 address, or it resolves to a
 * private/reserved range (see isPrivateOrReservedIp — never a genuine
 * customer address). Applies only the ONE normalization documented on
 * normalizeIp() (collapsing an IPv4-mapped IPv6 form to plain IPv4) —
 * otherwise the raw parsed value is returned as-is. Never trusts any
 * forwarded-for style header when TRUSTED_PROXY is unset — see the
 * module-level comment for why that's a deliberate anti-spoofing default,
 * not a gap.
 */
export function getClientIp(headerList: Headers): string | undefined {
  const mode = trustedProxyMode();
  warnIfTrustedProxyMissingInProduction(mode);
  if (mode === "none") return undefined;

  let candidate: string | undefined;

  if (mode === "cloudflare") {
    candidate = headerList.get("cf-connecting-ip")?.trim();
  }

  if (!candidate) {
    const forwarded = headerList.get("forwarded");
    if (forwarded) candidate = parseForwardedHeader(forwarded);
  }

  if (!candidate) {
    // stripForwardedPort defensively handles a misconfigured proxy that
    // appends a port here too (e.g. "203.0.113.9:51820") — this header has
    // no formal port syntax of its own (unlike RFC 7239 Forwarded), but a
    // stray port is a real-world proxy quirk worth tolerating rather than
    // silently discarding an otherwise-good IP.
    candidate = stripForwardedPort(headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "") || undefined;
  }

  if (!candidate) {
    candidate = stripForwardedPort(headerList.get("x-real-ip")?.trim() ?? "") || undefined;
  }

  if (!candidate) return undefined;
  const normalized = normalizeIp(candidate);
  if (!isValidIpAddress(normalized)) return undefined;
  if (isPrivateOrReservedIp(normalized)) return undefined;
  return normalized;
}
