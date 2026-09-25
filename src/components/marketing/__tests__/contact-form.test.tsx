// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";
import { ContactForm } from "../contact-form";

// Regression coverage for the public /contact submission flow (Part 3).
// This is untrusted, public-facing input, so the tests below prove: valid
// submissions reach the existing, already-hardened API route with a fixed,
// non-user-editable companyId; client-side validation blocks obviously
// invalid input before any request is sent; and a server-side rejection is
// shown as a generic message, never a raw error/stack leaking to a visitor.

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  // userEvent simulates a single real user — issuing several type() calls
  // concurrently (e.g. via Promise.all) interleaves keystrokes across
  // fields and leaves react-hook-form's state incomplete; each call must
  // be awaited in turn.
  await user.type(screen.getByLabelText(/first name/i), "Jane");
  await user.type(screen.getByLabelText(/last name/i), "Doe");
  await user.type(screen.getByLabelText(/email/i), "jane@example.com");
  await user.type(screen.getByLabelText(/message/i), "I have a question about an upcoming trip.");
}

describe("ContactForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits with the fixed default-company id and the entered field values, never asking the visitor to choose a company", async () => {
    const user = userEvent.setup();
    render(<ContactForm />);
    await fillRequiredFields(user);

    await user.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/public/crm-inquiry");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.companyId).toBe("default-company");
    expect(body.firstName).toBe("Jane");
    expect(body.email).toBe("jane@example.com");
    expect(body.subject).toBe("GENERAL_INQUIRY");

    expect(screen.queryByText(/company/i, { selector: "label" })).not.toBeInTheDocument();
  });

  it("shows a professional confirmation state after a successful submission", async () => {
    const user = userEvent.setup();
    render(<ContactForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/thank you/i)).toBeInTheDocument();
  });

  it("blocks submission client-side for an invalid email, without calling the API", async () => {
    const user = userEvent.setup();
    render(<ContactForm />);
    await user.type(screen.getByLabelText(/first name/i), "Jane");
    await user.type(screen.getByLabelText(/last name/i), "Doe");
    await user.type(screen.getByLabelText(/email/i), "not-an-email");
    await user.type(screen.getByLabelText(/message/i), "Hello there");

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a generic error message (never a raw server/database error) when the API reports failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, error: "Something went wrong. Please try again." }) }))
    );
    const user = userEvent.setup();
    render(<ContactForm />);
    await fillRequiredFields(user);

    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.queryByText(/prisma|database|stack|econn/i)).not.toBeInTheDocument();
  });
});
