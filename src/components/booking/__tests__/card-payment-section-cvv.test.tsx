// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { CardPaymentSection, EMPTY_CARD_FORM, type CardFormState } from "../card-payment-section";

// The booking form has a CVV/CVC input again. It is TRANSIENT: held in this
// component's state only, masked while typed, and sent once with "Finish
// Booking" for a format check — never stored (see the server-side tests in
// booking-currency.test.ts and the real-database scan in
// booking-submit.integration.test.ts).

function Harness({ initial = EMPTY_CARD_FORM, onChange }: { initial?: CardFormState; onChange?: (v: CardFormState) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <CardPaymentSection
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      label="Payment Method 1"
      fixedAmount={500}
      currency="USD"
    />
  );
}

describe("CardPaymentSection — the CVV/CVC input", () => {
  it("is present, required, masked, numeric and flagged for the browser's security-code autofill hint", () => {
    render(<Harness />);
    const input = screen.getByLabelText(/CVV \/ CVC/);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password"); // masked while typed
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "cc-csc");
    expect(input).toHaveAttribute("maxlength", "4");
    expect(screen.getByText(/CVV \/ CVC \*/)).toBeInTheDocument(); // required marker
  });

  it("accepts digits only, at most four", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText(/CVV \/ CVC/) as HTMLInputElement;
    await user.type(input, "1a2b3c4d5");
    expect(input.value).toBe("1234");
  });

  it("tells the customer it is only used to verify the card and is not stored", () => {
    render(<Harness />);
    expect(screen.getByText(/not stored/i)).toBeInTheDocument();
  });

  it("changes only the cvv field of the card state when typed in", async () => {
    const user = userEvent.setup();
    const seen: CardFormState[] = [];
    render(<Harness initial={{ ...EMPTY_CARD_FORM, cardholderName: "Jane Traveler", cardNumber: "4111 1111 1111 1111" }} onChange={(v) => seen.push(v)} />);
    await user.type(screen.getByLabelText(/CVV \/ CVC/), "737");
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({ cardholderName: "Jane Traveler", cardNumber: "4111 1111 1111 1111", cvv: "737" });
  });

  it("never writes the value to browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText(/CVV \/ CVC/), "737");
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("737");
    setItem.mockRestore();
  });
});

describe("BookingFlow wiring for the security code (source-level)", () => {
  const flow = readFileSync(path.join(process.cwd(), "src", "components", "booking", "booking-flow.tsx"), "utf-8");

  it("requires a well-formed code (brand-aware) before the booking can be submitted", () => {
    expect(flow).toMatch(/isValidCvvFormat\(card\.cvv, detectCardBrand\(card\.cardNumber\)\)/);
  });

  it("sends it once, inside the payment-method payload of the one submitBooking call", () => {
    expect((flow.match(/cvv: c\.cvv/g) ?? []).length).toBe(1);
  });

  it("clears it from state after a definitive answer — success or rejection", () => {
    expect((flow.match(/cvv: ""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the previous-card autofill never fills it (only cardholder name and expiry)", () => {
    const autofill = /\{ \.\.\.c, cardholderName: option\.cardholderName, expiryMonth: [^}]*expiryYear: String\(option\.expiryYear\) \}/.exec(flow);
    expect(autofill).not.toBeNull();
    expect(autofill![0]).not.toMatch(/cvv/i);
  });
});
