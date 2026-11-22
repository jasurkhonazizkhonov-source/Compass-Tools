// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the two PostgreSQL behaviours that website signing v2 and its per-visitor limiter depend on, which their unit tests can only simulate:
//   1. a request signature is single-use ACROSS concurrent requests: one atomic "INSERT ... ON CONFLICT DO NOTHING" decides the race (website-request-signature.ts);
//   2. the per-visitor limiter is an atomic counter: simultaneous requests cannot slip past the limit, visitors do not share a bucket (rate-limit.ts).
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied; removes its own tagged rows afterwards.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
}

const TAG = `wsr-${Date.now()}`;
const SECRET = randomBytes(24).toString("base64url"); // 32 characters: the minimum the verifier accepts
const COMPANY = `company-${TAG}`;
const PATH = "/api/public/contact-inquiry";
const BODY = JSON.stringify({ companyId: COMPANY, firstName: "Ada", lastName: "Lovelace", email: `ada-${TAG}@example.test`, message: "Hello" });

describe.skipIf(!enabled)("website signing v2 and per-visitor limiting - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let sig: typeof import("@/server/website-request-signature");
  let limiter: typeof import("@/server/security/rate-limit");
  let ingest: typeof import("@/server/lead-ingest-context");

  const inFuture = () => new Date(Date.now() + 5 * 60_000);
  function signedHeaders(overrides: { nonce?: string; ts?: number; body?: string } = {}) {
    const payload = { v: 2 as const, ts: overrides.ts ?? Math.floor(Date.now() / 1000), nonce: overrides.nonce ?? randomBytes(16).toString("base64url"), ip: "203.0.113.50" };
    const s = sig.signWebsiteRequestV2({ secret: SECRET, method: "POST", path: PATH, companyId: COMPANY, body: overrides.body ?? BODY, payload });
    return new Headers({ [ingest.VISITOR_CONTEXT_HEADER]: s.context, [ingest.VISITOR_SIGNATURE_HEADER]: s.signature });
  }
  const verify = (headers: Headers, body = BODY) => sig.verifyWebsiteRequestSignature({ headers, method: "POST", path: PATH, companyId: COMPANY, body, secret: SECRET });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    sig = await import("@/server/website-request-signature");
    limiter = await import("@/server/security/rate-limit");
    ingest = await import("@/server/lead-ingest-context");
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.rateLimitCounter.deleteMany({ where: { key: { contains: TAG } } }); // only this suite's own rows
    await prisma.$disconnect();
  });

  describe("the one-time nonce store (INSERT ... ON CONFLICT DO NOTHING)", () => {
    it("twenty-five simultaneous consumptions of one key: exactly one wins", async () => {
      const key = `nonce:v2:${COMPANY}:race-${TAG}`;
      const results = await Promise.all(Array.from({ length: 25 }, () => sig.consumeNonceInDatabase(key, inFuture())));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await prisma.rateLimitCounter.count({ where: { key } })).toBe(1);
    });

    it("a consumed key stays refused; a different key is independent", async () => {
      const a = `nonce:v2:${COMPANY}:a-${TAG}`;
      const b = `nonce:v2:${COMPANY}:b-${TAG}`;
      expect(await sig.consumeNonceInDatabase(a, inFuture())).toBe(true);
      expect(await sig.consumeNonceInDatabase(a, inFuture())).toBe(false);
      expect(await sig.consumeNonceInDatabase(b, inFuture())).toBe(true);
    });

    it("a nonce belongs to a company: the same nonce text for another company is another key", async () => {
      const nonce = `shared-${TAG}`;
      expect(await sig.consumeNonceInDatabase(`nonce:v2:${COMPANY}:${nonce}`, inFuture())).toBe(true);
      expect(await sig.consumeNonceInDatabase(`nonce:v2:other-${COMPANY}:${nonce}`, inFuture())).toBe(true);
    });

    it("an expired nonce row is purged by the existing cleanup, and nothing else is: a live row survives it", async () => {
      const expired = `nonce:v2:${COMPANY}:expired-${TAG}`;
      const live = `nonce:v2:${COMPANY}:live-${TAG}`;
      expect(await sig.consumeNonceInDatabase(expired, new Date(Date.now() - 60_000))).toBe(true);
      expect(await sig.consumeNonceInDatabase(live, inFuture())).toBe(true);
      const { deleted } = await limiter.cleanupExpiredRateLimitCounters();
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await prisma.rateLimitCounter.count({ where: { key: expired } })).toBe(0);
      expect(await prisma.rateLimitCounter.count({ where: { key: live } })).toBe(1);
    });
  });

  describe("the whole verifier on the real store (default nonce consumer)", () => {
    it("a signed request verifies once; the identical request again is refused as a replay", async () => {
      const headers = signedHeaders();
      const first = await verify(headers);
      expect(first.state).toBe("verified");
      expect(first).toMatchObject({ visitor: { ip: "203.0.113.50" } });
      expect(await verify(headers)).toEqual({ state: "invalid", reason: "replay" });
    });

    it("fifteen simultaneous submissions of the SAME signed request: exactly one is verified, the rest are replays", async () => {
      const headers = signedHeaders();
      const results = await Promise.all(Array.from({ length: 15 }, () => verify(headers)));
      expect(results.filter((r) => r.state === "verified")).toHaveLength(1);
      expect(results.filter((r) => r.state === "invalid" && r.reason === "replay")).toHaveLength(14);
    });

    it("a forged or tampered request never reaches the store: it consumes nothing, so the genuine request still works afterwards", async () => {
      const nonce = randomBytes(16).toString("base64url");
      const genuine = signedHeaders({ nonce });
      expect(await verify(genuine, BODY.replace("Hello", "Hullo"))).toEqual({ state: "invalid", reason: "bad_signature" }); // body changed after signing
      expect((await verify(genuine)).state).toBe("verified"); // the nonce was not burned by the refused attempt
    });

    it("a stale timestamp is refused before the store is touched", async () => {
      const nonce = randomBytes(16).toString("base64url");
      const stale = signedHeaders({ nonce, ts: Math.floor(Date.now() / 1000) - 3600 });
      expect(await verify(stale)).toEqual({ state: "invalid", reason: "expired" });
      expect(await prisma.rateLimitCounter.count({ where: { key: `nonce:v2:${COMPANY}:${nonce}` } })).toBe(0);
    });
  });

  describe("the per-visitor limiter (atomic counter)", () => {
    const config = { windowMs: 60 * 60 * 1000, maxAttempts: 5 }; // an hour-long window: the test cannot straddle a window boundary

    it("twelve simultaneous requests from one visitor: exactly five are allowed, the rest are refused with a retry time", async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => limiter.checkPublicRateLimitForKey(`203.0.113.${TAG}-one`, "WEBSITE_FLIGHT:website", config)));
      expect(results.filter((r) => r.allowed)).toHaveLength(5);
      const refused = results.filter((r) => !r.allowed);
      expect(refused).toHaveLength(7);
      for (const r of refused) expect(r.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("another visitor, and the same visitor on another endpoint, have their own allowance", async () => {
      const spent = `203.0.113.${TAG}-two`;
      for (let i = 0; i < 5; i++) expect((await limiter.checkPublicRateLimitForKey(spent, "CONTACT_INQUIRY:website", config)).allowed).toBe(true);
      expect((await limiter.checkPublicRateLimitForKey(spent, "CONTACT_INQUIRY:website", config)).allowed).toBe(false);
      expect((await limiter.checkPublicRateLimitForKey(`203.0.113.${TAG}-three`, "CONTACT_INQUIRY:website", config)).allowed).toBe(true);
      expect((await limiter.checkPublicRateLimitForKey(spent, "SUBSCRIBE:website", config)).allowed).toBe(true);
    });
  });
});
