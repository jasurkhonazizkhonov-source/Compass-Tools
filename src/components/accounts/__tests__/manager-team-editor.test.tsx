// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ManagerTeamEditor, type TeamCandidate } from "../manager-team-editor";

// Admin's control for a Manager's explicit team. The list only ever offers
// Travel Agents (the server enforces the same rule); this proves the control
// behaves, says when an agent would be moved from another team, and sends
// exactly the chosen ids.

const { setManagerTeam } = vi.hoisted(() => ({ setManagerTeam: vi.fn(async () => ({ added: 0, removed: 0, teamSize: 0 })) }));
vi.mock("@/server/actions/accounts", () => ({ setManagerTeam }));

const CANDIDATES: TeamCandidate[] = [
  { id: "ta-1", fullName: "John Agent", managerId: "mgr-1", managerName: "Andrew Manager", hidden: false, inactive: false },
  { id: "ta-2", fullName: "Sarah Agent", managerId: null, managerName: null, hidden: false, inactive: false },
  { id: "ta-3", fullName: "David Agent", managerId: "mgr-2", managerName: "Other Manager", hidden: true, inactive: false },
];

beforeEach(() => vi.clearAllMocks());

function setup() {
  return render(<ManagerTeamEditor managerId="mgr-1" managerName="Andrew Manager" candidates={CANDIDATES} initialMemberIds={["ta-1"]} />);
}

describe("ManagerTeamEditor", () => {
  it("shows the current team members", () => {
    setup();
    expect(screen.getByRole("button", { name: "Edit Andrew Manager's team" })).toHaveTextContent("John Agent");
  });

  it("shows 'No team members' for an empty team", () => {
    render(<ManagerTeamEditor managerId="mgr-1" managerName="Andrew Manager" candidates={CANDIDATES} initialMemberIds={[]} />);
    expect(screen.getByText("No team members")).toBeInTheDocument();
  });

  it("offers every Travel Agent, marks hidden ones, and warns when saving would move an agent off another manager's team", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Edit Andrew Manager's team" }));
    expect(screen.getByLabelText(/John Agent/)).toBeChecked();
    expect(screen.getByLabelText(/Sarah Agent/)).not.toBeChecked();
    expect(screen.getByText(/hidden/)).toBeInTheDocument();
    expect(screen.getByText(/On Other Manager's team — saving moves them here/)).toBeInTheDocument();
    // their own current member does not get the "moves" warning
    expect(screen.queryByText(/On Andrew Manager's team/)).not.toBeInTheDocument();
  });

  it("Save is disabled until the selection changes, then sends exactly the chosen ids", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Edit Andrew Manager's team" }));
    expect(screen.getByRole("button", { name: "Save team" })).toBeDisabled();
    await user.click(screen.getByLabelText(/Sarah Agent/));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(setManagerTeam).toHaveBeenCalledWith("mgr-1", expect.arrayContaining(["ta-1", "ta-2"]));
    expect((setManagerTeam.mock.calls[0] as unknown as [string, string[]])[1]).toHaveLength(2);
  });

  it("an agent can be removed from the team", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Edit Andrew Manager's team" }));
    await user.click(screen.getByLabelText(/John Agent/));
    await user.click(screen.getByRole("button", { name: "Save team" }));
    expect(setManagerTeam).toHaveBeenCalledWith("mgr-1", []);
  });

  it("Cancel discards unsaved ticks and calls nothing", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Edit Andrew Manager's team" }));
    await user.click(screen.getByLabelText(/Sarah Agent/));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(setManagerTeam).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Edit Andrew Manager's team" }));
    expect(screen.getByLabelText(/Sarah Agent/)).not.toBeChecked();
  });
});
