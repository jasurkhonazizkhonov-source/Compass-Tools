"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Send, Eye, Save, Trash2, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/subscriptions/rich-text-editor";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import {
  createMarketingCampaign,
  updateMarketingCampaign,
  deleteMarketingCampaign,
  sendMarketingCampaign,
  sendTestMarketingCampaign,
} from "@/server/actions/marketing-campaigns";

export function CampaignForm({
  campaignId,
  campaignName,
  initialName = "",
  initialSubject = "",
  initialHtml = "",
  recipientCount,
  excludedCount = 0,
  readOnly = false,
  canDelete = false,
  /** Pass 16 §7 — when the campaign is mid-send (batched/resumable: large
   * campaigns no longer complete in one request), this is the count of
   * subscribers still needing an attempt. Presence of this prop (as
   * opposed to just checking readOnly) is what shows the "Continue
   * Sending" affordance instead of treating the campaign as fully done. */
  remaining,
}: {
  campaignId?: string;
  /** Only needed once there's a real campaign to delete (name shown in the
   * delete-confirmation dialog) — unused for a brand-new, unsaved draft. */
  campaignName?: string;
  initialName?: string;
  initialSubject?: string;
  initialHtml?: string;
  recipientCount: number;
  /** Currently-unsubscribed subscriber count — shown in the send
   * confirmation so it's obvious they're being excluded (Part 18), never
   * used to gate anything (the server independently re-queries who's
   * actually eligible at send time regardless of what this component
   * displays). */
  excludedCount?: number;
  readOnly?: boolean;
  canDelete?: boolean;
  remaining?: number;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [subject, setSubject] = useState(initialSubject);
  const [html, setHtml] = useState(initialHtml);
  const [preview, setPreview] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">("desktop");
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function save() {
    if (!name.trim() || !subject.trim() || !html.trim()) {
      toast.error("Name, subject, and content are all required");
      return;
    }
    startTransition(async () => {
      try {
        if (campaignId) {
          await updateMarketingCampaign(campaignId, { name, subject, htmlContent: html });
          toast.success("Campaign saved");
        } else {
          const result = await createMarketingCampaign({ name, subject, htmlContent: html });
          toast.success("Campaign created");
          router.push(`/subscriptions/campaigns/${result.campaignId}`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save campaign");
      }
    });
  }

  function sendTest() {
    if (!campaignId) {
      toast.error("Save the campaign first");
      return;
    }
    startTransition(async () => {
      try {
        await sendTestMarketingCampaign(campaignId);
        toast.success("Test email sent to your own address");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send test");
      }
    });
  }

  function send() {
    if (!campaignId) return;
    startTransition(async () => {
      try {
        const result = await sendMarketingCampaign(campaignId);
        // Pass 16 §7 — a large campaign now completes across multiple
        // batches; be honest in the toast about whether this call finished
        // the whole campaign or just the next batch, so "Sent to 100
        // subscribers" is never mistaken for "campaign fully sent" when
        // more recipients remain.
        const base = `Sent to ${result.sent} subscriber${result.sent === 1 ? "" : "s"}${result.failed ? ` (${result.failed} failed)` : ""}${result.skipped ? ` · ${result.skipped} unsubscribed excluded` : ""}`;
        toast.success(result.done ? base : `${base}. ${result.remaining} more remaining — click Continue Sending to reach them.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send campaign");
      }
    });
  }

  function remove() {
    if (!campaignId) return;
    startTransition(async () => {
      try {
        await deleteMarketingCampaign(campaignId);
        toast.success("Campaign deleted");
        router.push("/subscriptions");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete campaign");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Campaign Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer Fare Sale" disabled={readOnly} />
        </div>
        <div className="space-y-1.5">
          <Label>Subject Line *</Label>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Fares from $299 — book by Friday" disabled={readOnly} />
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Label>Content *</Label>
          <div className="flex items-center gap-1">
            {preview && (
              <div className="flex items-center gap-0.5 rounded-md border p-0.5 mr-1">
                <Button type="button" variant={previewWidth === "desktop" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setPreviewWidth("desktop")} aria-label="Preview at desktop width" title="Desktop preview">
                  <Monitor className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant={previewWidth === "mobile" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setPreviewWidth("mobile")} aria-label="Preview at mobile width" title="Mobile preview">
                  <Smartphone className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" className="gap-1.5 h-7" onClick={() => setPreview((p) => !p)}>
              <Eye className="h-3.5 w-3.5" /> {preview ? "Edit" : "Preview"}
            </Button>
          </div>
        </div>
        {/* Rendering this campaign's own HTML directly is safe here: it was
            authored by this same Admin/Marketing Agent via the TipTap
            editor above (a trusted CRM user), never submitted by an
            anonymous/public visitor — the same trust boundary as any other
            admin-authored content in this app. */}
        {preview ? (
          <div className={previewWidth === "mobile" ? "flex justify-center bg-muted/30 rounded-md p-3" : ""}>
            <div className={previewWidth === "mobile" ? "w-[375px] max-w-full" : "w-full"}>
              <div className="rounded-md border p-4 prose prose-sm max-w-none min-h-[240px] bg-background" dangerouslySetInnerHTML={{ __html: html || "<p class='text-muted-foreground'>Nothing to preview yet.</p>" }} />
              <p className="text-[11px] text-muted-foreground mt-2 px-1">
                Every marketing email also includes an unsubscribe link in the footer below your content — not shown here since it&apos;s added automatically when the campaign is sent.
              </p>
            </div>
          </div>
        ) : readOnly ? (
          <div className="rounded-md border p-4 prose prose-sm max-w-none min-h-[240px]" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <RichTextEditor value={html} onChange={setHtml} />
        )}
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
        <p className="text-xs text-muted-foreground">
          {readOnly
            ? typeof remaining === "number" && remaining > 0
              ? `Sent to ${recipientCount} subscriber${recipientCount === 1 ? "" : "s"} so far — ${remaining} still to go`
              : `Sent to ${recipientCount} subscriber${recipientCount === 1 ? "" : "s"}`
            : `Will send to ${recipientCount} current subscriber${recipientCount === 1 ? "" : "s"}${excludedCount > 0 ? ` (${excludedCount} unsubscribed excluded)` : ""}`}
        </p>
        <div className="flex items-center gap-2">
          {canDelete && campaignId && (
            <Button type="button" variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setDeleteConfirmOpen(true)} disabled={isPending}>
              <Trash2 className="h-3.5 w-3.5" /> Delete Campaign
            </Button>
          )}
          {!readOnly && (
            <>
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={save} disabled={isPending}>
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save Draft
              </Button>
              {campaignId && (
                <>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={sendTest} disabled={isPending}>
                    <Send className="h-3.5 w-3.5" /> Send Test
                  </Button>
                  <Button type="button" size="sm" className="gap-1.5" onClick={() => setSendConfirmOpen(true)} disabled={isPending || recipientCount === 0}>
                    <Send className="h-3.5 w-3.5" /> Send to {recipientCount} Subscriber{recipientCount === 1 ? "" : "s"}
                  </Button>
                </>
              )}
            </>
          )}
          {/* Pass 16 §7 — a campaign mid-send (large enough to need more
              than one batch) is `readOnly` (content is locked, correctly)
              but is NOT finished — this button re-invokes the exact same
              send action to process the next batch, distinct from the
              DRAFT "Send to N Subscribers" button above (that one claims
              DRAFT -> SENDING; this one continues an already-SENDING
              campaign). No confirmation dialog — continuing a send you
              already confirmed once needs no second confirmation. */}
          {readOnly && campaignId && typeof remaining === "number" && remaining > 0 && (
            <Button type="button" size="sm" className="gap-1.5" onClick={send} disabled={isPending}>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Continue Sending ({remaining} remaining)
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={sendConfirmOpen}
        onOpenChange={setSendConfirmOpen}
        title="Send this campaign?"
        description={`Campaign: ${name || "Untitled"}. Recipients: ${recipientCount} active subscriber${recipientCount === 1 ? "" : "s"}.${excludedCount > 0 ? ` Excluded: ${excludedCount} unsubscribed subscriber${excludedCount === 1 ? "" : "s"} (never sent to).` : ""} This can't be undone.`}
        confirmLabel={`Send to ${recipientCount} Subscriber${recipientCount === 1 ? "" : "s"}`}
        onConfirm={send}
      />

      {canDelete && campaignId && (
        <ConfirmDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          title={`Delete "${campaignName || name || "this campaign"}"?`}
          description="This removes the draft campaign permanently. Subscribers and every other campaign are unaffected. Only draft campaigns can be deleted — a campaign that's already been sent is kept as a permanent record."
          confirmLabel="Delete Campaign"
          onConfirm={remove}
        />
      )}
    </div>
  );
}
