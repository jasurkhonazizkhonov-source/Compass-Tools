import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/server/email/service";
import { buildTaskReminderEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { resolveBaseUrl } from "@/lib/company-config";

// The task-reminder sweep, kept OUT of the "use server" module src/server/actions/tasks.ts on purpose. Everything exported from a "use server" file is
// a public Server Action: callable by any signed-in user whose page bundle includes it, with no check of its own. This sweep has two legitimate
// callers that have no signed-in user at all (the cron route /api/cron/tasks, behind CRON_SECRET, and the in-process poller in instrumentation.ts),
// so it lives here, where it is NOT an action, and the signed-in "Process Due Tasks" button calls a role-checked wrapper (processDueTaskNotifications
// in actions/tasks.ts) instead. The code below is unchanged from where it used to live.

const DUE_SOON_WINDOW_MS = 60 * 60 * 1000; // notify once a task is within 1 hour of its due time, or overdue

/**
 * Extension point for a real scheduler (Vercel Cron, GitHub Actions schedule,
 * an external queue worker, etc.) — see /api/cron/tasks. Scans pending tasks
 * that are due soon or overdue and haven't been notified yet, creates an
 * in-app Notification for the assigned agent (the only mechanism guaranteed
 * to work), and best-effort emails them too if SMTP is configured. Never
 * notifies anyone but the task's own assignee.
 */
export async function runDueTaskNotifications() {
  const now = new Date();
  const threshold = new Date(now.getTime() + DUE_SOON_WINDOW_MS);

  const dueTasks = await prisma.task.findMany({
    where: {
      status: "PENDING",
      assigneeId: { not: null },
      dueAt: { lte: threshold },
      dueNotifiedAt: null,
    },
    include: {
      assignee: true,
      contact: true,
      lead: {
        include: {
          contact: true,
          quotes: { orderBy: { createdAt: "desc" }, take: 1, select: { quoteNumber: true, id: true } },
          bookings: { orderBy: { createdAt: "desc" }, take: 1, select: { bookingReference: true, id: true } },
        },
      },
    },
    // Capped the same way processDueSequenceSteps caps its own due-work
    // query (sequences.ts) — an unbounded backlog (cron paused for a while,
    // or many companies with overdue tasks at once) must never pull an
    // unbounded row set with these deep includes in one query. Any leftover
    // due tasks are simply picked up on the next cron invocation, exactly
    // like the sequence-step processor's own leftover due steps are.
    take: 50,
  });

  let notified = 0;
  const baseUrl = resolveBaseUrl();

  for (const task of dueTasks) {
    if (!task.assignee) continue;

    // Pass 20 — same concurrency class Pass 19 found and fixed in
    // processDueSequenceSteps: this loop previously read every due,
    // unnotified task, then only marked dueNotifiedAt AFTER creating the
    // Notification and sending the email — nothing stopped a second,
    // overlapping invocation of this same cron entry point (an ordinary
    // occurrence: two overlapping scheduled runs, or a scheduler retry
    // while the first run is still in flight) from reading and processing
    // the exact same task before either invocation's write landed,
    // producing a duplicate in-app Notification and a duplicate reminder
    // email to the same agent. Fixed with the same atomic-claim shape:
    // dueNotifiedAt itself (the exact field the "due" query already
    // filters on) is claimed FIRST via a conditional updateMany whose
    // WHERE repeats `dueNotifiedAt: null` — if a concurrent invocation
    // already claimed this row, the count is 0 and this invocation skips
    // it. Unlike the sequence lease, there's no separate "lease expiry" to
    // reason about: once genuinely notified, a task should simply STAY
    // notified — reopening a task (toggleTask) or changing its due date
    // (updateTask) already resets dueNotifiedAt to null for a fresh cycle.
    const claim = await prisma.task.updateMany({ where: { id: task.id, dueNotifiedAt: null }, data: { dueNotifiedAt: now } });
    if (claim.count === 0) continue; // another concurrent invocation already claimed this task

    const overdue = task.dueAt != null && task.dueAt.getTime() < now.getTime();
    const relatedContact = task.contact ?? task.lead?.contact ?? null;
    const relatedName = relatedContact ? `${relatedContact.firstName} ${relatedContact.lastName}` : null;

    await prisma.notification.create({
      data: {
        accountId: task.assignee.id,
        taskId: task.id,
        type: overdue ? "TASK_OVERDUE" : "TASK_DUE",
        title: task.title,
        body: relatedName ? `Related to ${relatedName}` : null,
      },
    });

    // Sent via the assignee's own connected Gmail — a self-reminder, the
    // same pattern many calendar/task tools use, since there's no other
    // CRM user "acting" here (this runs from an unauthenticated cron
    // route). Silently skipped (not logged as an error) when this agent
    // hasn't connected Gmail — an expected, common state, not a bug.
    if (task.assignee.email && (await getGmailConnectionState(task.assignee.id)) === "CONNECTED") {
      const booking = task.lead?.bookings[0];
      const quote = task.lead?.quotes[0];
      const company = await getCompanyForAccountId(task.assignee.id);
      const { subject, html } = buildTaskReminderEmail({
        agentFullName: task.assignee.fullName,
        taskTitle: task.title,
        taskNotes: task.notes,
        dueAt: task.dueAt,
        priority: task.priority,
        overdue,
        relatedName,
        taskUrl: `${baseUrl}/tasks/${task.id}`,
        leadUrl: task.leadId ? `${baseUrl}/leads/${task.leadId}` : null,
        referenceLabel: booking ? "Related Booking" : quote ? "Related Quote" : null,
        referenceValue: booking ? booking.bookingReference : quote ? quote.quoteNumber : null,
        referenceUrl: booking ? `${baseUrl}/bookings/${booking.id}` : quote ? `${baseUrl}/quotes/${quote.id}` : null,
        company,
      });
      const result = await sendEmail({ accountId: task.assignee.id, to: task.assignee.email, subject, html });
      if (!result.ok) {
        console.error(`Task reminder email failed for task ${task.id}:`, result.error);
      }
    }

    notified++; // dueNotifiedAt was already set by the atomic claim above
  }

  return { scanned: dueTasks.length, notified };
}
