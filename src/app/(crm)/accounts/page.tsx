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

      {filtered.length === 0 ? (
        <EmptyState icon={UserCog} title="No accounts found" description="Try clearing the Online Only filter." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
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
