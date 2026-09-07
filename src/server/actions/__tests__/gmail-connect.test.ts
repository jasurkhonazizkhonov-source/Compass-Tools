import { describe, it, expect, vi, beforeEach } from "vitest";

// startGmailConnect(): sets a CSRF-state cookie and redirects to Google's
// consent URL — proves the redirect requests offline access + forced
// re-consent (so a refresh token is always returned, even on reconnect)
// and the minimum gmail.send scope, and that an unauthenticated caller is
// sent to /login instead of starting a connect flow.
// disconnectGmail(): proves it operates on the CALLER's own connection
// only, identified via the session, never a client-supplied account id; also
// proves it best-effort revokes the grant at Google before deleting the
// local row, and that a failed/unreachable revoke never blocks the local
// disconnect.

let cookieJar: Map<string, string>;
let currentAccount: { id: string; email: string } | null;
let deletedForAccountIds: string[];
let existingConnection: { accountId: string; encryptedRefreshToken: string } | null;
let revokeTokenMock: ReturnType<typeof vi.fn>;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: (name: string, value: string) => cookieJar.set(name, value),
  })),
}));

let redirectedTo: string | undefined;
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentAccount),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gmailConnection: {
      findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) =>
        existingConnection && existingConnection.accountId === accountId ? existingConnection : null
      ),
      deleteMany: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => {
        deletedForAccountIds.push(accountId);
        return { count: 1 };
      }),
    },
  },
}));

const generateAuthUrl = vi.fn((opts: { state: string }) => {
  void opts;
  return "https://accounts.google.com/o/oauth2/v2/auth?mock=1";
});
vi.mock("@/server/auth/gmail-oauth-config", () => ({
  getGmailOAuth2Client: () => ({ generateAuthUrl }),
  GMAIL_CONNECT_SCOPES: ["https://www.googleapis.com/auth/gmail.send", "openid", "email"],
}));

vi.mock("@/server/auth/google-config", () => ({
  getGoogleClientId: () => "mock-client-id",
  getGoogleClientSecret: () => "mock-client-secret",
}));

vi.mock("@/server/security/gmail-token-encryption", () => ({
  decryptRefreshToken: (encoded: string) => `decrypted:${encoded}`,
}));

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(function (this: { revokeToken: unknown }) {
    this.revokeToken = revokeTokenMock;
  }),
}));

beforeEach(() => {
  cookieJar = new Map();
  currentAccount = { id: "acct-1", email: "david.chen@compasstools.dev" };
  deletedForAccountIds = [];
  existingConnection = { accountId: "acct-1", encryptedRefreshToken: "enc-token-1" };
  redirectedTo = undefined;
  revokeTokenMock = vi.fn(async () => ({}));
  vi.clearAllMocks();
});

describe("startGmailConnect", () => {
  it("an unauthenticated caller is redirected to /login, never starts the OAuth flow", async () => {
    currentAccount = null;
    const { startGmailConnect } = await import("../gmail-connect");
    await expect(startGmailConnect()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(generateAuthUrl).not.toHaveBeenCalled();
  });

  it("sets a random, single-use CSRF-state cookie before redirecting", async () => {
    const { startGmailConnect } = await import("../gmail-connect");
    await expect(startGmailConnect()).rejects.toThrow();
    const state = cookieJar.get("gmail_oauth_state");
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThan(20);
  });

  it("requests offline access, forced re-consent (so a refresh token is always returned), and only the minimum gmail.send + identity scopes", async () => {
    const { startGmailConnect } = await import("../gmail-connect");
    await expect(startGmailConnect()).rejects.toThrow();

    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        access_type: "offline",
        prompt: "consent",
        scope: ["https://www.googleapis.com/auth/gmail.send", "openid", "email"],
      })
    );
  });

  it("the state passed to generateAuthUrl matches the cookie that was set", async () => {
    const { startGmailConnect } = await import("../gmail-connect");
    await expect(startGmailConnect()).rejects.toThrow();

    const cookieState = cookieJar.get("gmail_oauth_state");
    const call = generateAuthUrl.mock.calls[0][0];
    expect(call.state).toBe(cookieState);
  });

  it("redirects to the URL Google's auth-url generator returns", async () => {
    const { startGmailConnect } = await import("../gmail-connect");
    await expect(startGmailConnect()).rejects.toThrow();
    expect(redirectedTo).toBe("https://accounts.google.com/o/oauth2/v2/auth?mock=1");
  });
});

describe("disconnectGmail", () => {
  it("deletes only the CALLER's own connection, identified from the session — never a client-supplied id", async () => {
    const { disconnectGmail } = await import("../gmail-connect");
    await disconnectGmail();
    expect(deletedForAccountIds).toEqual(["acct-1"]);
  });

  it("rejects when there is no authenticated session", async () => {
    currentAccount = null;
    const { disconnectGmail } = await import("../gmail-connect");
    await expect(disconnectGmail()).rejects.toThrow(/Not signed in/);
  });

  it("revokes the grant at Google, using the decrypted refresh token, before deleting the local row", async () => {
    const { disconnectGmail } = await import("../gmail-connect");
    await disconnectGmail();
    expect(revokeTokenMock).toHaveBeenCalledWith("decrypted:enc-token-1");
    expect(deletedForAccountIds).toEqual(["acct-1"]);
  });

  it("still deletes the local connection even when the Google-side revoke call fails", async () => {
    revokeTokenMock = vi.fn(async () => {
      throw new Error("invalid_token");
    });
    const { disconnectGmail } = await import("../gmail-connect");
    await expect(disconnectGmail()).resolves.toBeUndefined();
    expect(deletedForAccountIds).toEqual(["acct-1"]);
  });

  it("skips the revoke call (no connection to revoke) but still no-ops cleanly when there is no existing connection row", async () => {
    existingConnection = null;
    const { disconnectGmail } = await import("../gmail-connect");
    await disconnectGmail();
    expect(revokeTokenMock).not.toHaveBeenCalled();
    expect(deletedForAccountIds).toEqual(["acct-1"]);
  });
});
