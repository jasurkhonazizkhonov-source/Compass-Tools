import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/server/email/service";
import { logActivity } from "@/server/activity-log";
import { buildSequenceEmail } from "@/server/email/templates";
import { renderSequenceTemplate, type SequenceVariableContext } from "@/lib/sequence-variables";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";
import { safeErrorTag } from "@/lib/safe-error-log";
import { IN_FLIGHT_PREFIX, UNCERTAIN_PREFIX, failureAttempts, openDelivery } from "@/lib/sequence-delivery";
import { assertTransition } from "@/lib/sequence-delivery-state";
import { pollerStopRequested } from "@/server/background-poller";

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
/** How many due enrollments one sweep reads and works through. drainDueSequenceSteps keeps sweeping while a sweep comes back full. */
export const DUE_BATCH_SIZE = 50;
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
function findDueEnrollments(enrollmentIds?: string[]) {
  return prisma.sequenceEnrollment.findMany({
    // An enrollment whose sequence has been switched to Inactive is left exactly as it is (still ACTIVE, same step, same nextSendAt): nothing is sent
    // while the sequence is off, and the enrollment is picked up again as soon as it is switched back on. An enrollment waiting for a person to resolve an
    // unconfirmed delivery has nextSendAt = null, so it is never selected here.
    where: {
      status: "ACTIVE",
      nextSendAt: { lte: new Date() },
      sequence: { isActive: true },
      // The approved-enrollment flow sends the FIRST step of just the enrollment(s) it created, right away, instead of waiting for the next scheduler tick.
      // Every other rule (claim lease, delivery marker, dispatch-time re-check, retry limits) is identical to a scheduled run.
      ...(enrollmentIds ? { id: { in: enrollmentIds } } : {}),
    },
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
    take: DUE_BATCH_SIZE,
  });
}

export async function runDueSequenceSteps(options: { enrollmentIds?: string[] } = {}) {
  const due = await findDueEnrollments(options.enrollmentIds);

  let sent = 0;
  let failed = 0;

  for (const enrollment of due) {
    // Shutdown requested: take on no further enrollment (the unclaimed ones stay due and are picked up by the next process).
    if (pollerStopRequested()) break;
    // One enrollment failing for an unexpected reason (a database hiccup in the middle) must never stop the others. If it happened after a send was
    // started, the in-flight marker is still there, so the next pickup treats the outcome as unknown instead of sending again.
    try {
      const outcome = await processEnrollment(enrollment);
      if (outcome === "sent") sent++;
      else if (outcome === "failed") failed++;
    } catch (err) {
      failed++;
      console.error(`[sequence-sender] processing one enrollment failed (${safeErrorTag(err)})`);
    }
  }

  try {
    revalidatePath("/sequences");
  } catch {
    // Called from the in-process poller there is no request to revalidate against; the sequence pages are dynamic, so nothing is lost.
  }
  return { processed: due.length, sent, failed };
}

// The shape of one row exactly as the query in runDueSequenceSteps returns it (derived from the real client, which applies the global omit rules).
type DueEnrollment = Awaited<ReturnType<typeof findDueEnrollments>>[number];

