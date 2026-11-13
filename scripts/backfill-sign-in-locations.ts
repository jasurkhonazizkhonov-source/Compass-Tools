// Fills in the approximate location for accounts whose LAST sign-in has an IP address but no location (everything signed in before the
// local geolocation database was installed). Read docs/GEOIP.md first.
//
//   npx tsx scripts/backfill-sign-in-locations.ts            DRY RUN (default): prints counts only, writes nothing, prints no addresses
//   npx tsx scripts/backfill-sign-in-locations.ts --apply    performs the update
//   --limit <n>                                              touch at most n accounts (default 500)
//
// Safe by construction: it only ever fills EMPTY location fields of an account that already has a stored IP; it never changes the IP,
// the sign-in time, the session, or a location that is already there; each distinct address is looked up once; a lookup that finds
// nothing leaves the account exactly as it was. The data model keeps ONE last sign-in per account, so the work is at most one row
// per user. It uses DATABASE_URL like the app does - point it at the intended database deliberately; against production it needs
// your explicit go-ahead.
import { prisma } from "../src/lib/prisma";
import { lookupIpLocation } from "../src/server/geo/ip-geolocation";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("--limit must be a whole number between 1 and 100000");

  const total = await prisma.account.count();
  const candidates = await prisma.account.findMany({
    where: { lastSignInIp: { not: null }, lastSignInCity: null, lastSignInRegion: null, lastSignInCountry: null, lastSignInCountryCode: null },
    select: { id: true, lastSignInIp: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  const withIp = await prisma.account.count({ where: { lastSignInIp: { not: null } } });

  const byIp = new Map<string, Awaited<ReturnType<typeof lookupIpLocation>>>();
  const reasons: Record<string, number> = {};
  let resolvable = 0;
  let updated = 0;
  for (const c of candidates) {
    const ip = c.lastSignInIp!;
    if (!byIp.has(ip)) byIp.set(ip, await lookupIpLocation(ip));
    const found = byIp.get(ip)!;
    if (found.status !== "resolved") {
      reasons[found.reason] = (reasons[found.reason] ?? 0) + 1;
      continue;
    }
    resolvable++;
    if (!apply) continue;
    const l = found.location;
    // Guarded again in SQL: a row that gained a location (or lost its IP) since the read above is left alone.
    updated += await prisma.$executeRaw`
      UPDATE "Account" SET
        "lastSignInCity" = ${l.city}, "lastSignInRegion" = ${l.region ?? l.regionCode}, "lastSignInCountry" = ${l.country},
        "lastSignInCountryCode" = ${l.countryCode}, "lastSignInTimeZone" = ${l.timeZone},
        "lastSignInLocationSource" = ${found.source}, "lastSignInLocationAt" = ${new Date()}
      WHERE "id" = ${c.id} AND "lastSignInIp" = ${ip}
        AND "lastSignInCity" IS NULL AND "lastSignInRegion" IS NULL AND "lastSignInCountry" IS NULL AND "lastSignInCountryCode" IS NULL`;
  }

  console.log(apply ? "APPLIED" : "DRY RUN - nothing was written");
  console.log(`accounts: ${total}; with a stored sign-in IP: ${withIp}; with an IP but no location (examined, limit ${limit}): ${candidates.length}`);
  console.log(`distinct addresses looked up: ${byIp.size}; resolvable: ${resolvable}${apply ? `; updated: ${updated}` : ""}`);
  if (Object.keys(reasons).length > 0) console.log(`not resolvable, by reason: ${JSON.stringify(reasons)}`);
  if (!apply && resolvable > 0) console.log("Re-run with --apply to write these locations.");
}

main()
  .catch((error) => {
    console.error(`backfill-sign-in-locations: ${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
