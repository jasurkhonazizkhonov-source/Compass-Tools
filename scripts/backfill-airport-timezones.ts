// One-off backfill for Airport.timezone on an existing database whose
// airports were seeded before this column was populated (prisma/seed.ts
// now populates it for any FUTURE fresh seed — this script is only for
// bringing an already-seeded database up to date). See src/lib/flight-duration.ts
// for why Airport.timezone exists: timezone-aware flight duration
// calculation needs each airport's real IANA zone, not just its lat/long.
//
// Run once: npx tsx scripts/backfill-airport-timezones.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import tzlookup from "tz-lookup";
import { PrismaClient } from "../src/generated/prisma/client";

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

function timezoneFromCoords(latitude: number | null, longitude: number | null): string | null {
  if (latitude == null || longitude == null) return null;
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return null;
  }
}

async function main() {
  const adapter = new PrismaPg({
    connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL!),
    ssl: { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });

  const airports = await prisma.airport.findMany({
    where: { timezone: null, latitude: { not: null }, longitude: { not: null } },
    select: { id: true, latitude: true, longitude: true },
  });

  console.log(`Backfilling timezone for ${airports.length} airports...`);

  // Group by resolved timezone first so this is a handful of bulk
  // updateMany() calls instead of one round trip per airport (9000+
  // individual awaits against a remote DB would be needlessly slow).
  const idsByTimezone = new Map<string, number[]>();
  let skipped = 0;
  for (const airport of airports) {
    const timezone = timezoneFromCoords(airport.latitude, airport.longitude);
    if (!timezone) {
      skipped++;
      continue;
    }
    const ids = idsByTimezone.get(timezone) ?? [];
    ids.push(airport.id);
    idsByTimezone.set(timezone, ids);
  }

  let updated = 0;
  for (const [timezone, ids] of idsByTimezone) {
    const res = await prisma.airport.updateMany({ where: { id: { in: ids } }, data: { timezone } });
    updated += res.count;
  }

  console.log(`Done: ${updated} airports updated across ${idsByTimezone.size} distinct timezones, ${skipped} skipped (coordinates outside any known timezone boundary).`);
  await prisma.$disconnect();
}

main();
