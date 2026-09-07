import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma. Focused on the Part 4/5 IDOR fix: Tasks previously
// had ZERO company or ownership scoping at all — getTasks/getTaskDetail/
// every task mutation. This covers the action-layer fix (visibility.ts's
// taskVisibilityWhere applied via assertTaskAccess) — and Part 18's
// redesign of that same function to be Lead-based rather than
// assigneeId-based: a restricted viewer's access now hinges on
// leadAssignedAgentId (or contactOwnerId when there's no Lead at all), not
// on who the task happens to be assigned to.

type FakeAccount = { id: string; role: string; companyId: string; status?: string };
type FakeTask = {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  contactId: string | null;
  leadId: string | null;
  leadAssignedAgentId: string | null;
  contactOwnerId: string | null;
  companyId: string;
  completedAt: Date | null;
  completedById: string | null;
  dueNotifiedAt: Date | null;
  dueAt: Date | null;
};

let currentActor: FakeAccount | null;
let tasks: Map<string, FakeTask>;
let accounts: Map<string, FakeAccount>;
let notifications: Array<Record<string, unknown>>;

// Generic structural matcher for the where shapes taskVisibilityWhere can
// produce (OR/AND groups, nested lead.assignedAgentId/lead.contact.companyId,
// contact.ownerId/contact.companyId, leadId: null) — evaluated against a
// Prisma-relation-shaped view of the fake task, the same way real Prisma
// would resolve those relations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function taskMatchesWhere(where: any, view: any): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as unknown[]).some((c) => taskMatchesWhere(c, view));
    if (key === "AND") return (cond as unknown[]).every((c) => taskMatchesWhere(c, view));
    const value = view?.[key];
    if (cond === null) return value === null || value === undefined;
    if (typeof cond === "object" && cond !== null) {
      if (value == null) return false;
      return taskMatchesWhere(cond, value);
    }
    return value === cond;
  });
}

function taskView(task: FakeTask) {
  return {
    id: task.id,
    leadId: task.leadId,
    lead: task.leadId ? { assignedAgentId: task.leadAssignedAgentId, contact: { companyId: task.companyId } } : null,
    contact: task.contactId ? { ownerId: task.contactOwnerId, companyId: task.companyId } : null,
  };
}

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/queries/tasks", () => ({ searchLeadsForTaskLink: vi.fn(async () => []) }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({})) }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn(async () => "DISCONNECTED") }));
vi.mock("@/server/email/service", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m1" })) }));
vi.mock("@/server/email/templates", () => ({ buildTaskReminderEmail: vi.fn(() => ({ subject: "s", html: "h" })) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrismaClient: any = {
  task: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const task = tasks.get(where.id as string);
      if (!task) return null;
      return taskMatchesWhere(where, taskView(task)) ? task : null;
    }),
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const task = tasks.get(id);
      if (!task) throw new Error("not found");
      return task;
    }),
    create: vi.fn(async ({ data }: { data: Partial<FakeTask> }) => {
      const id = `task-${tasks.size + 1}`;
      const task: FakeTask = {
        id,
        title: data.title ?? "",
        status: "PENDING",
        assigneeId: data.assigneeId ?? null,
        contactId: data.contactId ?? null,
        leadId: data.leadId ?? null,
        leadAssignedAgentId: data.leadAssignedAgentId ?? null,
        contactOwnerId: data.contactOwnerId ?? null,
        companyId: data.companyId ?? "company-1",
        completedAt: null,
        completedById: null,
        dueNotifiedAt: null,
        dueAt: null,
      };
      tasks.set(id, task);
      return task;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeTask> }) => {
      const task = tasks.get(id)!;
      Object.assign(task, data);
      return task;
    }),
    delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      tasks.delete(id);
    }),
    // Pass 20 — processDueTaskNotifications' own concurrency tests below.
    // findMany returns SHALLOW COPIES (`{...t}`), never the shared object
    // reference — the same real-Prisma-semantics lesson Pass 19 learned
    // the hard way for the equivalent sequences mock: without this, one
    // concurrent invocation's later claim-mutation would retroactively
    // change what a DIFFERENT invocation's already-fetched list appears to
    // hold, which isn't how Postgres actually behaves.
    findMany: vi.fn(async ({ where }: { where: { status: string; assigneeId: { not: null }; dueAt: { lte: Date }; dueNotifiedAt: null } }) =>
      [...tasks.values()]
        .filter((t) => t.status === where.status && t.assigneeId !== null && t.dueNotifiedAt === null && t.dueAt != null && t.dueAt.getTime() <= where.dueAt.lte.getTime())
        .map((t) => ({ ...t, assignee: accounts.get(t.assigneeId!) ? { id: t.assigneeId, fullName: "Agent", email: "agent@example.com" } : null, contact: null, lead: null }))
    ),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; dueNotifiedAt: null }; data: { dueNotifiedAt: Date } }) => {
      const task = tasks.get(where.id);
      if (!task || task.dueNotifiedAt !== where.dueNotifiedAt) return { count: 0 };
      task.dueNotifiedAt = data.dueNotifiedAt;
      return { count: 1 };
    }),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      notifications.push(data);
      return data;
    }),
  },
  contact: { findFirst: vi.fn(async () => null) },
  lead: { findFirst: vi.fn(async () => null) },
  account: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; companyId?: string; status?: string; role?: { not?: string } } }) => {
      const acc = accounts.get(where.id);
      if (!acc) return null;
      if (where.companyId && acc.companyId !== where.companyId) return null;
      if (where.status && acc.status !== where.status) return null;
      if (where.role?.not && acc.role === where.role.not) return null;
      return acc;
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrismaClient }));

