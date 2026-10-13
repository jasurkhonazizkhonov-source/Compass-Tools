import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { isProductionEnvironment } from "@/lib/env";

// Lead documents on the VPS's own disk. Server-only: nothing here is importable from a client component, and nothing here ever returns
// or logs an absolute path - callers get opaque keys, sizes, byte streams and coarse outcomes.
//
// WHERE: UPLOAD_STORAGE_DIR. In production the default is /var/lib/compass-tools/uploads, which docker compose bind-mounts from the
// host (compose.yaml), so the files live OUTSIDE the container's writable layer and survive container recreation and image upgrades.
// Outside production the default is ./.local-uploads (git-ignored). The directory is never served: there is no static route to it -
// every byte leaves through the authorised download route (src/app/api/attachments/[id]/file/route.ts).
//
// LAYOUT:   <root>/<2 hex>/<64 hex>     one file per attachment; the 64 hex digits are 256 random bits, the 2-digit directory is their
//                                       first two characters (so no directory grows unbounded and a key can be sanity-checked).
//           <root>/.tmp/<32 hex>.part   an upload while it is being received. Never visible under a final key until complete.
// KEYS:     generated here, never from the file name, the lead, the company or the browser. A key is only ever turned into a path by
//           pathForKey(), which accepts nothing but that exact shape - there is no way to express "..", a separator, an absolute path or
//           a drive letter - and then re-checks that the result is inside the root.
// WRITES:   received into .tmp with O_EXCL and mode 0600, counted against the authorised size while streaming (never buffered whole),
//           fsynced, then published with link(2): atomic AND exclusive, so two racing uploads of one attachment cannot both win and a
//           half-written file is never visible. The caller's content check runs on the temp file before it is published.
// MODES:    directories 0700, files 0600 (owner = the application user). Not group/world readable.

// NOTE: every filesystem call below carries /*turbopackIgnore: true*/. The upload directory comes from the environment, so the bundler cannot
// know it statically and would otherwise trace (and copy into the standalone output) the whole project for each call.

export type StorageStatus = { state: "ready"; freeBytes?: number } | { state: "low_space"; freeBytes: number } | { state: "unavailable" };

export class LocalStorageError extends Error {
  constructor(public readonly kind: "not_ready" | "invalid_key" | "failed") {
    // The message is generic on purpose: it may reach a log or a response, and must never contain a path.
    super(`Local storage ${kind}`);
    this.name = "LocalStorageError";
  }
}

type Env = Record<string, string | undefined>;

export const PRODUCTION_DEFAULT_ROOT = "/var/lib/compass-tools/uploads";
export const KEY_PATTERN = /^([0-9a-f]{2})\/([0-9a-f]{64})$/;
const TEMP_DIR = ".tmp";
const TEMP_NAME = /^[0-9a-f]{32}\.part$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Keep this much disk free for PostgreSQL, logs and Docker: uploads are refused rather than filling the disk. */
export const DEFAULT_MIN_FREE_MB = 1024;
/** A single upload must finish within this long (a stalled or deliberately slow client cannot hold a file open forever). */
const UPLOAD_DEADLINE_MS = 15 * 60 * 1000;
const STATUS_CACHE_MS = 3_000;

/** Surrounding whitespace and one pair of matching quotes (a `.env` line pasted into a dashboard). */
function clean(value: string | undefined): string {
  const v = (value ?? "").trim();
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1).trim() : v;
}

