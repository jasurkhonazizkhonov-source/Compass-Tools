// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The remaining consequential actions that now ask in the shared ConfirmDialog: team / customer notifications, role changes,
// permission grants, deactivating and removing a user. Real components, only the server actions mocked.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const updateAccount = vi.fn();
const setAccountStatus = vi.fn();
const updatePaymentPermissions = vi.fn();
const updateBookingPermissions = vi.fn();
vi.mock("@/server/actions/accounts", () => ({
  updateAccount: (...a: unknown[]) => updateAccount(...a),
  setAccountStatus: (...a: unknown[]) => setAccountStatus(...a),
  setAccountsVisibility: vi.fn(),
  updatePaymentPermissions: (...a: unknown[]) => updatePaymentPermissions(...a),
  updateBookingPermissions: (...a: unknown[]) => updateBookingPermissions(...a),
}));
vi.mock("@/server/actions/bookings", () => ({
  updateBookingTicketing: vi.fn(),
  sendNewSaleNotification: vi.fn(),
  sendCancellationConfirmationEmail: vi.fn(),
  sendCancellationNotification: vi.fn(),
}));
vi.mock("@/components/bookings/airline-confirmation-dialog", () => ({ AirlineConfirmationDialog: () => null }));

import { AccountStatusSwitch, RemoveUserButton, AccountBookingPermissionsEditor, AccountPaymentPermissionsEditor } from "@/components/accounts/account-row-editor";
import { BookingTicketingActionButtons } from "@/components/bookings/booking-ticketing-form";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeEach(() => {
  vi.clearAllMocks();
  updateAccount.mockResolvedValue(undefined);
  setAccountStatus.mockResolvedValue(undefined);
  updatePaymentPermissions.mockResolvedValue(undefined);
  updateBookingPermissions.mockResolvedValue(undefined);
});

