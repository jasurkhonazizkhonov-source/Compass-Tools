// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CustomerInfoCard } = await import("../customer-info-card");

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
