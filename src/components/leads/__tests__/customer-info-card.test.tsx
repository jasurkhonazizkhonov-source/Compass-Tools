// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

vi.mock("@/server/actions/contacts", () => ({
  updatePrimaryPhoneNumber: vi.fn(),
  updatePrimaryEmailAddress: vi.fn(),
  updateContactField: vi.fn(),
  addContactPhone: vi.fn(),
  deleteContactPhone: vi.fn(),
  setPrimaryPhone: vi.fn(),
  addContactEmail: vi.fn(),
  deleteContactEmail: vi.fn(),
  setPrimaryEmail: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const { CustomerInfoCard: Card } = await import("../customer-info-card");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const CustomerInfoCard = (props: React.ComponentProps<typeof Card>) => (
  <TooltipProvider>
    <Card {...props} />
  </TooltipProvider>
);

const props = { firstName: "Ada", lastName: "Lovelace", phones: [], emails: [] };

describe("'View full profile' opens the contact in a new tab", () => {
  it("is a link to that contact's profile with target=_blank and rel=noopener noreferrer", () => {
    render(<CustomerInfoCard contactId="contact-123" {...props} leadId="lead-1" />);
    const link = screen.getByRole("link", { name: /view full profile/i });
    expect(link).toHaveAttribute("href", "/contacts/contact-123");
    expect(link).toHaveAttribute("target", "_blank");
    const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
    expect(link).toHaveAccessibleName(/opens in a new tab/i);
  });

  it("carries the right record: two different contacts give two different destinations", () => {
    const { unmount } = render(<CustomerInfoCard contactId="aaa-111" {...props} />);
    expect(screen.getByRole("link", { name: /view full profile/i })).toHaveAttribute("href", "/contacts/aaa-111");
    unmount();
    render(<CustomerInfoCard contactId="bbb-222" {...props} />);
    expect(screen.getByRole("link", { name: /view full profile/i })).toHaveAttribute("href", "/contacts/bbb-222");
  });

  it("clicking it does not navigate or alter the current page (the browser opens the new tab; this page stays as it is)", async () => {
    const user = userEvent.setup();
    const before = window.location.href;
    render(<CustomerInfoCard contactId="contact-123" {...props} />);
    const link = screen.getByRole("link", { name: /view full profile/i });
    const defaultPrevented = vi.fn();
    link.addEventListener("click", (e) => defaultPrevented(e.defaultPrevented));
    await user.click(link);
    expect(defaultPrevented).toHaveBeenCalledWith(false); // not intercepted: normal link behaviour, so a new tab opens
    expect(window.location.href).toBe(before);
    expect(screen.getByText("Customer")).toBeInTheDocument(); // the page is still rendered
  });

  it("is still hidden on the contact's own page (showProfileLink=false) and no other link was added", () => {
    render(<CustomerInfoCard contactId="contact-123" {...props} showProfileLink={false} />);
    expect(screen.queryByRole("link", { name: /view full profile/i })).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

describe("phone / email controls follow the per-user permission", () => {
  const data = {
    firstName: "Ada",
    lastName: "Lovelace",
    phones: [{ id: "p1", number: "+14155709267", type: "MOBILE", isPrimary: true }, { id: "p2", number: "+14155709268", type: "HOME", isPrimary: false }],
    emails: [{ id: "e1", email: "ada@example.com", type: "PERSONAL", isPrimary: true }, { id: "e2", email: "ada2@example.com", type: "WORK", isPrimary: false }],
  };

  it("allowed (the default): edit, add, make-primary and delete controls are all offered", () => {
    render(<CustomerInfoCard contactId="c1" {...data} />);
    for (const name of [/edit primary phone/i, /edit primary email/i, /add phone number/i, /add email address/i, /make primary phone number/i, /make primary email/i, /delete phone number/i, /delete email/i]) {
      expect(screen.getAllByRole("button", { name }).length, String(name)).toBeGreaterThan(0);
    }
    expect(screen.queryByText(/do not have permission to change phone numbers/i)).toBeNull();
  });

  it("not allowed: values stay visible but no phone/email control is offered, and the name fields remain editable", () => {
    render(<CustomerInfoCard contactId="c1" {...data} canEditContactDetails={false} />);
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("ada2@example.com")).toBeInTheDocument();
    for (const name of [/edit primary phone/i, /edit primary email/i, /add phone number/i, /add email address/i, /make primary phone number/i, /make primary email/i, /delete phone number/i, /delete email/i]) {
      expect(screen.queryAllByRole("button", { name }), String(name)).toHaveLength(0);
    }
    expect(screen.getByRole("button", { name: /edit first name/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit last name/i })).toBeInTheDocument();
    expect(screen.getByText(/do not have permission to change phone numbers or email addresses/i)).toBeInTheDocument();
  });
});

describe("a masked email has no edit controls; a revealed one has them (for a user who may edit)", () => {
  const phones = [{ id: "p1", number: "+14155709267", type: "MOBILE", isPrimary: true }, { id: "p2", number: "+14155709268", type: "HOME", isPrimary: false }];
  const MASKED_EMAILS = [{ id: "e1", email: "a*******a@example.com", type: "PERSONAL", isPrimary: true }, { id: "e2", email: "a***2@example.com", type: "WORK", isPrimary: false }];
  const FULL_EMAILS = [{ id: "e1", email: "ada@example.com", type: "PERSONAL", isPrimary: true }, { id: "e2", email: "ada2@example.com", type: "WORK", isPrimary: false }];
  const EMAIL_CONTROLS = [/edit primary email/i, /make primary email/i, /delete email/i];
  const PHONE_CONTROLS = [/edit primary phone/i, /add phone number/i, /make primary phone number/i, /delete phone number/i];
  const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

  it("MASKED: no email pencil, no make-primary, no delete - and the Reveal button is still there; the phone controls are untouched", () => {
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={MASKED_EMAILS} canEditContactDetails emailPrivacy={{ masked: true, used: 1, limit: 5, resetsAt: FUTURE }} />);
    for (const name of EMAIL_CONTROLS) expect(screen.queryAllByRole("button", { name }), String(name)).toHaveLength(0);
    expect(screen.getByRole("button", { name: /reveal customer email/i })).toBeInTheDocument();
    for (const name of PHONE_CONTROLS) expect(screen.getAllByRole("button", { name }).length, String(name)).toBeGreaterThan(0);
    expect(screen.getByText(/reveal the email address to edit it/i)).toBeInTheDocument();
  });

  it("MASKED: the masked value is shown, and an editor can never be opened on it", async () => {
    const user = userEvent.setup();
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={MASKED_EMAILS} canEditContactDetails emailPrivacy={{ masked: true, used: 0, limit: 5, resetsAt: FUTURE }} />);
    expect(screen.getAllByText("a*******a@example.com").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: /email/i })).toBeNull();
    expect(screen.queryByDisplayValue(/@/)).toBeNull();
    await user.click(screen.getAllByText("a*******a@example.com")[0]);
    expect(screen.queryByDisplayValue(/@/)).toBeNull();
  });

  it("MASKED, adding a NEW address stays possible (it does not touch the masked one)", () => {
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={MASKED_EMAILS} canEditContactDetails emailPrivacy={{ masked: true, used: 0, limit: 5, resetsAt: FUTURE }} />);
    expect(screen.getByRole("button", { name: /add email address/i })).toBeInTheDocument();
  });

  it("REVEALED + permission: the email pencil, make-primary and delete appear, and the editor opens on the real address", async () => {
    const user = userEvent.setup();
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={FULL_EMAILS} canEditContactDetails emailPrivacy={{ masked: false, used: 1, limit: 5, resetsAt: FUTURE }} />);
    for (const name of EMAIL_CONTROLS) expect(screen.getAllByRole("button", { name }).length, String(name)).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /reveal customer email/i })).toBeNull(); // already revealed: only the indicator
    expect(screen.queryByText(/reveal the email address to edit it/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /edit primary email/i }));
    expect(screen.getByDisplayValue("ada@example.com")).toBeInTheDocument();
  });

  it("REVEALED but WITHOUT the permission: still no email pencil (visibility never grants editing)", () => {
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={FULL_EMAILS} canEditContactDetails={false} emailPrivacy={{ masked: false, used: 1, limit: 5, resetsAt: FUTURE }} />);
    for (const name of EMAIL_CONTROLS) expect(screen.queryAllByRole("button", { name }), String(name)).toHaveLength(0);
    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
  });

  it("an Administrator / unlimited viewer (no privacy object) always has the controls", () => {
    render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={FULL_EMAILS} canEditContactDetails />);
    for (const name of EMAIL_CONTROLS) expect(screen.getAllByRole("button", { name }).length, String(name)).toBeGreaterThan(0);
  });

  describe("a STALE tab: when the reveal period ends while the page is open", () => {
    afterEach(() => vi.useRealTimers());

    it("the addresses are masked at once, the pencil disappears, and the server is asked for a fresh render - without any user action", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-21T21:14:50Z")); // 13:14:50 PST
      refresh.mockClear();
      render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={FULL_EMAILS} canEditContactDetails emailPrivacy={{ masked: false, used: 1, limit: 5, resetsAt: "2026-11-21T21:15:00.000Z" }} />);
      expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /edit primary email/i }).length).toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000); // past 13:15:00
      });

      expect(screen.queryByText("ada@example.com")).toBeNull();
      expect(screen.queryByText("ada2@example.com")).toBeNull();
      expect(screen.getAllByText("a*a@example.com").length + screen.getAllByText("a**2@example.com").length).toBeGreaterThan(0);
      for (const name of EMAIL_CONTROLS) expect(screen.queryAllByRole("button", { name }), String(name)).toHaveLength(0);
      expect(screen.getByRole("button", { name: /reveal customer email/i })).toBeInTheDocument();
      expect(refresh).toHaveBeenCalled();
    });

    it("a tab that was asleep: coming back to it after the reset re-masks it immediately", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-21T21:00:00Z"));
      refresh.mockClear();
      render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={FULL_EMAILS} canEditContactDetails emailPrivacy={{ masked: false, used: 1, limit: 5, resetsAt: "2026-11-21T21:15:00.000Z" }} />);
      vi.setSystemTime(new Date("2026-11-21T23:00:00Z")); // the laptop slept through the reset; timers never ran
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(screen.queryByText("ada@example.com")).toBeNull();
      expect(screen.queryAllByRole("button", { name: /edit primary email/i })).toHaveLength(0);
      expect(refresh).toHaveBeenCalled();
    });

    it("nothing happens to a viewer who was never revealed (masked from the start): no timer-driven refresh", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-21T21:14:50Z"));
      refresh.mockClear();
      render(<CustomerInfoCard contactId="c1" firstName="Ada" lastName="L" phones={phones} emails={MASKED_EMAILS} canEditContactDetails emailPrivacy={{ masked: true, used: 0, limit: 5, resetsAt: "2026-11-21T21:15:00.000Z" }} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