async function processEnrollment(enrollment: DueEnrollment): Promise<"sent" | "failed" | "skipped"> {
  // Atomic claim — see CLAIM_LEASE_MS's own comment above for the full reasoning. Must happen before ANY side effect for this enrollment, including the
  // "no more steps -> COMPLETED" branch just below, which is itself a write two concurrent invocations could otherwise race.
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS);
  const claim = await prisma.sequenceEnrollment.updateMany({
    where: { id: enrollment.id, status: "ACTIVE", nextSendAt: enrollment.nextSendAt },
    data: { nextSendAt: leaseUntil },
  });
  if (claim.count === 0) return "skipped"; // another concurrent invocation already claimed this row

  const step = enrollment.sequence.steps[enrollment.currentStepIdx];
  if (!step) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: { status: "COMPLETED", completedAt: new Date(), nextSendAt: null },
    });
    return "skipped";
  }

  // The address(es) explicitly chosen at enroll time win when set; otherwise the contact's primary email (the behaviour for every enrollment that never
  // had a choice to make).
  const toEmail = enrollment.recipientEmail ?? enrollment.lead.contact.primaryEmail;

  // Neither of these is transient: nothing about the passage of time fixes a missing email or a missing agent, only a person editing the Contact/Lead.
  // The ENROLLMENT itself becomes FAILED (visible, not due) instead of retrying invisibly forever; staff can restart it from the lead or the sequence page.
  if (!toEmail) {
    await prisma.sequenceStepLog.create({
      data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Contact has no email address" },
    });
    await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: "FAILED", nextSendAt: null } });
    return "failed";
  }

  const agent = enrollment.lead.assignedAgent;
  if (!agent) {
    await prisma.sequenceStepLog.create({
      data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Lead has no assigned agent to send from" },
    });
    await prisma.sequenceEnrollment.update({ where: { id: enrollment.id }, data: { status: "FAILED", nextSendAt: null } });
    return "failed";
  }

  // What is already known about THIS step's delivery.
  const history = await prisma.sequenceStepLog.findMany({
    where: { enrollmentId: enrollment.id, stepId: step.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, error: true, createdAt: true },
  });
  const open = openDelivery(history);
  if (open) {
    // An earlier attempt at this very step never reported its outcome (the process died, or the call never came back). It may have been delivered, so it is
    // NOT sent again automatically: the enrollment waits (nextSendAt = null, so no sweep selects it) until a person confirms what happened.
    if (open.kind === "IN_FLIGHT" && open.log.id) {
      assertTransition("SENDING", "UNKNOWN"); // an abandoned in-flight attempt becomes an unknown outcome
      await prisma.sequenceStepLog.update({
        where: { id: open.log.id },
        data: { error: `${UNCERTAIN_PREFIX} a send was started but its result was never recorded` },
      });
    }
    const held = await prisma.sequenceEnrollment.updateMany({ where: { id: enrollment.id, status: "ACTIVE", currentStepIdx: enrollment.currentStepIdx }, data: { nextSendAt: null } });
    if (held.count > 0) {
      await logActivity({
        leadId: enrollment.leadId,
        type: "SEQUENCE_DELIVERY_UNCERTAIN",
        description: `Sequence "${enrollment.sequence.name}" step ${enrollment.currentStepIdx + 1} was held: an earlier send did not report whether it was delivered. Check the sender's Gmail Sent folder, then confirm it was sent or send it again.`,
      });
    }
    return "failed";
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
    // Only the automated drip send carries an unsubscribe link; the token is this enrollment's own opaque id.
    unsubscribeUrl: `${resolveBaseUrl()}/api/public/sequence-unsubscribe?enrollment=${enrollment.id}`,
  });
  // Last line of defence, atomic with respect to unenrollLead: the claim above was taken a few statements ago and rendering took time, so confirm RIGHT NOW
  // that the enrollment is still ACTIVE. This conditional update touches nothing but the lease it already holds; if an unenroll (or anything else that
  // ended the enrollment) committed first, no row matches and nothing is sent.
  // The check also proves the lease is STILL OURS: nextSendAt must equal the value this worker wrote when it claimed. If this worker stalled for longer than
  // the lease (a slow database, a long pause) another worker may have legitimately claimed the same row in the meantime - its claim changed nextSendAt, so
  // this update matches nothing and this worker stops instead of also sending. On success the lease is renewed for the duration of the send.
  const stillEligible = await prisma.sequenceEnrollment.updateMany({
    where: { id: enrollment.id, status: "ACTIVE", nextSendAt: leaseUntil },
    data: { nextSendAt: new Date(Date.now() + CLAIM_LEASE_MS) },
  });
  if (stillEligible.count === 0) return "skipped";

  // WRITE-AHEAD: record that a send is starting BEFORE the request leaves. If anything after this point goes wrong in a way that hides the outcome, this row
  // is what stops the next run from sending the same email again (see lib/sequence-delivery.ts).
  const marker = await prisma.sequenceStepLog.create({
    data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: `${IN_FLIGHT_PREFIX} send started` },
    select: { id: true },
  });

  const result = await sendEmail({
    accountId: agent.id,
    to: toEmail,
    subject,
    html,
    senderName: agent.fullName,
    replyTo: agent.email,
  });

  if (result.ok) {
    // The send is only RECORDED as sent now, after Gmail accepted it. Until this update commits the row still says in-flight, so a crash right here is
    // caught as an unknown outcome on the next pickup rather than resent.
    assertTransition("SENDING", "SENT");
    await prisma.sequenceStepLog.update({ where: { id: marker.id }, data: { status: "SENT", sentAt: new Date(), error: null } });
    await prisma.emailLog.create({
      data: {
        type: "SEQUENCE",
        subject,
        fromEmail: agent.email,
        toEmail,
        status: "SENT",
        messageId: result.messageId,
        leadId: enrollment.leadId,
        contactId: enrollment.lead.contactId,
      },
    });
    const nextIdx = enrollment.currentStepIdx + 1;
    const nextStep = enrollment.sequence.steps[nextIdx];
    // Conditional on ACTIVE AND on the step this worker read (a stale worker - one that outlived its lease - can never overwrite what a newer worker, a person's restart or a resolve already wrote): if the enrollment was unenrolled while this email was in flight, the email that already went out stays in the history but the
    // enrollment is not resurrected or overwritten.
    await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollment.id, status: "ACTIVE", currentStepIdx: enrollment.currentStepIdx },
      data: nextStep
        ? { currentStepIdx: nextIdx, nextSendAt: new Date(Date.now() + nextStep.delayMinutes * 60_000) }
        : { status: "COMPLETED", completedAt: new Date(), nextSendAt: null, currentStepIdx: nextIdx },
    });
    return "sent";
  }

  // The request may have reached Gmail and been accepted even though no confirmation came back (timeout, dropped connection, 5xx). Do NOT retry and do NOT
  // call it failed: mark it unconfirmed and hold the enrollment for a person. (No EmailLog row: it would have to claim either "sent" or "failed".)
  if (result.ambiguous) {
    assertTransition("SENDING", "UNKNOWN");
    await prisma.sequenceStepLog.update({ where: { id: marker.id }, data: { error: `${UNCERTAIN_PREFIX} ${result.error}` } });
    const held = await prisma.sequenceEnrollment.updateMany({ where: { id: enrollment.id, status: "ACTIVE", currentStepIdx: enrollment.currentStepIdx }, data: { nextSendAt: null } });
    if (held.count > 0) {
      await logActivity({
        leadId: enrollment.leadId,
        type: "SEQUENCE_DELIVERY_UNCERTAIN",
        description: `Sequence "${enrollment.sequence.name}" step ${enrollment.currentStepIdx + 1}: Gmail did not confirm whether the email was sent. It was not resent automatically. Check the sender's Gmail Sent folder, then confirm it was sent or send it again.`,
      });
    }
    return "failed";
  }

  // A DEFINITE failure: Gmail refused, or was never asked. The marker becomes an ordinary failed attempt.
  assertTransition("SENDING", "FAILED");
  await prisma.sequenceStepLog.update({ where: { id: marker.id }, data: { error: result.error } });
  await prisma.emailLog.create({
    data: {
      type: "SEQUENCE",
      subject,
      fromEmail: agent.email,
      toEmail,
      status: "FAILED",
      errorMessage: result.error,
      leadId: enrollment.leadId,
      contactId: enrollment.lead.contactId,
    },
  });

  // A failed send must NEVER advance the step.
  //  - NOT_CONNECTED / REAUTH_REQUIRED: no amount of waiting fixes these; only a person reconnecting Gmail does. The enrollment becomes FAILED (visible, not
  //    due, no further attempts, currentStepIdx untouched so the history shows which step failed); the lead page offers a restart once Gmail is reconnected.
  //  - SEND_FAILED (rate limit, token service, Gmail refusal): retried on the SAME step with backoff, at most MAX_SEND_ATTEMPTS real failures since the last
  //    manual restart; the count comes from the step's own log rows, so it survives a worker restart. After the last attempt it becomes FAILED.
  const permanent = result.code === "NOT_CONNECTED" || result.code === "REAUTH_REQUIRED";
  const attempts = permanent ? MAX_SEND_ATTEMPTS : failureAttempts([...history, { status: "FAILED", error: result.error, createdAt: new Date() }]);
  if (permanent || attempts >= MAX_SEND_ATTEMPTS) {
    const ended = await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollment.id, status: "ACTIVE", currentStepIdx: enrollment.currentStepIdx },
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
      where: { id: enrollment.id, status: "ACTIVE", currentStepIdx: enrollment.currentStepIdx },
      data: { nextSendAt: new Date(Date.now() + (RETRY_BACKOFF_MS[attempts - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1])) },
    });
  }
  return "failed";
}

/**
 * Runs the sweep repeatedly until a sweep comes back with fewer than a full batch (or maxBatches is reached), so a backlog - a restart after downtime, a
 * large bulk enrollment - is worked off within one scheduler tick instead of 50 enrollments per minute. Rows a sweep claims have their nextSendAt pushed
 * into the future, so the next batch never re-reads them; and because every row is claimed atomically, two instances draining at once split the work
 * rather than sending anything twice.
 */
export async function drainDueSequenceSteps(maxBatches = 10) {
  const total = { processed: 0, sent: 0, failed: 0, batches: 0 };
  for (let i = 0; i < maxBatches; i++) {
    if (pollerStopRequested()) break;
    const r = await runDueSequenceSteps();
    total.batches++;
    total.processed += r.processed;
    total.sent += r.sent;
    total.failed += r.failed;
    if (r.processed < DUE_BATCH_SIZE) break;
  }
  return total;
}
