import { notFound } from "next/navigation";
import { DatabaseBackup } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageDatabaseBackups } from "@/lib/permissions";
import { getDatabaseBackupStatus } from "@/server/actions/database-backup";
import { DatabaseBackupPanel } from "@/components/database-backup/database-backup-panel";

export const dynamic = "force-dynamic";

/**
 * Admin-only Database Backup. Authorization is enforced in independent layers: proxy.ts (route), here (notFound for anyone else), and every Server Action and the download route
 * re-check the role on the server. Creating a backup runs pg_dump on this server; the page never receives a connection string, a path or any data from the dump.
 */
export default async function DatabaseBackupPage() {
  const current = await getCurrentAccount();
  if (!canManageDatabaseBackups(current?.role)) notFound();
  const status = await getDatabaseBackupStatus();

  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <DatabaseBackup className="h-5 w-5 text-muted-foreground" />
          Database Backup &amp; Restore
        </h1>
        <p className="text-sm text-muted-foreground">
          Download a complete backup of the CRM&apos;s PostgreSQL database and keep it somewhere outside this server, so the CRM can be installed again and restored if the server or the database is lost. Only Admins can see this page.
        </p>
      </div>
      <DatabaseBackupPanel initial={status} />
    </div>
  );
}
