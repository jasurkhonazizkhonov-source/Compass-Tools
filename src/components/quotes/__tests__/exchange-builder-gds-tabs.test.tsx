// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/test/rtl-setup";

// Portability pass 2, Item 5 (scenario 4) — the exact same GDS
// tab-switch stale-state fix applied to quote-builder.tsx (see
// quote-builder-gds-tabs.test.tsx for the full history and root-cause
// explanation) was applied identically to exchange-builder.tsx, since it
// had the exact same shared-pasteText bug. This is the lighter,
// single-scenario equivalent for the Exchange Builder — not a full
// duplicate of every quote-builder test, since the underlying fix and
// component structure are identical and already thoroughly covered there.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/server/actions/exchange", () => ({
  sendExchangeForApproval: vi.fn(),
}));

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

const { ExchangeBuilder } = await import("../exchange-builder");

function renderBuilder() {
  const user = userEvent.setup({ delay: null });
  render(
    <TooltipProvider>
      <ExchangeBuilder
        originalQuoteId="quote-1"
        originalQuoteNumber="Q-1001"
        originalSegments={[]}
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

describe("ExchangeBuilder — GDS source tab switching (stale-state regression)", () => {
  it("never mixes a previous Sabre parse into a fresh Apollo parse after switching tabs", async () => {
    const user = renderBuilder();

    await user.click(screen.getByRole("tab", { name: /Sabre/i }));
    fireEvent.change(screen.getByPlaceholderText(/LH400C/), {
      target: { value: "1 LH400C 12MAR FRA JFK HK1 1050A 130P TH" },
    });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();
    expect(await screen.findByText(/FRA/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Apollo" }));
    const apolloTextarea = screen.getByPlaceholderText(/BA1460Y/) as HTMLTextAreaElement;
    expect(apolloTextarea.value).toBe("");

    fireEvent.change(apolloTextarea, { target: { value: "1 CX255Y 04SEP FCOMNL SS1 600P 725P * FR E" } });
    await user.click(screen.getByRole("button", { name: /Parse Itinerary/i }));
    await activateManualTab();

    const manualPanel = screen.getByRole("tabpanel", { name: "Manual Entry" });
    expect(within(manualPanel).getByText(/FCO/)).toBeInTheDocument();
    expect(within(manualPanel).getByText(/MNL/)).toBeInTheDocument();
    expect(within(manualPanel).getAllByText(/^Flight \d/)).toHaveLength(1);
    expect(within(manualPanel).queryByText(/FRA/)).not.toBeInTheDocument();
    expect(within(manualPanel).queryByText(/JFK/)).not.toBeInTheDocument();
  }, 15000);
});
