// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { QuoteInternalNotesEditor } from "../quote-internal-notes-editor";

// Pass 13 §5 — Internal Notes must lock into a read-only state once saved,
// with a separate explicit Edit action, never silently overwritable, and
// never customer-facing (unchanged privacy guarantee).

const { updateQuoteInternalNotes } = vi.hoisted(() => ({
  updateQuoteInternalNotes: vi.fn(async () => {}),
}));
vi.mock("@/server/actions/quotes", () => ({ updateQuoteInternalNotes }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QuoteInternalNotesEditor — locked/edit state (Pass 13 §5)", () => {
  it("a brand-new quote (nothing saved yet) opens directly in the editable state", () => {
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes={null} netTicketCost={null} />);
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("a quote with previously-saved notes opens LOCKED (read-only), showing the saved value with an Edit button", () => {
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes="Supplier: XYZ" netTicketCost={450.5} />);
    expect(screen.getByText("Supplier: XYZ")).toBeInTheDocument();
    expect(screen.getByText("$450.50")).toBeInTheDocument();
    expect(screen.queryByLabelText("Notes")).not.toBeInTheDocument(); // no editable textarea while locked
    expect(screen.getByRole("button", { name: "Edit internal notes" })).toBeInTheDocument();
  });

  it("clicking Edit unlocks the fields for editing", async () => {
    const user = userEvent.setup();
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes="Supplier: XYZ" netTicketCost={450.5} />);
    await user.click(screen.getByRole("button", { name: "Edit internal notes" }));
    expect(screen.getByLabelText("Notes")).toBeInTheDocument();
    expect(screen.getByLabelText("Notes")).toHaveValue("Supplier: XYZ");
  });

  it("saving relocks the fields back into the read-only state", async () => {
    const user = userEvent.setup();
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes="Old note" netTicketCost={100} />);
    await user.click(screen.getByRole("button", { name: "Edit internal notes" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("button", { name: "Edit internal notes" })).toBeInTheDocument();
    expect(updateQuoteInternalNotes).toHaveBeenCalledTimes(1);
  });

  it("Cancel discards unsaved edits and re-locks without calling the save action", async () => {
    const user = userEvent.setup();
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes="Original" netTicketCost={100} />);
    await user.click(screen.getByRole("button", { name: "Edit internal notes" }));
    const textarea = screen.getByLabelText("Notes");
    await user.clear(textarea);
    await user.type(textarea, "Accidentally typed text");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateQuoteInternalNotes).not.toHaveBeenCalled();
    expect(screen.getByText("Original")).toBeInTheDocument(); // reverted, not the accidental text
  });

  it("never renders any customer-facing wrapper — this component's own text explicitly states it is staff-only", () => {
    render(<QuoteInternalNotesEditor quoteId="q1" internalNotes="Confidential note" netTicketCost={null} />);
    expect(screen.getByText(/never shown to the customer/i)).toBeInTheDocument();
  });
});
