import { CallButton } from "@/components/crm/call-button";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { ReassignIconTrigger } from "@/components/crm/reassign-icon-trigger";
import { ReassignLeadDialog } from "@/components/leads/reassign-lead-dialog";
import { DeleteButton } from "@/components/crm/delete-button";
import { deleteLead } from "@/server/actions/leads";
import { canDeleteLead, canOfferLeadReassign } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };

/**
 * The Call / Email / Reassign actions for one lead in the Leads list — the
 * same three controls the individual lead page offers, and the SAME
 * implementations: the shared ReassignLeadDialog (→ the one reassignLead()
 * server action, with its own authorization, validation, audit trail and
 * notifications), the same Email composer and Call link. Nothing here is a
 * second reassignment path.
 *
 * Whether Reassign is shown is decided by canOfferLeadReassign() — the very
 * function the lead page uses — so the two surfaces can never disagree. That
 * is only the UI half: reassignLead() re-checks the caller's role on the
 * server, so a hidden button is never the only protection.
 *
 * Delete follows the same pattern: shown by canDeleteLead() (Admin/Manager) —
 * the lead page's own gate — and wired to the existing deleteLead() action,
 * which re-checks the role, the viewer's row-level scope (a Manager can only
 * delete inside their own team) and writes the audit entry. Same confirmation
 * and same message as the lead page.
 *
 * `variant="labeled"` (the phone card layout) puts a visible caption under
 * each icon, because a hover tooltip does not exist on touch screens.
 */
export function LeadRowActions({
  leadId,
  customerName,
  phone,
  email,
  assignedAgentId,
  assignedAgentName,
  agents,
  viewerRole,
  variant = "icons",
}: {
  leadId: string;
  customerName: string;
  phone: string | null;
  email: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  agents: Agent[];
  viewerRole: AccountRole | undefined;
  variant?: "icons" | "labeled";
}) {
  const showReassign = canOfferLeadReassign(viewerRole, assignedAgentId);
  const showDelete = canDeleteLead(viewerRole);
  const labeled = variant === "labeled";
  const caption = (text: string) => (labeled ? <span className="text-[11px] leading-none text-muted-foreground">{text}</span> : null);
  const slot = "flex flex-col items-center gap-1";

  return (
    <div className={labeled ? "flex items-start gap-4" : "flex items-center gap-1.5 whitespace-nowrap"}>
      {phone && (
        <div className={labeled ? slot : undefined}>
          <CallButton phone={phone} size={labeled ? "icon" : "icon-sm"} />
          {caption("Call")}
        </div>
      )}
      {email && (
        <div className={labeled ? slot : undefined}>
          <EmailComposerButton leadId={leadId} emails={[email]} contactName={customerName} size={labeled ? "icon" : "icon-sm"} />
          {caption("Email")}
        </div>
      )}
      {showReassign && (
        <div className={labeled ? slot : undefined}>
          <ReassignLeadDialog
            leadId={leadId}
            leadLabel={customerName}
            currentOwnerId={assignedAgentId}
            currentOwnerName={assignedAgentName}
            agents={agents}
            trigger={<ReassignIconTrigger label={assignedAgentId ? "Reassign Lead" : "Assign Lead"} size={labeled ? "icon" : "icon-sm"} />}
          />
          {caption(assignedAgentId ? "Reassign" : "Assign")}
        </div>
      )}
      {showDelete && (
        <div className={labeled ? slot : undefined}>
          <DeleteButton
            label="Delete Lead"
            confirmTitle="Delete this lead?"
            confirmLabel="Delete lead"
            confirmMessage="Deleting this lead will also delete any quotes and bookings created under it. The customer's contact record and their other leads are not affected. This action cannot be undone."
            deleteAction={deleteLead.bind(null, leadId)}
          />
          {caption("Delete")}
        </div>
      )}
    </div>
  );
}
