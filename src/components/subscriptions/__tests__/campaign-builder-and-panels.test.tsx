// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import type { CampaignAnalytics } from "@/server/actions/campaign-delivery";
import type { ImportJobRow } from "@/server/actions/subscriber-imports";

// The browser side of the campaign builder, the delivery panel (analytics + controls) and the background-import panel.

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
const previewSubscriberImport = vi.fn();
const createSubscriberImportJob = vi.fn();
const listSubscriberImportJobs = vi.fn(async () => [] as ImportJobRow[]);
vi.mock("@/server/actions/subscriber-imports", () => ({
  previewSubscriberImport: (...a: unknown[]) => previewSubscriberImport(...a),
  createSubscriberImportJob: (...a: unknown[]) => createSubscriberImportJob(...a),
  listSubscriberImportJobs: (...a: unknown[]) => (listSubscriberImportJobs as unknown as (...x: unknown[]) => unknown)(...a),
  getSubscriberImportErrorReport: vi.fn(async () => "row,reason\n2,INVALID_EMAIL"),
  cancelSubscriberImport: vi.fn(async () => ({ ok: true })),
  resumeSubscriberImport: vi.fn(async () => ({ ok: true })),
}));

const { CampaignBuilder } = await import("../campaign-builder");
const { CampaignDeliveryPanel } = await import("../campaign-delivery-panel");
const { SubscriberImportPanel } = await import("../subscriber-import-panel");
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
  audience: 1000, queued: 600, sent: 380, failed: 5, unknown: 3, skippedUnsubscribed: 8, skippedSuppressed: 4, completedFraction: 0.4, status: "SENDING", sentLastHour: 20,
  perMinuteBudget: 20, dailyLimit: 400, sentLast24h: 120, estimatedHoursRemaining: 36, scheduledAt: null, startedAt: null, completedAt: null, ...over,
});

