// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The sequence step editor: visual editor for new steps, plain text kept for older ones, server-rendered preview and source, the server's checks (errors stop saving), drafts kept in the
// browser, duplicate and reorder. The server actions and the TipTap editor are mocked here (the editor's own HTML is proven against the real server cleaner in
// components/email-editor/__tests__/extensions.test.ts; the actions' rules in server/actions/__tests__).
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

const addStep = vi.fn();
const updateStep = vi.fn();
const deleteStep = vi.fn();
const duplicateStep = vi.fn();
const moveStep = vi.fn();
vi.mock("@/server/actions/sequences", () => ({
  addStep: (...a: unknown[]) => addStep(...a),
  updateStep: (...a: unknown[]) => updateStep(...a),
  deleteStep: (...a: unknown[]) => deleteStep(...a),
  duplicateStep: (...a: unknown[]) => duplicateStep(...a),
  moveStep: (...a: unknown[]) => moveStep(...a),
}));
const analyze = vi.fn();
const preview = vi.fn();
vi.mock("@/server/actions/sequence-step-content", () => ({ analyzeSequenceStepDraft: (...a: unknown[]) => analyze(...a), previewSequenceStepEmail: (...a: unknown[]) => preview(...a) }));
// A stand-in for the TipTap editor: a textarea that reports HTML, and shows it received the variable list.
vi.mock("@/components/subscriptions/rich-text-editor", () => ({
  RichTextEditor: ({ value, onChange, variables }: { value: string; onChange: (html: string) => void; variables?: unknown[] }) => (
    <textarea data-testid="visual-editor" data-variables={variables?.length ?? 0} aria-label="Email body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const { StepEditor } = await import("../step-editor");

const OK = { errors: [], warnings: [], linkCount: 0, imageCount: 0, sizeChars: 10, ok: true };
const textStep = { id: "s1", subject: "Hi {{contact_first_name}}", body: "Hello there.\n\nSee https://example.com", bodyFormat: "TEXT" as const, delayMinutes: 0, order: 0 };
const htmlStep = { id: "s2", subject: "Offer", body: "<p>Big <strong>offer</strong></p>", bodyFormat: "HTML" as const, delayMinutes: 2 * 24 * 60, order: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  analyze.mockResolvedValue(OK);
  preview.mockResolvedValue({ ok: true, subject: "Hi Sarah", html: "<html><body><p>Hello Sarah</p></body></html>" });
  addStep.mockResolvedValue({});
  updateStep.mockResolvedValue({});
  duplicateStep.mockResolvedValue({});
  moveStep.mockResolvedValue({ ok: true });
});

describe("existing steps", () => {
  it("an older plain-text step stays plain text; a visual step is marked and summarised as words, never as markup", () => {
    render(<StepEditor sequenceId="seq-1" steps={[textStep, htmlStep]} />);
    const [first, second] = screen.getAllByTestId("sequence-step");
    expect(first).toHaveAttribute("data-format", "TEXT");
    expect(second).toHaveAttribute("data-format", "HTML");
    expect(within(second).getByText("Visual email")).toBeInTheDocument();
    expect(second.textContent).toContain("Big offer");
    expect(second.textContent).not.toContain("<strong>");
  });

  it("editing a plain-text step shows the plain-text box, and 'Use the visual editor' converts it only after confirmation", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[textStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 1" }));
    expect(screen.getByRole("textbox", { name: "Email body (plain text)" })).toHaveValue(textStep.body);
    expect(screen.queryByTestId("visual-editor")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Use the visual editor/ }));
    expect(screen.queryByTestId("visual-editor")).toBeNull(); // nothing changes until confirmed
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Use the visual editor" }));
    const editor = await screen.findByTestId("visual-editor");
    expect(editor).toHaveValue('<p>Hello there.</p><p>See <a href="https://example.com">https://example.com</a></p>');
    expect(editor).toHaveAttribute("data-variables", "17"); // the personalization variables are available in the visual editor
  });

  it("saving sends the step's format with the text, and the delay in minutes", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[htmlStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 2" }));
    const body = screen.getByTestId("visual-editor");
    await user.clear(body);
    await user.type(body, "<p>New</p>");
    await user.click(screen.getByRole("button", { name: "Save step" }));
    await waitFor(() => expect(updateStep).toHaveBeenCalledWith("s2", { subject: "Offer", body: "<p>New</p>", bodyFormat: "HTML", delayMinutes: 2 * 24 * 60 }));
    expect(toastSuccess).toHaveBeenCalledWith("Step updated");
  });

  it("Duplicate copies the step to the end; Move earlier / later are disabled at the ends, and a refusal from the server is shown as it is", async () => {
    const user = userEvent.setup();
    moveStep.mockResolvedValueOnce({ ok: false, error: "3 people are part-way through this sequence, so steps cannot be reordered." });
    render(<StepEditor sequenceId="seq-1" steps={[textStep, htmlStep]} />);
    expect(screen.getByRole("button", { name: "Move step 1 earlier" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move step 2 later" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Duplicate step 1" }));
    await waitFor(() => expect(duplicateStep).toHaveBeenCalledWith("s1"));
    expect(refresh).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Move step 2 earlier" }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("3 people are part-way through this sequence, so steps cannot be reordered."));
    expect(moveStep).toHaveBeenCalledWith("s2", "up");
  });
});

describe("new steps", () => {
  it("start in the visual editor, and save as HTML with the delay in minutes", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[textStep]} />);
    await user.click(screen.getByRole("button", { name: /Add Step/ }));
    expect(await screen.findByTestId("visual-editor")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Email subject"), "Follow up");
    await user.type(screen.getByTestId("visual-editor"), "<p>Hello</p>");
    await user.click(screen.getByRole("button", { name: /^Add Step$/ }));
    await waitFor(() => expect(addStep).toHaveBeenCalledWith({ sequenceId: "seq-1", subject: "Follow up", body: "<p>Hello</p>", bodyFormat: "HTML", delayMinutes: 2 * 24 * 60 }));
  });

  it("an empty subject or body is refused before anything is sent", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[]} />);
    await user.click(screen.getByRole("button", { name: /^Add Step$/ }));
    expect(toastError).toHaveBeenCalledWith("Subject and body are required");
    expect(addStep).not.toHaveBeenCalled();
  });
});

