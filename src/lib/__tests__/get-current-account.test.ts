import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeAccount = { id: string; activeSessionId: string | null; sessionCreatedAt: Date | null; status: string };

let accounts: Map<string, FakeAccount>;
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "compass_dev_account" && cookieValue ? { name, value: cookieValue } : undefined),
  })),
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
    },
  },
}));

const destroyCvvAuthorizationsForAccount = vi.fn();
vi.mock("@/server/security/cvv-cache", () => ({
  destroyCvvAuthorizationsForAccount: (...args: [string]) => destroyCvvAuthorizationsForAccount(...args),
}));

beforeEach(() => {
  accounts = new Map();
  cookieValue = undefined;
  vi.clearAllMocks();
});

describe("getCurrentAccount — real session validation, no fallback-to-admin", () => {
  it("returns null when there is no cookie at all", async () => {
    const { getCurrentAccount } = await import("../dev-session");
    expect(await getCurrentAccount()).toBeNull();
  });

  it("returns null when the cookie's token matches no account's current session (forged/unknown token)", async () => {
    cookieValue = "unknown-token";
    const { getCurrentAccount } = await import("../dev-session");
    expect(await getCurrentAccount()).toBeNull();
  });

  it("returns the account for a valid, unexpired session token", async () => {
    accounts.set("admin-1", { id: "admin-1", activeSessionId: "tok-abc", sessionCreatedAt: new Date(), status: "ACTIVE" });
    cookieValue = "tok-abc";
    const { getCurrentAccount } = await import("../dev-session");
    const account = await getCurrentAccount();
    expect(account?.id).toBe("admin-1");
  });

  it("returns null for a session older than the 24h absolute lifetime, even though the token still matches", async () => {
    accounts.set("admin-1", {
      id: "admin-1",
      activeSessionId: "tok-abc",
      sessionCreatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      status: "ACTIVE",
    });
    cookieValue = "tok-abc";
    const { getCurrentAccount } = await import("../dev-session");
    expect(await getCurrentAccount()).toBeNull();
  });

  it("destroys the account's active CVV authorization state the moment its expired session is lazily detected", async () => {
    accounts.set("admin-1", {
      id: "admin-1",
      activeSessionId: "tok-abc",
      sessionCreatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      status: "ACTIVE",
    });
    cookieValue = "tok-abc";
    const { getCurrentAccount } = await import("../dev-session");
    await getCurrentAccount();
    expect(destroyCvvAuthorizationsForAccount).toHaveBeenCalledWith("admin-1");
  });

  it("does NOT destroy CVV authorization state for a session that is still valid", async () => {
    accounts.set("admin-1", { id: "admin-1", activeSessionId: "tok-abc", sessionCreatedAt: new Date(), status: "ACTIVE" });
    cookieValue = "tok-abc";
    const { getCurrentAccount } = await import("../dev-session");
    await getCurrentAccount();
    expect(destroyCvvAuthorizationsForAccount).not.toHaveBeenCalled();
  });

  it("returns null for a token that was valid but has since been superseded by a newer login on another device", async () => {
    // Simulates: admin-1 logged in on device A (token "old-tok"), then
    // logged in again on device B, which overwrote activeSessionId to
    // "new-tok". Device A's cookie ("old-tok") no longer matches anything.
    accounts.set("admin-1", { id: "admin-1", activeSessionId: "new-tok", sessionCreatedAt: new Date(), status: "ACTIVE" });
    cookieValue = "old-tok";
    const { getCurrentAccount } = await import("../dev-session");
    expect(await getCurrentAccount()).toBeNull();
  });

  it("never silently falls back to any other account when the presented session is invalid", async () => {
    accounts.set("admin-1", { id: "admin-1", activeSessionId: "tok-real", sessionCreatedAt: new Date(), status: "ACTIVE" });
    cookieValue = "tok-fake";
    const { getCurrentAccount } = await import("../dev-session");
    const account = await getCurrentAccount();
    expect(account).toBeNull();
    expect(account).not.toEqual(accounts.get("admin-1"));
  });
});
