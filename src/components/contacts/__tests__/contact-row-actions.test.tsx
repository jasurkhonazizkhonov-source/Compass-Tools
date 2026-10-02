// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ContactRowActions } from "../contact-row-actions";
import { TooltipProvider } from "@/components/ui/tooltip";
import { canDeleteContact, canReassignLeads } from "@/lib/permissions";

// The Contacts list offers Call, Email, Reassign and Delete through the
// existing controls. Reassign and Delete show for exactly the roles the server
// actions allow (Admin and Manager); the server re-checks both, plus — for a
// Manager — that the contact is inside their own team.

const { reassignContact, deleteContact } = vi.hoisted(() => ({ reassignContact: vi.fn(async () => ({})), deleteContact: vi.fn(async () => undefined) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/server/actions/contacts", () => ({ reassignContact, deleteContact, sendContactEmail: vi.fn() }));
vi.mock("@/server/actions/leads", () => ({ sendLeadEmail: vi.fn(), reassignLead: vi.fn() }));

const AGENTS = [
  { id: "agent-a", fullName: "Agent A" },
  { id: "agent-b", fullName: "Agent B" },
];

function renderActions(over: Partial<React.ComponentProps<typeof ContactRowActions>> = {}) {
  return render(
    <TooltipProvider>
      <ContactRowActions
        contactId="contact-1"
        contactName="Dark Master"
        phone="+14155550123"
        email="dark@client.example"
        ownerId="agent-a"
        ownerName="Agent A"
        leads={[{ id: "lead-1", route: "JFK → LGW", ownerName: "Agent A" }]}
        agents={AGENTS}
        viewerRole="ADMIN"
        {...over}
      />
    </TooltipProvider>
  );
}

describe("Contacts list actions", () => {
  it.each(["ADMIN", "MANAGER"] as const)("a %s sees Call, Email, Reassign and Delete", (role) => {
    renderActions({ viewerRole: role });
    expect(screen.getByRole("link", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign Contact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Contact" })).toBeInTheDocument();
  });

  it.each(["TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const)("a %s sees neither Reassign nor Delete (Call and Email remain)", (role) => {
    renderActions({ viewerRole: role });
    expect(screen.queryByRole("button", { name: /Reassign/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Email/ })).toBeInTheDocument();
  });

  it("follows the server-side permission functions exactly", () => {
    for (const role of ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT", undefined] as const) {
      const { unmount } = renderActions({ viewerRole: role });
      expect(screen.queryByRole("button", { name: "Reassign Contact" }) !== null, `reassign ${role}`).toBe(canReassignLeads(role));
      expect(screen.queryByRole("button", { name: "Delete Contact" }) !== null, `delete ${role}`).toBe(canDeleteContact(role));
      unmount();
    }
  });

  it("an unowned contact offers 'Assign Contact'", () => {
    renderActions({ ownerId: null, ownerName: null });
    expect(screen.getByRole("button", { name: "Assign Contact" })).toBeInTheDocument();
  });

  it("Delete asks for confirmation (cancel = nothing happens) and then calls the existing deleteContact() with this contact's id", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    renderActions({ viewerRole: "MANAGER" });
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Delete Contact" }));
    expect(deleteContact).not.toHaveBeenCalled();
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Delete Contact" }));
    expect(deleteContact).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("Reassign opens the existing contact dialog", async () => {
    const user = userEvent.setup();
    renderActions({ viewerRole: "ADMIN" });
    await user.click(screen.getByRole("button", { name: "Reassign Contact" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the phone-card variant captions every action", () => {
    renderActions({ variant: "labeled", viewerRole: "ADMIN" });
    for (const text of ["Call", "Email", "Reassign", "Delete"]) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("omits Call/Email when the contact has no phone/email", () => {
    renderActions({ phone: null, email: null });
    expect(screen.queryByRole("link", { name: /Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Email/ })).not.toBeInTheDocument();
  });
});
