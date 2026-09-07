import { describe, it, expect } from "vitest";
import { parseEmailList } from "../bulk-subscriber-parse";

describe("parseEmailList — matches the spec's own worked example", () => {
  it("extracts one email per line", () => {
    const emails = parseEmailList("john@example.com\nmary@example.com\ndavid@example.com\nsarah@example.com");
    expect(emails).toEqual(["john@example.com", "mary@example.com", "david@example.com", "sarah@example.com"]);
  });
});

describe("parseEmailList — supported separator styles (Part 5)", () => {
  it("handles comma-separated emails", () => {
    expect(parseEmailList("john@example.com, mary@example.com, david@example.com")).toEqual([
      "john@example.com",
      "mary@example.com",
      "david@example.com",
    ]);
  });

  it("handles semicolon-separated emails", () => {
    expect(parseEmailList("john@example.com; mary@example.com; david@example.com")).toEqual([
      "john@example.com",
      "mary@example.com",
      "david@example.com",
    ]);
  });

  it("handles space-separated emails", () => {
    expect(parseEmailList("john@example.com mary@example.com david@example.com")).toEqual([
      "john@example.com",
      "mary@example.com",
      "david@example.com",
    ]);
  });

  it("handles a mix of separators in the same paste", () => {
    expect(parseEmailList("john@example.com,mary@example.com\ndavid@example.com; sarah@example.com")).toEqual([
      "john@example.com",
      "mary@example.com",
      "david@example.com",
      "sarah@example.com",
    ]);
  });
});

describe("parseEmailList — surrounding text, without becoming overly aggressive", () => {
  it("extracts an address out of a mail-client-style copied entry", () => {
    expect(parseEmailList("John Smith <john@example.com>")).toEqual(["john@example.com"]);
  });

  it("extracts multiple addresses each wrapped in display-name text", () => {
    expect(parseEmailList("John Smith <john@example.com>, Mary Jones <mary@example.com>")).toEqual([
      "john@example.com",
      "mary@example.com",
    ]);
  });

  it("ignores plain text that isn't email-shaped, rather than mangling it into a fake address", () => {
    expect(parseEmailList("Please add these subscribers:\njohn@example.com\nThanks!")).toEqual(["john@example.com"]);
  });

  it("returns an empty list for text with no email-shaped content at all", () => {
    expect(parseEmailList("just some notes, nothing to import here")).toEqual([]);
  });
});

describe("parseEmailList — does not dedupe or normalize (caller's job)", () => {
  it("preserves original casing and every occurrence, including exact duplicates", () => {
    expect(parseEmailList("John@Example.com\njohn@example.com")).toEqual(["John@Example.com", "john@example.com"]);
  });
});

describe("parseEmailList — extracts candidates without validating (Part 12D)", () => {
  it("still extracts a malformed candidate with no TLD, so classifyBulkSubscribers can flag it 'invalid' instead of it silently vanishing", () => {
    expect(parseEmailList("john@nodomain")).toEqual(["john@nodomain"]);
  });

  it("does not glue trailing comma/semicolon punctuation onto a loosely-matched candidate", () => {
    expect(parseEmailList("john@nodomain, mary@example.com")).toEqual(["john@nodomain", "mary@example.com"]);
  });

  it("extracts a double-'@' fragment as its own candidate (Part 29C — previously silently dropped entirely)", () => {
    expect(parseEmailList("a@@example.com")).toEqual(["a@@example.com"]);
  });

  it("extracts a double-'@' fragment alongside genuinely valid emails without merging or dropping either", () => {
    expect(parseEmailList("john@example.com a@@example.com mary@example.com")).toEqual([
      "john@example.com",
      "a@@example.com",
      "mary@example.com",
    ]);
  });
});
