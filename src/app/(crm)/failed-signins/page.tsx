import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewFailedSignIns } from "@/lib/permissions";
import { getFailedSignInPage } from "@/server/queries/failed-signins";
import { FailedSignInsView } from "@/components/failed-signins/failed-signins-view";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * Administrator-only security log of failed sign-in attempts. Authorization is enforced in independent layers: proxy.ts (route), here (notFound for anyone else),
 * and every server action re-checks the role. Records are read page by page on the server; the browser never holds the whole history.
 */
export default async function FailedSignInsPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (!canViewFailedSignIns(current?.role)) notFound();
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = sp.pageSize ? Number(one(sp.pageSize)) : undefined;
  const filters = { q: one(sp.q), from: one(sp.from), to: one(sp.to), reason: one(sp.reason), method: one(sp.method), ip: one(sp.ip) };
  const data = await getFailedSignInPage({ companyId: current!.companyId, filters, page, pageSize });
  redirectToValidPageIfNeeded(sp, "/failed-signins", page, data.pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          Failed Sign-ins
        </h1>
        <p className="text-sm text-muted-foreground">
          Every unsuccessful sign-in attempt, one row each, newest day first. Names and emails appear only when the sign-in provider verified them. Locations are
          approximate (derived from the IP address) and can be wrong. Records are kept until an administrator deletes them. Only administrators can see this page.
        </p>
      </div>
      <FailedSignInsView data={JSON.parse(JSON.stringify(data))} filters={filters} />
      <PaginationControls page={data.page} pageCount={data.pageCount} total={data.total} pageSize={data.pageSize} />
    </div>
  );
}
