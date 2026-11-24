// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// Checkbox selection on the Leads / Contacts lists: per-row and current-page selection, the indeterminate header, selection that
// survives paging but not a changed result set, and the two bulk actions (Add to sequence for anyone who may enroll, Delete for
// Administrators). The server actions are mocked here; their real behaviour is proven against PostgreSQL in
// server/actions/__integration__/bulk-selection.integration.test.ts.

let currentParams = new URLSearchParams();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), useSearchParams: () => currentParams }));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), warning: vi.fn() } }));
const bulkEnroll = vi.fn();
const bulkDelete = vi.fn();
vi.mock("@/server/actions/bulk-selection", () => ({ bulkEnrollInSequence: (...a: unknown[]) => bulkEnroll(...a), bulkDeleteRecords: (...a: unknown[]) => bulkDelete(...a) }));

const { BulkActionBar, BulkRowCheckbox, BulkSelectAllCheckbox, BulkSelectionProvider } = await import("../bulk-selection");

const SEQUENCES = [
  { id: "seq-1", name: "Welcome series", description: "Three friendly emails", stepCount: 3 },
  { id: "seq-2", name: "Follow-up", description: null, stepCount: 1 },
];
const ids = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

function Harness({ pageIds, kind = "leads", canEnroll = true, canDelete = false }: { pageIds: string[]; kind?: "leads" | "contacts"; canEnroll?: boolean; canDelete?: boolean }) {
  return (
    <BulkSelectionProvider kind={kind} pageIds={pageIds}>
      <BulkActionBar canEnroll={canEnroll} canDelete={canDelete} sequences={SEQUENCES} />
      <table>
        <thead>
          <tr>
            <th>
              <BulkSelectAllCheckbox />
            </th>
            <th>Customer</th>
          </tr>
        </thead>
        <tbody>
          {pageIds.map((id) => (
            <tr key={id}>
              <td>
                <BulkRowCheckbox id={id} label={`Person ${id}`} />
              </td>
              <td>Person {id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </BulkSelectionProvider>
  );
}
const header = () => screen.getByRole("checkbox", { name: "Select all rows on this page" });
const row = (id: string) => screen.getByRole("checkbox", { name: `Select Person ${id}` });
const count = () => screen.queryByTestId("bulk-selected-count")?.textContent ?? null;

beforeEach(() => {
  currentParams = new URLSearchParams();
  refresh.mockClear();
  toastError.mockClear();
  bulkEnroll.mockReset();
  bulkDelete.mockReset();
});

describe("selection", () => {
  it("each row can be selected and deselected, and the count follows", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(5)} />);
    expect(count()).toBeNull(); // nothing selected: no bar at all
    await user.click(row("r2"));
    await user.click(row("r4"));
    expect(row("r2")).toHaveAttribute("aria-checked", "true");
    expect(count()).toBe("2 leads selected");
    await user.click(row("r2"));
    expect(row("r2")).toHaveAttribute("aria-checked", "false");
    expect(count()).toBe("1 lead selected");
    await user.click(row("r4"));
    expect(count()).toBeNull();
  });

  it("the count uses the right noun for contacts", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(3)} kind="contacts" />);
    await user.click(row("r1"));
    expect(count()).toBe("1 contact selected");
    await user.click(row("r2"));
    expect(count()).toBe("2 contacts selected");
  });

  it("the header checkbox is empty, indeterminate or checked, and a click selects then deselects exactly the rows on this page", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(4)} />);
    expect(header()).toHaveAttribute("aria-checked", "false");
    await user.click(row("r1"));
    expect(header()).toHaveAttribute("aria-checked", "mixed");
    await user.click(header()); // some selected -> select the whole page
    expect(header()).toHaveAttribute("aria-checked", "true");
    expect(count()).toBe("4 leads selected");
    await user.click(header()); // all selected -> deselect the page
    expect(header()).toHaveAttribute("aria-checked", "false");
    expect(count()).toBeNull();
  });

  it.each([25, 50, 100])("select-all covers exactly the %i rows of a page of that size", async (size) => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(size)} />);
    await user.click(header());
    expect(count()).toBe(`${size} leads selected`);
    expect(screen.getAllByTestId("bulk-row-checkbox").every((c) => c.getAttribute("aria-checked") === "true")).toBe(true);
    expect(screen.getAllByTestId("bulk-row-checkbox")).toHaveLength(size);
  });

  it("selection survives moving to another page, and select-all there never touches the first page's rows", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness pageIds={ids(25, "a")} />);
    await user.click(row("a3"));
    await user.click(row("a7"));
    currentParams = new URLSearchParams("page=2");
    rerender(<Harness pageIds={ids(25, "b")} />);
    expect(count()).toBe("2 leads selected"); // the two rows on page 1 are still counted
    await user.click(header());
    expect(count()).toBe("27 leads selected");
    await user.click(header()); // deselect page 2 only
    expect(count()).toBe("2 leads selected");
    currentParams = new URLSearchParams();
    rerender(<Harness pageIds={ids(25, "a")} />);
    expect(row("a3")).toHaveAttribute("aria-checked", "true");
    expect(row("a7")).toHaveAttribute("aria-checked", "true");
    expect(header()).toHaveAttribute("aria-checked", "mixed");
  });

  it("changing the page size keeps the selection (the records are still the same records)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness pageIds={ids(25)} />);
    await user.click(row("r5"));
    currentParams = new URLSearchParams("pageSize=50");
    rerender(<Harness pageIds={ids(50)} />);
    expect(count()).toBe("1 lead selected");
  });

  it.each([["a search", "q=smith"], ["a status filter", "status=NEW"], ["an agent filter", "agent=u1"], ["a sort", "sort=updated"]])("%s drops a selection made against the old results", async (_n, qs) => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness pageIds={ids(5)} />);
    await user.click(row("r1"));
    await user.click(row("r2"));
    expect(count()).toBe("2 leads selected");
    currentParams = new URLSearchParams(qs);
    rerender(<Harness pageIds={ids(5)} />);
    expect(count()).toBeNull();
    expect(row("r1")).toHaveAttribute("aria-checked", "false");
  });

  it("clicking through pages with the same filter does not clear anything, but a changed filter on page 3 does", async () => {
    const user = userEvent.setup();
    currentParams = new URLSearchParams("status=NEW&page=3");
    const { rerender } = render(<Harness pageIds={ids(5)} />);
    await user.click(row("r1"));
    currentParams = new URLSearchParams("status=NEW&page=4");
    rerender(<Harness pageIds={ids(5)} />);
    expect(count()).toBe("1 lead selected");
    currentParams = new URLSearchParams("status=QUOTED&page=1");
    rerender(<Harness pageIds={ids(5)} />);
    expect(count()).toBeNull();
  });

  it("cannot select more than 100 records: the 101st is refused with a message, and an over-limit select-all adds nothing", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness pageIds={ids(100, "a")} />);
    await user.click(header());
    expect(count()).toBe("100 leads selected");
    currentParams = new URLSearchParams("page=2");
    rerender(<Harness pageIds={ids(25, "b")} />);
    await user.click(row("b1")); // the 101st
    expect(count()).toBe("100 leads selected");
    await user.click(header());
    expect(count()).toBe("100 leads selected");
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it("Clear selection empties it", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(3)} />);
    await user.click(header());
    await user.click(screen.getByRole("button", { name: /Clear selection/ }));
    expect(count()).toBeNull();
  });
});

