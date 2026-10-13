import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DOWNLOAD_URL_TTL_SECONDS } from "@/lib/attachments/policy";

// LEGACY storage provider: private Cloudflare R2 (S3-compatible). READ-ONLY IN PRACTICE - new uploads never touch it.
//
// Lead documents used to be uploaded to a private R2 bucket. They now go to the VPS disk (src/server/storage/local.ts), but files that
// were uploaded before the move still live in R2 and must stay openable and deletable until they are migrated or deliberately retired.
// This module exists only for those rows (Attachment.storageProvider = 'R2'). It deliberately offers only:
//   - presignDownload  open / download an existing file (a 60-second signed link, redirect from the authorised download route)
//   - remove           delete an existing file when a user deletes it, or when its lead / contact is deleted
// There is no upload, presign-upload, head or range-read here: nothing in the application can create or inspect an object in R2.
//
// Server-only: the credentials never leave this module and the browser only ever receives a short-lived link for ONE object after the
// caller was authorised for the Lead that owns it.
//
// Configuration (server environment variables; ONLY needed while R2-backed attachments exist - see docs/LEAD_ATTACHMENTS.md "Legacy R2"):
//   R2_ACCOUNT_ID          Cloudflare account id (builds the endpoint when R2_ENDPOINT is not set)
//   R2_ACCESS_KEY_ID       } an R2 API token scoped to the one bucket (Object Read is enough for downloads; delete needs Write)
//   R2_SECRET_ACCESS_KEY   }
//   R2_BUCKET_NAME         the private bucket
//   (R2_REGION and R2_ENDPOINT are optional overrides; the defaults - "auto" and the account endpoint - are what R2 uses.)

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

/** Whether the legacy R2 credentials are present. When false, existing R2-backed files cannot be opened or deleted. */
export function isLegacyR2Configured(env: Env = process.env): boolean {
  return getR2Config(env) !== null;
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
  if (!cfg) throw new StorageError("not_configured", "Legacy file storage is not configured");
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

export const legacyR2 = {
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