const isInside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Only the error CODE is ever logged ("ENOSPC"), never a message - messages contain paths. */
const codeOf = (err: unknown): string => (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string" ? (err as { code: string }).code : "unknown");
function logFailure(op: string, err: unknown) {
  console.error(`[local-storage] ${op} failed (${codeOf(err)})`);
}

/**
 * The configured upload root, or the reason it cannot be used. The root must be an ABSOLUTE path (a relative one would silently depend on
 * the working directory), must not be the filesystem root, and - in production - must not be inside the application directory: uploads
 * belong in the persistent mount, not next to the source and not in the container's writable layer.
 */
export function resolveUploadRoot(env: Env = process.env, cwd: string = process.cwd(), production: boolean = isProductionEnvironment()): { root: string } | { problem: "misconfigured" } {
  const configured = clean(env.UPLOAD_STORAGE_DIR);
  const raw = configured || (production ? PRODUCTION_DEFAULT_ROOT : path.join(cwd, ".local-uploads"));
  if (raw.includes("\0") || !path.isAbsolute(raw)) return { problem: "misconfigured" };
  const root = path.resolve(raw);
  if (path.parse(root).root === root) return { problem: "misconfigured" };
  if (production && (root === path.resolve(cwd) || isInside(path.resolve(cwd), root))) return { problem: "misconfigured" };
  return { root };
}

function requireRoot(): string {
  const r = resolveUploadRoot();
  if ("problem" in r) throw new LocalStorageError("not_ready");
  return r.root;
}

/** The minimum free space (bytes) that must remain after an upload; UPLOAD_MIN_FREE_MB, default 1024, 0 disables the reserve. */
export function minFreeBytes(env: Env = process.env): number {
  const raw = clean(env.UPLOAD_MIN_FREE_MB);
  const n = raw === "" ? NaN : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MIN_FREE_MB) * 1024 * 1024;
}

/** A fresh opaque key: 256 random bits, laid out as "<first two hex>/<all 64 hex>". */
export function newKey(): string {
  const id = randomBytes(32).toString("hex");
  return `${id.slice(0, 2)}/${id}`;
}

export function isValidKey(key: unknown): key is string {
  if (typeof key !== "string") return false;
  const m = KEY_PATTERN.exec(key);
  return !!m && m[2].startsWith(m[1]);
}

/** The ONLY place a key becomes a path. Throws for anything that is not exactly a key this module could have generated. */
export function pathForKey(key: string, root: string = requireRoot()): string {
  if (!isValidKey(key)) throw new LocalStorageError("invalid_key");
  const full = path.join(root, key.slice(0, 2), key.slice(3));
  if (!isInside(root, full)) throw new LocalStorageError("invalid_key");
  return full;
}

// ── readiness / disk space ──────────────────────────────────────────────────────────────────────────────────────────────────
let cachedStatus: { at: number; key: string; value: StorageStatus } | null = null;
export function resetStatusCacheForTests() {
  cachedStatus = null;
}

/**
 * Whether files can be stored: the root is configured, exists (in production it is NEVER created here - a missing bind mount must show
 * up as "unavailable", not silently fill the container's writable layer), is writable, and has free space above the reserve.
 * Cached for a few seconds (the health endpoint and the lead page both call it).
 */
export async function status(): Promise<StorageStatus> {
  const resolved = resolveUploadRoot();
  if ("problem" in resolved) return { state: "unavailable" };
  const { root } = resolved;
  const key = `${root}|${process.env.UPLOAD_MIN_FREE_MB ?? ""}`;
  if (cachedStatus && cachedStatus.key === key && Date.now() - cachedStatus.at < STATUS_CACHE_MS) return cachedStatus.value;

  let value: StorageStatus;
  try {
    if (!isProductionEnvironment()) await fsp.mkdir(/*turbopackIgnore: true*/ root, { recursive: true, mode: DIR_MODE });
    const st = await fsp.stat(/*turbopackIgnore: true*/ root);
    if (!st.isDirectory()) throw new Error("not a directory");
    await fsp.access(/*turbopackIgnore: true*/ root, fs.constants.W_OK | fs.constants.X_OK);
    await fsp.mkdir(/*turbopackIgnore: true*/ path.join(root, TEMP_DIR), { recursive: true, mode: DIR_MODE });
    let freeBytes: number | undefined;
    try {
      const s = await fsp.statfs(/*turbopackIgnore: true*/ root);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      freeBytes = undefined; // free space unknown on this filesystem: do not block uploads on a check that cannot be made
    }
    value = freeBytes !== undefined && freeBytes < minFreeBytes() ? { state: "low_space", freeBytes } : { state: "ready", freeBytes };
  } catch (err) {
    logFailure("status", err);
    value = { state: "unavailable" };
  }
  cachedStatus = { at: Date.now(), key, value };
  return value;
}

