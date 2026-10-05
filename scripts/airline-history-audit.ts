// Finds (and, only when told to, repairs) historical flight segments that still point at an airline row whose IATA code was
// recycled — see src/server/airline-history.ts for exactly what qualifies and why nothing else is ever touched.
//
//   # report only (default; read-only): counts, the airline pairs involved, and what could not be inferred
//   DATABASE_URL=... npm run airlines:history
//   # optionally limit to flights departing on/after a date
//   ... npm run airlines:history -- --since=2025-01-01
//   # repair (needs BOTH flags; writes the undo list to the file BEFORE changing anything)
//   ... npm run airlines:history -- --apply --confirm --undo-file=airline-undo.json
//   # reverse an earlier repair exactly
//   ... npm run airlines:history -- --undo=airline-undo.json --confirm
//
// Prints counts, airline names and segment ids only — never customer data. Take a backup first.
import fs from "node:fs";
import pg from "pg";
import { resolveDatabaseSsl } from "../src/lib/db-tls";
import { applyRepoint, reportAirlineHistory, undoRepoint, type UndoEntry } from "../src/server/airline-history";

function arg(name: string): string | undefined {
  return process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const apply = flag("apply");
  const confirm = flag("confirm");
  const undoFile = arg("undo");
  const undoOut = arg("undo-file");
  const sinceRaw = arg("since");
  const since = sinceRaw ? new Date(`${sinceRaw}T00:00:00.000Z`) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error("--since must be a date like 2025-01-01.");
    process.exit(1);
  }
  if ((apply || undoFile) && !confirm) {
    console.error("Refusing to change data without --confirm. Run without --apply first to see exactly what would change, and take a backup.");
    process.exit(1);
  }
  if (apply && !undoOut) {
    console.error("--apply needs --undo-file=<path>: the exact reversal list is written there before anything changes.");
    process.exit(1);
  }
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: resolveDatabaseSsl() });
  await client.connect();
  try {
    if (undoFile) {
      const entries = JSON.parse(fs.readFileSync(undoFile, "utf8")) as UndoEntry[];
      console.log(JSON.stringify(await undoRepoint(client, entries), null, 2));
      return;
    }
    const before = await reportAirlineHistory(client, { since });
    const { candidates, ...summary } = before;
    console.log(JSON.stringify({ ...summary, candidateSegments: candidates.length }, null, 2));
    if (!apply) {
      console.log(candidates.length === 0 ? "Nothing to repair." : `Dry run only: ${candidates.length} segment(s) could be re-pointed. Re-run with --apply --confirm --undo-file=<path> to repair.`);
      return;
    }
    const result = await applyRepoint(client, candidates, (undo) => fs.writeFileSync(undoOut!, JSON.stringify(undo, null, 1)));
    const after = await reportAirlineHistory(client, { since });
    console.log(JSON.stringify({ applied: result.applied, skippedBecauseChangedMeanwhile: result.skippedChanged, remainingCandidates: after.candidates.length, undoFile: undoOut }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`airline-history-audit failed (${err instanceof Error ? err.name : "error"})`);
  process.exit(1);
});
