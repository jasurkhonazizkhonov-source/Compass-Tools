import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import {
  canonicalWebsiteRequestMessage,
  sha256Hex,
  signWebsiteRequestV2,
  verifyWebsiteRequestSignature,
  websiteSignatureRequired,
  WEBSITE_SIGNATURE_MAX_AGE_SECONDS,
  WEBSITE_SIGNATURE_MAX_FUTURE_SECONDS,
  type NonceConsumer,
  type WebsiteContextPayload,
} from "../website-request-signature";
import { websiteSigningStartupProblem } from "../website-signing-policy";
import { guardWebsiteRequest, WEBSITE_UNATTRIBUTED_KEY } from "../website-signature-guard";
import { VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER } from "../lead-ingest-context";

// Signing v2 - the verifier in isolation. The nonce store is an in-memory stand-in with the same contract as the database one (the first key wins, atomically);
// the real INSERT ... ON CONFLICT against PostgreSQL is an integration concern and is NOT exercised here (no disposable database).
// The website carries its own implementation of the same specification and the same known-answer vector (tests/contact-visitor-context.spec.ts there).

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));
const limiter = vi.fn(async (...args: unknown[]) => (void args, { allowed: true }) as { allowed: boolean; retryAfterSeconds?: number });
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimitForKey: (key: string, endpoint: string, config: unknown) => limiter(key, endpoint, config),
}));

