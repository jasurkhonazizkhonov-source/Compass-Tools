import { describe, it, expect } from "vitest";
import { leadRouteLabel, leadSegmentsSchema, mirrorFromSegments, segmentsRouteLabel, MAX_LEAD_SEGMENTS } from "../lead-itinerary";

const ap = (iata: string) => ({ iata });

describe("segmentsRouteLabel", () => {
  it("chains consecutive legs: JFK → LHR → CDG → JFK", () => {
    expect(segmentsRouteLabel([{ departureAirport: ap("JFK"), arrivalAirport: ap("LHR") }, { departureAirport: ap("LHR"), arrivalAirport: ap("CDG") }, { departureAirport: ap("CDG"), arrivalAirport: ap("JFK") }])).toBe("JFK → LHR → CDG → JFK");
  });
  it("shows a break when a leg does not start where the previous one ended (an open-jaw): JFK → LHR · CDG → JFK", () => {
    expect(segmentsRouteLabel([{ departureAirport: ap("JFK"), arrivalAirport: ap("LHR") }, { departureAirport: ap("CDG"), arrivalAirport: ap("JFK") }])).toBe("JFK → LHR · CDG → JFK");
  });
  it("shows ? for an unknown airport and null for no segments", () => {
    expect(segmentsRouteLabel([{ departureAirport: null, arrivalAirport: ap("LHR") }])).toBe("? → LHR");
    expect(segmentsRouteLabel([])).toBeNull();
  });
});

describe("leadRouteLabel", () => {
  it("a multi-city lead with segments shows the whole chain", () => {
    expect(leadRouteLabel({ tripType: "MULTI_CITY", departureAirport: ap("JFK"), arrivalAirport: ap("LHR"), segments: [{ departureAirport: ap("JFK"), arrivalAirport: ap("LHR") }, { departureAirport: ap("LHR"), arrivalAirport: ap("CDG") }] })).toBe("JFK → LHR → CDG");
  });
  it("a one-way / round-trip lead, and a legacy multi-city lead without segments, show their single route", () => {
    expect(leadRouteLabel({ tripType: "ROUND_TRIP", departureAirport: ap("JFK"), arrivalAirport: ap("LGW"), segments: [] })).toBe("JFK → LGW");
    expect(leadRouteLabel({ tripType: "MULTI_CITY", departureAirport: ap("JFK"), arrivalAirport: ap("LGW"), segments: [] })).toBe("JFK → LGW");
    expect(leadRouteLabel({ tripType: "ONE_WAY", departureAirport: null, arrivalAirport: null })).toBe("— → —");
  });
  it("ignores stale segments on a lead that is no longer multi-city", () => {
    expect(leadRouteLabel({ tripType: "ONE_WAY", departureAirport: ap("JFK"), arrivalAirport: ap("LHR"), segments: [{ departureAirport: ap("AAA"), arrivalAirport: ap("BBB") }] })).toBe("JFK → LHR");
  });
});

describe("mirrorFromSegments", () => {
  it("mirrors the FIRST segment onto the lead-level route and clears the return date", () => {
    const m = mirrorFromSegments([
      { departureAirportId: 1, arrivalAirportId: 2, departureDate: "2026-10-20" },
      { departureAirportId: 2, arrivalAirportId: 3, departureDate: "2026-10-24" },
    ]);
    expect(m.departureAirportId).toBe(1);
    expect(m.arrivalAirportId).toBe(2);
    expect(m.departureDate?.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(m.returnDate).toBeNull();
  });
  it("tolerates an unset first segment", () => {
    expect(mirrorFromSegments([{ departureAirportId: null, arrivalAirportId: null, departureDate: null }])).toMatchObject({ departureAirportId: null, arrivalAirportId: null, departureDate: null });
  });
});

describe("leadSegmentsSchema", () => {
  const ok = { departureAirportId: 1, arrivalAirportId: 2, departureDate: "2026-10-20" };
  it("accepts 1..MAX segments", () => {
    expect(leadSegmentsSchema.safeParse([ok]).success).toBe(true);
    expect(leadSegmentsSchema.safeParse(Array.from({ length: MAX_LEAD_SEGMENTS }, () => ok)).success).toBe(true);
  });
  it("refuses an empty itinerary (the last segment cannot be removed) and too many segments", () => {
    expect(leadSegmentsSchema.safeParse([]).success).toBe(false);
    expect(leadSegmentsSchema.safeParse(Array.from({ length: MAX_LEAD_SEGMENTS + 1 }, () => ok)).success).toBe(false);
  });
  it("refuses malformed dates and ids, and accepts unset airports/dates", () => {
    expect(leadSegmentsSchema.safeParse([{ ...ok, departureDate: "10/20/2026" }]).success).toBe(false);
    expect(leadSegmentsSchema.safeParse([{ ...ok, departureAirportId: 1.5 }]).success).toBe(false);
    expect(leadSegmentsSchema.safeParse([{ ...ok, departureAirportId: -1 }]).success).toBe(false);
    expect(leadSegmentsSchema.safeParse([{ departureAirportId: null, arrivalAirportId: null, departureDate: null }]).success).toBe(true);
  });
});
