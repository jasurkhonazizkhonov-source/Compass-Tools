// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Note author + timestamp: two lines (author in bold, then the exact date and time), in the CRM's Pacific business zone, on every note
// display - and the notes themselves (body, add, edit, delete) behave as before.

const addNote = vi.fn(async () => undefined);
const updateNote = vi.fn(async () => undefined);
const deleteNote = vi.fn(async () => undefined);
vi.mock("@/server/actions/leads", () => ({ addNote: (...a: unknown[]) => addNote(...(a as [])), updateNote: (...a: unknown[]) => updateNote(...(a as [])), deleteNote: (...a: unknown[]) => deleteNote(...(a as [])) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/server/actions/contact-inquiries", () => ({ markInquiryRead: vi.fn(async () => undefined), updateInquiryStatus: vi.fn(async () => undefined), addInquiryNote: vi.fn(async () => undefined) }));
vi.mock("@/components/get-in-touch/inquiry-email-composer-dialog", () => ({ InquiryEmailComposerButton: () => null }));

const { NoteMeta, formatNoteTimestamp } = await import("../note-meta");
const { NotesPanel } = await import("../notes-panel");
const { InquiryDetailPanel } = await import("@/components/get-in-touch/inquiry-detail-panel");

const NOV5 = new Date("2026-11-05T17:45:00Z"); // 9:45 AM Pacific (PST)

describe("formatNoteTimestamp", () => {
  it("is 'MMM D, YYYY h:mm AM/PM' in Pacific time, whatever zone the server or browser is in", () => {
    expect(formatNoteTimestamp(NOV5)).toBe("Nov 5, 2026 9:45 AM");
    expect(formatNoteTimestamp(new Date("2026-07-04T19:05:00Z"))).toBe("Jul 4, 2026 12:05 PM"); // daylight time (PDT, UTC-7)
    expect(formatNoteTimestamp(new Date("2026-11-06T08:00:00Z"))).toBe("Nov 6, 2026 12:00 AM"); // Pacific midnight
    expect(formatNoteTimestamp(new Date("2026-11-06T07:59:00Z"))).toBe("Nov 5, 2026 11:59 PM"); // the previous Pacific day
    expect(formatNoteTimestamp("2026-11-05T17:45:00Z")).toBe("Nov 5, 2026 9:45 AM");
  });
  it("returns null, never a made-up time, for a missing or invalid value", () => {
    for (const bad of [null, undefined, "", "not a date", new Date("nope")]) expect(formatNoteTimestamp(bad as never), String(bad)).toBeNull();
  });
});

describe("NoteMeta", () => {
  it("shows the author in bold on the first line and the full date and time on the second", () => {
    render(<NoteMeta authorName="Tom Anderson" createdAt={NOV5} />);
    const meta = screen.getByTestId("note-meta");
    const lines = Array.from(meta.querySelectorAll("p"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Tom Anderson");
    expect(lines[0].className).toMatch(/font-semibold/);
    expect(lines[1]).toHaveTextContent("Nov 5, 2026 9:45 AM");
    expect(lines[1].className).not.toMatch(/font-semibold|font-bold/);
    expect(meta.textContent).not.toMatch(/ago|·/); // no relative-only time and no "Name · time" one-liner
    expect(within(meta).getByText("Nov 5, 2026 9:45 AM").closest("time")).toHaveAttribute("datetime", "2026-11-05T17:45:00.000Z");
  });

  it("uses honest fallbacks when the author or the time is missing", () => {
    const { rerender } = render(<NoteMeta authorName={null} createdAt={NOV5} />);
    expect(screen.getByTestId("note-author")).toHaveTextContent("Unknown author");
    rerender(<NoteMeta authorName="   " createdAt={NOV5} />);
    expect(screen.getByTestId("note-author")).toHaveTextContent("Unknown author");
    rerender(<NoteMeta authorName="Tom Anderson" createdAt={null} />);
    expect(screen.getByTestId("note-timestamp")).toHaveTextContent("Date unavailable");
    expect(screen.getByTestId("note-timestamp").querySelector("time")).toBeNull();
    rerender(<NoteMeta authorName="Tom Anderson" createdAt={new Date("invalid")} />);
    expect(screen.getByTestId("note-timestamp")).toHaveTextContent("Date unavailable");
  });
});

const NOTES = [
  { id: "n1", body: "Called the customer - wants a window seat.\nWill follow up Friday.", createdAt: NOV5, author: { fullName: "Tom Anderson" } },
  { id: "n2", body: "Second note", createdAt: new Date("2026-10-24T22:30:00Z"), author: null },
];

describe("NotesPanel", () => {
  beforeEach(() => {
    addNote.mockClear();
    updateNote.mockClear();
    deleteNote.mockClear();
  });

  it("shows each note's author and exact time on two lines and keeps the note text exactly as written", () => {
    render(<NotesPanel leadId="L1" notes={NOTES} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByTestId("note-author")).toHaveTextContent("Tom Anderson");
    expect(within(items[0]).getByTestId("note-timestamp")).toHaveTextContent("Nov 5, 2026 9:45 AM");
    expect(items[0].textContent).toContain("Called the customer - wants a window seat.");
    expect(within(items[0]).getByText(/Called the customer/).textContent).toBe(NOTES[0].body);
    expect(within(items[1]).getByTestId("note-author")).toHaveTextContent("Unknown author");
    expect(within(items[1]).getByTestId("note-timestamp")).toHaveTextContent("Oct 24, 2026 3:30 PM");
    expect(document.body.textContent).not.toMatch(/\bago\b/);
  });

  it("creating a note still calls the same action with the same arguments", async () => {
    const user = userEvent.setup();
    render(<NotesPanel contactId="C1" leadId="L1" notes={[]} />);
    await user.type(screen.getByPlaceholderText("Add a note..."), "  New note  ");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(addNote).toHaveBeenCalledWith({ contactId: "C1", leadId: "L1", body: "New note" }));
  });

  it("editing a note still saves through updateNote", async () => {
    const user = userEvent.setup();
    render(<NotesPanel leadId="L1" notes={NOTES} />);
    await user.click(screen.getAllByRole("button", { name: "Edit note" })[0]);
    const box = screen.getByDisplayValue(/Called the customer/);
    await user.clear(box);
    await user.type(box, "Edited");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(updateNote).toHaveBeenCalledWith("n1", "Edited", { contactId: undefined, leadId: "L1" }));
  });

  it("deleting a note still asks first, then calls deleteNote", async () => {
    const user = userEvent.setup();
    render(<NotesPanel leadId="L1" notes={NOTES} />);
    await user.click(screen.getAllByRole("button", { name: "Delete note" })[1]);
    expect(deleteNote).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete note" }));
    await waitFor(() => expect(deleteNote).toHaveBeenCalledWith("n2", { contactId: undefined, leadId: "L1" }));
  });

  it("keeps the original note order", () => {
    render(<NotesPanel leadId="L1" notes={[NOTES[1], NOTES[0]]} />);
    const authors = screen.getAllByTestId("note-author").map((n) => n.textContent);
    expect(authors).toEqual(["Unknown author", "Tom Anderson"]);
  });
});

describe("Inquiry internal notes use the same two-line format", () => {
  it("shows the author in bold and the exact time on the next line", () => {
    render(<InquiryDetailPanel inquiryId="i1" source="CRM_WEBSITE" status="NEW" readAt={new Date()} email="a@example.test" phone={null} contactName="Pat" notes={[{ id: "x", body: "Inquiry note", createdAt: NOV5, author: { fullName: "Tom Anderson" } }]} />);
    const meta = screen.getByTestId("note-meta");
    expect(within(meta).getByTestId("note-author")).toHaveTextContent("Tom Anderson");
    expect(within(meta).getByTestId("note-timestamp")).toHaveTextContent("Nov 5, 2026 9:45 AM");
    expect(screen.getByText("Inquiry note")).toBeInTheDocument();
  });
});
