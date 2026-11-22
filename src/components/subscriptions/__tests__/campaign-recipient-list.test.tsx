// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import type { RecipientPage, RecipientRow } from "@/server/queries/campaign-recipients";

// The recipient-level Delivery Status list and its per-recipient Cancel. Server actions are mocked; the real rules (atomic cancellation, ownership, the worker race) are proven in
// server/actions/__tests__/campaign-delivery-and-imports.test.ts and server/marketing/__tests__/campaign-worker.test.ts. Synthetic addresses only.

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => "/subscriptions/campaigns/c1",
  useSearchParams: () => new URLSearchParams("dsize=25"),
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));
const cancel = vi.fn();
vi.mock("@/server/actions/campaign-delivery", () => ({ cancelCampaignRecipient: (...a: unknown[]) => cancel(...a) }));

const { CampaignRecipientList } = await import("../campaign-recipient-list");

const at = (iso: string) => new Date(iso);
const row = (over: Partial<RecipientRow> & Pick<RecipientRow, "id" | "email" | "group" | "label">): RecipientRow => ({ at: null, atKind: null, reason: null, canCancel: false, ...over });
const ROWS: RecipientRow[] = [
  row({ id: "r1", email: "ada@example.test", group: "SENT", label: "Sent", at: at("2026-11-22T19:00:00Z"), atKind: "sent" }),
  row({ id: "r2", email: "bea@example.test", group: "SCHEDULED", label: "Scheduled", at: at("2026-11-23T20:00:00Z"), atKind: "earliest", reason: "Daily sending limit reached (400 per 24 hours from the sending Gmail account). Sending continues automatically when capacity frees up.", canCancel: true }),
  row({ id: "r3", email: "cy@example.test", group: "WAITING", label: "Waiting", reason: "In the sending queue", canCancel: true }),
  row({ id: "r4", email: "dee@example.test", group: "UNKNOWN", label: "Outcome unknown", reason: "No answer from Gmail. It is not sent again automatically." }),
  row({ id: "r5", email: "eli@example.test", group: "FAILED", label: "Failed", reason: "Sending failed" }),
  row({ id: "r6", email: "fay@example.test", group: "CANCELLED", label: "Cancelled", reason: "Cancelled before it was sent" }),
];
const PAGE = (over: Partial<RecipientPage> = {}): RecipientPage => ({
  campaignStatus: "SENDING",
  scheduledAt: null,
  total: 6,
  page: 1,
  pageSize: 25,
  pageCount: 1,
  groupCounts: [["SENT", "Sent"], ["SCHEDULED", "Scheduled"], ["WAITING", "Waiting"], ["UNKNOWN", "Outcome unknown"], ["FAILED", "Failed"], ["CANCELLED", "Cancelled"]].map(([group, label]) => ({ group: group as never, label, count: 1 })),
  rows: ROWS,
  dailyLimitReached: true,
  ...over,
});
const view = (data = PAGE(), emailRestricted = false) => render(<CampaignRecipientList campaignId="c1" data={data} emailRestricted={emailRestricted} />);

beforeEach(() => vi.clearAllMocks());

