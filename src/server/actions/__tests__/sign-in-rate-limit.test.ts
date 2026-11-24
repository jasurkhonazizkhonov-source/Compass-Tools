import { describe, it, expect, vi, beforeEach } from "vitest";

// Failed Google sign-ins are limited per client IP, and ONLY failures count: a refused client is turned away before anything else happens (no call to Google, no database
// write, nothing about accounts), a server problem never uses up anyone's allowance, and a shared office that signs in successfully is never held up.
const h = vi.hoisted(() => ({
  peek: vi.fn(),
  record: vi.fn(),
  verify: vi.fn(),
  authorize: vi.fn(),
  bootstrap: vi.fn(),
  establish: vi.fn(),
  failed: vi.fn(),
}));

vi.mock("@/server/security/rate-limit", () => ({
  peekPublicRateLimitFromRequest: h.peek,
  recordPublicRateLimitUse: h.record,
  describeWait: (s: number) => (s < 90 ? `${s} seconds` : `${Math.ceil(s / 60)} minutes`),
  RATE_LIMITS: { SIGN_IN_FAILURES: { windowMs: 900_000, maxAttempts: 15 } },
}));
vi.mock("@/server/auth/verify-google-token", () => ({ verifyGoogleIdTokenForSignIn: h.verify }));
vi.mock("@/server/auth/google-authorization", () => ({ authorizeGoogleUser: h.authorize }));
vi.mock("@/server/auth/initial-admin-bootstrap", () => ({ bootstrapInitialAdminIfEligible: h.bootstrap }));
vi.mock("@/server/auth/establish-session", () => ({ establishSession: h.establish }));
vi.mock("@/server/auth/failed-sign-in", () => ({ recordFailedSignIn: h.failed }));
vi.mock("@/server/auth/google-login-binding", () => ({ readBindingNonce: vi.fn(async () => "nonce"), clearBinding: vi.fn(async () => undefined), ensureBindingNonce: vi.fn(async () => "nonce") }));

const OK_IDENTITY = { email: "agent@example.com", name: "Agent" };

beforeEach(() => {
  vi.clearAllMocks();
  h.peek.mockResolvedValue({ allowed: true });
  h.record.mockResolvedValue(undefined);
  h.verify.mockResolvedValue(OK_IDENTITY);
  h.bootstrap.mockResolvedValue({ outcome: "not_applicable" });
  h.authorize.mockResolvedValue({ ok: true, account: { id: "acct-1" } });
  h.establish.mockResolvedValue(undefined);
});

describe("sign-in failures are limited per client, failures only", () => {
  it("a client over its allowance is refused FIRST: Google is not called, nothing is written, nothing about accounts is said, and it is told when to retry", async () => {
    h.peek.mockResolvedValue({ allowed: false, retryAfterSeconds: 420 });
    const { signInWithGoogle } = await import("../google-auth");
    const result = await signInWithGoogle("token");
    expect(result).toEqual({ ok: false, reason: "RATE_LIMITED", retryAfterSeconds: 420, message: "Too many failed sign-in attempts. Please try again in 7 minutes." });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.establish).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled(); // being refused does not use up more of the allowance
  });

  it("a SUCCESSFUL sign-in is never counted (a shared office signing in all morning is never blocked)", async () => {
    const { signInWithGoogle } = await import("../google-auth");
    for (let i = 0; i < 50; i++) expect(await signInWithGoogle("token")).toEqual({ ok: true });
    expect(h.record).not.toHaveBeenCalled();
  });

  it.each([
    ["a token Google did not accept", () => h.verify.mockResolvedValue(null), "GOOGLE_VERIFICATION_FAILED"],
    ["an identity with no CRM account", () => h.authorize.mockResolvedValue({ ok: false, reason: "UNKNOWN_EMAIL" }), "ACCESS_DENIED"],
    ["a disabled account", () => h.authorize.mockResolvedValue({ ok: false, reason: "ACCOUNT_DISABLED" }), "ACCESS_DENIED"],
    ["an uninitialised CRM", () => h.bootstrap.mockResolvedValue({ outcome: "not_initialized" }), "NOT_INITIALIZED"],
    ["the wrong initial-admin identity", () => h.bootstrap.mockResolvedValue({ outcome: "email_mismatch" }), "BOOTSTRAP_EMAIL_MISMATCH"],
  ])("%s counts as ONE failure for this client", async (_name, arrange, reason) => {
    arrange();
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("token")).toMatchObject({ ok: false, reason });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith("SIGN_IN_FAILURES", { windowMs: 900_000, maxAttempts: 15 });
  });

  it("a SERVER problem (database down) never uses up anyone's allowance", async () => {
    h.authorize.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("token")).toMatchObject({ ok: false, reason: "SERVER_ERROR" });
    spy.mockRestore();
    expect(h.record).not.toHaveBeenCalled();
  });

  it("a counter that cannot be read does not turn sign-in into an error: the attempt proceeds normally", async () => {
    h.peek.mockRejectedValue(new Error("db down"));
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("token")).toEqual({ ok: true });
  });
});
