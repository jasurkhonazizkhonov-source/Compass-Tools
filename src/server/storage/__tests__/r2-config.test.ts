import { describe, it, expect, afterEach } from "vitest";
import { getR2Config, isStorageConfigured, storageOrigin } from "../r2";
import { buildBaseCsp, buildNonceCsp } from "@/lib/csp";

const FULL = { R2_ACCOUNT_ID: "abc123", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "SECRET", R2_BUCKET_NAME: "crm-files", R2_REGION: "auto" };

describe("R2 configuration", () => {
  it("derives the S3 endpoint from the account id and defaults the region to auto", () => {
    const c = getR2Config({ ...FULL, R2_REGION: undefined });
    expect(c).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto", bucket: "crm-files", accessKeyId: "AKID", secretAccessKey: "SECRET" });
  });

  it("an explicit endpoint wins (trailing slash removed)", () => {
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "https://abc123.eu.r2.cloudflarestorage.com/" })?.endpoint).toBe("https://abc123.eu.r2.cloudflarestorage.com");
  });

  it("is unconfigured unless every required value is present", () => {
    expect(isStorageConfigured({})).toBe(false);
    for (const k of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"] as const) {
      expect(isStorageConfigured({ ...FULL, [k]: "" }), k).toBe(false);
    }
    expect(isStorageConfigured(FULL)).toBe(true);
  });

  it("never accepts a non-https endpoint (credentials must not travel in clear text)", () => {
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "http://abc123.r2.cloudflarestorage.com" })).toBeNull();
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "not a url" })).toBeNull();
  });

  it("exposes only the origin for the CSP, never a key", () => {
    expect(storageOrigin(FULL)).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(storageOrigin({})).toBeNull();
  });
});

describe("CSP connect-src follows the configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ENDPOINT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("includes the R2 origin only when storage is configured, in both policies", () => {
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCOUNT_ID;
    expect(buildBaseCsp()).not.toContain("r2.cloudflarestorage.com");
    expect(buildNonceCsp("n")).not.toContain("r2.cloudflarestorage.com");
    process.env.R2_ACCOUNT_ID = "abc123";
    expect(buildBaseCsp()).toContain("connect-src 'self' https://accounts.google.com https://www.googleapis.com https://abc123.r2.cloudflarestorage.com");
    expect(buildNonceCsp("n")).toContain("https://abc123.r2.cloudflarestorage.com");
    process.env.R2_ENDPOINT = "http://insecure.example";
    expect(buildBaseCsp()).not.toContain("insecure.example");
  });
});
