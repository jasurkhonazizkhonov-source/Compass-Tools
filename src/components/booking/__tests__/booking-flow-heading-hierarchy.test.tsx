// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { BookingFlow } from "../booking-flow";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 23 — CONFIRMED accessibility gap, now fixed: every section "title"
// on this customer-facing form (`CardTitle`, src/components/ui/card.tsx)
// renders a plain <div> with no heading semantics at all — unlike this
// exact flow's sibling pages (src/app/quote/[token]/page.tsx and
// .../confirmation/page.tsx), which use real <h1>/<h2> tags. That left the
// deeply-nested, carefully-leveled legal content (legal-section-list.tsx's
// own h3→h4→h5 chain, whose comments explicitly assume a heading ancestor
// exists above the accordion) floating with no heading above it at all —
// a genuine skipped-level violation, not just a missing top-level h1.
//
// The fix (scoped to booking-flow.tsx, card-payment-section.tsx, and
// passenger-form.tsx only — CardTitle itself, a shared primitive used
// across the whole CRM, is untouched) gives every section/subsection
// label a real ARIA heading role + level, so a screen reader can navigate
// this long form by heading exactly as it can on the sibling pages.
//
// This test doesn't re-litigate whether ARIA role="heading" is valid — it
// is, per the WAI-ARIA spec — it proves the resulting outline has no
// skipped levels anywhere in the rendered form, including inside the
// opened Cancellation Policy / Terms & Conditions accordion.

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

/** Native h1-h6 tags carry an implicit level; role="heading" elements carry
 * an explicit aria-level. Matches how a real screen reader (and axe's own
 * heading-order check) computes a heading's level. */
function headingLevel(el: Element): number {
  const explicit = el.getAttribute("aria-level");
  if (explicit) return Number(explicit);
  const match = /^H([1-6])$/.exec(el.tagName);
  if (!match) throw new Error(`Element with role=heading has neither aria-level nor an h1-h6 tag: ${el.outerHTML}`);
  return Number(match[1]);
}

describe("BookingFlow — section heading hierarchy (Pass 23 fix)", () => {
  it("every top-level section title is a real heading (role=heading), not just visually styled text", () => {
    renderBookingFlow();
    for (const name of [
      "Flight Itinerary",
      "Passenger Information",
      "Contact Information",
      "Payment",
      "Billing Address",
      "Gratuity",
      "Cancellation Policy & Terms & Conditions",
      "Electronic Signature",
    ]) {
      const heading = screen.getByRole("heading", { name, level: 2 });
      expect(heading).toBeInTheDocument();
    }
  });

  it("never skips a heading level, in document order, anywhere on the rendered page — including inside the opened legal accordion", async () => {
    const user = userEvent.setup();
    renderBookingFlow();

    // Expand both accordion panels so their own h3→h4→h5 chain
    // (legal-section-list.tsx) is present in the DOM alongside everything
    // else — the exact content that used to float with no heading
    // ancestor above it at all.
    await user.click(screen.getByRole("button", { name: /cancellation policy/i }));
    await user.click(screen.getByRole("button", { name: /^terms & conditions$/i }));
    await screen.findByText(/Standard Ticket Cancellation and Refunds/i);

    const headings = screen.getAllByRole("heading");
    expect(headings.length).toBeGreaterThan(5);

    const levels = headings.map(headingLevel);
    // No heading may jump more than one level deeper than the immediately
    // preceding heading (dropping back up any number of levels is fine —
    // that's how e.g. "Payment" (h2) is followed by "Card Details" (h3)
    // and then the next top-level section drops back to h2).
    for (let i = 1; i < levels.length; i++) {
      const jump = levels[i] - levels[i - 1];
      expect(jump, `heading #${i} ("${headings[i].textContent}", level ${levels[i]}) follows a level-${levels[i - 1]} heading ("${headings[i - 1].textContent}") — a jump of ${jump}`).toBeLessThanOrEqual(1);
    }

    // No heading starts the document at a level deeper than 2 — the legal
    // accordion's h3/h4/h5 chain must nest under the "Cancellation Policy
    // & Terms & Conditions" h2, never float at h3 with nothing above it.
    expect(Math.min(...levels)).toBeLessThanOrEqual(2);
  });

  it("nests the Payment section's per-card subsection label one level under the Payment heading", () => {
    renderBookingFlow();
    const payment = screen.getByRole("heading", { name: "Payment", level: 2 });
    const cardDetails = screen.getByRole("heading", { name: "Card Details", level: 3 });
    expect(payment).toBeInTheDocument();
    expect(cardDetails).toBeInTheDocument();
  });

  it("nests each passenger's subsection label one level under the Passenger Information heading", () => {
    renderBookingFlow();
    const passengerInfo = screen.getByRole("heading", { name: "Passenger Information", level: 2 });
    const passengerOne = screen.getByRole("heading", { name: /Passenger 1 · Adult/, level: 3 });
    expect(passengerInfo).toBeInTheDocument();
    expect(passengerOne).toBeInTheDocument();
  });
});
