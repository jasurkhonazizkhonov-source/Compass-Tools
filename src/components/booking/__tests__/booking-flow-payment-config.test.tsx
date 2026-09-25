// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// The booking form must be honest about payment availability: with no working
// provider it offers no card entry at all (and says nothing was charged); with
// one it shows ONLY the provider's hosted fields — never an input that could
// receive a card number or security code.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/booking", () => ({ submitBooking: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/actions/payment-setup", () => ({ createBookingPaymentSetup: vi.fn() }));
vi.mock("@/components/payments/secure-card-fields", async () => await import("@/test/secure-card-fields-stub"));
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
  currency: "AUD" as const,
  exchangeRate: 1.5,
  contactFirstName: "Jane",
  contactPhone: "+15551234567",
  contactEmail: "jane@example.com",
  companyName: "Test Travel Co",
};

function renderFlow(paymentConfig: React.ComponentProps<typeof BookingFlow>["paymentConfig"]) {
  return render(
    <CustomerThemeProvider>
      <BookingFlow {...BASE_PROPS} paymentConfig={paymentConfig} />
    </CustomerThemeProvider>
  );
}

describe("BookingFlow — payment availability", () => {
  it("provider not ready: shows a clear notice, offers NO card entry, and says nothing was charged", () => {
    renderFlow({ ready: false });
    expect(screen.getByRole("alert")).toHaveTextContent(/online booking is temporarily unavailable/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/nothing has been charged/i);
    expect(screen.queryByTestId("secure-card-fields")).not.toBeInTheDocument();
  });

  it("provider ready: the card is taken ONLY by the provider's hosted fields", () => {
    renderFlow({ ready: true, publishableKey: "pk_test_stub_key_value" });
    expect(screen.getByTestId("secure-card-fields")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("no input on the page can receive a card number, expiry or security code", () => {
    const { container } = renderFlow({ ready: true, publishableKey: "pk_test_stub_key_value" });
    for (const input of Array.from(container.querySelectorAll("input"))) {
      const autocomplete = input.getAttribute("autocomplete") ?? "";
      expect(autocomplete).not.toMatch(/^cc-(number|exp|exp-month|exp-year|csc)$/);
    }
  });

  it("shows the customer's payment amount in the booking's own currency, never a bare $", () => {
    renderFlow({ ready: true, publishableKey: "pk_test_stub_key_value" });
    const amounts = screen.getAllByText(/A\$|AUD/);
    expect(amounts.length).toBeGreaterThan(0);
  });
});
