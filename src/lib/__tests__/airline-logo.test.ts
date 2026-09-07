import { describe, it, expect } from "vitest";
import { airlineLogoUrl } from "../airline-logo";

// Portability pass, Item 9 — the CDN-URL fallback function itself had no
// dedicated test (only exercised indirectly through canonical-segment's
// own tests). This closes that gap with the exact edge-case checklist the
// task specifies: valid/lowercase/whitespace/missing/ICAO-only/invalid.
describe("airlineLogoUrl", () => {
  it("builds the CDN URL for a valid uppercase IATA code", () => {
    expect(airlineLogoUrl("CX")).toBe("https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("uppercases a lowercase IATA code", () => {
    expect(airlineLogoUrl("cx")).toBe("https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("handles a mixed-case IATA code", () => {
    expect(airlineLogoUrl("Cx")).toBe("https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("returns null (never throws or fabricates a URL) for a code with surrounding whitespace — degrades to the boxed-code fallback rather than requesting a malformed CDN path", () => {
    expect(airlineLogoUrl(" CX")).toBeNull();
    expect(airlineLogoUrl("CX ")).toBeNull();
    expect(airlineLogoUrl(" CX ")).toBeNull();
  });

  it("returns null for a missing IATA code (null, undefined, or empty string) — the ICAO-only-airline case", () => {
    expect(airlineLogoUrl(null)).toBeNull();
    expect(airlineLogoUrl(undefined)).toBeNull();
    expect(airlineLogoUrl("")).toBeNull();
  });

  it("returns null for a code that isn't exactly 2 alphanumeric characters, rather than guessing", () => {
    expect(airlineLogoUrl("C")).toBeNull();
    expect(airlineLogoUrl("CXX")).toBeNull();
    expect(airlineLogoUrl("C-")).toBeNull();
  });

  it("still builds a URL for a syntactically valid but non-existent 2-character code — this function only validates the CODE SHAPE, not whether a real airline or logo exists; the actual CDN 404 is handled by AirlineLogo's onError fallback, not here", () => {
    expect(airlineLogoUrl("ZZ")).toBe("https://images.kiwi.com/airlines/64x64/ZZ.png");
  });

  it("accepts a numeric-containing 2-character IATA code (some real airlines use these, e.g. '2K')", () => {
    expect(airlineLogoUrl("2K")).toBe("https://images.kiwi.com/airlines/64x64/2K.png");
  });
});
