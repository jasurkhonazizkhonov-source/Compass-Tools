// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { SubscriberList } from "../subscriber-list";

// Pass 7 §24/§29 baseline (status tabs navigate via URL, page-scoped
// selection) plus Pass 8 §2's cross-page "select all matching filter"
// mode: explicit page selection stays the safe default, but a second
// option lets the user logically select every row matching the current
// filter — without the browser ever fetching more than one page's worth
// of actual subscriber data.

const { push, deleteSubscribers, deleteSubscribersMatchingFilter, getSubscriberCountForFilter } = vi.hoisted(() => ({
  push: vi.fn(),
  deleteSubscribers: vi.fn(async (ids: string[]) => ({ deleted: ids.length })),
  deleteSubscribersMatchingFilter: vi.fn(async () => ({ deleted: 247 })),
  // Pass 9 §8 — defaults to echoing back whatever count the test's own
  // `filteredTotal` prop used, so existing assertions (written against
  // that prop) keep working unless a test explicitly overrides this to
  // prove the live-refresh behavior itself.
  getSubscriberCountForFilter: vi.fn(async () => 247),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/subscriptions",
  useSearchParams: () => new URLSearchParams("campaignsPage=3"),
}));

vi.mock("@/server/actions/subscribers", () => ({
  deleteSubscriber: vi.fn(async () => {}),
  deleteSubscribers,
  deleteSubscribersMatchingFilter,
  getSubscriberCountForFilter,
}));

function subscriber(overrides: Partial<{ id: string; email: string; status: "SUBSCRIBED" | "UNSUBSCRIBED" }> = {}) {
  return { id: "s1", email: "a@example.com", status: "SUBSCRIBED" as const, source: null, subscribedAt: new Date(2026, 0, 1), ...overrides };
}

function makePage(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => subscriber({ id: `s${offset + i + 1}`, email: `s${offset + i + 1}@example.com` }));
}

const COUNTS = { total: 90, subscribed: 60, unsubscribed: 30 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SubscriberList — status tabs navigate via URL and reset selection (Pass 7 §24, Pass 8 §2)", () => {
  it("clicking 'Unsubscribed' navigates with status=unsubscribed, drops subscribersPage, and preserves unrelated params", async () => {
    const user = userEvent.setup();
    render(<SubscriberList subscribers={[subscriber()]} counts={COUNTS} statusParam="all" filteredTotal={90} />);

    await user.click(screen.getByRole("button", { name: /Unsubscribed \(30\)/ }));

    expect(push).toHaveBeenCalledTimes(1);
    const url = new URL(push.mock.calls[0][0], "http://x");
    expect(url.searchParams.get("status")).toBe("unsubscribed");
    expect(url.searchParams.get("subscribersPage")).toBeNull();
    expect(url.searchParams.get("campaignsPage")).toBe("3"); // untouched
  });

  it("changing the filter clears an active 'select all matching' selection (never carries over to a different dataset)", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={60} />);

    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: /select all 60 subscribers matching this filter/i }));
    expect(screen.getByText(/all 60 subscribers matching this filter are selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Active \(60\)/ }));

    // No selection banner survives the filter change.
    expect(screen.queryByText(/matching this filter are selected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
  });
});

describe("SubscriberList — page-only selection (Option A)", () => {
  it("'select all' checkbox is explicitly labeled as page-scoped", () => {
    render(<SubscriberList subscribers={[subscriber()]} counts={COUNTS} statusParam="all" filteredTotal={1} />);
    expect(screen.getByLabelText("Select all subscribers on this page")).toBeInTheDocument();
  });

  it("selecting all rows on this page and bulk-deleting sends exactly those ids to deleteSubscribers", async () => {
    const user = userEvent.setup();
    const rows = [subscriber({ id: "s1", email: "a@example.com" }), subscriber({ id: "s2", email: "b@example.com" })];
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={2} />);

    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    expect(screen.getByText("2 selected on this page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove selected/i }));
    await user.click(screen.getByRole("button", { name: "Remove Selected" }));

    expect(deleteSubscribers).toHaveBeenCalledWith(["s1", "s2"]);
    expect(deleteSubscribersMatchingFilter).not.toHaveBeenCalled();
  });

  it("deselecting one row after 'select all' leaves the checkbox indeterminate, not fully checked", async () => {
    const user = userEvent.setup();
    const rows = [subscriber({ id: "s1", email: "a@example.com" }), subscriber({ id: "s2", email: "b@example.com" })];
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={2} />);

    const selectAll = screen.getByLabelText("Select all subscribers on this page");
    await user.click(selectAll);
    await user.click(screen.getByLabelText("Select a@example.com"));

    expect(selectAll).toHaveAttribute("data-state", "indeterminate");
  });

  it("does NOT offer 'select all matching' when the current page already contains every matching row", async () => {
    const user = userEvent.setup();
    const rows = makePage(10);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={10} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    expect(screen.queryByRole("button", { name: /select all .* matching this filter/i })).not.toBeInTheDocument();
  });
});

