// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@/test/rtl-setup";

vi.mock("@/server/actions/sequences", () => ({ unenrollLead: vi.fn(async () => ({ ok: true })) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { SequenceEnrollmentsTable } = await import("../sequence-enrollments-table");

const steps = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
const D = (day: number, h = 9) => new Date(2026, 10, day, h, 0, 0);
const contact = (first: string, email: string | null) => ({ contact: { firstName: first, lastName: "Test", primaryEmail: email } });

const base = { recipientEmail: null, leadVisible: true, stepLogs: [] as never[] };
const rows = [
  { ...base, id: "e1", leadId: "l1", status: "ACTIVE" as const, currentStepIdx: 1, enrolledAt: D(10), nextSendAt: D(17), lead: contact("Ada", "ada@example.com"),
    stepLogs: [{ stepId: "s1", status: "SENT" as const, sentAt: D(10, 9), createdAt: D(10, 9), error: null }] },
  { ...base, id: "e2", leadId: "l2", status: "FAILED" as const, currentStepIdx: 0, enrolledAt: D(11), nextSendAt: null, lead: contact("Bob", "bob@example.com"),
    stepLogs: [{ stepId: "s1", status: "FAILED" as const, sentAt: null, createdAt: D(11), error: "Gmail is not connected" }] },
  { ...base, id: "e3", leadId: "l3", status: "UNSUBSCRIBED" as const, currentStepIdx: 1, enrolledAt: D(9), nextSendAt: null, lead: contact("Cy", "cy@example.com"),
    stepLogs: [{ stepId: "s1", status: "SENT" as const, sentAt: D(9, 10), createdAt: D(9, 10), error: null }] },
  { ...base, id: "e4", leadId: "l4", status: "COMPLETED" as const, currentStepIdx: 3, enrolledAt: D(1), nextSendAt: null, lead: contact("Di", "di@example.com") },
  { ...base, id: "e5", leadId: "l5", status: "ACTIVE" as const, currentStepIdx: 0, enrolledAt: D(12), nextSendAt: D(13), leadVisible: false, lead: contact("Ed", "secret@example.com") },
];

function view(over: Partial<React.ComponentProps<typeof SequenceEnrollmentsTable>> = {}) {
  return render(<SequenceEnrollmentsTable enrollments={rows} steps={steps} sequenceName="Welcome" sequenceActive canUnenroll {...over} />);
}
const rowOf = (name: string) => screen.getByText(new RegExp(`^${name} Test`)).closest("tr") as HTMLElement;

describe("SequenceEnrollmentsTable", () => {
  it("lists every enrolled lead with its status, and real step progress for each", () => {
    view();
    expect(screen.getAllByTestId("enrollment-row")).toHaveLength(5);
    const ada = within(rowOf("Ada"));
    expect(ada.getByText("Active")).toBeInTheDocument();
    expect(ada.getByText("1 of 3 sent")).toBeInTheDocument();
    expect(ada.getByText("1: Sent")).toBeInTheDocument();
    expect(ada.getByText("2: Scheduled")).toBeInTheDocument();
    expect(ada.getByText("3: Pending")).toBeInTheDocument();
    expect(ada.getByText(/Step 2 · Nov 17, 2026 9:00 AM/)).toBeInTheDocument(); // next scheduled step and time
    expect(ada.getByText(/Step 1 · Nov 10, 2026 9:00 AM/)).toBeInTheDocument(); // last step that actually went out
  });

  it("a failed enrollment is identifiable, says where and why it stopped, and offers Retry and ONE Unenroll", () => {
    view();
    const bob = within(rowOf("Bob"));
    expect(bob.getByText("Failed", { selector: "span,div" })).toBeInTheDocument();
    expect(bob.getByText("1: Failed")).toBeInTheDocument();
    expect(bob.getByText(/Stopped at step 1: Gmail is not connected/)).toBeInTheDocument();
    expect(bob.getByText("None yet")).toBeInTheDocument();
    expect(bob.getAllByRole("button", { name: /unenroll/i })).toHaveLength(1); // never two for one enrollment
    expect(bob.getByRole("button", { name: /retry welcome now/i })).toBeInTheDocument();
  });

  it("an unenrolled lead keeps what was sent as history, shows the rest as cancelled, and has nothing scheduled", () => {
    view();
    const cy = within(rowOf("Cy"));
    expect(cy.getByText("1: Sent")).toBeInTheDocument();
    expect(cy.getByText("2: Cancelled")).toBeInTheDocument();
    expect(cy.getByText("3: Cancelled")).toBeInTheDocument();
    expect(cy.getByText("No further steps")).toBeInTheDocument();
    expect(cy.queryByRole("button", { name: /unenroll/i })).toBeNull();
  });

  it("a REPLIED enrollment says so, keeps what was sent, cancels the rest, and has no actions", () => {
    const base = rows[0];
    render(
      <SequenceEnrollmentsTable
        enrollments={[{ ...base, id: "r1", status: "REPLIED", currentStepIdx: 1, nextSendAt: null, stopReason: "REPLIED", stoppedAt: new Date("2026-11-20T10:30:00"), stepLogs: [base.stepLogs[0]] }]}
        steps={steps}
        sequenceName="Welcome"
        sequenceActive
        canUnenroll
      />
    );
    const row = within(screen.getByTestId("enrollment-row"));
    expect(row.getAllByText("Replied — Automatically stopped").length).toBeGreaterThan(0);
    expect(row.getByText("2: Cancelled")).toBeInTheDocument();
    expect(row.getByText(/The customer replied Nov 20, 2026 10:30 AM; the remaining steps were cancelled/)).toBeInTheDocument();
    expect(row.queryByRole("button")).toBeNull();
  });

  it("a completed enrollment shows every step sent", () => {
    view();
    expect(within(rowOf("Di")).getByText("3 of 3 sent")).toBeInTheDocument();
  });

  it("only ACTIVE and FAILED enrollments have an Unenroll button (one each), and it names the sequence; stopped and finished ones have none", () => {
    view();
    const buttons = screen.getAllByRole("button", { name: /unenroll from welcome/i });
    expect(buttons).toHaveLength(3); // Ada and Ed (ACTIVE) and Bob (FAILED)
    expect(within(rowOf("Cy")).queryByRole("button", { name: /unenroll/i })).toBeNull(); // already unenrolled
    expect(within(rowOf("Di")).queryByRole("button", { name: /unenroll/i })).toBeNull(); // completed
  });

  it("a viewer who may not unenroll gets no buttons at all", () => {
    view({ canUnenroll: false });
    expect(screen.queryAllByRole("button", { name: /unenroll/i })).toHaveLength(0);
  });

  it("an email is shown only for leads the viewer may see; otherwise it is withheld", () => {
    view();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByText("secret@example.com")).toBeNull();
    expect(within(rowOf("Ed")).getByText("Hidden")).toBeInTheDocument();
  });

  it("when the sequence is switched off, active enrollments are shown as paused, with no promised send time", () => {
    view({ sequenceActive: false });
    const ada = within(rowOf("Ada"));
    expect(ada.getByText("2: Paused")).toBeInTheDocument();
    expect(ada.getByText(/Paused: the sequence is switched off/)).toBeInTheDocument();
    expect(ada.getByText("Step 2 · paused")).toBeInTheDocument();
    expect(ada.queryByText(/Nov 17, 2026/)).toBeNull();
  });

  it("an explicitly chosen recipient is the address shown (what the emails really go to)", () => {
    view({ enrollments: [{ ...rows[0], recipientEmail: "ada.work@example.com, ada.home@example.com" }] });
    expect(screen.getByText("ada.work@example.com, ada.home@example.com")).toBeInTheDocument();
  });
});
