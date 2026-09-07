// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { CloseBookingButton } from "../close-booking-button";

// Job 2 — the "Done" button shown after a customer signs a new-booking,
// exchange-booking, or cancellation form. Browsers only allow a script to
// close a tab it opened itself via window.open() — a tab reached via a
// normal link/navigation (the realistic case here: an email link) cannot
// be force-closed, and there is no reliable way to detect in advance which
// case applies. So the button always attempts window.close() (free when it
// works) AND the explanatory fallback copy is always visible up front,
// never only shown after a failed attempt — this proves both halves of
// that contract rather than assuming the click "worked" just because
// window.close() was called.

describe("CloseBookingButton", () => {
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    closeSpy.mockRestore();
  });

  it("shows the honest 'safe to close this tab' fallback copy before the button is even clicked", () => {
    render(<CloseBookingButton />);
    expect(screen.getByText(/you can safely close this tab now/i)).toBeInTheDocument();
  });

  it("attempts window.close() when the Done button is clicked", async () => {
    const user = userEvent.setup();
    render(<CloseBookingButton />);
    await user.click(screen.getByRole("button", { name: /done/i }));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the fallback copy after a click that doesn't actually close the tab (window.close() silently no-ops)", async () => {
    const user = userEvent.setup();
    render(<CloseBookingButton />);
    await user.click(screen.getByRole("button", { name: /done/i }));
    // No fake "closed" state is ever rendered — the fallback message is the
    // only outcome shown, matching what actually happens for a
    // regular-navigation tab (window.close() is a silent no-op).
    expect(screen.getByText(/you can safely close this tab now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
  });

  it("renders the compact layout's fallback copy the same way (used on the confirmation page's header action slot)", () => {
    render(<CloseBookingButton compact />);
    expect(screen.getByText(/you can safely close this tab now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
  });
});
