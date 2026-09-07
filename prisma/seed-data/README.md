# Aviation reference data — source of truth

This directory is the application-owned, version-controlled source of truth
for airline/airport/aircraft reference data used throughout the CRM
(itinerary display, quote/booking emails, the airport/airline/aircraft
search fields in the quote builder, etc.).

| File | Source | License | Rows |
|---|---|---|---|
| `airports.csv` | [OurAirports](https://ourairports.com/data/) | Public domain | ~85,900 |
| `airlines.dat` | [OpenFlights](https://openflights.org/data.php) | ODbL | ~6,100 |
| `planes.dat` | [OpenFlights](https://openflights.org/data.php) | ODbL | ~250 |

No fabricated/invented codes or names — `parse.ts` (the parsing/filtering
logic shared by every consumer of these files) skips any row missing the
fields it needs rather than inventing a placeholder.

## Why this matters for portability

`Airport`/`Airline`/`AircraftType` are real Postgres tables (see
`prisma/schema.prisma`) — `FlightSegment` has genuine, required foreign keys
into `Airport` (and nullable ones into `Airline`/`AircraftType`), so a real
Postgres row still has to exist before a flight segment can be saved. The
files in this directory remain the durable, version-controlled **original**
source of truth, independent of any one Postgres instance — but the app no
longer depends on a human remembering to seed a new database from them
before the CRM will work correctly.

## The app is self-healing — no manual seed step required

`src/server/queries/reference-data.ts` bundles a pre-filtered, pre-parsed
copy of this data as JSON (`src/data/reference/{airports,airlines,
aircraft}.json` — generated from the files in this directory via `npm run
generate:reference-json`, using the exact same `parse.ts` logic `prisma/
seed.ts` uses). Every exported lookup function in `reference-data.ts` calls
`ensureReferenceDataSeeded()` first — a memoized, once-per-server-process
guard that checks each reference table's row count and, if any table is
short of the bundled dataset, bulk-inserts the missing rows via the same
idempotent `createMany({ skipDuplicates: true })` pattern `prisma/seed.ts`
already uses.

**Practical effect**: if the CRM is ever pointed at a brand-new, completely
empty PostgreSQL database, the very first airport/airline/aircraft lookup
the running app performs (a GDS paste, an autocomplete search, a Lead's
airport field) transparently populates the reference tables from the
bundled JSON — no manual step, no risk of forgetting. An already-seeded
database pays only three fast `COUNT` queries per process and does nothing
further.

The manual CLI path (`npm run db:seed` / `npm run db:seed:reference-data`,
below) still exists and still works exactly as before — it's a convenient
way to pre-warm a database ahead of time (e.g. right after `prisma migrate
deploy`, before any real traffic hits it), but it is no longer *required*
for correctness.

```bash
npx prisma migrate deploy         # creates the schema, including Airline/Airport/AircraftType
npm run db:seed:reference-data    # optional pre-warm — populates them from the files in this directory
```

**Note:** the plain `npm run db:seed` also runs `seedCompany()` and
`seedAccounts()` first, which create a fixed dev-fixture company and a
handful of test accounts — a *development* convenience only, not part of
the aviation-portability story. `npm run db:seed:reference-data` skips
those two and seeds only the aviation reference tables.

### Regenerating the bundled JSON

If `airports.csv`/`airlines.dat`/`planes.dat` are ever updated (a newer
OurAirports/OpenFlights export), regenerate the committed JSON the app
actually reads from:

```bash
npm run generate:reference-json
```

This overwrites `src/data/reference/*.json` from the current contents of
this directory, via the shared `parse.ts` logic — the same logic both
`prisma/seed.ts` and this generator use, so there is never a second,
drifting implementation of "what counts as a useful row."

## What's still database-only

`Airline.logoUrl` has no source file here — nothing in this repo populates
it (it comes from a manual/out-of-band process, and isn't part of the
bundled JSON either). This is safe to leave database-only: a direct query
of every `Airline.logoUrl` value currently in Postgres confirmed all ~1,120
of them are byte-for-byte identical to what `src/lib/airline-logo.ts`'s
`airlineLogoUrl(iata)` CDN-URL fallback already constructs
(`https://images.kiwi.com/airlines/64x64/{IATA}.png`) — the "curated" values
were never anything other than that same deterministic function's output,
so there is nothing distinct to migrate. `src/components/crm/
airline-logo.tsx`'s boxed-code badge is a further fallback for airlines
with no IATA code at all. This was confirmed live, not just by reading the
fallback code: a genuinely fresh database (see "How this was tested"
below), where every `Airline.logoUrl` is `null`, was driven through the
real quote builder and customer-facing quote page in a browser. That test
initially turned up a real bug — one component
(`flight-itinerary-display.tsx`) read the raw `segment.airline?.logoUrl`
database column directly instead of the already-resolved value
`resolveAirlineDisplay()` computes (which applies the CDN fallback) — fixed
by reading the resolved value instead. The email-template path
(`src/server/email/segment-mapper.ts`) never had this bug. With the fix,
logo display is genuinely, not just theoretically, independent of the
current Postgres instance.

## Concurrent first-request seeding safety

Within a single Node process, `ensureReferenceDataSeeded()`'s
module-level memoized promise already makes concurrent calls safe — the
first call sets the promise before any `await`, so every other call in
the same process just awaits that same in-flight promise rather than
re-checking or re-inserting anything.

Across multiple server processes hitting a brand-new database's first
moments of traffic at once, safety instead comes from the database
itself: `Airport.iata` and `Airline.iata` are `@unique`, and
`AircraftType.code` is `@unique`, so `createMany({ skipDuplicates: true })`
compiles to an atomic `INSERT ... ON CONFLICT DO NOTHING` that Postgres
itself resolves correctly even when two processes race on the same row.
The one column this didn't originally cover was `Airline.icao` for the
~80% of bundled airlines that have an ICAO code but no IATA code (Postgres
treats every `NULL` iata as distinct from every other, so the plain unique
index on `iata` does nothing for these rows) — migration
`20260901120000_airline_icao_partial_unique_index` adds a **partial**
unique index (unique on `icao`, only among rows where `iata IS NULL`) that
closes this the same way, at the database level, rather than the
application doing its own non-atomic pre-check. See that migration's own
comment, and `reference-data.test.ts`'s "Airline icao-only concurrent
insert" test for a live proof against two genuinely concurrent inserts.

## How to initialize a brand-new CRM database

Do **not** copy data out of any existing development or production
PostgreSQL database to set up a new one. The correct sequence is:

```bash
npx prisma migrate deploy   # creates the schema
npx tsx prisma/bootstrap-company.ts --company-name "Your Company" \
  --admin-name "Your Name" --admin-email "you@example.com"
```

`prisma/bootstrap-company.ts` creates exactly one `Company` and one active
Admin `Account` directly in the database (it refuses to run if any account
already exists) — this is how the very first login gets created without a
circular "you must already be signed in as an admin to create an admin"
problem. From there, sign in as that admin and use the CRM normally; every
airport/airline/aircraft lookup self-heals the reference tables from the
bundled JSON as described above, with no manual reference-data step and no
data copied from any other database.

### Two different "new database" scenarios — know which one you're doing

**Scenario A — a brand-new company, no existing CRM data.** This is what
the sequence above does, and it's what this whole self-healing mechanism
is designed for: it works fully automatically, with zero manually copied
data of any kind.

**Scenario B — moving an existing company's CRM data (Leads, Contacts,
Quotes, Bookings, historical `FlightSegment` rows, etc.) to a different
PostgreSQL database or instance.** This is **not** what the self-healing
mechanism does, and it is not a supported "just point it at a new database
and it figures itself out" operation. Historical `FlightSegment` rows
store real foreign-key integers (`departureAirportId`, `airlineId`,
`aircraftTypeId`) pointing at specific `Airport`/`Airline`/`AircraftType`
row ids. If you stood up the new database via Scenario A first, its
reference tables were populated by `createMany` in bundle order — the ids
those rows got are **not guaranteed to match** the ids the old database's
historical `FlightSegment` rows already reference. Moving only the
business tables (or moving everything except letting reference tables
re-seed from scratch) would silently attach old flights to the wrong
airport/airline/aircraft, or to a row that doesn't exist. There is no
automatic remapping for this, and none should be added without a specific,
carefully-reviewed migration design — silently guessing at FK remapping is
far more dangerous than requiring a human to do it deliberately.

The correct approach for Scenario B is a standard, whole-database
backup/restore (e.g. `pg_dump` / `pg_restore`, or your hosting provider's
own database migration/replication tooling) that moves **every** table,
reference tables included, together and atomically — not this
application's own seeding path. If you're planning a Scenario B move,
treat it as a database-administration task, not an application feature.

**A read-only safety check for exactly this scenario** is available:

```bash
# Before touching anything, against the SOURCE database:
npx tsx scripts/migration-safety-check.ts --snapshot before.json

# After the migration/restore, against the DESTINATION database:
npx tsx scripts/migration-safety-check.ts --verify before.json
```

This never writes to the database — it records (and later compares) each
Airport/Airline/AircraftType row's id-to-code mapping, and reports whether
any id that a historical `FlightSegment` row might reference now points at
a *different* airport/airline/aircraft than it did in the snapshot. It
also reports the historical `FlightSegment` count either way, so running
it with no flags at all against any database is a quick way to tell
whether that database has business data worth worrying about in the first
place (see the tool's own header comment for full details). It does not
and cannot perform the migration itself, and it deliberately does not
attempt any automatic FK remapping if a mismatch is found — silently
"fixing" a mismatched id by guessing could make a wrong flight segment
look right instead of visibly broken, which is worse than a loud failure.

Every run (with or without `--snapshot`/`--verify`) also directly checks
for **dangling foreign keys** — a `FlightSegment` *or `Lead`* row whose
airport/airline/aircraft id doesn't resolve to any row that currently
exists (`Lead.departureAirportId`/`arrivalAirportId` are a separate
nullable FK into `Airport`, populated by both the public lead-capture form
and the CRM's own Lead-creation flow, carrying the exact same risk as
`FlightSegment`'s FKs — this tool covers both, not just one). Postgres's
own FK constraints make a dangling reference impossible under normal
operation, so a failure here is a strong, immediate signal that a restore
bypassed constraint checking or was interrupted partway through — useful
even without a "before" snapshot to compare against.

## How this was tested

The self-healing behavior was first verified manually against a genuinely
separate, isolated PostgreSQL database (not by deleting rows from the
shared development database) — a real second database created on the same
Postgres server, migrated from scratch with `prisma migrate deploy`,
bootstrapped with `bootstrap-company.ts`, and driven through the actual
running app in a browser: airport autocomplete, Sabre and Apollo GDS
parsing, quote save, the CRM-internal itinerary display, the
customer-facing quote page, and the booking form all worked correctly with
zero manual reference-data seeding. The temporary database was dropped
afterward and the real `.env` file was never modified at any point in the
process (a temporary connection string was passed only to a short-lived
child process's environment, never written to disk).

That manual procedure is now also available as a repeatable, fully
automated script:

```bash
npm run test:fresh-db
```

`scripts/fresh-database-check.ts` creates a real, disposable database on
the same Postgres server, runs `prisma migrate deploy` against it, then
runs `scripts/fresh-database-check-inner.ts` in a separate process
(pointed at that database only via an in-memory environment variable
override — never written to `.env` or any file) to exercise the real
`reference-data.ts` functions, a real Sabre parse + hydration, and an
idempotency check (calling the lookups twice and confirming row counts
don't change), then drops the disposable database regardless of outcome.
Deliberately **not** part of `npm run test` / `vitest run` — it needs
`CREATEDB` privilege a locked-down CI database user may not have. Run it
manually (or from a CI job that specifically has that privilege) after any
change to `ensureReferenceDataSeeded` or the seed functions it calls.

## Where this data is read from

`src/server/queries/reference-data.ts` is the single, centralized query
layer for Airline/Airport/AircraftType — `searchAirlines`, `searchAirports`,
`searchAircraft`, `resolveAirportCodes`, `resolveAirlineCodes`,
`resolveAircraftCodes`. Every part of the app that needs this data goes
through these functions (including the public website lead-capture API
route); nothing else queries these tables directly.

The three `resolve*Codes` functions trim and uppercase codes internally
before querying, but return their result map keyed by each *original,
un-normalized* input string — so a caller must look up a result using the
exact string it passed in, not a normalized form (see `normalizeReferenceCode`
and its callers for why: every real caller already has the original string
in hand, and re-deriving a normalized key at the call site is a needless
second place for that logic to drift).
