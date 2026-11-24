// Complete PostgreSQL backups for the Admin "Database Backup" page.
//
// What it does: runs the PostgreSQL project's own `pg_dump` (custom format, compressed) against the application database, from this server, into a private staging directory;
// checks that the result can be read back (`pg_restore --list`) and contains the CRM's tables; records its size and SHA-256; and hands the file to the download route. The browser
// never talks to the database and never sees a connection string. Restoring is NOT done here: it is a deliberate operator procedure (docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md and
// deploy/restore-db.sh) into a NEW database, so no button in the application can overwrite the live one.
//
// Safety properties (each covered by tests):
//   - no shell: the tool is started with an argument vector, so no value is ever interpreted as a command; the file name is generated here and checked against a strict pattern
//     again before any read or delete (no path traversal);
//   - no credentials on a command line, in a log, in an error shown to the user or in the file name: the connection is passed to the tool through its environment, and every
//     message is scrubbed of anything that looks like a connection string;
//   - one backup at a time (an exclusive lock file; a lock left by a crashed run expires);
//   - the dump is written to a ".partial" file and only renamed to its final name after it passed verification, so an incomplete dump is never offered;
//   - the free disk space is checked first, a timeout stops a stuck dump, and the staged files are removed after a download, after a failure and after an hour;
//   - the dump goes to disk through the tool itself, never through this process's memory, so a large database does not need a large heap.
//
// Contents: every table of the application's PostgreSQL database (leads, contacts, users, sequences, enrollments, campaigns, subscribers, quotes, bookings, audit log, the
// migration history, ...) with indexes, constraints and sequences. EXCLUDED on purpose: the DATA of "PaymentMethodCvv" (retained security codes are destroyed 24 hours after a
// booking form is signed; a backup that kept them would keep them for as long as the backup lives) - the same rule as deploy/backup-db.sh. NOT in a database dump at all: uploaded
// documents, the .env file and its encryption keys, certificates, Cloudflare configuration, the Google OAuth credentials, and PostgreSQL roles (see the recovery guide).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDatabaseTlsMode } from "@/lib/db-tls";

export type BackupErrorCode =
  | "NOT_CONFIGURED"
  | "TOOL_MISSING"
  | "VERSION_MISMATCH"
  | "ALREADY_RUNNING"
  | "INSUFFICIENT_DISK"
  | "DUMP_FAILED"
  | "TIMEOUT"
  | "VERIFY_FAILED"
  | "NOT_FOUND";

/** An error whose message is safe to show to an Administrator: it never carries a connection string, a path outside the staging area, or a credential. */
export class BackupError extends Error {
  constructor(
    public readonly code: BackupErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BackupError";
  }
}

export type BackupInfo = {
  /** Also the file's name without its extension: "compass-20261124T101530Z-3fa9c2d1". */
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: Date;
  /** Staged files are removed after this time (or right after a complete download). */
  expiresAt: Date;
  sha256: string;
  format: string;
  pgDumpVersion: string;
  serverVersion: string;
};

export type BackupCapability = { available: true; pgDumpVersion: string; serverVersion: string } | { available: false; code: BackupErrorCode; reason: string };

export const BACKUP_FORMAT = "PostgreSQL custom format (pg_dump --format=custom, compressed)";
export const BACKUP_EXCLUDED_DATA = "PaymentMethodCvv";
/** Staged backups are removed after this long. */
export const BACKUP_TTL_MS = 60 * 60 * 1000;
/** A dump that runs longer than this is stopped. */
export const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
/** Free space required beyond the database's own size (the dump is compressed, so this is generous). */
export const BACKUP_DISK_HEADROOM_BYTES = 256 * 1024 * 1024;

const ID_PATTERN = /^compass-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const DUMP_EXT = ".dump";
const META_EXT = ".json";
const PARTIAL_EXT = ".partial";
const LOCK_NAME = "backup.lock";
const MAX_CAPTURE = 64 * 1024;

