// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@/test/rtl-setup";
import CrmSegmentError from "../error";

let mockPathname: string | null = "/leads";
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname }));

// Real gap found and fixed: this repo had ZERO error.tsx/global-error.tsx
// anywhere under src/app, so ANY uncaught exception rendering (crm)/
// layout.tsx (which every CRM page renders through) fell all the way to
// Next's own generic, full-document-replacing default error page — exactly
// the reported "This page couldn't load / A server error occurred" symptom.
// This file (src/app/error.tsx) is the fix: a scoped boundary that catches
// errors from (crm)/layout.tsx and below while staying inside the real
// root layout. These tests prove it distinguishes a server-side render
// failure (error.digest set) from a client-side one, always offers a
// working retry, and never renders the raw error message/stack to the
// user.

describe("CrmSegmentError (src/app/error.tsx)", () => {
  beforeEach(() => {
    mockPathname = "/leads";
  });

  it("shows the server-error message when the error carries a digest (a Server Component render failure)", () => {
    const error = Object.assign(new Error("Internal: something exploded"), { digest: "abc123" });
    render(<CrmSegmentError error={error} retry={() => {}} />);

    expect(screen.getByText(/server error occurred/i)).toBeInTheDocument();
    expect(screen.getByText(/Error ref: abc123/i)).toBeInTheDocument();
    // Never renders the raw error message to the user.
    expect(screen.queryByText(/something exploded/i)).not.toBeInTheDocument();
  });

  it("shows a generic retry message (no error ref) when there is no digest (a client-side error)", () => {
    const error = new Error("some client render error");
    render(<CrmSegmentError error={error} retry={() => {}} />);

    expect(screen.getByText(/went wrong loading this section/i)).toBeInTheDocument();
    expect(screen.queryByText(/Error ref:/i)).not.toBeInTheDocument();
  });

  it("offers a Return to Dashboard link on CRM pages", () => {
    mockPathname = "/leads/abc";
    render(<CrmSegmentError error={Object.assign(new Error("x"), { digest: "d1" })} retry={() => {}} />);
    expect(screen.getByRole("link", { name: /return to dashboard/i })).toHaveAttribute("href", "/dashboard");
    // The error ref stays visible so it can be matched to a server log.
    expect(screen.getByText(/Error ref: d1/i)).toBeInTheDocument();
  });

  it("does NOT offer the dashboard link to a customer on a quote/booking page (they have no CRM access)", () => {
    mockPathname = "/quote/some-token/book";
    render(<CrmSegmentError error={Object.assign(new Error("x"), { digest: "d2" })} retry={() => {}} />);
    expect(screen.queryByRole("link", { name: /return to dashboard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("calls retry() when the Try again button is clicked", () => {
    const retry = vi.fn();
    const error = Object.assign(new Error("boom"), { digest: "xyz" });
    render(<CrmSegmentError error={error} retry={retry} />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
