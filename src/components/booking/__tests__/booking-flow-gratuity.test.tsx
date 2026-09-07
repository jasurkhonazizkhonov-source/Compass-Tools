// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { vi } from "vitest";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";
import { GRATUITY_PRESETS } from "@/lib/pricing";

// Expanded gratuity quick-select amounts ($25/$50/$100/$150/$200/$250/$300),
// replacing the previous $25/$50/$100 set — see src/lib/pricing.ts's
// GRATUITY_PRESETS, the single shared source rendered here and by the
// CRM's quote-builder.tsx/exchange-builder.tsx.

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

function renderBookingFlow() {
  return render(
    <CustomerThemeProvider>
      <BookingFlow {...BASE_PROPS} />
    </CustomerThemeProvider>
  );
}

// Gratuity's "Custom amount" <Label> isn't programmatically associated with
// its <Input> (no htmlFor/id) — same structural lookup already used by
// booking-flow-legal-agreement.test.tsx's own "First Name *" field.
function getCustomAmountInput(): HTMLInputElement {
  const label = screen.getByText("Custom amount");
  return label.parentElement!.querySelector("input") as HTMLInputElement;
}

describe("BookingFlow — Gratuity quick-select amounts", () => {
  it("has exactly 7 suggested amounts: $25/$50/$100/$150/$200/$250/$300", () => {
    expect(GRATUITY_PRESETS).toEqual([25, 50, 100, 150, 200, 250, 300]);
  });

  it("renders all 7 suggested-amount buttons", () => {
    renderBookingFlow();
    for (const amount of [25, 50, 100, 150, 200, 250, 300]) {
      expect(screen.getByRole("button", { name: `$${amount}.00` })).toBeInTheDocument();
    }
  });

  it("selecting a suggested amount sets the custom-amount input to match", async () => {
    const user = userEvent.setup();
    renderBookingFlow();
    await user.click(screen.getByRole("button", { name: "$150.00" }));
    expect(getCustomAmountInput()).toHaveValue(150);
  });

  it("the custom-amount input still accepts an arbitrary value", async () => {
    const user = userEvent.setup();
    renderBookingFlow();
    const customInput = getCustomAmountInput();
    await user.clear(customInput);
    await user.type(customInput, "42");
    expect(customInput).toHaveValue(42);
  });
});
