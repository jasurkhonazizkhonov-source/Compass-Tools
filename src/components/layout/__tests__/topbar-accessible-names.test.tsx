// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";

// Fix-verification pass — the 768px topbar overflow was fixed by moving
// three elements' "show the descriptive text" breakpoint from sm/md
// (640/768px) to lg (1024px): AccountMenu's name/role block, PacificClock,
// and LeadQueueToggle's label. jsdom has no real CSS engine (Tailwind's
// `hidden lg:flex` is just a class-name string to it — there's no media
// query evaluation, no layout, no way to ask "is this visible at width
// X"), so a real breakpoint/visibility regression test isn't meaningfully
// possible here; that's what the live-browser DOM measurements (see the
// final report) are the authoritative check for. What jsdom CAN
// meaningfully verify — and what actually needed fixing alongside the
// responsive change — is that each control's ACCESSIBLE NAME no longer
// depends on that now-more-often-hidden text: three of these buttons
// previously had no aria-label at all (or a static one that ignored
// dynamic state), so hiding their visible text at a narrower width would
// have silently shrunk their accessible name too. This is a real,
// CSS-independent behavioral contract, not a brittle class-string check.

describe("AccountMenu — accessible name independent of responsive text visibility", () => {
  it("exposes the full name and role via aria-label, not just the (sometimes visually hidden) text block", async () => {
    vi.doMock("@/server/actions/dev-session", () => ({ signOut: vi.fn() }));
    vi.doMock("@/server/actions/gmail-connect", () => ({ startGmailConnect: vi.fn(), disconnectGmail: vi.fn() }));
    const { AccountMenu } = await import("../account-menu");
    render(<AccountMenu current={{ id: "1", fullName: "Jane Smith", email: "jane@example.com", role: "ADMIN" }} gmailStatus="NOT_CONNECTED" />);
    expect(screen.getByRole("button", { name: /Jane Smith.*Admin/i })).toBeInTheDocument();
  });

  it("falls back to a generic but still non-empty label when there is no signed-in account", async () => {
    vi.doMock("@/server/actions/dev-session", () => ({ signOut: vi.fn() }));
    vi.doMock("@/server/actions/gmail-connect", () => ({ startGmailConnect: vi.fn(), disconnectGmail: vi.fn() }));
    const { AccountMenu } = await import("../account-menu");
    render(<AccountMenu current={null} gmailStatus="NOT_CONNECTED" />);
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });
});

describe("LeadQueueToggle — accessible name independent of responsive text visibility", () => {
  it("exposes the queue position and status via aria-label even though the equivalent text span is hidden below lg", async () => {
    vi.doMock("@/server/actions/lead-queue", () => ({ joinLeadQueue: vi.fn(), leaveLeadQueue: vi.fn() }));
    const { LeadQueueToggle } = await import("../lead-queue-toggle");
    render(<LeadQueueToggle initialIsActive={true} initialPosition={3} />);
    expect(screen.getByRole("button", { name: /queue.*#3.*accepting/i })).toBeInTheDocument();
  });

  it("still has a real, non-empty accessible name when there's no queue position yet (the icon-only case)", async () => {
    vi.doMock("@/server/actions/lead-queue", () => ({ joinLeadQueue: vi.fn(), leaveLeadQueue: vi.fn() }));
    const { LeadQueueToggle } = await import("../lead-queue-toggle");
    render(<LeadQueueToggle initialIsActive={false} initialPosition={null} />);
    expect(screen.getByRole("button", { name: /accept leads/i })).toBeInTheDocument();
  });
});

describe("NotificationBell — accessible name reflects the unread count, which is otherwise a purely visual badge", async () => {
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
  vi.doMock("@/server/actions/notifications", () => ({
    fetchMyNotifications: vi.fn(async () => ({ items: [], unreadCount: 5 })),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  }));
  const { NotificationBell } = await import("../notification-bell");

  it("announces the unread count in the accessible name once notifications load, not just via the visual badge", async () => {
    render(<NotificationBell accountId="account-1" />);
    expect(await screen.findByRole("button", { name: "Notifications, 5 unread" })).toBeInTheDocument();
  });
});
