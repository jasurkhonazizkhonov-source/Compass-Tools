import { describe, it, expect, beforeAll, afterAll } from "vitest";

// The presigned URL is the contract between our server, the browser and Cloudflare R2, so its SHAPE is pinned down here with the real
// AWS signer (offline — nothing is sent anywhere): which headers are signed (a browser can only send a few), the expiry, the path, and
// that no SDK-added checksum header sneaks in (R2 does not implement them and a browser would never send them).
const saved = { ...process.env };

describe("presigned upload / download URLs (real signer, offline)", () => {
  let storage: typeof import("../r2");
  beforeAll(async () => {
    process.env.R2_ACCOUNT_ID = "acct123";
    process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
    process.env.R2_SECRET_ACCESS_KEY = "not-a-real-secret";
    process.env.R2_BUCKET_NAME = "crm-files";
    process.env.R2_REGION = "auto";
    delete process.env.R2_ENDPOINT;
    storage = await import("../r2");
  });
  afterAll(() => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_REGION", "R2_ENDPOINT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const KEY = "companies/default-company/leads/lead1234567/attachments/0b9c1d52-aaaa-bbbb-cccc-1234567890ab/0123456789abcdef0123456789abcdef";

  it("PUT: path-style URL on the R2 endpoint, 5-minute expiry, SigV4 for region auto / service s3", async () => {
    const { url, expiresInSeconds } = await storage.objectStorage.presignUpload(KEY, "application/pdf", 12345);
    const u = new URL(url);
    expect(u.origin).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/crm-files/${KEY}`);
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(expiresInSeconds).toBe(300);
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("PUT: only headers a browser sends are signed — content-type, content-length and host", async () => {
    const { url } = await storage.objectStorage.presignUpload(KEY, "application/pdf", 12345);
    const signed = (new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").sort();
    expect(signed).toEqual(["content-length", "content-type", "host"]);
    // Nothing the browser would have to send as a header / that R2 does not implement: no flexible-checksum, ACL, metadata or session-token
    // parameters, and the payload is not hashed (UNSIGNED-PAYLOAD is a query parameter of the URL itself, not a request header).
    const params = new URL(url).searchParams;
    const q = [...params.keys()].join(" ").toLowerCase();
    expect(q).not.toMatch(/checksum|x-amz-acl|x-amz-meta|x-amz-security-token|x-amz-sdk/);
    expect(params.get("X-Amz-Content-Sha256") ?? "UNSIGNED-PAYLOAD").toBe("UNSIGNED-PAYLOAD");
  });

  it("the signature depends on the type and length the server validated (a different file can't reuse the URL)", async () => {
    const a = new URL((await storage.objectStorage.presignUpload(KEY, "application/pdf", 100)).url).searchParams.get("X-Amz-Signature");
    const b = new URL((await storage.objectStorage.presignUpload(KEY, "application/pdf", 101)).url).searchParams.get("X-Amz-Signature");
    const c = new URL((await storage.objectStorage.presignUpload(KEY, "image/png", 100)).url).searchParams.get("X-Amz-Signature");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("GET: 60-second URL that forces the served type and disposition", async () => {
    const url = await storage.objectStorage.presignDownload(KEY, { contentType: "application/pdf", contentDisposition: 'inline; filename="a.pdf"' });
    const u = new URL(url);
    expect(u.pathname).toBe(`/crm-files/${KEY}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(u.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(u.searchParams.get("response-content-disposition")).toBe('inline; filename="a.pdf"');
    expect((u.searchParams.get("X-Amz-SignedHeaders") ?? "")).toBe("host");
  });

  it("an endpoint pasted WITH the bucket path still yields a correct URL (bucket not doubled)", async () => {
    process.env.R2_ENDPOINT = "https://acct123.r2.cloudflarestorage.com/crm-files";
    const { url } = await storage.objectStorage.presignUpload(KEY, "application/pdf", 10);
    expect(new URL(url).pathname).toBe(`/crm-files/${KEY}`);
    delete process.env.R2_ENDPOINT;
  });

  it("values pasted with quotes still produce a valid configuration", async () => {
    process.env.R2_BUCKET_NAME = '"crm-files"';
    process.env.R2_ACCESS_KEY_ID = " 'AKIDEXAMPLE' ";
    const { url } = await storage.objectStorage.presignUpload(KEY, "application/pdf", 10);
    expect(new URL(url).pathname).toBe(`/crm-files/${KEY}`);
    expect(new URL(url).searchParams.get("X-Amz-Credential")).toMatch(/^AKIDEXAMPLE\//);
    process.env.R2_BUCKET_NAME = "crm-files";
    process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  });
});
