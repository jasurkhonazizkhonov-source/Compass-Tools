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

// Pass 41 — real observability gap found and fixed: a real production
// report of the generic "Sign-in failed. Please try again." message could
// not previously be traced to a specific stage, because nothing between
// verifyGoogleIdToken() and the final establishSession() call was ever
// wrapped in a try/catch anywhere in the whole call chain (confirmed by
// direct inspection: zero try/catch in google-authorization.ts or
// dev-session.ts). ANY unexpected exception at ANY of those points threw
// uncaught straight through this action. These tests prove each stage is
// now individually guarded: the browser-visible result is always the same
// safe, generic SERVER_ERROR (never a thrown/rejected promise reaching the
// client, never a stack trace or DB detail) regardless of which internal
// stage actually failed.
describe("signInWithGoogle — per-stage failures resolve to a safe SERVER_ERROR, never an uncaught throw (Pass 41)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("bootstrapInitialAdminIfEligible throws (e.g. a database error on its own leading count() call): resolves SERVER_ERROR, never rejects", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "founder@example.com" });
    bootstrapInitialAdminIfEligible.mockRejectedValue(new Error("connection terminated"));
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).resolves.toEqual({ ok: false, reason: "SERVER_ERROR" });
    expect(establishSession).not.toHaveBeenCalled();
    // Never logs the raw error message (which could embed connection
    // details) — only a safe category tag.
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("INITIAL_ADMIN_BOOTSTRAP_FAILED");
    expect(loggedArgs).not.toContain("connection terminated");
  });

  it("establishSession throws after a successful bootstrap: resolves SERVER_ERROR rather than rejecting or silently claiming success", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "founder@example.com" });
    bootstrapInitialAdminIfEligible.mockResolvedValue({ outcome: "created", account: { id: "admin-1", role: "ADMIN" } });
    establishSession.mockRejectedValue(new Error("cookie write failed"));
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).resolves.toEqual({ ok: false, reason: "SERVER_ERROR" });
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("SESSION_CREATION_FAILED");
  });

  it("authorizeGoogleUser throws (e.g. a database error on its own lookup): resolves SERVER_ERROR, never rejects", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    authorizeGoogleUser.mockRejectedValue(new Error("connection terminated"));
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).resolves.toEqual({ ok: false, reason: "SERVER_ERROR" });
    expect(establishSession).not.toHaveBeenCalled();
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("DATABASE_LOOKUP_FAILED");
  });

  it("establishSession throws after normal authorization succeeds: resolves SERVER_ERROR rather than rejecting or silently claiming success", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    authorizeGoogleUser.mockResolvedValue({ ok: true, account: { id: "acct-1", role: "TRAVEL_AGENT" } });
    establishSession.mockRejectedValue(new Error("cookie write failed"));
    const { signInWithGoogle } = await import("../google-auth");

    await expect(signInWithGoogle("good-token")).resolves.toEqual({ ok: false, reason: "SERVER_ERROR" });
    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).toContain("SESSION_CREATION_FAILED");
  });

  it("never logs the ID token, even when every stage is failing", async () => {
    verifyGoogleIdToken.mockResolvedValue({ email: "agent@compasstools.dev" });
    authorizeGoogleUser.mockRejectedValue(new Error("connection terminated"));
    const { signInWithGoogle } = await import("../google-auth");

    await signInWithGoogle("super-secret-id-token-value");

    const loggedArgs = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(loggedArgs).not.toContain("super-secret-id-token-value");
  });
});
