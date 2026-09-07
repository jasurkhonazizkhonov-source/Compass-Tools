// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ReassignLeadDialog } from "../reassign-lead-dialog";

// Pass 7 §1/§15 — every Lead the current user is authorized to manage must
// have a clearly accessible Reassign action, using one consistent dialog
// UI across every entry point (Leads list row, Lead detail page). This
// covers the dialog component itself.
//
// Pass 10 §7/§25 — an unassigned Lead (currentOwnerId=null) is a valid,
// first-class ownership state, not a degraded case: the exact same dialog
// and the exact same reassignLead() call handle it, wording "Assign"
// instead of "Reassign" since there's no prior owner to reassign FROM.

const { reassignLead } = vi.hoisted(() => ({
  reassignLead: vi.fn(async () => ({})),
}));
vi.mock("@/server/actions/leads", () => ({ reassignLead }));

const AGENTS = [
  { id: "agent-a", fullName: "Agent A" },
  { id: "agent-b", fullName: "Agent B" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReassignLeadDialog — an already-owned Lead (Reassign wording)", () => {
  it("shows the current owner explicitly and excludes them from the New Owner picker", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId="agent-a" currentOwnerName="Agent A" agents={AGENTS} trigger={<button>Reassign</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Reassign" }));

    expect(screen.getByText("Current owner:")).toBeInTheDocument();
    expect(screen.getAllByText("Agent A").length).toBeGreaterThan(0);
    expect(screen.getByRole("dialog", { name: "Reassign Lead" })).toBeInTheDocument();
    expect(screen.getByText("New Owner")).toBeInTheDocument();

    await user.click(screen.getByLabelText("New Owner"));
    expect(screen.queryByRole("option", { name: "Agent A" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Agent B" })).toBeInTheDocument();
  });

  it("submits a reassignment with a reason, calling reassignLead with the exact args", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId="agent-a" currentOwnerName="Agent A" agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));

    await user.click(screen.getByLabelText("New Owner"));
    await user.click(await screen.findByText("Agent B"));
    await user.type(screen.getByLabelText(/reason/i), "Load balancing");
    await user.click(screen.getByRole("button", { name: "Reassign" }));

    await waitFor(() => expect(reassignLead).toHaveBeenCalledWith("lead-1", "agent-b", "Load balancing"));
  });
});

describe("ReassignLeadDialog — an unassigned Lead (Assign wording, Pass 10 §7/§25)", () => {
  it("titles the dialog 'Assign Lead', labels the picker 'Assign to', and the button reads 'Assign'", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("dialog", { name: "Assign Lead" })).toBeInTheDocument();
    expect(screen.getByText("Assign to")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
    expect(screen.queryByText("Reassign")).not.toBeInTheDocument();
  });

  it("shows 'Unassigned' as the current owner", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("reason is genuinely optional — submits fine with an empty reason, still via the same reassignLead() action", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));

    await user.click(screen.getByLabelText("Assign to"));
    await user.click(await screen.findByText("Agent A"));
    await user.click(screen.getByRole("button", { name: "Assign" }));

    await waitFor(() => expect(reassignLead).toHaveBeenCalledWith("lead-1", "agent-a", undefined));
  });

  it("requires a new owner before submitting", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Assign" }));

    expect(reassignLead).not.toHaveBeenCalled();
  });

  it("no agent is excluded from the picker when there is no current owner to exclude", async () => {
    const user = userEvent.setup();
    render(
      <ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByLabelText("Assign to"));

    expect(screen.getByRole("option", { name: "Agent A" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Agent B" })).toBeInTheDocument();
  });
});

// Pass 8 §4 — DOM-level accessibility verification (jsdom, no real screen
// reader — see the Pass 8 report).
describe("ReassignLeadDialog — accessibility (Pass 8 §4)", () => {
  it("has an accessible dialog name derived from its own title, for both wording states", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId="agent-a" currentOwnerName="Agent A" agents={AGENTS} trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Reassign Lead" })).toBeInTheDocument();
    unmount();

    render(<ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Assign Lead" })).toBeInTheDocument();
  });

  // Focus-return-to-trigger is Radix Dialog's own default (see the
  // matching comment in reassign-contact-dialog.test.tsx) — did not
  // reproduce under jsdom even with waitFor, so not asserted here; Escape
  // actually closing the dialog IS verified.
  it("Escape closes the dialog", async () => {
    const user = userEvent.setup();
    render(<ReassignLeadDialog leadId="lead-1" leadLabel="John Smith" currentOwnerId={null} currentOwnerName={null} agents={AGENTS} trigger={<button>Open</button>} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
