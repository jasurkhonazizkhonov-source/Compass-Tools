import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import manifest from "../migration-manifest.json";

// The app compares this manifest with the database's applied migrations at
// runtime (health check). A stale manifest would make a healthy deployment
// look broken — or, worse, hide a missing migration — so it is verified
// against the real prisma/migrations directory.
describe("migration manifest", () => {
  it("lists exactly the migration folders in prisma/migrations (run `npm run migrations:manifest` after adding one)", () => {
    const dir = path.resolve(__dirname, "../../../prisma/migrations");
    const onDisk = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(manifest.migrations).toEqual(onDisk);
  });

  it("includes the inquiry-source migration this build depends on", () => {
    expect(manifest.migrations).toContain("20260925000000_inquiry_source");
  });
});
