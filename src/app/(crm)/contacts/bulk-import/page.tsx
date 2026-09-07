import { notFound } from "next/navigation";
import { getCurrentAccount } from "@/lib/dev-session";
import { canBulkImportContacts } from "@/lib/permissions";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { BulkContactImport } from "@/components/contacts/bulk-contact-import";

export const dynamic = "force-dynamic";

/** Admin/Manager-only — see proxy.ts's matching route guard and every
 * bulk-contacts server action's own assertBulkImportAccess() for the other
 * two enforcement layers (this page-level notFound() is defense-in-depth
 * against a request that somehow reaches here without going through the
 * proxy, same three-layer pattern as /users). */
export default async function BulkContactImportPage() {
  const currentAccount = await getCurrentAccount();
  if (!canBulkImportContacts(currentAccount?.role)) notFound();

  const agents = await listLeadEligibleAgents(currentAccount!.companyId);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bulk Contacts</h1>
        <p className="text-sm text-muted-foreground">Create many contacts at once — enter rows manually or paste directly from a spreadsheet.</p>
      </div>

      <BulkContactImport agents={agents} />
    </div>
  );
}
