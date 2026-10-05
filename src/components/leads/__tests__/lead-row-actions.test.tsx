// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { LeadRowActions } from "../lead-row-actions";
import { canOfferLeadReassign } from "@/lib/permissions";
import { TooltipProvider } from "@/components/ui/tooltip";

// The Leads list offers the same three actions as the lead page — Call,
// Email, Reassign — through one component, and shows Reassign by the very
// rule the lead page uses (canOfferLeadReassign). The server action behind
// the button is the one reassignLead(); these tests cover what the user can
// SEE and invoke from the list.

const { reassignLead, deleteLead } = vi.hoisted(() => ({ reassignLead: vi.fn(async () => ({})), deleteLead: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/leads", () => ({ reassignLead, deleteLead, sendLeadEmail: vi.fn(), sendContactEmail: vi.fn() }));
vi.mock("@/server/actions/contacts", () => ({ sendContactEmail: vi.fn() }));

const AGENTS = [
  { id: "agent-a", fullName: "Agent A" },
  { id: "agent-b", fullName: "Agent B" },
];

function renderActions(over: Partial<React.ComponentProps<typeof LeadRowActions>> = {}) {
  return render(
    <TooltipProvider>
    <LeadRowActions
      leadId="lead-1"
      customerName="Dark Master"
      phone="+14155550123"
      email="dark@client.example"
      assignedAgentId="agent-a"
      assignedAgentName="Agent A"
      agents={AGENTS}
      viewerRole="ADMIN"
      {...over}
    />
    </TooltipProvider>
  );
}

describe("Leads list actions — Call, Email and Reassign", () => {
  it("an Admin sees all three on an owned lead", () => {
    renderActions({ viewerRole: "ADMIN" });
    expect(screen.getByRole("link", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign Lead" })).toBeInTheDocument();
  });

  it("a Manager sees Reassign too", () => {
    renderActions({ viewerRole: "MANAGER" });
    expect(screen.getByRole("button", { name: "Reassign Lead" })).toBeInTheDocument();
  });

  it.each(["TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const)("a %s does NOT see Reassign on an owned lead (but still sees Call and Email)", (role) => {
    renderActions({ viewerRole: role });
    expect(screen.queryByRole("button", { name: /Reassign/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
  });

  it("an unassigned lead offers 'Assign Lead' to any role — claiming an unowned lead is open — and an owned lead does not", () => {
    renderActions({ viewerRole: "TRAVEL_AGENT", assignedAgentId: null, assignedAgentName: null });
    expect(screen.getByRole("button", { name: "Assign Lead" })).toBeInTheDocument();
  });

  it("is driven by the same shared rule as the lead page", () => {
    for (const role of ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT", undefined] as const) {
      for (const owner of ["agent-a", null]) {
        const { unmount } = renderActions({ viewerRole: role, assignedAgentId: owner, assignedAgentName: owner ? "Agent A" : null });
        const shown = screen.queryByRole("button", { name: /^(Reassign|Assign) Lead$/ }) !== null;
        expect(shown, `${role}/${owner}`).toBe(canOfferLeadReassign(role, owner));
        unmount();
      }
    }
  });

  it("clicking Reassign opens the SAME reassignment dialog (current owner shown, current owner excluded) and submits through reassignLead()", async () => {
    const user = userEvent.setup();
    renderActions({ viewerRole: "ADMIN" });
    await user.click(screen.getByRole("button", { name: "Reassign Lead" }));
    expect(screen.getByRole("dialog", { name: "Reassign Lead" })).toBeInTheDocument();
    expect(screen.getByText("Current owner:")).toBeInTheDocument();
    await user.click(screen.getByLabelText("New Owner"));
    expect(screen.queryByRole("option", { name: "Agent A" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Agent B" }));
    await user.click(screen.getByRole("button", { name: "Reassign" }));
    expect(reassignLead).toHaveBeenCalledWith("lead-1", "agent-b", undefined);
  });

  it("the phone-card variant shows a visible caption under each action (touch screens have no tooltips)", () => {
    renderActions({ variant: "labeled", viewerRole: "ADMIN" });
    expect(screen.getByText("Call")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("Reassign")).toBeInTheDocument();
  });

  it("omits Call/Email when the lead has no phone/email instead of rendering dead buttons", () => {
    renderActions({ phone: null, email: null, viewerRole: "ADMIN" });
    expect(screen.queryByRole("link", { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign Lead" })).toBeInTheDocument();
  });
});

describe("both surfaces use the one rule (source-level)", () => {
  it("the Leads list (via LeadRowActions) and the lead detail page both gate Reassign with canOfferLeadReassign — no second copy of the role rule", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf-8");
    expect(read("src", "components", "leads", "lead-row-actions.tsx")).toContain("canOfferLeadReassign(viewerRole, assignedAgentId)");
    expect(read("src", "app", "(crm)", "leads", "page.tsx")).toContain("LeadRowActions");
    expect(read("src", "app", "(crm)", "leads", "[id]", "page.tsx")).toContain("canOfferLeadReassign(currentAccount?.role, lead.assignedAgentId)");
    // and both open the same dialog, which calls the same server action
    expect(read("src", "components", "leads", "lead-row-actions.tsx")).toContain("ReassignLeadDialog");
    expect(read("src", "app", "(crm)", "leads", "[id]", "page.tsx")).toContain("ReassignLeadDialog");
  });
});

describe("Leads list — Delete (Admin and Manager only)", () => {
  it.each(["ADMIN", "MANAGER"] as const)("a %s sees Delete next to Call, Email and Reassign", (role) => {
    renderActions({ viewerRole: role });
    expect(screen.getByRole("button", { name: "Delete Lead" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign Lead" })).toBeInTheDocument();
  });

  it.each(["TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const)("a %s does NOT see Delete — even on an unassigned lead they may claim", (role) => {
    renderActions({ viewerRole: role, assignedAgentId: null, assignedAgentName: null });
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Lead" })).not.toBeInTheDocument();
  });

  it("is driven by the same rule as the server action (canDeleteLead) for every role", async () => {
    const { canDeleteLead } = await import("@/lib/permissions");
    for (const role of ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT", undefined] as const) {
      const { unmount } = renderActions({ viewerRole: role });
      expect(screen.queryByRole("button", { name: "Delete Lead" }) !== null, String(role)).toBe(canDeleteLead(role));
      unmount();
    }
  });

  it("asks for confirmation first — cancelling deletes nothing; confirming calls the existing deleteLead() with this lead's id", async () => {
    const user = userEvent.setup();
    renderActions({ viewerRole: "ADMIN" });

    await user.click(screen.getByRole("button", { name: "Delete Lead" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this lead?" });
    expect(dialog).toHaveTextContent("also delete any quotes and bookings created under it");
    expect(deleteLead).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteLead).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete Lead" }));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    expect(deleteLead).toHaveBeenCalledTimes(1);
  });

  it("the phone-card variant captions it", () => {
    renderActions({ variant: "labeled", viewerRole: "MANAGER" });
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });
});
