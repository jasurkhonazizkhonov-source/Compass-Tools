// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import "@/test/rtl-setup";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const actions = vi.hoisted(() => ({
  requestLeadAttachmentUpload: vi.fn(),
  completeLeadAttachmentUpload: vi.fn(),
  abandonLeadAttachmentUpload: vi.fn(async () => ({ ok: true })),
  updateLeadAttachmentDescription: vi.fn(),
  deleteLeadAttachment: vi.fn(),
}));
vi.mock("@/server/actions/lead-attachments", () => actions);

import { LeadFilesPanel, type LeadFileRow } from "../lead-files-panel";
import { ContactDocumentsPanel } from "@/components/contacts/contact-documents-panel";

const LONG_NAME = `${"Passport-of-a-traveller-with-a-very-long-name-".repeat(4)}scan.pdf`;
const FILES: LeadFileRow[] = [
  { id: "att-1", fileName: "passport.pdf", description: "Passport copy", fileType: "application/pdf", fileSize: 2_400_000, createdAt: "2026-10-06T12:00:00.000Z", uploadedByName: "Jane Agent" },
  { id: "att-2", fileName: LONG_NAME, description: "A very long description ".repeat(40), fileType: "image/png", fileSize: 120_000, createdAt: "2026-10-05T12:00:00.000Z", uploadedByName: null },
  { id: "att-3", fileName: "notes.docx", description: null, fileType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileSize: 20_000, createdAt: "2026-10-04T12:00:00.000Z", uploadedByName: "Jane Agent" },
];
const base = { leadId: "lead-1", files: FILES, total: 3, canManage: false, storageReady: true, maxSizeMb: 10 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lead Files panel", () => {
  it("shows name, description, type, size, uploader and date, and never a raw storage URL", () => {
    const { container } = render(<LeadFilesPanel {...base} />);
    const list = screen.getByRole("list", { name: "Lead files" });
    expect(within(list).getByText("passport.pdf")).toBeInTheDocument();
    expect(within(list).getByText("Passport copy")).toBeInTheDocument();
    expect(within(list).getByText(/PDF/)).toBeInTheDocument();
    expect(within(list).getByText(/2\.3 MB|2\.4 MB/)).toBeInTheDocument();
    expect(within(list).getAllByText(/Uploaded by Jane Agent/).length).toBe(2);
    expect(within(list).getByText(/Oct 6, 2026/)).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/r2\.cloudflarestorage|storageKey|companies\//);
    // links go through the authorised route by attachment id only
    const open = screen.getByRole("link", { name: "Open passport.pdf" });
    expect(open).toHaveAttribute("href", "/api/attachments/att-1/file");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: "Download passport.pdf" })).toHaveAttribute("href", "/api/attachments/att-1/file?download=1");
  });

  it("only PDFs and images get an Open link; Office files are download-only", () => {
    render(<LeadFilesPanel {...base} />);
    expect(screen.queryByRole("link", { name: "Open notes.docx" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download notes.docx" })).toBeInTheDocument();
  });

  it("a Travel Agent sees no edit or delete controls", () => {
    render(<LeadFilesPanel {...base} canManage={false} />);
    expect(screen.queryByRole("button", { name: /Edit description/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
  });

  it("an Admin / Manager sees both, with accessible names that identify the file", () => {
    render(<LeadFilesPanel {...base} canManage />);
    expect(screen.getByRole("button", { name: "Edit description of passport.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete passport.pdf" })).toBeInTheDocument();
  });

  it("long file names truncate with the full name in a tooltip, and long descriptions are clamped", () => {
    render(<LeadFilesPanel {...base} />);
    const name = screen.getByTitle(LONG_NAME);
    expect(name.className).toMatch(/truncate/);
    const desc = screen.getByText(/A very long description/);
    expect(desc.className).toMatch(/line-clamp-3/);
    expect(desc.className).toMatch(/break-words/);
  });

  it("empty state, and a disabled Upload button with an explanation when storage isn't available", () => {
    render(<LeadFilesPanel {...base} files={[]} total={0} storageReady={false} />);
    expect(screen.getByText("No files yet")).toBeInTheDocument();
    expect(screen.getByText("0 files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload Document/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/not available/i);
    expect(document.body.textContent).not.toMatch(/bucket|S3|Cloudflare/i);
  });

  it("the upload dialog states the allowed types and size, and refuses an unsupported file before any request", async () => {
    render(<LeadFilesPanel {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /Upload Document/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/up to 10 MB/i)).toBeInTheDocument();
    const input = within(dialog).getByLabelText("File") as HTMLInputElement;
    expect(input.accept).toContain(".pdf");
    expect(input.accept).not.toMatch(/\.(svg|html|exe|mp4|mp3|zip)/);
    fireEvent.change(input, { target: { files: [new File(["x"], "movie.mp4", { type: "video/mp4" })] } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This file type is not supported");
    expect(within(dialog).getByRole("button", { name: /^Upload$/ })).toBeDisabled();
    expect(actions.requestLeadAttachmentUpload).not.toHaveBeenCalled();
  });

  it("refuses an oversized file client-side with the limit in the message", async () => {
    render(<LeadFilesPanel {...base} maxSizeMb={1} />);
    fireEvent.click(screen.getByRole("button", { name: /Upload Document/ }));
    const dialog = await screen.findByRole("dialog");
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.pdf", { type: "application/pdf" });
    fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [big] } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("maximum size is 1 MB");
  });

  it("shows a server refusal as a readable, retryable error and cleans up nothing it didn't create", async () => {
    actions.requestLeadAttachmentUpload.mockResolvedValue({ ok: false, error: "You can't add files to this lead." });
    render(<LeadFilesPanel {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /Upload Document/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [new File(["%PDF-1.7"], "ok.pdf", { type: "application/pdf" })] } });
    fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: "Passport copy" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Upload$/ }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("You can't add files to this lead."));
    expect(actions.requestLeadAttachmentUpload).toHaveBeenCalledWith(expect.objectContaining({ leadId: "lead-1", fileName: "ok.pdf", description: "Passport copy" }));
    expect(actions.completeLeadAttachmentUpload).not.toHaveBeenCalled();
    expect(actions.abandonLeadAttachmentUpload).not.toHaveBeenCalled();
  });

  describe("when the browser → server upload fails", () => {
    // A minimal XMLHttpRequest whose outcome the test chooses: "error" = no response at all (network), an HTTP status with the server's JSON
    // body, or "hang" = a request that never finishes (so it can be cancelled).
    const xhrCalls = { open: [] as unknown[][], sent: [] as unknown[], headers: [] as unknown[][] };
    function stubXhr(outcome: "error" | "hang" | number, body = "") {
      xhrCalls.open.length = 0;
      xhrCalls.sent.length = 0;
      xhrCalls.headers.length = 0;
      class FakeXhr {
        status = 0;
        responseText = "";
        upload = { onprogress: null as null | ((e: unknown) => void) };
        onload: null | (() => void) = null;
        onerror: null | (() => void) = null;
        onabort: null | (() => void) = null;
        ontimeout: null | (() => void) = null;
        open(...args: unknown[]) {
          xhrCalls.open.push(args);
        }
        setRequestHeader(...args: unknown[]) {
          xhrCalls.headers.push(args);
        }
        abort() {
          this.onabort?.();
        }
        send(file: unknown) {
          xhrCalls.sent.push(file);
          if (outcome === "hang") return;
          queueMicrotask(() => {
            if (outcome === "error") this.onerror?.();
            else {
              this.status = outcome;
              this.responseText = body;
              this.onload?.();
            }
          });
        }
      }
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
    }
    async function attemptUpload() {
      actions.requestLeadAttachmentUpload.mockResolvedValue({ ok: true, attachmentId: "pending-1", uploadUrl: "/api/attachments/pending-1/upload", headers: { "Content-Type": "application/pdf" } });
      render(<LeadFilesPanel {...base} />);
      fireEvent.click(screen.getByRole("button", { name: /Upload Document/ }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText("File"), { target: { files: [new File(["%PDF-1.7"], "ok.pdf", { type: "application/pdf" })] } });
      fireEvent.click(within(dialog).getByRole("button", { name: /^Upload$/ }));
      return dialog;
    }

    it("the file is PUT to the same-origin upload address the server returned - never to a storage provider", async () => {
      stubXhr(200, '{"ok":true}');
      actions.completeLeadAttachmentUpload.mockResolvedValue({ ok: true, attachmentId: "pending-1" });
      await attemptUpload();
      await waitFor(() => expect(actions.completeLeadAttachmentUpload).toHaveBeenCalledWith("pending-1"));
      expect(xhrCalls.open).toEqual([["PUT", "/api/attachments/pending-1/upload"]]);
      expect(String(xhrCalls.open[0][1])).not.toMatch(/^https?:|r2|amazonaws|cloudflarestorage/i);
      expect(xhrCalls.sent[0]).toBeInstanceOf(File);
      expect(xhrCalls.headers).toEqual([["Content-Type", "application/pdf"]]);
    });

    it("cancelling an upload in progress aborts the request, reports 'cancelled' without an error message, and removes the pending record", async () => {
      stubXhr("hang");
      const dialog = await attemptUpload();
      fireEvent.click(await within(dialog).findByRole("button", { name: /Cancel upload/ }));
      await waitFor(() => expect(actions.abandonLeadAttachmentUpload).toHaveBeenCalledWith("pending-1", { stage: "cancelled", kind: "other", status: 0 }));
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(actions.completeLeadAttachmentUpload).not.toHaveBeenCalled();
      expect(within(dialog).getByRole("button", { name: /^Upload$/ })).toBeEnabled();
    });

    it("no response (network drop): a specific, safe message; the failure is reported with stage, kind and status only; retry is possible", async () => {
      stubXhr("error");
      const dialog = await attemptUpload();
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/didn't reach the server/));
      expect(within(dialog).getByRole("alert")).not.toHaveTextContent(/bucket|cloudflare|https?:|CORS/i);
      expect(actions.abandonLeadAttachmentUpload).toHaveBeenCalledWith("pending-1", { stage: "put", kind: "blocked", status: 0 });
      expect(actions.completeLeadAttachmentUpload).not.toHaveBeenCalled();
      // not stuck: the Upload button is usable again for another attempt
      expect(within(dialog).getByRole("button", { name: /^Upload$/ })).toBeEnabled();
    });

    it("the server answers with an error status and no message: the status is shown and reported", async () => {
      stubXhr(403);
      const dialog = await attemptUpload();
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/rejected the upload \(error 403\)/));
      expect(actions.abandonLeadAttachmentUpload).toHaveBeenCalledWith("pending-1", { stage: "put", kind: "rejected", status: 403 });
    });

    it("the server's own short message is shown (content mismatch, too large, storage full)", async () => {
      for (const [status, message] of [
        [422, "This file's contents don't match its file type, so it was not saved."],
        [413, "The uploaded file didn't match what was selected. Please try again."],
        [507, "File storage is almost full, so new files can't be added right now. Please ask an administrator."],
      ] as const) {
        stubXhr(status, JSON.stringify({ error: message }));
        const dialog = await attemptUpload();
        await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(message));
        expect(actions.abandonLeadAttachmentUpload).toHaveBeenLastCalledWith("pending-1", { stage: "put", kind: "rejected", status });
        cleanup();
        vi.clearAllMocks();
      }
    });

    it("an error body that is not a short plain message is ignored (never shown)", async () => {
      stubXhr(500, "<html>Internal Server Error at /var/lib/compass-tools/uploads/ab/cd</html>");
      const dialog = await attemptUpload();
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/rejected the upload \(error 500\)/));
      expect(within(dialog).getByRole("alert")).not.toHaveTextContent(/var\/lib|html/i);
    });

    it("a failure after a successful PUT is reported as the verify stage", async () => {
      stubXhr(200);
      actions.completeLeadAttachmentUpload.mockResolvedValue({ ok: false, error: "This file's contents don't match its file type, so it was not saved." });
      const dialog = await attemptUpload();
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(/contents don't match/));
      expect(actions.abandonLeadAttachmentUpload).toHaveBeenCalledWith("pending-1", { stage: "verify", kind: "other", status: 0 });
    });
  });

  it("editing a description sends only the description; delete asks for confirmation first", async () => {
    actions.updateLeadAttachmentDescription.mockResolvedValue({ ok: true, description: "new" });
    actions.deleteLeadAttachment.mockResolvedValue({ ok: true });
    render(<LeadFilesPanel {...base} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description of passport.pdf" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "new" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(actions.updateLeadAttachmentDescription).toHaveBeenCalledWith("att-1", "new"));

    fireEvent.click(screen.getByRole("button", { name: "Delete passport.pdf" }));
    expect(actions.deleteLeadAttachment).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete file" }));
    await waitFor(() => expect(actions.deleteLeadAttachment).toHaveBeenCalledWith("att-1"));
  });
});

describe("Contact documents summary", () => {
  it("names the lead each document belongs to, and has no edit / delete controls", () => {
    const rows: LeadFileRow[] = [
      { ...FILES[0], lead: { id: "lead-9", label: "LHR → JFK" } },
      { ...FILES[2], lead: { id: "lead-8", label: "DXB → CDG" } },
    ];
    render(<ContactDocumentsPanel files={rows} total={2} />);
    expect(screen.getByRole("link", { name: "LHR → JFK" })).toHaveAttribute("href", "/leads/lead-9");
    expect(screen.getByRole("link", { name: "DXB → CDG" })).toHaveAttribute("href", "/leads/lead-8");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("empty state", () => {
    render(<ContactDocumentsPanel files={[]} total={0} />);
    expect(screen.getByText("No files yet")).toBeInTheDocument();
  });
});
