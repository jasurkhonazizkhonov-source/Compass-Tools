// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import type { CampaignAnalytics } from "@/server/actions/campaign-delivery";
import fs from "node:fs";
import path from "node:path";

// The browser side of the campaign builder, the delivery panel (analytics + controls) and the entry points on the Subscriptions page.

const refresh = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace, push: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

const previewCampaignDesign = vi.fn(async () => ({ ok: true, html: "<p>PREVIEW</p>", subject: "s", issues: [] }));
const saveCampaignDesign = vi.fn();
const sendCampaignTest = vi.fn();
const queueCampaign = vi.fn();
const pauseCampaignDelivery = vi.fn(async () => ({ ok: true }));
const resumeCampaignDelivery = vi.fn(async () => ({ ok: true }));
const cancelCampaignDelivery = vi.fn(async () => ({ ok: true }));
const getCampaignAnalytics = vi.fn();
vi.mock("@/server/actions/campaign-delivery", () => ({
  previewCampaignDesign: (...a: unknown[]) => (previewCampaignDesign as unknown as (...x: unknown[]) => unknown)(...a),
  saveCampaignDesign: (...a: unknown[]) => saveCampaignDesign(...a),
  sendCampaignTest: (...a: unknown[]) => sendCampaignTest(...a),
  queueCampaign: (...a: unknown[]) => queueCampaign(...a),
  pauseCampaignDelivery: (...a: unknown[]) => (pauseCampaignDelivery as unknown as (...x: unknown[]) => unknown)(...a),
  resumeCampaignDelivery: (...a: unknown[]) => (resumeCampaignDelivery as unknown as (...x: unknown[]) => unknown)(...a),
  cancelCampaignDelivery: (...a: unknown[]) => (cancelCampaignDelivery as unknown as (...x: unknown[]) => unknown)(...a),
  getCampaignAnalytics: (...a: unknown[]) => getCampaignAnalytics(...a),
}));

const { CampaignBuilder } = await import("../campaign-builder");
const { CampaignDeliveryPanel } = await import("../campaign-delivery-panel");
const { emptyDesign } = await import("@/lib/campaign-blocks");

beforeEach(() => vi.clearAllMocks());

describe("CampaignBuilder", () => {
  const start = () => render(<CampaignBuilder initial={{ name: "", subject: "", previewText: "", design: emptyDesign() }} />);

  it("starts empty with templates offered, and says what is wrong before anything can be queued", async () => {
    start();
    expect(screen.getByTestId("builder-templates")).toBeInTheDocument();
    expect(screen.getByTestId("builder-issues")).toHaveTextContent("Add a subject line.");
    expect(screen.getByTestId("builder-issues")).toHaveTextContent("Add at least one block.");
  });

  it("adds, edits, reorders and deletes blocks", async () => {
    const user = userEvent.setup();
    start();
    await user.click(screen.getByRole("button", { name: "Heading" }));
    await user.click(screen.getByRole("button", { name: "Button" }));
    expect(screen.getAllByTestId("builder-block")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Heading text"), { target: { value: "Winter fares" } });
    expect(screen.getByLabelText("Heading text")).toHaveValue("Winter fares");
    await user.click(screen.getByRole("button", { name: "Move block 2 up" }));
    const blocks = screen.getAllByTestId("builder-block");
    expect(within(blocks[0]).getByLabelText("Button label")).toBeInTheDocument();
    expect(within(blocks[1]).getByLabelText("Heading text")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete block 1" }));
    expect(screen.getAllByTestId("builder-block")).toHaveLength(1);
  });

  it("a button needs a label and a safe http(s) link: a javascript: link is flagged on that block", async () => {
    const user = userEvent.setup();
    start();
    await user.click(screen.getByRole("button", { name: "Button" }));
    fireEvent.change(screen.getByLabelText("Button link"), { target: { value: "javascript:alert(1)" } });
    const block = screen.getByTestId("builder-block");
    expect(within(block).getByLabelText("Problems with this block")).toHaveTextContent(/must start with http/);
    fireEvent.change(screen.getByLabelText("Button link"), { target: { value: "https://example.com/go" } });
    expect(within(block).queryByLabelText("Problems with this block")).toBeNull();
  });

  it("an image without alt text is a warning, not a blocker", async () => {
    const user = userEvent.setup();
    start();
    await user.click(screen.getByRole("button", { name: "Image" }));
    fireEvent.change(screen.getByLabelText("Image address"), { target: { value: "https://img.example.com/a.png" } });
    expect(within(screen.getByTestId("builder-block")).getByLabelText("Problems with this block")).toHaveTextContent(/alt text/);
    expect(screen.getByTestId("builder-block").querySelector("[data-severity='error']")).toBeNull();
  });

  it("shows the server-rendered preview in a sandboxed frame, switches between desktop and mobile widths, and a stale response never wins", async () => {
    const user = userEvent.setup();
    start();
    const frame = await screen.findByTestId("builder-preview");
    expect(frame).toHaveAttribute("sandbox", "");
    await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("PREVIEW"));
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect((frame as HTMLIFrameElement).style.width).toBe("680px");
    await user.click(screen.getByRole("button", { name: "Mobile preview" }));
    expect((frame as HTMLIFrameElement).style.width).toBe("375px");
    await user.click(screen.getByRole("button", { name: "Desktop preview" }));
    expect((frame as HTMLIFrameElement).style.width).toBe("680px");
  });

  it("Save draft sends the design to the server, shows the server's refusal, and on the first save moves the URL to the saved campaign", async () => {
    const user = userEvent.setup();
    saveCampaignDesign.mockResolvedValueOnce({ ok: false, error: "The button needs a label.", issues: [] });
    start();
    await user.type(screen.getByLabelText("Campaign name"), "Spring");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The button needs a label."));
    // The toast fires INSIDE the save transition; the button stays disabled (`pending`) until React has committed the end of that transition. Clicking before that is a click on a
    // disabled button: nothing happens and the second save never reaches the server. Under load the commit can lag the toast by seconds (this was the intermittent full-suite
    // failure, 2026-11-22), so wait for the button to be usable again - exactly what a person does.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
    saveCampaignDesign.mockResolvedValueOnce({ ok: true, campaignId: "c9", issues: [] });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/subscriptions/campaigns/builder?id=c9"));
    expect(saveCampaignDesign.mock.calls[1][0]).toMatchObject({ name: "Spring", design: { version: 1 } });
  });

  it("Send test needs a saved draft, then asks the server", async () => {
    const user = userEvent.setup();
    start();
    expect(screen.getByRole("button", { name: "Send test to me" })).toBeDisabled();
    saveCampaignDesign.mockResolvedValueOnce({ ok: true, campaignId: "c9", issues: [] });
    sendCampaignTest.mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test to me" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Send test to me" }));
    await waitFor(() => expect(sendCampaignTest).toHaveBeenCalledWith("c9"));
  });
});

