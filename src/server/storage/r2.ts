import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from "@/lib/attachments/policy";

// Private Cloudflare R2 object storage (S3-compatible). Server-only: the credentials never leave this module, and the browser only ever
// receives a short-lived presigned URL for ONE object after the caller has been authorised for the Lead that owns it.
//
// Configuration (all server environment variables; see docs/LEAD_ATTACHMENTS.md):
//   R2_ACCOUNT_ID          Cloudflare account id (builds the endpoint when R2_ENDPOINT is not set)
//   R2_ACCESS_KEY_ID       } an R2 API token scoped to the one bucket, Object Read & Write
//   R2_SECRET_ACCESS_KEY   }
//   R2_BUCKET_NAME         the PRIVATE bucket
//   R2_REGION              "auto" (R2's only region)
//   R2_ENDPOINT            optional override; default https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com

export type R2Config = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };

type Env = Record<string, string | undefined>;

/**
 * Values pasted into a hosting dashboard often carry whitespace or the quotes of a `.env` line (`R2_BUCKET_NAME="files"`). A stray quote
 * silently corrupts the signature (403) or the endpoint, so surrounding whitespace and one pair of matching quotes are removed.
 */
function clean(value: string | undefined): string {
  const v = (value ?? "").trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1).trim() : v;
}

export function getR2Config(env: Env = process.env): R2Config | null {
  const accessKeyId = clean(env.R2_ACCESS_KEY_ID);
  const secretAccessKey = clean(env.R2_SECRET_ACCESS_KEY);
  const bucket = clean(env.R2_BUCKET_NAME);
  const accountId = clean(env.R2_ACCOUNT_ID);
  const rawEndpoint = clean(env.R2_ENDPOINT) || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  if (!accessKeyId || !secretAccessKey || !bucket || !rawEndpoint) return null;
  // The endpoint must be an https ORIGIN: a typo (or an injected value) must never send credentials over plain http, and a bucket path
  // pasted onto the endpoint ("…/my-bucket") is dropped — the bucket is always sent separately, so keeping it would double it in the URL.
  let endpoint: string;
  try {
    const u = new URL(rawEndpoint);
    if (u.protocol !== "https:") return null;
    endpoint = u.origin;
  } catch {
    return null;
  }
  return { endpoint, region: clean(env.R2_REGION) || "auto", bucket, accessKeyId, secretAccessKey };
}

export function isStorageConfigured(env: Env = process.env): boolean {
  return getR2Config(env) !== null;
}

/** The https origin the browser uploads to — added to the Content-Security-Policy's connect-src when storage is configured. */
export function storageOrigin(env: Env = process.env): string | null {
  const c = getR2Config(env);
  return c ? new URL(c.endpoint).origin : null;
}

export class StorageError extends Error {
  constructor(
    public readonly kind: "not_configured" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

let cached: { key: string; client: S3Client; cfg: R2Config } | null = null;

function clientAndConfig(): { client: S3Client; cfg: R2Config } {
  const cfg = getR2Config();
  if (!cfg) throw new StorageError("not_configured", "File storage is not configured");
  const key = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.region}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      cfg,
      client: new S3Client({
        region: cfg.region,
        endpoint: cfg.endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        // R2 does not implement the SDK's newer default checksum headers; only add them when an operation requires them.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 2,
        requestHandler: { requestTimeout: 15_000, connectionTimeout: 5_000 },
      }),
    };
  }
  return cached;
}

/** Wraps any SDK failure so provider details (account, bucket, request ids, stack) never reach a caller that might show them. */
function fail(op: string, err: unknown): never {
  const name = err instanceof Error ? err.name : "unknown";
  console.error(`[r2] ${op} failed (${name})`);
  throw new StorageError("failed", `Storage ${op} failed`);
}

const isMissing = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
};

export const objectStorage = {
  /** A presigned PUT for exactly this key, content type and byte length, valid for UPLOAD_URL_TTL_SECONDS. */
  async presignUpload(key: string, contentType: string, contentLength: number): Promise<{ url: string; expiresInSeconds: number }> {
    try {
      const { client, cfg } = clientAndConfig();
      const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType, ContentLength: contentLength }), {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        // Sign the type and length so the stored object can't differ from what the server validated.
        signableHeaders: new Set(["content-type", "content-length"]),
      });
      return { url, expiresInSeconds: UPLOAD_URL_TTL_SECONDS };
    } catch (err) {
      return fail("presign-upload", err);
    }
  },

  /** A presigned GET that forces the served type and disposition (so an uploaded file can never render as HTML in our origin's context). */
  async presignDownload(key: string, opts: { contentType: string; contentDisposition: string }): Promise<string> {
    try {
      const { client, cfg } = clientAndConfig();
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key, ResponseContentType: opts.contentType, ResponseContentDisposition: opts.contentDisposition, ResponseCacheControl: "private, no-store" }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
    } catch (err) {
      return fail("presign-download", err);
    }
  },

  /** Object size, or null when the object does not exist. */
  async head(key: string): Promise<{ size: number } | null> {
    try {
      const { client, cfg } = clientAndConfig();
      const r = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (err) {
      if (isMissing(err)) return null;
      return fail("head", err);
    }
  },

  /** The first `bytes` bytes of the object (for signature verification), or null when it does not exist. */
  async readHead(key: string, bytes: number): Promise<Uint8Array | null> {
    try {
      const { client, cfg } = clientAndConfig();
      const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: `bytes=0-${Math.max(0, bytes - 1)}` }));
      return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
    } catch (err) {
      if (isMissing(err)) return null;
      return fail("read", err);
    }
  },

  /** Idempotent: deleting an object that is already gone succeeds. */
  async remove(key: string): Promise<void> {
    try {
      const { client, cfg } = clientAndConfig();
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    } catch (err) {
      if (isMissing(err)) return;
      fail("delete", err);
    }
  },
};
