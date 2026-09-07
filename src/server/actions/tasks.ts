"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { sendEmail } from "@/server/email/service";
import { buildTaskReminderEmail } from "@/server/email/templates";
import { searchLeadsForTaskLink } from "@/server/queries/tasks";
import { getCompanyForAccountId } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { resolveBaseUrl } from "@/lib/company-config";
import { taskVisibilityWhere, contactVisibilityWhere, leadVisibilityWhere } from "@/server/visibility";

/** Thin server-action wrapper so the client-side lead combobox can call the query. */
export async function searchLeadsForTaskLinkAction(query: string) {
  const actor = await getCurrentAccount();
  return searchLeadsForTaskLink(query, actor);
}

const TASK_NOT_FOUND = "Task not found";

/** IDOR/BOLA guard shared by every task mutation below — a restricted-role
 * actor may only act on a task whose Lead is assigned to them (or, absent a
 * Lead, whose Contact they own) — never merely because they're the manual
 * assignee (Part 18); Admin/Manager/Ticketing Agent act company-wide (see
 * taskVisibilityWhere). */
async function assertTaskAccess(actor: Awaited<ReturnType<typeof getCurrentAccount>>, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, ...taskVisibilityWhere(actor) } });
  if (!task) throw new Error(TASK_NOT_FOUND);
  return task;
}

