import { describe, it, expect, vi, beforeEach } from "vitest";

// "Can this account's Gmail send right now?" - every distinct answer, and what a send does when the result is not known. Mocked Prisma, mocked OAuth client
// (no call to Google), mocked fetch (no call to Gmail): nothing leaves the process and no real account is used.

type FakeConnection = { accountId: string; googleEmail: string; scopes: string[]; encryptedRefreshToken: string; status: "CONNECTED" | "REVOKED" };
let connections: Map<string, FakeConnection>;
const revoked: string[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gmailConnection: {
      findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => connections.get(accountId) ?? null),
      update: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => {
        revoked.push(accountId);
        const c = connections.get(accountId);
        if (c) c.status = "REVOKED";
        return c;
      }),
    },
  },
}));
let configOk = true;
vi.mock("@/server/auth/google-config", () => ({
  getGoogleClientId: () => {
    if (!configOk) throw new Error("GOOGLE_CLIENT_ID is not configured");
    return "test-client-id";
  },
  getGoogleClientSecret: () => "test-client-secret",
}));
let decryptOk = true;
vi.mock("@/server/security/gmail-token-encryption", () => ({
  decryptRefreshToken: (encoded: string) => {
    if (!decryptOk) throw new Error("bad key");
    return encoded.replace(/^ENC:/, "");
  },
}));
const getAccessToken = vi.fn();
vi.mock("google-auth-library", () => ({ OAuth2Client: vi.fn().mockImplementation(function () { return { setCredentials: vi.fn(), getAccessToken }; }) }));
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
function seed(over: Partial<FakeConnection> = {}, id = "acct-1") {
  connections.set(id, { accountId: id, googleEmail: "agent@example.com", scopes: [SEND_SCOPE], encryptedRefreshToken: "ENC:refresh", status: "CONNECTED", ...over });
}
beforeEach(() => {
  connections = new Map();
  revoked.length = 0;
  configOk = true;
  decryptOk = true;
  vi.clearAllMocks();
  getAccessToken.mockResolvedValue({ token: "access-token" });
});

