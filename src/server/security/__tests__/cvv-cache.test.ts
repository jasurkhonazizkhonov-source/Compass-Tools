import { describe, it, expect, beforeEach, vi } from "vitest";
import { cacheCvv, claimCvvForAuthorization, hasCachedCvv, destroyCvv, destroyCvvAuthorizationsForAccount, __resetCvvCacheForTests, CVV_TTL_MS } from "../cvv-cache";

describe("cvv-cache — the only place a CVV ever exists after submission", () => {
  beforeEach(() => {
    __resetCvvCacheForTests();
    vi.useRealTimers();
  });

  it("the authorization window is exactly 24 hours — a deliberate business decision, still bounded and single-authorization-scoped, not permanent retention", () => {
    expect(CVV_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("caches and claims a CVV for its own payment method id", () => {
    cacheCvv("pm-1", "123");
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBe("123");
  });

  it("never leaks one payment method's CVV into another's lookup — cross-card isolation", () => {
    cacheCvv("pm-1", "111");
    cacheCvv("pm-2", "222");
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBe("111");
    expect(claimCvvForAuthorization("pm-2", "agent-1")).toBe("222");
    // Destroying one card's entry must never affect the other's.
    destroyCvv("pm-1");
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBeUndefined();
    expect(claimCvvForAuthorization("pm-2", "agent-1")).toBe("222");
  });

  it("returns undefined for a payment method that was never cached", () => {
    expect(claimCvvForAuthorization("never-existed", "agent-1")).toBeUndefined();
  });

  it("hasCachedCvv reflects presence without ever returning the value itself", () => {
    cacheCvv("pm-1", "123");
    expect(hasCachedCvv("pm-1")).toBe(true);
    destroyCvv("pm-1");
    expect(hasCachedCvv("pm-1")).toBe(false);
  });

  it("destroyCvv is idempotent — safe to call on an already-destroyed or never-cached entry", () => {
    expect(() => destroyCvv("pm-does-not-exist")).not.toThrow();
    cacheCvv("pm-1", "123");
    destroyCvv("pm-1");
    expect(() => destroyCvv("pm-1")).not.toThrow();
  });

  it("a completed (destroyed) authorization can never be re-claimed — no historical CVV retrieval", () => {
    cacheCvv("pm-1", "123");
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBe("123");
    destroyCvv("pm-1"); // simulates confirmPaymentReceived ending the authorization
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBeUndefined();
    expect(hasCachedCvv("pm-1")).toBe(false);
  });

  it("expires automatically after the TTL elapses, even if never explicitly destroyed", () => {
    vi.useFakeTimers();
    cacheCvv("pm-1", "123");
    expect(hasCachedCvv("pm-1")).toBe(true);
    vi.advanceTimersByTime(CVV_TTL_MS + 1);
    expect(hasCachedCvv("pm-1")).toBe(false);
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("destroyCvvAuthorizationsForAccount only removes entries claimed by that account, not unclaimed or differently-claimed entries", () => {
    cacheCvv("pm-1", "111"); // fresh from submission, never claimed by anyone yet
    cacheCvv("pm-2", "222");
    cacheCvv("pm-3", "333");
    claimCvvForAuthorization("pm-2", "agent-A");
    claimCvvForAuthorization("pm-3", "agent-B");

    destroyCvvAuthorizationsForAccount("agent-A");

    expect(hasCachedCvv("pm-1")).toBe(true); // untouched — never claimed by anyone
    expect(hasCachedCvv("pm-2")).toBe(false); // agent-A's active authorization destroyed
    expect(hasCachedCvv("pm-3")).toBe(true); // a different agent's authorization is untouched
  });

  it("claiming does not extend or reset the TTL — the window is bounded from submission, not from last access", () => {
    vi.useFakeTimers();
    cacheCvv("pm-1", "123");
    vi.advanceTimersByTime(CVV_TTL_MS - 1000);
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBe("123"); // still valid, 1s before expiry
    vi.advanceTimersByTime(2000); // crosses the original TTL boundary
    expect(claimCvvForAuthorization("pm-1", "agent-1")).toBeUndefined(); // expired on schedule, not renewed by the earlier claim
    vi.useRealTimers();
  });
});
