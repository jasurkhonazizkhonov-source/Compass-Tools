// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@/test/rtl-setup";

const revealMock = vi.fn();
const toastError = vi.fn();
vi.mock("@/server/actions/lead-submission", () => ({ revealLeadSubmissionIp: (...a: unknown[]) => revealMock(...a) }));
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn() } }));

import { LeadSubmissionInformation, type LeadSubmissionDetails } from "../lead-submission-information";

const CREATED = new Date("2026-08-21T21:32:00Z"); // 14:32 PDT
const FULL: LeadSubmissionDetails = { hasIp: true, ipVersion: "v4", ipMasked: "203.x.x.x", city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles", budgetCurrency: "AUD" };
const FULL_IP = "203.0.113.42";

const view = (info: LeadSubmissionDetails | null, over: Partial<{ fromWebsite: boolean; canRevealIp: boolean }> = {}) =>
  render(<LeadSubmissionInformation leadId="lead-1" createdAt={CREATED} info={info} fromWebsite={over.fromWebsite ?? true} canRevealIp={over.canRevealIp ?? false} />);
const pageHas = (t: string) => document.body.textContent!.includes(t);

beforeEach(() => {
  revealMock.mockReset();
  toastError.mockReset();
});

describe("LeadSubmissionInformation", () => {
  it("shows the canonical submission time (Pacific), the MASKED IP, approximate city/country, region, timezone and budget currency", () => {
    view(FULL);
    expect(screen.getByText("Submission & IP Information")).toBeInTheDocument();
    expect(screen.getByText("August 21, 2026, 2:32 PM PDT")).toBeInTheDocument();
    expect(screen.getByText("203.x.x.x")).toBeInTheDocument();
    expect(screen.getByText("IP Address (masked)")).toBeInTheDocument();
    expect(screen.getByText("IP Version")).toBeInTheDocument();
    expect(screen.getByText("IPv4")).toBeInTheDocument();
    expect(screen.getByText("Approximate City")).toBeInTheDocument();
    expect(screen.getByText("Los Angeles")).toBeInTheDocument();
    expect(screen.getByText("Approximate Country")).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();
    expect(screen.getByText("Country Code")).toBeInTheDocument();
    expect(screen.getByText("US")).toBeInTheDocument();
    expect(screen.getByText("Approximate Region")).toBeInTheDocument();
    expect(screen.getByText("California")).toBeInTheDocument();
    expect(screen.getByText("Time Zone")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
    expect(screen.getByText("AUD")).toBeInTheDocument();
    expect(screen.getByText("Location is approximate and derived from the submitting IP address.")).toBeInTheDocument();
    expect(pageHas(FULL_IP)).toBe(false);
    // never mislabelled as a customer / exact / physical location, never a placeholder
    expect(document.body.textContent).not.toMatch(/Customer Location|Exact Location|Physical Location|undefined|null|Unknown/);
  });

  it("the full address is never in the rendered output, and a viewer without the IP-reveal permission gets no Reveal button", () => {
    view(FULL, { canRevealIp: false });
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(revealMock).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(FULL_IP);
  });

  it("the submission time is the lead's creation time", () => {
    view(FULL);
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(CREATED.toISOString());
  });

  it("an IPv6 address is masked to its first hextet", () => {
    view({ ...FULL, ipMasked: "2001:x:x:x:x:x:x:x", ipVersion: "v6" });
    expect(screen.getByText("2001:x:x:x:x:x:x:x").className).toMatch(/break-all/);
    expect(screen.getByText("IPv6")).toBeInTheDocument();
  });

  it("long place names wrap", () => {
    view({ ...FULL, city: "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch", country: "Saint Vincent and the Grenadines", countryCode: "VC" });
    expect(screen.getByText("Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch").closest("dd")?.className).toMatch(/break-words/);
  });

  it("shows ONLY fields that exist — city unavailable means no city row", () => {
    view({ hasIp: true, ipVersion: "v4", ipMasked: "198.x.x.x", city: null, region: null, country: "United Kingdom", countryCode: "GB", timeZone: null });
    expect(screen.getByText("United Kingdom")).toBeInTheDocument();
    expect(screen.getByText("GB")).toBeInTheDocument();
    for (const label of ["Approximate City", "Approximate Region", "Time Zone", "Budget currency"]) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });

  it("IP known but no location: the note says no location could be determined", () => {
    view({ hasIp: true, ipVersion: "v4", ipMasked: "198.x.x.x", city: null, region: null, country: null, countryCode: null, timeZone: null });
    expect(screen.queryByText("Approximate City")).not.toBeInTheDocument();
    expect(screen.getByText(/No location could be determined/)).toBeInTheDocument();
  });

  it("no IP captured: no IP row at all", () => {
    view({ hasIp: false, ipVersion: null, ipMasked: null, city: "Paris", region: null, country: "France", countryCode: "FR", timeZone: null });
    expect(screen.queryByText("IP Address")).not.toBeInTheDocument();
  });

  it("a brand-new website lead with no row yet says the information is not available yet — it does not claim nothing was recorded", () => {
    render(<LeadSubmissionInformation leadId="lead-1" createdAt={new Date(Date.now() - 60_000)} info={null} fromWebsite canRevealIp={false} />);
    expect(screen.getByText(/Submission information is not available yet/)).toBeInTheDocument();
    expect(screen.queryByText(/was recorded for this submission/)).not.toBeInTheDocument();
  });

  it("no row at all: an older website lead says nothing was recorded; a non-website lead renders nothing", () => {
    const { container, rerender } = view(null);
    expect(screen.getByText(/No IP address or location was recorded/)).toBeInTheDocument();
    rerender(<LeadSubmissionInformation leadId="lead-1" createdAt={CREATED} info={null} fromWebsite={false} canRevealIp={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("never claims exact location", () => {
    view(FULL);
    expect(document.body.textContent).not.toMatch(/physically|exact address|located at|GPS/i);
  });
});

describe("Reveal (permission-gated, audited, recent sign-in)", () => {
  it("an authorised viewer reveals the full IP on click: shown in a privileged, timed container, with the lead id sent to the action", async () => {
    revealMock.mockResolvedValue({ ipAddress: FULL_IP, ipVersion: "v4" });
    view(FULL, { canRevealIp: true });
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHas(FULL_IP)).toBe(true));
    expect(revealMock).toHaveBeenCalledWith("lead-1");
    expect(screen.getByText(/Full IP address — privileged view, auto-hides in/)).toBeInTheDocument();
  });

  it("Hide conceals it again, and window blur and unmount conceal it too", async () => {
    revealMock.mockResolvedValue({ ipAddress: FULL_IP, ipVersion: "v4" });
    const { unmount } = view(FULL, { canRevealIp: true });
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHas(FULL_IP)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: /hide/i }));
    expect(pageHas(FULL_IP)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHas(FULL_IP)).toBe(true));
    await act(async () => {});
    act(() => void window.dispatchEvent(new Event("blur")));
    expect(pageHas(FULL_IP)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHas(FULL_IP)).toBe(true));
    unmount();
    expect(pageHas(FULL_IP)).toBe(false);
  });

  it("a stale sign-in comes back as a returned message: shown inline, nothing revealed, the page does not crash", async () => {
    revealMock.mockResolvedValue({ error: "For security, Reveal requires a sign-in within the last 15 minutes. Sign out, sign back in, then try again." });
    view(FULL, { canRevealIp: true });
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign-in within the last 15 minutes/);
    expect(pageHas(FULL_IP)).toBe(false);
  });

  it("a thrown (masked) denial becomes a readable fallback, never raw digest text", async () => {
    revealMock.mockRejectedValue(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"));
    view(FULL, { canRevealIp: true });
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to reveal the submission IP. You may not have permission.");
    expect(document.body.textContent).not.toMatch(/Server Components render|digest/);
  });

  it("never writes the address to browser storage or cookies", async () => {
    revealMock.mockResolvedValue({ ipAddress: FULL_IP, ipVersion: "v4" });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    view(FULL, { canRevealIp: true });
    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    await waitFor(() => expect(pageHas(FULL_IP)).toBe(true));
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(FULL_IP);
  });
});
