import { Suspense } from "react";
import { SidebarShell } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { PresenceHeartbeat } from "@/components/layout/presence-heartbeat";
import { GmailConnectToast } from "@/components/layout/gmail-connect-toast";
import { toSidebarAccount } from "@/lib/account-format";
import { getCurrentAccount } from "@/lib/dev-session";
import { getMyQueueStatus } from "@/server/queries/lead-queue";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { getCompanyForAccountId } from "@/server/queries/company";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const current = await getCurrentAccount();
  const [queueStatus, gmailStatus, company] = await Promise.all([
    getMyQueueStatus(current?.id, current?.companyId),
    getGmailConnectionState(current?.id),
    getCompanyForAccountId(current?.id),
  ]);
  // Never forward the raw Account row into a Client Component — it may
  // carry a Prisma Decimal (commissionPercent), which React Server
  // Components cannot serialize across the boundary. See
  // toSidebarAccount's own doc comment for the full explanation.
  const navAccount = current ? toSidebarAccount(current) : null;

  return (
    <div className="min-h-screen bg-muted/30">
      <PresenceHeartbeat accountId={current?.id} />
      <Suspense fallback={null}>
        <GmailConnectToast />
      </Suspense>
      <SidebarShell current={navAccount} companyName={company.name}>
        <div className="flex min-h-screen flex-col">
          <Topbar current={navAccount} queueStatus={queueStatus} gmailStatus={gmailStatus} companyName={company.name} />
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </SidebarShell>
    </div>
  );
}
