import { describe, expect, it } from "vitest";
import { isEligibleForAutoDistribution, compareQueueEntries } from "@/lib/lead-distribution";

describe("isEligibleForAutoDistribution", () => {
  it("is eligible when website-sourced, unassigned, and never queued", () => {
    expect(
      isEligibleForAutoDistribution({ source: "WEBSITE", assignedAgentId: null, queueDistributedAt: null }),
    ).toBe(true);
  });

  it("rejects non-website sources", () => {
    expect(
      isEligibleForAutoDistribution({ source: "PHONE", assignedAgentId: null, queueDistributedAt: null }),
    ).toBe(false);
  });

  it("rejects a lead that already has an assigned agent", () => {
    expect(
      isEligibleForAutoDistribution({ source: "WEBSITE", assignedAgentId: "acc_1", queueDistributedAt: null }),
    ).toBe(false);
  });

  it("rejects a lead that already went through the queue, even if later unassigned", () => {
    expect(
      isEligibleForAutoDistribution({
        source: "WEBSITE",
        assignedAgentId: null,
        queueDistributedAt: new Date("2026-01-01"),
      }),
    ).toBe(false);
  });
});

describe("compareQueueEntries", () => {
  it("sorts a never-assigned worker (null lastAssignedAt) before an assigned one", () => {
    const neverAssigned = { lastAssignedAt: null, joinedAt: new Date("2026-01-02") };
    const assigned = { lastAssignedAt: new Date("2026-01-01"), joinedAt: new Date("2026-01-01") };
    expect(compareQueueEntries(neverAssigned, assigned)).toBeLessThan(0);
    expect(compareQueueEntries(assigned, neverAssigned)).toBeGreaterThan(0);
  });

  it("sorts by lastAssignedAt ascending when both have been assigned before", () => {
    const longerAgo = { lastAssignedAt: new Date("2026-01-01T00:00:00Z"), joinedAt: new Date("2026-01-01") };
    const morerecent = { lastAssignedAt: new Date("2026-01-02T00:00:00Z"), joinedAt: new Date("2026-01-01") };
    expect(compareQueueEntries(longerAgo, morerecent)).toBeLessThan(0);
  });

  it("breaks ties on joinedAt ascending when neither has ever been assigned", () => {
    const joinedFirst = { lastAssignedAt: null, joinedAt: new Date("2026-01-01T00:00:00Z") };
    const joinedSecond = { lastAssignedAt: null, joinedAt: new Date("2026-01-01T01:00:00Z") };
    expect(compareQueueEntries(joinedFirst, joinedSecond)).toBeLessThan(0);
  });

  it("treats identical entries as equal", () => {
    const entry = { lastAssignedAt: new Date("2026-01-01"), joinedAt: new Date("2026-01-01") };
    expect(compareQueueEntries(entry, { ...entry })).toBe(0);
  });

  it("produces a stable least-recently-served ordering across a mixed list", () => {
    const workers = [
      { id: "c", lastAssignedAt: new Date("2026-01-03T00:00:00Z"), joinedAt: new Date("2026-01-01") },
      { id: "a", lastAssignedAt: null, joinedAt: new Date("2026-01-01T02:00:00Z") },
      { id: "b", lastAssignedAt: null, joinedAt: new Date("2026-01-01T01:00:00Z") },
      { id: "d", lastAssignedAt: new Date("2026-01-02T00:00:00Z"), joinedAt: new Date("2026-01-01") },
    ];
    const sorted = [...workers].sort(compareQueueEntries).map((w) => w.id);
    expect(sorted).toEqual(["b", "a", "d", "c"]);
  });
});
