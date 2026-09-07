// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FlightSegmentEditor, type EditableSegment } from "../flight-segment-editor";

// Pass 13 §3/§4/§58 — the itinerary builder's duration field is now an
// hours + minutes editor, never raw total minutes as the primary editing
// surface. Internally this remains exactly the same
// FlightSegment.durationMinutes/durationOverrideMinutes integer — see
// flight-segment-editor.tsx's own DurationHoursMinutesInput doc comment —
// so calculateJourneyDuration (Pass 11/12) is completely unaffected; these
// tests only exercise the conversion layer this pass added.

vi.mock("@/server/queries/reference-data", () => ({
  searchAirports: vi.fn(async () => []),
  searchAirlines: vi.fn(async () => []),
  searchAircraft: vi.fn(async () => []),
}));

function emptySegment(overrides: Partial<EditableSegment> = {}): EditableSegment {
  return {
    clientId: "seg-1",
    // Same timezone on both ends by default — keeps the "calculated"
    // duration tests hand-verifiable arithmetic (plain clock-time
    // subtraction), since timezone-aware calculation itself is already
    // covered by flight-duration.test.ts; these tests are about the
    // hours/minutes conversion layer, not re-proving the duration engine.
    departureAirport: { id: 1, iata: "ATL", icao: null, name: "Atlanta", city: "Atlanta", country: "United States", timezone: "America/New_York" } as never,
    arrivalAirport: { id: 2, iata: "MIA", icao: null, name: "Miami", city: "Miami", country: "United States", timezone: "America/New_York" } as never,
    departureDate: "2026-06-01",
    departureTime: "09:00",
    arrivalDate: "2026-06-01",
    arrivalTime: "17:45",
    airline: null,
    airlineCodeRaw: "",
    flightNumber: "930",
    bookingClass: "",
    cabin: "BUSINESS",
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

/** A thin stateful wrapper — matches how the real Quote/Exchange builders
 * actually use FlightSegmentEditor (onChange feeds back into the segment
 * that gets re-rendered), which real interactive typing/clearing depends
 * on: a bare `vi.fn()` onChange with no state update leaves the controlled
 * inputs frozen at their initial value between keystrokes. */
function renderEditor(initial: EditableSegment) {
  const onChangeSpy = vi.fn();
  function Wrapper() {
    const [segment, setSegment] = useState(initial);
    return (
      <TooltipProvider>
        <FlightSegmentEditor
          segment={segment}
          index={0}
          onChange={(next) => {
            onChangeSpy(next);
            setSegment(next);
          }}
          onRemove={vi.fn()}
          canRemove={true}
        />
      </TooltipProvider>
    );
  }
  render(<Wrapper />);
  return onChangeSpy;
}

describe("FlightSegmentEditor — duration hours/minutes editor (Pass 13 §3)", () => {
  it("a calculated 8h45m duration (09:00 -> 17:45, same timezone) displays as Hours=8, Minutes=45, labeled '(calculated)'", () => {
    renderEditor(emptySegment());
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(8);
    expect(screen.getByLabelText("Flight duration — minutes")).toHaveValue(45);
    expect(screen.getByText("(calculated)")).toBeInTheDocument();
  });

  it("0h 45m (a short hop) displays Hours=0, Minutes=45 — a zero-hour flight is not blank", () => {
    renderEditor(emptySegment({ departureTime: "09:00", arrivalTime: "09:45" }));
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(0);
    expect(screen.getByLabelText("Flight duration — minutes")).toHaveValue(45);
  });

  it("10h 05m displays Hours=10, Minutes=5 (not 10h 5m collapsed oddly, and not '605')", () => {
    renderEditor(emptySegment({ durationOverrideMinutes: 605 }));
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(10);
    expect(screen.getByLabelText("Flight duration — minutes")).toHaveValue(5);
    // Never shown as a bare, unlabeled total-minutes number anywhere.
    expect(screen.queryByText("605")).not.toBeInTheDocument();
  });

  it("a manual correction from 3h28m to 4h28m updates durationOverrideMinutes accordingly, and labels the field '(manually set)'", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 208 })); // 3h28m
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(3);
    expect(screen.getByLabelText("Flight duration — minutes")).toHaveValue(28);
    expect(screen.getByText("(manually set)")).toBeInTheDocument();

    const hoursInput = screen.getByLabelText("Flight duration — hours");
    await user.clear(hoursInput);
    await user.type(hoursInput, "4");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ durationOverrideMinutes: 4 * 60 + 28 }));
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(4);
  });

  it("a manual correction to the minutes field alone (3h28m -> 3h15m) preserves the hours", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 208 })); // 3h28m
    const minutesInput = screen.getByLabelText("Flight duration — minutes");
    await user.clear(minutesInput);
    await user.type(minutesInput, "15");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ durationOverrideMinutes: 3 * 60 + 15 }));
  });

  it("minutes are constrained to 0–59 — typing 75 clamps to 59, never a raw out-of-range value", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 180 })); // 3h0m
    const minutesInput = screen.getByLabelText("Flight duration — minutes");
    await user.clear(minutesInput);
    await user.type(minutesInput, "75");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as EditableSegment;
    expect(lastCall.durationOverrideMinutes).toBe(3 * 60 + 59); // clamped, not 3h75m/255
  });

  it("hours accepts a non-negative integer with no artificial low ceiling (a legitimate ultra-long-haul flight)", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 60 })); // 1h0m
    const hoursInput = screen.getByLabelText("Flight duration — hours");
    await user.clear(hoursInput);
    await user.type(hoursInput, "19");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as EditableSegment;
    expect(lastCall.durationOverrideMinutes).toBe(19 * 60);
  });

  it("clicking Reset to calculated clears the manual override back to null", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 999 }));
    await user.click(screen.getByRole("button", { name: "Reset to calculated duration" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ durationOverrideMinutes: null }));
    // Reverts the displayed value to the real calculated 8h45m from the
    // default fixture's departure/arrival times, not a blank/frozen field.
    expect(screen.getByLabelText("Flight duration — hours")).toHaveValue(8);
    expect(screen.getByLabelText("Flight duration — minutes")).toHaveValue(45);
    expect(screen.getByText("(calculated)")).toBeInTheDocument();
  });

  it("editing the departure/arrival date or time clears a manual override — never silently keeps a stale value", async () => {
    const user = userEvent.setup();
    const onChange = renderEditor(emptySegment({ durationOverrideMinutes: 999 }));
    const departureTimeInput = screen.getByLabelText("Departure Time");
    await user.clear(departureTimeInput);
    await user.type(departureTimeInput, "10:00");
    const calls = onChange.mock.calls.map((c) => (c[0] as EditableSegment).durationOverrideMinutes);
    expect(calls[calls.length - 1]).toBeNull();
  });

  it("never exposes a raw total-minutes number as the primary editing control", () => {
    renderEditor(emptySegment());
    expect(screen.queryByLabelText("Flight duration in minutes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Flight duration — hours")).toBeInTheDocument();
    expect(screen.getByLabelText("Flight duration — minutes")).toBeInTheDocument();
  });
});