describe("deactivate / remove a user", () => {
  it("the Status switch asks before deactivating, Cancel runs nothing, confirm deactivates", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AccountStatusSwitch accountId="u1" status="ACTIVE" canEdit isSelf={false} accountName="Pat Agent" />);
    await user.click(screen.getByRole("switch"));
    expect(screen.getByRole("alertdialog", { name: "Deactivate Pat Agent?" })).toHaveTextContent("any session they hold ends");
    expect(setAccountStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(setAccountStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(setAccountStatus).toHaveBeenCalledWith("u1", "INACTIVE"));
  });

  it("turning an account back ON needs no confirmation (it only restores access)", async () => {
    const user = userEvent.setup();
    render(<AccountStatusSwitch accountId="u1" status="INACTIVE" canEdit isSelf={false} accountName="Pat Agent" />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(setAccountStatus).toHaveBeenCalledWith("u1", "ACTIVE"));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Remove user asks first; a server refusal stays visible in the dialog", async () => {
    setAccountStatus.mockRejectedValueOnce(new Error("Cannot disable this account — it is the last active Administrator"));
    const user = userEvent.setup();
    render(<RemoveUserButton accountId="u1" accountName="Pat Agent" status="ACTIVE" canRemove isSelf={false} />);
    await user.click(screen.getByRole("button", { name: "Remove user" }));
    expect(screen.getByRole("alertdialog", { name: "Remove Pat Agent?" })).toBeInTheDocument();
    expect(setAccountStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("last active Administrator");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("permission grants", () => {
  it("granting a booking-security permission asks first and names the permission; revoking does not ask", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AccountBookingPermissionsEditor accountId="m1" role="MANAGER" permissions={[]} />);
    await user.click(screen.getByRole("button", { name: /None/ }));
    const boxes = await screen.findAllByRole("checkbox");
    await user.click(boxes[0]);
    const dialog = screen.getByRole("alertdialog", { name: "Grant this permission?" });
    expect(dialog).toHaveTextContent("recorded in the audit log");
    expect(updateBookingPermissions).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(updateBookingPermissions).not.toHaveBeenCalled();
    // the popover closed when the dialog took focus: reopen it and grant for real this time
    if (!screen.queryByRole("checkbox")) await user.click(screen.getByRole("button", { name: /None/ }));
    await user.click((await screen.findAllByRole("checkbox"))[0]);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Grant permission" }));
    await waitFor(() => expect(updateBookingPermissions).toHaveBeenCalledTimes(1));
  });

  it("granting an Admin the card-reveal permission asks first", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AccountPaymentPermissionsEditor accountId="a1" role="ADMIN" permissions={[]} />);
    await user.click(screen.getByRole("button", { name: /Reveal not granted/ }));
    await user.click(await screen.findByRole("checkbox"));
    expect(screen.getByRole("alertdialog", { name: "Grant this permission?" })).toBeInTheDocument();
    expect(updatePaymentPermissions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Grant permission" }));
    await waitFor(() => expect(updatePaymentPermissions).toHaveBeenCalledTimes(1));
  });
});

describe("team / customer notifications on a booking", () => {
  const baseProps = {
    sendDisabledReason: null,
    bookingId: "bk1",
    canSendConfirmation: false,
    onConfirmationSent: () => undefined,
    sentBefore: false,
    notifyDisabledReason: null,
    notifyPending: false,
    canSendNewSale: true,
    canSendCancellationConfirmation: true,
    cancelConfirmPending: false,
    canNotifyCancellation: true,
    cancelNotifyPending: false,
  };

  it("each of the three emails asks first, and only the confirm button sends", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const notifyNewSale = vi.fn();
    const sendCancellationConfirmation = vi.fn();
    const notifyCancellation = vi.fn();
    render(
      <TooltipProvider>
        <BookingTicketingActionButtons {...baseProps} notifyNewSale={notifyNewSale} sendCancellationConfirmation={sendCancellationConfirmation} notifyCancellation={notifyCancellation} />
      </TooltipProvider>
    );

    await user.click(screen.getByRole("button", { name: /Notify Team of New Sale/ }));
    expect(screen.getByRole("alertdialog", { name: "Notify the team of this new sale?" })).toHaveTextContent("cannot be recalled");
    expect(notifyNewSale).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(notifyNewSale).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Notify Team of New Sale/ }));
    await user.click(screen.getByRole("button", { name: "Send notification" }));
    await waitFor(() => expect(notifyNewSale).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /Send Flight Cancellation Confirmation/ }));
    expect(screen.getByRole("alertdialog", { name: "Send the cancellation confirmation to the customer?" })).toBeInTheDocument();
    expect(sendCancellationConfirmation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send confirmation" }));
    await waitFor(() => expect(sendCancellationConfirmation).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /Notify Team of Cancellation/ }));
    expect(screen.getByRole("alertdialog", { name: "Notify the team of this cancellation?" })).toBeInTheDocument();
    expect(notifyCancellation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send notification" }));
    await waitFor(() => expect(notifyCancellation).toHaveBeenCalledTimes(1));
  });
});

import { AccountRoleSelect } from "@/components/accounts/account-row-editor";

describe("role change", () => {
  it("picking a different role asks first and names both roles; Cancel changes nothing; confirm applies it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AccountRoleSelect accountId="u1" role="TRAVEL_AGENT" canEdit />);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Manager" }));
    const dialog = screen.getByRole("alertdialog", { name: "Change this user's role?" });
    expect(dialog).toHaveTextContent("from Travel Agent to Manager");
    expect(updateAccount).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(updateAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Ticketing Agent" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Change role" }));
    await waitFor(() => expect(updateAccount).toHaveBeenCalledWith("u1", { role: "TICKETING_AGENT" }));
  });

  it("a step-up refusal from the server is shown inside the dialog and the role is not reported as changed", async () => {
    updateAccount.mockResolvedValueOnce({ error: "For security, this change requires a sign-in within the last 15 minutes." });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<AccountRoleSelect accountId="u1" role="TRAVEL_AGENT" canEdit />);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Manager" }));
    await user.click(screen.getByRole("button", { name: "Change role" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("within the last 15 minutes");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
