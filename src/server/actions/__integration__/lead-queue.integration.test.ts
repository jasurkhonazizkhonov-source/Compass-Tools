// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// REAL-DATABASE concurrency tests for the lead distribution queue. Runs only
// when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL database
// with this repo's migrations applied (see booking-submit.integration.test.ts
// for the convention); skipped otherwise. Everything it creates lives in its
// own throwaway Company rows and is deleted afterward.
//
// The unit tests fake Prisma, so they cannot show what actually matters for
// this feature: that FOR UPDATE SKIP LOCKED and the conditional claims hold
// up under genuinely simultaneous requests.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

type FakeAccount = { id: string; fullName: string; companyId: string; role: string };
let currentAccount: FakeAccount | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentAccount) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `lq-${Date.now()}`;

// getMyLeadOffer schedules its stranded-lead pickup via after(); with no
// request scope in a test process runAfterResponse runs it inline.

describe.skipIf(!enabled)("lead queue under real concurrency (PostgreSQL)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let queue: typeof import("../lead-queue");
  const companyIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    queue = await import("../lead-queue");
  });

  afterAll(async () => {
    if (!enabled) return;
    for (const companyId of companyIds) {
      await prisma.contact.deleteMany({ where: { companyId } });
      await prisma.account.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  // Each scenario gets its OWN company: candidate workers are scoped by the
  // lead's company, so scenarios cannot see each other's agents.
  async function scenario(agentCount: number, opts: { pausedCount?: number } = {}) {
    const n = ++seq;
    const companyId = `${TAG}-co-${n}`;
    companyIds.push(companyId);
    await prisma.company.create({ data: { id: companyId, name: `Co ${n}`, signatureTemplate: "x" } });

    const agents: FakeAccount[] = [];
    for (let i = 0; i < agentCount + (opts.pausedCount ?? 0); i++) {
      const a = await prisma.account.create({
        data: { fullName: `Agent ${n}-${i}`, email: `agent-${n}-${i}-${TAG}@example.test`, role: "TRAVEL_AGENT", companyId },
      });
      const paused = i >= agentCount;
      // Distinct, ordered join times so queue order is deterministic.
      await prisma.leadQueueEntry.create({ data: { accountId: a.id, isActive: !paused, joinedAt: new Date(Date.now() - (100 - i) * 1000) } });
      agents.push({ id: a.id, fullName: a.fullName, companyId, role: "TRAVEL_AGENT" });
    }

    const makeLead = async () => {
      const contact = await prisma.contact.create({ data: { firstName: "Web", lastName: `Lead${++seq}`, primaryEmail: `web${seq}-${TAG}@example.test`, companyId } });
      return prisma.lead.create({ data: { contactId: contact.id, source: "WEBSITE", status: "ATTEMPTING_TO_CONTACT" } });
    };
    return { companyId, agents, makeLead };
  }

  it("the SAME lead distributed by several callers at once (cron + inline + retries) is offered to exactly ONE agent", async () => {
    const { agents, makeLead } = await scenario(3);
    const lead = await makeLead();

    const results = await Promise.all(Array.from({ length: 6 }, () => queue.distributeNewWebsiteLead(lead.id)));

    expect(results.filter((r) => r.offered)).toHaveLength(1);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(agents.map((a) => a.id)).toContain(row.offeredToId);
    expect(row.assignedAgentId).toBeNull();
    expect(row.offerExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("a burst of leads across a few agents: no agent is ever offered two live leads, and none is offered twice", async () => {
    const { agents, makeLead } = await scenario(3);
    const leads = await Promise.all(Array.from({ length: 6 }, () => makeLead()));

    const results = await Promise.all(leads.map((l) => queue.distributeNewWebsiteLead(l.id)));

    expect(results.filter((r) => r.offered)).toHaveLength(3); // one per agent
    const offered = await prisma.lead.findMany({ where: { id: { in: leads.map((l) => l.id) }, offeredToId: { not: null } } });
    const perAgent = new Map<string, number>();
    for (const l of offered) perAgent.set(l.offeredToId!, (perAgent.get(l.offeredToId!) ?? 0) + 1);
    expect(perAgent.size).toBe(3);
    for (const count of perAgent.values()) expect(count).toBe(1);
    expect(new Set(offered.map((l) => l.offeredToId))).toEqual(new Set(agents.map((a) => a.id)));
  });

  it("a paused (not accepting) agent is never offered a lead, even when first in line", async () => {
    const { agents, makeLead } = await scenario(1, { pausedCount: 2 });
    const lead = await makeLead();

    const result = await queue.distributeNewWebsiteLead(lead.id);

    expect(result.offered).toBe(true);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).offeredToId).toBe(agents[0].id);
  });

  it("with nobody accepting, the lead stays unassigned and unoffered (stored for later) and is picked up once someone resumes", async () => {
    const { agents, makeLead } = await scenario(0, { pausedCount: 1 });
    const lead = await makeLead();

    const first = await queue.distributeNewWebsiteLead(lead.id);
    expect(first).toMatchObject({ offered: false, reason: "no_active_workers" });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ offeredToId: null, assignedAgentId: null });

    // The agent resumes accepting leads.
    await prisma.leadQueueEntry.update({ where: { accountId: agents[0].id }, data: { isActive: true } });
    const second = await queue.distributeNewWebsiteLead(lead.id);
    expect(second.offered).toBe(true);
  });

  it("double-clicking Accept (5 simultaneous requests) assigns the lead ONCE: one history row, one counter increment, contact owned by the agent", async () => {
    const { agents, makeLead } = await scenario(2);
    const lead = await makeLead();
    await queue.distributeNewWebsiteLead(lead.id);
    const offeredTo = (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).offeredToId!;
    currentAccount = agents.find((a) => a.id === offeredTo)!;

    const results = await Promise.all(Array.from({ length: 5 }, () => queue.acceptLeadOffer(lead.id)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.assignedAgentId).toBe(offeredTo);
    expect(row.offeredToId).toBeNull();
    expect(await prisma.leadStatusHistory.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await prisma.leadQueueEntry.findUniqueOrThrow({ where: { accountId: offeredTo } })).leadsAssignedCount).toBe(1);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: lead.contactId } })).ownerId).toBe(offeredTo);
    expect(await prisma.notification.count({ where: { leadId: lead.id, type: "LEAD_ASSIGNED" } })).toBe(1);
  });

  it("an agent who is NOT the one offered cannot accept it", async () => {
    const { agents, makeLead } = await scenario(2);
    const lead = await makeLead();
    await queue.distributeNewWebsiteLead(lead.id);
    const offeredTo = (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).offeredToId!;
    currentAccount = agents.find((a) => a.id !== offeredTo)!;

    const result = await queue.acceptLeadOffer(lead.id);

    expect(result.ok).toBe(false);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBeNull();
  });

  it("an expired offer moves on to the NEXT agent (timed-out agent goes to the back), and the late accept is refused", async () => {
    const { agents, makeLead } = await scenario(2);
    const lead = await makeLead();
    await queue.distributeNewWebsiteLead(lead.id);
    const first = (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).offeredToId!;
    const second = agents.find((a) => a.id !== first)!;

    // The window runs out.
    await prisma.lead.update({ where: { id: lead.id }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });
    // Any poll by the next agent sweeps expired offers (this is what the modal does).
    currentAccount = second;
    const seen = await queue.getMyLeadOffer();

    expect(seen?.leadId).toBe(lead.id); // the next agent now holds the live offer
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.offeredToId).toBe(second.id);
    // The agent who timed out was moved to the end of the line.
    const [timedOut, other] = await Promise.all([
      prisma.leadQueueEntry.findUniqueOrThrow({ where: { accountId: first } }),
      prisma.leadQueueEntry.findUniqueOrThrow({ where: { accountId: second.id } }),
    ]);
    expect(timedOut.lastAssignedAt).not.toBeNull();
    expect(other.lastAssignedAt).toBeNull();

    // The first agent, too late, cannot claim it.
    currentAccount = agents.find((a) => a.id === first)!;
    const late = await queue.acceptLeadOffer(lead.id);
    expect(late.ok).toBe(false);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).assignedAgentId).toBeNull();
  });

  it("a STRANDED website lead (nobody was accepting when it arrived) is picked up by an active agent's next offer poll — no re-join or cron needed", async () => {
    const { resetPendingPickupThrottleForTests } = await import("../../lead-pickup-throttle");
    resetPendingPickupThrottleForTests();
    const { agents, makeLead } = await scenario(1, { pausedCount: 0 });
    // The lead exists but was never offered (e.g. the inline distribution lost a race, or ran while agents were paused).
    const lead = await makeLead();
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ offeredToId: null, assignedAgentId: null });

    currentAccount = agents[0];
    const firstPoll = await queue.getMyLeadOffer(); // nothing live yet -> triggers the pickup
    expect(firstPoll).toBeNull();

    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).offeredToId).toBe(agents[0].id);
    const secondPoll = await queue.getMyLeadOffer();
    expect(secondPoll?.leadId).toBe(lead.id);
  });

  it("a lead is never dropped when workers are only momentarily busy: a burst larger than the pool still ends with every lead offered or pending, none lost or double-offered", async () => {
    const { agents, makeLead } = await scenario(4);
    const leads = await Promise.all(Array.from({ length: 12 }, () => makeLead()));

    const results = await Promise.all(leads.map((l) => queue.distributeNewWebsiteLead(l.id)));

    // 4 agents can each hold one live offer; the rest must stay pending, not vanish.
    const offered = await prisma.lead.findMany({ where: { id: { in: leads.map((l) => l.id) }, offeredToId: { not: null } } });
    expect(offered).toHaveLength(4);
    expect(new Set(offered.map((l) => l.offeredToId)).size).toBe(4); // one live offer per agent
    expect(new Set(offered.map((l) => l.offeredToId))).toEqual(new Set(agents.map((a) => a.id)));
    const pending = await prisma.lead.count({ where: { id: { in: leads.map((l) => l.id) }, offeredToId: null, assignedAgentId: null, queueDistributedAt: null } });
    expect(pending).toBe(8);
    expect(results.filter((r) => r.offered)).toHaveLength(4);
  });

  it("many concurrent polls of an expired offer (every open tab sweeping at once) advance it exactly once", async () => {
    const { agents, makeLead } = await scenario(3);
    const lead = await makeLead();
    await queue.distributeNewWebsiteLead(lead.id);
    await prisma.lead.update({ where: { id: lead.id }, data: { offerExpiresAt: new Date(Date.now() - 1000) } });

    currentAccount = agents[0];
    await Promise.all(Array.from({ length: 8 }, () => queue.getMyLeadOffer()));

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    // Offered to exactly one agent again, with a fresh live window — not skipped past several agents.
    expect(row.offeredToId).not.toBeNull();
    expect(row.offerExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const withLastAssigned = await prisma.leadQueueEntry.count({ where: { accountId: { in: agents.map((a) => a.id) }, lastAssignedAt: { not: null } } });
    expect(withLastAssigned).toBe(1);
  });
});
