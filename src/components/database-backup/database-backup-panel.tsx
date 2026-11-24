"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Download, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createDatabaseBackup, deleteDatabaseBackup, type BackupStatus, type BackupView } from "@/server/actions/database-backup";

const MB = 1024 * 1024;
export const formatBackupSize = (bytes: number) => (bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toFixed(2)} GB` : bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Starts the browser's own download of a staged backup: a plain same-origin request that carries the session cookie, answered only for an Admin. */
function startDownload(id: string) {
  const a = document.createElement("a");
  a.href = `/api/admin/database-backup/${encodeURIComponent(id)}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function DatabaseBackupPanel({ initial }: { initial: BackupStatus }) {
  const router = useRouter();
  const [creating, startCreate] = useTransition();
  const [backups, setBackups] = useState<BackupView[]>(initial.backups);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const capability = initial.capability;

  function create() {
    setMessage(null);
    startCreate(async () => {
      try {
        const result = await createDatabaseBackup();
        if (!result.ok) {
          setMessage({ tone: "error", text: result.error });
          return;
        }
        setBackups((list) => [result.backup, ...list.filter((b) => b.id !== result.backup.id)]);
        setMessage({ tone: "ok", text: `Backup created and verified (${formatBackupSize(result.backup.sizeBytes)}). Your download is starting; if it does not, use the Download button below.` });
        toast.success("Database backup created");
        startDownload(result.backup.id);
        router.refresh();
      } catch {
        setMessage({ tone: "error", text: "The backup could not be created right now. Nothing was kept. Please try again." });
      }
    });
  }

  async function remove(id: string) {
    const result = await deleteDatabaseBackup(id).catch(() => ({ ok: false as const, error: "Could not remove the backup." }));
    if (result.ok) setBackups((list) => list.filter((b) => b.id !== id));
    else toast.error(result.error ?? "Could not remove the backup.");
  }

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Download Database Backup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Creates a complete, restorable PostgreSQL backup on the server, checks that it can be read back, then downloads it to this computer. It does not change or lock the live database, and
            normal CRM use continues while it runs. A large database can take several minutes.
          </p>
          {!capability.available && (
            <div role="alert" className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="backup-unavailable">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{capability.reason}</span>
            </div>
          )}
          <Button type="button" onClick={create} disabled={creating || !capability.available} className="gap-2">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {creating ? "Creating backup…" : "Download Database Backup"}
          </Button>
          {message && (
            <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-foreground"} data-testid="backup-message">
              {message.text}
            </p>
          )}
        </CardContent>
      </Card>

      {backups.length > 0 && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Backups ready to download</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3" data-testid="backup-list">
              {backups.map((b) => (
                <li key={b.id} className="space-y-1 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs">{b.fileName}</span>
                    <div className="flex items-center gap-1.5">
                      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => startDownload(b.id)}>
                        <Download className="h-3.5 w-3.5" /> Download
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => remove(b.id)} aria-label={`Delete backup ${b.fileName}`}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Created {when(b.createdAt)} · {formatBackupSize(b.sizeBytes)} · complete and verified · removed from the server {when(b.expiresAt)} or after it is downloaded
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    SHA-256 <span className="font-mono">{b.sha256}</span>
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">What this backup contains</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Format:</strong> {initial.format}. Restore it with <code>pg_restore</code> into a NEW database (steps below).
          </p>
          <p>
            <strong className="text-foreground">Included:</strong> every table in the CRM&apos;s PostgreSQL database - leads, contacts, users, companies, quotes, bookings, sequences and enrollments, activities, notes, tasks,
            campaigns and subscribers, the audit log and the migration history - with their indexes, constraints and sequences.
          </p>
          <p>
            <strong className="text-foreground">Left out on purpose:</strong> the stored security codes (<code>{initial.excludedData}</code>), which the CRM deletes after 24 hours and which must never be kept in a backup.
          </p>
          <p>
            <strong className="text-foreground">Not in this file:</strong> uploaded lead documents, the <code>.env</code> file and its encryption keys (without the card and Gmail keys, encrypted card numbers and Gmail
            connections in the backup cannot be used), TLS certificates, Cloudflare and Google settings, and PostgreSQL roles. Back those up separately.
          </p>
          <p>
            <strong className="text-foreground">Keep it safe:</strong> the file holds customer and encrypted payment data. Store it encrypted, outside this server, and delete old copies. This page cannot restore a backup;
            a restore is a deliberate, separate procedure on the server, so nothing here can overwrite the live database.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
