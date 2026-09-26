import { describe, it, expect, afterEach, vi } from "vitest";
import { getAppEnvironment, isProductionEnvironment } from "../env";

function stub(env: Record<string, string>) {
  for (const k of ["APP_ENV", "VERCEL_ENV", "NODE_ENV"]) vi.stubEnv(k, env[k] ?? "");
}
afterEach(() => vi.unstubAllEnvs());

describe("getAppEnvironment — a production deployment is always identifiable as production", () => {
  it.each([
    [{ NODE_ENV: "production" }, "production"],
    [{ VERCEL_ENV: "production", NODE_ENV: "development" }, "production"],
    [{ VERCEL_ENV: "preview", NODE_ENV: "production" }, "preview"],
    [{ NODE_ENV: "development" }, "development"],
    [{ NODE_ENV: "test" }, "test"],
  ])("%j → %s", (env, expected) => {
    stub(env);
    expect(getAppEnvironment()).toBe(expected);
  });

  it("APP_ENV=production tightens any environment", () => {
    stub({ APP_ENV: "production", NODE_ENV: "development" });
    expect(getAppEnvironment()).toBe("production");
    expect(isProductionEnvironment()).toBe(true);
  });

  it("no other APP_ENV value can relax production, on a production build or on Vercel", () => {
    for (const label of ["staging", "development", "test", "preview", "local", "true", "false", "1", "PRODUCTION", " production "]) {
      stub({ APP_ENV: label, NODE_ENV: "production" });
      expect(isProductionEnvironment(), `NODE_ENV=production APP_ENV=${label}`).toBe(true);
      stub({ APP_ENV: label, VERCEL_ENV: "production", NODE_ENV: "development" });
      expect(isProductionEnvironment(), `VERCEL_ENV=production APP_ENV=${label}`).toBe(true);
    }
  });

  it("previews are production-class (they can run against real data)", () => {
    stub({ VERCEL_ENV: "preview" });
    expect(isProductionEnvironment()).toBe(true);
  });

  it("only genuine local development/test is non-production", () => {
    stub({ NODE_ENV: "development", APP_ENV: "staging" });
    expect(isProductionEnvironment()).toBe(false);
    stub({ NODE_ENV: "test" });
    expect(isProductionEnvironment()).toBe(false);
  });
});