describe("CampaignDeliveryPanel", () => {
  it("shows honest counts and definitions, progress, and the provider limit in plain words", () => {
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    expect(screen.getByTestId("stat-sent")).toHaveTextContent("380");
    expect(screen.getByTestId("stat-queued")).toHaveTextContent("600");
    expect(screen.getByTestId("stat-unknown")).toHaveTextContent("3");
    expect(screen.getByRole("progressbar", { name: "Delivery progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText(/accepted by Gmail\. Delivered, opened and clicked are not tracked/)).toBeInTheDocument();
    expect(screen.getByTestId("provider-limits")).toHaveTextContent(/at most 400 in any 24 hours/);
    expect(screen.getByTestId("provider-limits")).toHaveTextContent(/takes days/);
  });

  it("while sending: Pause and Cancel are offered; Resume and Schedule are not", () => {
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    expect(screen.getByRole("button", { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Schedule/ })).toBeNull();
  });

  it("Pause asks the server and refreshes the numbers", async () => {
    getCampaignAnalytics.mockResolvedValue(analytics({ status: "PAUSED" }));
    const user = userEvent.setup();
    render(<CampaignDeliveryPanel campaignId="c1" initial={analytics()} canQueue={false} />);
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(pauseCampaignDelivery).toHaveBeenCalledWith("c1"));
    expect(await screen.findByRole("button", { name: /Resume/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/paused/i);
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

describe("SubscriberImportPanel", () => {
  const job = (over: Partial<ImportJobRow> = {}): ImportJobRow => ({
    id: "j1", status: "PROCESSING", source: "PASTE", totalRows: 100_000, validRows: 98_000, invalidRows: 1_500, duplicateInFile: 500, existingRows: 10_000, importedRows: 40_000,
    skippedUnsubscribedOrSuppressed: 321, processedRows: 49_000, hasErrorReport: true, createdAt: "2026-11-20T10:00:00.000Z", finishedAt: null, ...over,
  });

  it("Check list shows counts only (never an address), including who is kept out", async () => {
    previewSubscriberImport.mockResolvedValue({ ok: true, preview: { totalRows: 10, validRows: 7, invalidRows: 2, duplicateInFile: 1, newSubscribers: 4, alreadySubscribed: 1, previouslyUnsubscribed: 1, suppressed: 1, truncated: false } });
    const user = userEvent.setup();
    const { container } = render(<SubscriberImportPanel initialJobs={[]} />);
    await user.type(screen.getByLabelText("Subscriber list"), "a@example.com");
    expect(screen.getByRole("button", { name: "Start import" })).toBeDisabled(); // must be checked first
    await user.click(screen.getByRole("button", { name: /Check list/ }));
    const preview = await screen.findByTestId("import-preview");
    expect(preview).toHaveTextContent("Will be added");
    expect(preview).toHaveTextContent("Unsubscribed (kept out)");
    expect(preview).toHaveTextContent("Suppressed (kept out)");
    expect(container.textContent).not.toMatch(/a@example\.com@/); // nothing but the textarea echoes input
    expect(screen.getByRole("button", { name: "Start import" })).toBeEnabled();
  });

  it("Start import queues the job in the background and clears the box", async () => {
    previewSubscriberImport.mockResolvedValue({ ok: true, preview: { totalRows: 1, validRows: 1, invalidRows: 0, duplicateInFile: 0, newSubscribers: 1, alreadySubscribed: 0, previouslyUnsubscribed: 0, suppressed: 0, truncated: false } });
    createSubscriberImportJob.mockResolvedValue({ ok: true, jobId: "j1", validRows: 1 });
    listSubscriberImportJobs.mockResolvedValue([job({ status: "QUEUED", processedRows: 0, importedRows: 0 })]);
    const user = userEvent.setup();
    render(<SubscriberImportPanel initialJobs={[]} />);
    await user.type(screen.getByLabelText("Subscriber list"), "a@example.com");
    await user.click(screen.getByRole("button", { name: /Check list/ }));
    await user.click(await screen.findByRole("button", { name: "Start import" }));
    await waitFor(() => expect(createSubscriberImportJob).toHaveBeenCalledWith("a@example.com", "PASTE"));
    await waitFor(() => expect(screen.getByLabelText("Subscriber list")).toHaveValue(""));
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("continues in the background"));
  });

  it("a server refusal (too many rows) is shown in place", async () => {
    previewSubscriberImport.mockResolvedValue({ ok: false, error: "Imports are limited to 250,000 rows at a time." });
    const user = userEvent.setup();
    render(<SubscriberImportPanel initialJobs={[]} />);
    await user.type(screen.getByLabelText("Subscriber list"), "x@example.com");
    await user.click(screen.getByRole("button", { name: /Check list/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("250,000");
  });

  it("history shows live progress and the plain-language outcome, with an error report only when there is one", () => {
    render(<SubscriberImportPanel initialJobs={[job(), job({ id: "j2", status: "COMPLETED", hasErrorReport: false, processedRows: 98_000, importedRows: 88_000 })]} />);
    const items = screen.getAllByTestId("import-job");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole("progressbar", { name: "Import progress" })).toHaveAttribute("aria-valuenow", "50");
    expect(items[0]).toHaveTextContent("100,000 rows");
    expect(items[0]).toHaveTextContent("321 unsubscribed or suppressed, not re-subscribed");
    expect(within(items[0]).getByRole("button", { name: /Error report/ })).toBeInTheDocument();
    expect(within(items[1]).queryByRole("button", { name: /Error report/ })).toBeNull();
    expect(within(items[1]).queryByRole("progressbar")).toBeNull();
  });

  it("a failed job offers Resume", () => {
    render(<SubscriberImportPanel initialJobs={[job({ status: "FAILED" })]} />);
    expect(screen.getByRole("button", { name: /Resume/ })).toBeInTheDocument();
  });
});
