// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const del = vi.fn();
vi.mock("@/server/actions/failed-signins", () => ({ deleteFailedSignInEvents: (...a: unknown[]) => del(...a) }));

const { FailedSignInsView } = await import("../failed-signins-view");

const row = (id: string, iso: string, over: Record<string, unknown> = {}) => ({
  id,
  occurredAt: iso,
  method: "GOOGLE_OAUTH",
  reasonCode: "UNKNOWN_ACCOUNT",
  attemptedEmail: null,
  verifiedEmail: null,
  verifiedFullName: null,
  ipAddress: "203.0.113.25",
  ipVersion: "v4",
  city: null,
  region: null,
  country: null,
  countryCode: null,
  geoSource: null,
  repeatCount: 1,
  ...over,
});
// 2026-11-20 in Los Angeles = 08:00Z..; 2026-11-19 = the day before
const DATA = {
  rows: [
    row("e1", "2026-11-20T17:19:22Z", { verifiedEmail: "sarah@example.com", verifiedFullName: "Sarah Wilson", reasonCode: "ACCOUNT_DISABLED", ipAddress: "2001:db8::1234", city: "Berlin", country: "Germany" }),
    row("e2", "2026-11-20T17:16:03Z", { attemptedEmail: "typed@yahoo.com" }),
    row("e3", "2026-11-20T17:15:12Z", { reasonCode: "GOOGLE_VERIFICATION_FAILED" }),
    row("e4", "2026-11-19T18:00:00Z", { verifiedEmail: "john.smith@gmail.com", verifiedFullName: "John Smith", city: "London", region: "England", country: "United Kingdom" }),
    row("e5", "2026-11-19T17:00:00Z", { reasonCode: "EVENTS_SUPPRESSED", repeatCount: 40 }),
  ],
  total: 14,
  page: 1,
  pageSize: 25,
  pageCount: 1,
  dayTotals: { "2026-11-20": 14, "2026-11-19": 2 },
  indicators: { e2: ["6 attempts from this address in the last 10 minutes"] },
};
const render_ = () => render(<FailedSignInsView data={DATA as never} filters={{}} />);

beforeEach(() => vi.clearAllMocks());

