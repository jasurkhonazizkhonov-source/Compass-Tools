// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 24/25 — the EXPLICIT "select a previous passenger" convenience for
// the new (non-exchange) booking form, distinct from the existing SILENT
// positional prefill already covered by booking-flow-prefill.test.tsx
// (that one auto-fills without any customer action; this one is an
// opt-in dropdown the customer must actively choose from). Selecting a
// previous passenger is only a convenience — every field must remain
// fully editable afterward, and the server-side authorization boundary
// (getPreviousPassengersForContact, scoped by token-derived contactId) is
// covered separately in the query's own test file, not re-tested here —
// this file only proves the CLIENT-SIDE selection/autofill/edit behavior.

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

const NIGORA = {
  firstName: "Nigora",
  middleName: null,
  lastName: "Dadabaeva",
  type: "ADULT" as const,
  dateOfBirth: new Date("1982-04-10T00:00:00Z"),
  gender: "FEMALE",
  tsaKnownTravelerNumber: "11112222",
  globalEntryNumber: null,
  frequentFlyerAirline: null,
  frequentFlyerNumber: "AA123456",
};
const JOHN = {
  firstName: "John",
  middleName: null,
  lastName: "Smith",
  type: "ADULT" as const,
  dateOfBirth: null,
  gender: null,
  tsaKnownTravelerNumber: null,
  globalEntryNumber: null,
  frequentFlyerAirline: null,
  frequentFlyerNumber: null,
};

describe("BookingFlow — previous-passenger selector (Pass 24/25)", () => {
  it("a customer with no previous passengers sees no selector at all", () => {
    renderBookingFlow({ previousPassengerOptions: [] });
    expect(screen.queryByLabelText(/autofill from a previous passenger/i)).not.toBeInTheDocument();
  });

  it("a customer with one previous passenger sees the selector, offering that one name", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPassengerOptions: [NIGORA] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    expect(screen.getByRole("option", { name: "Nigora Dadabaeva" })).toBeInTheDocument();
  });

  it("a customer with multiple previous passengers sees every one offered as a distinct option", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPassengerOptions: [NIGORA, JOHN] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    expect(screen.getByRole("option", { name: "Nigora Dadabaeva" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "John Smith" })).toBeInTheDocument();
  });

  it("selecting a previous passenger populates every available field", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPassengerOptions: [NIGORA] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Nigora Dadabaeva" }));

    expect(screen.getByDisplayValue("Nigora")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Dadabaeva")).toBeInTheDocument();
    expect(screen.getByDisplayValue("11112222")).toBeInTheDocument();
    expect(screen.getByDisplayValue("AA123456")).toBeInTheDocument();
  });

  it("a previous passenger with missing historical fields (no DOB, no gender, no KTN/GE) leaves those fields blank, not 'undefined'/'null'", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPassengerOptions: [JOHN] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "John Smith" }));

    expect(screen.getByDisplayValue("John")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("undefined")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("null")).not.toBeInTheDocument();
  });

  it("every autofilled field remains manually editable — not disabled/readOnly", async () => {
    const user = userEvent.setup();
    renderBookingFlow({ previousPassengerOptions: [NIGORA] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    await user.click(screen.getByRole("option", { name: "Nigora Dadabaeva" }));

    const firstNameInput = screen.getByDisplayValue("Nigora") as HTMLInputElement;
    expect(firstNameInput.disabled).toBe(false);
    expect(firstNameInput.readOnly).toBe(false);
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Corrected");
    expect(screen.getByDisplayValue("Corrected")).toBeInTheDocument();
  });

  it("two previous passengers with the same first name but different last names remain distinct, selectable options", async () => {
    const user = userEvent.setup();
    const secondNigora = { ...NIGORA, lastName: "Otherperson" };
    renderBookingFlow({ previousPassengerOptions: [NIGORA, secondNigora] });
    const select = screen.getByLabelText(/autofill from a previous passenger/i);
    await user.click(select);
    expect(screen.getByRole("option", { name: "Nigora Dadabaeva" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Nigora Otherperson" })).toBeInTheDocument();
  });

  it("the existing SILENT exchange prefill (previousPassengers) is unaffected by the presence/absence of previousPassengerOptions", () => {
    renderBookingFlow({
      previousPassengers: [{ firstName: "Larry", middleName: null, lastName: "Mehaffey", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null }],
      previousPassengerOptions: [],
    });
    // Silent prefill still applies even though the new selector has no options.
    expect(screen.getByDisplayValue("Larry")).toBeInTheDocument();
  });
});
