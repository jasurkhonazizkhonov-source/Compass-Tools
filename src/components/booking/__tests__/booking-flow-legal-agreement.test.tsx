// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 21 — Cancellation Policy + Terms & Conditions accordion, extending
// (not duplicating) the pre-existing termsAccepted checkbox/validation.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/server/actions/booking", () => ({ submitBooking: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/queries/reference-data", () => ({
  searchAirports: vi.fn(async () => []),
  searchAirlines: vi.fn(async () => []),
  searchAircraft: vi.fn(async () => []),
}));

const BASE_PROPS = {
  token: "test-token",
  segments: [],
  adults: 1,
  childrenCount: 0,
  infants: 0,
  adultPrice: 500,
  childPrice: 0,
  infantPrice: 0,
  taxes: 0,
  serviceFee: 0,
  currency: "USD" as const,
  exchangeRate: 1,
  contactFirstName: "Jane",
  contactPhone: "+15551234567",
  contactEmail: "jane@example.com",
  companyName: "Acme Travel Co",
  companyPhone: "+1 (555) 010-2000",
  companyWebsite: "https://acmetravel.example",
};

function renderBookingFlow(props: Partial<React.ComponentProps<typeof BookingFlow>> = {}) {
  return render(
    <CustomerThemeProvider>
      <BookingFlow {...BASE_PROPS} {...props} />
    </CustomerThemeProvider>
  );
}

describe("BookingFlow — Cancellation Policy & Terms & Conditions accordion (Pass 21)", () => {
  it("renders exactly one agreement checkbox referencing both the Cancellation Policy and Terms & Conditions", () => {
    renderBookingFlow();
    expect(screen.getAllByText(/I have read and agree to the Cancellation Policy and Terms & Conditions/i)).toHaveLength(1);
  });

  it("renders both accordion triggers, collapsed by default", () => {
    renderBookingFlow();
    const cancellationTrigger = screen.getByRole("button", { name: /cancellation policy/i });
    const termsTrigger = screen.getByRole("button", { name: /^terms & conditions$/i });
    expect(cancellationTrigger).toHaveAttribute("aria-expanded", "false");
    expect(termsTrigger).toHaveAttribute("aria-expanded", "false");
    // Content isn't in the DOM yet (or is visually hidden) before expansion.
    expect(screen.queryByText(/Standard Ticket Cancellation and Refunds/i)).not.toBeInTheDocument();
  });

  it("expanding one accordion via keyboard does not collapse the other (type=\"multiple\") and does not clear entered passenger data", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    // passenger-form.tsx's <Label> isn't programmatically associated with
    // its <Input> (no htmlFor/id) — match the existing booking-flow-prefill
    // test's own approach of locating fields structurally instead.
    const firstNameLabel = screen.getAllByText("First Name *")[0];
    const firstNameInput = firstNameLabel.parentElement!.querySelector("input") as HTMLInputElement;
    await user.type(firstNameInput, "Alex");

    const cancellationTrigger = screen.getByRole("button", { name: /cancellation policy/i });
    cancellationTrigger.focus();
    await user.keyboard("{Enter}");
    expect(cancellationTrigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText(/Standard Ticket Cancellation and Refunds/i)).toBeInTheDocument();

    const termsTrigger = screen.getByRole("button", { name: /^terms & conditions$/i });
    await user.click(termsTrigger);
    expect(termsTrigger).toHaveAttribute("aria-expanded", "true");
    // Opening the second panel doesn't close the first.
    expect(cancellationTrigger).toHaveAttribute("aria-expanded", "true");

    expect(firstNameInput.value).toBe("Alex");
  });

  it("interpolates the real configured company name/phone into the Cancellation Policy content — never a fictional placeholder company", async () => {
    const user = userEvent.setup();
    renderBookingFlow();
    await user.click(screen.getByRole("button", { name: /cancellation policy/i }));
    await screen.findByText(/Standard Ticket Cancellation and Refunds/i);
    expect(screen.getAllByText(/Acme Travel Co/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/TopBusinessClass/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/FirstClass Choice/i)).not.toBeInTheDocument();
  });
});
