// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The lead Sequences tab (the one place a lead's sequence status lives) and the Unenroll button. The former "Active sequence" block above the tabs was removed. Server actions are mocked; the real rules (only an ACTIVE enrollment
// can be unenrolled, ownership, authorization, no send after unenroll) are proven in server/actions/__tests__/sequences.test.ts.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));
const unenroll = vi.fn();
vi.mock("@/server/actions/sequences", () => ({ unenrollLead: (...a: unknown[]) => unenroll(...a), enrollLeads: vi.fn() }));

const { LeadSequencesPanel } = await import("../lead-sequences-panel");

type E = Parameters<typeof LeadSequencesPanel>[0]["enrollments"][number];
const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }));
const enr = (o: Partial<E> & { id: string }): E => ({
  status: "ACTIVE",
  currentStepIdx: 1,
  enrolledAt: new Date(Date.now() - 15 * 3600_000),
  nextSendAt: new Date("2026-11-14T16:55:00"),
  completedAt: null,
  sequence: { id: `seq-${o.id}`, name: `Sequence ${o.id}`, steps: steps(5) },
  enrolledBy: { fullName: "Tom Anderson" },
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  unenroll.mockResolvedValue({ ok: true });
});

const renderPanel = (enrollments: E[], available: { id: string; name: string; description: string | null; stepCount: number }[] = []) =>
  render(<LeadSequencesPanel leadId="lead-1" availableSequences={available} enrollments={enrollments} />);

describe("the main lead details no longer carry a separate Active sequence block", () => {
  it("neither the lead page nor the shared component file mentions the removed notice, and the page still renders the Sequences tab", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const page = fs.readFileSync(path.join(process.cwd(), "src", "app", "(crm)", "leads", "[id]", "page.tsx"), "utf8");
    const shared = fs.readFileSync(path.join(process.cwd(), "src", "components", "leads", "active-sequences.tsx"), "utf8");
    expect(page).not.toMatch(/LeadActiveSequencesNotice|active-sequences-notice/);
    expect(shared).not.toMatch(/LeadActiveSequencesNotice|active-sequences-notice/);
    expect(page).toMatch(/LeadSequencesPanel/);
  });
});