describe("layout", () => {
  it("groups by business day, newest first, with the day's TOTAL (not just the rows on this page) in each heading", () => {
    render_();
    const groups = screen.getAllByTestId("day-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveTextContent("November 20, 2026");
    expect(groups[0]).toHaveTextContent("14 failed attempts");
    expect(groups[1]).toHaveTextContent("November 19, 2026");
    expect(groups[1]).toHaveTextContent("2 failed attempts");
  });

  it("every attempt is its own row (three attempts the same day from the same address are three rows)", () => {
    render_();
    expect(within(screen.getAllByTestId("day-group")[0]).getAllByTestId("failed-signin-row")).toHaveLength(3);
  });

  it("shows name, email, full IP, approximate location, exact time with seconds and the reason; verified and unverified identities are labelled", () => {
    render_();
    const first = screen.getAllByTestId("failed-signin-row")[0];
    expect(first).toHaveTextContent("Sarah Wilson");
    expect(first).toHaveTextContent("sarah@example.com");
    expect(first).toHaveTextContent("verified");
    expect(first).toHaveTextContent("2001:db8::1234"); // complete address
    expect(first).toHaveTextContent("Berlin, Germany");
    expect(first).toHaveTextContent("09:19:22"); // 17:19:22Z in Los Angeles, with seconds
    expect(first).toHaveTextContent("Account disabled");
    const second = screen.getAllByTestId("failed-signin-row")[1];
    expect(second).toHaveTextContent("typed@yahoo.com");
    expect(second).toHaveTextContent("unverified");
    expect(second).toHaveTextContent("Unavailable"); // no verified name: never invented
  });

  it("an unverifiable attempt shows 'Unavailable' for name and email, and a missing location says so", () => {
    render_();
    const third = screen.getAllByTestId("failed-signin-row")[2];
    expect(third).toHaveTextContent("OAuth authentication failure");
    expect(third.textContent?.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(2);
    expect(third).toHaveTextContent("Location unavailable");
  });

  it("security indicators calculated from the events are shown on the row; a roll-up row shows its count", () => {
    render_();
    expect(screen.getByTestId("indicator")).toHaveTextContent("6 attempts from this address in the last 10 minutes");
    expect(screen.getAllByTestId("failed-signin-row")[4]).toHaveTextContent("x40");
  });

  it("an empty result is an explicit empty state", () => {
    render(<FailedSignInsView data={{ ...DATA, rows: [], total: 0, dayTotals: {}, indicators: {} } as never} filters={{}} />);
    expect(screen.getByText("No failed sign-ins")).toBeInTheDocument();
  });
});

describe("selection and deletion", () => {
  it("'select all' selects ONLY the rows on this page and the count says so", async () => {
    const user = userEvent.setup();
    render_();
    await user.click(screen.getByRole("checkbox", { name: "Select all records on this page" }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("5 selected"); // the 5 rows shown, not the 14 matching
    await user.click(screen.getByRole("checkbox", { name: "Select all records on this page" }));
    expect(screen.getByTestId("selected-count")).toHaveTextContent("0 selected");
  });

  it("Delete selected is disabled until something is selected; it asks for confirmation naming the count, and sends exactly the selected ids", async () => {
    del.mockResolvedValue({ ok: true, deleted: 2, requested: 2 });
    const user = userEvent.setup();
    render_();
    const button = screen.getByRole("button", { name: "Delete selected" });
    expect(button).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select attempt e2" }));
    await user.click(screen.getByRole("checkbox", { name: "Select attempt e4" }));
    await user.click(button);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete 2 failed sign-in records?");
    expect(del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Delete records" }));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect((del.mock.calls[0][0] as string[]).sort()).toEqual(["e2", "e4"]);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("a single record can be deleted from its own row, after confirmation", async () => {
    del.mockResolvedValue({ ok: true, deleted: 1, requested: 1 });
    const user = userEvent.setup();
    render_();
    await user.click(screen.getByRole("button", { name: "Delete attempt e3" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete records" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(["e3"]));
  });

  it("Cancel deletes nothing; a refusal from the server stays visible in the dialog", async () => {
    const user = userEvent.setup();
    render_();
    await user.click(screen.getByRole("button", { name: "Delete attempt e3" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(del).not.toHaveBeenCalled();
    del.mockResolvedValue({ ok: false, error: "Select at most 200 records at a time." });
    await user.click(screen.getByRole("button", { name: "Delete attempt e3" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete records" }));
    expect(await screen.findByText(/at most 200/)).toBeInTheDocument();
  });
});

describe("inspecting an event", () => {
  it("shows every field, keeps verified and attempted identities apart, and says an IP does not identify a person", async () => {
    const user = userEvent.setup();
    render_();
    await user.click(screen.getByRole("button", { name: "Inspect attempt e2" }));
    const details = await screen.findByTestId("event-details");
    expect(details).toHaveTextContent("e2");
    expect(details).toHaveTextContent("Attempted email (unverified)");
    expect(details).toHaveTextContent("typed@yahoo.com");
    expect(details).toHaveTextContent("2026-11-20 17:16:03");
    expect(screen.getByText(/does not identify a person/)).toBeInTheDocument();
  });
});

describe("filters", () => {
  it("the filter form submits by GET (URL-driven, server-side) with search, dates, reason, method and IP fields", () => {
    const { container } = render_();
    const form = container.querySelector("form[aria-label='Filter failed sign-ins']") as HTMLFormElement;
    expect(form.method).toBe("get");
    for (const name of ["q", "from", "to", "reason", "method", "ip"]) expect(form.querySelector(`[name='${name}']`), name).toBeTruthy();
  });
});

describe("FailedSignInsView - the data licence credit", () => {
  it("shows the DB-IP CC BY 4.0 credit once when any location on the page came from DB-IP, and nothing when none did", () => {
    const withDbip = { ...DATA, rows: DATA.rows.map((r, i) => (i === 0 ? { ...r, geoSource: "DBIP-City-Lite (2026-11-01)" } : r)) };
    const { unmount } = render(<FailedSignInsView data={withDbip as never} filters={{}} />);
    const credit = screen.getAllByTestId("geoip-attribution");
    expect(credit).toHaveLength(1);
    expect(credit[0].textContent).toMatch(/approximate estimates .* not where a person is/);
    expect(credit[0].textContent).toMatch(/IP geolocation by DB-IP \(https:\/\/db-ip\.com\), licensed under CC BY 4\.0/);
    unmount();
    render(<FailedSignInsView data={DATA as never} filters={{}} />);
    expect(screen.queryByTestId("geoip-attribution")).toBeNull();
  });
});

describe("FailedSignInsView - location format matches the Users page", () => {
  it("'City, Region, Country (CC)' with only the parts that exist and a repeated neighbour dropped; nothing known reads 'Location unavailable'", () => {
    const rows = [
      { ...DATA.rows[0], id: "f1", city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE" },
      { ...DATA.rows[0], id: "f2", city: "Singapore", region: "Singapore", country: "Singapore", countryCode: "SG" },
      { ...DATA.rows[0], id: "f3", city: null, region: null, country: "France", countryCode: "FR" },
      { ...DATA.rows[0], id: "f4", city: null, region: null, country: null, countryCode: null },
    ];
    render(<FailedSignInsView data={{ ...DATA, rows, total: 4 } as never} filters={{}} />);
    const text = screen.getAllByTestId("failed-signin-row").map((r) => r.textContent ?? "").join("\n");
    expect(text).toContain("Frankfurt am Main, Hesse, Germany (DE)");
    expect(text).toContain("Singapore, Singapore (SG)");
    expect(text).not.toContain("Singapore, Singapore, Singapore");
    expect(text).toContain("France (FR)");
    expect(text).toContain("Location unavailable");
  });
});