describe("CampaignRecipientList", () => {
  it("lists every status in the required order, each under its own heading, with the email and a status badge", () => {
    view();
    expect(screen.getAllByTestId("recipient-group-heading").map((h) => h.textContent)).toEqual(["Sent (1)", "Scheduled (1)", "Waiting (1)", "Outcome unknown (1)", "Failed (1)", "Cancelled (1)"]);
    const items = screen.getAllByTestId("campaign-recipient");
    expect(items.map((i) => i.textContent?.split(/Sent|Scheduled|Waiting|Outcome|Failed|Cancelled/)[0])).toEqual(["ada@example.test", "bea@example.test", "cy@example.test", "dee@example.test", "eli@example.test", "fay@example.test"]);
    for (const label of ["Sent", "Scheduled", "Waiting", "Outcome unknown", "Failed", "Cancelled"]) expect(within(items.find((i) => i.textContent?.includes(label))!).getAllByText(label).length).toBeGreaterThan(0); // a status badge on every row
  });

  it("the summary line gives accurate counts, and the heading carries the total", () => {
    view();
    expect(screen.getByText("Delivery Status (6)")).toBeInTheDocument();
    expect(screen.getByTestId("recipient-summary")).toHaveTextContent("Sent 1 · Scheduled 1 · Waiting 1 · Outcome unknown 1 · Failed 1 · Cancelled 1");
  });

  it("Sent shows when it was sent (in Pacific time, named); it is plainly 'accepted by Gmail', not 'delivered'", () => {
    view();
    const sent = screen.getAllByTestId("campaign-recipient")[0];
    expect(sent).toHaveTextContent(/Sent Nov 22, 11:00 AM PT/);
    expect(screen.getByText(/Sent means accepted by Gmail; inbox delivery is not tracked/)).toBeInTheDocument();
  });

  it("Scheduled shows the actual reason (daily limit) and the EARLIEST time, never a promised delivery time", () => {
    view();
    const scheduled = screen.getAllByTestId("campaign-recipient")[1];
    expect(within(scheduled).getByTestId("recipient-reason")).toHaveTextContent("Daily sending limit reached (400 per 24 hours");
    expect(scheduled).toHaveTextContent(/Earliest Nov 23, 12:00 PM PT/);
    expect(scheduled.textContent).not.toMatch(/delivered at|will be sent at|arrives/i);
  });

  it("a Cancel control appears ONLY next to recipients that can still be cancelled (Scheduled, Waiting) - never Sent, Outcome unknown, Failed or Cancelled", () => {
    view();
    const buttons = screen.getAllByRole("button", { name: /^Cancel sending to/ });
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Cancel sending to bea@example.test", "Cancel sending to cy@example.test"]);
    for (const email of ["ada@example.test", "dee@example.test", "eli@example.test", "fay@example.test"]) expect(screen.queryByRole("button", { name: `Cancel sending to ${email}` })).toBeNull();
  });

  it("a viewer subject to email masking sees masked addresses everywhere, including the cancel button's name", () => {
    const { container } = view(PAGE(), true);
    expect(container.textContent).not.toContain("ada@example.test");
    expect(container.textContent).not.toContain("bea@example.test");
    expect(screen.getByText("a*a@example.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel sending to b*a@example.test" })).toBeInTheDocument();
  });

  it("a cancelled campaign shows Cancelled recipients without any Cancel control; an empty list says why", () => {
    const { unmount } = view(PAGE({ campaignStatus: "CANCELLED", rows: [row({ id: "r9", email: "gus@example.test", group: "CANCELLED", label: "Cancelled", reason: "The campaign was cancelled before this message was sent" })], total: 1, groupCounts: [{ group: "CANCELLED", label: "Cancelled", count: 1 }] }));
    expect(screen.queryByRole("button", { name: /^Cancel sending to/ })).toBeNull();
    unmount();
    view(PAGE({ campaignStatus: "SCHEDULED", total: 0, rows: [], groupCounts: [] }));
    expect(screen.getByTestId("recipient-empty")).toHaveTextContent("Recipients are listed here once sending starts.");
  });

  it("pagination: a rows-per-page selector (25 / 50 / 75 / 100) and 'Showing A-B of N' that belong to THIS list (their own URL parameters)", async () => {
    const user = userEvent.setup();
    view(PAGE({ total: 130, pageCount: 6, page: 1, pageSize: 25 }));
    expect(screen.getByText(/Showing 1.+25 of 130/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Rows per recipients page" }));
    for (const n of ["25", "50", "75", "100"]) expect(screen.getByRole("option", { name: n })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "100" }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0][0])).toContain("dsize=100"); // this list's own parameter; the campaign page's other parameters are kept
  });
});

describe("CancelRecipientButton (inside the list)", () => {
  const open = async () => {
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Cancel sending to cy@example.test" }));
    return { user, dialog: await screen.findByRole("alertdialog") };
  };

  it("asks for confirmation first - nothing is sent to the server until the user confirms - and says the rest of the campaign continues", async () => {
    const { dialog } = await open();
    expect(within(dialog).getByText(/This one message will not be sent. The rest of the campaign continues/)).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("confirming cancels exactly that recipient of exactly that campaign, then refreshes the list", async () => {
    cancel.mockResolvedValue({ ok: true });
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: "Cancel recipient" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("c1", "r3"));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Recipient cancelled"));
    expect(refresh).toHaveBeenCalled();
  });

  it("'Keep' cancels nothing", async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("when the server refuses (for example the worker had already started on it) the reason is shown and the list is refreshed - it never looks as if it worked", async () => {
    cancel.mockResolvedValue({ ok: false, error: "Sending to this recipient has already started, so it can no longer be cancelled. Its outcome is shown as unknown." });
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: "Cancel recipient" }));
    expect(await within(dialog).findByText(/already started, so it can no longer be cancelled/)).toBeInTheDocument();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled(); // so the row now shows what really happened
  });
});
