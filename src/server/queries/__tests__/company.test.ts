import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for the ENOENT crash fix: resolveBranding's fallback
// logo processing must never throw, never permanently cache a failure, and
// must correctly prefer a company's own uploaded logo bytes over the
// bundled static fallback. vi.resetModules() in beforeEach gives each test
// a fresh copy of company.ts's module-level cache variable, since that's
// exactly the behavior under test.

let companyRow: Record<string, unknown> | null;
let readFileShouldFail: boolean;

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => {
    if (readFileShouldFail) {
      throw Object.assign(new Error("ENOENT: no such file or directory, open 'public/logo.png'"), { code: "ENOENT" });
    }
    return Buffer.from("fake-original-logo-bytes");
  }),
}));

vi.mock("@/lib/logo-processing", () => ({
  processLogo: vi.fn(async () => ({
    original: Buffer.from("orig"),
    email: Buffer.from("fake-email-bytes"),
    web: Buffer.from("fake-web-bytes"),
    icon: Buffer.from("fake-icon-bytes"),
    transparencyApplied: false,
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: {
      findUnique: vi.fn(async () => companyRow),
    },
  },
}));

function seedCompany(overrides: Partial<Record<string, unknown>> = {}) {
  companyRow = {
    id: "c1",
    name: "Acme Travel",
    website: null,
    phone: null,
    brandColor: null,
    logoEmailUrl: null,
    logoEmailData: null,
    logoWebUrl: null,
    logoIconUrl: null,
    signatureTemplate: "sig",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  companyRow = null;
  readFileShouldFail = false;
});

describe("getCompanyById — company's own uploaded logo takes priority", () => {
  it("uses the company's own uploaded logo bytes when present, never touching the filesystem at all", async () => {
    seedCompany({ logoEmailData: Buffer.from("uploaded-bytes") });
    const fs = await import("node:fs/promises");
    const { getCompanyById } = await import("../company");

    const branding = await getCompanyById("c1");

    expect(branding.logoEmailUrl).toBe(`data:image/png;base64,${Buffer.from("uploaded-bytes").toString("base64")}`);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});

describe("getCompanyById — static fallback logo, present (Case B)", () => {
  it("resolves to a processed data: URI when no company logo is uploaded but the bundled fallback file exists", async () => {
    seedCompany();
    const { getCompanyById } = await import("../company");

    const branding = await getCompanyById("c1");

    expect(branding.logoEmailUrl).toBe(`data:image/png;base64,${Buffer.from("fake-email-bytes").toString("base64")}`);
  });
});

describe("getCompanyById — static fallback logo, missing (Case C — the ENOENT regression)", () => {
  it("resolves logoEmailUrl to null instead of throwing when the fallback file can't be read", async () => {
    seedCompany();
    readFileShouldFail = true;
    const { getCompanyById } = await import("../company");

    const branding = await getCompanyById("c1"); // must not throw

    expect(branding.logoEmailUrl).toBeNull();
  });

  it("the rest of branding stays fully usable — the CRM keeps working, only the logo is omitted", async () => {
    seedCompany({ name: "Acme Travel", brandColor: "#123456" });
    readFileShouldFail = true;
    const { getCompanyById } = await import("../company");

    const branding = await getCompanyById("c1");

    expect(branding.name).toBe("Acme Travel");
    expect(branding.brandColor).toBe("#123456");
    expect(branding.logoWebUrl).toBeTruthy(); // unaffected — never touches the filesystem
    expect(branding.logoIconUrl).toBeTruthy();
  });

  it("an orphaned/unknown company (all-null branding path) also degrades gracefully rather than crashing", async () => {
    companyRow = null;
    readFileShouldFail = true;
    const { getCompanyById } = await import("../company");

    const branding = await getCompanyById("nonexistent-id");

    expect(branding.logoEmailUrl).toBeNull();
    expect(branding.name).toBe("Compass Tools"); // FALLBACK_NAME
  });
});

describe("getCompanyById — fallback-logo caching (Section 10)", () => {
  it("does not permanently cache a failed lookup — a later call succeeds once the file becomes readable", async () => {
    seedCompany();
    readFileShouldFail = true;
    const { getCompanyById } = await import("../company");

    const first = await getCompanyById("c1");
    expect(first.logoEmailUrl).toBeNull();

    readFileShouldFail = false;
    const second = await getCompanyById("c1");
    expect(second.logoEmailUrl).toBe(`data:image/png;base64,${Buffer.from("fake-email-bytes").toString("base64")}`);
  });

  it("caches a genuine success — a second call does not re-read or reprocess the file", async () => {
    seedCompany();
    const fs = await import("node:fs/promises");
    const { getCompanyById } = await import("../company");

    await getCompanyById("c1");
    await getCompanyById("c1");

    expect(fs.readFile).toHaveBeenCalledTimes(1);
  });

  it("never caches stale per-company data — a company's own logo is re-read from the database on every call, not cached at all", async () => {
    seedCompany({ logoEmailData: Buffer.from("first-upload") });
    const { getCompanyById } = await import("../company");

    const before = await getCompanyById("c1");
    expect(before.logoEmailUrl).toBe(`data:image/png;base64,${Buffer.from("first-upload").toString("base64")}`);

    seedCompany({ logoEmailData: Buffer.from("second-upload") }); // admin re-uploads
    const after = await getCompanyById("c1");
    expect(after.logoEmailUrl).toBe(`data:image/png;base64,${Buffer.from("second-upload").toString("base64")}`);
  });
});

describe("getCompanyById — missing bundled fallback logo is a normal state, not a noisy repeated error", () => {
  // A missing OPTIONAL asset (ENOENT) must never spam the server log once
  // per request — that's exactly the "exceptional filesystem error" framing
  // this must not have. A GENUINE problem (corrupt file, permission denied)
  // is a different story and should keep surfacing.
  it("logs the missing-fallback-logo note at most once across many repeated calls, never per-request", async () => {
    seedCompany();
    readFileShouldFail = true;
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getCompanyById } = await import("../company");

    await getCompanyById("c1");
    await getCompanyById("c1");
    await getCompanyById("c1");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs a genuine (non-ENOENT) failure — e.g. a corrupt file processLogo rejects — every time it recurs, as a visible error, not silently", async () => {
    seedCompany();
    const fs = await import("node:fs/promises");
    vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES: permission denied"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getCompanyById } = await import("../company");

    await getCompanyById("c1");
    await getCompanyById("c1");

    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
