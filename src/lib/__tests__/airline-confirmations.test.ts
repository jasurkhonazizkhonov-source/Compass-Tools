import { describe, it, expect } from "vitest";
import { resolveAirlineConfirmations, toLegacyBookingFields, airlineConfirmationEntrySchema } from "../airline-confirmations";

describe("resolveAirlineConfirmations — the one shared source of truth", () => {
  it("prefers the new array when present and non-empty", () => {
    const result = resolveAirlineConfirmations({
      airlineConfirmations: [{ id: "1", airlineIata: "AA", confirmationNumber: "NEW123", eTicketNumbers: [] }],
      airlineConfirmationNumber: "OLD999",
      ticketNumbers: ["999"],
    });
    expect(result).toEqual([{ id: "1", airlineIata: "AA", confirmationNumber: "NEW123", eTicketNumbers: [] }]);
  });

  it("synthesizes a single legacy entry when the new array is null (a pre-Pass-23 booking)", () => {
    const result = resolveAirlineConfirmations({
      airlineConfirmations: null,
      airlineConfirmationNumber: "AA123",
      ticketNumbers: ["0011", "0022"],
    });
    expect(result).toEqual([{ id: "legacy", airlineIata: null, confirmationNumber: "AA123", eTicketNumbers: ["0011", "0022"] }]);
  });

  it("returns an empty array when neither the new field nor the legacy field has anything", () => {
    expect(resolveAirlineConfirmations({ airlineConfirmations: null, airlineConfirmationNumber: null, ticketNumbers: null })).toEqual([]);
  });

  it("treats an empty new array as genuinely empty (not falling back to legacy) — an explicit 'removed everything' save", () => {
    const result = resolveAirlineConfirmations({ airlineConfirmations: [], airlineConfirmationNumber: "AA123", ticketNumbers: ["0011"] });
    // An empty array from a real DB row means the agent explicitly saved
    // zero rows — this must NOT resurrect stale legacy values (those are
    // only ever mirrored FROM the array, never authoritative once it's
    // been saved at least once).
    expect(result).toEqual([]);
  });

  it("never throws on malformed/unexpected JSON in the new field — treats it as absent", () => {
    const result = resolveAirlineConfirmations({
      airlineConfirmations: { not: "an array" },
      airlineConfirmationNumber: "AA123",
      ticketNumbers: null,
    });
    expect(result).toEqual([{ id: "legacy", airlineIata: null, confirmationNumber: "AA123", eTicketNumbers: [] }]);
  });

  it("filters out empty-string legacy ticket numbers", () => {
    const result = resolveAirlineConfirmations({ airlineConfirmations: null, airlineConfirmationNumber: "AA123", ticketNumbers: ["0011", "", "0022"] });
    expect(result[0].eTicketNumbers).toEqual(["0011", "0022"]);
  });
});

describe("toLegacyBookingFields — backward-compatibility mirror", () => {
  it("mirrors the first entry's confirmation number and flattens every entry's e-tickets", () => {
    const result = toLegacyBookingFields([
      { id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: ["0011"] },
      { id: "2", airlineIata: null, confirmationNumber: "BB456", eTicketNumbers: ["0022", "0033"] },
    ]);
    expect(result).toEqual({ airlineConfirmationNumber: "AA123", ticketNumbers: ["0011", "0022", "0033"] });
  });

  it("an empty array mirrors to null/[] — a real 'cleared everything' save", () => {
    expect(toLegacyBookingFields([])).toEqual({ airlineConfirmationNumber: null, ticketNumbers: [] });
  });
});

describe("airlineConfirmationEntrySchema — input validation", () => {
  it("requires a non-empty confirmation number", () => {
    expect(airlineConfirmationEntrySchema.safeParse({ id: "1", confirmationNumber: "" }).success).toBe(false);
  });

  // Pass 24 — previously untested: confirmationNumber is `.trim().min(1)`,
  // so a value that is entirely whitespace must be rejected too, not just
  // the empty string. Confirmed correct behavior; this closes the missing
  // coverage for it.
  it("rejects a confirmation number that is only whitespace", () => {
    expect(airlineConfirmationEntrySchema.safeParse({ id: "1", confirmationNumber: "   " }).success).toBe(false);
  });

  it("airlineIata and eTicketNumbers are genuinely optional", () => {
    const parsed = airlineConfirmationEntrySchema.safeParse({ id: "1", confirmationNumber: "AA123" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.airlineIata).toBeNull();
      expect(parsed.data.eTicketNumbers).toEqual([]);
    }
  });

  it("blank airlineIata normalizes to null rather than an empty string", () => {
    const parsed = airlineConfirmationEntrySchema.safeParse({ id: "1", confirmationNumber: "AA123", airlineIata: "   " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.airlineIata).toBeNull();
  });
});
