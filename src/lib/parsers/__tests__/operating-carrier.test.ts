import { describe, it, expect } from "vitest";
import { parseGdsItinerary } from "../gds-line";

describe("operating carrier ('OPERATED BY X' continuation lines)", () => {
  it("attaches the operating carrier name to the immediately preceding segment", () => {
    const text = `1 PR 105Z 28JAN SFOMNL SS1 1040P 535A2* TH/SA E 1
2 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY PAL EXPRESS`;
    const segments = parseGdsItinerary(text, 2026);
    expect(segments).toHaveLength(2);
    expect(segments[0].operatingCarrierName).toBeUndefined();
    expect(segments[1].operatingCarrierName).toBe("PAL EXPRESS");
  });

  it("never overwrites the marketing carrier fields — PR/2849 remain the marketing carrier", () => {
    const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY PAL EXPRESS`;
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.airlineCode).toBe("PR");
    expect(seg.flightNumber).toBe("2849");
    expect(seg.operatingCarrierName).toBe("PAL EXPRESS");
  });

  it("does not attach to any segment when there is no preceding segment", () => {
    const text = `        OPERATED BY PAL EXPRESS
1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1`;
    const segments = parseGdsItinerary(text, 2026);
    expect(segments).toHaveLength(1);
    expect(segments[0].operatingCarrierName).toBeUndefined();
  });

  it("does not misparse the 'OPERATED BY' line as a spurious extra segment (e.g. reading 'PAL' as an airport)", () => {
    const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY PAL EXPRESS`;
    const segments = parseGdsItinerary(text, 2026);
    expect(segments).toHaveLength(1);
  });

  it("leaves a segment with no continuation line unaffected", () => {
    const text = `1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E`;
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.operatingCarrierName).toBeUndefined();
  });
});

describe("full worked examples from the spec — end-to-end field extraction", () => {
  it("BR/EVA Air example: marketing carrier, flight, class, route, status, times, +2 day arrival offset", () => {
    const text = "1 BR 15D 27JAN LAXTPE GK1 1100P 540A2 WE/FR";
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.airlineCode).toBe("BR");
    expect(seg.flightNumber).toBe("15");
    expect(seg.bookingClass).toBe("D");
    expect(seg.departureAirport).toBe("LAX");
    expect(seg.arrivalAirport).toBe("TPE");
    expect(seg.departureDate).toBe("2026-01-27");
    expect(seg.departureTime).toBe("23:00");
    expect(seg.arrivalTime).toBe("05:40");
    expect(seg.arrivalDate).toBe("2026-01-29"); // +2 days from departure
  });

  it("PR/Philippine Airlines + PAL Express example: two segments, operating carrier on the connecting leg", () => {
    const text = `1 PR 105Z 28JAN SFOMNL SS1 1040P 535A2* TH/SA E 1
2 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY PAL EXPRESS`;
    const segments = parseGdsItinerary(text, 2026);
    expect(segments).toHaveLength(2);

    const [first, second] = segments;
    expect(first.airlineCode).toBe("PR");
    expect(first.flightNumber).toBe("105");
    expect(first.departureAirport).toBe("SFO");
    expect(first.arrivalAirport).toBe("MNL");
    expect(first.departureDate).toBe("2026-01-28");
    expect(first.departureTime).toBe("22:40");
    expect(first.arrivalTime).toBe("05:35");
    expect(first.arrivalDate).toBe("2026-01-30"); // +2 days
    expect(first.operatingCarrierName).toBeUndefined();

    expect(second.airlineCode).toBe("PR");
    expect(second.flightNumber).toBe("2849");
    expect(second.departureAirport).toBe("MNL");
    expect(second.arrivalAirport).toBe("CEB");
    expect(second.departureDate).toBe("2026-01-30");
    expect(second.departureTime).toBe("08:50");
    expect(second.arrivalTime).toBe("10:10");
    expect(second.arrivalDate).toBe("2026-01-30"); // same-day, no offset signal
    expect(second.operatingCarrierName).toBe("PAL EXPRESS");
  });
});
