// A tiny record of the LAST ATTEMPT to update the geolocation database, kept beside the database file (`<database>.update.json`, in the same volume) so System Health can say
// when the database was last refreshed successfully and whether the most recent attempt failed. Written only by the operator's update command (scripts/geoip-database.ts);
// read by the application, which has the volume mounted read-only. It holds a timestamp, an outcome and a short plain reason - never a path, a secret or a record.
import { promises as fs } from "node:fs";

export type GeoIpUpdateOutcome = "success" | "failed";
export type GeoIpUpdateStatus = {
  /** When the most recent attempt finished. */
  lastAttemptAt: Date;
  lastOutcome: GeoIpUpdateOutcome;
  /** Short plain reason for a failed attempt (file paths removed, bounded length). */
  lastError: string | null;
  /** When an attempt last SUCCEEDED (kept across later failures). */
  lastSuccessAt: Date | null;
};

const REASON_MAX = 200;

export const updateStatusPath = (databasePath: string) => `${databasePath}.update.json`;

/** A one-line reason that is safe to store and show: no absolute file paths, no control characters, bounded. */
export function safeReason(message: unknown): string {
  const text = typeof message === "string" ? message : "the update failed";
  return text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"')]*[\\/][^\s"')]+/g, "<path>") // a path with at least two segments
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_MAX);
}

/** Reads the record. Never throws: a missing, unreadable or malformed file is simply "no record" (null). */
export async function readUpdateStatus(databasePath: string): Promise<GeoIpUpdateStatus | null> {
  try {
    const raw = JSON.parse(await fs.readFile(updateStatusPath(databasePath), "utf8")) as Record<string, unknown>;
    const at = typeof raw.lastAttemptAt === "string" ? new Date(raw.lastAttemptAt) : null;
    if (!at || Number.isNaN(at.getTime())) return null;
    const outcome = raw.lastOutcome === "success" || raw.lastOutcome === "failed" ? raw.lastOutcome : null;
    if (!outcome) return null;
    const success = typeof raw.lastSuccessAt === "string" ? new Date(raw.lastSuccessAt) : null;
    return {
      lastAttemptAt: at,
      lastOutcome: outcome,
      lastError: outcome === "failed" && typeof raw.lastError === "string" ? safeReason(raw.lastError) : null,
      lastSuccessAt: success && !Number.isNaN(success.getTime()) ? success : null,
    };
  } catch {
    return null;
  }
}

/** Records the outcome of an update attempt (operator command only). A failure keeps the previous success time. Written atomically (temp file + rename); never throws. */
export async function recordUpdateAttempt(databasePath: string, outcome: GeoIpUpdateOutcome, error?: unknown, now: Date = new Date()): Promise<void> {
  try {
    const previous = await readUpdateStatus(databasePath);
    const body = {
      lastAttemptAt: now.toISOString(),
      lastOutcome: outcome,
      lastError: outcome === "failed" ? safeReason(error instanceof Error ? error.message : error) : null,
      lastSuccessAt: outcome === "success" ? now.toISOString() : previous?.lastSuccessAt?.toISOString() ?? null,
    };
    const file = updateStatusPath(databasePath);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(body) + "\n", { mode: 0o644 });
    await fs.rename(temp, file);
  } catch {
    // Recording is informational; it must never turn a good update into a failure or hide the real error.
  }
}
