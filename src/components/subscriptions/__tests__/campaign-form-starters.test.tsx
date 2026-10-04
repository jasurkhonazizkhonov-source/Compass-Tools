// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/test/rtl-setup";
import { CAMPAIGN_STARTERS, firstUnfilledPlaceholder, hasUnfilledPlaceholders } from "@/lib/campaign-starters";

const sendMock = vi.fn();
const toastError = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));
vi.mock("@/server/actions/marketing-campaigns", () => ({
  createMarketingCampaign: vi.fn(),
  updateMarketingCampaign: vi.fn(),
  deleteMarketingCampaign: vi.fn(),
  sendMarketingCampaign: (...a: unknown[]) => sendMock(...a),
  sendTestMarketingCampaign: vi.fn(),
}));
// TipTap needs a real layout engine; the form only needs to hand it content and read changes back.
vi.mock("@/components/subscriptions/rich-text-editor", () => ({
  RichTextEditor: ({ value, onChange }: { value: string; onChange: (h: string) => void }) => (
    <textarea aria-label="Campaign content" defaultValue={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { CampaignForm } from "../campaign-form";

beforeEach(() => {
  sendMock.mockReset();
  toastError.mockReset();
});

describe("campaign starters (system-supplied default copy)", () => {
  it("every starter is concise, free of promotional clichés and exclamation marks, and marks what the author must complete", () => {
    expect(CAMPAIGN_STARTERS.length).toBeGreaterThanOrEqual(3);
    const banned = /thrilled|unlock|don'?t miss|game[- ]?chang|revolution|amazing|incredible|exclusive offer|limited time|act now|hurry|!/i;
    for (const s of CAMPAIGN_STARTERS) {
      const text = `${s.subject} ${s.html}`;
      expect(text, s.id).not.toMatch(banned);
      expect(hasUnfilledPlaceholders(s.subject, s.html), s.id).toBe(true);
      expect(s.html.replace(/<[^>]+>/g, " ").split(/\s+/).length, s.id).toBeLessThan(120);
      expect(s.html, s.id).not.toMatch(/Business Flights|Compass Tools/i);
    }
  });

  it("never invents a price, date or contact: those are placeholders, not numbers", () => {
    for (const s of CAMPAIGN_STARTERS) {
      expect(s.html, s.id).not.toMatch(/\$\s?\d|\b\d{3}[ -]\d{3}[ -]\d{4}\b|@\w+\.\w+/);
    }
  });

  it("placeholder helpers", () => {
    expect(hasUnfilledPlaceholders("Plain text", "<p>[URGENT] note</p>")).toBe(false);
    expect(hasUnfilledPlaceholders("Subject", "<p>Fare to [[Destination]]</p>")).toBe(true);
    expect(firstUnfilledPlaceholder("ok", "<p>[[Phone number]] and [[Fare]]</p>")).toBe("Phone number");
    expect(firstUnfilledPlaceholder("ok", "fine")).toBeNull();
  });
});

describe("CampaignForm — starters", () => {
  it("offers the templates on a new, empty campaign; choosing one fills subject and content and hides the picker", async () => {
    render(<CampaignForm recipientCount={3} />);
    expect(screen.getByTestId("campaign-starters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CAMPAIGN_STARTERS[0].label }));
    await waitFor(() => expect(screen.queryByTestId("campaign-starters")).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Business class to Lisbon/i)).toHaveValue(CAMPAIGN_STARTERS[0].subject);
    expect((screen.getByLabelText("Campaign content") as HTMLTextAreaElement).value).toBe(CAMPAIGN_STARTERS[0].html);
  });

  it("does not offer templates once there is content of the author's own, for a saved campaign, or read-only", () => {
    const { unmount } = render(<CampaignForm recipientCount={3} initialHtml="<p>My own words</p>" />);
    expect(screen.queryByTestId("campaign-starters")).not.toBeInTheDocument();
    unmount();
    const saved = render(<CampaignForm recipientCount={3} campaignId="c1" />);
    expect(screen.queryByTestId("campaign-starters")).not.toBeInTheDocument();
    saved.unmount();
    render(<CampaignForm recipientCount={3} readOnly />);
    expect(screen.queryByTestId("campaign-starters")).not.toBeInTheDocument();
  });

  it("choosing a starter keeps a subject the author already typed", async () => {
    render(<CampaignForm recipientCount={3} />);
    fireEvent.change(screen.getByPlaceholderText(/Business class to Lisbon/i), { target: { value: "My subject" } });
    fireEvent.click(screen.getByRole("button", { name: CAMPAIGN_STARTERS[1].label }));
    await waitFor(() => expect(screen.queryByTestId("campaign-starters")).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Business class to Lisbon/i)).toHaveValue("My subject");
  });

  it("sending is refused client-side while a [[placeholder]] remains — the server action is never called", async () => {
    render(<CampaignForm campaignId="c1" initialSubject="Fares to [[Destination]]" initialHtml="<p>Hello</p>" recipientCount={3} />);
    fireEvent.click(screen.getByRole("button", { name: /^Send to 3 Subscribers$/ }));
    // confirm dialog
    const confirm = await screen.findAllByRole("button", { name: /Send to 3 Subscribers/ });
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("[[Destination]]")));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("explains that a paragraph holding only a short link is sent as a button", () => {
    render(<CampaignForm recipientCount={3} initialHtml="<p>x</p>" />);
    expect(screen.getByText(/sent as a button/i)).toBeInTheDocument();
  });
});