type Env = Record<string, string | undefined>;
type ChildEnv = Record<string, string | undefined>;

export function isValidBackupId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && ID_PATTERN.test(id);
}

/** Where staged backups live: BACKUP_STAGING_DIR (a dedicated volume in the Docker deployment), else a private folder under the system temp directory. */
export function backupStagingDir(env: Env = process.env): string {
  const configured = env.BACKUP_STAGING_DIR?.trim();
  return path.resolve(/*turbopackIgnore: true*/ configured || path.join(os.tmpdir(), "compass-tools-backups"));
}

/** The minimum environment a tool needs to start (and nothing else of this process's environment, which holds the application's secrets). */
const baseEnv = (): ChildEnv => {
  const keep = ["PATH", "HOME", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"];
  const out: ChildEnv = { LANG: "C.UTF-8" };
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
};

const tool = (name: "pg_dump" | "pg_restore", env: Env) => (name === "pg_dump" ? env.PG_DUMP_BIN?.trim() || "pg_dump" : env.PG_RESTORE_BIN?.trim() || "pg_restore");

/** Anything that looks like a connection string or a password assignment is replaced; used on every message that can leave this module. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text.replace(/postgres(?:ql)?:\/\/[^\s'"]*/gi, "postgresql://***");
  out = out.replace(/(password|PGPASSWORD)\s*[=:]\s*\S+/gi, "$1=***");
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The libpq environment for a DATABASE_URL: nothing on a command line, nothing logged. `cleanup` removes the temporary CA file, when one was needed. */
export async function buildPgEnvironment(databaseUrl: string | undefined, env: Env = process.env): Promise<{ env: ChildEnv; secrets: string[]; cleanup: () => Promise<void> }> {
  if (!databaseUrl) throw new BackupError("NOT_CONFIGURED", "The database connection is not configured on this server.");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new BackupError("NOT_CONFIGURED", "The database connection setting is not a valid PostgreSQL address.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new BackupError("NOT_CONFIGURED", "The database connection setting is not a PostgreSQL address.");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) throw new BackupError("NOT_CONFIGURED", "The database connection setting has no host or database name.");

  const out: ChildEnv = {
    ...baseEnv(),
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "compass-tools-backup",
  };
  if (url.username) out.PGUSER = decodeURIComponent(url.username);
  const password = url.password ? decodeURIComponent(url.password) : "";
  if (password) out.PGPASSWORD = password;

  // The same TLS decision the application itself makes for this connection (src/lib/db-tls.ts).
  let caFile: string | null = null;
  const mode = getDatabaseTlsMode(env as unknown as NodeJS.ProcessEnv);
  if (mode === "disabled") out.PGSSLMODE = "disable";
  else if (mode === "verified_system") out.PGSSLMODE = "verify-full";
  else if (mode === "verified_ca") {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pgca-"));
    caFile = path.join(dir, "ca.pem");
    await fs.writeFile(caFile, (env.DATABASE_SSL_CA ?? "").replace(/\\n/g, "\n"), { mode: 0o600 });
    out.PGSSLMODE = "verify-full";
    out.PGSSLROOTCERT = caFile;
  } else out.PGSSLMODE = "require";

  return {
    env: out,
    secrets: password ? [password] : [],
    cleanup: async () => {
      if (caFile) await fs.rm(path.dirname(caFile), { recursive: true, force: true });
    },
  };
}

type ToolResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: NodeJS.ErrnoException };

/** Starts a tool WITHOUT a shell; output is captured up to a small cap (the dump itself goes to a file named by --file, never through here). */
export function runTool(bin: string, args: string[], options: { env: ChildEnv; timeoutMs: number; cwd?: string }): Promise<ToolResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: error as NodeJS.ErrnoException });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE * 80) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, spawnError: error as NodeJS.ErrnoException }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

