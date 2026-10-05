// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

type Load = {
  ok: true;
  recipients: Array<{ email: string; sources: Array<"booking-form" | "contact"> }>;
  defaultSelected: string[];
  hasSentBefore: boolean;
  sender: { fullName: string; email: string } | null;
};
const THREE: Load = {
  ok: true,
  recipients: [
    { email: "booking@example.com", sources: ["booking-form"] },
    { email: "primary@example.com", sources: ["contact"] },
    { email: "work@example.com", sources: ["contact"] },
  ],
  defaultSelected: ["booking@example.com"],
  hasSentBefore: false,
  sender: { fullName: "Andrew Kent", email: "andrew@example.com" },
};

const { sendAction, loadAction } = vi.hoisted(() => ({
  sendAction: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, sentTo: [] })),
  loadAction: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
}));
vi.mock("@/server/actions/bookings", () => ({ sendAirlineConfirmationEmail: sendAction, getAirlineConfirmationRecipients: loadAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AirlineConfirmationDialog } from "../airline-confirmation-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  loadAction.mockResolvedValue(THREE);
  sendAction.mockImplementation(async (_id: unknown, o: unknown) => ({ ok: true, sentTo: (o as { recipients: string[] }).recipients }));
});

async function open(sentBefore = false, onSent = vi.fn()) {
  const user = userEvent.setup();
  render(<AirlineConfirmationDialog bookingId="b1" sentBefore={sentBefore} onSent={onSent} />);
  await user.click(screen.getByRole("button", { name: sentBefore ? "Resend Airline Confirmation" : "Send Airline Confirmation" }));
  await screen.findByRole("checkbox", { name: "booking@example.com" });
  return { user, onSent };
}
const box = (email: string) => screen.getByRole("checkbox", { name: email });

describe("AirlineConfirmationDialog — recipient checkboxes", () => {
  it("loads the customer addresses for this booking and pre-selects only the signed booking-form address", async () => {
    await open();
    expect(loadAction).toHaveBeenCalledWith("b1");
    expect(box("booking@example.com")).toBeChecked();
    expect(box("primary@example.com")).not.toBeChecked();
    expect(box("work@example.com")).not.toBeChecked();
    expect(screen.getByText("1 of 3 selected", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Sent from Andrew Kent/)).toBeInTheDocument();
  });

  it("one address: sends exactly that one", async () => {
    const { user, onSent } = await open();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendAction).toHaveBeenCalledWith("b1", { resend: false, recipients: ["booking@example.com"] }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it("two addresses: ticking another adds it", async () => {
    const { user } = await open();
    await user.click(box("work@example.com"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendAction).toHaveBeenCalledWith("b1", { resend: false, recipients: expect.arrayContaining(["booking@example.com", "work@example.com"]) }));
    expect((sendAction.mock.calls[0][1] as { recipients: string[] }).recipients).toHaveLength(2);
  });

  it("Select all ticks every address; Select none clears them", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Select all" }));
    for (const e of ["booking@example.com", "primary@example.com", "work@example.com"]) expect(box(e)).toBeChecked();
    expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select none" }));
    for (const e of ["booking@example.com", "primary@example.com", "work@example.com"]) expect(box(e)).not.toBeChecked();
    expect(screen.getByText("No address selected", { exact: false })).toBeInTheDocument();
  });

  it("none selected: shows 'Select at least one email address.' and sends NOTHING", async () => {
    const { user } = await open();
    await user.click(box("booking@example.com")); // untick the default
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one email address.");
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("ticking an address clears the validation message", async () => {
    const { user } = await open();
    await user.click(box("booking@example.com"));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("alert");
    await user.click(box("primary@example.com"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Resend: the label says Resend, sends with resend: true, and uses the CURRENT selection", async () => {
    const { user } = await open(true);
    expect(screen.getByRole("heading", { name: "Resend Airline Confirmation" })).toBeInTheDocument();
    await user.click(box("booking@example.com"));
    await user.click(box("primary@example.com"));
    await user.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() => expect(sendAction).toHaveBeenCalledWith("b1", { resend: true, recipients: ["primary@example.com"] }));
  });

  it("re-opening the dialog starts again from the default — an earlier selection is not silently restored", async () => {
    const { user } = await open();
    await user.click(box("work@example.com"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "work@example.com" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Send Airline Confirmation" }));
    await screen.findByRole("checkbox", { name: "work@example.com" });
    expect(box("work@example.com")).not.toBeChecked();
    expect(box("booking@example.com")).toBeChecked();
  });

  it("a double-click on Send calls the server once", async () => {
    let release!: (v: unknown) => void;
    sendAction.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const { user } = await open();
    const send = screen.getByRole("button", { name: "Send" });
    await user.dblClick(send);
    expect(sendAction).toHaveBeenCalledTimes(1);
    release({ ok: true, sentTo: ["booking@example.com"] });
  });

  it("no address on file: says so, offers nothing to tick and cannot send", async () => {
    loadAction.mockResolvedValue({ ...THREE, recipients: [], defaultSelected: [] });
    const user = userEvent.setup();
    render(<AirlineConfirmationDialog bookingId="b1" sentBefore={false} onSent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Send Airline Confirmation" }));
    expect(await screen.findByText("This booking has no customer email on file.")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("a failed address load (e.g. not permitted) is a readable message, never a raw React error", async () => {
    loadAction.mockRejectedValue(new Error("Minified React error #441"));
    const user = userEvent.setup();
    render(<AirlineConfirmationDialog bookingId="b1" sentBefore={false} onSent={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Send Airline Confirmation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the customer's email addresses.");
    expect(document.body.textContent).not.toMatch(/Minified React error|#441/);
  });
});
