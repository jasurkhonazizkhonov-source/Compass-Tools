import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The Gmail "Connect" OAuth callback — a real Route Handler Google
// redirects the browser to with ?code&state (or ?error on cancel). Proves:
// CSRF state validation, that a session-expired-mid-flow visitor is sent
// to /login (never silently trusted), that a granted email mismatched
// against the signed-in CRM account's own email is rejected without
// storing anything, and that a successful connect encrypts the refresh
// token before persisting it (never stores the raw value).

let cookieJar: Map<string, string>;
let currentAccount: { id: string; email: string } | null;
let connections: Map<string, { accountId: string; googleEmail: string; scopes: string[]; encryptedRefreshToken: string; status: string }>;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    delete: (name: string) => cookieJar.delete(name),
  })),
}));

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentAccount),
}));

type ConnectionWrite = { googleEmail: string; scopes: string[]; encryptedRefreshToken: string; status: string; revokedAt?: Date | null };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gmailConnection: {
      upsert: vi.fn(async ({ where: { accountId }, create, update }: { where: { accountId: string }; create: ConnectionWrite & { accountId: string }; update: ConnectionWrite }) => {
        const existing = connections.get(accountId);
        const row = existing ? { ...existing, ...update } : { ...create, connectedAt: new Date() };
        connections.set(accountId, row);
        return row;
      }),
    },
  },
}));

const getToken = vi.fn();
vi.mock("@/server/auth/gmail-oauth-config", () => ({
  getGmailOAuth2Client: () => ({ getToken }),
}));

const verifyGoogleIdToken = vi.fn();
vi.mock("@/server/auth/verify-google-token", () => ({
  verifyGoogleIdToken: (...args: [string]) => verifyGoogleIdToken(...args),
}));

vi.mock("@/server/security/gmail-token-encryption", () => ({
  encryptRefreshToken: (token: string) => `ENC:${token}`,
}));

beforeEach(() => {
  cookieJar = new Map([["gmail_oauth_state", "expected-state-value"]]);
  currentAccount = { id: "acct-1", email: "david.chen@compasstools.dev" };
  connections = new Map();
  vi.clearAllMocks();
});

function makeRequest(query: string) {
  return new NextRequest(`http://localhost:3000/api/auth/gmail/callback${query}`);
}

describe("Gmail OAuth callback", () => {
  it("user declined consent on Google's screen: redirects to /dashboard?gmail=cancelled, no token exchange attempted", async () => {
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?error=access_denied"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=cancelled");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("missing state entirely: redirects with gmail=error, no token exchange", async () => {
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("state does not match the cookie: rejected as a CSRF mismatch, no token exchange", async () => {
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=attacker-supplied-state"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("clears the state cookie regardless of outcome", async () => {
    const { GET } = await import("../route");
    await GET(makeRequest("?code=abc&state=wrong"));
    expect(cookieJar.has("gmail_oauth_state")).toBe(false);
  });

  it("valid state but no CRM session (expired mid-flow): sent to /login, not silently trusted", async () => {
    currentAccount = null;
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("token exchange throws: redirects with gmail=error, stores nothing", async () => {
    getToken.mockRejectedValue(new Error("invalid_grant"));
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(connections.size).toBe(0);
  });

  it("no refresh_token in the response (should not happen with access_type=offline, but handled defensively): rejected, stores nothing", async () => {
    getToken.mockResolvedValue({ tokens: { id_token: "idt", scope: "gmail.send" } });
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(connections.size).toBe(0);
  });

  it("no id_token in the response: rejected (cannot verify which account was granted), stores nothing", async () => {
    getToken.mockResolvedValue({ tokens: { refresh_token: "rt", scope: "gmail.send" } });
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(connections.size).toBe(0);
  });

  it("id_token fails verification: rejected, stores nothing", async () => {
    getToken.mockResolvedValue({ tokens: { refresh_token: "rt", id_token: "bad-idt", scope: "gmail.send" } });
    verifyGoogleIdToken.mockResolvedValue(null);
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=error");
    expect(connections.size).toBe(0);
  });

  it("granted Gmail account does NOT match the signed-in CRM account's own email: rejected as a mismatch, stores nothing", async () => {
    getToken.mockResolvedValue({ tokens: { refresh_token: "rt", id_token: "idt", scope: "gmail.send" } });
    verifyGoogleIdToken.mockResolvedValue({ email: "someone.else@gmail.com" });
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=mismatch");
    expect(connections.size).toBe(0);
  });

  it("matches case-insensitively — different casing of the same address is accepted, not treated as a mismatch", async () => {
    getToken.mockResolvedValue({ tokens: { refresh_token: "rt", id_token: "idt", scope: "gmail.send" } });
    verifyGoogleIdToken.mockResolvedValue({ email: "David.Chen@CompassTools.dev" });
    const { GET } = await import("../route");
    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=connected");
  });

  it("success: stores the connection with the refresh token ENCRYPTED, never the raw value, and redirects with gmail=connected", async () => {
    getToken.mockResolvedValue({
      tokens: { refresh_token: "raw-refresh-token-value", id_token: "idt", scope: "https://www.googleapis.com/auth/gmail.send openid email" },
    });
    verifyGoogleIdToken.mockResolvedValue({ email: "david.chen@compasstools.dev" });
    const { GET } = await import("../route");

    const response = await GET(makeRequest("?code=abc&state=expected-state-value"));

    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard?gmail=connected");
    const stored = connections.get("acct-1")!;
    // The mocked encryptRefreshToken() prefixes with "ENC:" — proves the
    // route calls the encryption function rather than storing tokens.refresh_token verbatim.
    expect(stored.encryptedRefreshToken).toBe("ENC:raw-refresh-token-value");
    expect(stored.googleEmail).toBe("david.chen@compasstools.dev");
    expect(stored.scopes).toEqual(["https://www.googleapis.com/auth/gmail.send", "openid", "email"]);
    expect(stored.status).toBe("CONNECTED");
  });

  it("a reconnect (existing REVOKED connection) is upgraded back to CONNECTED with the new token", async () => {
    connections.set("acct-1", { accountId: "acct-1", googleEmail: "david.chen@compasstools.dev", scopes: [], encryptedRefreshToken: "ENC:old-token", status: "REVOKED" });
    getToken.mockResolvedValue({ tokens: { refresh_token: "new-refresh-token", id_token: "idt", scope: "gmail.send" } });
    verifyGoogleIdToken.mockResolvedValue({ email: "david.chen@compasstools.dev" });
    const { GET } = await import("../route");

    await GET(makeRequest("?code=abc&state=expected-state-value"));

    const stored = connections.get("acct-1")!;
    expect(stored.status).toBe("CONNECTED");
    expect(stored.encryptedRefreshToken).toBe("ENC:new-refresh-token");
  });
});
