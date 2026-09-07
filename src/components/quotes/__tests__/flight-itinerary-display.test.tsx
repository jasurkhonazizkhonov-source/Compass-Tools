// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { axe } from "vitest-axe";
import { FlightItineraryDisplay, type SegmentDisplay } from "../flight-itinerary-display";

// Portability pass 2, Item 9 — dedicated regression coverage for the exact
// component where the real airline-logo bug lived (see this file's own
// prop-wiring fix: <AirlineLogo logoUrl={airline.logoUrl}> reading the
// already-resolved value, not the raw segment.airline?.logoUrl database
// column). That fix was previously verified only by a live browser
// screenshot against a genuinely fresh database — this makes it a
// permanent, fast, automated regression test instead. This component is
// pure (no data fetching, no server/router dependency), so no mocking is
// needed at all.

function segment(overrides: Partial<SegmentDisplay>): SegmentDisplay {
  return {
    id: "seg-1",
    sequence: 1,
    flightNumber: "255",
    bookingClass: "Y",
    cabin: "ECONOMY",
    departureAt: new Date("2026-09-04T18:00:00Z"),
    arrivalAt: new Date("2026-09-04T19:25:00Z"),
    durationMinutes: 85,
    airline: { name: "Cathay Pacific", iata: "CX", icao: "CPA", logoUrl: null },
    airlineCodeRaw: "CX",
    aircraftType: null,
    aircraftRaw: null,
    departureAirport: { iata: "FCO", name: "Leonardo da Vinci", city: "Rome" },
    arrivalAirport: { iata: "MNL", name: "Ninoy Aquino Intl", city: "Manila" },
    connectionType: null,
    ...overrides,
  };
}

