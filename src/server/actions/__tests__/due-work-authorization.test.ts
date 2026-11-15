import { describe, it, expect, vi, beforeEach } from "vitest";

// The "process due" sweeps used to be exported straight from "use server" modules: public Server Actions with no check of their own, the same
// function the cron route and the boot-time poller call. They now live in plain modules (src/server/due-task-notifications.ts,
// src/server/due-sequence-steps.ts); the signed-in buttons call role-checked wrappers, and the cron routes / poller call the sweeps directly.
// These tests pin that split with the sweeps mocked, so no database, email or Gmail is involved.

const runTasks = vi.fn(async () => ({ scanned: 2, notified: 1 }));
const runSequences = vi.fn(async () => ({ sent: 3, failed: 0 }));
let account: { id: string; role: string } | null = null;

vi.mock("@/server/due-task-notifications", () => ({ runDueTaskNotifications: () => runTasks() }));
vi.mock("@/server/due-sequence-steps", () => ({ runDueSequenceSteps: () => runSequences(), drainDueSequenceSteps: () => runSequences() }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => account) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/server/email/service", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/email/templates", () => ({ buildTaskReminderEmail: vi.fn(), buildSequenceEmail: vi.fn() }));
vi.mock("@/server/queries/tasks", () => ({ searchLeadsForTaskLink: vi.fn() }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn() }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn() }));
vi.mock("@/server/sequence-enrollment-eligibility", () => ({ classifyLeadsForEnrollment: vi.fn() }));

beforeEach(() => {
  runTasks.mockClear();
  runSequences.mockClear();
  account = null;
});

const ROLES_WITH_PAGE = ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT"];

describe("processDueTaskNotifications (the Tasks page button) is a role-checked Server Action", () => {
  it("refuses an unauthenticated call and never runs the sweep", async () => {
    const { processDueTaskNotifications } = await import("../tasks");
    await expect(processDueTaskNotifications()).rejects.toThrow(/not authorized/i);
    expect(runTasks).not.toHaveBeenCalled();
  });

  it("refuses a role that cannot see the Tasks page", async () => {
    const { processDueTaskNotifications } = await import("../tasks");
    const { canViewTasks } = await import("@/lib/permissions");
    const blocked = ["BACK_OFFICE", "MARKETING", "ACCOUNTING", "SUPPORT"].find((r) => !canViewTasks(r as never));
    if (!blocked) return; // every defined role may see the page - nothing to refuse
    account = { id: "a1", role: blocked };
    await expect(processDueTaskNotifications()).rejects.toThrow(/not authorized/i);
    expect(runTasks).not.toHaveBeenCalled();
  });

  it("runs the sweep for a signed-in role that can see the page, and returns its counts", async () => {
    const { processDueTaskNotifications } = await import("../tasks");
    const { canViewTasks } = await import("@/lib/permissions");
    const role = ROLES_WITH_PAGE.find((r) => canViewTasks(r as never))!;
    account = { id: "a1", role };
    expect(await processDueTaskNotifications()).toEqual({ scanned: 2, notified: 1 });
    expect(runTasks).toHaveBeenCalledTimes(1);
  });
});

describe("processDueSequenceSteps (the Sequence page button) is a role-checked Server Action", () => {
  it("refuses an unauthenticated call and never runs the sweep", async () => {
    const { processDueSequenceSteps } = await import("../sequences");
    await expect(processDueSequenceSteps()).rejects.toThrow(/not authorized/i);
    expect(runSequences).not.toHaveBeenCalled();
  });

  it("runs the sweep for a role that can see the Sequences page", async () => {
    const { processDueSequenceSteps } = await import("../sequences");
    const { canViewSequencesPage } = await import("@/lib/permissions");
    const role = ROLES_WITH_PAGE.find((r) => canViewSequencesPage(r as never))!;
    account = { id: "a1", role };
    expect(await processDueSequenceSteps()).toEqual({ sent: 3, failed: 0 });
    expect(runSequences).toHaveBeenCalledTimes(1);
  });
});

describe("the sweeps are no longer public Server Actions", () => {
  it("the new modules do not carry a 'use server' directive, and the action modules no longer export the sweeps", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of ["src/server/due-task-notifications.ts", "src/server/due-sequence-steps.ts"]) {
      expect(read(rel), rel).not.toMatch(/^\s*["']use server["']/m);
    }
    expect(read("src/server/actions/tasks.ts")).not.toMatch(/export async function runDueTaskNotifications/);
    expect(read("src/server/actions/sequences.ts")).not.toMatch(/export async function runDueSequenceSteps/);
  });

  it("the cron routes and the poller call the sweeps directly (they have no signed-in user), never the guarded action wrappers", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    expect(read("src/app/api/cron/tasks/route.ts")).toMatch(/runDueTaskNotifications/);
    expect(read("src/app/api/cron/tasks/route.ts")).not.toMatch(/actions\/tasks/);
    expect(read("src/app/api/cron/sequences/route.ts")).toMatch(/drainDueSequenceSteps/); // the drain wrapper around runDueSequenceSteps
    expect(read("src/app/api/cron/sequences/route.ts")).not.toMatch(/actions\/sequences/);
    expect(read("src/instrumentation.ts")).toMatch(/runDueTaskNotifications/);
    expect(read("src/instrumentation.ts")).toMatch(/drainDueSequenceSteps/); // the poller sends due sequence steps too
    expect(read("src/instrumentation.ts")).not.toMatch(/processDueSequenceSteps/);
    expect(read("src/instrumentation.ts")).not.toMatch(/import\(\s*["']@\/server\/actions\/tasks["']\s*\)/); // comments may mention the action by name
  });
});
