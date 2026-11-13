import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// logo-processing.ts loads the native `sharp` addon on FIRST USE, not at import. The module sits on the server's start-up path
// (instrumentation -> task notifications -> company queries), so a native library that cannot load on a host (a platform binary or
// libvips file missing from a traced Docker image) must only break logo processing, never server start.

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("sharp");
  vi.restoreAllMocks();
});

describe("sharp is loaded lazily", () => {
  it("importing the module does not load sharp (a broken native library cannot stop the server from starting)", async () => {
    const loads = vi.fn();
    vi.doMock("sharp", () => {
      loads();
      throw new Error("native library unavailable");
    });
    const mod = await import("../logo-processing");
    expect(typeof mod.processLogo).toBe("function");
    expect(loads).not.toHaveBeenCalled();
  });

  it("when sharp cannot load, validation reports a clear error instead of throwing", async () => {
    vi.doMock("sharp", () => {
      throw new Error("ERR_DLOPEN_FAILED");
    });
    const { validateLogoUpload } = await import("../logo-processing");
    const result = await validateLogoUpload(Buffer.from("not empty"));
    expect(result).toEqual({ ok: false, error: "Image processing is not available on this server." });
  });

  it("when sharp cannot load, processLogo rejects (callers already treat a failed logo as 'no logo') and the failure is retried, not cached", async () => {
    let attempts = 0;
    vi.doMock("sharp", () => {
      attempts += 1;
      throw new Error("ERR_DLOPEN_FAILED");
    });
    const { processLogo } = await import("../logo-processing");
    await expect(processLogo(Buffer.from("x"))).rejects.toThrow();
    await expect(processLogo(Buffer.from("x"))).rejects.toThrow();
    expect(attempts).toBe(2);
  });

  it("with the real library it still validates and processes an image exactly as before", async () => {
    const sharp = (await import("sharp")).default;
    // A 64x64 opaque white square with a black 24x24 block in the middle: a flat backdrop, so the background heuristic applies.
    const block = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#000000" } }).png().toBuffer();
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } })
      .composite([{ input: block, left: 20, top: 20 }])
      .png()
      .toBuffer();

    const { validateLogoUpload, processLogo } = await import("../logo-processing");
    expect(await validateLogoUpload(png)).toMatchObject({ ok: true, format: "png", width: 64, height: 64 });
    const processed = await processLogo(png);
    expect(processed.original).toBe(png);
    expect(processed.transparencyApplied).toBe(true);
    for (const variant of [processed.email, processed.web, processed.icon]) {
      expect((await sharp(variant).metadata()).format).toBe("png");
    }
  });
});