describe("Sequences tab: active enrollment", () => {
  it("shows the real data of an active enrollment: name, status, who applied it, step X of Y, next email, and an Unenroll action", () => {
    renderPanel([enr({ id: "a", sequence: { id: "s-1", name: "5-Step Automated Email Sequence for New Leads", steps: steps(5) } })]);
    const card = screen.getByTestId("active-sequence");
    expect(within(card).getByRole("link", { name: "5-Step Automated Email Sequence for New Leads" })).toHaveAttribute("href", "/sequences/s-1");
    expect(card.textContent).toMatch(/Active/);
    expect(card.textContent).toMatch(/by Tom Anderson/);
    expect(card.textContent).toMatch(/Step 2 of 5/);
    expect(card.textContent).toMatch(/Next email: Nov 14, 2026 at 4:55 PM/);
    expect(within(card).getByRole("button", { name: "Unenroll from 5-Step Automated Email Sequence for New Leads" })).toBeInTheDocument();
  });

  it("several active sequences are listed separately, each with its own Unenroll; failed and unenrolled ones are history, not active - and only the FAILED one offers an Unenroll there", () => {
    renderPanel([enr({ id: "a" }), enr({ id: "b", currentStepIdx: 0 }), enr({ id: "c", status: "FAILED" }), enr({ id: "d", status: "UNSUBSCRIBED" })]);
    expect(screen.getAllByTestId("active-sequence")).toHaveLength(2);
    const active = screen.getByRole("region", { name: "Active sequences" });
    expect(within(active).getAllByRole("button", { name: /^Unenroll from/ })).toHaveLength(2);
    const history = screen.getByRole("region", { name: "Sequence history" });
    const items = within(history).getAllByTestId("sequence-history-item");
    expect(items).toHaveLength(2);
    // exactly ONE Unenroll in all of History, on the failed enrollment, next to its Retry (never two Unenroll buttons for one enrollment)
    expect(within(history).getAllByRole("button", { name: /^Unenroll from/ })).toHaveLength(1);
    const failed = items.find((i) => i.textContent?.includes("Sequence c"))!;
    expect(within(failed).getByRole("button", { name: "Unenroll from Sequence c" })).toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: "Retry Sequence c now" })).toBeInTheDocument();
    expect(within(items.find((i) => i.textContent?.includes("Sequence d"))!).queryByRole("button", { name: /Unenroll/ })).toBeNull();
  });

  it("a REPLIED enrollment is history, says the customer replied and the rest was cancelled automatically, and offers nothing to do", () => {
    renderPanel([enr({ id: "r", status: "REPLIED", nextSendAt: null, stopReason: "REPLIED", stoppedAt: new Date("2026-11-20T10:30:00") })]);
    expect(screen.queryByTestId("active-sequence")).toBeNull();
    const item = screen.getByTestId("sequence-history-item");
    expect(item.textContent).toMatch(/Replied — Automatically stopped/);
    expect(item.textContent).toMatch(/The customer replied Nov 20, 2026 at 10:30 AM - the remaining emails were cancelled automatically/);
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("an enrollment that is due but waiting for the sender's Gmail capacity says so instead of showing a time that has passed", () => {
    renderPanel([enr({ id: "w", currentStepIdx: 0, nextSendAt: new Date(Date.now() - 600_000), waitReason: "CAPACITY" })]);
    const card = screen.getByTestId("active-sequence");
    expect(card).toHaveAttribute("data-state", "waiting");
    expect(card.textContent).toMatch(/Scheduled — Waiting for available Gmail sending capacity/);
    expect(screen.getByTestId("waiting-note").textContent).toMatch(/goes out automatically when capacity frees up/);
  });

  it("the step never runs past the last step, and a missing next send is simply not shown", () => {
    renderPanel([enr({ id: "a", currentStepIdx: 9, nextSendAt: null })]);
    const item = screen.getByTestId("active-sequence");
    expect(item.textContent).toMatch(/Step 5 of 5/);
    expect(item.textContent).not.toMatch(/Next email/);
  });

  it("a lead with no active enrollment (failed, unsubscribed, completed only) has no Active region at all", () => {
    renderPanel([enr({ id: "a", status: "FAILED" }), enr({ id: "b", status: "UNSUBSCRIBED" }), enr({ id: "c", status: "COMPLETED", completedAt: new Date() })]);
    expect(screen.queryByRole("region", { name: "Active sequences" })).toBeNull();
    expect(screen.queryByTestId("active-sequence")).toBeNull();
  });
});

