import { describe, it, expect } from "vitest";
import { formatRelativeUpdated } from "../relative-time";

const NOW = new Date("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("formatRelativeUpdated", () => {
  it.each([
    [0, "Just now"],
    [30 * S, "Just now"],
    [59 * S, "Just now"],
    [60 * S, "1 minute ago"],
    [2 * M, "2 minutes ago"],
    [18 * M, "18 minutes ago"],
    [59 * M, "59 minutes ago"],
    [60 * M, "1 hour ago"],
    [2 * H, "2 hours ago"],
    [23 * H, "23 hours ago"],
    [24 * H, "Yesterday"],
    [47 * H, "Yesterday"],
    [3 * D, "3 days ago"],
    [6 * D, "6 days ago"],
    [7 * D, "1 week ago"],
    [14 * D, "2 weeks ago"],
    [45 * D, "6 weeks ago"],
    [75 * D, "2 months ago"],
    [400 * D, "1 year ago"],
  ])("%d ms ago → %s", (ms, expected) => {
    expect(formatRelativeUpdated(ago(ms), NOW)).toBe(expected);
  });

  it("a timestamp slightly in the future (clock skew) reads Just now, never a negative duration", () => {
    expect(formatRelativeUpdated(new Date(NOW.getTime() + 5 * M), NOW)).toBe("Just now");
  });
});