const majorOf = (versionText: string): number | null => {
  const m = /(\d+)(?:\.\d+)*/.exec(versionText.replace(/^.*?\)\s*/, ""));
  return m ? Number(m[1]) : null;
};

export type BackupDeps = {
  /** The server's version ("17.2") and the size of the current database in bytes; replaceable in tests. */
  databaseFacts: () => Promise<{ serverVersion: string; sizeBytes: number }>;
  /** Free bytes on the volume that holds `dir`; replaceable in tests. */
  freeBytes: (dir: string) => Promise<number>;
};

export const defaultDeps: BackupDeps = {
  databaseFacts: async () => {
    const { prisma } = await import("@/lib/prisma");
    const rows = await prisma.$queryRaw<Array<{ v: string; s: bigint }>>`SELECT current_setting('server_version') AS v, pg_database_size(current_database()) AS s`;
    return { serverVersion: String(rows[0].v), sizeBytes: Number(rows[0].s) };
  },
  freeBytes: async (dir) => {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  },
};

/** Whether a backup can be made here: the PostgreSQL client tools exist, and are not older than the server (pg_dump refuses a newer server). Never throws. */
export async function getBackupCapability(options: { env?: Env; deps?: BackupDeps } = {}): Promise<BackupCapability> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? defaultDeps;
  try {
    const r = await runTool(tool("pg_dump", env), ["--version"], { env: baseEnv(), timeoutMs: 10_000 });
    if (r.spawnError || r.code !== 0) return { available: false, code: "TOOL_MISSING", reason: "The PostgreSQL backup tool (pg_dump) is not installed in this environment." };
    const pgDumpVersion = r.stdout.trim().replace(/^pg_dump \(PostgreSQL\)\s*/, "");
    const facts = await deps.databaseFacts();
    const toolMajor = majorOf(pgDumpVersion);
    const serverMajor = majorOf(facts.serverVersion);
    if (toolMajor === null || serverMajor === null || toolMajor < serverMajor) {
      return { available: false, code: "VERSION_MISMATCH", reason: `The backup tool is PostgreSQL ${pgDumpVersion} but the database server is ${facts.serverVersion}; pg_dump cannot back up a newer server.` };
    }
    return { available: true, pgDumpVersion, serverVersion: facts.serverVersion };
  } catch {
    return { available: false, code: "DUMP_FAILED", reason: "The backup tool could not be checked right now." };
  }
}

async function acquireLock(dir: string, now: number): Promise<() => Promise<void>> {
  const lock = path.join(dir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await fs.stat(lock).then((s) => now - s.mtimeMs, () => null);
      if (age === null) continue;
      if (age < BACKUP_TIMEOUT_MS + 5 * 60_000) throw new BackupError("ALREADY_RUNNING", "A backup is already being created. Wait for it to finish, then try again.");
      await fs.rm(lock, { force: true }); // left behind by a run that died
    }
  }
  throw new BackupError("ALREADY_RUNNING", "A backup is already being created. Wait for it to finish, then try again.");
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Removes staged files that have expired, and any ".partial" left by a run that died. Never throws. */
export async function sweepStagedBackups(options: { env?: Env; now?: number } = {}): Promise<number> {
  const dir = backupStagingDir(options.env);
  const now = options.now ?? Date.now();
  let removed = 0;
  try {
    for (const name of await fs.readdir(/*turbopackIgnore: true*/ dir)) {
      const full = path.join(dir, name);
      const stat = await fs.lstat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      const stem = name.slice(0, name.length - path.extname(name).length);
      const staged = (isValidBackupId(stem) && (name.endsWith(DUMP_EXT) || name.endsWith(META_EXT))) || name.endsWith(PARTIAL_EXT);
      if (!staged) continue;
      const limit = name.endsWith(PARTIAL_EXT) ? BACKUP_TIMEOUT_MS + 10 * 60_000 : BACKUP_TTL_MS;
      if (now - stat.mtimeMs > limit) {
        await fs.rm(full, { force: true });
        removed++;
      }
    }
  } catch {
    // no staging directory yet: nothing to sweep
  }
  return removed;
}

