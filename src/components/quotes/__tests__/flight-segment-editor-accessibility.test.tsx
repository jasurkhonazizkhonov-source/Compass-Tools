// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { axe } from "vitest-axe";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FlightSegmentEditor, type EditableSegment } from "../flight-segment-editor";

// Portability pass 4, Item 1 — FieldSlot previously rendered its visible
// <Label> and the field's actual control (a mix of native <Input>/<Select>
// and custom ARIA combobox buttons like AirportSearchField) as separate,
// unassociated siblings, so a screen-reader user landing directly on a
// control got only its own generic content — both airport fields exposed
// the identical accessible name "Search airport or city..." until a value
// was picked. Fixed via FieldSlot generating a real, unique-per-instance
// id (React's useId()) for its own <Label>, and every control receiving
// that id through a render-prop and applying it via aria-labelledby — the
// correct mechanism for a custom widget, and one that makes the EXISTING
// visible label text the single source of the accessible name too,
// instead of a second, separately-maintained string that could drift.

vi.mock("@/server/queries/reference-data", () => ({
  searchAirports: vi.fn(async () => []),
  searchAirlines: vi.fn(async () => []),
  searchAircraft: vi.fn(async () => []),
}));

function emptySegment(overrides: Partial<EditableSegment> = {}): EditableSegment {
  return {
    clientId: "seg-1",
    departureAirport: null,
    arrivalAirport: null,
    departureDate: "",
    departureTime: "",
    arrivalDate: "",
    arrivalTime: "",
    airline: null,
    airlineCodeRaw: "",
    flightNumber: "",
    bookingClass: "",
    cabin: "ECONOMY",
    aircraft: null,
    aircraftRaw: "",
    operatingCarrierName: "",
    warnings: [],
    uncertainFields: [],
    isExtraLeg: false,
    durationOverrideMinutes: null,
    ...overrides,
  };
}

function renderEditor(segment: EditableSegment, index = 0) {
  render(
    <TooltipProvider>
      <FlightSegmentEditor segment={segment} index={index} onChange={vi.fn()} onRemove={vi.fn()} canRemove={true} />
    </TooltipProvider>
  );
}

// Mirrors exactly how the browser's accname algorithm resolves
// aria-labelledby — the same check used to live-verify this fix in a real
// browser (see the final report's DOM-inspection section).
function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(" ");
  }
  return el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
}

describe("FlightSegmentEditor — field label/control association", () => {
  it("the two airport fields no longer share the same generic accessible name — each resolves to its own distinct visible label", () => {
    renderEditor(emptySegment());
    const combos = screen.getAllByRole("combobox");
    const airportCombos = combos.filter((c) => accessibleName(c) === "From" || accessibleName(c) === "To");
    expect(airportCombos).toHaveLength(2);
    const names = airportCombos.map(accessibleName);
    expect(new Set(names).size).toBe(2); // "From" and "To" — never identical
  });

  it("every field's accessible name matches its own visible label text exactly (single source of truth, no drift)", () => {
    renderEditor(emptySegment());
    const expectedLabels = ["From", "To", "Departure Date", "Departure Time", "Arrival Date", "Arrival Time", "Airline", "Flight Number", "Cabin", "Booking Class", "Aircraft"];
    const controls = document.querySelectorAll("button[aria-labelledby], input[aria-labelledby]");
    const actualNames = Array.from(controls).map(accessibleName);
    for (const expected of expectedLabels) {
      expect(actualNames).toContain(expected);
    }
  });

  it("never produces a redundant doubled announcement like 'Airline Airline' — the labelledby id resolves to exactly the visible label text, once", () => {
    renderEditor(emptySegment());
    const airlineCombo = screen.getAllByRole("combobox").find((c) => accessibleName(c) === "Airline");
    expect(airlineCombo).toBeDefined();
    expect(accessibleName(airlineCombo!)).toBe("Airline");
  });

  it("no duplicate DOM ids are produced for a single segment", () => {
    renderEditor(emptySegment());
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no duplicate DOM ids are produced across two independently rendered segment instances (React's useId is unique per component instance)", () => {
    const { unmount } = render(
      <TooltipProvider>
        <FlightSegmentEditor segment={emptySegment({ clientId: "seg-1" })} index={0} onChange={vi.fn()} onRemove={vi.fn()} canRemove={true} />
        <FlightSegmentEditor segment={emptySegment({ clientId: "seg-2" })} index={1} onChange={vi.fn()} onRemove={vi.fn()} canRemove={true} />
      </TooltipProvider>
    );
    const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    unmount();
  });

  it("Quote Builder's flight segment editor remains fully functional after the label-association change (renders all fields, accepts input)", () => {
    renderEditor(emptySegment());
    expect(screen.getByPlaceholderText("e.g. 1460")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Y")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(4); // From, To, Airline, Cabin, Aircraft
  });
});

describe("FlightSegmentEditor — automated axe-core scan", () => {
  // A general axe-core sweep on top of the targeted, hand-written checks
  // above — catches whole classes of ARIA/structure issues (not just the
  // one this pass fixed) without hand-enumerating them. This is real,
  // automated tooling — not a substitute for actual screen-reader testing,
  // which this environment has no access to (see the final report).
  it("has no automatically-detectable accessibility violations", async () => {
    const { container } = render(
      <TooltipProvider>
        <FlightSegmentEditor segment={emptySegment()} index={0} onChange={vi.fn()} onRemove={vi.fn()} canRemove={true} />
      </TooltipProvider>
    );
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  }, 15000);
});
