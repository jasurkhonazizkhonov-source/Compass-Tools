"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Upload, Trash2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { uploadCompanyLogo, removeCompanyLogo } from "@/server/actions/company";
import type { LogoProcessingStatus } from "@/generated/prisma/client";

const STATUS_META: Record<LogoProcessingStatus, { label: string; variant: "default" | "outline" | "destructive" }> = {
  NONE: { label: "No logo uploaded — using the default placeholder", variant: "outline" },
  PROCESSING: { label: "Processing…", variant: "outline" },
  PROCESSED: { label: "Processed", variant: "default" },
  FAILED: { label: "Processing failed", variant: "destructive" },
};

export function CompanyLogoPanel({
  currentWebUrl,
  status,
  error,
}: {
  currentWebUrl: string;
  status: LogoProcessingStatus;
  error: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const meta = STATUS_META[status];

  const onFileChange = (file: File | null) => {
    if (!file) return;
    setPreviewUrl(URL.createObjectURL(file));

    const formData = new FormData();
    formData.set("logo", file);

    startTransition(async () => {
      const result = await uploadCompanyLogo(formData);
      if (result.ok) {
        toast.success(result.transparencyApplied ? "Logo uploaded and background removed" : "Logo uploaded");
      } else {
        toast.error(result.error);
      }
      setPreviewUrl(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    });
  };

  const onRemove = () => {
    startTransition(async () => {
      try {
        await removeCompanyLogo();
        toast.success("Logo removed — back to the default placeholder");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove logo");
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-40 items-center justify-center rounded-md border bg-muted/30 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl ?? currentWebUrl}
            alt="Company logo preview"
            className="max-h-full max-w-full object-contain"
          />
        </div>
        <div className="space-y-1.5">
          <Badge variant={meta.variant} className="gap-1">
            {status === "PROCESSED" && <CheckCircle2 className="h-3 w-3" />}
            {status === "FAILED" && <XCircle className="h-3 w-3" />}
            {isPending ? "Uploading…" : meta.label}
          </Badge>
          {error && status === "FAILED" && <p className="text-xs text-destructive max-w-sm">{error}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
        <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => fileInputRef.current?.click()}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {status === "NONE" ? "Upload logo" : "Replace logo"}
        </Button>
        {status !== "NONE" && (
          <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground max-w-md">
        PNG, JPEG, WEBP, or GIF, up to 8MB. Automatically resized for email, the booking page, and compact UI use. A
        flat background is removed automatically when it can be done safely — your logo&apos;s colors, text, and
        proportions are never altered, and the original upload is always kept as a fallback.
      </p>
    </div>
  );
}
