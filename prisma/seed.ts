// Seeds reference data (accounts, airports, airlines, aircraft types) from
// real open datasets — OurAirports (public domain) and OpenFlights (ODbL).
// No fabricated codes/names: rows are skipped if the source data is missing
// the fields we need.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, AccountRole } from "../src/generated/prisma/client";
import { parseAirportsCsv, parseAirlinesDat, parseAircraftDat } from "./seed-data/parse";

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

const adapter = new PrismaPg({
  connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL!),
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter });

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function seedCompany() {
  await prisma.company.upsert({
    where: { id: "default-company" },
    update: {},
    create: {
      id: "default-company",
      name: "Business Flights Travel",
      website: "https://www.businessflights.travel",
      phone: "+1 (000) 000-0000",
      brandColor: "#1c3a5e",
      signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
    },
  });
  console.log("Seeded default company");
}

async function seedAccounts() {
  const accounts: Array<{
    fullName: string;
    email: string;
    phone: string;
    role: AccountRole;
    lastSeenAt?: Date;
  }> = [
    { fullName: "Sarah Mitchell", email: "admin@compasstools.dev", phone: "+1-212-555-0101", role: "ADMIN", lastSeenAt: new Date() },
    { fullName: "David Chen", email: "david.chen@compasstools.dev", phone: "+1-212-555-0102", role: "TRAVEL_AGENT", lastSeenAt: new Date() },
    { fullName: "Maria Lopez", email: "maria.lopez@compasstools.dev", phone: "+1-212-555-0103", role: "TRAVEL_AGENT" },
    { fullName: "James Okafor", email: "james.okafor@compasstools.dev", phone: "+1-212-555-0104", role: "TICKETING_AGENT" },
    { fullName: "Priya Sharma", email: "priya.sharma@compasstools.dev", phone: "+1-212-555-0105", role: "FLIGHT_EXPERT", lastSeenAt: new Date() },
    { fullName: "Tom Bennett", email: "tom.bennett@compasstools.dev", phone: "+1-212-555-0106", role: "MANAGER" },
  ];

  for (const a of accounts) {
    await prisma.account.upsert({
      where: { email: a.email },
      update: {},
      create: { ...a, companyId: "default-company" },
    });
  }
  console.log(`Seeded ${accounts.length} accounts`);
}

async function seedAirports() {
  const rows = parseAirportsCsv();
  let inserted = 0;
  for (const batch of chunk(rows, 2000)) {
    const res = await prisma.airport.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`Seeded ${inserted} airports (from ${rows.length} parsed)`);
}

async function seedAirlines() {
  const rows = parseAirlinesDat();
  // `Airline.iata` is @unique, and migration
  // 20260901120000_airline_icao_partial_unique_index adds a matching
  // partial unique index on `icao` scoped to rows where `iata IS NULL` —
  // together these cover every airline row, so a plain skipDuplicates
  // insert is correct and idempotent across repeated runs, including
  // concurrent ones. (This function previously did its own
  // findMany-then-filter pre-check for the ICAO-only case, since the
  // database itself couldn't dedupe it — see src/server/queries/
  // reference-data.ts's seedAirlinesFromBundle for the identical
  // simplification and the full history.)
  let inserted = 0;
  for (const batch of chunk(rows, 2000)) {
    const res = await prisma.airline.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`Seeded ${inserted} airlines (from ${rows.length} parsed)`);
}

async function seedAircraft() {
  const rows = parseAircraftDat();
  let inserted = 0;
  for (const batch of chunk(rows, 2000)) {
    const res = await prisma.aircraftType.createMany({ data: batch, skipDuplicates: true });
    inserted += res.count;
  }
  console.log(`Seeded ${inserted} aircraft types (from ${rows.length} parsed)`);
}

async function main() {
  // Item 7 (database portability) — `seedCompany`/`seedAccounts` create a
  // fixed DEV-fixture company and a handful of test accounts; they are a
  // development convenience only, not part of the aviation reference-data
  // portability story (see prisma/seed-data/README.md). On a real
  // production database for a different company, run
  // `npm run db:seed:reference-data` instead of the plain `npm run
  // db:seed` — this flag lets that script skip the two fixture calls
  // without needing to hand-edit this file first.
  const referenceDataOnly = process.argv.includes("--reference-data-only");
  if (!referenceDataOnly) {
    await seedCompany();
    await seedAccounts();
  }
  await seedAirports();
  await seedAirlines();
  await seedAircraft();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
