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
//   - "vercel"      — Vercel's edge network overwrites X-Forwarded-For (and sets
//                      X-Real-IP / X-Vercel-Forwarded-For) itself and never
//                      forwards a client-supplied value. It also does NOT
//                      sanitize the RFC 7239 `Forwarded` header, so this mode
//                      deliberately never reads it. When TRUSTED_PROXY is unset
//                      AND the runtime is Vercel (VERCEL=1, which only the
//                      platform sets on its own deployments) this mode is
//                      selected automatically; an explicit TRUSTED_PROXY
//                      (including "none") always wins.
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

import { isIP } from "node:net";
import { isProductionEnvironment } from "@/lib/env";

// Address parsing is done by Node's own parser (net.isIP), not by hand-written patterns: the previous IPv6 pattern was "pragmatic, not exhaustive"
// and rejected valid addresses with an embedded IPv4 tail that is not written with "::" (for example 0:0:0:0:0:ffff:1.2.3.4 or 2001:db8:0:0:0:0:192.0.2.1),
// which some proxies emit. A differential test against net.isIP (see request-ip-parsing.test.ts) keeps the two in step.

/**
 * Whether the value is a single, complete IPv4 or IPv6 address as text. Anything else is false: a port, a prefix length ("/64"), brackets, a
 * scope/zone id ("fe80::1%eth0" - a zone names a local interface and is never a visitor's address), whitespace, an empty or oversized string.
 */
export function isValidIpAddress(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 45) return false;
  if (value.includes("%")) return false;
  return isIP(value) !== 0;
}

/** The canonical text of a VALID IPv6 address: lower case, leading zeros dropped, the longest zero run compressed (RFC 5952, as the WHATWG URL serializer writes it). */
function canonicalIpv6(ip: string): string | undefined {
  try {
    const host = new URL(`http://[${ip}]/`).hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : undefined;
  } catch {
    return undefined;
  }
}

/** The IPv4 text of an IPv4-mapped IPv6 address in canonical form ("::ffff:cb00:7109"), or undefined when it is not one. */
function ipv4FromMapped(canonical: string): string | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!m) return undefined;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/**
 * ONE stored text per address, so the same visitor can never be recorded (or hashed for the vault's exact-match search and velocity checks) as two different
 * strings:
 *   - an IPv4-mapped IPv6 address, in ANY spelling ("::ffff:203.0.113.9", "::ffff:cb00:7109", "0:0:0:0:0:ffff:cb00:7109"), is the plain IPv4 it stands for;
 *   - every other IPv6 address is written canonically (lower case, compressed per RFC 5952), so "2001:DB8:0:0:0:0:0:1" and "2001:db8::1" are one value;
 *     the deprecated IPv4-COMPATIBLE form ("::203.0.113.9") is NOT turned into IPv4 (it is not the same thing), only written canonically ("::cb00:7109");
 *   - IPv4 has a single valid spelling and is returned unchanged; anything that is not a valid address is returned unchanged (callers validate separately).
 * Nothing is truncated: the longest result is a full 39-character IPv6 address, far inside the TEXT columns it is stored in.
 */
export function normalizeIp(ip: string): string {
  const trimmed = typeof ip === "string" ? ip.trim() : ip;
  if (typeof trimmed !== "string" || !isValidIpAddress(trimmed) || isIP(trimmed) !== 6) return trimmed;
  const canonical = canonicalIpv6(trimmed);
  if (!canonical) return trimmed;
  return ipv4FromMapped(canonical) ?? canonical;
}

export type TrustedProxyMode = "none" | "vercel" | "cloudflare" | "nginx" | "generic";

const VALID_MODES: ReadonlySet<string> = new Set(["vercel", "cloudflare", "nginx", "generic"]);

export type TrustedProxyConfig = { mode: TrustedProxyMode; source: "explicit" | "platform" | "none" };

/**
 * Resolves the trusted-proxy mode. Order: (1) an explicit, valid
 * TRUSTED_PROXY value (`none` included — an operator can always opt out);
 * (2) the Vercel runtime identifying itself (VERCEL=1); (3) "none" — trust
 * nothing. An unrecognised TRUSTED_PROXY value never trusts anything by
 * itself: it falls through to (2)/(3) exactly as if unset.
 */
