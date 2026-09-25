// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import "@/test/rtl-setup";

vi.mock("@/lib/prisma", () => ({ prisma: {}, getPrismaPoolStats: () => null, getPoolSettings: () => ({ max: 2 }) }));

import { SystemHealthView } from "../system-health-view";
import type { HealthCheckResult } from "@/server/system/health-checks";
import type { HealthEventView } from "@/server/system/health-events";

const check = (over: Partial<HealthCheckResult> & Pick<HealthCheckResult, "id" | "state">): HealthCheckResult => ({
  category: "test",
  title: `Title ${over.id}`,
  summary: `Summary ${over.id}`,
  ...over,
});

const event = (over: Partial<HealthEventView> = {}): HealthEventView => ({
  id: "e1",
  type: "EMAIL_SEND_FAILED",
  severity: "WARNING",
  category: "email",
  message: "An outbound email could not be sent (NOT_CONNECTED).",
  firstSeenAt: new Date("2026-09-25T10:00:00Z"),
  lastSeenAt: new Date("2026-09-25T11:00:00Z"),
  occurrenceCount: 7,
  resolvedAt: null,
  ...over,
});

describe("SystemHealthView", () => {
  it("groups checks into Critical / Warning / Informational by state, with UNKNOWN under Warning", () => {
    render(
      <SystemHealthView
        results={[check({ id: "a", state: "CRITICAL" }), check({ id: "b", state: "WARNING" }), check({ id: "c", state: "UNKNOWN" }), check({ id: "d", state: "HEALTHY" })]}
        open={[]}
        recentlyResolved={[]}
        checkedAt="2026-09-25T12:00:00Z"
      />
    );
    const critical = screen.getByRole("region", { name: /critical/i });
    const warning = screen.getByRole("region", { name: /warning/i });
    const info = screen.getByRole("region", { name: /informational/i });
    expect(within(critical).getByText("Title a")).toBeInTheDocument();
    expect(within(warning).getByText("Title b")).toBeInTheDocument();
    expect(within(warning).getByText("Title c")).toBeInTheDocument();
    expect(within(info).getByText("Title d")).toBeInTheDocument();
    expect(within(critical).queryByText("Title d")).not.toBeInTheDocument();
  });

  it("overall status is the worst state", () => {
    render(<SystemHealthView results={[check({ id: "a", state: "WARNING" }), check({ id: "b", state: "CRITICAL" })]} open={[]} recentlyResolved={[]} checkedAt="2026-09-25T12:00:00Z" />);
    expect(screen.getByTestId("overall-state")).toHaveTextContent("Critical");
  });

  it("an all-healthy system shows Healthy and no Critical/Warning sections", () => {
    render(<SystemHealthView results={[check({ id: "a", state: "HEALTHY" })]} open={[]} recentlyResolved={[]} checkedAt="2026-09-25T12:00:00Z" />);
    expect(screen.getByTestId("overall-state")).toHaveTextContent("Healthy");
    expect(screen.queryByRole("region", { name: /critical/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^warning/i })).not.toBeInTheDocument();
  });

  it("shows the facts and the 'what to do' guidance, only when present", () => {
    render(
      <SystemHealthView
        results={[check({ id: "a", state: "WARNING", facts: [{ label: "GOOGLE_CLIENT_SECRET", value: "Missing" }], action: "Set the secret." }), check({ id: "b", state: "HEALTHY" })]}
        open={[]}
        recentlyResolved={[]}
        checkedAt="2026-09-25T12:00:00Z"
      />
    );
    const a = screen.getByTestId("check-a");
    expect(within(a).getByText("GOOGLE_CLIENT_SECRET")).toBeInTheDocument();
    expect(within(a).getByText("Missing")).toBeInTheDocument();
    expect(within(a).getByText(/Set the secret\./)).toBeInTheDocument();
    expect(within(screen.getByTestId("check-b")).queryByText(/What to do/)).not.toBeInTheDocument();
  });

  it("lists open incidents with their occurrence count, and recently resolved ones with the resolution time", () => {
    render(
      <SystemHealthView
        results={[check({ id: "a", state: "HEALTHY" })]}
        open={[event()]}
        recentlyResolved={[event({ id: "e2", message: "Old problem", occurrenceCount: 1, resolvedAt: new Date("2026-09-24T09:00:00Z") })]}
        checkedAt="2026-09-25T12:00:00Z"
      />
    );
    expect(screen.getByText(/could not be sent/)).toBeInTheDocument();
    expect(screen.getByText("×7")).toBeInTheDocument();
    expect(screen.getByText("Old problem")).toBeInTheDocument();
    expect(screen.getByText(/Resolved Sep 2[34]/)).toBeInTheDocument();
  });

  it("empty incident lists say so", () => {
    render(<SystemHealthView results={[check({ id: "a", state: "HEALTHY" })]} open={[]} recentlyResolved={[]} checkedAt="2026-09-25T12:00:00Z" />);
    expect(screen.getByText("No open incidents.")).toBeInTheDocument();
    expect(screen.getByText("Nothing resolved recently.")).toBeInTheDocument();
  });

  it("offers a Re-run checks link back to the page", () => {
    render(<SystemHealthView results={[check({ id: "a", state: "HEALTHY" })]} open={[]} recentlyResolved={[]} checkedAt="2026-09-25T12:00:00Z" />);
    expect(screen.getByRole("link", { name: /re-run checks/i })).toHaveAttribute("href", "/system-health");
  });
});
