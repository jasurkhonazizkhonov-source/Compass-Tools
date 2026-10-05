import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { resolveVisitorContext, signVisitorContext, VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER, VISITOR_CONTEXT_MAX_SKEW_SECONDS } from "../lead-ingest-context";
import { deriveWebsiteLeadId } from "../website-lead-id";

const SECRET = "unit-test-secret-0123456789-abcdefghijkl"; // throwaway test value
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const ts = Math.floor(NOW / 1000);
const headersFor = (payload: object, secret = SECRET) => {
  const s = signVisitorContext(payload as never, secret);
  return new Headers({ [VISITOR_CONTEXT_HEADER]: s.context, [VISITOR_SIGNATURE_HEADER]: s.signature });
};

describe("resolveVisitorContext", () => {
  it("no headers at all -> absent (a direct visitor: the trusted-proxy path applies)", () => {
    expect(resolveVisitorContext(new Headers(), NOW, SECRET)).toEqual({ state: "absent" });
  });

  it("a valid signed context -> verified, with a validated IP and the website's approximate location", () => {
    const r = resolveVisitorContext(headersFor({ v: 1, ts, ip: "203.0.113.42", city: "Los%20Angeles", region: "CA", country: "US", timezone: "America/Los_Angeles" }), NOW, SECRET);
    expect(r).toMatchObject({ state: "verified", ip: "203.0.113.42" });
    expect(r.state === "verified" && r.location).toMatchObject({ city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles" });
  });

  it("an IPv4-mapped IPv6 address is normalised; IPv6 is accepted", () => {
    expect(resolveVisitorContext(headersFor({ v: 1, ts, ip: "::ffff:203.0.113.9" }), NOW, SECRET)).toMatchObject({ ip: "203.0.113.9" });
    expect(resolveVisitorContext(headersFor({ v: 1, ts, ip: "2001:db8:85a3::8a2e:370:7334" }), NOW, SECRET)).toMatchObject({ ip: "2001:db8:85a3::8a2e:370:7334" });
  });

  it.each(["10.1.2.3", "192.168.0.1", "127.0.0.1", "not-an-ip", "999.1.1.1", ""])("a signed but unacceptable IP (%s) is dropped, not stored", (ip) => {
    expect(resolveVisitorContext(headersFor({ v: 1, ts, ip, country: "DE" }), NOW, SECRET)).toMatchObject({ state: "verified", ip: undefined });
  });

  it("wrong secret, tampered context, tampered signature, missing signature, missing context -> invalid", () => {
    const good = signVisitorContext({ v: 1, ts, ip: "203.0.113.42" }, SECRET);
    expect(resolveVisitorContext(headersFor({ v: 1, ts, ip: "203.0.113.42" }, "a-completely-different-secret-value-xx"), NOW, SECRET).state).toBe("invalid");
    const tampered = Buffer.from(JSON.stringify({ v: 1, ts, ip: "8.8.8.8" })).toString("base64url");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: tampered, [VISITOR_SIGNATURE_HEADER]: good.signature }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: good.context, [VISITOR_SIGNATURE_HEADER]: good.signature.replace(/.$/, (c) => (c === "0" ? "1" : "0")) }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: good.context }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({ [VISITOR_SIGNATURE_HEADER]: good.signature }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: good.context, [VISITOR_SIGNATURE_HEADER]: "zz" }), NOW, SECRET).state).toBe("invalid");
  });

  it("no secret configured, or one that is too short, can never verify anything", () => {
    const h = headersFor({ v: 1, ts, ip: "203.0.113.42" });
    expect(resolveVisitorContext(h, NOW, undefined).state).toBe("invalid");
    expect(resolveVisitorContext(h, NOW, "").state).toBe("invalid");
    expect(resolveVisitorContext(headersFor({ v: 1, ts, ip: "203.0.113.42" }, "short"), NOW, "short").state).toBe("invalid");
  });

  it("the timestamp window is enforced in both directions", () => {
    const edge = VISITOR_CONTEXT_MAX_SKEW_SECONDS;
    expect(resolveVisitorContext(headersFor({ v: 1, ts: ts - edge, ip: "203.0.113.42" }), NOW, SECRET).state).toBe("verified");
    expect(resolveVisitorContext(headersFor({ v: 1, ts: ts - edge - 5, ip: "203.0.113.42" }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(headersFor({ v: 1, ts: ts + edge + 5, ip: "203.0.113.42" }), NOW, SECRET).state).toBe("invalid");
  });

  it("an unknown version, a non-numeric timestamp, garbage JSON or an oversized context are invalid even when correctly signed", () => {
    expect(resolveVisitorContext(headersFor({ v: 2, ts }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(headersFor({ v: 1, ts: "now" }), NOW, SECRET).state).toBe("invalid");
    const garbage = Buffer.from("not json").toString("base64url");
    expect(resolveVisitorContext(new Headers({ [VISITOR_CONTEXT_HEADER]: garbage, [VISITOR_SIGNATURE_HEADER]: createHmac("sha256", SECRET).update(garbage).digest("hex") }), NOW, SECRET).state).toBe("invalid");
    expect(resolveVisitorContext(headersFor({ v: 1, ts, pad: "x".repeat(3000) }), NOW, SECRET).state).toBe("invalid");
  });

  it("oversized or control-character geo values are not stored", () => {
    const r = resolveVisitorContext(headersFor({ v: 1, ts, city: "x".repeat(500), country: "DE" }), NOW, SECRET);
    expect(r.state === "verified" && r.location?.city).toBeUndefined();
    expect(r.state === "verified" && r.location?.countryCode).toBe("DE");
  });
});

describe("deriveWebsiteLeadId", () => {
  it("is deterministic, cuid-shaped, and different for different keys", () => {
    expect(deriveWebsiteLeadId("abc12345")).toBe(deriveWebsiteLeadId("abc12345"));
    expect(deriveWebsiteLeadId("abc12345")).toMatch(/^c[0-9a-f]{24}$/);
    expect(deriveWebsiteLeadId("abc12345")).not.toBe(deriveWebsiteLeadId("abc12346"));
  });
  it("matches the id the public website derives for the same key (cross-path idempotency)", () => {
    // value computed with the website's own deriveLeadId() (src/lib/submission-id.ts there) for the key "abc12345"
    expect(deriveWebsiteLeadId("abc12345")).toBe("cb16d0a63dc3b3cd8ee495bf4");
  });
});