/** Whether `bytes` more can be accepted while still leaving the reserve free. */
export async function hasRoomFor(bytes: number): Promise<boolean> {
  const s = await status();
  if (s.state === "unavailable") return false;
  if (s.state === "low_space") return false;
  return s.freeBytes === undefined || s.freeBytes - bytes >= minFreeBytes();
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type StoreResult =
  | { ok: true; size: number }
  | { ok: false; reason: "TOO_LARGE" | "SIZE_MISMATCH" | "SIGNATURE_MISMATCH" | "EXISTS" | "NO_SPACE" | "FAILED" };

class TooLarge extends Error {}
const PROBE_BYTES = 4096;

/**
 * Receives an upload and publishes it under `key` ONLY if it is exactly `expectedSize` bytes and `acceptHead(first bytes)` approves.
 * The body is streamed to a temp file and counted as it arrives: more than `expectedSize` bytes aborts immediately (the rest of the
 * request is never read), so a hostile or buggy client cannot consume more than the authorised size. Nothing is held in memory beyond
 * the stream's own small buffers. On ANY failure the temp file is removed and nothing is published.
 */
export async function storeUpload(
  key: string,
  body: ReadableStream<Uint8Array> | Readable,
  opts: { expectedSize: number; acceptHead: (head: Uint8Array) => boolean; signal?: AbortSignal },
): Promise<StoreResult> {
  let tmpPath: string | undefined;
  let handle: fsp.FileHandle | undefined;
  try {
    const root = requireRoot();
    const finalPath = pathForKey(key, root);
    if (!Number.isInteger(opts.expectedSize) || opts.expectedSize <= 0) return { ok: false, reason: "SIZE_MISMATCH" };

    await ensureDir(path.join(root, TEMP_DIR));
    await ensureDir(path.dirname(finalPath));
    if (await fsp.lstat(/*turbopackIgnore: true*/ finalPath).then(() => true, () => false)) return { ok: false, reason: "EXISTS" };

    tmpPath = path.join(root, TEMP_DIR, `${randomBytes(16).toString("hex")}.part`);
    // flags "wx" = O_CREAT|O_EXCL: never reuse or follow an existing name. The stream owns the descriptor and closes it when done.
    const out = fs.createWriteStream(/*turbopackIgnore: true*/ tmpPath, { flags: "wx", mode: FILE_MODE });

    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > opts.expectedSize) cb(new TooLarge());
        else cb(null, chunk);
      },
    });
    const input = body instanceof Readable ? body : Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
    const signals = [AbortSignal.timeout(UPLOAD_DEADLINE_MS), ...(opts.signal ? [opts.signal] : [])];
    await pipeline(input, counter, out, { signal: AbortSignal.any(signals) });

    if (received !== opts.expectedSize) return { ok: false, reason: "SIZE_MISMATCH" };

    // Re-open the finished temp file: check what it ACTUALLY contains (not what the client said), then force it to disk.
    handle = await fsp.open(/*turbopackIgnore: true*/ tmpPath, "r+");
    const onDisk = (await handle.stat()).size;
    if (onDisk !== opts.expectedSize) return { ok: false, reason: "SIZE_MISMATCH" };
    const head = Buffer.alloc(Math.min(PROBE_BYTES, onDisk));
    await handle.read(head, 0, head.length, 0);
    if (!opts.acceptHead(head)) return { ok: false, reason: "SIGNATURE_MISMATCH" };
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Publish: link(2) fails with EEXIST if the name is taken, so exactly one of any number of racing uploads wins.
    try {
      await fsp.link(/*turbopackIgnore: true*/ tmpPath, finalPath);
    } catch (err) {
      const code = codeOf(err);
      if (code === "EEXIST") return { ok: false, reason: "EXISTS" };
      if (!["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(code)) throw err;
      // A filesystem without hard links: fall back to an atomic rename (the existence check above still applies; it is not exclusive).
      await fsp.rename(/*turbopackIgnore: true*/ tmpPath, finalPath);
      tmpPath = undefined;
    }
    return { ok: true, size: received };
  } catch (err) {
    if (err instanceof TooLarge) return { ok: false, reason: "TOO_LARGE" };
    const code = codeOf(err);
    logFailure("write", err);
    return { ok: false, reason: code === "ENOSPC" || code === "EDQUOT" ? "NO_SPACE" : "FAILED" };
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (tmpPath) await fsp.unlink(/*turbopackIgnore: true*/ tmpPath).catch(() => {});
  }
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Creates ONE directory level, never its parents. The upload root itself must already exist (the bind mount in production): creating it
 * here would put files on the container's own disk when the mount is missing. A missing root therefore fails with ENOENT instead.
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(/*turbopackIgnore: true*/ dir, { mode: DIR_MODE });
  } catch (err) {
    if (codeOf(err) !== "EEXIST") throw err;
  }
}