export type CreateBackupOptions = { env?: Env; deps?: BackupDeps; now?: Date; timeoutMs?: number };

/** Creates, verifies and stages one complete backup. Throws a BackupError (safe to show) on any failure; no partial file is left behind. */
export async function createBackup(options: CreateBackupOptions = {}): Promise<BackupInfo> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? defaultDeps;
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? BACKUP_TIMEOUT_MS;
  const dir = backupStagingDir(env);

  const pg = await buildPgEnvironment(env.DATABASE_URL, env);
  let release: (() => Promise<void>) | null = null;
  let partial: string | null = null;
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await sweepStagedBackups({ env, now: now.getTime() });
    release = await acquireLock(dir, now.getTime());

    const capability = await getBackupCapability({ env, deps });
    if (!capability.available) throw new BackupError(capability.code, capability.reason);
    const facts = await deps.databaseFacts();
    const free = await deps.freeBytes(dir);
    const needed = facts.sizeBytes + BACKUP_DISK_HEADROOM_BYTES;
    if (free < needed) {
      throw new BackupError("INSUFFICIENT_DISK", `Not enough free disk space for a backup: about ${Math.ceil(needed / 1048576)} MB are needed and ${Math.floor(free / 1048576)} MB are free.`);
    }

    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const id = `compass-${stamp}-${randomBytes(4).toString("hex")}`;
    const finalPath = path.join(dir, id + DUMP_EXT);
    partial = finalPath + PARTIAL_EXT;

    const dump = await runTool(
      tool("pg_dump", env),
      ["--format=custom", "--compress=6", "--no-owner", "--no-privileges", "--lock-wait-timeout=60000", `--exclude-table-data="${BACKUP_EXCLUDED_DATA}"`, `--file=${partial}`],
      { env: pg.env, timeoutMs }
    );
    if (dump.timedOut) throw new BackupError("TIMEOUT", `The backup took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped. Nothing was kept.`);
    if (dump.spawnError || dump.code !== 0) {
      console.error(`[database-backup] pg_dump failed (exit ${dump.code}): ${redactSecrets(dump.stderr, pg.secrets)}`);
      throw new BackupError("DUMP_FAILED", "The database backup failed. Nothing was kept. Details are in the server log.");
    }
    await fs.chmod(partial, 0o600).catch(() => undefined);

    // Read it back before offering it: a file that cannot be listed, or that lacks the CRM's own tables, is not a backup.
    const listing = await runTool(tool("pg_restore", env), ["--list", partial], { env: baseEnv(), timeoutMs: 120_000 });
    const toc = listing.stdout;
    const hasAccount = /\sTABLE public "?Account"?\s/.test(toc);
    const hasMigrations = /\sTABLE public "?_prisma_migrations"?\s/.test(toc);
    const leaksCvv = new RegExp(`\\sTABLE DATA public "?${BACKUP_EXCLUDED_DATA}"?\\s`).test(toc);
    if (listing.spawnError || listing.code !== 0 || !hasAccount || !hasMigrations || leaksCvv) {
      throw new BackupError("VERIFY_FAILED", "The backup file could not be verified (it cannot be read back, is missing the CRM's tables, or contains data that must not be backed up). It was not kept.");
    }

    const sizeBytes = (await fs.stat(partial)).size;
    const sha256 = await sha256Of(partial);
    await fs.rename(partial, finalPath);
    partial = null;

    const info: BackupInfo = {
      id,
      fileName: id + DUMP_EXT,
      sizeBytes,
      createdAt: now,
      expiresAt: new Date(now.getTime() + BACKUP_TTL_MS),
      sha256,
      format: BACKUP_FORMAT,
      pgDumpVersion: capability.pgDumpVersion,
      serverVersion: capability.serverVersion,
    };
    await fs.writeFile(path.join(dir, id + META_EXT), JSON.stringify({ ...info, createdAt: info.createdAt.toISOString(), expiresAt: info.expiresAt.toISOString() }), { mode: 0o600 });
    return info;
  } finally {
    if (partial) await fs.rm(partial, { force: true }).catch(() => undefined);
    if (release) await release().catch(() => undefined);
    await pg.cleanup().catch(() => undefined);
  }
}

