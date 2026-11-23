import { describe, it, expect } from "vitest";
import { z } from "zod";
import { describeLeadFlexibility, flexibilityDaysAfterToggle, isValidDateFlexibilityDays } from "@/lib/date-flexibility";
import { refineFlexibility, resolveFlexibility } from "@/server/lead-intake";

describe("describeLeadFlexibility: the choice in the customer's own terms, never invented", () => {
  it.each([
    [false, 0, "Exact dates"],
    [true, 1, "± 1 day"],
    [true, 2, "± 2 days"],
    [true, 3, "± 3 days"],
    [true, null, "Flexible"],
    [true, undefined, "Flexible"],
    [false, null, null],
    [false, undefined, null],
  ])("flexible=%s, days=%s -> %s", (flexible, days, expected) => {
    expect(describeLeadFlexibility(flexible, days)).toBe(expected);
  });

  it("a stored number outside 0-3 (the database refuses it, but a value is never trusted) falls back to the Boolean", () => {
    expect(describeLeadFlexibility(true, 7)).toBe("Flexible");
    expect(describeLeadFlexibility(false, -1)).toBeNull();
    expect(describeLeadFlexibility(true, 1.5)).toBe("Flexible");
  });

  it("isValidDateFlexibilityDays accepts exactly the integers 0-3", () => {
    for (const v of [0, 1, 2, 3]) expect(isValidDateFlexibilityDays(v)).toBe(true);
    for (const v of [-1, 4, 1.5, "2", null, undefined, Number.NaN]) expect(isValidDateFlexibilityDays(v)).toBe(false);
  });
});

describe("flexibilityDaysAfterToggle: a staff edit never leaves the Boolean and the customer's choice contradicting each other", () => {
  it("switching ON while the customer chose exact dates: flexible, number no longer known", () => {
    expect(flexibilityDaysAfterToggle(true, 0)).toBeNull();
  });
  it("switching OFF while the customer chose 1-3 days: exact dates", () => {
    for (const d of [1, 2, 3]) expect(flexibilityDaysAfterToggle(false, d)).toBe(0);
  });
  it("everything else is unchanged", () => {
    expect(flexibilityDaysAfterToggle(true, 2)).toBe(2);
    expect(flexibilityDaysAfterToggle(true, null)).toBeNull();
    expect(flexibilityDaysAfterToggle(false, 0)).toBe(0);
    expect(flexibilityDaysAfterToggle(false, null)).toBeNull();
  });
});

describe("resolveFlexibility / refineFlexibility (lead intake)", () => {
  it("the number implies the Boolean", () => {
    expect(resolveFlexibility({ dateFlexibilityDays: 0 })).toEqual({ flexibleDates: false, dateFlexibilityDays: 0 });
    expect(resolveFlexibility({ dateFlexibilityDays: 2 })).toEqual({ flexibleDates: true, dateFlexibilityDays: 2 });
  });
  it("the Boolean alone stores 'not stated' for the number: it is never invented", () => {
    expect(resolveFlexibility({ datesFlexible: true })).toEqual({ flexibleDates: true, dateFlexibilityDays: null });
    expect(resolveFlexibility({ datesFlexible: false })).toEqual({ flexibleDates: false, dateFlexibilityDays: null });
    expect(resolveFlexibility({})).toEqual({ flexibleDates: false, dateFlexibilityDays: null });
  });
  it("contradictory pairs are refused; agreeing and partial ones are not", () => {
    const schema = z.object({ datesFlexible: z.boolean().optional(), dateFlexibilityDays: z.number().optional() }).superRefine(refineFlexibility);
    expect(schema.safeParse({ datesFlexible: true, dateFlexibilityDays: 0 }).success).toBe(false);
    expect(schema.safeParse({ datesFlexible: false, dateFlexibilityDays: 3 }).success).toBe(false);
    expect(schema.safeParse({ datesFlexible: true, dateFlexibilityDays: 3 }).success).toBe(true);
    expect(schema.safeParse({ datesFlexible: false, dateFlexibilityDays: 0 }).success).toBe(true);
    expect(schema.safeParse({ dateFlexibilityDays: 2 }).success).toBe(true);
    expect(schema.safeParse({ datesFlexible: true }).success).toBe(true);
  });
});
