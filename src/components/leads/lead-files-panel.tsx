"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { format } from "date-fns";
import { Download, ExternalLink, FileSpreadsheet, FileText, Image as ImageIcon, Loader2, Paperclip, Pencil, Trash2, Upload } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/crm/empty-state";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  ACCEPT_ATTRIBUTE,
  ALLOWED_EXTENSIONS_LABEL,
  MAX_DESCRIPTION_LENGTH,
  allowedTypeForMime,
  formatFileSize,
  validateFile,
} from "@/lib/attachments/policy";
import {
  abandonLeadAttachmentUpload,
  completeLeadAttachmentUpload,
  deleteLeadAttachment,
  requestLeadAttachmentUpload,
  updateLeadAttachmentDescription,
} from "@/server/actions/lead-attachments";

export type LeadFileRow = {
  id: string;
  fileName: string;
  description: string | null;
  fileType: string | null;
  fileSize: number | null;
  createdAt: string; // ISO
  uploadedByName: string | null;
  /** Contact view only: the Lead this document was uploaded to. */
  lead?: { id: string; label: string };
};

function FileTypeIcon({ mime }: { mime: string | null }) {
  if (mime?.startsWith("image/")) return <ImageIcon className="size-4" />;
  if (mime?.includes("sheet") || mime?.includes("excel") || mime === "text/csv") return <FileSpreadsheet className="size-4" />;
  return <FileText className="size-4" />;
}

/** One document row — shared by the Lead tab and the Contact summary so both look and behave the same. */
export function FileRowItem({ file, canManage, onEdit, onDelete }: { file: LeadFileRow; canManage?: boolean; onEdit?: () => void; onDelete?: () => void }) {
  const type = allowedTypeForMime(file.fileType);
  const href = `/api/attachments/${file.id}/file`;
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden>
          <FileTypeIcon mime={file.fileType} />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium" title={file.fileName}>{file.fileName}</p>
          {file.description && <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{file.description}</p>}
          {file.lead && (
            <p className="text-xs text-muted-foreground">
              Lead: <a href={`/leads/${file.lead.id}`} className="font-medium text-foreground underline underline-offset-2">{file.lead.label}</a>
            </p>
          )}
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{type?.label ?? "File"}</span>
            {file.fileSize != null && <span>{formatFileSize(file.fileSize)}</span>}
            <span>Uploaded by {file.uploadedByName ?? "Unknown"}</span>
            <span>{format(new Date(file.createdAt), "MMM d, yyyy")}</span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {type?.inline && (
          <a href={href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label={`Open ${file.fileName}`}>
            <ExternalLink className="size-3.5" aria-hidden /> Open
          </a>
        )}
        <a href={`${href}?download=1`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))} aria-label={`Download ${file.fileName}`}>
          <Download className="size-3.5" aria-hidden /> Download
        </a>
        {canManage && (
          <span className="flex items-center gap-1">
          {onEdit && (
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit description of ${file.fileName}`} title="Edit description">
              <Pencil className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${file.fileName}`} title="Delete file" className="text-muted-foreground hover:text-destructive">
              <Trash2 className="size-3.5" />
            </Button>
          )}
          </span>
        )}
      </div>
    </li>
  );
}

type Phase = "idle" | "preparing" | "uploading" | "verifying";

function putWithProgress(url: string, file: File, headers: Record<string, string>, onProgress: (pct: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("upload failed")));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

