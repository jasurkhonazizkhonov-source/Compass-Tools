// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
const createDatabaseBackup = vi.fn();
const deleteDatabaseBackup = vi.fn();
vi.mock("@/server/actions/database-backup", () => ({
  createDatabaseBackup: (...a: unknown[]) => createDatabaseBackup(...a),
  deleteDatabaseBackup: (...a: unknown[]) => deleteDatabaseBackup(...a),
}));

const { DatabaseBackupPanel, formatBackupSize } = await import("../database-backup-panel");

const ID = "compass-20261124T101530Z-3fa9c2d1";
const backup = { id: ID, fileName: `${ID}.dump`, sizeBytes: 5 * 1024 * 1024, createdAt: "2026-11-24T10:15:30.000Z", expiresAt: "2026-11-24T11:15:30.000Z", sha256: "a".repeat(64), format: "PostgreSQL custom format", pgDumpVersion: "17.11", serverVersion: "17.11" };
const status = (over: Record<string, unknown> = {}) => ({
  capability: { available: true as const, pgDumpVersion: "17.11", serverVersion: "17.11" },
  backups: [],
  format: "PostgreSQL custom format (pg_dump --format=custom, compressed)",
  excludedData: "PaymentMethodCvv",
  ...over,
});

let clicked: string[];
beforeEach(() => {
  vi.clearAllMocks();
  clicked = [];
  // jsdom cannot download; the panel starts a download by clicking a temporary link, so record the address it points at
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute("href") ?? "");
  });
});

describe("DatabaseBackupPanel", () => {
  it("has ONE 'Download Database Backup' button, and says what a backup contains, what it leaves out and that it cannot restore", () => {
    render(<DatabaseBackupPanel initial={status()} />);
    expect(screen.getAllByRole("button", { name: /Download Database Backup/ })).toHaveLength(1);
    const text = document.body.textContent!;
    expect(text).toMatch(/PostgreSQL custom format/);
    expect(text).toMatch(/PaymentMethodCvv/);
    expect(text).toMatch(/uploaded lead documents/);
    expect(text).toMatch(/\.env/);
    expect(text).toMatch(/cannot restore a backup/);
  });

  it("creating a backup shows the result and starts the download of exactly that backup", async () => {
    createDatabaseBackup.mockResolvedValue({ ok: true, backup });
    render(<DatabaseBackupPanel initial={status()} />);
    await userEvent.click(screen.getByRole("button", { name: /Download Database Backup/ }));
    await waitFor(() => expect(screen.getByTestId("backup-message").textContent).toMatch(/Backup created and verified \(5\.0 MB\)/));
    expect(clicked).toEqual([`/api/admin/database-backup/${ID}`]);
    const list = screen.getByTestId("backup-list");
    expect(list.textContent).toContain(`${ID}.dump`);
    expect(list.textContent).toContain("a".repeat(64));
    expect(toastSuccess).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  });

  it("a refusal is shown as an alert and nothing is downloaded", async () => {
    createDatabaseBackup.mockResolvedValue({ ok: false, error: "A backup is already being created. Wait for it to finish, then try again." });
    render(<DatabaseBackupPanel initial={status()} />);
    await userEvent.click(screen.getByRole("button", { name: /Download Database Backup/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already being created/));
    expect(clicked).toEqual([]);
    expect(screen.queryByTestId("backup-list")).toBeNull();
  });

  it("a thrown error (for example a signed-out session) is a plain message, never a stack trace", async () => {
    createDatabaseBackup.mockRejectedValue(new Error("Not available.\n at secret/path.ts:1"));
    render(<DatabaseBackupPanel initial={status()} />);
    await userEvent.click(screen.getByRole("button", { name: /Download Database Backup/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be created right now/));
    expect(document.body.textContent).not.toMatch(/secret\/path/);
  });

  it("when the backup tool is not installed the button is disabled and the reason is shown", () => {
    render(<DatabaseBackupPanel initial={status({ capability: { available: false, code: "TOOL_MISSING", reason: "The PostgreSQL backup tool (pg_dump) is not installed in this environment." } })} />);
    expect(screen.getByRole("button", { name: /Download Database Backup/ })).toBeDisabled();
    expect(screen.getByTestId("backup-unavailable").textContent).toMatch(/pg_dump\) is not installed/);
  });

  it("staged backups are listed with Download and Delete; Delete removes the row, a failed delete keeps it and says why", async () => {
    deleteDatabaseBackup.mockResolvedValueOnce({ ok: false, error: "That backup does not exist or has already been removed." }).mockResolvedValueOnce({ ok: true });
    render(<DatabaseBackupPanel initial={status({ backups: [backup] })} />);
    await userEvent.click(screen.getByRole("button", { name: /^Download$|Download$/ }));
    expect(clicked).toEqual([`/api/admin/database-backup/${ID}`]);
    await userEvent.click(screen.getByRole("button", { name: `Delete backup ${ID}.dump` }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That backup does not exist or has already been removed."));
    expect(screen.getByTestId("backup-list")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Delete backup ${ID}.dump` }));
    await waitFor(() => expect(screen.queryByTestId("backup-list")).toBeNull());
  });

  it("formats sizes for people", () => {
    expect(formatBackupSize(500)).toBe("1 KB");
    expect(formatBackupSize(2048)).toBe("2 KB");
    expect(formatBackupSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBackupSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
