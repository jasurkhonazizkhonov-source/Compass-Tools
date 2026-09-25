// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 13 §36/§37 — BookingFlow (reused for both a first-time booking and
// an approved exchange's own signing step) now accepts `previousPassengers`
// to prefill the passenger form from the customer's last charged booking.
// Prefilled ≠ locked (§34) — every field must remain a normal, editable
// input, never read-only.

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

describe("BookingFlow — passenger prefill (Pass 13 §36/§37)", () => {
  it("prefills the passenger form fields from previousPassengers, matched by type/order", () => {
    renderBookingFlow({
      previousPassengers: [
        {
          firstName: "Larry",
          middleName: null,
          lastName: "Mehaffey",
          type: "ADULT",
          dateOfBirth: new Date("1985-03-15T00:00:00Z"),
          gender: "MALE",
          tsaKnownTravelerNumber: "12345678",
          globalEntryNumber: "98765432",
        },
      ],
    });

    expect(screen.getByDisplayValue("Larry")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mehaffey")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12345678")).toBeInTheDocument();
    expect(screen.getByDisplayValue("98765432")).toBeInTheDocument();
  });

  it("prefilled fields remain fully editable — not disabled/readOnly", () => {
    renderBookingFlow({
      previousPassengers: [
        { firstName: "Larry", middleName: null, lastName: "Mehaffey", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null },
      ],
    });
    const firstNameInput = screen.getByDisplayValue("Larry") as HTMLInputElement;
    expect(firstNameInput.disabled).toBe(false);
    expect(firstNameInput.readOnly).toBe(false);
  });

  it("a brand-new customer (no previousPassengers) still gets the existing blank-form behavior, unaffected", () => {
    renderBookingFlow();
    expect(screen.queryByDisplayValue("Larry")).not.toBeInTheDocument();
  });

  it("only pairs previous passengers with the SAME passenger type — an ADULT's info never lands on a CHILD/INFANT slot", () => {
    renderBookingFlow({
      adults: 1,
      childrenCount: 1,
      previousPassengers: [
        { firstName: "AdultOnly", middleName: null, lastName: "Traveler", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null },
      ],
    });
    expect(screen.getByDisplayValue("AdultOnly")).toBeInTheDocument();
    // Exactly one prefilled first-name field — the child slot stays blank.
    const firstNameFields = screen.getAllByDisplayValue("AdultOnly");
    expect(firstNameFields).toHaveLength(1);
  });
});
