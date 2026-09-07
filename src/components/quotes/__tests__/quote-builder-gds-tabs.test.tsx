// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/test/rtl-setup";

// Portability pass, Item 2 — regression coverage for a real, reproduced bug:
// pasting a new GDS itinerary into a different source tab (e.g. Sabre then
// Apollo) without reloading the page could show stale/mixed segment data
// from the previous parse. Root cause was a single `pasteText` state
// shared between the Sabre and Apollo textareas in quote-builder.tsx —
// switching tabs left the OTHER tab's textarea showing the just-parsed
// text, so pasting into it without clearing first could concatenate old
// and new itinerary text into one nonsensical parse. Fixed by giving each
// GDS source its own paste buffer (sabrePasteText / apolloPasteText) plus
// a monotonic request-id guard so a slower, earlier parse can never
// overwrite a faster, later one's result. This test reproduces the exact
// user-facing scenario end to end: real parsers, real hydration logic —
// only the network-bound reference-data lookups and the Next.js/server
// bindings are mocked. Tab switches use @testing-library/user-event
// (rather than a bare fireEvent.click) because Radix UI's Tabs trigger
// needs a real pointerdown/mouseup/click sequence to activate in jsdom.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/server/actions/quotes", () => ({
  createQuote: vi.fn(),
  sendQuote: vi.fn(),
}));

