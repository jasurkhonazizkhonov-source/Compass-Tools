// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { SidebarNav } = await import("../sidebar");

const links = () => screen.getAllByRole("link").map((a) => ({ text: a.textContent?.trim(), href: a.getAttribute("href") }));

describe("sidebar: Database Backup", () => {
  it("an Administrator sees exactly ONE entry for it, pointing at /database-backup, after System Health", () => {
    render(<SidebarNav role="ADMIN" />);
    const all = links();
    const entries = all.filter((l) => l.text === "Database Backup");
    expect(entries).toEqual([{ text: "Database Backup", href: "/database-backup" }]);
    expect(all.findIndex((l) => l.text === "Database Backup")).toBe(all.findIndex((l) => l.text === "System Health") + 1);
  });

  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const)("a %s never sees it", (role) => {
    render(<SidebarNav role={role} />);
    expect(links().map((l) => l.text)).not.toContain("Database Backup");
    expect(links().map((l) => l.href)).not.toContain("/database-backup");
  });

  it("a signed-out render shows nothing of it", () => {
    render(<SidebarNav />);
    expect(screen.queryByText("Database Backup")).toBeNull();
  });
});
