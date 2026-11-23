// Operator tool for the local IP-geolocation database (see docs/GEOIP.md). It changes nothing unless you run `download` or `install`,
// it never runs by itself, and it never touches the application database. Run with: npx tsx scripts/geoip-database.ts <command>
//
//   verify [file]                         Check a database file and print its type, build date and age. Add --ip <address> to try a lookup.
//   status [--target <path>]              Show the installed database and the outcome of the last update attempt (changes nothing).
//   install <file> [--target <path>] [--allow-older] [--allow-smaller]
//                                         Validate a downloaded .mmdb and atomically put it in place (previous copy kept as <target>.previous).
//   download --accept-cc-by-4.0 [--target <path>] [--month YYYY-MM] [--allow-older] [--allow-smaller]
//                                         Fetch DB-IP "IP to City Lite" from the official download host, validate it, install it.
//
// An update never replaces a working database with a bad one: the download goes to a temporary directory, the file is validated (and validated again as a copy), an older or
// much smaller file is refused unless you pass the flags above, two updates cannot run at once, and the previous file is kept. Every attempt - success or failure - is recorded
// beside the database (<target>.update.json) so System Health can show when it was last refreshed.
//
// The target defaults to $GEOIP_DB_PATH, else data/geoip/city.mmdb. DB-IP Lite needs no account or key; its licence (CC BY 4.0)
// requires crediting DB-IP.com, which the Admin Users page does. For MaxMind GeoLite2 (account + licence key + EULA) download the
// "GeoLite2 City" .mmdb yourself and use `install`.
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { geoipDatabasePath } from "../src/server/geo/ip-geolocation";
import { installDatabaseFile, validateDatabaseFile, type DatabaseInfo, type InstallOptions } from "../src/server/geo/geoip-database-file";
import { readUpdateStatus, recordUpdateAttempt } from "../src/server/geo/geoip-update-status";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const installOptions = (args: string[]): InstallOptions => ({ allowOlder: args.includes("--allow-older"), allowSmaller: args.includes("--allow-smaller") });

function print(info: DatabaseInfo) {
  console.log(`  type:       ${info.databaseType}`);
  console.log(`  built:      ${info.builtAt.toISOString().slice(0, 10)} (${Math.floor(info.ageDays)} days old)`);
  console.log(`  IP version: ${info.ipVersion === 6 ? "IPv6 tree (covers IPv4 and IPv6)" : "IPv4 only"}`);
  console.log(`  size:       ${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  for (const s of info.samples) console.log(`  lookup ${s.ip}: ${s.found ? `${s.city ?? "(no city)"}, ${s.country ?? "(no country)"}` : "no record"}`);
}

async function download(args: string[]) {
  if (!args.includes("--accept-cc-by-4.0")) {
    throw new Error("DB-IP Lite is licensed CC BY 4.0 and must be credited to DB-IP.com. Re-run with --accept-cc-by-4.0 to confirm you accept that licence (https://db-ip.com/db/download/ip-to-city-lite).");
  }
  const target = flag(args, "--target") ?? geoipDatabasePath();
  const now = new Date();
  const month = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const requested = flag(args, "--month");
  if (requested && !/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) throw new Error("--month must look like 2026-11");
  // DB-IP publishes on the 1st; early in a month the current file may not exist yet, so fall back to the previous month.
  const months = requested ? [requested] : [month(now), month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))];

  const work = await fs.mkdtemp(path.join(os.tmpdir(), "geoip-"));
  try {
    for (const m of months) {
      const url = `https://download.db-ip.com/free/dbip-city-lite-${m}.mmdb.gz`;
      console.log(`Downloading ${url}`);
      const res = await fetch(url);
      if (res.status === 404) {
        console.log(`  not published yet (404)`);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const file = path.join(work, `dbip-city-lite-${m}.mmdb`);
      await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(file));
      const info = await installDatabaseFile(file, target, installOptions(args));
      await recordUpdateAttempt(target, "success");
      console.log(`Installed ${target}`);
      print(info);
      console.log("The running application picks the new file up within a minute; no restart or rebuild is needed.");
      console.log('Attribution: "IP geolocation by DB-IP" (https://db-ip.com) - already shown on the Admin Users page.');
      return;
    }
    throw new Error(`no DB-IP Lite file found for ${months.join(" or ")}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify") {
    const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--ip") ?? geoipDatabasePath();
    const ip = flag(args, "--ip");
    console.log(`Checking ${file}`);
    print(await validateDatabaseFile(file, ip ? [ip] : []));
  } else if (command === "install") {
    const candidate = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--target");
    if (!candidate) throw new Error("usage: install <file.mmdb> [--target <path>]");
    const target = flag(args, "--target") ?? geoipDatabasePath();
    try {
      print(await installDatabaseFile(candidate, target, installOptions(args)));
    } catch (error) {
      await recordUpdateAttempt(target, "failed", error);
      throw error;
    }
    await recordUpdateAttempt(target, "success");
    console.log(`Installed ${target}`);
  } else if (command === "download") {
    const target = flag(args, "--target") ?? geoipDatabasePath();
    try {
      await download(args);
    } catch (error) {
      // A missing licence flag is a usage error, not an update attempt; everything else (network, 404 for both months, validation, refusal) is recorded.
      if (args.includes("--accept-cc-by-4.0")) await recordUpdateAttempt(target, "failed", error);
      throw error;
    }
  } else if (command === "status") {
    const target = flag(args, "--target") ?? geoipDatabasePath();
    const status = await readUpdateStatus(target);
    try {
      console.log(`Installed database (${target}):`);
      print(await validateDatabaseFile(target));
    } catch (error) {
      console.log(`  not usable: ${(error as Error).message}`);
    }
    if (!status) console.log("Last update attempt: no record (the update command has not run against this location).");
    else {
      console.log(`Last update attempt: ${status.lastOutcome} at ${status.lastAttemptAt.toISOString()}${status.lastError ? ` - ${status.lastError}` : ""}`);
      console.log(`Last successful update: ${status.lastSuccessAt ? status.lastSuccessAt.toISOString() : "never recorded"}`);
    }
  } else {
    console.log("usage: geoip-database.ts verify [file] [--ip <address>] | status [--target <path>] | install <file> [--target <path>] [--allow-older] [--allow-smaller] | download --accept-cc-by-4.0 [--target <path>] [--month YYYY-MM] [--allow-older] [--allow-smaller]");
    process.exitCode = command ? 2 : 0;
  }
}

main().catch((error) => {
  console.error(`geoip-database: ${(error as Error).message}`);
  process.exitCode = 1;
});