describe("SubscriberList — cross-page 'select all matching filter' (Pass 8 §2, Option B)", () => {
  it("offers 'select all N matching this filter' once every row on the current page is selected and more exist", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);

    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    expect(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" })).toBeInTheDocument();
  });

  it("choosing it shows a banner naming the exact server-provided total, not the page size", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));

    expect(screen.getByText(/all 247 subscribers matching this filter are selected/i)).toBeInTheDocument();
    expect(screen.getByText("All 247 matching selected")).toBeInTheDocument();
  });

  it("selection remains logically active across a page change (state survives a prop swap without unmounting)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SubscriberList subscribers={makePage(25)} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));

    // Simulate navigating to page 2 — the server sends a new `subscribers`
    // page, but this component instance is not unmounted.
    rerender(<SubscriberList subscribers={makePage(25, 25)} counts={COUNTS} statusParam="all" filteredTotal={247} />);

    expect(screen.getByText(/all 247 subscribers matching this filter are selected/i)).toBeInTheDocument();
    // Every row on the NEW page is shown as selected too, since none of
    // them are in the (still empty) exclusion set.
    expect(screen.getByLabelText("Select s26@example.com")).toBeChecked();
  });

  it("unchecking one subscriber while in 'select all matching' mode creates an exclusion, decrementing the visible count by exactly one", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));

    await user.click(screen.getByLabelText("Select s3@example.com"));

    expect(screen.getByText("All 246 matching selected")).toBeInTheDocument();
    expect(screen.getByText(/1 manually deselected/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Select s3@example.com")).not.toBeChecked();
    // A sibling row is unaffected.
    expect(screen.getByLabelText("Select s4@example.com")).toBeChecked();
  });

  it("re-checking a previously-excluded subscriber removes it from the exclusion set", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));
    await user.click(screen.getByLabelText("Select s3@example.com")); // exclude
    await user.click(screen.getByLabelText("Select s3@example.com")); // re-include

    expect(screen.getByText("All 247 matching selected")).toBeInTheDocument();
    expect(screen.queryByText(/manually deselected/i)).not.toBeInTheDocument();
  });

  it("'Clear selection' fully resets cross-page selection back to nothing selected", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));

    await user.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.queryByText(/matching selected/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select s1@example.com")).not.toBeChecked();
  });

  it("bulk delete in 'select all matching' mode calls deleteSubscribersMatchingFilter with the filter and exclusions — never deleteSubscribers", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="active" status={"SUBSCRIBED" as never} filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 active subscribers matching this filter" }));
    await user.click(screen.getByLabelText("Select s3@example.com")); // exclude one

    await user.click(screen.getByRole("button", { name: /remove selected/i }));
    // Confirmation clearly names the count and explains filter scope.
    expect(screen.getByText("Delete 246 selected subscribers?")).toBeInTheDocument();
    expect(screen.getByText(/every active subscriber matching the current filter/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Selected" }));

    expect(deleteSubscribersMatchingFilter).toHaveBeenCalledWith({ status: "SUBSCRIBED", excludeIds: ["s3"] });
    expect(deleteSubscribers).not.toHaveBeenCalled();
  });

  it("Pass 9 §8 — refreshes the count from the server right before showing the confirmation, so a stale filteredTotal doesn't reach the user", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    // The page was rendered with filteredTotal=247, but 20 have since been
    // deleted by someone else — the server now truthfully reports 227.
    getSubscriberCountForFilter.mockResolvedValueOnce(227);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));
    expect(screen.getByText("All 247 matching selected")).toBeInTheDocument(); // still the stale number before refresh

    await user.click(screen.getByRole("button", { name: /remove selected/i }));

    expect(getSubscriberCountForFilter).toHaveBeenCalledWith(undefined);
    // The confirmation dialog — and the persistent selection banner behind
    // it — now both show the freshly-fetched, accurate count.
    expect(screen.getByText("Delete 227 selected subscribers?")).toBeInTheDocument();
    expect(screen.getByText("All 227 matching selected")).toBeInTheDocument();
  });

  it("falls back to filteredTotal if the live-count refresh itself fails, without blocking the confirmation dialog from opening", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    getSubscriberCountForFilter.mockRejectedValueOnce(new Error("network error"));
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" }));

    await user.click(screen.getByRole("button", { name: /remove selected/i }));

    expect(screen.getByText("Delete 247 selected subscribers?")).toBeInTheDocument();
  });
});

// Pass 8 §4 — the bulk-delete confirmation dialog for a large/cross-page
// selection, DOM-level accessibility (jsdom, no real screen reader).
describe("SubscriberList — bulk-delete confirmation accessibility (Pass 8 §4)", () => {
  it("the confirmation dialog has an accessible name naming the exact selected count, and a clearly-labeled destructive action", async () => {
    const user = userEvent.setup();
    const rows = [subscriber({ id: "s1", email: "a@example.com" }), subscriber({ id: "s2", email: "b@example.com" })];
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={2} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: /remove selected/i }));

    expect(screen.getByRole("dialog", { name: "Remove 2 selected subscribers?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Selected" })).toBeInTheDocument();
  });

  // Focus-return-to-trigger is Radix Dialog's own default (see the
  // matching comment in reassign-contact-dialog.test.tsx) — did not
  // reproduce under jsdom, so not asserted here; Escape actually closing
  // the dialog without triggering the destructive action IS verified.
  it("Escape closes the confirmation dialog without deleting anything", async () => {
    const user = userEvent.setup();
    const rows = [subscriber({ id: "s1", email: "a@example.com" })];
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={1} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));
    await user.click(screen.getByRole("button", { name: /remove selected/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteSubscribers).not.toHaveBeenCalled();
  });

  it("the 'select all matching filter' link and 'Clear selection' control are both reachable via the keyboard", async () => {
    const user = userEvent.setup();
    const rows = makePage(25);
    render(<SubscriberList subscribers={rows} counts={COUNTS} statusParam="all" filteredTotal={247} />);
    await user.click(screen.getByLabelText("Select all subscribers on this page"));

    const selectAllMatchingBtn = screen.getByRole("button", { name: "Select all 247 subscribers matching this filter" });
    selectAllMatchingBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText(/all 247 subscribers matching this filter are selected/i)).toBeInTheDocument();

    const clearBtn = screen.getByRole("button", { name: "Clear selection" });
    clearBtn.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText(/matching selected/i)).not.toBeInTheDocument();
  });
});
