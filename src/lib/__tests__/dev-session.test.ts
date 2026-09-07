import { describe, it, expect, vi } from "vitest";

// dev-session.ts imports @/lib/prisma at module scope for its other export
// (getCurrentAccount) — prisma.ts eagerly creates a client from
// process.env.DATABASE_URL at import time, which isn't set in this test
// environment. isSessionExpired itself never touches the database; this
// mock exists purely so importing the module doesn't crash on load.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { isSessionExpired, SESSION_MAX_AGE_MS } from "../dev-session";

describe("isSessionExpired", () => {
  it("treats a null sessionCreatedAt (never logged in / signed out) as expired", () => {
    expect(isSessionExpired(null)).toBe(true);
  });

  it("treats a session created just now as not expired", () => {
    expect(isSessionExpired(new Date())).toBe(false);
  });

  it("treats a session created 23 hours ago as not expired", () => {
    expect(isSessionExpired(new Date(Date.now() - 23 * 60 * 60 * 1000))).toBe(false);
  });

  it("treats a session created exactly at the 24h boundary as not yet expired", () => {
    expect(isSessionExpired(new Date(Date.now() - SESSION_MAX_AGE_MS + 1000))).toBe(false);
  });

  it("treats a session created 24 hours and 1 second ago as expired (absolute lifetime, not sliding)", () => {
    expect(isSessionExpired(new Date(Date.now() - SESSION_MAX_AGE_MS - 1000))).toBe(true);
  });

  it("treats a session created many days ago as expired", () => {
    expect(isSessionExpired(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000))).toBe(true);
  });
});
