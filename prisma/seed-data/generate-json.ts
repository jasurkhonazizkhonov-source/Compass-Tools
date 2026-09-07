// One-off, manually-run dev script (`npm run generate:reference-json`) that
// converts the raw OurAirports/OpenFlights source files in this directory
// into the pre-filtered, pre-normalized JSON datasets the running app
// bundles and reads from (src/data/reference/*.json — see
// src/server/queries/reference-data.ts's ensureReferenceDataSeeded()).
//
// Not part of the build or runtime — this is a dev tool, run once to
// produce the committed JSON files, and re-run again later only if the
// source airports.csv/airlines.dat/planes.dat files are ever updated. Uses
// the exact same parse/filter logic as prisma/seed.ts (imported from
// ./parse.ts) so there is never a second, drifting implementation of "what
// counts as a useful row."
import fs from "node:fs";
import path from "node:path";
import { parseAirportsCsv, parseAirlinesDat, parseAircraftDat } from "./parse";

function writeJson(fileName: string, data: unknown) {
  const outDir = path.join(__dirname, "..", "..", "src", "data", "reference");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  fs.writeFileSync(outPath, JSON.stringify(data), "utf-8");
  console.log(`Wrote ${outPath} (${Array.isArray(data) ? data.length : "?"} rows)`);
}

function main() {
  writeJson("airports.json", parseAirportsCsv());
  writeJson("airlines.json", parseAirlinesDat());
  writeJson("aircraft.json", parseAircraftDat());
}

main();
