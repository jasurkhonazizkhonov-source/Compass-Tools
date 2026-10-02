import { format, formatDistanceToNow } from "date-fns";
import { UserCog } from "lucide-react";
import { getAccountsDirectory } from "@/server/queries/accounts";
import { getCurrentAccount } from "@/lib/dev-session";
import { ROLE_LABELS } from "@/lib/permissions";
import { OnlineIndicator, isOnline } from "@/components/accounts/online-indicator";
import { OnlineOnlyToggle } from "@/components/accounts/online-only-toggle";
import { LeadAcceptanceStatus } from "@/components/accounts/lead-acceptance-status";
import { EmptyState } from "@/components/crm/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * General worker directory — available to every authenticated CRM user,
 * read-only. Managing accounts (create, edit, role changes, enable/
 * disable) lives on the separate admin-only /users page; nothing on this
 * page mutates an Account. See src/app/(crm)/users/page.tsx.
 */
export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const onlineOnly = sp.online === "1";

  const current = await getCurrentAccount();
  // Pass 11 Part 1 — accounts hidden by an Admin (accountsVisible=false)
  // are excluded server-side by the query itself, never client-side; the
  // Online Only filter below operates on this already-filtered list.
  const accounts = current ? await getAccountsDirectory(current.companyId) : [];

  const filtered = onlineOnly ? accounts.filter((a) => isOnline(a.lastSeenAt)) : accounts;

  // Manager teams, read-only here (Admin edits them on /users). Built from the
  // directory list itself, so a hidden agent is never revealed just because
  // they are on a team.
  const nameById = new Map(accounts.map((a) => [a.id, a.fullName]));
  const teams = accounts
    .filter((a) => a.role === "MANAGER")
    .map((m) => ({ manager: m, members: accounts.filter((a) => a.role === "TRAVEL_AGENT" && a.managerId === m.id) }))
    .filter((t) => t.members.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} team member{filtered.length === 1 ? "" : "s"}
          </p>
        </div>
        <OnlineOnlyToggle />
      </div>

      {current && <LeadAcceptanceStatus companyId={current.companyId} />}

      {teams.length > 0 && (
        <section aria-label="Manager teams" className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Manager teams</h2>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {teams.map(({ manager, members }) => (
              <li key={manager.id} className="min-w-0 rounded-md border px-3 py-2">
                <p className="text-xs text-muted-foreground">Manager</p>
                <p className="break-words text-sm font-medium">{manager.fullName}</p>
                <p className="mt-2 text-xs text-muted-foreground">Team members</p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {members.map((m) => (
                    <li key={m.id}>
                      <Badge variant="outline" className="text-xs font-normal">{m.fullName}</Badge>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {filtered.length === 0 ? (
        <EmptyState icon={UserCog} title="No accounts found" description="Try clearing the Online Only filter." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Presence</TableHead>
                <TableHead>Last Activity</TableHead>
                <TableHead>Hired</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => (
                <TableRow key={a.id} className="hover:bg-muted/40">
                  <TableCell className="font-medium text-sm">
                    {a.fullName}
                    {a.id === current?.id && <Badge variant="outline" className="ml-2 text-[10px]">You</Badge>}
                  </TableCell>
                  <TableCell className="text-sm">{ROLE_LABELS[a.role]}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {a.role === "MANAGER"
                      ? (() => {
                          const n = accounts.filter((x) => x.role === "TRAVEL_AGENT" && x.managerId === a.id).length;
                          return n === 0 ? "No team members" : `${n} team member${n === 1 ? "" : "s"}`;
                        })()
                      : a.role === "TRAVEL_AGENT" && a.managerId && nameById.get(a.managerId)
                        ? `Manager: ${nameById.get(a.managerId)}`
                        : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.phone ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{a.location ?? "—"}</TableCell>
                  <TableCell><OnlineIndicator lastSeenAt={a.lastSeenAt} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.lastSeenAt ? formatDistanceToNow(a.lastSeenAt, { addSuffix: true }) : "Never"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.hiredAt ? a.hiredAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Not set"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(a.createdAt, "MMM d, yyyy")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
