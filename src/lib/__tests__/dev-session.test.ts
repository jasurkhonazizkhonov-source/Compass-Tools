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

  it("the 24h lifetime is ABSOLUTE and exact: valid one millisecond before it, expired at it and after (no grace, no sliding)", () => {
    const created = new Date("2026-10-05T10:00:00.000Z");
    const t = created.getTime();
    expect(isSessionExpired(created, t)).toBe(false);
    expect(isSessionExpired(created, t + SESSION_MAX_AGE_MS - 1)).toBe(false);
    expect(isSessionExpired(created, t + SESSION_MAX_AGE_MS)).toBe(true);
    expect(isSessionExpired(created, t + SESSION_MAX_AGE_MS + 1)).toBe(true);
    expect(SESSION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("a newer sessionCreatedAt (a new sign-in) starts a new full window", () => {
    const first = new Date("2026-10-05T10:00:00.000Z");
    const second = new Date("2026-10-06T09:59:00.000Z"); // signed in again just before the first window closed
    const now = first.getTime() + SESSION_MAX_AGE_MS + 60_000;
    expect(isSessionExpired(first, now)).toBe(true);
    expect(isSessionExpired(second, now)).toBe(false);
  });

  it("treats a session created many days ago as expired", () => {
    expect(isSessionExpired(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000))).toBe(true);
  });
});
