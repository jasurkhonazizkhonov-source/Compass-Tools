// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ActivityTimeline } from "../activity-timeline";

// ActivityTimeline imports loadMoreActivities (a "use server" action) for
// its Pass 6 "Load more" button — mocked here so this component test never
// touches the real Prisma client (this file runs under jsdom with no
// DATABASE_URL configured, same reason every other component test mocks
// its server-action imports).
const { loadMoreActivities } = vi.hoisted(() => ({ loadMoreActivities: vi.fn() }));
vi.mock("@/server/actions/activity", () => ({ loadMoreActivities }));

// Pass 5 — Activity History UI. Groups activities by calendar day (Today/
// Yesterday/weekday/date) and shows a per-event-type icon, matching the
// requested mockup. Deliberately tests observable behavior (what groups
// render, in what order, with what text) rather than icon implementation
// details.

function activity(overrides: Partial<{ id: string; type: string; description: string; createdAt: Date; actor: { fullName: string } | null }>) {
  return {
    id: "a1",
    type: "LEAD_CREATED",
    description: "Lead created",
    createdAt: new Date(),
    actor: { fullName: "Nigora Dadabaeva" },
    ...overrides,
  };
}

describe("ActivityTimeline — empty state", () => {
  it("shows an empty state with no activities, not a blank/broken timeline", () => {
    render(<ActivityTimeline activities={[]} />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });
});

describe("ActivityTimeline — date grouping", () => {
  it("groups a today event under 'Today' and an older event under its own date, in the order given (newest-first is the caller's responsibility)", () => {
    const now = new Date();
    const oldDate = new Date(2020, 0, 1, 10, 0);
    render(
      <ActivityTimeline
        activities={[
          activity({ id: "a1", createdAt: now, description: "Recent event" }),
          activity({ id: "a2", createdAt: oldDate, description: "Old event" }),
        ]}
      />
    );
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Jan 1, 2020")).toBeInTheDocument();
    expect(screen.getByText("Recent event")).toBeInTheDocument();
    expect(screen.getByText("Old event")).toBeInTheDocument();
  });

  it("groups two same-day events under one shared date heading, not two separate ones", () => {
    const now = new Date();
    render(
      <ActivityTimeline
        activities={[
          activity({ id: "a1", createdAt: now, description: "First today" }),
          activity({ id: "a2", createdAt: new Date(now.getTime() - 60_000), description: "Second today" }),
        ]}
      />
    );
    expect(screen.getAllByText("Today")).toHaveLength(1);
  });
});

describe("ActivityTimeline — content", () => {
  it("shows the actor's name and falls back to 'System' when there is none (e.g. a system-triggered event)", () => {
    render(
      <ActivityTimeline
        activities={[
          activity({ id: "a1", actor: { fullName: "Jasur" }, description: "Actor event" }),
          activity({ id: "a2", actor: null, description: "System event" }),
        ]}
      />
    );
    expect(screen.getByText(/Jasur/)).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.tagName === "P" && /^System ·/.test(el.textContent ?? ""))).toBeInTheDocument();
  });

  it("renders the exact description text as written by the server (single source of truth, no re-derivation in the UI)", () => {
    render(<ActivityTimeline activities={[activity({ description: "Reassigned from Sarah Johnson to Nigora Dadabaeva — Agent unavailable" })]} />);
    expect(screen.getByText("Reassigned from Sarah Johnson to Nigora Dadabaeva — Agent unavailable")).toBeInTheDocument();
  });
});

// Pass 6 (§32.C) — "Load more" only shows up when there's actually a
// leadId/contactId to page against AND the initial batch looks like it
// might be a truncated 30-row page; a short list (the common case for most
// leads/contacts) never shows a dead-end "Load more" button.
describe("ActivityTimeline — load more (Pass 6, §32.C)", () => {
  it("shows no 'Load more' button when there are fewer than a full page of activities", () => {
    render(<ActivityTimeline activities={[activity({ id: "a1" })]} leadId="lead-1" />);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("shows no 'Load more' button when a full page arrives but no leadId/contactId was given (nothing to page against)", () => {
    const fullPage = Array.from({ length: 30 }, (_, i) => activity({ id: `a${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) }));
    render(<ActivityTimeline activities={fullPage} />);
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("shows 'Load more' when a full 30-row page arrives with a leadId, fetches and appends the next page on click, then hides itself once the server reports no more", async () => {
    const user = userEvent.setup();
    const fullPage = Array.from({ length: 30 }, (_, i) => activity({ id: `a${i}`, description: `Event ${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) }));
    loadMoreActivities.mockResolvedValueOnce({
      activities: [activity({ id: "older-1", description: "An older event", createdAt: new Date(2025, 0, 1), actor: { fullName: "Older Actor" } })],
      hasMore: false,
    });

    render(<ActivityTimeline activities={fullPage} leadId="lead-1" />);
    const button = screen.getByRole("button", { name: /load more/i });
    await user.click(button);

    await waitFor(() => expect(screen.getByText("An older event")).toBeInTheDocument());
    expect(loadMoreActivities).toHaveBeenCalledWith({ leadId: "lead-1", contactId: undefined, cursor: "a29" });
    expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument();
  });

  it("leaves the currently-shown activities untouched if loading more fails", async () => {
    const user = userEvent.setup();
    const fullPage = Array.from({ length: 30 }, (_, i) => activity({ id: `a${i}`, description: `Event ${i}`, createdAt: new Date(2026, 0, 1, 0, 0, i) }));
    loadMoreActivities.mockRejectedValueOnce(new Error("network error"));

    render(<ActivityTimeline activities={fullPage} contactId="contact-1" />);
    await user.click(screen.getByRole("button", { name: /load more/i }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /load more/i })).not.toBeInTheDocument());
    // All 30 originally-rendered events are still there — nothing was lost.
    expect(screen.getByText("Event 0")).toBeInTheDocument();
    expect(screen.getByText("Event 29")).toBeInTheDocument();
  });
});
