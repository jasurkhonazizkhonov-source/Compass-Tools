import { CallButton } from "@/components/crm/call-button";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { ReassignIconTrigger } from "@/components/crm/reassign-icon-trigger";
import { ReassignContactDialog } from "@/components/contacts/reassign-contact-dialog";
import { DeleteButton } from "@/components/crm/delete-button";
import { deleteContact } from "@/server/actions/contacts";
import { canDeleteContact, canReassignLeads } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };

/**
 * The Call / Email / Reassign / Delete actions for one contact in the
 * Contacts list. Each is the existing control, not a new implementation:
 * the Email composer and Call link the contact page uses, the shared
 * ReassignContactDialog (→ reassignContact(), which checks canReassignLeads
 * and, for a Manager, that the contact is inside their own team), and the
 * shared DeleteButton (→ deleteContact(), which re-checks canDeleteContact,
 * the viewer's row-level scope and writes the audit entry).
 *
 * Whether Reassign and Delete are SHOWN follows the same permission
 * functions the server actions enforce (canReassignLeads / canDeleteContact —
 * Admin and Manager), but hiding is only the UI half: every action checks
 * again on the server. `variant="labeled"` (phone cards) puts a caption under
 * each icon because touch screens have no tooltips.
 */
export function ContactRowActions({
  contactId,
  contactName,
  phone,
  email,
  ownerId,
  ownerName,
  leads,
  agents,
  viewerRole,
  variant = "icons",
}: {
  contactId: string;
  contactName: string;
  phone: string | null;
  email: string | null;
  ownerId: string | null;
  ownerName: string | null;
  leads: Array<{ id: string; route: string; ownerName: string | null }>;
  agents: Agent[];
  viewerRole: AccountRole | undefined;
  variant?: "icons" | "labeled";
}) {
  const labeled = variant === "labeled";
  const showReassign = canReassignLeads(viewerRole);
  const showDelete = canDeleteContact(viewerRole);
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
          <EmailComposerButton contactId={contactId} emails={[email]} contactName={contactName} size={labeled ? "icon" : "icon-sm"} />
          {caption("Email")}
        </div>
      )}
      {showReassign && (
        <div className={labeled ? slot : undefined}>
          <ReassignContactDialog
            contactId={contactId}
            contactName={contactName}
            currentOwnerId={ownerId}
            currentOwnerName={ownerName}
            leads={leads}
            agents={agents}
            trigger={<ReassignIconTrigger label={ownerId ? "Reassign Contact" : "Assign Contact"} size={labeled ? "icon" : "icon-sm"} />}
          />
          {caption(ownerId ? "Reassign" : "Assign")}
        </div>
      )}
      {showDelete && (
        <div className={labeled ? slot : undefined}>
          <DeleteButton
            label="Delete Contact"
            confirmTitle="Delete this contact?"
            confirmLabel="Delete contact"
            confirmMessage="Deleting this contact will also delete all of their leads, quotes, bookings, payment methods and activity history. This action cannot be undone."
            deleteAction={deleteContact.bind(null, contactId)}
          />
          {caption("Delete")}
        </div>
      )}
    </div>
  );
}
