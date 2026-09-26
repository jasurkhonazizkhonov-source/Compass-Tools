import { prisma } from "@/lib/prisma";
import { isProductionEnvironment } from "@/lib/env";
import { purgeCardData, type PurgeSummary } from "./card-retention";
import type { Queryable } from "./card-key-rotation";

// Opt-in scheduled retention purge, run by the daily cron (/api/cron/tasks).
//
//   CARD_RETENTION_DAYS   Whole number of days. UNSET = disabled (the default).
//
// The retention period is a BUSINESS decision (docs/CARD_VAULT_SECURITY.md §10):
// this code invents none. When set, every stored card number older than that
// many days (counted from the card's creation) is destroyed, together with any
// removed-but-not-yet-purged card. Purging is irreversible.
//
// Safety: it only ever runs when explicitly configured, and in a production-class
// environment only when the cron is authenticated (CRON_SECRET set) — an open
// cron endpoint must never be able to trigger an irreversible purge.

/** The Prisma connection presented as the minimal Queryable the purge module needs. */
function prismaQueryable(): Queryable {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/^\s*select/i.test(sql)) {
        const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
        return { rows };
      }
      const rowCount = await prisma.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    },
  };
}

export function getCardRetentionDays(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CARD_RETENTION_DAYS?.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
}

export type ScheduledRetentionResult =
  | { status: "disabled" }
  | { status: "invalid_configuration" }
  | { status: "skipped_unauthenticated_cron" }
  | ({ status: "ran" } & PurgeSummary);

export async function runScheduledCardRetention(env: NodeJS.ProcessEnv = process.env): Promise<ScheduledRetentionResult> {
  const raw = env.CARD_RETENTION_DAYS?.trim();
  if (!raw) return { status: "disabled" };
  const days = getCardRetentionDays(env);
  if (days === null) return { status: "invalid_configuration" };
  if (isProductionEnvironment() && !env.CRON_SECRET) return { status: "skipped_unauthenticated_cron" };
  const summary = await purgeCardData(prismaQueryable(), { apply: true, archived: true, olderThanDays: days });
  return { status: "ran", ...summary };
}
