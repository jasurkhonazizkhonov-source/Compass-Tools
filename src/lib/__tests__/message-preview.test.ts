import { describe, it, expect } from "vitest";
import { messagePreview } from "../message-preview";

describe("messagePreview", () => {
  it("leaves ordinary text exactly as written — every letter intact (a bad regex once dropped every lowercase 's')", () => {
    expect(messagePreview("Question about a booking made last week.")).toBe("Question about a booking made last week.");
    expect(messagePreview("We are a 40-person team")).toBe("We are a 40-person team");
  });

  it("collapses newlines and runs of whitespace into single spaces", () => {
    expect(messagePreview("Hello\n\n   there\tfriend  ")).toBe("Hello there friend");
  });

  it("truncates long messages with an ellipsis and trims trailing space before it", () => {
    const long = "word ".repeat(50);
    const out = messagePreview(long, 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/ …$/);
  });

  it("never truncates a message at or under the limit", () => {
    expect(messagePreview("x".repeat(90))).toBe("x".repeat(90));
  });
});
