// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Sequence -> Enroll Leads -> "Choose leads": narrow the list by status (any of the ticked ones), then tick the intended leads (or all shown) and enroll. Server
// actions are mocked; their rules are tested in server/actions/__tests__/sequences.test.ts.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const enrollLeads = vi.fn();
vi.mock("@/server/actions/sequences", () => ({ enrollLeads: (...a: unknown[]) => enrollLeads(...a) }));
vi.mock("@/server/actions/sequence-status-enroll", () => ({ previewEnrollByStatus: vi.fn(), enrollLeadsByStatus: vi.fn() }));

const { EnrollLeadsDialog } = await import("../enroll-leads-dialog");
const { LEAD_STATUS_META } = await import("@/lib/status-meta");

const MANY = [
  { id: "a", name: "Ann Able", route: "JFK - LHR", status: "BOOKED" },
  { id: "b", name: "Ben Baker", route: "SFO - CDG", status: "QUOTED" },
  { id: "c", name: "Cat Cole", route: "LAX - NRT", status: "QUOTED" },
  { id: "d", name: "Dan Dyer", route: "ORD - FRA", status: "BOOKED" },
];

async function open() {
  const user = userEvent.setup();
  render(<EnrollLeadsDialog sequenceId="seq-1" sequenceName="Welcome Series" leads={MANY} />);
  await user.click(screen.getByRole("button", { name: /Enroll Leads/ }));
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

beforeEach(() => {
  vi.clearAllMocks();
  enrollLeads.mockResolvedValue({ enrolled: 2, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {} });
});

describe("Choose leads - status filter and select-all-shown", () => {
  it("ticking statuses shows leads whose status is ANY of them (OR, never AND), and says how many are shown", async () => {
    const { user, dialog } = await open();
    expect(within(dialog).getByText(/4 shown · 0 selected/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.QUOTED.label }));
    expect(within(dialog).getByText(/2 shown/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Ann Able")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.BOOKED.label }));
    expect(within(dialog).getByText(/4 shown/)).toBeInTheDocument(); // Quoted OR Booked
    expect(within(dialog).getByText("Ann Able")).toBeInTheDocument();
  });

  it("'Select all shown' selects exactly the filtered leads, leaves hidden ones alone, and enrolls only those", async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.QUOTED.label }));
    await user.click(within(dialog).getByRole("button", { name: "Select all shown" }));
    expect(within(dialog).getByText(/2 shown · 2 selected/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Deselect all shown" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Enroll 2$/ }));
    await waitFor(() => expect(enrollLeads).toHaveBeenCalledTimes(1));
    expect((enrollLeads.mock.calls[0][1] as string[]).sort()).toEqual(["b", "c"]);
  });

  it("selecting across filters accumulates; deselecting the shown ones removes only those", async () => {
    const { user, dialog } = await open();
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.QUOTED.label }));
    await user.click(within(dialog).getByRole("button", { name: "Select all shown" }));
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.QUOTED.label })); // remove the filter
    await user.click(within(dialog).getByText("Ann Able"));
    expect(within(dialog).getByText(/4 shown · 3 selected/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: LEAD_STATUS_META.QUOTED.label }));
    await user.click(within(dialog).getByRole("button", { name: "Deselect all shown" }));
    expect(within(dialog).getByText(/2 shown · 1 selected/)).toBeInTheDocument(); // only Ann (hidden by the filter) is still selected
  });
});
