import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises sendViaGmail() end-to-end against mocked Prisma, mocked
// OAuth2Client (never a real network call to Google's token endpoint), and
// a mocked global fetch (never a real call to the Gmail API) — proving the
// not-connected / revoked / access-token-refresh-failure / API-failure /
// success paths, and that a refresh-token invalidation is detected and
// persisted so the UI can show "Reconnect Gmail" without a repeat failure.

type FakeConnection = {
  accountId: string;
  googleEmail: string;
  scopes: string[];
  encryptedRefreshToken: string;
  status: "CONNECTED" | "REVOKED";
};

let connections: Map<string, FakeConnection>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gmailConnection: {
      findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => connections.get(accountId) ?? null),
      update: vi.fn(async ({ where: { accountId }, data }: { where: { accountId: string }; data: Partial<FakeConnection> & { revokedAt?: Date } }) => {
        const existing = connections.get(accountId);
        if (!existing) throw new Error("not found");
        Object.assign(existing, data);
        return existing;
      }),
    },
  },
}));

vi.mock("@/server/auth/google-config", () => ({
  getGoogleClientId: () => "test-client-id",
  getGoogleClientSecret: () => "test-client-secret",
}));

vi.mock("@/server/security/gmail-token-encryption", () => ({
  decryptRefreshToken: (encoded: string) => encoded.replace(/^ENC:/, ""),
}));

const getAccessToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(function () {
    return { setCredentials: vi.fn(), getAccessToken };
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  connections = new Map();
  vi.clearAllMocks();
});

function seedConnection(overrides: Partial<FakeConnection> = {}) {
  connections.set("acct-1", {
    accountId: "acct-1",
    googleEmail: "david.chen@compasstools.dev",
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    encryptedRefreshToken: "ENC:refresh-token-value",
    status: "CONNECTED",
    ...overrides,
  });
}

const BASE_INPUT = { accountId: "acct-1", to: "customer@example.com", subject: "Your quote", html: "<p>hi</p>" };

describe("sendViaGmail — connection state", () => {
  it("returns NOT_CONNECTED when the account has never connected Gmail", async () => {
    const { sendViaGmail } = await import("../gmail-send");
    const result = await sendViaGmail(BASE_INPUT);
    expect(result).toEqual({ ok: false, code: "NOT_CONNECTED", error: expect.stringContaining("Connect Gmail") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns REAUTH_REQUIRED immediately for a REVOKED connection, without attempting a token refresh", async () => {
    seedConnection({ status: "REVOKED" });
    const { sendViaGmail } = await import("../gmail-send");
    const result = await sendViaGmail(BASE_INPUT);
    expect(result).toEqual({ ok: false, code: "REAUTH_REQUIRED", error: expect.stringContaining("reconnect") });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendViaGmail — access token refresh failures", () => {
  it("invalid_grant during refresh marks the connection REVOKED and returns REAUTH_REQUIRED", async () => {
    seedConnection();
    getAccessToken.mockRejectedValue(new Error("invalid_grant: Token has been expired or revoked."));
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result).toEqual({ ok: false, code: "REAUTH_REQUIRED", error: expect.stringContaining("reconnect") });
    expect(connections.get("acct-1")!.status).toBe("REVOKED");
  });

  it("a non-invalid_grant refresh failure (network error) does NOT mark the connection revoked", async () => {
    seedConnection();
    getAccessToken.mockRejectedValue(new Error("network timeout"));
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result).toEqual({ ok: false, code: "SEND_FAILED", error: expect.any(String) });
    expect(connections.get("acct-1")!.status).toBe("CONNECTED");
  });
});

describe("sendViaGmail — Gmail API response handling", () => {
  it("successfully sends: POSTs to Gmail's messages.send with a Bearer token and base64url raw MIME, returns the Gmail message id", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "fresh-access-token" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "gmail-msg-123" }) });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail({ ...BASE_INPUT, senderName: "David Chen", replyTo: "david.chen@compasstools.dev" });

    expect(result).toEqual({ ok: true, messageId: "gmail-msg-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer fresh-access-token");

    const body = JSON.parse(options.body);
    // base64url: no '+', '/', or '=' padding characters.
    expect(body.raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(body.raw, "base64url").toString("utf8");
    expect(decoded).toContain("From: David Chen <david.chen@compasstools.dev>");
    expect(decoded).toContain("Reply-To: david.chen@compasstools.dev");
    expect(decoded).toContain("Subject: Your quote");
  });

  it("uses the connected Gmail address as the display name when no senderName is given", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "id-1" }) });
    const { sendViaGmail } = await import("../gmail-send");

    await sendViaGmail(BASE_INPUT);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const decoded = Buffer.from(body.raw, "base64url").toString("utf8");
    // MIME builders collapse "x <x>" to plain "x" when the display name
    // equals the address — the address itself is what matters here.
    expect(decoded).toMatch(/^From: david\.chen@compasstools\.dev/m);
  });

  it("a 401 response marks the connection REVOKED and returns REAUTH_REQUIRED", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { status: "UNAUTHENTICATED" } }) });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REAUTH_REQUIRED");
    expect(connections.get("acct-1")!.status).toBe("REVOKED");
  });

  it("a 403 insufficientPermissions response marks REVOKED and returns REAUTH_REQUIRED (scope was reduced/revoked)", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { errors: [{ reason: "insufficientPermissions" }] } }),
    });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REAUTH_REQUIRED");
    expect(connections.get("acct-1")!.status).toBe("REVOKED");
  });

  it("a 429 rate-limit response returns SEND_FAILED with a user-friendly message and does NOT mark revoked", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: { errors: [{ reason: "rateLimitExceeded" }] } }) });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result).toEqual({ ok: false, code: "SEND_FAILED", error: expect.stringContaining("rate limit") });
    expect(connections.get("acct-1")!.status).toBe("CONNECTED");
  });

  it("a generic 500 response returns a generic SEND_FAILED without exposing raw API error details", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: "Internal error: stack trace xyz" } }) });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SEND_FAILED");
      expect(result.error).not.toContain("stack trace");
    }
  });

  it("a thrown network error calling fetch itself returns SEND_FAILED", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEND_FAILED");
  });
});