// Canned resolution data standing in for the self-healing reference-data
// layer (already covered by its own live-DB tests elsewhere) — this test
// is about the itinerary BUILDER's own state management, not reference
// data resolution itself.
vi.mock("@/server/queries/reference-data", () => {
  const airports: Record<string, { id: number; iata: string; name: string; city: string; country: string; timezone: string }> = {
    FRA: { id: 1, iata: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", timezone: "Europe/Berlin" },
    JFK: { id: 2, iata: "JFK", name: "John F Kennedy Intl", city: "New York", country: "United States", timezone: "America/New_York" },
    FCO: { id: 3, iata: "FCO", name: "Leonardo da Vinci", city: "Rome", country: "Italy", timezone: "Europe/Rome" },
    MNL: { id: 4, iata: "MNL", name: "Ninoy Aquino Intl", city: "Manila", country: "Philippines", timezone: "Asia/Manila" },
  };
  const airlines: Record<string, { id: number; name: string; iata: string; icao: string | null; logoUrl: string | null }> = {
    LH: { id: 10, name: "Lufthansa", iata: "LH", icao: "DLH", logoUrl: null },
    CX: { id: 11, name: "Cathay Pacific", iata: "CX", icao: "CPA", logoUrl: null },
  };
  return {
    searchAirports: vi.fn(async () => []),
    searchAirlines: vi.fn(async () => []),
    searchAircraft: vi.fn(async () => []),
    resolveAirportCodes: vi.fn(async (codes: string[]) => {
      const map: Record<string, unknown> = {};
      for (const c of codes) map[c] = airports[c.toUpperCase()] ?? null;
      return map;
    }),
    resolveAirlineCodes: vi.fn(async (codes: string[]) => {
      const map: Record<string, unknown> = {};
      for (const c of codes) map[c] = airlines[c.toUpperCase()] ?? null;
      return map;
    }),
    resolveAircraftCodes: vi.fn(async (codes: string[]) => {
      const map: Record<string, unknown> = {};
      for (const c of codes) map[c] = null;
      return map;
    }),
  };
});

const { QuoteBuilder } = await import("../quote-builder");

function renderBuilder() {
  const user = userEvent.setup({ delay: null });
  render(
    // Real usage always has a root-layout-provided TooltipProvider (see
    // src/app/layout.tsx) — not a portability change, just replicating that
    // ambient context here since the component is rendered in isolation.
    <TooltipProvider>
      <QuoteBuilder
        leadId="lead-1"
        defaultTripType="ROUND_TRIP"
        defaultCabin="ECONOMY"
        defaultAdults={1}
        defaultChildren={0}
        defaultInfants={0}
      />
    </TooltipProvider>
  );
  return user;
}

async function activateManualTab() {
  await waitFor(() => expect(screen.getByRole("tab", { name: "Manual Entry" })).toHaveAttribute("data-state", "active"));
}

describe("QuoteBuilder — GDS source tab switching (stale-state regression)", () => {
  it("never mixes a previous Sabre parse into a fresh Apollo parse after switching tabs", async () => {
    const user = renderBuilder();

    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), {
      target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH\n2 LH401C 15MAR JFK FRA HK1 600P 800A 16MAR TH" },
    });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();

    // FRA appears twice (flight 1's departure, flight 2's arrival) — this
    // is a real 2-segment round-trip, not a duplicate-rendering bug.
    expect((await screen.findAllByText(/FRA/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Lufthansa|LH —/i).length).toBeGreaterThan(0);

    // Switch to the Apollo tab — its textarea must be untouched by the
    // Sabre text just parsed (the actual bug: a shared pasteText state
    // would show the old Sabre text here).
    await user.click(screen.getByRole("tab", { name: "Apollo" }));
    const apolloTextarea = screen.getByPlaceholderText(/BA1460Y/) as HTMLTextAreaElement;
    expect(apolloTextarea.value).toBe("");

    fireEvent.change(apolloTextarea, { target: { value: "1 CX255Y 04SEP FCOMNL SS1 600P 725P * FR E" } });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();

    const manualPanel = screen.getByRole("tabpanel", { name: "Manual Entry" });
    // Exactly the new Apollo segment's data is present...
    expect(within(manualPanel).getByText(/FCO/)).toBeInTheDocument();
    expect(within(manualPanel).getByText(/MNL/)).toBeInTheDocument();
    expect(within(manualPanel).getByText(/Cathay Pacific|CX —/i)).toBeInTheDocument();
    // ...and there is only ONE segment (the earlier Sabre parse produced
    // two) — no leftover second flight card from the previous parse.
    expect(within(manualPanel).getAllByText(/^Flight \d/)).toHaveLength(1);
    // ...and nothing from the old Sabre itinerary survived: no Frankfurt/
    // JFK airports, no Lufthansa, anywhere in the manual tab.
    expect(within(manualPanel).queryByText(/FRA/)).not.toBeInTheDocument();
    expect(within(manualPanel).queryByText(/JFK/)).not.toBeInTheDocument();
    expect(within(manualPanel).queryByText(/Lufthansa|LH —/i)).not.toBeInTheDocument();
  }, 15000);

  it("switching from Apollo to Sabre is equally clean (order-independence — not just the exact sequence originally reported)", async () => {
    const user = renderBuilder();

    await user.click(screen.getByRole("tab", { name: "Apollo" }));
    fireEvent.change(screen.getByPlaceholderText(/BA1460Y/), {
      target: { value: "1 CX255Y 04SEP FCOMNL SS1 600P 725P * FR E" },
    });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();
    expect(await screen.findByText(/FCO/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    const sabreTextarea = screen.getByPlaceholderText(/LH400C/) as HTMLTextAreaElement;
    expect(sabreTextarea.value).toBe("");

    fireEvent.change(sabreTextarea, { target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH" } });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();

    const manualPanel = screen.getByRole("tabpanel", { name: "Manual Entry" });
    expect(within(manualPanel).getByText(/FRA/)).toBeInTheDocument();
    expect(within(manualPanel).queryByText(/FCO/)).not.toBeInTheDocument();
    expect(within(manualPanel).queryByText(/MNL/)).not.toBeInTheDocument();
    expect(within(manualPanel).queryByText(/Cathay Pacific|CX —/i)).not.toBeInTheDocument();
  }, 15000);

  it("a failed parse (no recognizable segments) leaves the previously parsed itinerary fully intact rather than clearing or mixing it", async () => {
    const user = renderBuilder();

    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), {
      target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH" },
    });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();
    expect(await screen.findByText(/FRA/)).toBeInTheDocument();

    // Go back to Sabre, clear the (persisted) text down to genuinely empty
    // input, and try to parse again — runParse's own guard rejects this
    // before touching any existing segment state.
    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));

    // Still on the Sabre tab (a real parse success is what navigates to
    // Manual Entry) and the earlier segment's data was never touched.
    expect(screen.getByRole("tab", { name: /Sabre/i })).toHaveAttribute("data-state", "active");
    await user.click(screen.getByRole("tab", { name: "Manual Entry" }));
    expect(screen.getByText(/FRA/)).toBeInTheDocument();
  }, 15000);

  // Portability pass 2, Item 5 (scenario 3 — rapid/overlapping parses) —
  // this scenario is NOT reachable through simulated user interaction: the
  // Parse button is disabled (via useTransition's isPending) for the full
  // duration of any in-flight parse, and jsdom (matching real browsers)
  // refuses to dispatch a click event to a disabled native <button> at
  // all, through fireEvent or userEvent alike — confirmed empirically
  // while writing this test, not assumed. The monotonic request-id guard
  // in runParse() exists as defense-in-depth for a code path that isn't
  // reachable today (verified by code review — see quote-builder.tsx's
  // own comment on parseRequestRef), not as something a passing/failing
  // race-condition test can currently exercise. Documented here as an
  // explicit testing limitation rather than silently skipped.
  it("the Parse button is disabled for the full duration of a pending parse, which is what makes the overlapping-parse scenario unreachable through the UI in the first place", async () => {
    const { resolveAirportCodes } = await import("@/server/queries/reference-data");
    // Deliberately slow this one resolution down so the pending window is
    // long enough to reliably observe mid-flight, rather than racing
    // against how fast the mocked promises happen to settle.
    vi.mocked(resolveAirportCodes).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ FRA: { id: 1, iata: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", timezone: "Europe/Berlin" }, JFK: { id: 2, iata: "JFK", name: "John F Kennedy Intl", city: "New York", country: "United States", timezone: "America/New_York" } }), 100))
    );
    const user = renderBuilder();
    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), {
      target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH" },
    });
    const parseButton = screen.getByRole("button", { name: /Parse Itinerary/i });
    await user.click(parseButton);
    // The parse is still in flight (the artificially delayed resolution
    // hasn't settled yet) — the button must be disabled right now, which
    // is exactly the mechanism that makes a second, overlapping click
    // impossible to dispatch at all (jsdom, like a real browser, refuses
    // to fire a click event on a disabled native <button>).
    expect(screen.getByRole("button", { name: /Parse Itinerary/i })).toBeDisabled();
    // The parse still completes correctly once the delayed resolution
    // settles — this isn't a stuck/broken state, just a genuinely pending
    // one. Navigating to Manual Entry (unmounting the Sabre tab's own
    // Parse button along with it) is itself proof the parse succeeded.
    await activateManualTab();
    expect(await screen.findByText(/FRA/)).toBeInTheDocument();
  }, 15000);
});

