// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { PaginationControls } from "../pagination-controls";

// Pass 8 §4 — pagination accessibility: a <nav> landmark with an accessible
// name, Previous/Next with meaningful accessible names and real `disabled`
// state, a page-number input with a real associated <label> (not just
// aria-label), Enter-to-navigate, and out-of-range clamping. These are DOM/
// keyboard-level assertions (jsdom) — no real screen reader was used; see
// the Pass 8 report for exactly what that does and doesn't cover.
//
// Pass 12 §28/§29/§30 — page information and the rows-per-page selector
// must ALWAYS be visible, even on a single page; only Prev/Next/the
// page-jump input are omitted when there's nothing to navigate to.

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/leads",
  useSearchParams: () => new URLSearchParams("status=NEW"),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PaginationControls — always-visible page information (Pass 12 §29)", () => {
  it("still shows 'Showing X–Y of Z' and the rows-per-page selector when there's only one page", () => {
    render(<PaginationControls page={1} pageCount={1} total={18} pageSize={25} />);
    expect(screen.getByText("Showing 1–18 of 18")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("omits Prev/Next/page-jump when there's only one page — nothing useful to navigate to", () => {
    render(<PaginationControls page={1} pageCount={1} total={18} pageSize={25} />);
    expect(screen.queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
  });

  it("shows the correct A–B range for a middle page", () => {
    render(<PaginationControls page={2} pageCount={3} total={137} pageSize={50} />);
    expect(screen.getByText("Showing 51–100 of 137")).toBeInTheDocument();
  });

  it("the last page's range is clamped to the true total, not a full page's worth", () => {
    render(<PaginationControls page={3} pageCount={3} total={137} pageSize={50} />);
    expect(screen.getByText("Showing 101–137 of 137")).toBeInTheDocument();
  });

  it("shows 'Showing 0–0 of 0' for an empty result set, not a broken/negative range", () => {
    render(<PaginationControls page={1} pageCount={1} total={0} pageSize={25} />);
    expect(screen.getByText("Showing 0–0 of 0")).toBeInTheDocument();
  });
});

describe("PaginationControls — semantics (Pass 8 §4)", () => {
  it("is a <nav> landmark with an accessible name", () => {
    render(<PaginationControls page={2} pageCount={5} total={125} pageSize={25} />);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeInTheDocument();
  });

  it("uses a distinguishing accessible name when `label` is given (two pagers on one page)", () => {
    render(<PaginationControls page={2} pageCount={5} total={125} pageSize={25} pageParam="campaignsPage" label="campaigns" />);
    expect(screen.getByRole("navigation", { name: "campaigns pagination" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous campaigns page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next campaigns page" })).toBeInTheDocument();
  });

  it("the page-number input has a real associated <label>, not just aria-label", () => {
    render(<PaginationControls page={2} pageCount={5} total={125} pageSize={25} />);
    const input = screen.getByLabelText("Go to page");
    expect(input.tagName).toBe("INPUT");
    // getByLabelText only succeeds via a real <label for="..."> or
    // aria-labelledby association (not merely aria-label) unless the
    // element itself specifies aria-label — assert the <label> element
    // exists and points at this exact input via `for`/`id`.
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label).not.toBeNull();
  });

  it("communicates the current page via a live, readable 'Showing A–B of N' region", () => {
    render(<PaginationControls page={3} pageCount={9} total={225} pageSize={25} />);
    const status = screen.getByText("Showing 51–75 of 225");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});

describe("PaginationControls — keyboard and disabled-state behavior", () => {
  it("Previous is disabled (real disabled attribute) on the first page", () => {
    render(<PaginationControls page={1} pageCount={5} total={125} pageSize={25} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("Next is disabled on the last page", () => {
    render(<PaginationControls page={5} pageCount={5} total={125} pageSize={25} />);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("both are enabled on a middle page", () => {
    render(<PaginationControls page={3} pageCount={5} total={125} pageSize={25} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("Next is keyboard-activatable and navigates to page+1, preserving other URL params", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={3} pageCount={5} total={125} pageSize={25} />);
    const nextButton = screen.getByRole("button", { name: "Next page" });
    nextButton.focus();
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledWith("/leads?status=NEW&page=4");
  });

  it("typing a page number and pressing Enter navigates there", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={1} pageCount={20} total={500} pageSize={25} />);
    const input = screen.getByLabelText("Go to page");
    await user.clear(input);
    await user.type(input, "12");
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledWith("/leads?status=NEW&page=12");
  });

  it("an out-of-range page number (above pageCount) is clamped rather than navigating past the end", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={1} pageCount={5} total={125} pageSize={25} />);
    const input = screen.getByLabelText("Go to page");
    await user.clear(input);
    await user.type(input, "999");
    await user.keyboard("{Enter}");

    expect(push).toHaveBeenCalledWith("/leads?status=NEW&page=5");
  });

  it("page 1 omits the page param entirely from the URL", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={2} pageCount={5} total={125} pageSize={25} />);
    await user.click(screen.getByRole("button", { name: "Previous page" }));

    expect(push).toHaveBeenCalledWith("/leads?status=NEW");
  });
});

describe("PaginationControls — rows-per-page selector (Pass 12 §28/§30)", () => {
  it("offers exactly 25/50/75/100 as options", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={1} pageCount={5} total={125} pageSize={25} />);
    await user.click(screen.getByRole("combobox"));
    for (const size of [25, 50, 75, 100]) {
      expect(screen.getByRole("option", { name: String(size) })).toBeInTheDocument();
    }
  });

  it("changing the page size writes ?pageSize=50 to the URL and resets the page param", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={3} pageCount={5} total={125} pageSize={25} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "50" }));

    expect(push).toHaveBeenCalledWith("/leads?status=NEW&pageSize=50");
  });

  it("selecting the default 25 omits pageSize from the URL entirely (matches the default page-1-omits-page convention)", async () => {
    const user = userEvent.setup();
    render(<PaginationControls page={1} pageCount={2} total={125} pageSize={50} pageParam="page" pageSizeParam="pageSize" />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "25" }));

    expect(push).toHaveBeenCalledWith("/leads?status=NEW");
  });
});
