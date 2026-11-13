import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/server/email/service";
import { logActivity } from "@/server/activity-log";
import { buildSequenceEmail } from "@/server/email/templates";
import { renderSequenceTemplate, type SequenceVariableContext } from "@/lib/sequence-variables";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";

// The sequence-step sweep, kept OUT of the "use server" module src/server/actions/sequences.ts on purpose: everything exported from a "use server" file
// is a public Server Action with no check of its own. The sweep's legitimate callers are the cron route /api/cron/sequences (behind CRON_SECRET) and
// the signed-in "Process Due Steps" button, which now calls a role-checked wrapper (processDueSequenceSteps in actions/sequences.ts). The code below is
// unchanged from where it used to live.

function buildVariableContext(
  enrollment: {
    lead: {
      departureAirport: { city: string; iata: string } | null;
      arrivalAirport: { city: string; iata: string } | null;
      departureDate: Date | null;
      returnDate: Date | null;
      tripType: string;
      cabinClass: string;
      contact: { firstName: string; lastName: string; primaryPhone: string | null; primaryEmail: string | null };
      assignedAgent: { fullName: string; email: string; phone: string | null } | null;
    };
  },
  companyName: string
): SequenceVariableContext {
  const { lead } = enrollment;
  const [senderFirstName, ...rest] = (lead.assignedAgent?.fullName ?? "Your Agent").split(" ");
  return {
    contactFirstName: lead.contact.firstName,
    contactLastName: lead.contact.lastName,
    contactPhone: lead.contact.primaryPhone ?? "",
    contactEmail: lead.contact.primaryEmail ?? "",
    departureCity: lead.departureAirport?.city ?? "",
    departureAirport: lead.departureAirport?.iata ?? "",
    arrivalCity: lead.arrivalAirport?.city ?? "",
    arrivalAirport: lead.arrivalAirport?.iata ?? "",
    departureDate: lead.departureDate ? lead.departureDate.toDateString() : "",
    returnDate: lead.returnDate ? lead.returnDate.toDateString() : "",
    tripType: lead.tripType.replace("_", " "),
    cabinClass: lead.cabinClass.replace("_", " "),
    senderFirstName,
    senderLastName: rest.join(" "),
    senderPhone: lead.assignedAgent?.phone ?? "",
    senderEmail: lead.assignedAgent?.email ?? "",
    companyName,
  };
}

// Pass 19 §8/§23/§49 — concurrency audit found processDueSequenceSteps had
// NO claiming mechanism at all: it read every ACTIVE, due enrollment via a
// plain findMany, then looped through sending emails and updating rows one
// at a time, with nothing preventing a SECOND concurrent invocation (an
// overlapping cron tick, or a manual "Process Due Steps" click while a
// scheduled run is still in flight — both real, ordinary occurrences, not
// exotic edge cases) from reading and processing the exact same set of
// "due" enrollments before the first invocation's per-row updates land,
// sending the same step's email twice to the same recipient. Fixed with a
// lease-style atomic claim, the same conditional-updateMany-as-advisory-
// lock pattern this codebase already uses for sendMarketingCampaign's
// DRAFT->SENDING claim (marketing-campaigns.ts) — no schema change, no new
// enum/status value: nextSendAt (the exact field the "due" query already
// filters on) is pushed CLAIM_LEASE_MS into the future FIRST, via a
// conditional update whose WHERE clause repeats the precise nextSendAt
// value this invocation originally read. If a concurrent invocation
// already claimed (and thus changed) that same row's nextSendAt between
// the read and this claim attempt, the WHERE no longer matches, count is
// 0, and this invocation skips the row entirely rather than double-
// processing it. If a worker crashes mid-send after claiming but before
// its own final update, the lease simply expires after CLAIM_LEASE_MS and
// the row becomes "due" again for a later run — self-healing, no stuck
// enrollment, no manual intervention needed.
const CLAIM_LEASE_MS = 2 * 60_000;
/** A transient send failure (rate limit, network) is retried on the SAME step at most this many times in total, never skipping the step. */
const MAX_SEND_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3 of a step. */
const RETRY_BACKOFF_MS = [10 * 60_000, 60 * 60_000];

/**
 * Processes all sequence steps due to send right now. This is the extension
 * point a real scheduler (Vercel Cron, a queue worker, etc.) should call —
 * see /api/cron/sequences. No such scheduler is deployed in this dev
 * environment, so the Sequences UI also exposes a manual "Process Due Steps"
 * action for testing.
 */