describe("which bulk actions are offered", () => {
  it.each([
    ["enroll only (a Travel Agent / Manager)", true, false],
    ["enroll and delete (an Administrator)", true, true],
    ["neither", false, false],
  ])("%s", async (_n, canEnroll, canDelete) => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(2)} canEnroll={canEnroll} canDelete={canDelete} />);
    await user.click(row("r1"));
    expect(!!screen.queryByRole("button", { name: /Add to sequence/ })).toBe(canEnroll);
    expect(!!screen.queryByRole("button", { name: /^Delete$/ })).toBe(canDelete);
    expect(screen.getByRole("button", { name: /Clear selection/ })).toBeInTheDocument();
  });
});

describe("bulk delete (Administrator)", () => {
  it("asks for confirmation naming the count and the consequences, and does nothing until confirmed", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(3)} canDelete />);
    await user.click(header());
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 3 leads?")).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/also delete any quotes and bookings/);
    expect(dialog.textContent).toMatch(/cannot be undone/);
    expect(bulkDelete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(bulkDelete).not.toHaveBeenCalled();
    expect(count()).toBe("3 leads selected");
  });

  it("for contacts the confirmation says leads, quotes and bookings go too", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(2)} kind="contacts" canDelete />);
    await user.click(row("r1"));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/delete all of their leads, quotes, bookings/);
  });

  it("sends the selected ids once, then drops the deleted ones from the selection and refreshes the list", async () => {
    const user = userEvent.setup();
    bulkDelete.mockResolvedValue({ ok: true, requested: 2, deleted: 2, deletedIds: ["r1", "r2"], failed: [] });
    render(<Harness pageIds={ids(4)} canDelete />);
    await user.click(row("r1"));
    await user.click(row("r2"));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await user.click(await screen.findByRole("button", { name: "Delete 2 leads" }));
    await waitFor(() => expect(bulkDelete).toHaveBeenCalledTimes(1));
    expect(bulkDelete).toHaveBeenCalledWith({ kind: "leads", ids: ["r1", "r2"] });
    await waitFor(() => expect(count()).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("reports records that could not be deleted and keeps exactly those selected", async () => {
    const user = userEvent.setup();
    bulkDelete.mockResolvedValue({ ok: true, requested: 2, deleted: 1, deletedIds: ["r1"], failed: [{ id: "r2", label: "Person r2", reason: "Could not be deleted" }] });
    render(<Harness pageIds={ids(3)} canDelete />);
    await user.click(row("r1"));
    await user.click(row("r2"));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await user.click(await screen.findByRole("button", { name: "Delete 2 leads" }));
    const failures = await screen.findByTestId("bulk-delete-failures");
    expect(failures.textContent).toMatch(/1 could not be deleted/);
    expect(failures.textContent).toMatch(/Person r2/);
    expect(count()).toBe("1 lead selected");
    expect(row("r2")).toHaveAttribute("aria-checked", "true");
  });

  it("a refusal from the server keeps the dialog open with its message and the selection intact", async () => {
    const user = userEvent.setup();
    bulkDelete.mockResolvedValue({ ok: false, error: "Only an Administrator can delete several records at once." });
    render(<Harness pageIds={ids(2)} canDelete />);
    await user.click(row("r1"));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await user.click(await screen.findByRole("button", { name: "Delete 1 lead" }));
    expect(await screen.findByText(/Only an Administrator can delete/)).toBeInTheDocument();
    expect(count()).toBe("1 lead selected");
  });
});

describe("bulk Add to sequence", () => {
  async function openAndChoose(user: ReturnType<typeof userEvent.setup>, pickSecond = false) {
    await user.click(screen.getByRole("button", { name: /Add to sequence/ }));
    const dialog = await screen.findByRole("dialog");
    if (pickSecond) await user.click(within(dialog).getByRole("radio", { name: /Follow-up/ }));
    await user.click(within(dialog).getByRole("button", { name: "Review" }));
    return dialog;
  }

  it("choose -> confirm (naming the sequence and the count) -> enroll with the selected ids", async () => {
    const user = userEvent.setup();
    bulkEnroll.mockResolvedValue({ ok: true, sequenceName: "Welcome series", requested: 2, enrolled: 2, alreadyEnrolled: 0, failed: [], settledIds: ["r1", "r2"], withoutEmail: 0 });
    render(<Harness pageIds={ids(3)} />);
    await user.click(row("r1"));
    await user.click(row("r2"));
    const dialog = await openAndChoose(user);
    expect(dialog.textContent).toMatch(/Enroll 2 leads\?/);
    expect(dialog.textContent).toMatch(/Welcome series/);
    expect(dialog.textContent).toMatch(/already actively enrolled in this sequence are skipped/);
    expect(bulkEnroll).not.toHaveBeenCalled(); // nothing is sent before the confirming click
    await user.click(within(dialog).getByRole("button", { name: "Enroll 2 leads" }));
    await waitFor(() => expect(bulkEnroll).toHaveBeenCalledWith({ sequenceId: "seq-1", kind: "leads", ids: ["r1", "r2"], recipientMode: "primary" }));
    expect(await screen.findByTestId("bulk-enroll-result")).toHaveTextContent("2 enrolled");
    await waitFor(() => expect(count()).toBeNull()); // everything enrolled: nothing left selected
    expect(refresh).toHaveBeenCalled();
  });

  it("lets the user pick a different sequence", async () => {
    const user = userEvent.setup();
    bulkEnroll.mockResolvedValue({ ok: true, sequenceName: "Follow-up", requested: 1, enrolled: 1, alreadyEnrolled: 0, failed: [], settledIds: ["r1"], withoutEmail: 0 });
    render(<Harness pageIds={ids(2)} />);
    await user.click(row("r1"));
    const dialog = await openAndChoose(user, true);
    await user.click(within(dialog).getByRole("button", { name: "Enroll 1 lead" }));
    await waitFor(() => expect(bulkEnroll).toHaveBeenCalledWith({ sequenceId: "seq-2", kind: "leads", ids: ["r1"], recipientMode: "primary" }));
  });

  it("contacts: the confirmation explains enrollment goes through the most recent lead", async () => {
    const user = userEvent.setup();
    render(<Harness pageIds={ids(2)} kind="contacts" />);
    await user.click(row("r1"));
    const dialog = await openAndChoose(user);
    expect(dialog.textContent).toMatch(/enrolled through their most recent lead/);
  });

  it("partial result: shows enrolled / already / failed with reasons, deselects the settled ones and keeps the failed ones selected", async () => {
    const user = userEvent.setup();
    bulkEnroll.mockResolvedValue({
      ok: true,
      sequenceName: "Welcome series",
      requested: 4,
      enrolled: 1,
      alreadyEnrolled: 1,
      failed: [
        { id: "r3", label: "Person r3", reason: "Has no lead you can access" },
        { id: "r4", label: null, reason: "No longer available to you" },
      ],
      settledIds: ["r1", "r2"],
      withoutEmail: 1,
    });
    render(<Harness pageIds={ids(4)} />);
    await user.click(header());
    const dialog = await openAndChoose(user);
    await user.click(within(dialog).getByRole("button", { name: "Enroll 4 leads" }));
    const result = await screen.findByTestId("bulk-enroll-result");
    expect(result.textContent).toMatch(/1\s*enrolled/);
    expect(result.textContent).toMatch(/1\s*already in this sequence/);
    expect(result.textContent).toMatch(/2\s*could not be enrolled/);
    const failures = screen.getByTestId("bulk-enroll-failures");
    expect(failures.textContent).toMatch(/Person r3 - Has no lead you can access/);
    expect(failures.textContent).toMatch(/A selected record - No longer available/);
    expect(dialog.textContent).toMatch(/1 enrolled has no email address/);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(count()).toBe("2 leads selected");
    expect(row("r3")).toHaveAttribute("aria-checked", "true");
    expect(row("r1")).toHaveAttribute("aria-checked", "false");
  });

  it("a refusal from the server is shown on the confirm step and nothing is deselected", async () => {
    const user = userEvent.setup();
    bulkEnroll.mockResolvedValue({ ok: false, error: "You are not authorized to enroll these records in a sequence." });
    render(<Harness pageIds={ids(2)} />);
    await user.click(row("r1"));
    const dialog = await openAndChoose(user);
    await user.click(within(dialog).getByRole("button", { name: "Enroll 1 lead" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not authorized");
    expect(count()).toBe("1 lead selected");
  });

  it("with no usable sequence the dialog says so and cannot proceed", async () => {
    const user = userEvent.setup();
    render(
      <BulkSelectionProvider kind="leads" pageIds={["r1"]}>
        <BulkActionBar canEnroll canDelete={false} sequences={[]} />
        <BulkRowCheckbox id="r1" label="Person r1" />
      </BulkSelectionProvider>
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Person r1" }));
    await user.click(screen.getByRole("button", { name: /Add to sequence/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/No active sequences with steps are available/);
    expect(within(dialog).getByRole("button", { name: "Review" })).toBeDisabled();
  });
});