describe("sendViaGmail — security", () => {
  it("never includes the refresh or access token anywhere in the returned result", async () => {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "super-secret-access-token" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "id-1" }) });
    const { sendViaGmail } = await import("../gmail-send");

    const result = await sendViaGmail(BASE_INPUT);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-access-token");
    expect(serialized).not.toContain("refresh-token-value");
  });
});

describe("sendViaGmail — Bcc recipients reach the raw message", () => {
  async function rawOf(input: Parameters<typeof import("../gmail-send").sendViaGmail>[0]) {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "m" }) });
    const { sendViaGmail } = await import("../gmail-send");
    await sendViaGmail(input);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    return Buffer.from(body.raw, "base64url").toString("utf8");
  }

  it("keeps the Bcc header (Gmail delivers to exactly what the raw message names — nodemailer drops it by default)", async () => {
    const raw = await rawOf({ ...BASE_INPUT, bcc: "a@example.com, b@example.com" });
    expect(raw).toMatch(/^Bcc: .*a@example\.com/im);
    expect(raw).toContain("b@example.com");
  });

  it("accepts the Bcc list as separate addresses (an array), not only one joined string", async () => {
    const raw = await rawOf({ ...BASE_INPUT, bcc: ["a@example.com", "b@example.com", "c@example.com"] });
    for (const addr of ["a@example.com", "b@example.com", "c@example.com"]) expect(raw).toContain(addr);
    expect(raw).toMatch(/^Bcc:/im);
  });

  it("a message without a Bcc list has no Bcc header at all", async () => {
    const raw = await rawOf(BASE_INPUT);
    expect(raw).not.toMatch(/^Bcc:/im);
  });
});

