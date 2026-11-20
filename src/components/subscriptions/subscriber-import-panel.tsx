"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, Loader2, Download, Ban, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/crm/status-badge";
import {
  cancelSubscriberImport, createSubscriberImportJob, getSubscriberImportErrorReport, listSubscriberImportJobs, previewSubscriberImport, resumeSubscriberImport,
  type ImportJobRow, type ImportPreview,
} from "@/server/actions/subscriber-imports";

const MAX_BYTES = 4 * 1024 * 1024; // keep in step with IMPORT_MAX_BYTES (the server action body limit is 5 MB)
const ACTIVE = new Set(["QUEUED", "PROCESSING"]);
const TONE: Record<string, "neutral" | "info" | "warning" | "success" | "destructive"> = { QUEUED: "info", PROCESSING: "warning", COMPLETED: "success", FAILED: "destructive", CANCELLED: "neutral" };
const n = (v: number) => v.toLocaleString("en-US");

/**
 * Large subscriber imports. The list is checked and queued here; the writing happens in a background job, in chunks, so a 100,000-row file is never one request and
 * survives a restart. An import can only ADD addresses that are not already on the list: anyone who unsubscribed or was suppressed stays that way, and is counted in
 * the summary instead. The downloadable error report holds row numbers and reasons only - never an address.
 */
export function SubscriberImportPanel({ initialJobs }: { initialJobs: ImportJobRow[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ImportJobRow[]>(initialJobs);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<"PASTE" | "FILE">("PASTE");

  const reload = useCallback(async () => {
    try {
      setJobs(await listSubscriberImportJobs());
    } catch {
      /* keep what is shown */
    }
  }, []);

  const anyActive = jobs.some((j) => ACTIVE.has(j.status));
  useEffect(() => {
    if (!anyActive) return;
    const id = setInterval(() => void reload(), 4_000);
    return () => clearInterval(id);
  }, [anyActive, reload]);

  function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`That file is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB. Split it into smaller files.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ""));
      setSource("FILE");
      setPreview(null);
      setError(null);
    };
    reader.onerror = () => setError("That file could not be read.");
    reader.readAsText(file);
  }

  function runPreview() {
    setError(null);
    startTransition(async () => {
      const r = await previewSubscriberImport(text);
      if (!r.ok) {
        setPreview(null);
        setError(r.error);
        return;
      }
      setPreview(r.preview);
    });
  }

  function start() {
    setError(null);
    startTransition(async () => {
      const r = await createSubscriberImportJob(text, source);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(`Import started for ${n(r.validRows)} addresses. It continues in the background.`);
      setText("");
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      await reload();
      router.refresh();
    });
  }

  async function downloadReport(id: string) {
    const csv = await getSubscriberImportErrorReport(id);
    if (!csv) return;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card className="shadow-none" data-testid="subscriber-import-panel">
      <CardHeader><CardTitle className="text-sm font-medium">Import subscribers</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setSource("PASTE"); setPreview(null); }}
            rows={5}
            placeholder={"One per line: email, first name, last name (the names are optional)\nada@example.com,Ada,Lovelace"}
            aria-label="Subscriber list"
            disabled={pending}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="text-xs" aria-label="Choose a CSV or text file" onChange={(e) => onFile(e.target.files?.[0])} />
            <Button size="sm" variant="outline" disabled={pending || !text.trim()} onClick={runPreview} className="gap-1.5">
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Check list
            </Button>
            <Button size="sm" disabled={pending || !preview || preview.validRows === 0} onClick={start} className="gap-1.5">
              <Upload className="h-3.5 w-3.5" /> Start import
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Up to 250,000 rows and 4 MB (roughly 150,000 addresses) per import; split a bigger file and import it in parts. Addresses already on the list are left exactly as they are - nobody who unsubscribed is ever re-subscribed by an import.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        {preview && (
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" data-testid="import-preview">
            <Stat label="Rows read" value={preview.totalRows} />
            <Stat label="Will be added" value={preview.newSubscribers} />
            <Stat label="Already subscribed" value={preview.alreadySubscribed} />
            <Stat label="Unsubscribed (kept out)" value={preview.previouslyUnsubscribed} />
            <Stat label="Suppressed (kept out)" value={preview.suppressed} />
            <Stat label="Invalid" value={preview.invalidRows} />
            <Stat label="Duplicate in file" value={preview.duplicateInFile} />
            {preview.truncated && <div className="col-span-2 text-xs text-destructive sm:col-span-4">The list is longer than 250,000 rows. Split it and import it in parts.</div>}
          </dl>
        )}

        {jobs.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Import history</h3>
            <ul className="divide-y rounded-md border" data-testid="import-history">
              {jobs.map((j) => {
                const pct = j.validRows === 0 ? 100 : Math.round((j.processedRows / j.validRows) * 100);
                return (
                  <li key={j.id} className="space-y-1.5 p-3 text-sm" data-testid="import-job">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <StatusBadge label={j.status.charAt(0) + j.status.slice(1).toLowerCase()} tone={TONE[j.status] ?? "neutral"} />
                        <span className="text-xs text-muted-foreground">{new Date(j.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC</span>
                      </span>
                      <span className="flex items-center gap-1">
                        {j.hasErrorReport && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => void downloadReport(j.id)}>
                            <Download className="h-3 w-3" /> Error report
                          </Button>
                        )}
                        {ACTIVE.has(j.status) && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => void cancelSubscriberImport(j.id).then(reload)}>
                            <Ban className="h-3 w-3" /> Cancel
                          </Button>
                        )}
                        {j.status === "FAILED" && (
                          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => void resumeSubscriberImport(j.id).then(reload)}>
                            <RotateCw className="h-3 w-3" /> Resume
                          </Button>
                        )}
                      </span>
                    </div>
                    {ACTIVE.has(j.status) && (
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {n(j.totalRows)} rows · {n(j.importedRows)} added · {n(j.existingRows)} already on the list ({n(j.skippedUnsubscribedOrSuppressed)} unsubscribed or suppressed, not re-subscribed) · {n(j.invalidRows)} invalid · {n(j.duplicateInFile)} duplicates in the file
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{n(value)}</dd>
    </div>
  );
}