function revalidateTaskPaths(taskId: string, path: { contactId?: string | null; leadId?: string | null }) {
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${taskId}`);
  if (path.leadId) revalidatePath(`/leads/${path.leadId}`);
  if (path.contactId) revalidatePath(`/contacts/${path.contactId}`);
  revalidatePath("/dashboard");
}

const createTaskSchema = z.object({
  contactId: z.string().optional(),
  leadId: z.string().optional(),
  title: z.string().min(1),
  notes: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueAt: z.string().optional(),
  assigneeId: z.string().optional(),
});

export async function createTask(params: z.infer<typeof createTaskSchema>) {
  const data = createTaskSchema.parse(params);
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not authenticated");

  // A task's contactId/leadId are never trusted blindly — same IDOR
  // guarding as every other cross-entity reference in this codebase. A
  // brand-new task with neither is still valid (a standalone to-do).
  if (data.contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: data.contactId, ...contactVisibilityWhere(actor) }, select: { id: true } });
    if (!contact) throw new Error("Contact not found");
  }
  if (data.leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: data.leadId, ...leadVisibilityWhere(actor) }, select: { id: true } });
    if (!lead) throw new Error("Lead not found");
  }
  if (data.assigneeId) {
    // Marketing Agent has no access to Tasks at all (canViewTasks) —
    // assigning them one would be a dead-end nobody could ever see or
    // complete, so it's rejected here the same way an outside-company or
    // inactive account is.
    const assignee = await prisma.account.findFirst({ where: { id: data.assigneeId, companyId: actor.companyId, status: "ACTIVE", role: { not: "MARKETING_AGENT" } }, select: { id: true } });
    if (!assignee) throw new Error("Assignee must be an active account in your own company that has access to Tasks");
  }

  const task = await prisma.task.create({
    data: {
      contactId: data.contactId,
      leadId: data.leadId,
      title: data.title,
      notes: data.notes,
      priority: data.priority,
      dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
      assigneeId: data.assigneeId || actor?.id,
    },
  });

  await logActivity({
    contactId: data.contactId,
    leadId: data.leadId,
    actorId: actor?.id,
    type: "TASK_CREATED",
    description: `Task created: ${data.title}`,
  });

  revalidateTaskPaths(task.id, data);
  return task;
}

const updateTaskSchema = z.object({
  taskId: z.string(),
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  dueAt: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
});

export async function updateTask(params: z.infer<typeof updateTaskSchema>) {
  const data = updateTaskSchema.parse(params);
  const actor = await getCurrentAccount();
  const existing = await assertTaskAccess(actor, data.taskId);

  // Same cross-tenant + Marketing-Agent guard as createTask's assigneeId
  // check above — previously this reassignment path had no validation at
  // all, accepting any string as the new assignee.
  if (data.assigneeId) {
    const assignee = await prisma.account.findFirst({ where: { id: data.assigneeId, companyId: actor!.companyId, status: "ACTIVE", role: { not: "MARKETING_AGENT" } }, select: { id: true } });
    if (!assignee) throw new Error("Assignee must be an active account in your own company that has access to Tasks");
  }

  const nextDueAt = data.dueAt === undefined ? undefined : data.dueAt ? new Date(data.dueAt) : null;
  const dueAtChanged = nextDueAt !== undefined && nextDueAt?.getTime() !== existing.dueAt?.getTime();

  const task = await prisma.task.update({
    where: { id: data.taskId },
    data: {
      title: data.title,
      notes: data.notes === undefined ? undefined : data.notes,
      priority: data.priority,
      dueAt: nextDueAt,
      assigneeId: data.assigneeId === undefined ? undefined : data.assigneeId,
      dueNotifiedAt: dueAtChanged ? null : undefined,
    },
  });

  await logActivity({
    contactId: existing.contactId ?? undefined,
    leadId: existing.leadId ?? undefined,
    actorId: actor?.id,
    type: "TASK_UPDATED",
    description: `Task updated: ${task.title}`,
  });

  revalidateTaskPaths(task.id, existing);
  return task;
}

export async function reassignTask(taskId: string, assigneeId: string) {
  const actor = await getCurrentAccount();
  await assertTaskAccess(actor, taskId);
  const existing = await prisma.task.findUniqueOrThrow({ where: { id: taskId }, include: { assignee: true } });
  // A task can never be reassigned to an account outside the actor's own
  // company — same cross-tenant guard as reassignLead/reassignContact.
  // Marketing Agent is excluded too: that role has no access to Tasks at
  // all (canViewTasks), so reassigning to them would be a dead-end.
  const newAssignee = await prisma.account.findFirst({ where: { id: assigneeId, companyId: actor?.companyId, status: "ACTIVE", role: { not: "MARKETING_AGENT" } } });
  if (!newAssignee) throw new Error("Assignee must be an active account in your own company that has access to Tasks");

  await prisma.task.update({ where: { id: taskId }, data: { assigneeId } });

  await logActivity({
    contactId: existing.contactId ?? undefined,
    leadId: existing.leadId ?? undefined,
    actorId: actor?.id,
    type: "TASK_REASSIGNED",
    description: `Task "${existing.title}" reassigned to ${newAssignee.fullName}`,
  });

  revalidateTaskPaths(taskId, existing);
}

/** Shared complete/reopen toggle — used by both the embedded per-lead widget and the dedicated Tasks page. */
export async function toggleTask(taskId: string, path: { contactId?: string | null; leadId?: string | null } = {}) {
  const actor = await getCurrentAccount();
  const task = await assertTaskAccess(actor, taskId);
  await prisma.task.update({
    where: { id: taskId },
    data:
      task.status === "PENDING"
        ? { status: "COMPLETED", completedAt: new Date(), completedById: actor?.id }
        // Reopening restores future reminder eligibility — clear the dedup
        // guard so the cron will notify again if the task is still due/overdue.
        : { status: "PENDING", completedAt: null, completedById: null, dueNotifiedAt: null },
  });
  revalidateTaskPaths(taskId, { contactId: path.contactId ?? task.contactId, leadId: path.leadId ?? task.leadId });
}

export async function deleteTask(taskId: string) {
  const actor = await getCurrentAccount();
  const existing = await assertTaskAccess(actor, taskId);

  await prisma.task.delete({ where: { id: taskId } });

  await logActivity({
    contactId: existing.contactId ?? undefined,
    leadId: existing.leadId ?? undefined,
    actorId: actor?.id,
    type: "TASK_DELETED",
    description: `Task deleted: ${existing.title}`,
  });

  revalidateTaskPaths(taskId, existing);
}

const DUE_SOON_WINDOW_MS = 60 * 60 * 1000; // notify once a task is within 1 hour of its due time, or overdue

/**
 * Extension point for a real scheduler (Vercel Cron, GitHub Actions schedule,
 * an external queue worker, etc.) — see /api/cron/tasks. Scans pending tasks
 * that are due soon or overdue and haven't been notified yet, creates an
 * in-app Notification for the assigned agent (the only mechanism guaranteed
 * to work), and best-effort emails them too if SMTP is configured. Never
 * notifies anyone but the task's own assignee.
 */
export async function processDueTaskNotifications() {
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