describe("checkGmailSendReadiness - the distinct situations", () => {
  it("Gmail disconnected: NOT_CONNECTED (no connection row at all)", async () => {
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toMatchObject({ ready: false, code: "NOT_CONNECTED" });
  });

  it("Gmail connected and usable: ready, and verified when the token service was asked", async () => {
    seed();
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toEqual({ ready: true, verified: true });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("without verification only local checks run (no call to Google) and the answer says it is unverified", async () => {
    seed();
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1")).toEqual({ ready: true, verified: false });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("revoked authorization (already marked): REAUTH_REQUIRED", async () => {
    seed({ status: "REVOKED" });
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toMatchObject({ ready: false, code: "REAUTH_REQUIRED" });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("expired / revoked at Google (invalid_grant on refresh): REAUTH_REQUIRED, and the connection is marked revoked so nobody is told it is fine", async () => {
    seed();
    getAccessToken.mockRejectedValueOnce(new Error("invalid_grant: Token has been expired or revoked."));
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toMatchObject({ ready: false, code: "REAUTH_REQUIRED" });
    expect(revoked).toEqual(["acct-1"]);
  });

  it("an authorization that can be refreshed is simply ready (the refresh happens on every check and every send)", async () => {
    seed();
    getAccessToken.mockResolvedValueOnce({ token: "fresh-access-token" });
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toEqual({ ready: true, verified: true });
    expect(revoked).toEqual([]);
  });

  it("send permission not granted: MISSING_PERMISSION, not 'not connected' and not 'expired'", async () => {
    seed({ scopes: ["openid", "email"] });
    const { checkGmailSendReadiness } = await import("../gmail-send");
    const r = await checkGmailSendReadiness("acct-1", { verifyToken: true });
    expect(r).toMatchObject({ ready: false, code: "MISSING_PERMISSION" });
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("Google's token service unavailable (network, outage): TEMPORARILY_UNAVAILABLE - NOT ready, and NOT 'reconnect', and the connection is left alone", async () => {
    seed();
    getAccessToken.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"));
    const { checkGmailSendReadiness } = await import("../gmail-send");
    const r = await checkGmailSendReadiness("acct-1", { verifyToken: true });
    expect(r).toMatchObject({ ready: false, code: "TEMPORARILY_UNAVAILABLE" });
    expect(revoked).toEqual([]);
    expect(connections.get("acct-1")!.status).toBe("CONNECTED");
  });

  it("a stored token that cannot be decrypted (key rotated) or an unconfigured OAuth client: REAUTH_REQUIRED", async () => {
    seed();
    decryptOk = false;
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toMatchObject({ ready: false, code: "REAUTH_REQUIRED" });
    decryptOk = true;
    configOk = false;
    expect(await checkGmailSendReadiness("acct-1", { verifyToken: true })).toMatchObject({ ready: false, code: "REAUTH_REQUIRED" });
  });

  it("wrong user: a connection belongs to ONE account - another account with no connection of its own is NOT_CONNECTED, whatever its neighbour has", async () => {
    seed({}, "agent-a");
    const { checkGmailSendReadiness } = await import("../gmail-send");
    expect(await checkGmailSendReadiness("agent-a", { verifyToken: true })).toEqual({ ready: true, verified: true });
    expect(await checkGmailSendReadiness("agent-b", { verifyToken: true })).toMatchObject({ ready: false, code: "NOT_CONNECTED" });
  });

  it("the answer never contains a token, key or Google address", async () => {
    seed();
    const { checkGmailSendReadiness } = await import("../gmail-send");
    for (const r of [await checkGmailSendReadiness("acct-1", { verifyToken: true }), await checkGmailSendReadiness("nobody", { verifyToken: true })]) {
      const text = JSON.stringify(r);
      expect(text).not.toMatch(/access-token|refresh|ENC:|agent@example\.com/);
    }
  });
});

describe("sendViaGmail - what is known about the outcome", () => {
  const input = { accountId: "acct-1", to: "customer@example.com", subject: "Hello", html: "<p>hi</p>" };
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("success returns the message id", async () => {
    seed();
    fetchMock.mockResolvedValueOnce(json(200, { id: "msg-1" }));
    const { sendViaGmail } = await import("../gmail-send");
    expect(await sendViaGmail(input)).toEqual({ ok: true, messageId: "msg-1" });
  });

  it("the request carries a deadline (a hung connection cannot hold a sequence worker forever)", async () => {
    seed();
    fetchMock.mockResolvedValueOnce(json(200, { id: "msg-1" }));
    const { sendViaGmail } = await import("../gmail-send");
    await sendViaGmail(input);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("Gmail ACCEPTED the message but the answer cannot be read: still a success - reporting a failure here would make a retry send it twice", async () => {
    seed();
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } });
    const { sendViaGmail } = await import("../gmail-send");
    const r = await sendViaGmail(input);
    expect(r.ok).toBe(true);
  });

  it("a timeout or dropped connection is an UNKNOWN outcome: failure + ambiguous, so the caller must not blindly resend", async () => {
    seed();
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const { sendViaGmail } = await import("../gmail-send");
    const r = await sendViaGmail(input);
    expect(r).toMatchObject({ ok: false, code: "SEND_FAILED", ambiguous: true });
  });

  it("a 5xx from Gmail is also unknown (it may have queued the message)", async () => {
    seed();
    fetchMock.mockResolvedValueOnce(json(503, { error: { status: "UNAVAILABLE" } }));
    const { sendViaGmail } = await import("../gmail-send");
    expect(await sendViaGmail(input)).toMatchObject({ ok: false, code: "SEND_FAILED", ambiguous: true });
  });

  it("definite refusals are NOT ambiguous: rate limit (429), expired authorization (401), other 4xx", async () => {
    seed();
    const { sendViaGmail } = await import("../gmail-send");
    fetchMock.mockResolvedValueOnce(json(429, { error: { errors: [{ reason: "rateLimitExceeded" }] } }));
    const limited = await sendViaGmail(input);
    expect(limited).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect((limited as { ambiguous?: boolean }).ambiguous).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json(400, { error: { status: "INVALID_ARGUMENT" } }));
    expect((await sendViaGmail(input) as { ambiguous?: boolean }).ambiguous).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json(401, {}));
    const expired = await sendViaGmail(input);
    expect(expired).toMatchObject({ ok: false, code: "REAUTH_REQUIRED" });
    expect((expired as { ambiguous?: boolean }).ambiguous).toBeUndefined();
  });

  it("when no request was made (token refresh failed, not connected) the outcome is definite, never ambiguous", async () => {
    seed();
    getAccessToken.mockRejectedValueOnce(new Error("network down"));
    const { sendViaGmail } = await import("../gmail-send");
    const r = await sendViaGmail(input);
    expect(r).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect((r as { ambiguous?: boolean }).ambiguous).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sendViaGmail({ ...input, accountId: "nobody" })).toMatchObject({ ok: false, code: "NOT_CONNECTED" });
  });
});
