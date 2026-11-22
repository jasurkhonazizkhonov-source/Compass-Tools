// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { DateRangeFilterFields } from "../range-date-fields";

// The optional From / To calendars of the failed sign-in filter. The form is still a plain GET form that submits two fields named `from` and `to` (yyyy-MM-dd text, possibly empty),
// so the server's query, pagination links and business-day conversion are unchanged. The calendar is the same one the Commissions / Salesboard reports use.

function Form({ from = "", to = "", onSubmit = vi.fn() }: { from?: string; to?: string; onSubmit?: (blocked: boolean) => void }) {
  return (
    <form
      aria-label="filter"
      onSubmit={(e) => {
        onSubmit(e.defaultPrevented);
        e.preventDefault(); // jsdom cannot navigate
      }}
    >
      <DateRangeFilterFields initialFrom={from} initialTo={to} testIdPrefix="failed-signins-date" />
      <button type="submit">Apply</button>
    </form>
  );
}
const hidden = (name: string) => (document.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement).value;
const fromBtn = () => screen.getByRole("button", { name: "From" });
const toBtn = () => screen.getByRole("button", { name: "To" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("failed sign-in From / To calendars", () => {
  it("renders labelled From and To triggers (a placeholder when empty, the formatted date when set) and submits the same two fields, empty allowed", () => {
    render(<Form from="2026-10-01" to="" />);
    expect(fromBtn()).toHaveTextContent("Oct 1, 2026");
    expect(toBtn()).toHaveTextContent("Select date");
    expect(hidden("from")).toBe("2026-10-01");
    expect(hidden("to")).toBe(""); // an open-ended filter is valid
    expect(screen.getByTestId("failed-signins-date-from")).toBe(fromBtn());
    expect(screen.getByTestId("failed-signins-date-to")).toBe(toBtn());
  });

  it("opens a month calendar with a clear month and year heading, weekday headings and month navigation", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="2026-10-31" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("October 2026")).toBeInTheDocument();
    expect(dialog.querySelectorAll("th")).toHaveLength(7);
    await user.click(within(dialog).getByRole("button", { name: /previous month/i }));
    expect(within(dialog).getByText("September 2026")).toBeInTheDocument();
  });

  it("picking a day sets that exact calendar date and closes the calendar; the selected day is marked for assistive technology", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="2026-10-31" />);
    await user.click(toBtn());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /October 31(st)?, 2026/ }).closest("td")).toHaveAttribute("data-selected", "true");
    await user.click(within(dialog).getByRole("button", { name: /October 20(th)?, 2026/ }));
    expect(hidden("to")).toBe("2026-10-20");
    expect(toBtn()).toHaveTextContent("Oct 20, 2026");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an INVALID range cannot be picked: days after To are disabled in From, days before From are disabled in To", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-10" to="2026-10-20" />);
    await user.click(fromBtn());
    const fromDialog = await screen.findByRole("dialog");
    expect(within(fromDialog).getByRole("button", { name: /October 21(st)?, 2026/ })).toBeDisabled();
    expect(within(fromDialog).getByRole("button", { name: /October 20(th)?, 2026/ })).toBeEnabled();
    await user.keyboard("{Escape}");
    await user.click(toBtn());
    const toDialog = await screen.findByRole("dialog");
    expect(within(toDialog).getByRole("button", { name: /October 9(th)?, 2026/ })).toBeDisabled();
    expect(within(toDialog).getByRole("button", { name: /October 10(th)?, 2026/ })).toBeEnabled();
  });

  it("a date can be CLEARED again (these are optional filters), and clicking the selected day does not blank it by accident", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-10" to="2026-10-20" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /October 10(th)?, 2026/ }));
    expect(hidden("from")).toBe("2026-10-10"); // clicking the selected day keeps it (and leaves the calendar open)
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear date" }));
    expect(hidden("from")).toBe("");
    expect(fromBtn()).toHaveTextContent("Select date");
  });

  it("submitting a hand-built reversed range is stopped with a message; a valid, an open-ended and an empty filter submit normally", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const submitted = vi.fn();
    const { unmount } = render(<Form from="2026-10-20" to="2026-10-10" onSubmit={submitted} />);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByTestId("failed-signins-date-error")).toHaveTextContent("The From date must be on or before the To date.");
    expect(submitted).toHaveBeenCalledWith(true); // cancelled before it could be sent
    unmount();

    for (const [from, to] of [["2026-10-10", "2026-10-20"], ["2026-10-10", ""], ["", "2026-10-20"], ["", ""], ["2026-10-10", "2026-10-10"]]) {
      const ok = vi.fn();
      const r = render(<Form from={from} to={to} onSubmit={ok} />);
      await user.click(screen.getByRole("button", { name: "Apply" }));
      expect(ok, `${from}..${to}`).toHaveBeenCalledWith(false);
      expect(screen.queryByTestId("failed-signins-date-error")).toBeNull();
      r.unmount();
    }
  });

  it("is keyboard operable: the trigger is a real button that opens the calendar, and Escape closes it", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-10" to="2026-10-20" />);
    fromBtn().focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
