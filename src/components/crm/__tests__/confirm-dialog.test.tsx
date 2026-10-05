// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { useState } from "react";
import { ConfirmDialog } from "../confirm-dialog";

function Harness({ onConfirm, variant, cancelLabel }: { onConfirm: () => Promise<unknown> | unknown; variant?: "destructive" | "default"; cancelLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this lead?"
        description="This cannot be undone."
        confirmLabel="Delete lead"
        cancelLabel={cancelLabel}
        variant={variant}
        onConfirm={onConfirm as () => Promise<void>}
      />
    </>
  );
}

/** A promise the test resolves by hand, to observe the pending state. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ConfirmDialog — the CRM replacement for window.confirm", () => {
  it("is an alertdialog with its title and description wired up, a Cancel and a specifically-labelled primary action (never 'OK')", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => undefined} />);
    await user.click(screen.getByText("Open"));
    const dialog = screen.getByRole("alertdialog", { name: "Delete this lead?" });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete lead" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^ok$/i })).not.toBeInTheDocument();
  });

  it("starts with focus on Cancel, so a stray Enter cannot fire the destructive action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // Focus-return-to-trigger is Radix Dialog's own behaviour; it does not reproduce under jsdom (see the matching note in
  // subscriber-list.test.tsx), so it is verified in the real browser run instead.
  it("Escape and Cancel close it without running the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
    await user.click(screen.getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("supports a custom cancel label and the non-destructive variant", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => undefined} variant="default" cancelLabel="Keep quote" />);
    await user.click(screen.getByText("Open"));
    expect(screen.getByRole("button", { name: "Keep quote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete lead" })).toHaveAttribute("data-variant", "default");
  });

  it("the destructive variant (default) styles the primary action as destructive", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => undefined} />);
    await user.click(screen.getByText("Open"));
    expect(screen.getByRole("button", { name: "Delete lead" })).toHaveAttribute("data-variant", "destructive");
  });

  it("while the action runs: both buttons are disabled, Escape cannot dismiss it, and a second click does not run it twice", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const onConfirm = vi.fn(() => gate.promise);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    const confirm = screen.getByRole("button", { name: "Delete lead" });
    await user.click(confirm);
    await user.click(confirm); // double click
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // not dismissible mid-action

    gate.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("two clicks in the SAME tick still run the action once (the guard is a ref, not state)", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const onConfirm = vi.fn(() => gate.promise);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    const confirm = screen.getByRole("button", { name: "Delete lead" });
    confirm.click();
    confirm.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a thrown error keeps the dialog open and says so; the action can be retried", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error("You do not have permission to delete this lead.")).mockResolvedValueOnce(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have permission to delete this lead.");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete lead" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("production masks thrown server-action messages — a generic one is shown instead of the digest text", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"));
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was changed");
    expect(alert).not.toHaveTextContent("Server Components");
  });

  it("a RETURNED { error } (what production server actions do) also keeps it open with the message", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue({ error: "For security, this change requires a recent sign-in." });
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("requires a recent sign-in");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("a successful action closes it, and re-opening shows no stale error", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onConfirm = vi.fn().mockResolvedValueOnce({ error: "nope" }).mockResolvedValueOnce(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByText("Open"));
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByText("Open"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete lead" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
