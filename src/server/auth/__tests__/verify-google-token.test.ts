import { describe, it, expect, vi, beforeEach } from "vitest";

// LAYER 1 (authentication) in isolation — google-auth-library's
// OAuth2Client is mocked so this never makes a real network call to
// Google. Verifies the specific trust decisions this module is
// responsible for: require email_verified, use the configured client ID
// as the audience, and collapse every failure mode to a generic null
// rather than leaking verification error details to the caller.

const verifyIdToken = vi.fn();
vi.mock("google-auth-library", () => ({
  // Must be a real `function`, not an arrow — OAuth2Client is invoked with
  // `new`, and only a function/class expression supports vitest's
  // "explicit return value becomes the constructed instance" mock behavior.
  OAuth2Client: vi.fn().mockImplementation(function () {
    return { verifyIdToken };
  }),
}));

vi.mock("@/server/auth/google-config", () => ({
  getGoogleClientId: () => "test-client-id.apps.googleusercontent.com",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyGoogleIdToken", () => {
  it("returns the verified email when the token is valid and email_verified is true", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "agent@compasstools.dev", email_verified: true }),
    });
    const { verifyGoogleIdToken } = await import("../verify-google-token");

    const result = await verifyGoogleIdToken("valid-token");

    expect(result).toEqual({ email: "agent@compasstools.dev" });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "valid-token", audience: "test-client-id.apps.googleusercontent.com" });
  });

  it("returns null when Google reports the email as unverified — never trusted even if present", async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: "agent@compasstools.dev", email_verified: false }),
    });
    const { verifyGoogleIdToken } = await import("../verify-google-token");

    expect(await verifyGoogleIdToken("token")).toBeNull();
  });

  it("returns null when the payload has no email at all", async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => ({ email_verified: true }) });
    const { verifyGoogleIdToken } = await import("../verify-google-token");

    expect(await verifyGoogleIdToken("token")).toBeNull();
  });

  it("returns null when getPayload() itself returns nothing", async () => {
    verifyIdToken.mockResolvedValue({ getPayload: () => undefined });
    const { verifyGoogleIdToken } = await import("../verify-google-token");

    expect(await verifyGoogleIdToken("token")).toBeNull();
  });

  it("returns null (never throws) when verification itself rejects — expired token, bad signature, wrong audience, etc.", async () => {
    verifyIdToken.mockRejectedValue(new Error("Token used too late"));
    const { verifyGoogleIdToken } = await import("../verify-google-token");

    await expect(verifyGoogleIdToken("expired-token")).resolves.toBeNull();
  });
});