/** Opens a stored file without following a symlink at the final component, and only if it is a regular file. */
async function openRegular(key: string): Promise<fsp.FileHandle | null> {
  const p = pathForKey(key);
  try {
    const handle = await fsp.open(/*turbopackIgnore: true*/ p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) {
      await handle.close();
      return null;
    }
    return handle;
  } catch (err) {
    const code = codeOf(err);
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return null;
    logFailure("open", err);
    throw new LocalStorageError("failed");
  }
}

export const localStorage = {
  /** Size of the stored file, or null when it does not exist. */
  async head(key: string): Promise<{ size: number } | null> {
    const handle = await openRegular(key);
    if (!handle) return null;
    try {
      return { size: (await handle.stat()).size };
    } finally {
      await handle.close().catch(() => {});
    }
  },

  /** The first `bytes` bytes (for signature verification), or null when the file does not exist. */
  async readHead(key: string, bytes: number): Promise<Uint8Array | null> {
    const handle = await openRegular(key);
    if (!handle) return null;
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(bytes, 1024 * 1024)));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }
  },

  /** A stream of the whole file and its size, or null when it does not exist. The handle is closed when the stream ends or is cancelled. */
  async openRead(key: string): Promise<{ stream: Readable; size: number } | null> {
    const handle = await openRegular(key);
    if (!handle) return null;
    const size = (await handle.stat()).size;
    return { stream: handle.createReadStream({ autoClose: true }), size };
  },

  /** Idempotent: deleting a file that is already gone succeeds. Any other failure throws and leaves the file where it is. */
  async remove(key: string): Promise<void> {
    const p = pathForKey(key);
    try {
      await fsp.unlink(/*turbopackIgnore: true*/ p);
    } catch (err) {
      if (codeOf(err) === "ENOENT") return;
      logFailure("delete", err);
      throw new LocalStorageError("failed");
    }
  },

  /**
   * Removes upload temp files older than `maxAgeMs` (a crashed or cut-off upload). Looks ONLY in <root>/.tmp, ONLY at regular files whose
   * name is exactly one this module creates, so it cannot touch a stored attachment or anything else. Returns how many were removed.
   */
  async sweepTempFiles(now: number, maxAgeMs: number): Promise<number> {
    let dir: string;
    try {
      dir = path.join(requireRoot(), TEMP_DIR);
    } catch {
      return 0;
    }
    let names: string[];
    try {
      names = await fsp.readdir(/*turbopackIgnore: true*/ dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!TEMP_NAME.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fsp.lstat(/*turbopackIgnore: true*/ p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
          await fsp.unlink(/*turbopackIgnore: true*/ p);
          removed++;
        }
      } catch {
        // already gone, or cannot be removed now: the next run tries again
      }
    }
    return removed;
  },
};