beforeEach(() => {
  currentActor = null;
  tasks = new Map();
  accounts = new Map();
  notifications = [];
  vi.clearAllMocks();
});

function seedTask(id: string, overrides: Partial<FakeTask> = {}) {
  tasks.set(id, {
    id,
    title: "Task",
    status: "PENDING",
    assigneeId: null,
    // Every real task has at least a Lead (see visibility.ts's own
    // comment) — defaulted here so company-wide viewers can see a task by
    // default without every test needing to set this explicitly.
    contactId: null,
    leadId: "lead-x",
    leadAssignedAgentId: null,
    contactOwnerId: null,
    companyId: "company-1",
    completedAt: null,
    completedById: null,
    dueNotifiedAt: null,
    dueAt: null,
    ...overrides,
  });
}

describe("Tasks — IDOR/ownership fix (previously zero authorization check at all)", () => {
  it("a Travel Agent cannot delete a task whose Lead is assigned to a different agent", async () => {
    seedTask("task-1", { leadAssignedAgentId: "agent-owner" });
    currentActor = { id: "agent-2", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { deleteTask } = await import("../tasks");
    await expect(deleteTask("task-1")).rejects.toThrow(/not found/i);
    expect(tasks.has("task-1")).toBe(true);
  });

  it("a Travel Agent CAN delete a task whose Lead is assigned to them, even if manually assigned to someone else", async () => {
    // Part 18 — visibility is Lead-based, not assigneeId-based: assigneeId
    // here is deliberately a DIFFERENT person than the actor, proving
    // manual assignment alone neither grants nor blocks access.
    seedTask("task-1", { leadAssignedAgentId: "agent-1", assigneeId: "someone-else" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { deleteTask } = await import("../tasks");
    await deleteTask("task-1");
    expect(tasks.has("task-1")).toBe(false);
  });

  it("an Admin (company-wide visibility) can toggle/complete ANY task", async () => {
    seedTask("task-1", { leadAssignedAgentId: "someone-else" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { toggleTask } = await import("../tasks");
    await toggleTask("task-1");
    expect(tasks.get("task-1")!.status).toBe("COMPLETED");
  });

  it("a Travel Agent cannot toggle a task whose Lead is assigned to a different agent, even if manually assigned to them", async () => {
    seedTask("task-1", { leadAssignedAgentId: "someone-else", assigneeId: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { toggleTask } = await import("../tasks");
    await expect(toggleTask("task-1")).rejects.toThrow(/not found/i);
    expect(tasks.get("task-1")!.status).toBe("PENDING");
  });

  it("a Travel Agent with no Lead on the task falls back to their own Contact ownership", async () => {
    seedTask("task-1", { leadId: null, contactId: "contact-1", contactOwnerId: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { toggleTask } = await import("../tasks");
    await toggleTask("task-1");
    expect(tasks.get("task-1")!.status).toBe("COMPLETED");
  });

  it("updateTask rejects a non-owning restricted-role actor", async () => {
    seedTask("task-1", { leadAssignedAgentId: "agent-owner", title: "Original" });
    currentActor = { id: "agent-2", role: "TRAVEL_AGENT", companyId: "company-1" };
    const { updateTask } = await import("../tasks");
    await expect(updateTask({ taskId: "task-1", title: "Hijacked" })).rejects.toThrow(/not found/i);
    expect(tasks.get("task-1")!.title).toBe("Original");
  });

  it("reassignTask rejects an assignee outside the actor's own company", async () => {
    seedTask("task-1", { leadAssignedAgentId: "admin-1" });
    accounts.set("outsider", { id: "outsider", role: "TRAVEL_AGENT", companyId: "other-company", status: "ACTIVE" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { reassignTask } = await import("../tasks");
    await expect(reassignTask("task-1", "outsider")).rejects.toThrow(/own company/i);
  });

  it("reassignTask succeeds for an active assignee in the same company", async () => {
    seedTask("task-1", { assigneeId: "admin-1" });
    accounts.set("agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", status: "ACTIVE" });
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { reassignTask } = await import("../tasks");
    await reassignTask("task-1", "agent-1");
    expect(tasks.get("task-1")!.assigneeId).toBe("agent-1");
  });

  // Marketing Agent has no access to Tasks at all (canViewTasks) — assigning
  // them one is a dead-end (see reference-data.ts's listTaskEligibleAgents).
  // These cover the server-side enforcement, not just the UI dropdown fix.
  describe("Marketing Agent cannot be a task assignee (dead-end: they can never view Tasks)", () => {
    it("createTask rejects a Marketing Agent assigneeId", async () => {
      accounts.set("marketer-1", { id: "marketer-1", role: "MARKETING_AGENT", companyId: "company-1", status: "ACTIVE" });
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
      const { createTask } = await import("../tasks");
      await expect(createTask({ title: "Follow up", assigneeId: "marketer-1" })).rejects.toThrow(/access to Tasks/i);
    });

    it("updateTask rejects reassigning to a Marketing Agent", async () => {
      seedTask("task-1", { assigneeId: "admin-1" });
      accounts.set("marketer-1", { id: "marketer-1", role: "MARKETING_AGENT", companyId: "company-1", status: "ACTIVE" });
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
      const { updateTask } = await import("../tasks");
      await expect(updateTask({ taskId: "task-1", assigneeId: "marketer-1" })).rejects.toThrow(/access to Tasks/i);
      expect(tasks.get("task-1")!.assigneeId).toBe("admin-1"); // untouched
    });

    it("reassignTask rejects a Marketing Agent as the new assignee", async () => {
      seedTask("task-1", { assigneeId: "admin-1" });
      accounts.set("marketer-1", { id: "marketer-1", role: "MARKETING_AGENT", companyId: "company-1", status: "ACTIVE" });
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
      const { reassignTask } = await import("../tasks");
      await expect(reassignTask("task-1", "marketer-1")).rejects.toThrow(/access to Tasks/i);
      expect(tasks.get("task-1")!.assigneeId).toBe("admin-1"); // untouched
    });

    it("createTask still succeeds for a non-Marketing-Agent assignee (no regression)", async () => {
      accounts.set("agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", status: "ACTIVE" });
      currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
      const { createTask } = await import("../tasks");
      const task = await createTask({ title: "Follow up", assigneeId: "agent-1" });
      expect(task.assigneeId).toBe("agent-1");
    });
  });
});

// Pass 20 — the exact same concurrency class Pass 19 found and fixed in
// processDueSequenceSteps, discovered by auditing every other "scan due
// work, notify, then mark notified" cron-style entry point in the
// codebase for the same unmitigated read-then-later-write gap. Before
// this pass, processDueTaskNotifications had NO test coverage at all.
describe("processDueTaskNotifications — concurrency (Pass 20)", () => {
  function seedDueTask(id: string, overrides: Partial<FakeTask> = {}) {
    accounts.set("agent-1", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", status: "ACTIVE" });
    seedTask(id, { assigneeId: "agent-1", dueAt: new Date(Date.now() - 1000), ...overrides });
  }

  it("notifies exactly once for a single invocation", async () => {
    seedDueTask("task-1");
    const { processDueTaskNotifications } = await import("../tasks");
    const result = await processDueTaskNotifications();
    expect(result.notified).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(tasks.get("task-1")!.dueNotifiedAt).not.toBeNull();
  });

  it("two concurrent invocations processing the SAME due task notify exactly once, not twice", async () => {
    seedDueTask("task-1");
    const { processDueTaskNotifications } = await import("../tasks");
    const [first, second] = await Promise.all([processDueTaskNotifications(), processDueTaskNotifications()]);
    expect(first.notified + second.notified).toBe(1); // NEVER 2 — this is the actual bug this pass fixed
    expect(notifications).toHaveLength(1);
  });

  it("a task with no assignee is skipped without error and never counted as notified", async () => {
    seedTask("task-1", { assigneeId: null, dueAt: new Date(Date.now() - 1000) });
    const { processDueTaskNotifications } = await import("../tasks");
    const result = await processDueTaskNotifications();
    expect(result.notified).toBe(0);
    expect(notifications).toHaveLength(0);
  });

  it("does not re-notify a task that was already notified in a previous scan", async () => {
    seedDueTask("task-1", { dueNotifiedAt: new Date() });
    const { processDueTaskNotifications } = await import("../tasks");
    const result = await processDueTaskNotifications();
    expect(result.notified).toBe(0);
    expect(notifications).toHaveLength(0);
  });
});
