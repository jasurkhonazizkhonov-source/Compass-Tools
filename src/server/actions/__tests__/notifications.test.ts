import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for a real IDOR: these three actions previously
// trusted a client-supplied accountId/notificationId with no server-side
// ownership check — notification-bell.tsx (a Client Component) passed its
// own accountId prop straight through, which is just a POST field as far
// as a direct server-action call is concerned. Proves each action now
// derives the actor from the session and never reads/mutates another
// account's notifications.

let currentAccount: { id: string; role: string } | null;
let getRecentNotificationsCalls: string[];
let getUnreadNotificationCountCalls: string[];
let updateManyCalls: Array<{ where: Record<string, unknown> }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentAccount),
}));

vi.mock("@/server/queries/notifications", () => ({
  getRecentNotifications: vi.fn(async (accountId: string) => {
    getRecentNotificationsCalls.push(accountId);
    return [{ id: "notif-1", accountId }];
  }),
  getUnreadNotificationCount: vi.fn(async (accountId: string) => {
    getUnreadNotificationCountCalls.push(accountId);
    return 3;
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      updateMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        updateManyCalls.push({ where });
        return { count: 1 };
      }),
    },
  },
}));

beforeEach(() => {
  currentAccount = { id: "acct-1", role: "TRAVEL_AGENT" };
  getRecentNotificationsCalls = [];
  getUnreadNotificationCountCalls = [];
  updateManyCalls = [];
  vi.clearAllMocks();
});

describe("fetchMyNotifications", () => {
  it("fetches using the CALLER's own session-derived account id, never a client-supplied one", async () => {
    const { fetchMyNotifications } = await import("../notifications");
    const result = await fetchMyNotifications();
    expect(getRecentNotificationsCalls).toEqual(["acct-1"]);
    expect(getUnreadNotificationCountCalls).toEqual(["acct-1"]);
    expect(result.unreadCount).toBe(3);
  });

  it("returns an empty result instead of throwing when there is no session", async () => {
    currentAccount = null;
    const { fetchMyNotifications } = await import("../notifications");
    const result = await fetchMyNotifications();
    expect(result).toEqual({ items: [], unreadCount: 0 });
    expect(getRecentNotificationsCalls).toEqual([]);
  });
});

describe("markNotificationRead", () => {
  it("scopes the update to the CALLER's own account — a notification belonging to someone else silently matches nothing", async () => {
    const { markNotificationRead } = await import("../notifications");
    await markNotificationRead("notif-999");
    expect(updateManyCalls).toEqual([{ where: { id: "notif-999", accountId: "acct-1" } }]);
  });

  it("no-ops when there is no session", async () => {
    currentAccount = null;
    const { markNotificationRead } = await import("../notifications");
    await markNotificationRead("notif-999");
    expect(updateManyCalls).toEqual([]);
  });
});

describe("markAllNotificationsRead", () => {
  it("only ever marks the CALLER's own notifications read — no accountId parameter exists to spoof", async () => {
    const { markAllNotificationsRead } = await import("../notifications");
    await markAllNotificationsRead();
    expect(updateManyCalls).toEqual([{ where: { accountId: "acct-1", readAt: null } }]);
  });

  it("no-ops when there is no session", async () => {
    currentAccount = null;
    const { markAllNotificationsRead } = await import("../notifications");
    await markAllNotificationsRead();
    expect(updateManyCalls).toEqual([]);
  });
});
