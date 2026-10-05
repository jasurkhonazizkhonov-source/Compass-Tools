import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake cookie jar + Account table, same convention as the other
// server-action test files in this project (payment-methods.test.ts etc.).

type FakeAccount = { id: string; activeSessionId: string | null; sessionCreatedAt: Date | null; lastSeenAt: Date | null; status?: string };

let accounts: Map<string, FakeAccount>;
let cookieJar: Map<string, string>;
let redirectedTo: string | undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    redirectedTo = path;
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findUnique: vi.fn(async ({ where: { activeSessionId } }: { where: { activeSessionId: string } }) => {
        for (const account of accounts.values()) {
          if (account.activeSessionId === activeSessionId) return account;
        }
        return null;
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeAccount> }) => {
        const account = accounts.get(id);
        if (!account) throw new Error(`account ${id} not found`);
        Object.assign(account, data);
        return account;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { activeSessionId: string }; data: Partial<FakeAccount> }) => {
        let count = 0;
        for (const account of accounts.values()) {
          if (account.activeSessionId === where.activeSessionId) {
            Object.assign(account, data);
            count++;
          }
        }
        return { count };
      }),
    },
  },
}));

beforeEach(() => {
  accounts = new Map([
    ["admin-1", { id: "admin-1", activeSessionId: null, sessionCreatedAt: null, lastSeenAt: null, status: "ACTIVE" }],
    ["agent-1", { id: "agent-1", activeSessionId: null, sessionCreatedAt: null, lastSeenAt: null, status: "ACTIVE" }],
  ]);
  cookieJar = new Map();
  redirectedTo = undefined;
  vi.clearAllMocks();
});

/** Stands in for a completed sign-in: the account holds a token and this "browser" carries the matching cookie. */
async function establishSession(accountId: string) {
  const token = `tok-${accountId}-${Math.random().toString(36).slice(2)}`;
  Object.assign(accounts.get(accountId)!, { activeSessionId: token, sessionCreatedAt: new Date() });
  cookieJar.set("compass_dev_account", token);
}

// establishSession (session issuance, single active device, sign-in IP/location, the absolute 24h lifetime) now lives in
// src/server/auth/establish-session.ts and is proven against a real PostgreSQL in
// __integration__/session-lifecycle.integration.test.ts — it is one atomic SQL statement, which a fake table cannot honestly model.

describe("heartbeat — session-derived, never a client-supplied accountId", () => {
  // PresenceHeartbeat is a Client Component that imports heartbeat()
  // directly, which makes it a real network-callable server action
  // regardless of what accountId prop the component was rendered with —
  // heartbeat() must never trust a parameter for this reason (it takes
  // none). Proves it only ever touches the CALLER's own session account.
  it("updates lastSeenAt for the CALLER's own account, derived from the session cookie", async () => {
    const { heartbeat } = await import("../dev-session");
    await establishSession("admin-1");
    expect(accounts.get("admin-1")!.lastSeenAt).toBeNull();

    await heartbeat();

    expect(accounts.get("admin-1")!.lastSeenAt).toBeInstanceOf(Date);
    expect(accounts.get("agent-1")!.lastSeenAt).toBeNull();
  });

  it("skips the database write when the previous heartbeat was under 30s ago (multiple tabs/devices no longer each write)", async () => {
    const { heartbeat } = await import("../dev-session");
    await establishSession("admin-1");
    const recent = new Date(Date.now() - 5_000);
    accounts.get("admin-1")!.lastSeenAt = recent;

    await heartbeat();

    expect(accounts.get("admin-1")!.lastSeenAt).toBe(recent); // untouched

    const stale = new Date(Date.now() - 60_000);
    accounts.get("admin-1")!.lastSeenAt = stale;
    await heartbeat();
    expect(accounts.get("admin-1")!.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("is a safe no-op when there is no valid session (no cookie, or a stale/superseded token)", async () => {
    const { heartbeat } = await import("../dev-session");
    await expect(heartbeat()).resolves.toBeUndefined();
    expect(accounts.get("admin-1")!.lastSeenAt).toBeNull();
    expect(accounts.get("agent-1")!.lastSeenAt).toBeNull();
  });
});

describe("signOut — real server-side invalidation", () => {
  it("clears the account's activeSessionId/sessionCreatedAt, not just the cookie", async () => {
    const { signOut } = await import("../dev-session");
    await establishSession("admin-1");
    expect(accounts.get("admin-1")!.activeSessionId).toBeTruthy();

    await signOut();

    expect(accounts.get("admin-1")!.activeSessionId).toBeNull();
    expect(accounts.get("admin-1")!.sessionCreatedAt).toBeNull();
  });

  it("clears the cookie", async () => {
    const { signOut } = await import("../dev-session");
    await establishSession("admin-1");
    await signOut();
    expect(cookieJar.has("compass_dev_account")).toBe(false);
  });

  it("redirects to the sign-in bootstrap page", async () => {
    const { signOut } = await import("../dev-session");
    await establishSession("admin-1");
    await signOut();
    expect(redirectedTo).toBe("/login");
  });

  it("a stale/already-cleared cookie is a safe no-op, not an error", async () => {
    const { signOut } = await import("../dev-session");
    cookieJar.set("compass_dev_account", "some-token-that-matches-nothing");
    await expect(signOut()).resolves.not.toThrow();
  });
});
