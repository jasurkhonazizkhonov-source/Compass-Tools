import { describe, it, expect } from "vitest";
import { comparePendingMigrations } from "../migration-status";

describe("comparePendingMigrations", () => {
  it("reports exactly the migrations the build expects that the database has not applied", () => {
    expect(comparePendingMigrations(["a", "b", "c"], ["a", "b"])).toEqual(["c"]);
    expect(comparePendingMigrations(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("ignores extra applied migrations the build does not know about (a newer deploy, or another app sharing the database)", () => {
    expect(comparePendingMigrations(["a"], ["a", "zzz-from-elsewhere"])).toEqual([]);
  });

  it("everything is pending against an empty history", () => {
    expect(comparePendingMigrations(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
