// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { LeadCapturedEvent, formatCapturedAt } from "../lead-captured-event";

// The Activity section's first entry: when the lead was ORIGINALLY created
// (Lead.createdAt), kept apart from accepted / reassigned / updated times.

const CREATED = new Date("2026-10-02T14:00:00Z"); // 7:00 AM Pacific (PDT)

describe("LeadCapturedEvent", () => {
  it("a website lead reads 'Lead Captured from Website' with the original timestamp from createdAt", () => {
    render(<LeadCapturedEvent createdAt={CREATED} source="WEBSITE" />);
    expect(screen.getByText("Lead Captured from Website")).toBeInTheDocument();
    expect(screen.getByText("October 2, 2026, 7:00 AM PDT")).toBeInTheDocument();
    expect(screen.getByText(/Original submission time/)).toBeInTheDocument();
  });

  it("renders a machine-readable <time> equal to the stored createdAt (never the browser's clock)", () => {
    const { container } = render(<LeadCapturedEvent createdAt={CREATED} source="WEBSITE" />);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-02T14:00:00.000Z");
  });

  it("a lead made some other way says so instead of claiming a website capture", () => {
    render(<LeadCapturedEvent createdAt={CREATED} source="PHONE" />);
    expect(screen.getByText("Lead Created — Incoming Call")).toBeInTheDocument();
    expect(screen.queryByText(/from Website/)).not.toBeInTheDocument();
    expect(screen.getByText(/Original creation time/)).toBeInTheDocument();
  });

  it("is explicit that it is not the accepted / reassigned / updated time", () => {
    render(<LeadCapturedEvent createdAt={CREATED} source="WEBSITE" />);
    expect(screen.getByText(/not when it was accepted, reassigned or last updated/)).toBeInTheDocument();
  });

  it("formats in the CRM's working time zone with the zone named, whatever zone the server runs in", () => {
    expect(formatCapturedAt(new Date("2026-01-15T17:30:00Z"))).toBe("January 15, 2026, 9:30 AM PST");
    expect(formatCapturedAt(new Date("2026-07-15T17:30:00Z"))).toBe("July 15, 2026, 10:30 AM PDT");
  });
});
