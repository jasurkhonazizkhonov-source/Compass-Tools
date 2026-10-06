// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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

  it("empty state, and a disabled Upload button with an explanation when storage isn't configured", () => {
    render(<LeadFilesPanel {...base} files={[]} total={0} storageReady={false} />);
    expect(screen.getByText("No files yet")).toBeInTheDocument();
    expect(screen.getByText("0 files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload Document/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/not set up/i);
    expect(document.body.textContent).not.toMatch(/R2|bucket|S3|Cloudflare/i);
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
