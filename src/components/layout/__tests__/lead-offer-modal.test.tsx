// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@/test/rtl-setup";

// Pass 36 — real, evidence-based optimization: LeadOfferModal previously
// polled getMyLeadOffer() (which doubles as the opportunistic
// sweepExpiredOffers() trigger) every 3 seconds regardless of whether the
// browser tab was even visible. A background tab has no user watching for
// a live offer to respond to, so this suite proves polling slows down
// while hidden and immediately re-syncs the instant the tab becomes
// visible again — never leaving a stale offer/countdown shown longer than
// it takes the user to actually look at the tab.

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let getMyLeadOfferMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  getMyLeadOfferMock = vi.fn(async () => null);
  vi.doMock("@/server/actions/lead-queue", () => ({
    getMyLeadOffer: getMyLeadOfferMock,
    acceptLeadOffer: vi.fn(),
    skipLeadOffer: vi.fn(),
  }));
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("LeadOfferModal — visibility-aware polling (Pass 36)", () => {
  it("polls every 3s while the tab is visible (the pre-existing foreground rate, unchanged)", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); }); // flush the initial poll() call

    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(3);
  });

  it("slows to a 15s heartbeat once the tab becomes hidden — no poll at the old 3s mark", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    // Visibility change to "hidden" itself must NOT poll again immediately —
    // only becoming visible does.
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1); // still 1 — the old 3s cadence no longer applies

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); }); // total 15s since hidden
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2); // the slow heartbeat fired once
  });

  it("polls immediately the instant the tab becomes visible again, rather than waiting out the slow interval", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    act(() => setVisibility("hidden"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // well short of the 15s heartbeat
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1); // no poll yet while hidden

    await act(async () => {
      setVisibility("visible");
      await Promise.resolve();
    });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2); // immediate re-sync, not a stale-for-up-to-15s wait

    // And the fast 3s cadence resumes from here.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(3);
  });
});

// ── Fresh-lead alert wiring ────────────────────────────────────────────
// The dialog asks lib/lead-offer-alert for ONE sound per offer. These prove the
// trigger logic (the actual audio is covered in lib/__tests__/lead-offer-alert
// with a fake Web Audio API, since a test run cannot hear): polling the same
// offer repeatedly never re-triggers, a genuinely new offer does, the Accept /
// Skip controls and countdown are unchanged, and a blocked sound is explained.
describe("LeadOfferModal — alert sound trigger", () => {
  const EXPIRES = new Date(Date.now() + 60_000).toISOString();
  const OFFER = { leadId: "lead-1", contactName: "Dark Master", email: "d@x.example", phone: "+14155550123", source: "WEBSITE", route: "JFK → LGW", offerExpiresAt: EXPIRES };
  let announce: ReturnType<typeof vi.fn>;
  let accept: ReturnType<typeof vi.fn>;
  let skip: ReturnType<typeof vi.fn>;

  function wire(result: "played" | "blocked" | "duplicate" = "played") {
    announce = vi.fn(async () => result);
    accept = vi.fn(async () => ({ ok: true }));
    skip = vi.fn(async () => ({ ok: true }));
    vi.doMock("@/lib/lead-offer-alert", () => ({ announceLeadOffer: announce, initOfferAudio: vi.fn(() => () => {}) }));
    vi.doMock("@/server/actions/lead-queue", () => ({ getMyLeadOffer: getMyLeadOfferMock, acceptLeadOffer: accept, skipLeadOffer: skip }));
  }

  it("sounds exactly once for an offer however many times the poll returns it", async () => {
    getMyLeadOfferMock = vi.fn(async () => OFFER);
    wire();
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(expect.objectContaining({ accountId: "account-1", key: `lead-1:${EXPIRES}` }));
  });

  it("sounds again for a genuinely new offer (a different lead, or the same lead re-offered with a new expiry)", async () => {
    let current = OFFER;
    getMyLeadOfferMock = vi.fn(async () => current);
    wire();
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    current = { ...OFFER, leadId: "lead-2" };
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    current = { ...OFFER, leadId: "lead-2", offerExpiresAt: new Date(Date.now() + 120_000).toISOString() };
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(announce).toHaveBeenCalledTimes(3);
  });

  it("shows the offer with Accept and Skip, and the countdown is still derived from the server's expiry", async () => {
    getMyLeadOfferMock = vi.fn(async () => OFFER);
    wire();
    const { LeadOfferModal } = await import("../lead-offer-modal");
    const { screen } = await import("@testing-library/react");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("button", { name: /Accept Lead/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
    expect(screen.getByText(/^[01]:\d\d$/)).toBeInTheDocument(); // m:ss, ≤ 1:00
  });

  it("Accept and Skip still call the existing queue actions", async () => {
    getMyLeadOfferMock = vi.fn(async () => OFFER);
    wire();
    const { LeadOfferModal } = await import("../lead-offer-modal");
    const { screen, fireEvent } = await import("@testing-library/react");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Skip" })); await Promise.resolve(); });
    expect(skip).toHaveBeenCalledWith("lead-1");
  });

  it("when the browser blocks sound the dialog says so (and the tab title still announces the offer)", async () => {
    getMyLeadOfferMock = vi.fn(async () => OFFER);
    wire("blocked");
    document.title = "Compass Tools";
    const { LeadOfferModal } = await import("../lead-offer-modal");
    const { screen } = await import("@testing-library/react");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Sound is off until you click or press a key/)).toBeInTheDocument();
    expect(document.title).toBe("(New lead) Compass Tools");
  });

  it("no sound is requested while there is no offer", async () => {
    getMyLeadOfferMock = vi.fn(async () => null);
    wire();
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(announce).not.toHaveBeenCalled();
  });
});
