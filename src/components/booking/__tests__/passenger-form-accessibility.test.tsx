// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { PassengerForm, type PassengerFormState } from "../passenger-form";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 22 — CONFIRMED accessibility gap, now fixed: every field in this
// form was a bare visual <Label> with no programmatic association to its
// control (no htmlFor/id, no aria-labelledby for the two custom-widget
// fields) — a screen-reader user tabbing through got no field name at
// all. These tests prove every field is now reachable by its accessible
// name via Testing Library's getByLabelText/getByRole (the same query a
// real screen reader's accessibility-tree lookup relies on), which fails
// for any field still missing a real label association.

vi.mock("@/server/queries/reference-data", () => ({
  searchAirlines: vi.fn(async () => []),
}));

function blankPassenger(overrides: Partial<PassengerFormState> = {}): PassengerFormState {
  return {
    clientId: "p1",
    type: "ADULT",
    firstName: "",
    middleName: "",
    lastName: "",
    dateOfBirth: "",
    gender: "",
    tsaKnownTravelerNumber: "",
    globalEntryNumber: "",
    frequentFlyerAirline: null,
    frequentFlyerNumber: "",
    ...overrides,
  };
}

function renderForm(index = 0) {
  return render(
    <CustomerThemeProvider>
      <PassengerForm passenger={blankPassenger()} index={index} onChange={() => {}} />
    </CustomerThemeProvider>
  );
}

describe("PassengerForm — every field has a real accessible name (Pass 22 fix)", () => {
  it("every native text input is reachable via its label text", () => {
    renderForm();
    expect(screen.getByLabelText("First Name *")).toBeInTheDocument();
    expect(screen.getByLabelText("Middle Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Last Name *")).toBeInTheDocument();
    expect(screen.getByLabelText("TSA PreCheck / Known Traveler #")).toBeInTheDocument();
    expect(screen.getByLabelText("Global Entry #")).toBeInTheDocument();
    expect(screen.getByLabelText("Frequent Flyer #")).toBeInTheDocument();
  });

  it("typing into the labeled First Name field actually reaches the real input (not a decoy element sharing the label text)", async () => {
    function StatefulWrapper() {
      const [passenger, setPassenger] = useState(blankPassenger());
      return (
        <CustomerThemeProvider>
          <PassengerForm passenger={passenger} index={0} onChange={setPassenger} />
        </CustomerThemeProvider>
      );
    }
    const user = userEvent.setup();
    render(<StatefulWrapper />);
    const firstName = screen.getByLabelText("First Name *");
    await user.type(firstName, "Jane");
    expect((firstName as HTMLInputElement).value).toBe("Jane");
  });

  it("the Gender select trigger is reachable via its label text (aria-invalid combobox role)", () => {
    renderForm();
    expect(screen.getByLabelText("Gender *")).toBeInTheDocument();
  });

  it("the Date of Birth custom widget is reachable via aria-labelledby (accessible name resolves to the visible label)", () => {
    renderForm();
    // DatePicker renders a button whose accessible name comes from
    // aria-labelledby pointing at the visible <Label id=...> — this is
    // exactly what getByRole's accessible-name computation resolves.
    expect(screen.getByRole("button", { name: /Date of Birth \*/i })).toBeInTheDocument();
  });

  it("the Frequent Flyer Airline custom widget is reachable via aria-labelledby", () => {
    renderForm();
    expect(screen.getByLabelText("Frequent Flyer Airline")).toBeInTheDocument();
  });

  it("two PassengerForm instances on the same page never collide on id (each gets its own unique ids via useId)", () => {
    render(
      <CustomerThemeProvider>
        <PassengerForm passenger={blankPassenger()} index={0} onChange={() => {}} />
        <PassengerForm passenger={blankPassenger()} index={1} onChange={() => {}} />
      </CustomerThemeProvider>
    );
    const firstNameFields = screen.getAllByLabelText("First Name *");
    expect(firstNameFields).toHaveLength(2);
    // Distinct DOM ids — proves useId() actually produced unique values,
    // not a hardcoded string that would silently mislabel the second
    // instance's field as belonging to the first's label (or vice versa).
    const ids = firstNameFields.map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
  });
});
