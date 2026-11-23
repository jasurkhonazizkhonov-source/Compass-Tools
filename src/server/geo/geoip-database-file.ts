// Validation and installation of the geolocation database FILE - used by `npm run geoip:*` (scripts/geoip-database.ts), never by
// a request. A new file is only ever put in place after it has been opened and proven to be a usable City database, and the
// swap is a single rename, so a failed or truncated download can never replace a working database.
//
// What protects the database that is serving today (all of it covered by geoip-database-file.test.ts):
//   - the candidate is validated, copied next to the target under a name only this process uses, and validated AGAIN as a copy before anything is swapped;
//   - the previous file is kept beside the new one as `<target>.previous` (roll back by renaming it);
//   - a candidate that is OLDER than the installed database, or less than half its size, is refused unless the operator says so explicitly;
//   - two updates cannot run at once: an exclusive lock file (`<target>.lock`) is held for the whole install, and a lock left by a crashed run expires after 30 minutes.
import { promises as fs } from "node:fs";
import path from "node:path";
import { open } from "maxmind";
import type { CityResponse } from "mmdb-lib";

export type DatabaseInfo = {
  databaseType: string;
  builtAt: Date;
  ipVersion: number;
  nodeCount: number;
  sizeBytes: number;
  ageDays: number;
  /** Resolved for the optional sample address(es) passed to validate. */
  samples: { ip: string; found: boolean; country?: string; city?: string }[];
};

export type InstallOptions = {
  /** Allow replacing the installed database with one that was BUILT EARLIER (a deliberate rollback). */
  allowOlder?: boolean;
  /** Allow replacing it with a file less than half its size (a different, smaller edition). */
  allowSmaller?: boolean;
};

/** A lock older than this was left by a run that died; it no longer blocks. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/** Opens `file` as a MaxMind-format City database and checks it end to end. Throws a plain Error naming the problem. */
export async function validateDatabaseFile(file: string, sampleIps: string[] = []): Promise<DatabaseInfo> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  if (stat.size < 1024) throw new Error(`${file} is only ${stat.size} bytes - too small to be a geolocation database (truncated download?)`);
  const reader = await open<CityResponse>(file); // throws on a gzip file, a truncated file or anything that is not MMDB
  const md = reader.metadata;
  if (!/city/i.test(md.databaseType)) throw new Error(`database type "${md.databaseType}" is not a City database (country-only and ASN files cannot name a city)`);
  const ageDays = (Date.now() - md.buildEpoch.getTime()) / 86_400_000;
  if (ageDays < -2) throw new Error(`build date ${md.buildEpoch.toISOString()} is in the future - the file is not trustworthy`);
  const samples = sampleIps.map((ip) => {
    const r = reader.get(ip);
    return { ip, found: !!r, country: r?.country?.names?.en, city: r?.city?.names?.en };
  });
  return { databaseType: md.databaseType, builtAt: md.buildEpoch, ipVersion: md.ipVersion, nodeCount: md.nodeCount, sizeBytes: stat.size, ageDays, samples };
}

/** Takes the update lock, or throws a plain Error saying another update is running. Returns the function that releases it. */
async function acquireLock(target: string, now = Date.now()): Promise<() => Promise<void>> {
  const lock = `${target}.lock`;
  const body = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lock, "wx"); // exclusive: fails if it already exists
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      return async () => {
        await fs.rm(lock, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await fs.stat(lock).then((s) => now - s.mtimeMs, () => null);
      if (age === null) continue; // it vanished between the two calls: try again
      if (age < LOCK_STALE_MS) throw new Error("another geolocation database update is already running (lock file present); wait for it to finish");
      await fs.rm(lock, { force: true }); // a crashed run's lock: clear it and retry once
    }
  }
  throw new Error("could not take the update lock");
}

/**
 * Validates `candidate`, then atomically makes it the database at `target`. The previous file (if any) is kept beside it as
 * `<target>.previous` so an operator can roll back by renaming. Returns what was installed.
 */
export async function installDatabaseFile(candidate: string, target: string, options: InstallOptions = {}): Promise<DatabaseInfo> {
  const info = await validateDatabaseFile(candidate);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const release = await acquireLock(target);
  const staged = `${target}.incoming-${process.pid}`;
  try {
    // Compare with what is serving today. A current file that is itself unusable is not a reason to refuse a good one.
    const current = await validateDatabaseFile(target).catch(() => null);
    if (current) {
      if (!options.allowOlder && info.builtAt.getTime() < current.builtAt.getTime()) {
        throw new Error(`the new database was built ${info.builtAt.toISOString().slice(0, 10)}, earlier than the installed one (${current.builtAt.toISOString().slice(0, 10)}); it was not installed (pass --allow-older to roll back on purpose)`);
      }
      if (!options.allowSmaller && info.sizeBytes < current.sizeBytes / 2) {
        throw new Error(`the new database is ${Math.round(info.sizeBytes / 1024 / 1024)} MB, less than half the installed one (${Math.round(current.sizeBytes / 1024 / 1024)} MB); it was not installed (pass --allow-smaller if that is intended)`);
      }
    }
    await fs.copyFile(candidate, staged);
    // The copy is what gets swapped in, so validate THAT (a disk error while copying must not install a bad file).
    await validateDatabaseFile(staged);
    try {
      await fs.copyFile(target, `${target}.previous`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(staged, target);
  } finally {
    await fs.rm(staged, { force: true });
    await release();
  }
  return info;
}