async function readInfo(dir: string, id: string): Promise<BackupInfo | null> {
  try {
    const dumpStat = await fs.lstat(path.join(dir, id + DUMP_EXT));
    if (!dumpStat.isFile()) return null;
    const raw = JSON.parse(await fs.readFile(path.join(dir, id + META_EXT), "utf8")) as Record<string, unknown>;
    const createdAt = new Date(String(raw.createdAt));
    if (Number.isNaN(createdAt.getTime()) || raw.id !== id || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) || raw.sizeBytes !== dumpStat.size) return null;
    return {
      id,
      fileName: id + DUMP_EXT,
      sizeBytes: dumpStat.size,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + BACKUP_TTL_MS),
      sha256: raw.sha256,
      format: typeof raw.format === "string" ? raw.format.slice(0, 120) : BACKUP_FORMAT,
      pgDumpVersion: typeof raw.pgDumpVersion === "string" ? raw.pgDumpVersion.slice(0, 40) : "",
      serverVersion: typeof raw.serverVersion === "string" ? raw.serverVersion.slice(0, 40) : "",
    };
  } catch {
    return null;
  }
}

/** The staged, verified backups that have not expired, newest first. A file whose record is missing or does not match it is not listed. */
export async function listStagedBackups(options: { env?: Env; now?: number } = {}): Promise<BackupInfo[]> {
  const env = options.env ?? process.env;
  const dir = backupStagingDir(env);
  const now = options.now ?? Date.now();
  await sweepStagedBackups({ env, now });
  let names: string[];
  try {
    names = await fs.readdir(/*turbopackIgnore: true*/ dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(DUMP_EXT)) continue;
    const id = name.slice(0, -DUMP_EXT.length);
    if (!isValidBackupId(id)) continue;
    const info = await readInfo(dir, id);
    if (info && info.expiresAt.getTime() > now) out.push(info);
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The file for a download. `id` is checked against the strict pattern and the resolved path must stay inside the staging directory; a symlink is refused. */
export async function resolveStagedBackup(id: unknown, options: { env?: Env; now?: number } = {}): Promise<{ path: string; info: BackupInfo }> {
  if (!isValidBackupId(id)) throw new BackupError("NOT_FOUND", "That backup does not exist.");
  const dir = backupStagingDir(options.env);
  const file = path.join(dir, id + DUMP_EXT);
  const resolvedDir = await fs.realpath(/*turbopackIgnore: true*/ dir).catch(() => null);
  const resolvedFile = await fs.realpath(file).catch(() => null);
  if (!resolvedDir || !resolvedFile || path.dirname(resolvedFile) !== resolvedDir) throw new BackupError("NOT_FOUND", "That backup does not exist or has expired.");
  const info = await readInfo(dir, id);
  if (!info || info.expiresAt.getTime() <= (options.now ?? Date.now())) throw new BackupError("NOT_FOUND", "That backup does not exist or has expired.");
  return { path: file, info };
}

/** Removes one staged backup (its file and its record). Returns whether anything was removed. */
export async function deleteStagedBackup(id: unknown, options: { env?: Env } = {}): Promise<boolean> {
  if (!isValidBackupId(id)) return false;
  const dir = backupStagingDir(options.env);
  let removed = false;
  for (const ext of [DUMP_EXT, META_EXT]) {
    const target = path.join(dir, id + ext);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isFile()) {
      await fs.rm(target, { force: true });
      removed = true;
    }
  }
  return removed;
}
