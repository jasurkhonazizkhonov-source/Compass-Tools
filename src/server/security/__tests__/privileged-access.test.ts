import { describe, it, expect, afterEach, vi } from "vitest";

describe("requireRecentAuthentication / requireMfa", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("in development (no APP_ENV/NODE_ENV=production), reports NOT_AVAILABLE_IN_DEVELOPMENT and allows through", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "test");
    const { requireRecentAuthentication, requireMfa } = await import("../privileged-access");
    expect(requireRecentAuthentication()).toEqual({ ok: true, note: "NOT_AVAILABLE_IN_DEVELOPMENT" });
    expect(requireMfa()).toEqual({ ok: true, note: "NOT_AVAILABLE_IN_DEVELOPMENT" });
  });

  it("fails closed in production (APP_ENV=production) — never fakes success", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { requireRecentAuthentication, requireMfa } = await import("../privileged-access");
    expect(requireRecentAuthentication()).toEqual({ ok: false, reason: "MFA_REQUIRED_NOT_CONFIGURED" });
    expect(requireMfa()).toEqual({ ok: false, reason: "MFA_REQUIRED_NOT_CONFIGURED" });
  });

  it("fails closed when NODE_ENV=production and APP_ENV is unset", async () => {
    vi.stubEnv("APP_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    const { requireRecentAuthentication } = await import("../privileged-access");
    expect(requireRecentAuthentication().ok).toBe(false);
  });

  it("APP_ENV=development is NOT an escape hatch: a production NODE_ENV still fails closed", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "production");
    const { requireRecentAuthentication, requireRecentLogin } = await import("../privileged-access");
    expect(requireRecentAuthentication().ok).toBe(false);
    expect(requireRecentLogin(undefined).ok).toBe(false);
  });
});

describe("requireRecentLogin (Reveal step-up)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("outside production-class environments it passes through explicitly (no real sign-in exists locally)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const { requireRecentLogin } = await import("../privileged-access");
    expect(requireRecentLogin(null)).toEqual({ ok: true, note: "NOT_AVAILABLE_IN_DEVELOPMENT" });
  });

  it("in production it requires a sign-in within the window — by session creation time", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } = await import("../privileged-access");
    const now = Date.now();
    expect(requireRecentLogin(new Date(now - 60_000), now)).toEqual({ ok: true });
    expect(requireRecentLogin(new Date(now - RECENT_LOGIN_WINDOW_MS), now).ok).toBe(true);
    expect(requireRecentLogin(new Date(now - RECENT_LOGIN_WINDOW_MS - 1), now)).toEqual({ ok: false, reason: "RECENT_LOGIN_REQUIRED" });
    expect(requireRecentLogin(new Date(now - 24 * 3600_000), now).ok).toBe(false);
    expect(requireRecentLogin(null, now).ok).toBe(false);
    expect(requireRecentLogin(undefined, now).ok).toBe(false);
    // a session "created in the future" (clock skew / tampering) is not accepted as recent
    expect(requireRecentLogin(new Date(now + 60_000), now).ok).toBe(false);
  });

  it("applies regardless of how the vault was enabled (APP_ENV / CARD_VAULT_MODE do not relax it)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "staging");
    vi.stubEnv("CARD_VAULT_MODE", "application-encryption-risk-accepted");
    const { requireRecentLogin } = await import("../privileged-access");
    expect(requireRecentLogin(new Date(Date.now() - 3600_000)).ok).toBe(false);
  });
});