const SECRET = "unit-test-ingest-secret-0123456789-abcdefghijkl"; // throwaway
const PATH = "/api/public/contact-inquiry";
const COMPANY = "company-1";
const BODY = JSON.stringify({ companyId: COMPANY, firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", subject: "OTHER", message: "Hello" });
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const nowSeconds = Math.floor(NOW / 1000);

function memoryNonceStore(): { consume: NonceConsumer; keys: Set<string>; expiries: Map<string, Date> } {
  const keys = new Set<string>();
  const expiries = new Map<string, Date>();
  return {
    keys,
    expiries,
    consume: async (key, expiresAt) => {
      if (keys.has(key)) return false;
      keys.add(key);
      expiries.set(key, expiresAt);
      return true;
    },
  };
}

type Over = { method?: string; path?: string; company?: string; body?: string; secret?: string; payload?: Partial<WebsiteContextPayload> & Record<string, unknown> };
function signed(over: Over = {}, signBody = BODY) {
  const payload = { v: 2, ts: nowSeconds, nonce: randomBytes(16).toString("base64url"), ...(over.payload ?? {}) } as WebsiteContextPayload;
  const s = signWebsiteRequestV2({ secret: over.secret ?? SECRET, method: over.method ?? "POST", path: over.path ?? PATH, companyId: over.company ?? COMPANY, body: signBody, payload });
  return new Headers({ [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature });
}
const verify = (headers: Headers, store = memoryNonceStore(), over: Partial<Parameters<typeof verifyWebsiteRequestSignature>[0]> = {}) =>
  verifyWebsiteRequestSignature({ headers, method: "POST", path: PATH, companyId: COMPANY, body: BODY, nowMs: NOW, secret: SECRET, consumeNonce: store.consume, ...over });

describe("the canonical message and the known-answer vector", () => {
  // Independent calculation (plain Node crypto, written separately from the implementation): CT-WEBSITE-REQUEST-V2 then length-prefixed fields.
  const VECTOR = {
    secret: "known-answer-secret-0123456789-abcdefghij",
    payload: { v: 2, ts: 1800000000, nonce: "AAAAAAAAAAAAAAAAAAAAAA", ip: "203.0.113.7", country: "AU" } as WebsiteContextPayload,
    body: '{"companyId":"company-1","email":"a@example.test"}',
    context: "eyJ2IjoyLCJ0cyI6MTgwMDAwMDAwMCwibm9uY2UiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIiwiaXAiOiIyMDMuMC4xMTMuNyIsImNvdW50cnkiOiJBVSJ9",
    bodyHash: "5339ff248c79874aa7f96a7ab5aec083d3e1ac7cbbd3bcbb10f389ff6b14780c",
    signature: "5bafec282f9a6cb99071361647e971dcb3e34659f691528f9b33afd0667ed6d6",
  };

  it("produces exactly the vector's context, body hash and signature", () => {
    const s = signWebsiteRequestV2({ secret: VECTOR.secret, method: "POST", path: PATH, companyId: COMPANY, body: VECTOR.body, payload: VECTOR.payload });
    expect(s.context).toBe(VECTOR.context);
    expect(sha256Hex(VECTOR.body)).toBe(VECTOR.bodyHash);
    expect(s.signature).toBe(VECTOR.signature);
  });

  it("is length-prefixed: a field value cannot move a boundary (the same characters split differently sign differently)", () => {
    const base = { method: "POST", ts: 1, nonce: "n".repeat(22), bodySha256: "0".repeat(64), context: "ctx" };
    const a = canonicalWebsiteRequestMessage({ ...base, path: "/a", companyId: "bc" });
    const b = canonicalWebsiteRequestMessage({ ...base, path: "/ab", companyId: "c" });
    const c = canonicalWebsiteRequestMessage({ ...base, path: "/a\nbc", companyId: "" });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a.startsWith("CT-WEBSITE-REQUEST-V2\n4:POST\n2:/a\n2:bc\n")).toBe(true);
  });

  it("measures lengths in UTF-8 bytes, not characters", () => {
    expect(canonicalWebsiteRequestMessage({ method: "POST", path: "/é", companyId: "c", ts: 1, nonce: "n".repeat(22), bodySha256: "0".repeat(64), context: "x" })).toContain("3:/é");
  });

  it("the method is upper-cased in the message, nothing else is normalised", () => {
    expect(canonicalWebsiteRequestMessage({ method: "post", path: "/P", companyId: "C", ts: 1, nonce: "n".repeat(22), bodySha256: "0".repeat(64), context: "x" })).toContain("4:POST\n2:/P\n1:C");
  });
});

describe("a valid v2 request", () => {
  it("is verified; the visitor facts come from the authenticated context; the nonce is consumed once with an expiry beyond the accepted window", async () => {
    const store = memoryNonceStore();
    const headers = signed({ payload: { ip: "2001:4860:4860::8888", city: "Z%C3%BCrich", region: "ZH", country: "CH", timezone: "Europe/Zurich", source: "cloudflare" } });
    const r = await verify(headers, store);
    expect(r.state).toBe("verified");
    if (r.state !== "verified") return;
    expect(r.visitor.ip).toBe("2001:4860:4860::8888");
    expect(r.visitor.location).toMatchObject({ city: "Zürich", countryCode: "CH" });
    expect(store.keys.size).toBe(1);
    const [key] = [...store.keys];
    expect(key.startsWith(`nonce:v2:${COMPANY}:`)).toBe(true);
    expect(store.expiries.get(key)!.getTime()).toBeGreaterThan(NOW + WEBSITE_SIGNATURE_MAX_AGE_SECONDS * 1000); // never purged while a replay would still be in-window
  });

  it("an authentic request with no visitor facts is still verified (the signature authenticates the request, not just the IP)", async () => {
    const r = await verify(signed());
    expect(r).toMatchObject({ state: "verified", visitor: {} });
  });

  it("accepts the boundaries: exactly the maximum age and exactly the maximum future offset", async () => {
    expect((await verify(signed({ payload: { ts: nowSeconds - WEBSITE_SIGNATURE_MAX_AGE_SECONDS } }))).state).toBe("verified");
    expect((await verify(signed({ payload: { ts: nowSeconds + WEBSITE_SIGNATURE_MAX_FUTURE_SECONDS } }))).state).toBe("verified");
  });
});

describe("a v2 request that must be refused", () => {
  const reason = async (r: ReturnType<typeof verify>) => {
    const out = await r;
    return out.state === "invalid" ? out.reason : out.state;
  };

  it("modified body", async () => expect(await reason(verify(signed(), undefined, { body: BODY.replace("Hello", "Hullo") }))).toBe("bad_signature"));
  it("modified body by one byte of whitespace (the exact bytes are signed, not the parsed JSON)", async () => expect(await reason(verify(signed(), undefined, { body: `${BODY} ` }))).toBe("bad_signature"));
  it("modified HTTP method", async () => expect(await reason(verify(signed(), undefined, { method: "PUT" }))).toBe("bad_signature"));
  it("modified request path", async () => expect(await reason(verify(signed(), undefined, { path: "/api/public/subscribe" }))).toBe("bad_signature"));
  it("modified company id (cross-company substitution)", async () => expect(await reason(verify(signed(), undefined, { companyId: "company-2" }))).toBe("bad_signature"));
  it("a missing company id on the receiving side", async () => expect(await reason(verify(signed(), undefined, { companyId: undefined }))).toBe("bad_signature"));
  it("wrong signing secret", async () => expect(await reason(verify(signed({ secret: "another-secret-0123456789-abcdefghijklmnopqrs" })))).toBe("bad_signature"));
  it("invalid signature (altered hex)", async () => {
    const h = signed();
    h.set(VISITOR_SIGNATURE_HEADER, (h.get(VISITOR_SIGNATURE_HEADER) as string).replace(/^./, (c) => (c === "0" ? "1" : "0")));
    expect(await reason(verify(h))).toBe("bad_signature");
  });
  it("signature that is not 64 hex characters", async () => {
    const h = signed();
    h.set(VISITOR_SIGNATURE_HEADER, "abcd");
    expect(await reason(verify(h))).toBe("malformed");
  });
  it("context altered after signing (the visitor IP swapped)", async () => {
    const h = signed({ payload: { ip: "203.0.113.7" } });
    const swapped = Buffer.from(JSON.stringify({ v: 2, ts: nowSeconds, nonce: "A".repeat(22), ip: "198.51.100.9" })).toString("base64url");
    h.set(VISITOR_CONTEXT_HEADER, swapped);
    expect(await reason(verify(h))).toBe("bad_signature");
  });
  it("expired timestamp", async () => expect(await reason(verify(signed({ payload: { ts: nowSeconds - WEBSITE_SIGNATURE_MAX_AGE_SECONDS - 1 } })))).toBe("expired"));
  it("future timestamp beyond the permitted window", async () => expect(await reason(verify(signed({ payload: { ts: nowSeconds + WEBSITE_SIGNATURE_MAX_FUTURE_SECONDS + 1 } })))).toBe("future"));
  it("missing nonce", async () => {
    // Craft a context with no nonce and sign it (with an empty nonce in the message): the verifier must refuse it on the nonce, before anything else.
    const context = Buffer.from(JSON.stringify({ v: 2, ts: nowSeconds })).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(canonicalWebsiteRequestMessage({ method: "POST", path: PATH, companyId: COMPANY, ts: nowSeconds, nonce: "", bodySha256: sha256Hex(BODY), context })).digest("hex");
    const r = await verify(new Headers({ [VISITOR_CONTEXT_HEADER]: context, [VISITOR_SIGNATURE_HEADER]: signature }));
    expect(r).toEqual({ state: "invalid", reason: "bad_nonce" });
  });
  it("malformed nonce (too short, forbidden characters)", async () => {
    expect(await reason(verify(signed({ payload: { nonce: "short" } })))).toBe("bad_nonce");
    expect(await reason(verify(signed({ payload: { nonce: "has spaces and ?! characters.." } })))).toBe("bad_nonce");
  });
  it("invalid signature version (v1 is not accepted on these routes, v3 is unknown)", async () => {
    expect(await reason(verify(signed({ payload: { v: 1 as never } })))).toBe("unsupported_version");
    expect(await reason(verify(signed({ payload: { v: 3 as never } })))).toBe("unsupported_version");
  });
  it("malformed context (not base64url JSON, an array, an oversized one)", async () => {
    const mk = (context: string) => new Headers({ [VISITOR_CONTEXT_HEADER]: context, [VISITOR_SIGNATURE_HEADER]: "a".repeat(64) });
    expect(await reason(verify(mk("%%%not-base64%%%")))).toBe("malformed");
    expect(await reason(verify(mk(Buffer.from("[1,2]").toString("base64url"))))).toBe("malformed");
    expect(await reason(verify(mk("A".repeat(3000))))).toBe("malformed");
  });
  it("a signature without a context, or a context without a signature", async () => {
    expect(await reason(verify(new Headers({ [VISITOR_SIGNATURE_HEADER]: "a".repeat(64) })))).toBe("malformed");
    expect(await reason(verify(new Headers({ [VISITOR_CONTEXT_HEADER]: signed().get(VISITOR_CONTEXT_HEADER) as string })))).toBe("malformed");
  });
  it("no signing secret configured on this server, or one that is too short", async () => {
    expect(await reason(verify(signed(), undefined, { secret: undefined }))).toBe("no_secret");
    expect(await reason(verify(signed(), undefined, { secret: "short" }))).toBe("no_secret");
  });
  it("no signature headers at all is 'absent' (the route decides whether that is allowed)", async () => expect((await verify(new Headers())).state).toBe("absent"));
});

describe("replay protection", () => {
  it("a consumed nonce is never accepted again, even by the identical request", async () => {
    const store = memoryNonceStore();
    const headers = signed();
    expect((await verify(headers, store)).state).toBe("verified");
    expect(await verify(headers, store)).toEqual({ state: "invalid", reason: "replay" });
  });

  it("two concurrent submissions of the same envelope: exactly one wins", async () => {
    const store = memoryNonceStore();
    const headers = signed();
    const results = await Promise.all([verify(headers, store), verify(headers, store), verify(headers, store), verify(headers, store)]);
    expect(results.filter((r) => r.state === "verified")).toHaveLength(1);
    expect(results.filter((r) => r.state === "invalid" && r.reason === "replay")).toHaveLength(3);
  });

  it("a nonce belongs to a company: the same nonce for another company is a different key (and a different signature anyway)", async () => {
    const store = memoryNonceStore();
    const nonce = "N".repeat(22);
    expect((await verify(signed({ payload: { nonce } }), store)).state).toBe("verified");
    expect((await verify(signed({ payload: { nonce }, company: "company-2" }), store, { companyId: "company-2" })).state).toBe("verified");
    expect(store.keys.size).toBe(2);
  });

  it("a legitimate retry is a NEW request (a fresh nonce and timestamp): accepted, and left to the idempotency key to collapse into a duplicate", async () => {
    const store = memoryNonceStore();
    expect((await verify(signed(), store)).state).toBe("verified"); // the attempt whose reply was lost
    expect((await verify(signed(), store)).state).toBe("verified"); // the retry, re-signed
    expect(store.keys.size).toBe(2);
  });

  it("only an authentic request ever reaches the store: refused requests consume nothing", async () => {
    const store = memoryNonceStore();
    await verify(signed({ secret: "another-secret-0123456789-abcdefghijklmnopqrs" }), store);
    await verify(signed(), store, { body: "tampered" });
    await verify(signed({ payload: { ts: 1 } }), store);
    expect(store.keys.size).toBe(0);
  });

  it("when the one-time store is unavailable the result is 'unavailable' (fail closed), never 'verified'", async () => {
    const down: NonceConsumer = async () => {
      throw new Error("database down");
    };
    expect(await verify(signed(), undefined, { consumeNonce: down })).toEqual({ state: "unavailable" });
  });
});

describe("the guard: when a signature is required, and per-visitor rate limiting", () => {
  beforeEach(() => {
    limiter.mockClear();
    limiter.mockImplementation(async () => ({ allowed: true }));
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true"); // strict mode: the final rollout state
  });
  afterEach(() => vi.unstubAllEnvs());

  const request = (headers: Headers) => new Request(`http://crm.internal${PATH}`, { method: "POST", headers, body: BODY });
  const guard = (headers: Headers, store = memoryNonceStore(), extra: Partial<Parameters<typeof guardWebsiteRequest>[0]> = {}) =>
    guardWebsiteRequest({ req: request(headers), body: BODY, companyId: COMPANY, verify: (i) => verifyWebsiteRequestSignature({ ...i, nowMs: NOW, consumeNonce: store.consume }), ...extra });

  it("is always required in production, whatever the switch says; elsewhere only with WEBSITE_SIGNATURE_REQUIRED=true", () => {
    for (const flag of [undefined, "", "false", "0", "off", "true", "nonsense"]) expect(websiteSignatureRequired(flag, true), String(flag)).toBe(true);
    expect(websiteSignatureRequired("true", false)).toBe(true);
    expect(websiteSignatureRequired(" TRUE ", false)).toBe(true);
    for (const flag of ["", "false", "0", "yes", "1"]) expect(websiteSignatureRequired(flag, false), flag).toBe(false);
  });

  it.each(["APP_ENV=production", "VERCEL_ENV=production", "VERCEL_ENV=preview", "NODE_ENV=production"])("%s counts as production with no switch set", (setting) => {
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
    const [name, value] = setting.split("=");
    vi.stubEnv(name, value);
    expect(websiteSignatureRequired()).toBe(true);
  });

  it("says at startup when signatures are required but none could be verified, and says nothing otherwise (never a value)", () => {
    expect(websiteSigningStartupProblem()).toBeUndefined();
    vi.stubEnv("LEAD_INGEST_SECRET", "too-short-secret-sentinel");
    expect(websiteSigningStartupProblem()).toMatch(/every website request will be refused/);
    expect(websiteSigningStartupProblem()).not.toContain("too-short-secret-sentinel");
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
    expect(websiteSigningStartupProblem()).toBeUndefined(); // development without the switch
    vi.stubEnv("APP_ENV", "production");
    expect(websiteSigningStartupProblem()).toMatch(/LEAD_INGEST_SECRET/);
  });

  it("refuses an unsigned request when a secret is configured (no unsigned fallback), with 401 and nothing else", async () => {
    expect(await guard(new Headers())).toMatchObject({ ok: false, status: 401, code: "signature_required" });
  });

  it("refuses an invalid or replayed one with 401, and a store outage with 503", async () => {
    const store = memoryNonceStore();
    const headers = signed();
    expect((await guard(headers, store)).ok).toBe(true);
    expect(await guard(headers, store)).toMatchObject({ ok: false, status: 401, code: "invalid_signature" });
    const down = await guardWebsiteRequest({ req: request(signed()), body: BODY, companyId: COMPANY, verify: async () => ({ state: "unavailable" }) });
    expect(down).toMatchObject({ ok: false, status: 503, code: "unavailable" });
  });

  it.each([
    ["no secret", ""],
    ["a secret shorter than 32 characters", "short"],
  ])("fails closed with 503 when signatures are required and there is %s: nothing passes, signed or not", async (_label, secret) => {
    vi.stubEnv("LEAD_INGEST_SECRET", secret);
    for (const headers of [new Headers(), signed({ payload: { ip: "203.0.113.7" } })]) expect(await guard(headers)).toEqual({ ok: false, status: 503, code: "unavailable" });
    expect(limiter).not.toHaveBeenCalled();
  });

  it.each(["", "false"])("in production the switch cannot turn the requirement off (WEBSITE_SIGNATURE_REQUIRED=%j)", async (flag) => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", flag);
    expect(await guard(new Headers())).toMatchObject({ ok: false, status: 401, code: "signature_required" });
    expect(await guard(signed({ secret: "another-secret-0123456789-abcdefghijklmnopqrs" }))).toMatchObject({ ok: false, status: 401, code: "invalid_signature" });
    const store = memoryNonceStore();
    const headers = signed();
    expect((await guard(headers, store)).ok).toBe(true);
    expect(await guard(headers, store)).toMatchObject({ ok: false, status: 401, code: "invalid_signature" }); // replay
  });

  it("in development without the switch, unsigned and unverifiable requests pass and nothing is trusted about the visitor", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", "");
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
    expect(await guard(new Headers())).toEqual({ ok: true, signed: false });
    expect(await guard(signed({ payload: { ip: "203.0.113.7" } }))).toEqual({ ok: true, signed: false });
  });

  it("rate-limits by the VERIFIED visitor IP, in a website-only bucket, never by anything the connection says", async () => {
    const r = await guard(signed({ payload: { ip: "203.0.113.7" } }), undefined, { rateLimit: { endpoint: "CONTACT_INQUIRY", config: { windowMs: 1000, maxAttempts: 20 } } });
    expect(r).toMatchObject({ ok: true, signed: true });
    expect(limiter).toHaveBeenCalledWith("203.0.113.7", "CONTACT_INQUIRY:website", { windowMs: 1000, maxAttempts: 20 });
  });

  it("traffic the website could not attribute shares one bucket with a larger allowance", async () => {
    await guard(signed(), undefined, { rateLimit: { endpoint: "CONTACT_INQUIRY", config: { windowMs: 1000, maxAttempts: 20 } } });
    expect(limiter).toHaveBeenCalledWith(WEBSITE_UNATTRIBUTED_KEY, "CONTACT_INQUIRY:website", { windowMs: 1000, maxAttempts: 100 });
  });

  it("answers 429 with Retry-After information when the visitor is over the limit", async () => {
    limiter.mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 42 }));
    const r = await guard(signed({ payload: { ip: "203.0.113.7" } }), undefined, { rateLimit: { endpoint: "CONTACT_INQUIRY", config: { windowMs: 1000, maxAttempts: 20 } } });
    expect(r).toEqual({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 42 });
  });

  it("logs fixed tags only: never the context, the signature, the nonce, the body or the IP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await guard(signed({ payload: { ip: "203.0.113.7" } }), undefined, { body: "tampered" });
    const logged = warn.mock.calls.flat().join(" ");
    warn.mockRestore();
    expect(logged).toContain("[website-signature] refused: bad_signature");
    for (const forbidden of ["203.0.113.7", "ada@example.test", SECRET]) expect(logged).not.toContain(forbidden);
  });
});

