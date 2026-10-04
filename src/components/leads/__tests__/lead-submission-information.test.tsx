// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { LeadSubmissionInformation, type LeadSubmissionDetails } from "../lead-submission-information";

const CREATED = new Date("2026-08-21T21:32:00Z"); // 14:32 PDT
const FULL: LeadSubmissionDetails = { ipAddress: "203.0.113.42", ipVersion: "v4", city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles", budgetCurrency: "AUD" };

describe("LeadSubmissionInformation", () => {
  it("shows the canonical submission time (Pacific), full IP, approximate city/country, region, timezone and budget currency", () => {
    render(<LeadSubmissionInformation createdAt={CREATED} info={FULL} fromWebsite />);
    expect(screen.getByText("Lead Submission Information")).toBeInTheDocument();
    expect(screen.getByText("August 21, 2026, 2:32 PM PDT")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.42")).toBeInTheDocument();
    expect(screen.getByText("v4")).toBeInTheDocument();
    expect(screen.getByText("Approximate City")).toBeInTheDocument();
    expect(screen.getByText("Los Angeles")).toBeInTheDocument();
    expect(screen.getByText("Approximate Country")).toBeInTheDocument();
    expect(screen.getByText("United States (US)")).toBeInTheDocument();
    expect(screen.getByText("California")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
    expect(screen.getByText("AUD")).toBeInTheDocument();
    expect(screen.getByText(/estimated from the IP address/i)).toBeInTheDocument();
    expect(screen.getByText(/not the customer's exact position/i)).toBeInTheDocument();
  });

  it("the submission time is the lead's creation time — it does not move with any other timestamp", () => {
    const { rerender } = render(<LeadSubmissionInformation createdAt={CREATED} info={FULL} fromWebsite />);
    expect(screen.getByText("August 21, 2026, 2:32 PM PDT")).toBeInTheDocument();
    rerender(<LeadSubmissionInformation createdAt={CREATED} info={{ ...FULL, city: "Elsewhere" }} fromWebsite />);
    expect(screen.getByText("August 21, 2026, 2:32 PM PDT")).toBeInTheDocument();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(CREATED.toISOString());
  });

  it("an IPv6 address is shown in full and wraps instead of breaking the layout", () => {
    const v6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
    render(<LeadSubmissionInformation createdAt={CREATED} info={{ ...FULL, ipAddress: v6, ipVersion: "v6" }} fromWebsite />);
    const el = screen.getByText(v6);
    expect(el.className).toMatch(/break-all/);
    expect(screen.getByText("v6")).toBeInTheDocument();
  });

  it("long place names wrap", () => {
    render(<LeadSubmissionInformation createdAt={CREATED} info={{ ...FULL, city: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch", country: "Saint Vincent and the Grenadines", countryCode: "VC" }} fromWebsite />);
    expect(screen.getByText("Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch").closest("dd")?.className).toMatch(/break-words/);
  });

  it("shows ONLY fields that exist — city unavailable means no city row, and nothing is made up", () => {
    render(<LeadSubmissionInformation createdAt={CREATED} info={{ ipAddress: "198.51.100.7", ipVersion: "v4", city: null, region: null, country: "United Kingdom", countryCode: "GB", timeZone: null }} fromWebsite />);
    expect(screen.getByText("198.51.100.7")).toBeInTheDocument();
    expect(screen.getByText("United Kingdom (GB)")).toBeInTheDocument();
    for (const label of ["Approximate City", "Region", "Timezone", "Budget currency"]) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("IP known but no location: the IP is shown and the note says no location could be determined", () => {
    render(<LeadSubmissionInformation createdAt={CREATED} info={{ ipAddress: "198.51.100.7", ipVersion: "v4", city: null, region: null, country: null, countryCode: null, timeZone: null }} fromWebsite />);
    expect(screen.getByText("198.51.100.7")).toBeInTheDocument();
    expect(screen.queryByText("Approximate City")).not.toBeInTheDocument();
    expect(screen.getByText(/No location could be determined/)).toBeInTheDocument();
  });

  it("no row at all: a website lead says nothing was recorded; a non-website lead renders nothing", () => {
    const { container, rerender } = render(<LeadSubmissionInformation createdAt={CREATED} info={null} fromWebsite />);
    expect(screen.getByText(/No IP address or location was recorded/)).toBeInTheDocument();
    rerender(<LeadSubmissionInformation createdAt={CREATED} info={null} fromWebsite={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never claims exact location", () => {
    render(<LeadSubmissionInformation createdAt={CREATED} info={FULL} fromWebsite />);
    expect(document.body.textContent).not.toMatch(/physically|exact address|located at|GPS/i);
  });
});