export function LeadFilesPanel({
  leadId,
  files,
  total,
  canManage,
  storageReady,
  maxSizeMb,
}: {
  leadId: string;
  files: LeadFileRow[];
  total: number;
  canManage: boolean;
  storageReady: boolean;
  maxSizeMb: number;
}) {
  const router = useRouter();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busy = phase !== "idle";

  const [editing, setEditing] = useState<LeadFileRow | null>(null);
  const [editText, setEditText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [deleting, setDeleting] = useState<LeadFileRow | null>(null);

  function resetUpload() {
    setFile(null);
    setDescription("");
    setPhase("idle");
    setProgress(0);
    setError(null);
  }

  function pick(next: File | null) {
    setError(null);
    setFile(next);
    if (next) {
      const checked = validateFile({ fileName: next.name, contentType: next.type, size: next.size }, maxSizeMb * 1024 * 1024);
      if (!checked.ok) setError(checked.error);
    }
  }

  async function upload() {
    if (!file || busy) return;
    const checked = validateFile({ fileName: file.name, contentType: file.type, size: file.size }, maxSizeMb * 1024 * 1024);
    if (!checked.ok) return setError(checked.error);
    setError(null);
    setPhase("preparing");
    const controller = new AbortController();
    abortRef.current = controller;
    let pendingId: string | null = null;
    try {
      const req = await requestLeadAttachmentUpload({ leadId, fileName: file.name, contentType: file.type, size: file.size, description });
      if (!req.ok) throw new Error(req.error);
      pendingId = req.attachmentId;
      setPhase("uploading");
      await putWithProgress(req.uploadUrl, file, req.headers, setProgress, controller.signal);
      setPhase("verifying");
      const done = await completeLeadAttachmentUpload(req.attachmentId);
      if (!done.ok) throw new Error(done.error);
      toast.success("File uploaded");
      resetUpload();
      setUploadOpen(false);
      router.refresh();
    } catch (err) {
      if (pendingId) void abandonLeadAttachmentUpload(pendingId);
      const cancelled = err instanceof DOMException && err.name === "AbortError";
      setPhase("idle");
      setProgress(0);
      if (!cancelled) setError(err instanceof Error && err.message !== "upload failed" ? err.message : "The upload didn't go through. Check your connection and try again.");
    } finally {
      abortRef.current = null;
    }
  }

  async function saveDescription() {
    if (!editing) return;
    setEditBusy(true);
    setEditError(null);
    const res = await updateLeadAttachmentDescription(editing.id, editText);
    setEditBusy(false);
    if (!res.ok) return setEditError(res.error);
    toast.success("Description updated");
    setEditing(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {`${total} file${total === 1 ? "" : "s"}`}
          <span className="hidden sm:inline"> · {ALLOWED_EXTENSIONS_LABEL} · up to {maxSizeMb} MB each</span>
        </p>
        <Button size="sm" onClick={() => setUploadOpen(true)} disabled={!storageReady} title={storageReady ? undefined : "File storage is not configured yet"}>
          <Upload className="size-3.5" aria-hidden /> Upload Document
        </Button>
      </div>
      {!storageReady && <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" role="status">File uploads are not set up yet. An administrator needs to configure file storage.</p>}

      {files.length === 0 ? (
        <EmptyState icon={Paperclip} title="No files yet" description="Passport copies, visas, and other documents can be attached here." />
      ) : (
        <ul className="max-h-[32rem] space-y-2 overflow-y-auto pr-1" aria-label="Lead files">
          {files.map((f) => (
            <FileRowItem key={f.id} file={f} canManage={canManage} onEdit={() => { setEditing(f); setEditText(f.description ?? ""); setEditError(null); }} onDelete={() => setDeleting(f)} />
          ))}
        </ul>
      )}
      {total > files.length && <p className="text-xs text-muted-foreground">Showing the {files.length} most recent files of {total}.</p>}

      <Dialog open={uploadOpen} onOpenChange={(o) => { if (busy) return; setUploadOpen(o); if (!o) resetUpload(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>{ALLOWED_EXTENSIONS_LABEL}. Up to {maxSizeMb} MB.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="lead-file-input" className="text-xs">File</Label>
              <input
                id="lead-file-input"
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                disabled={busy}
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
                className="block w-full min-w-0 cursor-pointer rounded-lg border border-input bg-transparent text-sm file:mr-3 file:cursor-pointer file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50"
              />
              {file && (
                <p className="break-all text-xs text-muted-foreground">
                  {file.name} · {formatFileSize(file.size)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lead-file-description" className="text-xs">Description (optional)</Label>
              <Textarea
                id="lead-file-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={MAX_DESCRIPTION_LENGTH}
                rows={3}
                disabled={busy}
                placeholder="e.g. Passport copy for the customer…"
              />
            </div>
            {busy && (
              <div role="status" aria-live="polite" className="space-y-1.5">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {phase === "preparing" ? "Preparing…" : phase === "uploading" ? `Uploading… ${progress}%` : "Checking the file…"}
                </p>
                {phase === "uploading" && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                  </div>
                )}
              </div>
            )}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </div>
          <DialogFooter>
            {phase === "uploading" ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>Cancel upload</Button>
            ) : (
              <Button variant="outline" onClick={() => { setUploadOpen(false); resetUpload(); }} disabled={busy}>Cancel</Button>
            )}
            <Button onClick={upload} disabled={!file || busy || !!error}>
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Upload className="size-3.5" aria-hidden />} Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(o) => { if (!o && !editBusy) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit description</DialogTitle>
            <DialogDescription className="break-all">{editing?.fileName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="lead-file-edit-description" className="text-xs">Description</Label>
            <Textarea id="lead-file-edit-description" value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={MAX_DESCRIPTION_LENGTH} rows={4} disabled={editBusy} />
            <p className="text-xs text-muted-foreground">Only the description changes; the file itself is untouched.</p>
            {editError && <p className="text-sm text-destructive" role="alert">{editError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={editBusy}>Cancel</Button>
            <Button onClick={saveDescription} disabled={editBusy}>{editBusy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this file?"
        description={<span className="break-all">“{deleting?.fileName}” will be permanently deleted from this lead. This can&apos;t be undone.</span>}
        confirmLabel="Delete file"
        onConfirm={async () => {
          if (!deleting) return;
          const res = await deleteLeadAttachment(deleting.id);
          if (!res.ok) return { error: res.error };
          toast.success("File deleted");
          setDeleting(null);
          router.refresh();
        }}
      />
    </div>
  );
}
