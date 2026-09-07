import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText, PlaneTakeoff, Paperclip } from "lucide-react";
import { getLeadDetail, leadRecordExists } from "@/server/queries/leads";
import { AccessRestricted } from "@/components/crm/access-restricted";
import { listTaskEligibleAgents, listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getApplicableSequences } from "@/server/queries/sequences";
import { getCurrentAccount } from "@/lib/dev-session";
import { canReassignLeads, canDeleteLead, canViewLeads } from "@/lib/permissions";
import { DeleteButton } from "@/components/crm/delete-button";
import { deleteLead } from "@/server/actions/leads";
import { LeadSequencesPanel } from "@/components/leads/lead-sequences-panel";
import { CustomerInfoCard } from "@/components/leads/customer-info-card";
import { TravelRequestCard } from "@/components/leads/travel-request-card";
import { CrmMetaCard } from "@/components/leads/crm-meta-card";
import { LeadStatusSelect } from "@/components/leads/lead-status-select";
import { CallButton } from "@/components/crm/call-button";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { ReassignIconTrigger } from "@/components/crm/reassign-icon-trigger";
import { ReassignLeadDialog } from "@/components/leads/reassign-lead-dialog";
import { NotesPanel } from "@/components/crm/notes-panel";
import { TasksPanel } from "@/components/crm/tasks-panel";
import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { QUOTE_STATUS_META } from "@/lib/status-meta";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentAccount = await getCurrentAccount();
  if (!canViewLeads(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const [lead, agents, leadEligibleAgents, applicableSequences] = await Promise.all([
    getLeadDetail(id, viewer),
    currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
    currentAccount ? listLeadEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
    getApplicableSequences(viewer),
  ]);

  if (!lead) {
    if (await leadRecordExists(id)) return <AccessRestricted />;
    notFound();
  }

  return (
    <div className="space-y-5">
      <div>
        <Link href="/leads" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Leads
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {lead.contact.firstName} {lead.contact.lastName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {lead.departureAirport?.iata ?? "?"} → {lead.arrivalAirport?.iata ?? "?"} ·{" "}
              {lead.tripType.replace("_", " ")} · {lead.cabinClass.replace("_", " ")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LeadStatusSelect leadId={lead.id} status={lead.status} viewerRole={currentAccount?.role} />
            <CallButton phone={lead.contact.primaryPhone} size="icon" />
            <EmailComposerButton
              leadId={lead.id}
              emails={
                lead.contact.emails.length > 0
                  ? [...lead.contact.emails].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map((e) => e.email)
                  : lead.contact.primaryEmail
                    ? [lead.contact.primaryEmail]
                    : []
              }
              contactName={`${lead.contact.firstName} ${lead.contact.lastName}`}
              size="icon"
            />
            {/* Pass 10 §7/§26 — matches the Leads list row's own gate exactly
             * (and CrmMetaCard's inline "Assigned Agent" field just below,
             * which already had this fallback): claiming a currently-
             * unassigned Lead is open to any authenticated viewer who can
             * see it at all (reassignLead() itself only gates MOVING a
             * lead AWAY from an existing owner behind canReassignLeads) —
             * this dialog must not be the one place on this page that
             * mysteriously requires canReassignLeads even when there's no
             * owner to reassign FROM. */}
            {(canReassignLeads(currentAccount?.role) || !lead.assignedAgentId) && (
              <ReassignLeadDialog
                leadId={lead.id}
                leadLabel={`${lead.contact.firstName} ${lead.contact.lastName}`}
                currentOwnerId={lead.assignedAgentId}
                currentOwnerName={lead.assignedAgent?.fullName ?? null}
                agents={leadEligibleAgents}
                trigger={<ReassignIconTrigger label={lead.assignedAgentId ? "Reassign Lead" : "Assign Lead"} />}
              />
            )}
            <Button asChild className="gap-2">
              <Link href={`/quotes/new?leadId=${lead.id}`} target="_blank" rel="noopener noreferrer">
                <FileText className="h-4 w-4" /> Fare Quote
              </Link>
            </Button>
            {canDeleteLead(currentAccount?.role) && (
              <DeleteButton
                variant="full"
                confirmTitle="Delete this lead?"
                confirmMessage="Deleting this lead will also delete any quotes and bookings created under it. The customer's contact record and their other leads are not affected. This action cannot be undone."
                deleteAction={deleteLead.bind(null, lead.id)}
                redirectTo="/leads"
              />
            )}
          </div>
        </div>
        {lead.status === "ACCEPTED" && (
          <div className="mt-3 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-foreground">
            This lead was automatically assigned to <strong>{lead.assignedAgent?.fullName ?? "its owner"}</strong> because
            they already own this customer&apos;s contact record. If you believe this lead should be reassigned to you,
            please contact your manager or supervisor.
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
        <div className="min-w-0 space-y-5">
          <CustomerInfoCard
            contactId={lead.contact.id}
            firstName={lead.contact.firstName}
            lastName={lead.contact.lastName}
            phones={lead.contact.phones}
            emails={lead.contact.emails}
            leadId={lead.id}
          />
          <TravelRequestCard
            leadId={lead.id}
            departureAirport={lead.departureAirport}
            arrivalAirport={lead.arrivalAirport}
            departureDate={lead.departureDate}
            returnDate={lead.returnDate}
            tripType={lead.tripType}
            cabinClass={lead.cabinClass}
            adults={lead.adults}
            childrenCount={lead.children}
            infants={lead.infants}
            flexibleDates={lead.flexibleDates}
            preferredAirline={lead.preferredAirline}
            budget={lead.budget ? Number(lead.budget) : null}
            additionalNotes={lead.notes}
          />
          <CrmMetaCard
            leadId={lead.id}
            source={lead.source}
            priority={lead.priority}
            assignedAgentId={lead.assignedAgentId}
            agents={leadEligibleAgents}
            createdAt={lead.createdAt}
            canReassign={canReassignLeads(currentAccount?.role)}
            referredByContact={lead.referredByContact}
          />
        </div>

        <Card className="shadow-none">
          <CardContent className="pt-2">
            <Tabs defaultValue="notes">
              <div className="w-full min-w-0 overflow-x-auto">
                <TabsList>
                  <TabsTrigger value="notes">Notes</TabsTrigger>
                  <TabsTrigger value="tasks">Tasks {lead.tasks.filter((t) => t.status === "PENDING").length > 0 && `(${lead.tasks.filter((t) => t.status === "PENDING").length})`}</TabsTrigger>
                  <TabsTrigger value="quotes">Quotes {lead.quotes.length > 0 && `(${lead.quotes.length})`}</TabsTrigger>
                  <TabsTrigger value="booking">Booking</TabsTrigger>
                  <TabsTrigger value="sequences">Sequences {lead.enrollments.length > 0 && `(${lead.enrollments.length})`}</TabsTrigger>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="attachments">Files</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="notes" className="pt-4">
                <NotesPanel leadId={lead.id} contactId={undefined} notes={lead.notesRel} />
              </TabsContent>

              <TabsContent value="tasks" className="pt-4">
                <TasksPanel leadId={lead.id} tasks={lead.tasks} agents={agents} currentAgentId={currentAccount?.id} />
              </TabsContent>

              <TabsContent value="quotes" className="pt-4">
                {lead.quotes.length === 0 ? (
                  <EmptyState
                    icon={FileText}
                    title="No Quotes Yet"
                    description="Create a quote for this lead to get started."
                    action={
                      <Button asChild size="sm" className="gap-2">
                        <Link href={`/quotes/new?leadId=${lead.id}`} target="_blank" rel="noopener noreferrer"><FileText className="h-3.5 w-3.5" /> Create Quote</Link>
                      </Button>
                    }
                  />
                ) : (
                  <ul className="space-y-2">
                    {lead.quotes.map((q) => {
                      const meta = QUOTE_STATUS_META[q.status];
                      return (
                        <li key={q.id}>
                          <Link
                            href={`/quotes/${q.id}`}
                            className="flex items-center justify-between rounded-md border px-3 py-2.5 hover:bg-muted/50"
                          >
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

              <TabsContent value="booking" className="pt-4">
                {lead.bookings.length === 0 ? (
                  <EmptyState icon={PlaneTakeoff} title="No booking yet" description="Bookings appear here once a customer completes checkout on a sent quote." />
                ) : (
                  <ul className="space-y-2">
                    {lead.bookings.map((b) => (
                      <li key={b.id}>
                        <Link href={`/bookings/${b.id}`} className="flex items-center justify-between rounded-md border px-3 py-2.5 hover:bg-muted/50">
                          <div>
                            <p className="text-sm font-medium">{b.bookingReference}</p>
                            <p className="text-xs text-muted-foreground">{b.status.replace("_", " ")}</p>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="sequences" className="pt-4">
                <LeadSequencesPanel
                  leadId={lead.id}
                  enrollments={lead.enrollments}
                  availableSequences={applicableSequences}
                  contactEmails={
                    lead.contact.emails.length > 0
                      ? [...lead.contact.emails].sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map((e) => e.email)
                      : lead.contact.primaryEmail
                        ? [lead.contact.primaryEmail]
                        : []
                  }
                />
              </TabsContent>

              <TabsContent value="activity" className="pt-4">
                <ActivityTimeline activities={lead.activities} leadId={lead.id} />
              </TabsContent>

              <TabsContent value="attachments" className="pt-4">
                <EmptyState icon={Paperclip} title="No files yet" description="Passport copies, visas, and other documents can be attached here." />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
