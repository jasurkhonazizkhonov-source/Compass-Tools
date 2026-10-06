import { Paperclip } from "lucide-react";
import { EmptyState } from "@/components/crm/empty-state";
import { FileRowItem, type LeadFileRow } from "@/components/leads/lead-files-panel";

/**
 * Contact "Files" tab: a read-only summary of the documents uploaded to this Contact's Leads — each row names the Lead it belongs to.
 * The rows come from listContactLeadAttachments, which already applies Lead visibility, so a Lead the viewer can't open contributes
 * nothing here. Documents are managed (edited / deleted) from their Lead, not from this summary.
 */
export function ContactDocumentsPanel({ files, total }: { files: LeadFileRow[]; total: number }) {
  if (files.length === 0) {
    return <EmptyState icon={Paperclip} title="No files yet" description="Documents uploaded to this contact's leads appear here." />;
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{total} file{total === 1 ? "" : "s"} across this contact&apos;s leads</p>
      <ul className="max-h-[32rem] space-y-2 overflow-y-auto pr-1" aria-label="Contact documents">
        {files.map((f) => (
          <FileRowItem key={f.id} file={f} />
        ))}
      </ul>
      {total > files.length && <p className="text-xs text-muted-foreground">Showing the {files.length} most recent files of {total}.</p>}
    </div>
  );
}
