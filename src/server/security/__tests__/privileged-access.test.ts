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

  it("an explicit APP_ENV=development escape hatch overrides a production NODE_ENV", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("NODE_ENV", "production");
    const { requireRecentAuthentication } = await import("../privileged-access");
    expect(requireRecentAuthentication().ok).toBe(true);
  });
});
