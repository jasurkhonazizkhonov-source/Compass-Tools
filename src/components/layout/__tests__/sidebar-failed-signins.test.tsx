// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { SidebarNav } = await import("../sidebar");

const labels = () => screen.getAllByRole("link").map((a) => a.textContent?.trim());

describe("sidebar: Failed Sign-ins", () => {
  it("an Administrator sees it, directly between Subscriptions and Users", () => {
    render(<SidebarNav role="ADMIN" />);
    const l = labels();
    const i = l.indexOf("Failed Sign-ins");
    expect(i).toBeGreaterThan(-1);
    expect(l[i - 1]).toBe("Subscriptions");
    expect(l[i + 1]).toBe("Users");
  });

  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const)("a %s never sees it", (role) => {
    render(<SidebarNav role={role} />);
    expect(labels()).not.toContain("Failed Sign-ins");
  });

  it("a signed-out render shows nothing of it either", () => {
    render(<SidebarNav />);
    expect(screen.queryByText("Failed Sign-ins")).toBeNull();
  });
});