describe("checks from the server", () => {
  it("a draft with errors cannot be saved, and each error is shown as an alert; warnings are shown as advice and do not block", async () => {
    const user = userEvent.setup();
    analyze.mockResolvedValue({
      errors: [{ level: "error", code: "image-not-public", message: "Image 1 must be a public https:// address." }],
      warnings: [{ level: "warning", code: "image-alt", message: "Image 1 has no description (alt text)." }],
      linkCount: 0, imageCount: 1, sizeChars: 50, ok: false,
    });
    render(<StepEditor sequenceId="seq-1" steps={[]} />);
    await user.type(screen.getByPlaceholderText("Email subject"), "S");
    await user.type(screen.getByTestId("visual-editor"), "<p>x</p>");
    const checks = await screen.findByTestId("step-checks");
    await waitFor(() => expect(within(checks).getByRole("alert").textContent).toMatch(/Image 1 must be a public https/));
    expect(checks.textContent).toMatch(/has no description/);
    expect(screen.getByRole("button", { name: /^Add Step$/ })).toBeDisabled();
    analyze.mockResolvedValue({ ...OK, warnings: [{ level: "warning", code: "image-alt", message: "Image 1 has no description (alt text)." }] });
    await user.type(screen.getByTestId("visual-editor"), " ");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Add Step$/ })).toBeEnabled());
  });

  it("when nothing is wrong it says so", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[]} />);
    await user.type(screen.getByTestId("visual-editor"), "<p>x</p>");
    expect((await screen.findByTestId("step-checks")).textContent).toMatch(/No problems found/);
  });

  it("an error the server raises when saving is shown to the person as written; an unknown failure is generic", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[]} />);
    await user.type(screen.getByPlaceholderText("Email subject"), "S");
    await user.type(screen.getByTestId("visual-editor"), "<p>x</p>");
    addStep.mockRejectedValueOnce(new Error("This email cannot be saved: The email is too large."));
    await user.click(screen.getByRole("button", { name: /^Add Step$/ }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("This email cannot be saved: The email is too large."));
    addStep.mockRejectedValueOnce(new Error("connect ECONNREFUSED postgresql://user:secret@db"));
    await user.click(screen.getByRole("button", { name: /^Add Step$/ }));
    await waitFor(() => expect(toastError).toHaveBeenLastCalledWith("The step could not be saved. Please try again."));
  });
});

