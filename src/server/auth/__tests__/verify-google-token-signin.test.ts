import { describe, it, expect, vi, beforeEach } from "vitest";

// The sign-in button's token is checked against THIS browser's nonce (google-login-binding.ts) on top of everything verifyGoogleIdToken checks. google-auth-library is mocked, so
// this never calls Google.
const verifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(function () {
    return { verifyIdToken };
  }),
}));
vi.mock("@/server/auth/google-config", () => ({ getGoogleClientId: () => "test-client-id.apps.googleusercontent.com" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }));

beforeEach(() => vi.clearAllMocks());

const NONCE = "nonce-implied-by-this-browsers-cookie";
const payload = (over: Record<string, unknown> = {}) => ({ getPayload: () => ({ email: "agent@compasstools.dev", email_verified: true, nonce: NONCE, ...over }) });

describe("verifyGoogleIdTokenForSignIn - the token must carry this browser's nonce", () => {
  it("accepts a valid token whose nonce equals the expected one", async () => {
    verifyIdToken.mockResolvedValue(payload());
    const { verifyGoogleIdTokenForSignIn } = await import("../verify-google-token");
    expect(await verifyGoogleIdTokenForSignIn("token", NONCE)).toEqual({ email: "agent@compasstools.dev" });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "token", audience: "test-client-id.apps.googleusercontent.com" });
  });

  it.each([
    ["a different nonce", { nonce: "nonce-from-somebody-elses-browser" }],
    ["no nonce claim at all", { nonce: undefined }],
    ["an empty nonce", { nonce: "" }],
    ["a non-string nonce", { nonce: 42 }],
  ])("refuses %s (a token obtained elsewhere cannot sign this browser in)", async (_label, over) => {
    verifyIdToken.mockResolvedValue(payload(over));
    const { verifyGoogleIdTokenForSignIn } = await import("../verify-google-token");
    expect(await verifyGoogleIdTokenForSignIn("token", NONCE)).toBeNull();
  });

  it("with no expected nonce (no binding cookie) it refuses without even asking Google", async () => {
    const { verifyGoogleIdTokenForSignIn } = await import("../verify-google-token");
    for (const none of [null, undefined, ""]) expect(await verifyGoogleIdTokenForSignIn("token", none)).toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("still requires a verified email, whatever the nonce", async () => {
    verifyIdToken.mockResolvedValue(payload({ email_verified: false }));
    const { verifyGoogleIdTokenForSignIn } = await import("../verify-google-token");
    expect(await verifyGoogleIdTokenForSignIn("token", NONCE)).toBeNull();
  });

  it("an invalid signature or expired token (Google rejects it) is null; the nonce plays no part", async () => {
    verifyIdToken.mockRejectedValue(new Error("Token used too late"));
    const { verifyGoogleIdTokenForSignIn } = await import("../verify-google-token");
    expect(await verifyGoogleIdTokenForSignIn("token", NONCE)).toBeNull();
  });

  it("the plain verifyGoogleIdToken (the Gmail connection's code-exchange token, which has its own state) does not demand a nonce", async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email: "agent@compasstools.dev", email_verified: true }) });
    const { verifyGoogleIdToken } = await import("../verify-google-token");
    expect(await verifyGoogleIdToken("token")).toEqual({ email: "agent@compasstools.dev" });
  });
});
