import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the full signInWithGoogle() ordering: LAYER 1 (ID token
// verification) must run and succeed before LAYER 2 (CRM authorization) is
// even attempted, and a session must never be established unless BOTH
// succeed. Each dependency is mocked independently so this test proves the
// orchestration, not any one layer's own internal logic (those already
// have their own dedicated test files).

const verifyGoogleIdToken = vi.fn();
vi.mock("@/server/auth/verify-google-token", () => ({
  verifyGoogleIdToken: (...args: [string]) => verifyGoogleIdToken(...args),
}));

const authorizeGoogleUser = vi.fn();
vi.mock("@/server/auth/google-authorization", () => ({
  authorizeGoogleUser: (...args: [string]) => authorizeGoogleUser(...args),
}));

const establishSession = vi.fn();
vi.mock("@/server/actions/dev-session", () => ({
  establishSession: (...args: [string]) => establishSession(...args),
}));

let redirectedTo: string | undefined;
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    redirectedTo = path;
    throw new Error(`NEXT_REDIRECT:${path}`); // mirrors redirect()'s real throw-to-unwind behavior
  }),
}));

beforeEach(() => {
  redirectedTo = undefined;
  vi.clearAllMocks();
});

describe("signInWithGoogle — ordering and session-issuance guard", () => {
  it("ID token verification fails: returns GOOGLE_VERIFICATION_FAILED, never calls CRM authorization or establishes a session", async () => {
    verifyGoogleIdToken.mockResolvedValue(null);
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("bad-token");

    expect(result).toEqual({ ok: false, kind: "GOOGLE_VERIFICATION_FAILED" });
    expect(authorizeGoogleUser).not.toHaveBeenCalled();
    expect(establishSession).not.toHaveBeenCalled();
    expect(redirectedTo).toBeUndefined();
  });

  it("Google verifies but the CRM denies (unknown/disabled): redirects to /access-denied, never establishes a session", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "stranger@example.com" });
    authorizeGoogleUser.mockResolvedValue({ ok: false, reason: "UNKNOWN_EMAIL" });
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).rejects.toThrow("NEXT_REDIRECT:/access-denied");

    expect(authorizeGoogleUser).toHaveBeenCalledWith("stranger@example.com");
    expect(establishSession).not.toHaveBeenCalled();
    expect(redirectedTo).toBe("/access-denied");
  });

  it("Google verifies and the CRM authorizes: establishes a session for the resolved account and redirects to /dashboard", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    authorizeGoogleUser.mockResolvedValue({ ok: true, account: { id: "acct-1", role: "TRAVEL_AGENT" } });
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).rejects.toThrow("NEXT_REDIRECT:/dashboard");

    expect(establishSession).toHaveBeenCalledWith("acct-1");
    expect(redirectedTo).toBe("/dashboard");
  });

  it("never establishes a session before authorization has actually resolved — verification and authorization both run before establishSession is called", async () => {
    const callOrder: string[] = [];
    verifyGoogleIdToken.mockImplementation(async () => {
      callOrder.push("verify");
      return { email: "agent@compasstools.dev" };
    });
    authorizeGoogleUser.mockImplementation(async () => {
      callOrder.push("authorize");
      return { ok: true, account: { id: "acct-1", role: "TRAVEL_AGENT" } };
    });
    establishSession.mockImplementation(async () => {
      callOrder.push("session");
    });
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).rejects.toThrow();

    expect(callOrder).toEqual(["verify", "authorize", "session"]);
  });
});
