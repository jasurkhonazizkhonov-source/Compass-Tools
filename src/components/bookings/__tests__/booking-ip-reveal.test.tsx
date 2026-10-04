// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import "@/test/rtl-setup";

// Regression tests for the Admin "Reveal" of a booking's submission IP.
// The original failure: the action THREW on every production call (its
// step-up gate failed closed unconditionally) and Next masks a thrown action
// error as an opaque digest, which React reports as "Minified React error
// #441". The contract now: expected refusals are RETURNED as { error }, shown
// inline, and a thrown (masked) error is replaced by a readable fallback —
// nothing ever propagates out of the click handler into React.

const revealMock = vi.fn();
const historyMock = vi.fn();
const previewMock = vi.fn();
vi.mock("@/server/actions/booking-security", () => ({ revealBookingIp: (...a: unknown[]) => revealMock(...a) }));
vi.mock("@/server/actions/ip-vault", () => ({
  getBookingIpMaskedPreview: (...a: unknown[]) => previewMock(...a),
  getIpHistoryForBooking: (...a: unknown[]) => historyMock(...a),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { BookingIpReveal } from "../booking-ip-reveal";

const V4 = "203.0.113.42";
const V6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
const PREVIEW = { masked: "203.x.x.x", count: 1, ipVersion: "v4" as const };

async function setup(canReveal = true) {
  const view = render(<BookingIpReveal bookingId="b-1" canReveal={canReveal} />);
  await screen.findByText("203.x.x.x");
  return view;
}
const pageHas = (text: string) => document.body.textContent!.includes(text);
const revealButton = () => screen.getByRole("button", { name: /^(reveal|revealing)/i });

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  revealMock.mockReset();
  historyMock.mockReset();
  previewMock.mockReset().mockResolvedValue(PREVIEW);
  toastError.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe("BookingIpReveal", () => {
  it("is masked by default, and a viewer without the grant gets no Reveal button and never calls the action", async () => {
    await setup(false);
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(revealMock).not.toHaveBeenCalled();
    expect(pageHas(V4)).toBe(false);
  });

  it("shows a loading state while the reveal is in flight, then the full IPv4 address", async () => {
    let resolve!: (v: unknown) => void;
    revealMock.mockReturnValue(new Promise((r) => (resolve = r)));
    await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(screen.getByRole("button", { name: /revealing/i })).toBeDisabled());
    expect(pageHas(V4)).toBe(false);
    await act(async () => resolve({ ipAddress: V4, userAgent: "Mozilla/5.0 Test" }));
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    expect(screen.getByText(/privileged view/i)).toBeInTheDocument();
    expect(screen.getByText("Mozilla/5.0 Test")).toBeInTheDocument();
    expect(screen.getByText("v4")).toBeInTheDocument();
    expect(revealMock).toHaveBeenCalledWith("b-1");
  });

  it("renders a full IPv6 address without truncation and labels it v6", async () => {
    revealMock.mockResolvedValue({ ipAddress: V6, userAgent: null });
    await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V6)).toBe(true));
    expect(screen.getByText("v6")).toBeInTheDocument();
    expect(screen.getByText(V6, { exact: false }).className).toMatch(/break-all/);
  });

  it("the Hide button conceals the value again, and a second Reveal works", async () => {
    revealMock.mockResolvedValue({ ipAddress: V4, userAgent: null });
    await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /^hide$/i }));
    expect(pageHas(V4)).toBe(false);
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
  });

  it("auto-hides after the countdown without a state update inside a state updater (no React warning)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    revealMock.mockResolvedValue({ ipAddress: V4, userAgent: null });
    await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    expect(screen.getByText(/auto-hides in 60s/i)).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(59_000));
    expect(pageHas(V4)).toBe(true);
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(pageHas(V4)).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("conceals immediately when the window loses focus, and on unmount", async () => {
    revealMock.mockResolvedValue({ ipAddress: V4, userAgent: null });
    const { unmount } = await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(pageHas(V4)).toBe(false);
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    unmount();
    expect(pageHas(V4)).toBe(false);
  });

  it("a RETURNED refusal (e.g. stale sign-in) is shown inline and as a toast; nothing crashes and no IP is displayed", async () => {
    const msg = "For security, Reveal requires a sign-in within the last 15 minutes. Sign out, sign back in, then try again.";
    revealMock.mockResolvedValue({ error: msg });
    await setup();
    fireEvent.click(revealButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(msg);
    expect(toastError).toHaveBeenCalledWith(msg, expect.anything());
    expect(pageHas(V4)).toBe(false);
    expect(revealButton()).toBeEnabled();
  });

  it("a THROWN denial keeps its message; a MASKED production error (the React #441 digest) becomes a readable fallback, never raw digest text", async () => {
    revealMock.mockRejectedValueOnce(new Error("You are not authorized to reveal this booking's submission IP"));
    await setup();
    fireEvent.click(revealButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/not authorized to reveal/);

    revealMock.mockRejectedValueOnce(
      new Error("An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included")
    );
    fireEvent.click(revealButton());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unable to reveal the submission IP. You may not have permission."));
    expect(document.body.textContent).not.toMatch(/Server Components render|digest|#441/);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("clears a previous error on the next attempt", async () => {
    revealMock.mockResolvedValueOnce({ error: "try later" });
    await setup();
    fireEvent.click(revealButton());
    await screen.findByRole("alert");
    revealMock.mockResolvedValueOnce({ ipAddress: V4, userAgent: null });
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("the IP history action returning { error } is reported without crashing", async () => {
    previewMock.mockResolvedValue({ ...PREVIEW, count: 2 });
    historyMock.mockResolvedValue({ error: "history needs a recent sign-in" });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /full ip history/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("history needs a recent sign-in", expect.anything()));
    expect(screen.getByRole("button", { name: /view full ip history/i })).toBeInTheDocument();
  });

  it("never writes the IP to browser storage, cookies, the URL or the console", async () => {
    revealMock.mockResolvedValue({ ipAddress: V4, userAgent: null });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await setup();
    fireEvent.click(revealButton());
    await waitFor(() => expect(pageHas(V4)).toBe(true));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(V4);
    expect(log).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(V4);
    log.mockRestore();
  });
});
