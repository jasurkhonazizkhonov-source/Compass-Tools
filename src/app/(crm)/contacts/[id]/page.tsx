import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, Users, FileText, PlaneTakeoff, Paperclip } from "lucide-react";
import { getContactDetail, contactRecordExists } from "@/server/queries/contacts";
import { AccessRestricted } from "@/components/crm/access-restricted";
import { listTaskEligibleAgents, listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canReassignLeads, canRevealPaymentMethod, canManageContactPaymentMethods, canAuthorizeSupplierPayment, canDeleteContact, canViewContacts } from "@/lib/permissions";
import { CustomerInfoCard } from "@/components/leads/customer-info-card";
import { ReassignContactDialog } from "@/components/contacts/reassign-contact-dialog";
import { PaymentMethodsPanel } from "@/components/contacts/payment-methods-panel";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { CallButton } from "@/components/crm/call-button";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { DeleteButton } from "@/components/crm/delete-button";
import { deleteContact } from "@/server/actions/contacts";
import { NotesPanel } from "@/components/crm/notes-panel";
import { TasksPanel } from "@/components/crm/tasks-panel";
import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { LEAD_STATUS_META, QUOTE_STATUS_META } from "@/lib/status-meta";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentAccount = await getCurrentAccount();
  if (!canViewContacts(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const [contact, agents, leadEligibleAgents] = await Promise.all([
    getContactDetail(id, viewer),
    currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
    currentAccount ? listLeadEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  if (!contact) {
    if (await contactRecordExists(id)) return <AccessRestricted />;
    notFound();
  }

  return (
    <div className="space-y-5">
      <div>
        <Link href="/contacts" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Contacts
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{contact.firstName} {contact.lastName}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Customer since {format(contact.createdAt, "MMM yyyy")} · {contact.leads.length} lead{contact.leads.length === 1 ? "" : "s"} · Owner:{" "}
              <span className={contact.owner ? "text-foreground font-medium" : ""}>{contact.owner?.fullName ?? "Unassigned"}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CallButton phone={contact.primaryPhone} size="icon" />
            <EmailComposerButton
              contactId={contact.id}
              emails={
                contact.emails.length > 0
                  ? [...contact.emails].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map((e) => e.email)
                  : contact.primaryEmail
                    ? [contact.primaryEmail]
                    : []
              }
              contactName={`${contact.firstName} ${contact.lastName}`}
              size="icon"
            />
            {canReassignLeads(currentAccount?.role) && (
              <ReassignContactDialog
                contactId={contact.id}
                contactName={`${contact.firstName} ${contact.lastName}`}
                currentOwnerId={contact.owner?.id ?? null}
                currentOwnerName={contact.owner?.fullName ?? null}
                leads={contact.leads.map((l) => ({
                  id: l.id,
                  route: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`,
                  ownerName: l.assignedAgent?.fullName ?? null,
                }))}
                agents={leadEligibleAgents}
              />
            )}
            <NewLeadDialog
              agents={leadEligibleAgents}
              presetContact={{
                id: contact.id,
                firstName: contact.firstName,
                lastName: contact.lastName,
                primaryPhone: contact.primaryPhone,
                primaryEmail: contact.primaryEmail,
              }}
              currentAccountId={currentAccount?.id}
              canAssignOthers={canReassignLeads(currentAccount?.role)}
            />
            {canDeleteContact(currentAccount?.role) && (
              <DeleteButton
                variant="full"
                confirmTitle="Delete this contact?"
                confirmMessage={`Deleting this contact will also delete all ${contact.leads.length} lead${contact.leads.length === 1 ? "" : "s"} associated with this customer, and any quotes or bookings under those leads. This action cannot be undone.`}
                deleteAction={deleteContact.bind(null, contact.id)}
                redirectTo="/contacts"
              />
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
        <CustomerInfoCard
          contactId={contact.id}
          firstName={contact.firstName}
          lastName={contact.lastName}
          phones={contact.phones}
          emails={contact.emails}
          showProfileLink={false}
        />

        <Card className="shadow-none">
          <CardContent className="pt-2">
            <Tabs defaultValue="leads">
              <div className="w-full min-w-0 overflow-x-auto">
                <TabsList>
                  <TabsTrigger value="leads">Leads {contact.leads.length > 0 && `(${contact.leads.length})`}</TabsTrigger>
                  <TabsTrigger value="quotes">Quotes {contact.quotes.length > 0 && `(${contact.quotes.length})`}</TabsTrigger>
                  <TabsTrigger value="bookings">Bookings {contact.bookings.length > 0 && `(${contact.bookings.length})`}</TabsTrigger>
                  <TabsTrigger value="payment">Payment {contact.paymentMethods.length > 0 && `(${contact.paymentMethods.length})`}</TabsTrigger>
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                  <TabsTrigger value="tasks">Tasks</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="files">Files</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="leads" className="pt-4">
                {contact.leads.length === 0 ? (
                  <EmptyState icon={Users} title="No leads yet" description="Travel requests for this customer will appear here." />
                ) : (
                  <ul className="space-y-2">
                    {contact.leads.map((l) => {
                      const meta = LEAD_STATUS_META[l.status];
                      return (
                        <li key={l.id}>
                          <Link href={`/leads/${l.id}`} className="flex items-center justify-between rounded-md border px-3 py-2.5 hover:bg-muted/50">
                            <div>
                              <p className="text-sm font-medium">
                                {l.departureAirport?.iata ?? "?"} → {l.arrivalAirport?.iata ?? "?"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {l.assignedAgent?.fullName ?? "Unassigned"} · {format(l.createdAt, "MMM d, yyyy")}
                              </p>
                            </div>
                            <StatusBadge label={meta.label} tone={meta.tone} />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="quotes" className="pt-4">
                {contact.quotes.length === 0 ? (
                  <EmptyState icon={FileText} title="No Quotes Yet" description="Quotes sent to this customer will appear here." />
                ) : (
                  <ul className="space-y-2">
                    {contact.quotes.map((q) => {
                      const meta = QUOTE_STATUS_META[q.status];
                      return (
                        <li key={q.id}>
                          <Link href={`/quotes/${q.id}`} className="flex items-center justify-between rounded-md border px-3 py-2.5 hover:bg-muted/50">
                            <div>
                              <p className="text-sm font-medium">{q.quoteNumber}</p>
                              <p className="text-xs text-muted-foreground">${Number(q.total).toLocaleString()}</p>
                            </div>
                            <StatusBadge label={meta.label} tone={meta.tone} />
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="bookings" className="pt-4">
                {contact.bookings.length === 0 ? (
                  <EmptyState icon={PlaneTakeoff} title="No bookings yet" description="Completed bookings for this customer will appear here." />
                ) : (
                  <ul className="space-y-2">
                    {contact.bookings.map((b) => (
                      <li key={b.id}>
                        <Link href={`/bookings/${b.id}`} className="flex items-center justify-between rounded-md border px-3 py-2.5 hover:bg-muted/50">
                          <p className="text-sm font-medium">{b.bookingReference}</p>
                          <p className="text-xs text-muted-foreground">{b.status.replace("_", " ")}</p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="payment" className="pt-4">
                <PaymentMethodsPanel
                  contactId={contact.id}
                  paymentMethods={contact.paymentMethods}
                  canReveal={canRevealPaymentMethod(currentAccount)}
                  canManage={canManageContactPaymentMethods(currentAccount)}
                  canAuthorizeSupplierPayment={canAuthorizeSupplierPayment(currentAccount)}
                />
              </TabsContent>

              <TabsContent value="notes" className="pt-4">
                <NotesPanel contactId={contact.id} notes={contact.notes} />
              </TabsContent>

              <TabsContent value="tasks" className="pt-4">
                <TasksPanel contactId={contact.id} tasks={contact.tasks} agents={agents} currentAgentId={currentAccount?.id} />
              </TabsContent>

              <TabsContent value="activity" className="pt-4">
                <ActivityTimeline activities={contact.activities} contactId={contact.id} />
              </TabsContent>

              <TabsContent value="files" className="pt-4">
                <EmptyState icon={Paperclip} title="No files yet" description="Passport copies, visas, and other documents can be attached here." />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
