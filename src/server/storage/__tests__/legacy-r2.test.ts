import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { getR2Config, isLegacyR2Configured, legacyR2 } from "../legacy-r2";
import { buildBaseCsp, buildNonceCsp } from "@/lib/csp";

// R2 is now a LEGACY, read/delete-only provider for files uploaded before the move to local storage. These tests pin down what is left
// of it (configuration, the signed download link) and prove that nothing can write to R2 or put an R2 origin in the browser's CSP.

const FULL = { R2_ACCOUNT_ID: "abc123", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "SECRET", R2_BUCKET_NAME: "crm-files", R2_REGION: "auto" };
const SRC = path.resolve(__dirname, "..", "..", "..");

describe("legacy R2 configuration", () => {
  it("derives the S3 endpoint from the account id and defaults the region to auto", () => {
    expect(getR2Config({ ...FULL, R2_REGION: undefined })).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto", bucket: "crm-files", accessKeyId: "AKID", secretAccessKey: "SECRET" });
  });

  it("an explicit endpoint wins (trailing slash removed)", () => {
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "https://abc123.eu.r2.cloudflarestorage.com/" })?.endpoint).toBe("https://abc123.eu.r2.cloudflarestorage.com");
  });

  it("is unconfigured unless every required value is present (so existing R2 files are reported unavailable, not mishandled)", () => {
    expect(isLegacyR2Configured({})).toBe(false);
    for (const k of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ACCOUNT_ID"] as const) expect(isLegacyR2Configured({ ...FULL, [k]: "" }), k).toBe(false);
    expect(isLegacyR2Configured(FULL)).toBe(true);
  });

  it("R2_REGION and R2_ENDPOINT are optional - the four credentials are all that is needed", () => {
    const { R2_REGION: _region, ...four } = FULL;
    void _region;
    expect(isLegacyR2Configured(four)).toBe(true);
  });

  it("tolerates the quotes and spaces of a pasted .env line, and a bucket path pasted onto the endpoint", () => {
    const c = getR2Config({ ...FULL, R2_BUCKET_NAME: ' "crm-files" ', R2_ACCESS_KEY_ID: "'AKID'", R2_SECRET_ACCESS_KEY: '"SECRET"', R2_ENDPOINT: '"https://abc123.r2.cloudflarestorage.com/crm-files/"' });
    expect(c).toEqual({ endpoint: "https://abc123.r2.cloudflarestorage.com", region: "auto", bucket: "crm-files", accessKeyId: "AKID", secretAccessKey: "SECRET" });
  });

  it("never accepts a non-https endpoint (credentials must not travel in clear text)", () => {
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "http://abc123.r2.cloudflarestorage.com" })).toBeNull();
    expect(getR2Config({ ...FULL, R2_ENDPOINT: "not a url" })).toBeNull();
  });
});

describe("legacy R2 signed download (real signer, offline)", () => {
  const saved = { ...process.env };
  beforeAll(() => {
    Object.assign(process.env, { R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_SECRET_ACCESS_KEY: "not-a-real-secret", R2_BUCKET_NAME: "crm-files", R2_REGION: "auto" });
    delete process.env.R2_ENDPOINT;
  });
  afterAll(() => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_REGION", "R2_ENDPOINT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  // The shape of a key written before the move - it only ever reaches R2, never the local filesystem.
  const KEY = "companies/default-company/leads/lead1234567/attachments/0b9c1d52-aaaa-bbbb-cccc-1234567890ab/0123456789abcdef0123456789abcdef";

  it("GET: 60-second path-style URL that forces the served type and disposition", async () => {
    const u = new URL(await legacyR2.presignDownload(KEY, { contentType: "application/pdf", contentDisposition: 'inline; filename="a.pdf"' }));
    expect(u.origin).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/crm-files/${KEY}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(u.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="a.pdf"');
    expect(u.searchParams.get("response-cache-control")).toBe("private, no-store");
    expect(u.searchParams.get("X-Amz-SignedHeaders") ?? "").toBe("host");
  });

  it("values pasted with quotes still produce a valid signed link", async () => {
    process.env.R2_BUCKET_NAME = '"crm-files"';
    process.env.R2_ACCESS_KEY_ID = " 'AKIDEXAMPLE' ";
    const u = new URL(await legacyR2.presignDownload(KEY, { contentType: "application/pdf", contentDisposition: "attachment" }));
    expect(u.pathname).toBe(`/crm-files/${KEY}`);
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^AKIDEXAMPLE\//);
    process.env.R2_BUCKET_NAME = "crm-files";
    process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  });

  it("a failure reaches the caller as a generic error with no credential, bucket or endpoint in it", async () => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"]) delete process.env[k];
    const err = await legacyR2.presignDownload(KEY, { contentType: "application/pdf", contentDisposition: "attachment" }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/crm-files|acct123|AKID|not-a-real-secret|cloudflarestorage/);
  });
});

describe("nothing can write to R2 any more", () => {
  it("the legacy provider exposes only signed download and delete: no upload, presign-upload, head or range-read", () => {
    expect(Object.keys(legacyR2).sort()).toEqual(["presignDownload", "remove"]);
  });

  it("the module does not even import the SDK commands that write or inspect objects", () => {
    const code = readFileSync(path.join(SRC, "server", "storage", "legacy-r2.ts"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/PutObjectCommand|HeadObjectCommand|CreateMultipartUpload|UploadPart|CopyObjectCommand/);
    expect(code).toMatch(/GetObjectCommand/);
    expect(code).toMatch(/DeleteObjectCommand/);
  });

  it("the upload action and route never reference the R2 module", () => {
    for (const f of [["server", "actions", "lead-attachments.ts"], ["app", "api", "attachments", "[id]", "upload", "route.ts"]]) {
      expect(readFileSync(path.join(SRC, ...f), "utf-8"), f.join("/")).not.toMatch(/legacy-r2|@aws-sdk|R2_/);
    }
  });
});

describe("the CSP carries no storage origin", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ENDPOINT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("connect-src is the same with or without R2 configured: uploads are same-origin", () => {
    delete process.env.R2_ENDPOINT;
    delete process.env.R2_ACCOUNT_ID;
    const without = [buildBaseCsp(), buildNonceCsp("n")];
    process.env.R2_ACCOUNT_ID = "abc123";
    process.env.R2_ENDPOINT = "https://abc123.r2.cloudflarestorage.com";
    const withR2 = [buildBaseCsp(), buildNonceCsp("n")];
    expect(withR2).toEqual(without);
    for (const csp of withR2) {
      expect(csp).not.toContain("cloudflarestorage.com");
      expect(csp).toContain("connect-src 'self' https://accounts.google.com https://www.googleapis.com;");
    }
  });
});