describe("development without WEBSITE_SIGNATURE_REQUIRED (never production)", () => {
  beforeEach(() => {
    limiter.mockClear();
    limiter.mockImplementation(async () => ({ allowed: true }));
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const request = (headers: Headers) => new Request(`http://crm.internal${PATH}`, { method: "POST", headers, body: BODY });
  const guard = (headers: Headers, store = memoryNonceStore(), extra: Partial<Parameters<typeof guardWebsiteRequest>[0]> = {}) =>
    guardWebsiteRequest({ req: request(headers), body: BODY, companyId: COMPANY, verify: (i) => verifyWebsiteRequestSignature({ ...i, nowMs: NOW, consumeNonce: store.consume }), ...extra });

  it("an unsigned request is accepted", async () => {
    expect(await guard(new Headers())).toEqual({ ok: true, signed: false });
  });

  it("a v1 context is not refused here: it is left to the unchanged v1 reader, and no v2 facts are trusted", async () => {
    const v1Payload = Buffer.from(JSON.stringify({ v: 1, ts: nowSeconds, ip: "203.0.113.9" }), "utf8").toString("base64url");
    const headers = new Headers({ [VISITOR_CONTEXT_HEADER]: v1Payload, [VISITOR_SIGNATURE_HEADER]: createHmac("sha256", SECRET).update(v1Payload).digest("hex") });
    expect(await guard(headers)).toEqual({ ok: true, signed: false });
  });

  it("a valid v2 request is still verified, single-use and rate-limited per visitor", async () => {
    const store = memoryNonceStore();
    const headers = signed({ payload: { ip: "203.0.113.7" } });
    const first = await guard(headers, store, { rateLimit: { endpoint: "WEBSITE_FLIGHT", config: { windowMs: 1000, maxAttempts: 20 } } });
    expect(first).toMatchObject({ ok: true, signed: true, visitor: { ip: "203.0.113.7" } });
    expect(limiter).toHaveBeenCalledWith("203.0.113.7", "WEBSITE_FLIGHT:website", { windowMs: 1000, maxAttempts: 20 });
    // the replay carries no verified visitor (and therefore no trusted IP), and is not counted against anybody
    limiter.mockClear();
    expect(await guard(headers, store, { rateLimit: { endpoint: "WEBSITE_FLIGHT", config: { windowMs: 1000, maxAttempts: 20 } } })).toEqual({ ok: true, signed: false });
    expect(limiter).not.toHaveBeenCalled();
  });

  it("the one-time store being down is still a 503 for a v2 request (it is never treated as verified)", async () => {
    const down = await guardWebsiteRequest({ req: request(signed()), body: BODY, companyId: COMPANY, verify: async () => ({ state: "unavailable" }) });
    expect(down).toMatchObject({ ok: false, status: 503, code: "unavailable" });
  });
});

describe("key rotation: LEAD_INGEST_SECRET_PREVIOUS", () => {
  const NEW_SECRET = "rotated-new-secret-0123456789-abcdefghijklmnop"; // throwaway
  const OLD_SECRET = SECRET;

  it("accepts a request signed with the previous secret while the rotation is in progress, and one signed with the new secret", async () => {
    const withOld = await verify(signed({ secret: OLD_SECRET }), undefined, { secret: NEW_SECRET, previousSecret: OLD_SECRET });
    expect(withOld.state).toBe("verified");
    const withNew = await verify(signed({ secret: NEW_SECRET }), undefined, { secret: NEW_SECRET, previousSecret: OLD_SECRET });
    expect(withNew.state).toBe("verified");
  });
  it("refuses the previous secret once it is no longer configured (rotation finished)", async () => {
    const r = await verify(signed({ secret: OLD_SECRET }), undefined, { secret: NEW_SECRET, previousSecret: undefined });
    expect(r).toEqual({ state: "invalid", reason: "bad_signature" });
  });
  it("refuses a third secret, and ignores a previous secret that is too short (it can never be used to verify)", async () => {
    const other = "a-third-unrelated-secret-0123456789-abcdefghij";
    expect(await verify(signed({ secret: other }), undefined, { secret: NEW_SECRET, previousSecret: OLD_SECRET })).toEqual({ state: "invalid", reason: "bad_signature" });
    const shortSecret = "short";
    expect(await verify(signed({ secret: shortSecret }), undefined, { secret: NEW_SECRET, previousSecret: shortSecret })).toEqual({ state: "invalid", reason: "bad_signature" });
  });
  it("a nonce is consumed once whichever secret signed the request", async () => {
    const store = memoryNonceStore();
    const headers = signed({ secret: OLD_SECRET });
    expect((await verify(headers, store, { secret: NEW_SECRET, previousSecret: OLD_SECRET })).state).toBe("verified");
    expect(await verify(headers, store, { secret: NEW_SECRET, previousSecret: OLD_SECRET })).toEqual({ state: "invalid", reason: "replay" });
  });
});

describe("per-client limiting: one visitor can never use another visitor's allowance, and unauthenticated traffic is never counted", () => {
  // A stand-in with the contract of the real limiter (atomic fixed-window counter per key): the first `max` calls per key pass, the rest are refused.
  const counts = new Map<string, number>();
  beforeEach(() => {
    counts.clear();
    limiter.mockClear();
    limiter.mockImplementation(async (...args: unknown[]) => {
      const [key, endpoint, config] = args as [string, string, { maxAttempts: number }];
      const k = `${key}|${endpoint}`;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      return n <= config.maxAttempts ? { allowed: true } : { allowed: false, retryAfterSeconds: 30 };
    });
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  const request = (headers: Headers) => new Request(`http://crm.internal${PATH}`, { method: "POST", headers, body: BODY });
  const guardFor = (headers: Headers, store: ReturnType<typeof memoryNonceStore>, body = BODY) =>
    guardWebsiteRequest({
      req: request(headers),
      body,
      companyId: COMPANY,
      rateLimit: { endpoint: "WEBSITE_FLIGHT", config: { windowMs: 60_000, maxAttempts: 3 } },
      verify: (i) => verifyWebsiteRequestSignature({ ...i, nowMs: NOW, consumeNonce: store.consume }),
    });

  it("a visitor over the limit is refused with 429 + Retry-After while another visitor is unaffected", async () => {
    const store = memoryNonceStore();
    for (let i = 0; i < 3; i++) expect((await guardFor(signed({ payload: { ip: "203.0.113.1" } }), store)).ok).toBe(true);
    expect(await guardFor(signed({ payload: { ip: "203.0.113.1" } }), store)).toMatchObject({ ok: false, status: 429, code: "rate_limited", retryAfterSeconds: 30 });
    expect((await guardFor(signed({ payload: { ip: "203.0.113.2" } }), store)).ok).toBe(true);
  });

  it("changing unrelated request fields cannot reach a fresh allowance: the key is the signed visitor IP, not the body, the nonce or the timestamp", async () => {
    const store = memoryNonceStore();
    for (let i = 0; i < 3; i++) {
      const body = BODY + " ".repeat(i); // a different (still correctly signed) body, nonce and timestamp every time
      expect((await guardFor(signed({ payload: { ip: "203.0.113.5", ts: nowSeconds - i } }, body), store, body)).ok).toBe(true);
    }
    const body = BODY + "  x";
    expect(await guardFor(signed({ payload: { ip: "203.0.113.5" } }, body), store, body)).toMatchObject({ ok: false, status: 429 });
  });

  it("requests with an invalid signature are refused with 401 BEFORE they can count against any visitor's allowance", async () => {
    const store = memoryNonceStore();
    const forged = signed({ secret: "forged-secret-0123456789-abcdefghijklmnopqrstu", payload: { ip: "203.0.113.9" } });
    for (let i = 0; i < 10; i++) expect(await guardFor(forged, store)).toMatchObject({ ok: false, status: 401 });
    expect(limiter).not.toHaveBeenCalled();
    expect((await guardFor(signed({ payload: { ip: "203.0.113.9" } }), store)).ok).toBe(true); // the real visitor still has the whole allowance
  });

  it("unattributed traffic (no visitor IP) shares one bucket that is separate from every named visitor", async () => {
    const store = memoryNonceStore();
    for (let i = 0; i < 15; i++) expect((await guardFor(signed(), store)).ok).toBe(true); // 3 x 5 allowance
    expect(await guardFor(signed(), store)).toMatchObject({ ok: false, status: 429 });
    expect((await guardFor(signed({ payload: { ip: "203.0.113.77" } }), store)).ok).toBe(true);
  });

  it("recovers after the window: a fresh window starts from zero (window keys differ, the same visitor passes again)", async () => {
    const store = memoryNonceStore();
    for (let i = 0; i < 4; i++) await guardFor(signed({ payload: { ip: "203.0.113.3" } }), store);
    counts.clear(); // what the next fixed window means for the real limiter: a new bucket key with no count
    expect((await guardFor(signed({ payload: { ip: "203.0.113.3" } }), store)).ok).toBe(true);
  });
});
