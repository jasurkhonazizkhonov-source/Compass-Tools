// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { LeadSegmentsEditor, type EditableSegment } from "../lead-segments-editor";

// The Travel Request section's multi-city editor: see every leg, add another,
// edit, remove (with confirmation), reorder, and save the whole list at once.

const { setLeadSegments } = vi.hoisted(() => ({ setLeadSegments: vi.fn(async () => ({ count: 0 })) }));
vi.mock("@/server/actions/leads", () => ({ setLeadSegments }));
vi.mock("@/server/queries/reference-data", () => ({ searchAirports: vi.fn(async () => []) }));

const ap = (id: number, iata: string, city: string) => ({ id, iata, name: `${city} Airport`, city, country: "X", timezone: null });
const JFK = ap(1, "JFK", "New York");
const LHR = ap(2, "LHR", "London");
const CDG = ap(3, "CDG", "Paris");

const THREE: EditableSegment[] = [
  { key: "a", from: JFK, to: LHR, date: "2026-10-20" },
  { key: "b", from: LHR, to: CDG, date: "2026-10-24" },
  { key: "c", from: CDG, to: JFK, date: "2026-10-30" },
];

beforeEach(() => vi.clearAllMocks());

describe("LeadSegmentsEditor", () => {
  it("shows every captured segment, in order, each with its own From / To / date", () => {
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={THREE} />);
    const items = screen.getAllByRole("listitem", { name: /Segment \d/ });
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByRole("combobox", { name: "Segment 1 from" })).toHaveTextContent("JFK");
    expect(within(items[0]).getByRole("combobox", { name: "Segment 1 to" })).toHaveTextContent("LHR");
    expect(within(items[1]).getByRole("combobox", { name: "Segment 2 from" })).toHaveTextContent("LHR");
    expect(within(items[2]).getByRole("combobox", { name: "Segment 3 to" })).toHaveTextContent("JFK");
    expect(screen.getByText("3 flight segments")).toBeInTheDocument();
  });

  it("'Add flight segment' appends a leg that starts where the previous one ended", async () => {
    const user = userEvent.setup();
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={THREE} />);
    await user.click(screen.getByRole("button", { name: /Add flight segment/i }));
    const items = screen.getAllByRole("listitem", { name: /Segment \d/ });
    expect(items).toHaveLength(4);
    expect(within(items[3]).getByRole("combobox", { name: "Segment 4 from" })).toHaveTextContent("JFK"); // previous leg's destination
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("removing a segment asks first; cancelling keeps it, confirming drops it (nothing is saved until Save)", async () => {
    const user = userEvent.setup();
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={THREE} />);

    await user.click(screen.getByRole("button", { name: "Remove segment 2" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove segment 2?" });
    expect(dialog).toHaveTextContent("The itinerary is only changed when you press Save itinerary.");
    expect(screen.getAllByRole("listitem", { name: /Segment \d/, hidden: true })).toHaveLength(3); // still there while asking (the page is inert behind the modal)
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getAllByRole("listitem", { name: /Segment \d/ })).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Remove segment 2" }));
    // The dialog's own button is the only one named exactly "Remove segment" (the row buttons carry the segment number).
    await user.click(screen.getByRole("button", { name: "Remove segment" }));
    expect(screen.getAllByRole("listitem", { name: /Segment \d/ })).toHaveLength(2);
    expect(setLeadSegments).not.toHaveBeenCalled(); // removing never saves the itinerary
  });

  it("the last remaining segment cannot be removed", async () => {
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={[THREE[0]]} />);
    expect(screen.getByRole("button", { name: "Remove segment 1" })).toBeDisabled();
  });

  it("segments can be moved up and down; the first cannot go up and the last cannot go down", async () => {
    const user = userEvent.setup();
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={THREE} />);
    expect(screen.getByRole("button", { name: "Move segment 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move segment 3 down" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move segment 1 down" }));
    expect(screen.getByRole("combobox", { name: "Segment 1 from" })).toHaveTextContent("LHR");
    expect(screen.getByRole("combobox", { name: "Segment 2 from" })).toHaveTextContent("JFK");
  });

  it("Save sends the whole list, in order, as ids and dates — and is disabled until something changed", async () => {
    const user = userEvent.setup();
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={THREE} />);
    expect(screen.getByRole("button", { name: "Save itinerary" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move segment 3 up" }));
    await user.click(screen.getByRole("button", { name: "Save itinerary" }));
    expect(setLeadSegments).toHaveBeenCalledTimes(1);
    expect(setLeadSegments).toHaveBeenCalledWith("lead-1", [
      { departureAirportId: 1, arrivalAirportId: 2, departureDate: "2026-10-20" },
      { departureAirportId: 3, arrivalAirportId: 1, departureDate: "2026-10-30" },
      { departureAirportId: 2, arrivalAirportId: 3, departureDate: "2026-10-24" },
    ]);
  });

  it("an empty seed still shows one blank segment to fill in", () => {
    render(<LeadSegmentsEditor leadId="lead-1" initialSegments={[]} />);
    expect(screen.getAllByRole("listitem", { name: /Segment \d/ })).toHaveLength(1);
  });
});