describe("QuoteBuilder — GDS tabs keyboard interaction", () => {
  it("Enter activates the focused Parse Itinerary button (native button semantics — no custom key handling needed or present)", async () => {
    const user = renderBuilder();
    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), {
      target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH" },
    });
    screen.getByRole("button", { name: /Parse Itinerary/i }).focus();
    await user.keyboard("{Enter}");
    await activateManualTab();
    expect(await screen.findByText(/FRA/)).toBeInTheDocument();
  }, 15000);

  it("Space activates the focused Parse Itinerary button", async () => {
    const user = renderBuilder();
    await user.click(screen.getByRole("tab", { name: "Apollo" }));
    fireEvent.change(screen.getByPlaceholderText(/BA1460Y/), {
      target: { value: "1 CX255Y 04SEP FCOMNL SS1 600P 725P * FR E" },
    });
    screen.getByRole("button", { name: /Parse Itinerary/i }).focus();
    await user.keyboard(" ");
    await activateManualTab();
    expect(await screen.findByText(/FCO/)).toBeInTheDocument();
  }, 15000);

  it("ArrowRight/ArrowLeft move focus and activation between the Itinerary Source tabs (Radix's default 'automatic' tab activation)", async () => {
    const user = renderBuilder();
    screen.getByRole("tab", { name: "Manual Entry" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /Sabre/i })).toHaveFocus();
    expect(screen.getByRole("tab", { name: /Sabre/i })).toHaveAttribute("data-state", "active");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Apollo" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Apollo" })).toHaveAttribute("data-state", "active");
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: /Sabre/i })).toHaveFocus();
  }, 15000);

  it("Tab moves focus from the paste textarea to the Parse button in document order, and Shift+Tab reverses it", async () => {
    const user = renderBuilder();
    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    const textarea = screen.getByPlaceholderText(/LH400C/);
    textarea.focus();
    expect(textarea).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /Parse Itinerary/i })).toHaveFocus();
    await user.tab({ shift: true });
    expect(textarea).toHaveFocus();
  }, 15000);
});
