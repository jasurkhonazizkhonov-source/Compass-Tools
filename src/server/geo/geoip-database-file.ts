// Validation and installation of the geolocation database FILE — used by `npm run geoip:*` (scripts/geoip-database.ts), never by
// a request. A new file is only ever put in place after it has been opened and proven to be a usable City database, and the
// swap is a single rename, so a failed or truncated download can never replace a working database.
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

/**
 * Validates `candidate`, then atomically makes it the database at `target`. The previous file (if any) is kept beside it as
 * `<target>.previous` so an operator can roll back by renaming. Returns what was installed.
 */
export async function installDatabaseFile(candidate: string, target: string): Promise<DatabaseInfo> {
  const info = await validateDatabaseFile(candidate);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staged = `${target}.incoming`;
  await fs.copyFile(candidate, staged);
  try {
    // The copy is what gets swapped in, so validate THAT (a disk error while copying must not install a bad file).
    await validateDatabaseFile(staged);
    try {
      await fs.copyFile(target, `${target}.previous`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rm(staged, { force: true });
    throw error;
  }
  return info;
}