describe("sendViaGmail — RFC 8058 one-click unsubscribe headers (marketing mail)", () => {
  async function rawOf(input: Parameters<typeof import("../gmail-send").sendViaGmail>[0]) {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "m" }) });
    const { sendViaGmail } = await import("../gmail-send");
    await sendViaGmail(input);
    const body = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    return Buffer.from(body.raw, "base64url").toString("utf8");
  }

  it("a marketing message carries List-Unsubscribe (the recipient's own https URL) and List-Unsubscribe-Post: List-Unsubscribe=One-Click", async () => {
    const raw = await rawOf({ ...BASE_INPUT, listUnsubscribeUrl: "https://crm.example.test/api/public/unsubscribe?token=abc123" });
    expect(raw).toMatch(/^List-Unsubscribe:\s*<https:\/\/crm\.example\.test\/api\/public\/unsubscribe\?token=abc123>\s*$/im); // the header may be folded onto the next line
    expect(raw).toMatch(/^List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click\s*$/im);
  });

  it("an ordinary (non-marketing) message has neither header", async () => {
    const raw = await rawOf(BASE_INPUT);
    expect(raw).not.toMatch(/^List-Unsubscribe/im);
  });

  it("a URL that is not plain https, or that could break out of the header, is never put in a header (the message goes without the pair)", async () => {
    for (const bad of ["http://crm.example.test/u?token=a", "javascript:alert(1)", "https://x.test/u>\r\nBcc: attacker@example.test", "https://x.test/u with space", "https://x.test/u<script>"]) {
      const raw = await rawOf({ ...BASE_INPUT, listUnsubscribeUrl: bad });
      expect(raw, bad).not.toMatch(/^List-Unsubscribe/im);
      expect(raw, bad).not.toMatch(/^Bcc:\s*attacker/im);
    }
  });
});

describe("sendViaGmail — the provider's answers a campaign worker must tell apart", () => {
  async function send(response: { ok: boolean; status?: number; json?: () => Promise<unknown> } | Error) {
    seedConnection();
    getAccessToken.mockResolvedValue({ token: "t" });
    if (response instanceof Error) fetchMock.mockRejectedValue(response);
    else fetchMock.mockResolvedValue(response);
    const { sendViaGmail } = await import("../gmail-send");
    return sendViaGmail(BASE_INPUT);
  }
  const loadIsRateLimitError = async () => (await import("@/server/marketing/campaign-worker")).isRateLimitError;

  it.each([
    ["403 rateLimitExceeded (user sending quota)", 403, "rateLimitExceeded"],
    ["403 userRateLimitExceeded", 403, "userRateLimitExceeded"],
    ["403 dailyLimitExceeded", 403, "dailyLimitExceeded"],
    ["403 quotaExceeded", 403, "quotaExceeded"],
    ["429", 429, undefined],
  ])("%s is a definite, retry-later quota answer: never a revoked connection, never ambiguous, and recognised by the worker as a rate limit", async (_label, status, reason) => {
    const result = await send({ ok: false, status, json: async () => ({ error: { errors: reason ? [{ reason }] : [] } }) });
    expect(result).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect((result as { ambiguous?: boolean }).ambiguous).toBeUndefined();
    expect(connections.get("acct-1")!.status).toBe("CONNECTED");
    expect((await loadIsRateLimitError())((result as { error: string }).error)).toBe(true);
  });

  it.each([500, 502, 503, 504])("a %i from Gmail is AMBIGUOUS (it may have queued the message): the worker must hold it as uncertain, never re-send it", async (status) => {
    const result = await send({ ok: false, status, json: async () => ({}) });
    expect(result).toMatchObject({ ok: false, code: "SEND_FAILED", ambiguous: true });
  });

  it("a timeout / reset connection (no answer) is AMBIGUOUS", async () => {
    const result = await send(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  it("a 4xx rejection (for example an invalid recipient) is a definite failure, not ambiguous", async () => {
    const result = await send({ ok: false, status: 400, json: async () => ({ error: { errors: [{ reason: "invalidArgument" }], message: "Invalid To header" } }) });
    expect(result).toMatchObject({ ok: false, code: "SEND_FAILED" });
    expect((result as { ambiguous?: boolean }).ambiguous).toBeUndefined();
  });

  it("LOST RESPONSE AFTER ACCEPTANCE: a 2xx whose body cannot be read is still a success (the message is gone; reporting a failure would make a retry send it twice)", async () => {
    const result = await send({ ok: true, json: async () => { throw new Error("socket closed while reading the body"); } });
    expect(result).toEqual({ ok: true, messageId: "accepted-without-id" });
  });
});
