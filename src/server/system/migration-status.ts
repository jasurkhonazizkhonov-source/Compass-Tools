import { prisma } from "@/lib/prisma";
import manifest from "@/lib/migration-manifest.json";

export type MigrationStatus =
  | { state: "current"; expected: number; applied: number; pending: string[] }
  | { state: "pending"; expected: number; applied: number; pending: string[] }
  | { state: "unknown"; expected: number };

/** Pure comparison (testable without a database): which migrations this
 * build expects that the database has not finished applying. Extra applied
 * migrations the build does not know about (a newer deploy / the sibling
 * website's own) are ignored — only MISSING ones matter. */
export function comparePendingMigrations(expected: readonly string[], applied: readonly string[]): string[] {
  const done = new Set(applied);
  return expected.filter((name) => !done.has(name));
}

/**
 * Whether the database has every migration this build's code depends on.
 * Read-only (one SELECT on Prisma's own history table). A deploy whose code
 * needs a column its database does not have would otherwise show up only as
 * scattered runtime errors — this makes it one clear answer.
 */
export async function getMigrationStatus(): Promise<MigrationStatus> {
  const expected = manifest.migrations;
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    const applied = rows.map((r) => r.migration_name);
    const pending = comparePendingMigrations(expected, applied);
    return { state: pending.length === 0 ? "current" : "pending", expected: expected.length, applied: applied.length, pending };
  } catch {
    // e.g. the history table does not exist at all (a database that never
    // ran `prisma migrate`) — cannot tell, so say so rather than guess.
    return { state: "unknown", expected: expected.length };
  }
}