describe("preview and source", () => {
  async function openEditing(user: ReturnType<typeof userEvent.setup>) {
    render(<StepEditor sequenceId="seq-1" steps={[htmlStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 2" }));
  }

  it("the Preview tab shows the email as the server renders it, in a frame that can do nothing", async () => {
    const user = userEvent.setup();
    await openEditing(user);
    await user.click(screen.getByRole("tab", { name: /Preview/ }));
    const frame = await screen.findByTestId("email-preview");
    expect(frame).toHaveAttribute("sandbox", ""); // no scripts, no navigation, no access to the CRM
    expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("Hello Sarah"));
    expect(preview).toHaveBeenCalledWith({ subject: "Offer", body: "<p>Big <strong>offer</strong></p>", bodyFormat: "HTML" });
    expect(screen.getByText("Hi Sarah")).toBeInTheDocument();
  });

  it("desktop, email-width and mobile views change the frame width", async () => {
    const user = userEvent.setup();
    await openEditing(user);
    await user.click(screen.getByRole("tab", { name: /Preview/ }));
    const frame = await screen.findByTestId("email-preview");
    expect(frame).toHaveAttribute("data-device", "email");
    expect(frame.style.width).toBe("600px");
    await user.click(screen.getByRole("button", { name: /Mobile/ }));
    expect(screen.getByTestId("email-preview")).toHaveAttribute("data-device", "mobile");
    expect(screen.getByTestId("email-preview").style.width).toBe("375px");
    await user.click(screen.getByRole("button", { name: /Desktop/ }));
    expect(screen.getByTestId("email-preview").style.width).toBe("720px");
    expect(screen.getByRole("button", { name: /Desktop/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("the HTML tab shows the source read-only, as text (never as markup)", async () => {
    const user = userEvent.setup();
    preview.mockResolvedValue({ ok: true, subject: "S", html: '<html><body><script>alert(1)</script><p>Hi</p></body></html>' });
    await openEditing(user);
    await user.click(screen.getByRole("tab", { name: /HTML/ }));
    const source = await screen.findByTestId("email-source");
    expect(source.textContent).toContain("<script>alert(1)</script>"); // shown as text
    expect(source.querySelector("script")).toBeNull(); // and not run
  });

  it("a failed preview is explained", async () => {
    const user = userEvent.setup();
    preview.mockResolvedValue({ ok: false, error: "The email is too large to preview." });
    await openEditing(user);
    await user.click(screen.getByRole("tab", { name: /Preview/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("The email is too large to preview.");
  });
});

describe("drafts kept in this browser", () => {
  const draft = { subject: "Draft subject", body: "<p>Draft body</p>", bodyFormat: "HTML", delayDays: 3, savedAt: Date.now() };

  it("an unsaved draft from an earlier session is offered, and Restore puts it back", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("compass:step-draft:s2", JSON.stringify(draft));
    render(<StepEditor sequenceId="seq-1" steps={[htmlStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 2" }));
    const offer = await screen.findByTestId("draft-offer");
    expect(offer.textContent).toMatch(/unsaved draft/);
    await user.click(within(offer).getByRole("button", { name: "Restore draft" }));
    expect(screen.getByPlaceholderText("Email subject")).toHaveValue("Draft subject");
    expect(screen.getByTestId("visual-editor")).toHaveValue("<p>Draft body</p>");
    expect(screen.queryByTestId("draft-offer")).toBeNull();
  });

  it("Discard removes it, and a draft identical to what is saved is not offered", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("compass:step-draft:s2", JSON.stringify(draft));
    const { unmount } = render(<StepEditor sequenceId="seq-1" steps={[htmlStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 2" }));
    await user.click(within(await screen.findByTestId("draft-offer")).getByRole("button", { name: "Discard" }));
    expect(window.localStorage.getItem("compass:step-draft:s2")).toBeNull();
    unmount();
    window.localStorage.setItem("compass:step-draft:s2", JSON.stringify({ subject: htmlStep.subject, body: htmlStep.body, bodyFormat: "HTML", delayDays: 2, savedAt: 1 }));
    render(<StepEditor sequenceId="seq-1" steps={[htmlStep]} />);
    await user.click(screen.getByRole("button", { name: "Edit step 2" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("draft-offer")).toBeNull();
  });

  it("what is being typed is kept as a draft, and removed once the step is saved", async () => {
    const user = userEvent.setup();
    render(<StepEditor sequenceId="seq-1" steps={[]} />);
    await user.type(screen.getByPlaceholderText("Email subject"), "Kept");
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem("compass:step-draft:new:seq-1") ?? "{}").subject).toBe("Kept"), { timeout: 3000 });
    await user.type(screen.getByTestId("visual-editor"), "<p>x</p>");
    await user.click(screen.getByRole("button", { name: /^Add Step$/ }));
    await waitFor(() => expect(addStep).toHaveBeenCalled());
    await waitFor(() => expect(window.localStorage.getItem("compass:step-draft:new:seq-1")).toBeNull());
  });
});