describe("FlightItineraryDisplay — airline logo (Test E regression)", () => {
  it("renders the real CDN-fallback logo image (not a broken image, not the boxed-code fallback) when the airline row's logoUrl is null — exactly the state every self-healed Airline row is in on a fresh database", () => {
    render(<FlightItineraryDisplay segments={[segment({})]} />);
    const img = screen.getByRole("img", { name: "Cathay Pacific" });
    expect(img).toHaveAttribute("src", "https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("an explicit database logoUrl still wins over the CDN fallback when one is present", () => {
    render(<FlightItineraryDisplay segments={[segment({ airline: { name: "Cathay Pacific", iata: "CX", icao: "CPA", logoUrl: "https://cdn.example.com/custom.png" } })]} />);
    const img = screen.getByRole("img", { name: "Cathay Pacific" });
    expect(img).toHaveAttribute("src", "https://cdn.example.com/custom.png");
  });

  it("falls back to the boxed airline code (no image at all) when there is no airline reference row and no code to derive a CDN URL from", () => {
    render(<FlightItineraryDisplay segments={[segment({ airline: null, airlineCodeRaw: null })]} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

describe("FlightItineraryDisplay — itinerary rendering", () => {
  it("renders departure and arrival airport city/code for a single segment", () => {
    render(<FlightItineraryDisplay segments={[segment({})]} />);
    expect(screen.getByText("Rome")).toBeInTheDocument();
    expect(screen.getByText("Manila")).toBeInTheDocument();
    expect(screen.getByText("(FCO)")).toBeInTheDocument();
    expect(screen.getByText("(MNL)")).toBeInTheDocument();
  });

  it("groups a multi-city itinerary into separate labeled legs (Flight 1 / Flight 2), each with its own route summary", () => {
    const segments = [
      segment({ id: "seg-1", connectionType: null, departureAirport: { iata: "FRA", name: "Frankfurt", city: "Frankfurt" }, arrivalAirport: { iata: "JFK", name: "JFK", city: "New York" } }),
      segment({ id: "seg-2", connectionType: "MULTI_CITY", departureAirport: { iata: "JFK", name: "JFK", city: "New York" }, arrivalAirport: { iata: "LAX", name: "LAX", city: "Los Angeles" } }),
    ];
    render(<FlightItineraryDisplay segments={segments} />);
    expect(screen.getByText("Flight 1")).toBeInTheDocument();
    expect(screen.getByText("Flight 2")).toBeInTheDocument();
  });

  it("marks a cancelled segment with a visible warning rather than rendering it as a normal, bookable flight", () => {
    render(
      <FlightItineraryDisplay
        segments={[segment({ id: "seg-cancelled" })]}
        cancelledSegmentIds={new Set(["seg-cancelled"])}
        cancellationState="cancelled"
      />
    );
    expect(screen.getAllByText(/cancel/i).length).toBeGreaterThan(0);
  });

  it("marks a scheduled-for-cancellation segment as pending, never claiming it is already cancelled", () => {
    render(
      <FlightItineraryDisplay
        segments={[segment({ id: "seg-pending" })]}
        cancelledSegmentIds={new Set(["seg-pending"])}
        cancellationState="scheduled"
      />
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/this flight has been cancelled/i);
  });
});

describe("FlightItineraryDisplay — Total Journey Summary & duration terminology (Pass 11 Part 2)", () => {
  it("a nonstop segment shows a 'Nonstop' badge and never a fake Connection block", () => {
    render(<FlightItineraryDisplay segments={[segment({})]} />);
    expect(screen.getByText("Nonstop")).toBeInTheDocument();
    expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  });

  it("labels the per-segment figure 'Flight duration', distinct from the group's 'total journey time'", () => {
    render(<FlightItineraryDisplay segments={[segment({})]} />);
    expect(screen.getByText("Flight duration")).toBeInTheDocument();
    expect(screen.getByText(/total journey time/)).toBeInTheDocument();
  });

  it("a two-segment connecting itinerary shows a Connection block (not 'Layover') AND both legs' own Flight duration — never just the first flight's duration for the whole journey", () => {
    const segments = [
      segment({
        id: "seg-1",
        connectionType: null,
        durationMinutes: 8 * 60 + 45, // 525
        departureAt: new Date("2026-10-13T19:30:00Z"),
        departureAirport: { iata: "ATL", name: "Atlanta", city: "Atlanta", timezone: "America/New_York" },
        arrivalAt: new Date("2026-10-14T10:15:00Z"),
        arrivalAirport: { iata: "CPH", name: "Copenhagen", city: "Copenhagen", timezone: "Europe/Copenhagen" },
      }),
      segment({
        id: "seg-2",
        connectionType: "LAYOVER",
        durationMinutes: 2 * 60, // 120
        departureAt: new Date("2026-10-14T15:00:00Z"),
        departureAirport: { iata: "CPH", name: "Copenhagen", city: "Copenhagen", timezone: "Europe/Copenhagen" },
        arrivalAt: new Date("2026-10-14T16:00:00Z"),
        arrivalAirport: { iata: "LHR", name: "Heathrow", city: "London", timezone: "Europe/London" },
      }),
    ];
    render(<FlightItineraryDisplay segments={segments} />);

    // Both legs' own Flight duration figures are present (8h45 and 2h0),
    // never collapsed into a single number for the whole journey.
    expect(screen.getByText("8h 45m")).toBeInTheDocument();
    expect(screen.getByText("2h 0m")).toBeInTheDocument();

    // The Connection block (4h45 layover), timezone-aware, not the naive
    // same-zone subtraction the old code used.
    expect(screen.getByText("Connection")).toBeInTheDocument();
    expect(screen.getByText(/4h 45m layover in Copenhagen/)).toBeInTheDocument();

    // The Total Journey Summary shows the correct 15h30 total — exactly
    // the spec's own worked example — computed via calculateJourneyDuration,
    // never by naively subtracting displayed strings.
    expect(screen.getByText("15h 30m")).toBeInTheDocument();
    expect(screen.getByText(/total journey time/)).toBeInTheDocument();
    expect(screen.getByText(/1 connection · Copenhagen/)).toBeInTheDocument();

    // Route summary in the Total Journey Summary header.
    expect(screen.getByText(/Atlanta \(ATL\) → London \(LHR\)/)).toBeInTheDocument();
  });
});

describe("FlightItineraryDisplay — multi-city journey groups get separate totals (Pass 12 §22/§23)", () => {
  it("a Multi City segment starts a brand new journey group with its OWN total journey time, never combined with the previous group's", () => {
    const segments = [
      segment({
        id: "g1",
        connectionType: null,
        durationMinutes: 8 * 60,
        departureAt: new Date("2026-10-13T19:00:00Z"),
        departureAirport: { iata: "ATL", name: "Atlanta", city: "Atlanta", timezone: "America/New_York" },
        arrivalAt: new Date("2026-10-14T07:00:00Z"),
        arrivalAirport: { iata: "LHR", name: "Heathrow", city: "London", timezone: "Europe/London" },
      }),
      segment({
        id: "g2-1",
        connectionType: "MULTI_CITY",
        durationMinutes: 110,
        departureAt: new Date("2026-10-20T09:00:00Z"),
        departureAirport: { iata: "LHR", name: "Heathrow", city: "London", timezone: "Europe/London" },
        arrivalAt: new Date("2026-10-20T11:50:00Z"),
        arrivalAirport: { iata: "CPH", name: "Copenhagen", city: "Copenhagen", timezone: "Europe/Copenhagen" },
      }),
      segment({
        id: "g2-2",
        connectionType: "LAYOVER",
        durationMinutes: 9 * 60 + 55,
        departureAt: new Date("2026-10-20T14:55:00Z"),
        departureAirport: { iata: "CPH", name: "Copenhagen", city: "Copenhagen", timezone: "Europe/Copenhagen" },
        arrivalAt: new Date("2026-10-20T18:50:00Z"),
        arrivalAirport: { iata: "ATL", name: "Atlanta", city: "Atlanta", timezone: "America/New_York" },
      }),
    ];
    render(<FlightItineraryDisplay segments={segments} />);

    expect(screen.getByText("Flight 1")).toBeInTheDocument();
    expect(screen.getByText("Flight 2")).toBeInTheDocument();
    // Group 2's own independently-calculated total (the 14h50 worked example).
    expect(screen.getByText("14h 50m")).toBeInTheDocument();
    // The combined (wrong) figure must never appear.
    expect(screen.queryByText("26h 50m")).not.toBeInTheDocument();
  });
});

describe("FlightItineraryDisplay — automated axe-core scan", () => {
  it("has no automatically-detectable accessibility violations for a two-segment itinerary", async () => {
    const { container } = render(
      <FlightItineraryDisplay
        segments={[
          segment({ id: "seg-1" }),
          segment({ id: "seg-2", departureAirport: { iata: "MNL", name: "Ninoy Aquino Intl", city: "Manila" }, arrivalAirport: { iata: "FCO", name: "Leonardo da Vinci", city: "Rome" } }),
        ]}
      />
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  }, 15000);
});