describe("Unenroll", () => {
  it("asks for confirmation first, and only then calls the server action with the enrollment AND the lead being viewed", async () => {
    const user = userEvent.setup();
    renderPanel([enr({ id: "a" })]);
    await user.click(screen.getByRole("button", { name: /^Unenroll from/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/already sent stay in the history/)).toBeInTheDocument();
    expect(unenroll).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Unenroll" }));
    await waitFor(() => expect(unenroll).toHaveBeenCalledWith("a", "lead-1"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalledWith("Lead unenrolled");
  });

  it("Cancel does nothing", async () => {
    const user = userEvent.setup();
    renderPanel([enr({ id: "a" })]);
    await user.click(screen.getByRole("button", { name: /^Unenroll from/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(unenroll).not.toHaveBeenCalled();
  });

  it("a refusal (e.g. already stopped) keeps the dialog open and shows the reason — it never looks like it worked", async () => {
    unenroll.mockResolvedValue({ ok: false, error: "This enrollment is no longer active." });
    const user = userEvent.setup();
    renderPanel([enr({ id: "a" })]);
    await user.click(screen.getByRole("button", { name: /^Unenroll from/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Unenroll" }));
    expect(await within(dialog).findByText("This enrollment is no longer active.")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("Sequences tab", () => {
  const available = [
    { id: "seq-a", name: "Sequence a", description: null, stepCount: 5 },
    { id: "seq-b", name: "Sequence b", description: null, stepCount: 5 },
    { id: "seq-c", name: "Sequence c", description: null, stepCount: 5 },
  ];

  it("separates Active from History, labels a failed one as stopped (never 'Step 2 of 5 · Next ...'); history offers Unenroll ONLY for the failed one", () => {
    render(
      <LeadSequencesPanel
        leadId="lead-1"
        availableSequences={available}
        enrollments={[enr({ id: "a" }), enr({ id: "b", status: "FAILED", nextSendAt: null, currentStepIdx: 0 }), enr({ id: "c", status: "UNSUBSCRIBED", nextSendAt: null }), enr({ id: "d", status: "COMPLETED", completedAt: new Date(2026, 9, 2, 12), nextSendAt: null, currentStepIdx: 5 })]}
      />
    );
    const active = screen.getByRole("region", { name: "Active sequences" });
    expect(within(active).getAllByTestId("active-sequence")).toHaveLength(1);
    const history = screen.getByRole("region", { name: "Sequence history" });
    const items = within(history).getAllByTestId("sequence-history-item");
    expect(items).toHaveLength(3);
    const failed = items.find((i) => i.textContent?.includes("Sequence b"))!;
    expect(failed.textContent).toMatch(/Failed/);
    expect(failed.textContent).toMatch(/Stopped at step 1 of 5 - no further emails will be sent/);
    expect(failed.textContent).not.toMatch(/Next/);
    // an enrollment ended by staff (or an older row with no recorded reason) reads Unenrolled; only a customer's own unsubscribe reads Unsubscribed
    expect(items.find((i) => i.textContent?.includes("Sequence c"))!.textContent).toMatch(/Unenrolled at step 2 of 5/);
    expect(items.find((i) => i.textContent?.includes("Sequence d"))!.textContent).toMatch(/Completed Oct 2, 2026/);
    expect(within(history).getAllByRole("button", { name: /^Unenroll from/ })).toHaveLength(1);
    expect(within(failed).getByRole("button", { name: "Unenroll from Sequence b" })).toBeInTheDocument();
  });

  it("a customer's own unsubscribe is worded as the customer's doing", () => {
    renderPanel([enr({ id: "u", status: "UNSUBSCRIBED", nextSendAt: null, stopReason: "CUSTOMER_UNSUBSCRIBED" })]);
    const item = screen.getByTestId("sequence-history-item");
    expect(item.textContent).toMatch(/The customer unsubscribed at step 2 of 5/);
    expect(item.textContent).toMatch(/Unsubscribed/);
  });

  it("Unenroll on a FAILED enrollment asks first, says it ends for good, then calls the server action for that enrollment and refreshes", async () => {
    const user = userEvent.setup();
    renderPanel([enr({ id: "f", status: "FAILED", nextSendAt: null, currentStepIdx: 2 })]);
    await user.click(screen.getByRole("button", { name: "Unenroll from Sequence f" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/has stopped for this lead\. Unenrolling ends it for good/);
    expect(unenroll).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Unenroll" }));
    await waitFor(() => expect(unenroll).toHaveBeenCalledWith("f", "lead-1"));
    expect(toastSuccess).toHaveBeenCalledWith("Lead unenrolled");
    expect(refresh).toHaveBeenCalled();
  });

  it("with no enrollment at all it shows the empty state, and a failed enrollment does not look like an active one", () => {
    const { unmount } = render(<LeadSequencesPanel leadId="lead-1" availableSequences={available} enrollments={[]} />);
    expect(screen.getByText("No sequences applied")).toBeInTheDocument();
    unmount();
    render(<LeadSequencesPanel leadId="lead-1" availableSequences={available} enrollments={[enr({ id: "a", status: "FAILED" })]} />);
    expect(screen.queryByRole("region", { name: "Active sequences" })).toBeNull();
    expect(screen.queryByTestId("active-sequence")).toBeNull();
  });
});
