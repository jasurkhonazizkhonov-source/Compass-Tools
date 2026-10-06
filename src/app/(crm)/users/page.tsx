import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { UserCog } from "lucide-react";
import { getAccountSignInDetails, getAllAccounts } from "@/server/queries/accounts";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageAccounts, ROLE_LABELS } from "@/lib/permissions";
import { OnlineIndicator } from "@/components/accounts/online-indicator";
import { AccountFullNameEditor, AccountRoleSelect, AccountStatusSwitch, AccountVisibilityToggle, AccountPhoneEditor, AccountEmailEditor, AccountHiredAtEditor, AccountLocationEditor, AccountCommissionPercentEditor, AccountTipPercentEditor, AccountPaymentPermissionsEditor, AccountBookingPermissionsEditor, RemoveUserButton } from "@/components/accounts/account-row-editor";
import { NewAccountDialog } from "@/components/accounts/new-account-dialog";
import { SignOutAllUsersButton } from "@/components/accounts/sign-out-all-users-button";
import { ManagerTeamEditor, type TeamCandidate } from "@/components/accounts/manager-team-editor";
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
  // Latest successful sign-in (time, full IP, approximate location) — Administrator-only, read through its own query.
  const signIns = await getAccountSignInDetails(current);
  const activeAdminCount = accounts.filter((a) => a.role === "ADMIN" && a.status === "ACTIVE").length;

  // Manager teams. The editor offers every Travel Agent (hidden and inactive
  // ones too — Admin manages the full roster; a hidden agent's records are
  // still in their manager's scope), and says which manager each is on now.
  const nameById = new Map(accounts.map((a) => [a.id, a.fullName]));
  const teamCandidates: TeamCandidate[] = accounts
    .filter((a) => a.role === "TRAVEL_AGENT")
    .map((a) => ({ id: a.id, fullName: a.fullName, managerId: a.managerId, managerName: a.managerId ? (nameById.get(a.managerId) ?? null) : null, hidden: !a.accountsVisible, inactive: a.status !== "ACTIVE" }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length} user{accounts.length === 1 ? "" : "s"} · Manage CRM accounts, roles, and access
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SignOutAllUsersButton />
          <NewAccountDialog />
        </div>
      </div>

      {accounts.length === 0 ? (
        <EmptyState icon={UserCog} title="No users found" />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card shadow-[8px_0_8px_-8px_rgba(0,0,0,0.25)]">Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Accounts Directory</TableHead>
                <TableHead>Payment Permissions</TableHead>
                <TableHead>Booking Security</TableHead>
                <TableHead>Hired</TableHead>
                <TableHead title="The work location an Administrator assigned to this user">Location</TableHead>
                <TableHead>Commission %</TableHead>
                <TableHead>Tip %</TableHead>
                <TableHead title="When this user last completed a successful CRM sign-in">Last Sign In</TableHead>
                <TableHead title="The IP address of the latest successful sign-in">Last Sign In IP</TableHead>
                <TableHead title="Approximate location derived from the sign-in IP — not a street address, and not the assigned Location">Last Sign In Location</TableHead>
                <TableHead>Presence</TableHead>
                <TableHead>Last Activity</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const isLastActiveAdmin = a.id === current?.id && a.role === "ADMIN" && activeAdminCount === 1;
                return (
                <TableRow key={a.id} className="group hover:bg-muted/40">
                  {/* Pinned so a row stays identifiable while the wide table scrolls sideways (19 columns). */}
                  <TableCell className="sticky left-0 z-10 bg-card font-medium text-sm group-hover:bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))] shadow-[8px_0_8px_-8px_rgba(0,0,0,0.25)]">
                    <AccountFullNameEditor accountId={a.id} fullName={a.fullName} canEdit />
                    {a.id === current?.id && <Badge variant="outline" className="ml-2 text-[10px]">You</Badge>}
                  </TableCell>
                  <TableCell><AccountRoleSelect accountId={a.id} role={a.role} canEdit isLastActiveAdmin={isLastActiveAdmin} /></TableCell>
                  <TableCell>
                    {a.role === "MANAGER" ? (
                      <ManagerTeamEditor
                        // Re-created whenever the team on the server changes (e.g. an agent moved here from
                        // another manager's row), so the editor never shows or re-saves a stale team.
                        key={`${a.id}:${teamCandidates.filter((c) => c.managerId === a.id).map((c) => c.id).sort().join(",")}`}
                        managerId={a.id}
                        managerName={a.fullName}
                        candidates={teamCandidates}
                        initialMemberIds={teamCandidates.filter((c) => c.managerId === a.id).map((c) => c.id)}
                      />
                    ) : a.role === "TRAVEL_AGENT" && a.managerId ? (
                      <span className="text-sm text-muted-foreground">Manager: {nameById.get(a.managerId) ?? "—"}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
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
                  {(() => {
                    const si = signIns.get(a.id);
                    return (
                      <>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap" data-testid="last-sign-in-at" title={si?.lastSignInAt ? si.lastSignInAt.toISOString() : undefined}>
                          {/* Shown in UTC with the zone named: the server's own time zone is not the viewer's, and an unlabelled local time would mislead. */}
                          {si?.lastSignInAt ? `${si.lastSignInAt.toISOString().slice(0, 10)} ${si.lastSignInAt.toISOString().slice(11, 16)} UTC` : "Never"}
                        </TableCell>
                        <TableCell className="text-xs font-mono whitespace-nowrap" data-testid="last-sign-in-ip" title={si?.ip ?? undefined}>
                          {si?.ip ?? <span className="text-muted-foreground font-sans">{si?.lastSignInAt ? "Not recorded" : "—"}</span>}
                        </TableCell>
                        <TableCell className="text-xs max-w-[14rem] truncate" data-testid="last-sign-in-location" title={si?.location ?? undefined}>
                          {si?.location ?? <span className="text-muted-foreground">{si?.lastSignInAt ? "Location unavailable" : "—"}</span>}
                        </TableCell>
                      </>
                    );
                  })()}
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
