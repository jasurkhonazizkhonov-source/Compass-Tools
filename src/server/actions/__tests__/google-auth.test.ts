import { describe, it, expect, vi, beforeEach } from "vitest";

// Exercises the full signInWithGoogle() ordering: LAYER 1 (ID token
// verification) -> LAYER 0 (initial-admin bootstrap, only ever eligible on
// a zero-Account deployment) -> LAYER 2 (normal CRM authorization) -> a
// session, in that order, with a session established only when one of the
// last two layers actually resolves to a real Account. Each dependency is
// mocked independently so this proves the ORCHESTRATION, not any one
// layer's own internal logic (those have their own dedicated test files).
//
// Pass 37 — this action no longer calls next/navigation's redirect()
// internally (see google-auth.ts's own doc comment for the real bug that
// caused — a rejected, uncaught promise on the client left "Signing in…"
// stuck forever). It now always resolves to a plain, discriminated result;
// the caller (the client button) is responsible for navigating.

const verifyGoogleIdToken = vi.fn();
vi.mock("@/server/auth/verify-google-token", () => ({
  verifyGoogleIdToken: (...args: [string]) => verifyGoogleIdToken(...args),
}));

const authorizeGoogleUser = vi.fn();
vi.mock("@/server/auth/google-authorization", () => ({
  authorizeGoogleUser: (...args: [string]) => authorizeGoogleUser(...args),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

const bootstrapInitialAdminIfEligible = vi.fn();
vi.mock("@/server/auth/initial-admin-bootstrap", () => ({
  bootstrapInitialAdminIfEligible: (...args: [string, string | undefined]) => bootstrapInitialAdminIfEligible(...args),
}));

const establishSession = vi.fn();
vi.mock("@/server/actions/dev-session", () => ({
  establishSession: (...args: [string]) => establishSession(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "not_applicable" });
});

describe("signInWithGoogle — ordering and session-issuance guard", () => {
  it("ID token verification fails: returns GOOGLE_VERIFICATION_FAILED, never attempts bootstrap, authorization, or a session", async () => {
    verifyGoogleIdToken.mockResolvedValue(null);
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("bad-token");

    expect(result).toEqual({ ok: false, reason: "GOOGLE_VERIFICATION_FAILED" });
    expect(bootstrapInitialAdminIfEligible).not.toHaveBeenCalled();
    expect(authorizeGoogleUser).not.toHaveBeenCalled();
    expect(establishSession).not.toHaveBeenCalled();
  });

  it("Google verifies but the CRM denies (unknown/disabled): resolves ACCESS_DENIED, never establishes a session", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "stranger@example.com" });
    authorizeGoogleUser.mockResolvedValue({ ok: false, reason: "UNKNOWN_EMAIL" });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: false, reason: "ACCESS_DENIED" });
    expect(authorizeGoogleUser).toHaveBeenCalledWith("stranger@example.com");
    expect(establishSession).not.toHaveBeenCalled();
  });

  it("Google verifies and the CRM authorizes: establishes a session for the resolved account and resolves ok", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    authorizeGoogleUser.mockResolvedValue({ ok: true, account: { id: "acct-1", role: "TRAVEL_AGENT" } });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: true });
    expect(establishSession).toHaveBeenCalledWith("acct-1");
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

    await signInWithGoogle("good-token");

    expect(callOrder).toEqual(["verify", "authorize", "session"]);
  });

  // Pass 37 — LAYER 0 (initial-admin bootstrap) orchestration.
  it("bootstrap creates the initial admin: establishes a session for the bootstrapped account WITHOUT ever calling normal authorization", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "founder@example.com", name: "Founder" });
    bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "created", account: { id: "admin-1", role: "ADMIN" } });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: true });
    expect(bootstrapInitialAdminIfEligible).toHaveBeenCalledWith("founder@example.com", "Founder");
    expect(establishSession).toHaveBeenCalledWith("admin-1");
    expect(authorizeGoogleUser).not.toHaveBeenCalled();
  });

  it("bootstrap reports the CRM is not initialized: resolves NOT_INITIALIZED without ever calling normal authorization or establishing a session", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "anyone@example.com" });
    bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "not_initialized" });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: false, reason: "NOT_INITIALIZED" });
    expect(authorizeGoogleUser).not.toHaveBeenCalled();
    expect(establishSession).not.toHaveBeenCalled();
  });

  it("bootstrap reports an email mismatch: resolves BOOTSTRAP_EMAIL_MISMATCH without ever calling normal authorization or establishing a session", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "wrong-person@example.com" });
    bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "email_mismatch" });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: false, reason: "BOOTSTRAP_EMAIL_MISMATCH" });
    expect(authorizeGoogleUser).not.toHaveBeenCalled();
    expect(establishSession).not.toHaveBeenCalled();
  });

  it("bootstrap not applicable (accounts already exist): falls through to normal authorization exactly as before bootstrap existed", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "not_applicable" });
    authorizeGoogleUser.mockResolvedValue({ ok: true, account: { id: "acct-1", role: "TRAVEL_AGENT" } });
    const { signInWithGoogle } = await import("../google-auth");

    const result = await signInWithGoogle("good-token");

    expect(result).toEqual({ ok: true });
    expect(authorizeGoogleUser).toHaveBeenCalledWith("agent@compasstools.dev");
    expect(establishSession).toHaveBeenCalledWith("acct-1");
  });
});
