import { describe, it, expect, vi, beforeEach } from "vitest";

// Real defect found and fixed: sendViaGmail() documents and types itself as
// ALWAYS resolving to a GmailSendResult and never throwing — every one of
// its ~14 callers (booking creation, quote sending, cancellation, task and
// sequence notifications, marketing campaigns …) relies on that contract.
// But the two lines that build the OAuth client were the only ones in the
// function outside any try/catch, and all three calls on them can throw:
//   - getGoogleClientId() / getGoogleClientSecret() when the OAuth env vars
//     are unset,
//   - decryptRefreshToken() when GMAIL_TOKEN_ENCRYPTION_KEY is missing,
//     malformed, or (the realistic production case) has been ROTATED since
//     the connection's refresh token was encrypted, which fails AES-GCM
//     auth-tag verification.
// The throw escaped the contract, which meant crm-email.ts never wrote its
// EmailLog row (a failed send left no audit trail) and unrelated business
// operations that merely try to send a notification failed outright rather
// than degrading. These tests pin the fixed behaviour: a safe, classified
// result instead of a throw, and nothing sensitive in the logs.
//
// Kept in its own file (rather than gmail-send.test.ts) because these cases
// need the encryption/config mocks to THROW, and vi.mock factories are
// hoisted per-file — the sibling file's happy-path mocks can't express that.

type FakeConnection = {
  accountId: string;
  googleEmail: string;
  scopes: string[];
  encryptedRefreshToken: string;
  status: "CONNECTED" | "REVOKED";
};

let connections: Map<string, FakeConnection>;
let decryptImpl: (encoded: string) => string;
let clientIdImpl: () => string;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gmailConnection: {
      findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => connections.get(accountId) ?? null),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("@/server/auth/google-config", () => ({
  getGoogleClientId: () => clientIdImpl(),
  getGoogleClientSecret: () => "test-client-secret",
}));

vi.mock("@/server/security/gmail-token-encryption", () => ({
  decryptRefreshToken: (encoded: string) => decryptImpl(encoded),
}));

const getAccessToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(function () {
    return { setCredentials: vi.fn(), getAccessToken };
  }),
}));

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  connections = new Map([
    [
      "acct-1",
      {
        accountId: "acct-1",
        googleEmail: "agent@compasstools.dev",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
        encryptedRefreshToken: "ENC:refresh-token-value",
        status: "CONNECTED" as const,
      },
    ],
  ]);
  decryptImpl = (encoded: string) => encoded.replace(/^ENC:/, "");
  clientIdImpl = () => "test-client-id";
  vi.clearAllMocks();
});

const BASE_INPUT = { accountId: "acct-1", to: "customer@example.com", subject: "Your quote", html: "<p>hi</p>" };

describe("sendViaGmail — unusable credentials never throw out of the documented contract", () => {
  it("a rotated/incorrect GMAIL_TOKEN_ENCRYPTION_KEY (AES-GCM auth-tag failure) resolves to REAUTH_REQUIRED instead of throwing", async () => {
    decryptImpl = () => {
      throw new Error("Unsupported state or unable to authenticate data");
    };
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("REAUTH_REQUIRED");
      expect(result.error).toMatch(/reconnect gmail/i);
    }
  });

  it("a missing GMAIL_TOKEN_ENCRYPTION_KEY resolves to a safe result instead of throwing", async () => {
    decryptImpl = () => {
      throw new Error("Gmail token encryption is not configured");
    };
    const { sendViaGmail } = await import("../gmail-send");

    await expect(sendViaGmail(BASE_INPUT)).resolves.toMatchObject({ ok: false, code: "REAUTH_REQUIRED" });
  });

  it("unset Google OAuth client configuration resolves to a safe result instead of throwing", async () => {
    clientIdImpl = () => {
      throw new Error("GOOGLE_CLIENT_ID is not set");
    };
    const { sendViaGmail } = await import("../gmail-send");

    await expect(sendViaGmail(BASE_INPUT)).resolves.toMatchObject({ ok: false, code: "REAUTH_REQUIRED" });
  });

  it("never logs the underlying error, the refresh token, or any key material — only a safe category", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    decryptImpl = () => {
      throw new Error("Unsupported state or unable to authenticate data: refresh-token-value");
    };
    const { sendViaGmail } = await import("../gmail-send");

    await sendViaGmail(BASE_INPUT);

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("GMAIL_CREDENTIALS_UNUSABLE");
    expect(logged).not.toContain("refresh-token-value");
    expect(logged).not.toContain("Unsupported state");
    errorSpy.mockRestore();
  });

  it("the happy path is unchanged — working credentials still reach the Gmail API", async () => {
    getAccessToken.mockResolvedValue({ token: "access-token" });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: "gmail-message-id" }),
    });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result).toEqual({ ok: true, messageId: "gmail-message-id" });
  });
});
