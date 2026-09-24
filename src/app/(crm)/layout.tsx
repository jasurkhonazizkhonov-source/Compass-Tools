import { Suspense } from "react";
import { SidebarShell } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { PresenceHeartbeat } from "@/components/layout/presence-heartbeat";
import { GmailConnectToast } from "@/components/layout/gmail-connect-toast";
import { toSidebarAccount } from "@/lib/account-format";
import { getCurrentAccount } from "@/lib/dev-session";
import { getMyQueueStatus } from "@/server/queries/lead-queue";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { getCompanyForAccountId, getCompanyById } from "@/server/queries/company";
import { safeErrorTag, describeDatabaseTarget } from "@/lib/safe-error-log";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const current = await getCurrentAccount();
  // Real diagnosability gap found and fixed: this Promise.all runs on
  // EVERY single CRM page (this layout wraps all of them) and, until now,
  // had no logging of its own — a failure here (the exact class of
  // "This page couldn't load" report this app has seen repeatedly)
  // relied entirely on Next.js's own generic, unlabeled server logging to
  // be diagnosable at all. This still NEVER hides or swallows the
  // failure — the page genuinely cannot render without this data, so the
  // error is re-thrown immediately after logging, reaching the same
  // src/app/error.tsx boundary as before. The only change is that a real
  // recurrence now leaves a clear, greppable `[crm-layout]` log line
  // (matching the safeErrorTag convention already used by proxy.ts and
  // google-auth.ts — class name only, never the error message, which can
  // embed connection detail) instead of depending solely on Next's own
  // digest-only logging.
  let queueStatus: Awaited<ReturnType<typeof getMyQueueStatus>>;
  let gmailStatus: Awaited<ReturnType<typeof getGmailConnectionState>>;
  let company: Awaited<ReturnType<typeof getCompanyForAccountId>>;
  try {
    [queueStatus, gmailStatus, company] = await Promise.all([
      getMyQueueStatus(current?.id, current?.companyId),
      getGmailConnectionState(current?.id),
      // Real, measured performance defect found and fixed: this used to
      // call getCompanyForAccountId(current?.id), which spends an EXTRA
      // database round trip re-reading the account row purely to learn its
      // companyId — a value `current` (just awaited above) already carries.
      // At roughly 600ms per round trip against the live production
      // database (see the measurement note in src/lib/dev-session.ts), that
      // was a wholly avoidable ~600ms on every single CRM page load, since
      // this layout renders for every CRM route. Falls back to the
      // account-less path only when there genuinely is no session, which is
      // exactly what getCompanyForAccountId(undefined) already returned.
      current ? getCompanyById(current.companyId) : getCompanyForAccountId(undefined),
    ]);
  } catch (err) {
    console.error(`[crm-layout] SHARED_LAYOUT_DATA_FAILED (${safeErrorTag(err)}) db=${describeDatabaseTarget()}`);
    throw err;
  }
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
