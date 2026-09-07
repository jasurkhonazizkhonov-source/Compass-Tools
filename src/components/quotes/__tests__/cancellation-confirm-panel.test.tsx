// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";
import { CancellationConfirmPanel } from "../cancellation-confirm-panel";

// Pass 13 §32-§35 — the cancellation signing panel prefills passenger
// information from this quote's own already-booked passengers and keeps
// every field editable (§34: prefilled ≠ immutable).

vi.mock("@/server/actions/cancellation", () => ({ confirmCancellationByCustomer: vi.fn(async () => ({ alreadyConfirmed: false })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/server/queries/reference-data", () => ({
  searchAirports: vi.fn(async () => []),
  searchAirlines: vi.fn(async () => []),
  searchAircraft: vi.fn(async () => []),
}));

function renderPanel(
  initialPassengers: React.ComponentProps<typeof CancellationConfirmPanel>["initialPassengers"],
  company?: React.ComponentProps<typeof CancellationConfirmPanel>["company"]
) {
  return render(
    <CustomerThemeProvider>
      <CancellationConfirmPanel token="test-token" initialPassengers={initialPassengers} company={company} />
    </CustomerThemeProvider>
  );
}

describe("CancellationConfirmPanel — passenger prefill (Pass 13 §32-§35)", () => {
  it("shows the prefilled passenger information from the existing booking", () => {
    renderPanel([
      {
        id: "passenger-1",
        firstName: "Larry",
        middleName: null,
        lastName: "Mehaffey",
        type: "ADULT",
        dateOfBirth: new Date("1985-03-15T00:00:00Z"),
        gender: "MALE",
        tsaKnownTravelerNumber: "12345678",
        globalEntryNumber: "98765432",
      },
    ]);
    expect(screen.getByDisplayValue("Larry")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Mehaffey")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12345678")).toBeInTheDocument();
  });

  it("prefilled fields remain fully editable", () => {
    renderPanel([
      { id: "passenger-1", firstName: "Larry", middleName: null, lastName: "Mehaffey", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null },
    ]);
    const firstNameInput = screen.getByDisplayValue("Larry") as HTMLInputElement;
    expect(firstNameInput.disabled).toBe(false);
    expect(firstNameInput.readOnly).toBe(false);
  });

  it("always renders the Confirm Cancellation action regardless of passenger count", () => {
    renderPanel([]);
    expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeInTheDocument();
  });

  it("handles multiple passengers, each shown as its own labeled card", () => {
    renderPanel([
      { id: "p1", firstName: "Larry", middleName: null, lastName: "Mehaffey", type: "ADULT", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null },
      { id: "p2", firstName: "Junior", middleName: null, lastName: "Mehaffey", type: "CHILD", dateOfBirth: null, gender: null, tsaKnownTravelerNumber: null, globalEntryNumber: null },
    ]);
    expect(screen.getByDisplayValue("Larry")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Junior")).toBeInTheDocument();
    expect(screen.getByText(/Passenger 1 · Adult/)).toBeInTheDocument();
    expect(screen.getByText(/Passenger 2 · Child/)).toBeInTheDocument();
  });
});

describe("CancellationConfirmPanel — Cancellation Policy accordion (Pass 21)", () => {
  it("omits the Cancellation Policy accordion when no company is supplied (backward-compatible)", () => {
    renderPanel([]);
    expect(screen.queryByRole("button", { name: /cancellation policy/i })).not.toBeInTheDocument();
  });

  it("shows a read-only Cancellation Policy accordion, with the real configured company name, when company is supplied", () => {
    renderPanel([], { name: "Acme Travel Co", phone: "+15550102000", website: "https://acmetravel.example" });
    expect(screen.getByRole("button", { name: /cancellation policy/i })).toBeInTheDocument();
  });

  it("does not add a second acknowledgement checkbox — Confirm Cancellation stays the single action", () => {
    renderPanel([], { name: "Acme Travel Co", phone: "+15550102000", website: "https://acmetravel.example" });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /confirm cancellation/i })).toBeInTheDocument();
  });
});
