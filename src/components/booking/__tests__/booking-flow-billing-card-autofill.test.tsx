// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 25 §7-9/§3-6 — billing-address and masked-card autofill selectors.
// The card selector's central security property: it must NEVER autofill
// (or even offer) the card number or CVV — only cardholder name + expiry,
// matching docs/PAYMENT_AUTOFILL_SECURITY.md.

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
  companyName: "Test Travel Co",
};

function renderBookingFlow(props: Partial<React.ComponentProps<typeof BookingFlow>> = {}) {
  return render(
    <CustomerThemeProvider>
      <BookingFlow {...BASE_PROPS} {...props} />
    </CustomerThemeProvider>
  );
}

const PREVIOUS_ADDRESS = { billingAddress: "123 Main St", billingApt: null, billingCity: "Springfield", billingState: "IL", billingZip: "62704", billingCountry: "United States" };
const PREVIOUS_CARD = { id: "pm-1", cardholderName: "Jane Traveler", last4: "4242", cardBrand: "Visa", expiryMonth: 12, expiryYear: 2028 };

describe("BookingFlow — previous billing address selector (Pass 25)", () => {
  it("no previous addresses: no selector shown", () => {
    renderBookingFlow({ previousBillingAddresses: [] });
    expect(screen.queryByLabelText(/autofill from a previous address/i)).not.toBeInTheDocument();
  });

  it("selecting a previous address populates every field, editable afterward", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousBillingAddresses: [PREVIOUS_ADDRESS] });
    const select = screen.getByLabelText(/autofill from a previous address/i);
    await user.click(select);
    await user.click(screen.getByRole("option", { name: /123 Main St/i }));

    const addressInput = screen.getByDisplayValue("123 Main St") as HTMLInputElement;
    expect(addressInput).toBeInTheDocument();
    expect(screen.getByDisplayValue("Springfield")).toBeInTheDocument();
    expect(addressInput.disabled).toBe(false);
    await user.clear(addressInput);
    await user.type(addressInput, "456 Other Ave");
    expect(screen.getByDisplayValue("456 Other Ave")).toBeInTheDocument();
  });
});

describe("BookingFlow — previous card selector (Pass 25) — masked-only, never the card number/CVV", () => {
  it("no previous cards: no selector shown", () => {
    renderBookingFlow({ previousPaymentMethods: [] });
    expect(screen.queryByLabelText(/autofill from a previously used card/i)).not.toBeInTheDocument();
  });

  it("offers the card only in masked form — brand, last4, cardholder, expiry — never the full number", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPaymentMethods: [PREVIOUS_CARD] });
    const select = screen.getByLabelText(/autofill from a previously used card/i);
    await user.click(select);
    expect(screen.getByRole("option", { name: /Visa ending in 4242/i })).toBeInTheDocument();
  });

  it("selecting a previous card autofills ONLY cardholder name and expiry — the card number field stays empty", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPaymentMethods: [PREVIOUS_CARD] });
    const select = screen.getByLabelText(/autofill from a previously used card/i);
    await user.click(select);
    await user.click(screen.getByRole("option", { name: /Visa ending in 4242/i }));

    expect(screen.getByDisplayValue("Jane Traveler")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2028")).toBeInTheDocument();
    // The card-number input must still be empty — never autofilled.
    expect(screen.getByPlaceholderText(/card number/i)).toHaveValue("");
  });

  it("tells the customer they still need to enter the card number and security code", () => {
    renderBookingFlow({ previousPaymentMethods: [PREVIOUS_CARD] });
    expect(screen.getByText(/still need to enter the full card number and security code/i)).toBeInTheDocument();
  });
});
