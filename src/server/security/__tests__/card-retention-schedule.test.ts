import { describe, it, expect, vi, afterEach } from "vitest";
import { getCardRetentionDays, runScheduledCardRetention } from "../card-retention-schedule";

// The scheduled purge invents no retention period: it is OFF unless the owner
// sets CARD_RETENTION_DAYS, and in production it never runs from an
// unauthenticated cron. (The purge itself is exercised against a real database in
// card-vault.integration.test.ts.)

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
afterEach(() => vi.unstubAllEnvs());

describe("CARD_RETENTION_DAYS", () => {
  it("is disabled by default — no period is assumed", async () => {
    expect(getCardRetentionDays(env({}))).toBeNull();
    expect(await runScheduledCardRetention(env({}))).toEqual({ status: "disabled" });
    expect(await runScheduledCardRetention(env({ CARD_RETENTION_DAYS: "  " }))).toEqual({ status: "disabled" });
  });

  it("only accepts a whole number of days between 1 and 3650; anything else is reported, never guessed", async () => {
    for (const bad of ["0", "-5", "1.5", "abc", "3651", "30 days", "1e2"]) {
      expect(getCardRetentionDays(env({ CARD_RETENTION_DAYS: bad })), bad).toBeNull();
      expect(await runScheduledCardRetention(env({ CARD_RETENTION_DAYS: bad })), bad).toEqual({ status: "invalid_configuration" });
    }
    expect(getCardRetentionDays(env({ CARD_RETENTION_DAYS: "90" }))).toBe(90);
  });

  it("in a production-class environment it refuses to run unless the cron is authenticated (CRON_SECRET)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await runScheduledCardRetention(env({ CARD_RETENTION_DAYS: "90" }))).toEqual({ status: "skipped_unauthenticated_cron" });
  });
});
