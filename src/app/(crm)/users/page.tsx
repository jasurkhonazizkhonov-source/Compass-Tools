import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { UserCog } from "lucide-react";
import { getAllAccounts } from "@/server/queries/accounts";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageAccounts, ROLE_LABELS } from "@/lib/permissions";
import { OnlineIndicator } from "@/components/accounts/online-indicator";
import { AccountFullNameEditor, AccountRoleSelect, AccountStatusSwitch, AccountVisibilityToggle, AccountPhoneEditor, AccountEmailEditor, AccountHiredAtEditor, AccountLocationEditor, AccountCommissionPercentEditor, AccountTipPercentEditor, AccountPaymentPermissionsEditor, AccountBookingPermissionsEditor, RemoveUserButton } from "@/components/accounts/account-row-editor";
import { NewAccountDialog } from "@/components/accounts/new-account-dialog";
import { EmptyState } from "@/components/crm/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

/**
 * Admin-only user management — create, edit, change role, enable/disable.
 * Distinct from the general read-only /accounts directory every CRM user
 * can see. Gated here at the page level (server-rendered 404 for a
 * non-admin, not just a hidden sidebar link) AND again in proxy.ts at the
 * route level AND again inside every server action this page calls
 * (createAccount/updateAccount/setAccountStatus each call assertAdmin()
 * independently) — hiding the nav item alone would not be sufficient.
 */
export default async function UsersPage() {
  const current = await getCurrentAccount();
  if (!canManageAccounts(current?.role)) notFound();

  const accounts = await getAllAccounts(current!.companyId);
  const activeAdminCount = accounts.filter((a) => a.role === "ADMIN" && a.status === "ACTIVE").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} user{accounts.length === 1 ? "" : "s"} · Manage CRM accounts, roles, and access
          </p>
        </div>
        <NewAccountDialog />
      </div>

      {accounts.length === 0 ? (
        <EmptyState icon={UserCog} title="No users found" />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Accounts Directory</TableHead>
                <TableHead>Payment Permissions</TableHead>
                <TableHead>Booking Security</TableHead>
                <TableHead>Hired</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Commission %</TableHead>
                <TableHead>Tip %</TableHead>
                <TableHead>Presence</TableHead>
                <TableHead>Last Activity</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const isLastActiveAdmin = a.id === current?.id && a.role === "ADMIN" && activeAdminCount === 1;
                return (
                <TableRow key={a.id} className="hover:bg-muted/40">
                  <TableCell className="font-medium text-sm">
                    <AccountFullNameEditor accountId={a.id} fullName={a.fullName} canEdit />
                    {a.id === current?.id && <Badge variant="outline" className="ml-2 text-[10px]">You</Badge>}
                  </TableCell>
                  <TableCell><AccountRoleSelect accountId={a.id} role={a.role} canEdit isLastActiveAdmin={isLastActiveAdmin} /></TableCell>
                  <TableCell><AccountPhoneEditor accountId={a.id} phone={a.phone} canEdit /></TableCell>
                  <TableCell><AccountEmailEditor accountId={a.id} email={a.email} canEdit isLastActiveAdmin={isLastActiveAdmin} /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <AccountStatusSwitch
                        accountId={a.id}
                        status={a.status}
                        canEdit
                        isSelf={a.id === current?.id}
                        accountName={a.fullName}
                      />
                      <RemoveUserButton
                        accountId={a.id}
                        accountName={a.fullName}
                        status={a.status}
                        canRemove
                        isSelf={a.id === current?.id}
                        isLastActiveAdmin={isLastActiveAdmin}
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <AccountVisibilityToggle accountId={a.id} visible={a.accountsVisible} />
                  </TableCell>
                  <TableCell>
                    <AccountPaymentPermissionsEditor accountId={a.id} role={a.role} permissions={a.paymentPermissions} />
                  </TableCell>
                  <TableCell>
                    <AccountBookingPermissionsEditor accountId={a.id} role={a.role} permissions={a.bookingPermissions} />
                  </TableCell>
                  <TableCell><AccountHiredAtEditor accountId={a.id} hiredAt={a.hiredAt} canEdit /></TableCell>
                  <TableCell><AccountLocationEditor accountId={a.id} location={a.location} canEdit /></TableCell>
                  <TableCell><AccountCommissionPercentEditor accountId={a.id} commissionPercent={a.commissionPercent != null ? Number(a.commissionPercent) : null} canEdit /></TableCell>
                  <TableCell><AccountTipPercentEditor accountId={a.id} tipPercent={a.tipPercent != null ? Number(a.tipPercent) : null} canEdit /></TableCell>
                  <TableCell><OnlineIndicator lastSeenAt={a.lastSeenAt} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lastSeenAt ? formatDistanceToNow(a.lastSeenAt, { addSuffix: true }) : "Never"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(a.createdAt, "MMM d, yyyy")}</TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Role labels: {Object.values(ROLE_LABELS).join(" · ")}. Disabling a user revokes CRM access immediately but preserves all of their historical leads, quotes, bookings, and activity — nothing is deleted. Hiding a user from the Accounts directory only affects whether their row appears on the general /accounts page — it does not change their access, ownership, history, or online status.
      </p>
    </div>
  );
}