export function trustedProxyConfig(): TrustedProxyConfig {
  const raw = process.env.TRUSTED_PROXY?.trim().toLowerCase();
  if (raw === "none") return { mode: "none", source: "explicit" };
  if (raw && VALID_MODES.has(raw)) return { mode: raw as TrustedProxyMode, source: "explicit" };
  if (process.env.VERCEL === "1") return { mode: "vercel", source: "platform" };
  return { mode: "none", source: "none" };
}

/** The effective mode, defaulting to "none" (trust nothing). */
export function trustedProxyMode(): TrustedProxyMode {
  return trustedProxyConfig().mode;
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
  const [a, b, c] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 — loopback (the original "::1 problem", IPv4 form)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — carrier-grade NAT / overlay-network hop (RFC 6598), never a visitor's public address
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — network benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved (incl. 255.255.255.255) — never a client
  // The documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) are deliberately NOT listed: real traffic never uses them, and
  // they are what every test and example in this code base uses as a stand-in for "a public visitor".
  return false;
}

function isPrivateOrReservedIpv6(canonical: string): boolean {
  if (canonical === "::1" || canonical === "::") return true; // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(canonical)) return true; // fc00::/7 — unique local (RFC 4193)
  if (/^fe[89ab][0-9a-f]:/.test(canonical)) return true; // fe80::/10 — link-local
  if (/^fe[c-f][0-9a-f]:/.test(canonical)) return true; // fec0::/10 — deprecated site-local
  if (/^ff[0-9a-f]{2}:/.test(canonical)) return true; // ff00::/8 — multicast, never a client
  return false;
}

/**
 * Whether an address is a private/reserved range (RFC 1918, loopback, link-local, carrier-grade NAT, "this network", multicast/reserved, or IPv6
 * unique-local/link-local/site-local/multicast/loopback/unspecified) — never a real customer's own public IP. getClientIp() treats a resolved
 * value in one of these ranges as untrustworthy, for the same reason it already refused a bare ::1: such a value only ever indicates a
 * misconfigured proxy chain leaking an internal hop's address (or a client's own machine talking to itself in dev), not a genuine signer.
 * An IPv4-mapped IPv6 address is judged as the IPv4 it stands for (in any spelling), so "::ffff:10.0.0.1" and "::ffff:a00:1" are private too.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized.includes(":")) return isValidIpAddress(normalized) ? isPrivateOrReservedIpv4(normalized) : false;
  return isPrivateOrReservedIpv6(canonicalIpv6(normalized) ?? normalized.toLowerCase());
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

  for (const raw of candidateHeaderValues(mode, headerList)) {
    const normalized = normalizeIp(raw);
    if (!isValidIpAddress(normalized)) continue;
    if (isPrivateOrReservedIp(normalized)) return undefined;
    return normalized;
  }
  return undefined;
}

/**
 * The raw candidate values a given trust mode may read, in priority order.
 * Each mode reads ONLY headers its proxy is known to set/overwrite itself:
 *   - vercel: x-vercel-forwarded-for, x-real-ip, x-forwarded-for — all set by
 *     Vercel's edge. `Forwarded` and CF-Connecting-IP are never read: a
 *     client can send either directly and Vercel passes them through.
 *   - cloudflare: cf-connecting-ip only (Cloudflare's own edge header).
 *   - nginx / generic: the operator has asserted their proxy overwrites the
 *     standard headers (see the module comment), so `Forwarded`,
 *     X-Forwarded-For (first hop) and X-Real-IP are read in that order.
 * Header values are never logged.
 */
function candidateHeaderValues(mode: Exclude<TrustedProxyMode, "none">, headerList: Headers): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    const cleaned = stripForwardedPort((v ?? "").trim());
    if (cleaned) out.push(cleaned);
  };
  const firstOf = (v: string | null) => v?.split(",")[0];

  if (mode === "vercel") {
    push(firstOf(headerList.get("x-vercel-forwarded-for")));
    push(headerList.get("x-real-ip"));
    push(firstOf(headerList.get("x-forwarded-for")));
  } else if (mode === "cloudflare") {
    push(headerList.get("cf-connecting-ip"));
  } else {
    const forwarded = headerList.get("forwarded");
    if (forwarded) push(parseForwardedHeader(forwarded));
    // stripForwardedPort (in push) tolerates a proxy that appends a port to
    // the X-Forwarded-For value — a real-world quirk worth tolerating rather
    // than silently discarding an otherwise-good IP.
    push(firstOf(headerList.get("x-forwarded-for")));
    push(headerList.get("x-real-ip"));
  }
  return out;
}