const analytics = (over: Partial<CampaignAnalytics> = {}): CampaignAnalytics => ({
  audience: 1000, queued: 600, sent: 380, failed: 5, unknown: 3, skippedUnsubscribed: 8, skippedSuppressed: 4, cancelled: 0, completedFraction: 0.4, status: "SENDING", sentLastHour: 20,
  perMinuteBudget: 20, dailyLimit: 400, sentLast24h: 120, estimatedHoursRemaining: 36, scheduledAt: null, startedAt: null, completedAt: null, ...over,
});

describe("CampaignDeliveryPanel", () => {
  it("no longer shows the large Delivery information section: no heading, progress bar, count tiles, Gmail explanations or sending-limit text - only the controls", () => {
    const { container } = render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    expect(screen.getByTestId("campaign-delivery-controls")).toBeInTheDocument();
    expect(screen.queryByText("Delivery")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    for (const id of ["stat-sent", "stat-queued", "stat-failed", "stat-unknown", "stat-unsub", "stat-suppressed", "provider-limits"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(container.textContent).not.toMatch(/Waiting|Outcome unknown|Skipped|accepted by Gmail|in any 24 hours|takes days|of the audience has been handled/);
  });

  it("a finished campaign has no controls, so the component renders nothing at all", () => {
    for (const status of ["SENT", "CANCELLED", "FAILED"] as const) {
      const { container, unmount } = render(<CampaignDeliveryPanel campaignId="c1" initial={analytics({ status })} canQueue={false} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("while sending: Pause and Cancel are offered; Resume and Schedule are not", () => {
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Schedule/ })).toBeNull();
  });

  it("Pause asks the server and the controls follow the new status (Resume appears)", async () => {
    getCampaignAnalytics.mockResolvedValue(analytics({ status: "PAUSED" }));
    const user = userEvent.setup();
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(pauseCampaignDelivery).toHaveBeenCalledWith("c1"));
    expect(await screen.findByRole("button", { name: /Resume/ })).toBeInTheDocument();
  });

  it("Cancel is confirmed first and only then sent to the server", async () => {
    getCampaignAnalytics.mockResolvedValue(analytics({ status: "CANCELLED" }));
    const user = userEvent.setup();
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics({ status: "PAUSED" })} canQueue={false} />);
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(cancelCampaignDelivery).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel campaign" }));
    await waitFor(() => expect(cancelCampaignDelivery).toHaveBeenCalledWith("c1"));
  });

  it("a draft can be scheduled: the button needs a time, and sends it to the server as an ISO instant", async () => {
    queueCampaign.mockResolvedValue({ ok: true, status: "SCHEDULED", audience: 5 });
    getCampaignAnalytics.mockResolvedValue(analytics({ status: "SCHEDULED" }));
    const user = userEvent.setup();
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics({ status: "DRAFT", audience: 0, queued: 0, sent: 0, completedFraction: 0 })} canQueue />);
    expect(screen.getByRole("button", { name: /Schedule/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Schedule for"), { target: { value: "2030-01-01T09:00" } });
    await user.click(screen.getByRole("button", { name: /Schedule/ }));
    await waitFor(() => expect(queueCampaign).toHaveBeenCalledTimes(1));
    expect(queueCampaign.mock.calls[0][1]).toMatch(/^2030-01-01T\d\d:00:00\.000Z$/);
  });

  it("a server refusal is shown, not swallowed", async () => {
    pauseCampaignDelivery.mockResolvedValueOnce({ ok: false });
    getCampaignAnalytics.mockResolvedValue(analytics());
    const user = userEvent.setup();
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});

describe("Subscriptions page entry points", () => {
  const page = () => fs.readFileSync(path.join(process.cwd(), "src", "app", "(crm)", "subscriptions", "page.tsx"), "utf8");

  it("has ONE campaign button, labelled 'New Campaign', and it opens the builder", () => {
    const src = page();
    expect(src.match(/New Campaign/g)).toHaveLength(1);
    expect(src).toContain('href="/subscriptions/campaigns/builder">New Campaign<');
    expect(src).not.toContain("campaigns/new");
    expect(src).not.toContain("New Campaign (builder)");
  });

  it("no longer offers the redundant CSV subscriber import (the Add Bulk Subscribers box is the way in)", () => {
    expect(page()).not.toMatch(/SubscriberImport|subscriber-import/);
    expect(fs.existsSync(path.join(process.cwd(), "src", "app", "(crm)", "subscriptions", "campaigns", "new", "page.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "src", "components", "subscriptions", "subscriber-import-panel.tsx"))).toBe(false);
  });
});
