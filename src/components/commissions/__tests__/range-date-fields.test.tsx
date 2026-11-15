// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import "@/test/rtl-setup";
import { CommissionRangeDateFields } from "../range-date-fields";
import { ReportRangeControls } from "@/components/crm/report-range-controls";
import { resolveReportRange } from "@/lib/pay-period";

// The Commission section's From / To fields as a calendar popover. The form still submits two plain fields named `from` and `to` with
// yyyy-MM-dd text, so the server-side range resolution (and with it every pay-period boundary and timezone rule) is untouched.

// onSubmit receives whether the submission had already been cancelled (defaultPrevented) by the component when the form's own handler ran.
function Form({ from = "", to = "", onSubmit = vi.fn() }: { from?: string; to?: string; onSubmit?: (blocked: boolean) => void }) {
  return (
    <form
      aria-label="range"
      onSubmit={(e) => {
        onSubmit(e.defaultPrevented);
        e.preventDefault(); // jsdom cannot navigate; this only keeps the test page in place
      }}
    >
      <CommissionRangeDateFields initialFrom={from} initialTo={to} />
      <button type="submit">Apply range</button>
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

describe("Commission calendar fields", () => {
  it("shows labelled From and To triggers with a placeholder or the formatted date, and submits the original yyyy-MM-dd values", () => {
    render(<Form from="2026-10-01" to="" />);
    expect(fromBtn()).toHaveTextContent("Oct 1, 2026");
    expect(toBtn()).toHaveTextContent("Select date");
    expect(hidden("from")).toBe("2026-10-01");
    expect(hidden("to")).toBe("");
  });

  it("opens a calendar with a clear month and year heading and previous / next month navigation", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="2026-10-31" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("October 2026")).toBeInTheDocument();
    expect(dialog.querySelectorAll("th")).toHaveLength(7); // one aligned heading per weekday
    await user.click(within(dialog).getByRole("button", { name: /next month/i }));
    expect(within(dialog).getByText("November 2026")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /previous month/i }));
    await user.click(within(dialog).getByRole("button", { name: /previous month/i }));
    expect(within(dialog).getByText("September 2026")).toBeInTheDocument();
  });

  it("picking a day sets the field to that exact local date, shows it, and closes the calendar", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /October 31(st)?, 2026/ }));
    expect(hidden("from")).toBe("2026-10-31");
    expect(fromBtn()).toHaveTextContent("Oct 31, 2026");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("month and year boundaries serialise correctly (Dec 31 / Jan 1 / Feb 29) with no day shifted by a time zone", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-12-30" to="2028-02-01" />);
    await user.click(fromBtn());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /December 31(st)?, 2026/ }));
    expect(hidden("from")).toBe("2026-12-31");
    await user.click(fromBtn());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /next month/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /January 1(st)?, 2027/ }));
    expect(hidden("from")).toBe("2027-01-01");
    await user.click(toBtn());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /next month/i })); // Feb 2028 (a leap year)
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /February 29(th)?, 2028/ }));
    expect(hidden("to")).toBe("2028-02-29");
  });

  it.each(["America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati", "UTC"])("the picked day is the same calendar day in a browser set to %s (nothing is converted through UTC)", async (zone) => {
    const saved = process.env.TZ;
    process.env.TZ = zone;
    try {
      const user = userEvent.setup({ advanceTimers: () => undefined });
      render(<Form from="2026-10-15" to="" />);
      await user.click(fromBtn());
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /October 31(st)?, 2026/ }));
      expect(hidden("from")).toBe("2026-10-31");
      expect(fromBtn()).toHaveTextContent("Oct 31, 2026");
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("clicking the already-selected day keeps it (the field is never blanked by accident)", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="2026-10-31" />);
    await user.click(fromBtn());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /October 15(th)?, 2026/ }));
    expect(hidden("from")).toBe("2026-10-15");
  });

  it("styles the selected day and today distinctly, and exposes them to assistive technology", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-11-04" to="" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    const selected = within(dialog).getByRole("button", { name: /November 4(th)?, 2026/ });
    expect(selected.closest("td")).toHaveAttribute("data-selected", "true");
    expect(selected).toHaveAttribute("data-selected-single", "true");
    expect(selected.className).toMatch(/bg-primary|data-\[selected-single=true\]:bg-primary/);
    const today = within(dialog).getByRole("button", { name: /November 10(th)?, 2026/ });
    expect(today.closest("td")).toHaveAttribute("data-today", "true");
    expect(today.closest("td")!.className).toMatch(/ring-primary/);
    expect(today.closest("td")).not.toHaveAttribute("data-selected", "true");
  });

  it("is keyboard operable: arrow keys move between days and Enter picks one", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-10-15" to="" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    within(dialog).getByRole("button", { name: /October 15(th)?, 2026/ }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(document.activeElement).toHaveAccessibleName(/October 17(th)?, 2026/);
    await user.keyboard("{Enter}");
    expect(hidden("from")).toBe("2026-10-17");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("will not submit until both dates are chosen (the rule the native 'required' inputs enforced), then submits normally", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const onSubmit = vi.fn();
    render(<Form from="2026-10-01" to="" onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith(true); // cancelled before it could be sent
    expect(screen.getByRole("alert")).toHaveTextContent("Choose both a From and a To date.");
    await user.click(toBtn());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /November 20(th)?, 2026/ })); // opens on the current month
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(false); // allowed through
    expect(hidden("from")).toBe("2026-10-01");
    expect(hidden("to")).toBe("2026-11-20");
  });

  it("a reversed range is NOT blocked here: it goes to the server, which answers with its warning exactly as before", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const onSubmit = vi.fn();
    render(<Form from="2026-10-20" to="2026-10-01" onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith(false);
  });
});

