// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BookingInformationCard, type BookingInformationCardProps } from "../booking-information-card";

// The disabled Send/Resend button is wrapped in a Tooltip (for its
// explanatory reason) — needs a TooltipProvider ancestor, same pattern
// flight-segment-duration.test.tsx already uses for the same primitive.
function renderCard(props: BookingInformationCardProps) {
  return render(
    <TooltipProvider>
      <BookingInformationCard {...props} />
    </TooltipProvider>
  );
}

// New, read-only "Booking Information" panel on the Quote detail page — a
// display-only mirror of the Booking detail page's own Ticketing card
// (BookingTicketingForm's locked view), with the one interactive exception
// of Send/Resend Airline Confirmation, which calls the same canonical
// sendAirlineConfirmationEmail server action.

const { sendAirlineConfirmationEmail } = vi.hoisted(() => ({
  sendAirlineConfirmationEmail: vi.fn(async () => {}),
}));
vi.mock("@/server/actions/bookings", () => ({ sendAirlineConfirmationEmail }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

const baseProps = {
  bookingId: "b1",
  pnr: "ABCDEF",
  status: "TICKETED" as const,
  fareAmount: 500,
  taxAmount: 75.5,
  serviceFeeAmount: 25,
  profitAmount: 120.25,
  internalNotes: "Supplier confirmed via phone",
  hasSentConfirmationBefore: false,
};

describe("BookingInformationCard — read-only display", () => {
  it("renders PNR, Ticket Status, and the USD-formatted internal money fields for a single confirmation", () => {
    renderCard({
      ...baseProps,
      confirmations: [{ id: "c1", airlineName: "Delta Air Lines", confirmationNumber: "XYZ123", eTicketNumbers: [] }],
    });

    expect(screen.getByText("ABCDEF")).toBeInTheDocument();
    expect(screen.getByText("Delta Air Lines — XYZ123")).toBeInTheDocument();
    expect(screen.getByText("Ticketed")).toBeInTheDocument(); // BOOKING_STATUS_META label
    // Internal-USD-tracking fields (Pass 22) — formatted via formatMoney(value, "USD").
    expect(screen.getByText("$500.00")).toBeInTheDocument();
    expect(screen.getByText("$75.50")).toBeInTheDocument();
    expect(screen.getByText("$25.00")).toBeInTheDocument();
    expect(screen.getByText("$120.25")).toBeInTheDocument();
    expect(screen.getByText("Supplier confirmed via phone")).toBeInTheDocument();
    // Read-only — no inputs, no Save button anywhere on this card.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("renders one row per entry for multiple airline confirmations, each with its own e-ticket numbers", () => {
    renderCard({
      ...baseProps,
      confirmations: [
        { id: "c1", airlineName: "Delta Air Lines", confirmationNumber: "XYZ123", eTicketNumbers: ["0061234567890"] },
        { id: "c2", airlineName: null, confirmationNumber: "QRS999", eTicketNumbers: ["0061234567891", "0061234567892"] },
      ],
    });

    expect(screen.getByText("Airline Confirmation Numbers")).toBeInTheDocument();
    expect(screen.getByText("Delta Air Lines — XYZ123")).toBeInTheDocument();
    expect(screen.getByText("E-ticket: 0061234567890")).toBeInTheDocument();
    // No airline resolved for the second entry — shown with no name prefix.
    expect(screen.getByText("QRS999")).toBeInTheDocument();
    expect(screen.getByText("E-tickets: 0061234567891, 0061234567892")).toBeInTheDocument();
  });

  it("shows em dashes for PNR/Booking Notes/confirmations when nothing is set", () => {
    renderCard({ ...baseProps, pnr: null, internalNotes: null, confirmations: [] });
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(3); // PNR, confirmations, Booking Notes
  });
});

describe("BookingInformationCard — Send/Resend Airline Confirmation", () => {
  const ticketedWithConfirmation = {
    ...baseProps,
    confirmations: [{ id: "c1", airlineName: "Delta Air Lines", confirmationNumber: "XYZ123", eTicketNumbers: [] }],
  };

  it("shows 'Send Airline Confirmation' (first-send) when no confirmation has been sent yet, and calls the action with no resend flag", async () => {
    const user = userEvent.setup();
    renderCard({ ...ticketedWithConfirmation, hasSentConfirmationBefore: false });

    const button = screen.getByRole("button", { name: "Send Airline Confirmation" });
    expect(button).toBeEnabled();
    await user.click(button);

    expect(sendAirlineConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(sendAirlineConfirmationEmail).toHaveBeenCalledWith("b1", undefined);
    // Optimistic local flip — the button now reads "Resend" without a reload.
    expect(await screen.findByRole("button", { name: "Resend Airline Confirmation" })).toBeInTheDocument();
  });

  it("shows 'Resend Airline Confirmation' when a confirmation was already sent, and calls the action with { resend: true }", async () => {
    const user = userEvent.setup();
    renderCard({ ...ticketedWithConfirmation, hasSentConfirmationBefore: true });

    const button = screen.getByRole("button", { name: "Resend Airline Confirmation" });
    await user.click(button);

    expect(sendAirlineConfirmationEmail).toHaveBeenCalledWith("b1", { resend: true });
  });

  it("disables the button (with an explanatory tooltip) when the ticket status isn't Ticketed/Confirmed", () => {
    renderCard({ ...ticketedWithConfirmation, status: "PENDING_TICKETING" });
    expect(screen.getByRole("button", { name: "Send Airline Confirmation" })).toBeDisabled();
  });

  it("disables the button when there is no airline confirmation number on file", () => {
    renderCard({ ...baseProps, confirmations: [], status: "TICKETED" });
    expect(screen.getByRole("button", { name: "Send Airline Confirmation" })).toBeDisabled();
  });

  it("surfaces a failure from the server action as an error toast rather than throwing", async () => {
    const { toast } = await import("sonner");
    sendAirlineConfirmationEmail.mockRejectedValueOnce(new Error("This booking has no customer email on file"));
    const user = userEvent.setup();
    renderCard({ ...ticketedWithConfirmation, hasSentConfirmationBefore: false });

    await user.click(screen.getByRole("button", { name: "Send Airline Confirmation" }));

    expect(await screen.findByRole("button", { name: "Send Airline Confirmation" })).toBeInTheDocument(); // stays "Send" — not optimistically flipped on failure
    expect(toast.error).toHaveBeenCalledWith("This booking has no customer email on file");
  });
});
