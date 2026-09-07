import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake cookie jar + Account table, same convention as the other
// server-action test files in this project (payment-methods.test.ts etc.).

type FakeAccount = { id: string; activeSessionId: string | null; sessionCreatedAt: Date | null; lastSeenAt: Date | null };

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

const destroyCvvAuthorizationsForAccount = vi.fn();
vi.mock("@/server/security/cvv-cache", () => ({
  destroyCvvAuthorizationsForAccount: (...args: [string]) => destroyCvvAuthorizationsForAccount(...args),
}));

beforeEach(() => {
  accounts = new Map([
    ["admin-1", { id: "admin-1", activeSessionId: null, sessionCreatedAt: null, lastSeenAt: null }],
    ["agent-1", { id: "agent-1", activeSessionId: null, sessionCreatedAt: null, lastSeenAt: null }],
  ]);
  cookieJar = new Map();
  redirectedTo = undefined;
  vi.clearAllMocks();
});

describe("establishSession — session issuance", () => {
  it("issues a fresh, unguessable session token and stores it on the account", async () => {
    const { establishSession } = await import("../dev-session");
    await establishSession("admin-1");

    const account = accounts.get("admin-1")!;
    expect(account.activeSessionId).toBeTruthy();
    expect(account.activeSessionId!.length).toBeGreaterThan(20);
    expect(account.sessionCreatedAt).toBeInstanceOf(Date);
  });

  it("sets the session cookie to the token, never to the raw account id", async () => {
    const { establishSession } = await import("../dev-session");
    await establishSession("admin-1");

    const account = accounts.get("admin-1")!;
    const cookieValue = cookieJar.get("compass_dev_account");
    expect(cookieValue).toBe(account.activeSessionId);
    expect(cookieValue).not.toBe("admin-1");
  });

  it("a second login for the SAME account overwrites (invalidates) the previous token — single active device", async () => {
    const { establishSession } = await import("../dev-session");
    await establishSession("admin-1");
    const firstToken = accounts.get("admin-1")!.activeSessionId;

    await establishSession("admin-1");
    const secondToken = accounts.get("admin-1")!.activeSessionId;

    expect(secondToken).not.toBe(firstToken);
    // The first token no longer matches any account's activeSessionId, so a
    // lookup by it (what getCurrentAccount does) would now find nothing —
    // that's the actual single-device enforcement mechanism.
    expect([...accounts.values()].some((a) => a.activeSessionId === firstToken)).toBe(false);
  });

  it("logging in as a DIFFERENT account does not affect the first account's session", async () => {
    const { establishSession } = await import("../dev-session");
    await establishSession("admin-1");
    const adminToken = accounts.get("admin-1")!.activeSessionId;

    await establishSession("agent-1");

    expect(accounts.get("admin-1")!.activeSessionId).toBe(adminToken);
  });

  it("destroys any CVV authorization state the account was holding on every login — a fresh login is a fresh authentication boundary", async () => {
    const { establishSession } = await import("../dev-session");
    await establishSession("admin-1");
    expect(destroyCvvAuthorizationsForAccount).toHaveBeenCalledWith("admin-1");
  });
});

describe("heartbeat — session-derived, never a client-supplied accountId", () => {
  // PresenceHeartbeat is a Client Component that imports heartbeat()
  // directly, which makes it a real network-callable server action
  // regardless of what accountId prop the component was rendered with —
  // heartbeat() must never trust a parameter for this reason (it takes
  // none). Proves it only ever touches the CALLER's own session account.
  it("updates lastSeenAt for the CALLER's own account, derived from the session cookie", async () => {
    const { establishSession, heartbeat } = await import("../dev-session");
    await establishSession("admin-1");
    expect(accounts.get("admin-1")!.lastSeenAt).toBeNull();

    await heartbeat();

    expect(accounts.get("admin-1")!.lastSeenAt).toBeInstanceOf(Date);
    expect(accounts.get("agent-1")!.lastSeenAt).toBeNull();
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
    const { establishSession, signOut } = await import("../dev-session");
    await establishSession("admin-1");
    expect(accounts.get("admin-1")!.activeSessionId).toBeTruthy();

    await signOut();

    expect(accounts.get("admin-1")!.activeSessionId).toBeNull();
    expect(accounts.get("admin-1")!.sessionCreatedAt).toBeNull();
  });

  it("clears the cookie", async () => {
    const { establishSession, signOut } = await import("../dev-session");
    await establishSession("admin-1");
    await signOut();
    expect(cookieJar.has("compass_dev_account")).toBe(false);
  });

  it("redirects to the sign-in bootstrap page", async () => {
    const { establishSession, signOut } = await import("../dev-session");
    await establishSession("admin-1");
    await signOut();
    expect(redirectedTo).toBe("/login");
  });

  it("a stale/already-cleared cookie is a safe no-op, not an error", async () => {
    const { signOut } = await import("../dev-session");
    cookieJar.set("compass_dev_account", "some-token-that-matches-nothing");
    await expect(signOut()).resolves.not.toThrow();
  });

  it("destroys the signed-out account's active CVV authorization state, not some other account's", async () => {
    const { establishSession, signOut } = await import("../dev-session");
    await establishSession("admin-1");
    destroyCvvAuthorizationsForAccount.mockClear(); // ignore the call establishSession itself made
    await signOut();
    expect(destroyCvvAuthorizationsForAccount).toHaveBeenCalledWith("admin-1");
    expect(destroyCvvAuthorizationsForAccount).not.toHaveBeenCalledWith("agent-1");
  });

  it("a sign-out with no matching session does not attempt to destroy any account's CVV state", async () => {
    const { signOut } = await import("../dev-session");
    cookieJar.set("compass_dev_account", "some-token-that-matches-nothing");
    await signOut();
    expect(destroyCvvAuthorizationsForAccount).not.toHaveBeenCalled();
  });
});