describe("the calendar is opt-in (Commissions and Salesboard opt in)", () => {
  const range = resolveReportRange({ from: "2026-10-01", to: "2026-10-31" });
  const html = (modern: boolean) => renderToStaticMarkup(<ReportRangeControls basePath="/commissions" selected={range} now={new Date("2026-11-10T20:00:00Z")} modernCalendar={modern} />);

  it("without the opt-in (Salesboard, and anything else) the native From / To date inputs are unchanged", () => {
    const h = html(false);
    const dateInputs = (h.match(/<input[^>]*>/g) ?? []).filter((tag) => tag.includes('type="date"'));
    expect(dateInputs).toHaveLength(2);
    const from = dateInputs.find((t) => t.includes('name="from"'))!;
    const to = dateInputs.find((t) => t.includes('name="to"'))!;
    expect(from).toMatch(/required/);
    expect(to).toMatch(/required/);
    expect(from).toContain('value="2026-10-01"');
    expect(to).toContain('value="2026-10-31"');
    expect(h).not.toContain("commission-date-from");
  });

  it("a ReportRangeControls rendered with no calendar option keeps the native inputs - the calendar is opt-in only", () => {
    const h = renderToStaticMarkup(<ReportRangeControls basePath="/salesboard" selected={range} now={new Date("2026-11-10T20:00:00Z")} />);
    expect(h).toContain('type="date"');
    expect(h).not.toContain("commission-date-from");
  });

  it("Salesboard uses the SAME calendar control as Commissions, with the same from / to fields and the same Apply range button", () => {
    const h = renderToStaticMarkup(<ReportRangeControls basePath="/salesboard" selected={range} now={new Date("2026-11-10T20:00:00Z")} modernCalendar />);
    expect(h).not.toContain('type="date"');
    expect(h).toContain('data-testid="commission-date-from"');
    expect(h).toContain('type="hidden" name="from" value="2026-10-01"');
    expect(h).toContain('type="hidden" name="to" value="2026-10-31"');
    expect(h).toContain("Apply range");
    expect(h).toContain('action="/salesboard"');
  });

  it("with the opt-in (Commissions) the calendar triggers replace the native inputs and the same from / to values are submitted", () => {
    const h = html(true);
    expect(h).not.toContain('type="date"');
    expect(h).toContain('data-testid="commission-date-from"');
    expect(h).toContain('data-testid="commission-date-to"');
    expect(h).toContain('type="hidden" name="from" value="2026-10-01"');
    expect(h).toContain('type="hidden" name="to" value="2026-10-31"');
    expect(h).toContain("Oct 1, 2026");
  });

  it("the quick ranges, the pay-period list and the Show / Apply buttons are identical in both modes", () => {
    for (const modern of [false, true]) {
      const h = html(modern);
      for (const label of ["Current Pay Period", "Previous Pay Period", "Current Month", "Previous Month", "Pay period", "Show", "Apply range"]) expect(h, `${modern} ${label}`).toContain(label);
      expect(h).toContain('name="payPeriod"');
    }
  });
});

describe("the chosen range is highlighted in the calendar", () => {
  it("the days between From and To are marked as part of the range, and days outside it are not", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-11-03" to="2026-11-08" />);
    await user.click(fromBtn());
    const dialog = await screen.findByRole("dialog");
    const cell = (re: RegExp) => within(dialog).getByRole("button", { name: re }).closest("td") as HTMLElement;
    for (const day of [/November 4(th)?, 2026/, /November 5(th)?, 2026/, /November 6(th)?, 2026/, /November 7(th)?, 2026/]) {
      expect(cell(day).className, String(day)).toMatch(/bg-primary\/10/);
    }
    expect(cell(/November 2(nd)?, 2026/).className).not.toMatch(/bg-primary\/10/);
    expect(cell(/November 12(th)?, 2026/).className).not.toMatch(/bg-primary\/10/);
    // the two ends are the strongly styled selected day in their own calendar
    expect(cell(/November 3(rd)?, 2026/)).toHaveAttribute("data-selected", "true");
  });

  it("the span also shows in the To calendar, so both pickers describe the same range", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    render(<Form from="2026-11-03" to="2026-11-08" />);
    await user.click(toBtn());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /November 5(th)?, 2026/ }).closest("td")!.className).toMatch(/bg-primary\/10/);
    expect(within(dialog).getByRole("button", { name: /November 8(th)?, 2026/ }).closest("td")).toHaveAttribute("data-selected", "true");
  });

  it("a reversed or incomplete range highlights nothing (it is not a range yet), and the form still submits what was chosen", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    const { unmount } = render(<Form from="2026-11-08" to="2026-11-03" />);
    await user.click(fromBtn());
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /November 5(th)?, 2026/ }).closest("td")!.className).not.toMatch(/bg-primary\/10/);
    unmount();
    render(<Form from="2026-11-03" to="" />);
    await user.click(fromBtn());
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /November 5(th)?, 2026/ }).closest("td")!.className).not.toMatch(/bg-primary\/10/);
  });
});
