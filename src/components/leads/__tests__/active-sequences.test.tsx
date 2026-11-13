// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The lead-profile sequence notice, the Sequences tab and the Unenroll button. Server actions are mocked; the real rules (only an ACTIVE enrollment
// can be unenrolled, ownership, authorization, no send after unenroll) are proven in server/actions/__tests__/sequences.test.ts.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn() } }));
const unenroll = vi.fn();
vi.mock("@/server/actions/sequences", () => ({ unenrollLead: (...a: unknown[]) => unenroll(...a), enrollLeads: vi.fn() }));

const { LeadActiveSequencesNotice } = await import("../active-sequences");
const { LeadSequencesPanel } = await import("../lead-sequences-panel");

type E = Parameters<typeof LeadActiveSequencesNotice>[0]["enrollments"][number];
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

describe("LeadActiveSequencesNotice (shown when the lead profile opens)", () => {
  it("renders nothing when there is no genuinely active enrollment — failed, unsubscribed and completed ones do not count", () => {
    const { container } = render(
      <LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a", status: "FAILED" }), enr({ id: "b", status: "UNSUBSCRIBED" }), enr({ id: "c", status: "COMPLETED", completedAt: new Date() })]} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("active-sequences-notice")).toBeNull();
  });

  it("shows the real data of an active enrollment: name, status, who applied it, step X of Y, next email, and an Unenroll action", () => {
    render(<LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a", sequence: { id: "s-1", name: "5-Step Automated Email Sequence for New Leads", steps: steps(5) } })]} />);
    const notice = screen.getByTestId("active-sequences-notice");
    expect(within(notice).getByRole("heading", { name: "Active sequence" })).toBeInTheDocument();
    expect(within(notice).getByRole("link", { name: "5-Step Automated Email Sequence for New Leads" })).toHaveAttribute("href", "/sequences/s-1");
    expect(notice.textContent).toMatch(/Active/);
    expect(notice.textContent).toMatch(/by Tom Anderson/);
    expect(notice.textContent).toMatch(/Step 2 of 5/);
    expect(notice.textContent).toMatch(/Next email: Nov 14, 2026 at 4:55 PM/);
    expect(within(notice).getByRole("button", { name: "Unenroll from 5-Step Automated Email Sequence for New Leads" })).toBeInTheDocument();
  });

  it("several active sequences are listed separately, each with its own Unenroll; only the active ones among a mixed list", () => {
    render(
      <LeadActiveSequencesNotice
        leadId="lead-1"
        enrollments={[enr({ id: "a" }), enr({ id: "b", currentStepIdx: 0 }), enr({ id: "c", status: "FAILED" }), enr({ id: "d", status: "UNSUBSCRIBED" })]}
      />
    );
    const items = screen.getAllByTestId("active-sequence");
    expect(items).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "Active sequences (2)" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Unenroll from/ })).toHaveLength(2);
    expect(screen.queryByText("Sequence c")).toBeNull();
    expect(screen.queryByText("Sequence d")).toBeNull();
  });

  it("the step never runs past the last step, and a missing next send is simply not shown", () => {
    render(<LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a", currentStepIdx: 9, nextSendAt: null })]} />);
    const item = screen.getByTestId("active-sequence");
    expect(item.textContent).toMatch(/Step 5 of 5/);
    expect(item.textContent).not.toMatch(/Next email/);
  });
});

describe("Unenroll", () => {
  it("asks for confirmation first, and only then calls the server action with the enrollment AND the lead being viewed", async () => {
    const user = userEvent.setup();
    render(<LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a" })]} />);
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
    render(<LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a" })]} />);
    await user.click(screen.getByRole("button", { name: /^Unenroll from/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(unenroll).not.toHaveBeenCalled();
  });

  it("a refusal (e.g. already stopped) keeps the dialog open and shows the reason — it never looks like it worked", async () => {
    unenroll.mockResolvedValue({ ok: false, error: "This enrollment is no longer active." });
    const user = userEvent.setup();
    render(<LeadActiveSequencesNotice leadId="lead-1" enrollments={[enr({ id: "a" })]} />);
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

  it("separates Active from History, labels a failed one as stopped (never 'Step 2 of 5 · Next ...'), and gives history no Unenroll", () => {
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
    expect(items.find((i) => i.textContent?.includes("Sequence c"))!.textContent).toMatch(/Unsubscribed at step 2 of 5/);
    expect(items.find((i) => i.textContent?.includes("Sequence d"))!.textContent).toMatch(/Completed Oct 2, 2026/);
    expect(within(history).queryByRole("button", { name: /Unenroll/ })).toBeNull();
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