export async function runDueSequenceSteps() {
  const due = await prisma.sequenceEnrollment.findMany({
    // An enrollment whose sequence has been switched to Inactive is left exactly as it is (still ACTIVE, same step, same nextSendAt): nothing is sent
    // while the sequence is off, and the enrollment is picked up again as soon as it is switched back on. Before this filter the Active/Inactive switch only
    // hid the sequence from the "enroll" pickers and did not stop sends that were already scheduled.
    where: { status: "ACTIVE", nextSendAt: { lte: new Date() }, sequence: { isActive: true } },
    include: {
      sequence: { include: { steps: { orderBy: { order: "asc" } } } },
      lead: {
        include: {
          contact: true,
          departureAirport: true,
          arrivalAirport: true,
          assignedAgent: true,
        },
      },
    },
    take: 50,
  });

  let sent = 0;
  let failed = 0;

  for (const enrollment of due) {
    // Atomic claim — see CLAIM_LEASE_MS's own comment above for the full
    // reasoning. Must happen before ANY side effect for this enrollment,
    // including the "no more steps -> COMPLETED" branch just below, which
    // is itself a write two concurrent invocations could otherwise race.
    const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS);
    const claim = await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollment.id, status: "ACTIVE", nextSendAt: enrollment.nextSendAt },
      data: { nextSendAt: leaseUntil },
    });
    if (claim.count === 0) continue; // another concurrent invocation already claimed this row

    const step = enrollment.sequence.steps[enrollment.currentStepIdx];
    if (!step) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "COMPLETED", completedAt: new Date(), nextSendAt: null },
      });
      continue;
    }

    // Part 4 — the address(es) explicitly chosen at enroll time win when
    // set; otherwise fall back to the contact's primary email, matching
    // the pre-existing behavior for every enrollment that never had a
    // choice to make (only ever one email on file, or bulk-enrolled).
    const toEmail = enrollment.recipientEmail ?? enrollment.lead.contact.primaryEmail;

    // Pass 29 — these two conditions (no email on file, no assigned agent)
    // are not transient: nothing about the passage of time fixes either
    // one on its own, only a human editing the Contact/Lead. Previously
    // this only logged a per-step FAILED SequenceStepLog and `continue`d —
    // the claim above had already pushed nextSendAt CLAIM_LEASE_MS into
    // the future, but nothing advanced currentStepIdx or set a terminal
    // enrollment status, so the SAME enrollment became "due" again ~2
    // minutes later, forever, silently generating a fresh duplicate
    // SequenceStepLog + EmailLog row every cycle with zero visibility to
    // any human that it was permanently stuck. Now transitions the
    // ENROLLMENT itself to the pre-existing (previously unused)
    // EnrollmentStatus.FAILED — the exact same shape the "no more steps"
    // branch below already uses for COMPLETED — so it stops being "due"
    // and shows up as a real, visible terminal state in the CRM instead of
    // retrying invisibly forever. Once the underlying data is fixed (an
    // email added to the contact, an agent assigned to the lead), staff
    // can simply re-run "Apply Sequence" for that lead — enrollLeads's own
    // dedup check only excludes an existing ACTIVE enrollment, so a FAILED
    // one never blocks a fresh attempt.
    if (!toEmail) {
      await prisma.sequenceStepLog.create({
        data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Contact has no email address" },
      });
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "FAILED", nextSendAt: null },
      });
      failed++;
      continue;
    }

    const agent = enrollment.lead.assignedAgent;
    if (!agent) {
      await prisma.sequenceStepLog.create({
        data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Lead has no assigned agent to send from" },
      });
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "FAILED", nextSendAt: null },
      });
      failed++;
      continue;
    }

    const company = await getCompanyForAccountId(agent.id);
    const context = buildVariableContext(enrollment, company.name);
    const renderedSubject = renderSequenceTemplate(step.subject, context);
    const renderedBody = renderSequenceTemplate(step.body, context);
    const { subject, html } = buildSequenceEmail({
      subject: renderedSubject,
      bodyText: renderedBody,
      agent: { fullName: agent.fullName, email: agent.email, phone: agent.phone },
      company,
      // Pass 16 §4/§5 — only the automated drip send carries an unsubscribe
      // link; the token is this enrollment's own opaque id (see
      // /api/public/sequence-unsubscribe's own doc comment for why no new
      // schema field was needed).
      unsubscribeUrl: `${resolveBaseUrl()}/api/public/sequence-unsubscribe?enrollment=${enrollment.id}`,
    });
    // Last line of defence, atomic with respect to unenrollLead: the claim above was taken a few statements ago and rendering took time,
    // so confirm RIGHT NOW that the enrollment is still ACTIVE. This conditional update touches nothing but the lease it already holds;
    // if an unenroll (or anything else that ended the enrollment) committed first, no row matches and nothing is sent.
    const stillEligible = await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollment.id, status: "ACTIVE" },
      data: { nextSendAt: leaseUntil },
    });
    if (stillEligible.count === 0) continue;

    const result = await sendEmail({
      accountId: agent.id,
      to: toEmail,
      subject,
      html,
      senderName: agent.fullName,
      replyTo: agent.email,
    });

    await prisma.sequenceStepLog.create({
      data: {
        enrollmentId: enrollment.id,
        stepId: step.id,
        status: result.ok ? "SENT" : "FAILED",
        sentAt: result.ok ? new Date() : undefined,
        error: result.ok ? undefined : result.error,
      },
    });
    await prisma.emailLog.create({
      data: {
        type: "SEQUENCE",
        subject,
        fromEmail: agent.email,
        toEmail,
        status: result.ok ? "SENT" : "FAILED",
        errorMessage: result.ok ? undefined : result.error,
        messageId: result.ok ? result.messageId : undefined,
        leadId: enrollment.leadId,
        contactId: enrollment.lead.contactId,
      },
    });

    if (result.ok) {
      sent++;
      const nextIdx = enrollment.currentStepIdx + 1;
      const nextStep = enrollment.sequence.steps[nextIdx];
      // Conditional on ACTIVE: if the enrollment was unenrolled while this email was in flight, the email that already went out stays in
      // the history but the enrollment is not resurrected or overwritten (previously an unconditional update could turn an unenrolled
      // enrollment into COMPLETED).
      await prisma.sequenceEnrollment.updateMany({
        where: { id: enrollment.id, status: "ACTIVE" },
        data: nextStep
          ? { currentStepIdx: nextIdx, nextSendAt: new Date(Date.now() + nextStep.delayMinutes * 60_000) }
          : { status: "COMPLETED", completedAt: new Date(), nextSendAt: null, currentStepIdx: nextIdx },
      });
      continue;
    }

    failed++;
    // A failed send must NEVER advance the step: previously the step counter moved on and the enrollment stayed ACTIVE, so the CRM showed
    // "Step 2 of 5 - Next: ..." for a sequence whose first email never went out, and the picker then refused a re-enrollment.
    //  - NOT_CONNECTED / REAUTH_REQUIRED: no amount of waiting fixes these; only a person reconnecting Gmail does. The enrollment becomes
    //    FAILED (visible, not due, no further attempts, currentStepIdx untouched so the history shows which step failed), and a new
    //    enrollment can be created once Gmail is connected.
    //  - SEND_FAILED (rate limit, network, Gmail outage): retried on the SAME step with backoff, at most MAX_SEND_ATTEMPTS in total; the
    //    attempt number is the count of this step's FAILED logs, so it survives a worker restart. After the last attempt it becomes FAILED.
    const permanent = result.code === "NOT_CONNECTED" || result.code === "REAUTH_REQUIRED";
    const attempts = permanent ? MAX_SEND_ATTEMPTS : await prisma.sequenceStepLog.count({ where: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED" } });
    if (permanent || attempts >= MAX_SEND_ATTEMPTS) {
      const ended = await prisma.sequenceEnrollment.updateMany({
        where: { id: enrollment.id, status: "ACTIVE" },
        data: { status: "FAILED", nextSendAt: null },
      });
      if (ended.count > 0) {
        await logActivity({
          leadId: enrollment.leadId,
          type: "SEQUENCE_FAILED",
          description: `Sequence "${enrollment.sequence.name}" stopped at step ${enrollment.currentStepIdx + 1}: ${result.error}`,
        });
      }
    } else {
      await prisma.sequenceEnrollment.updateMany({
        where: { id: enrollment.id, status: "ACTIVE" },
        data: { nextSendAt: new Date(Date.now() + (RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1])) },
      });
    }
  }

  revalidatePath("/sequences");
  return { processed: due.length, sent, failed };
}
