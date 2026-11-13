"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { searchLeadsForTaskLink } from "@/server/queries/tasks";
import { canViewTasks } from "@/lib/permissions";
import { runDueTaskNotifications } from "@/server/due-task-notifications";
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
    // An account an Admin has hidden is not part of the current team (see accountsVisible), so
    // it cannot be handed new work through a direct request either — the pickers already omit it.
    const assignee = await prisma.account.findFirst({ where: { id: data.assigneeId, companyId: actor.companyId, status: "ACTIVE", role: { not: "MARKETING_AGENT" }, OR: [{ accountsVisible: true }, { id: actor.id }] }, select: { id: true } });
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
    // Hidden accounts cannot be newly assigned (the task's CURRENT assignee may stay, so editing
    // other fields of an existing task never fails); the actor may always assign to themselves.
    const assignee = await prisma.account.findFirst({
      where: {
        id: data.assigneeId,
        companyId: actor!.companyId,
        status: "ACTIVE",
        role: { not: "MARKETING_AGENT" },
        OR: [{ accountsVisible: true }, { id: actor!.id }, ...(existing.assigneeId ? [{ id: existing.assigneeId }] : [])],
      },
      select: { id: true },
    });
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
  // A hidden account cannot be handed the task (it may already hold it, or be the actor).
  const newAssignee = await prisma.account.findFirst({
    where: {
      id: assigneeId,
      companyId: actor?.companyId,
      status: "ACTIVE",
      role: { not: "MARKETING_AGENT" },
      OR: [{ accountsVisible: true }, ...(actor ? [{ id: actor.id }] : []), ...(existing.assigneeId ? [{ id: existing.assigneeId }] : [])],
    },
  });
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

/**
 * The signed-in "Process Due Tasks" button. It runs the same sweep as the cron route and the poller (runDueTaskNotifications in
 * src/server/due-task-notifications.ts) but only for a signed-in account that may see the Tasks page: this is a public Server Action, so it carries
 * its own check instead of trusting the page that renders the button.
 */
export async function processDueTaskNotifications() {
  const actor = await getCurrentAccount();
  if (!actor || !canViewTasks(actor.role)) throw new Error("You are not authorized to process due tasks");
  return runDueTaskNotifications();
}
