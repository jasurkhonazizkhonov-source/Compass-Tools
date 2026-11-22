import { prisma } from "@/lib/prisma";
import type { Prisma, TaskStatus, Priority } from "@/generated/prisma/client";
import { taskVisibilityWhere, leadVisibilityWhere, type Viewer } from "@/server/visibility";
import { resolvePageSize } from "@/lib/pagination";
import { isEmailRestricted, withEmailPrivacy } from "@/server/privacy/customer-email";
import { contactSearchConditions, viaContact } from "@/server/search/contact-search";

export type TaskFilters = {
  q?: string;
  status?: TaskStatus;
  // Part 18 — "My Tasks / All Tasks / Specific User", honored only for a
  // company-wide viewer (see taskVisibilityWhere) — this replaces filtering
  // by literal task.assigneeId, since visibility is Lead-based, not
  // assignee-based.
  scopeUserId?: string;
  priority?: Priority;
  due?: "overdue" | "today" | "week" | "no_date";
  page?: number;
  pageSize?: number;
  sort?: "due_asc" | "due_desc" | "created_desc" | "created_asc";
};

function dueRangeFilter(due: TaskFilters["due"]): Prisma.TaskWhereInput {
  if (!due) return {};
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (due === "overdue") return { dueAt: { lt: now }, status: "PENDING" };
  if (due === "today") return { dueAt: { gte: startOfToday, lt: endOfToday } };
  if (due === "week") return { dueAt: { gte: startOfToday, lt: endOfWeek } };
  return { dueAt: null };
}

type TaskContact = { id: string; primaryEmail: string | null };
// A task carries its customer twice (task.contact and task.lead.contact); both are masked for a viewer who may not see the address.
async function maskTaskContacts<T extends { contact: TaskContact | null; lead: { contact: TaskContact } | null }>(viewer: Viewer, tasks: T[]): Promise<T[]> {
  const first = await withEmailPrivacy(viewer, tasks, (t) => t.contact, (t, email) => ({ ...t, contact: t.contact ? { ...t.contact, primaryEmail: email } : t.contact }));
  return withEmailPrivacy(viewer, first, (t) => t.lead?.contact, (t, email) => ({ ...t, lead: t.lead ? { ...t.lead, contact: { ...t.lead.contact, primaryEmail: email } } : t.lead }));
}

export async function getTasks(filters: TaskFilters, viewer: Viewer) {
  const page = Math.max(1, Math.trunc(filters.page ?? 1) || 1);
  // Pass 7 §18/§31 — 25 rows/page, hard-capped server-side.
  const pageSize = resolvePageSize(filters.pageSize); // Pass 12 §28/§30 — 25/50/75/100 allow-list

  const where: Prisma.TaskWhereInput = {
    AND: [
      taskVisibilityWhere(viewer, filters.scopeUserId),
      filters.status ? { status: filters.status } : {},
      filters.priority ? { priority: filters.priority } : {},
      dueRangeFilter(filters.due),
      filters.q
        ? {
            OR: [
              { title: { contains: filters.q, mode: "insensitive" } },
              { notes: { contains: filters.q, mode: "insensitive" } },
              { contact: { firstName: { contains: filters.q, mode: "insensitive" } } },
              { contact: { lastName: { contains: filters.q, mode: "insensitive" } } },
              { lead: { contact: { firstName: { contains: filters.q, mode: "insensitive" } } } },
              { lead: { contact: { lastName: { contains: filters.q, mode: "insensitive" } } } },
            ],
          }
        : {},
    ],
  };

  const primarySort: Prisma.TaskOrderByWithRelationInput =
    filters.sort === "due_desc"
      ? { dueAt: "desc" }
      : filters.sort === "created_desc"
        ? { createdAt: "desc" }
        : filters.sort === "created_asc"
          ? { createdAt: "asc" }
          : { dueAt: "asc" };
  // `id` tiebreaker for deterministic pagination (Pass 7 §25) — several
  // tasks can easily share a dueAt/createdAt (e.g. auto-created follow-ups).
  const orderBy: Prisma.TaskOrderByWithRelationInput[] = [primarySort, { id: "desc" }];

  const [rawTasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        contact: true,
        lead: { include: { contact: true } },
        assignee: true,
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.task.count({ where }),
  ]);
  const tasks = await maskTaskContacts(viewer, rawTasks);

  return { tasks, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getTaskCounts(viewer: Viewer, scopeUserId?: string) {
  const now = new Date();
  const base: Prisma.TaskWhereInput = { AND: [taskVisibilityWhere(viewer, scopeUserId)] };

  const [pending, overdue, dueToday, completed] = await Promise.all([
    prisma.task.count({ where: { ...base, status: "PENDING" } }),
    prisma.task.count({ where: { ...base, status: "PENDING", dueAt: { lt: now } } }),
    prisma.task.count({
      where: {
        ...base,
        status: "PENDING",
        dueAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()), lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) },
      },
    }),
    prisma.task.count({ where: { ...base, status: "COMPLETED" } }),
  ]);

  return { pending, overdue, dueToday, completed };
}

export async function getTaskDetail(taskId: string, viewer: Viewer) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, ...taskVisibilityWhere(viewer) },
    include: {
      contact: true,
      lead: { include: { contact: true, departureAirport: true, arrivalAirport: true } },
      assignee: true,
      completedBy: true,
    },
  });
  if (!task) return task;
  return (await maskTaskContacts(viewer, [task]))[0];
}

export async function searchLeadsForTaskLink(query: string, viewer: Viewer) {
  const maskLeads = <L extends { contact: { id: string; primaryEmail: string | null } }>(rows: L[]) =>
    withEmailPrivacy(viewer, rows, (l) => l.contact, (l, email) => ({ ...l, contact: { ...l.contact, primaryEmail: email } }));
  if (!query.trim()) {
    const leads = await prisma.lead.findMany({
      where: leadVisibilityWhere(viewer),
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { contact: true, departureAirport: true, arrivalAirport: true },
    });
    return maskLeads(leads);
  }
  const emailRestricted = await isEmailRestricted(viewer);
  const leads = await prisma.lead.findMany({
    where: {
      AND: [
        leadVisibilityWhere(viewer),
        {
          OR: viaContact(contactSearchConditions(query, { emailRestricted })),
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 8,
    include: { contact: true, departureAirport: true, arrivalAirport: true },
  });
  return maskLeads(leads);
}
