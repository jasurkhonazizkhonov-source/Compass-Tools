import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the LAYER 2 authorization decision tree in isolation — this
// never touches any real OAuth/Google code (none exists yet), it only
// verifies that GIVEN an already-verified email, the CRM's own
// authorization rules (exists? active? what role?) behave exactly as
// specced, entirely independent of whether Google authentication itself
// succeeded.

type FakeAccount = {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
};

let accounts: FakeAccount[];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findFirst: vi.fn(async ({ where }: { where: { email: { equals: string; mode: string } } }) => {
        const target = where.email.equals.toLowerCase();
        return accounts.find((a) => a.email.toLowerCase() === target) ?? null;
      }),
    },
  },
}));

beforeEach(() => {
  accounts = [
    { id: "acct-admin", email: "admin@compasstools.dev", fullName: "Sarah Mitchell", role: "ADMIN", status: "ACTIVE" },
    { id: "acct-agent", email: "sarah.mitchell@compasstools.dev", fullName: "Not Sarah Mitchell The Admin", role: "TRAVEL_AGENT", status: "ACTIVE" },
    { id: "acct-disabled", email: "disabled@compasstools.dev", fullName: "Disabled User", role: "TRAVEL_AGENT", status: "INACTIVE" },
  ];
  vi.clearAllMocks();
});

describe("normalizeEmail", () => {
  it("trims whitespace and lowercases", async () => {
    const { normalizeEmail } = await import("../google-authorization");
    expect(normalizeEmail("  Sarah@Example.com  ")).toBe("sarah@example.com");
  });
});

describe("authorizeGoogleUser — decision tree", () => {
  it("§19/20: verified email matching an active user is allowed, and the role is loaded from the CRM database, not from anywhere else", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    const result = await authorizeGoogleUser("sarah.mitchell@compasstools.dev");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.account.role).toBe("TRAVEL_AGENT");
      expect(result.account.id).toBe("acct-agent");
    }
  });

  it("§21: verified email matching an ADMIN account loads the Admin role", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    const result = await authorizeGoogleUser("admin@compasstools.dev");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account.role).toBe("ADMIN");
  });

  it("§21: a disabled CRM account is denied even though the email exists", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    const result = await authorizeGoogleUser("disabled@compasstools.dev");
    expect(result).toEqual({ ok: false, reason: "ACCOUNT_DISABLED" });
  });

  it("§21: an email with no matching Account at all is denied — never auto-created", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    const result = await authorizeGoogleUser("stranger@example.com");
    expect(result).toEqual({ ok: false, reason: "UNKNOWN_EMAIL" });
    // Confirm no account was created as a side effect.
    expect(accounts).toHaveLength(3);
  });

  it("matches case-insensitively and tolerates surrounding whitespace, without confusing two similarly-named accounts", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    const result = await authorizeGoogleUser("  SARAH.MITCHELL@COMPASSTOOLS.DEV  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.account.id).toBe("acct-agent");
  });

  it("§24: Google authentication success alone never grants access — this function only ever accepts a plain verified-email string, never a client-supplied 'trust me' flag or object", async () => {
    const { authorizeGoogleUser } = await import("../google-authorization");
    // There is no parameter shape by which a caller could assert
    // "already authorized" without an email that actually resolves to a
    // real, active Account — an unknown email is always denied regardless
    // of what the (nonexistent, not-yet-built) calling OAuth layer claims.
    const result = await authorizeGoogleUser("admin@fake-imposter.example.com");
    expect(result.ok).toBe(false);
  });
});
