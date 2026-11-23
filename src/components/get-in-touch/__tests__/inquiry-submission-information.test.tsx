// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@/test/rtl-setup";

// The Admin inbox's "Submission & IP Information": the IP is masked on screen, the full address appears only after the audited Reveal action
// (bound to THIS inquiry and inbox) returns it, and a missing record says so plainly.

const revealAction = vi.fn();
vi.mock("@/server/actions/inquiry-submission", () => ({ revealInquirySubmissionIp: (...a: unknown[]) => revealAction(...a) }));
vi.mock("@/server/actions/lead-submission", () => ({ revealLeadSubmissionIp: vi.fn() })); // must NOT be the one used for an inquiry
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { InquirySubmissionInformation } = await import("../inquiry-submission-information");
const { revealLeadSubmissionIp } = await import("@/server/actions/lead-submission");

const info = { hasIp: true, ipVersion: "v4" as const, ipMasked: "203.x.x.x", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney" };
const createdAt = new Date(2026, 10, 13, 12, 0, 0);

beforeEach(() => {
  vi.clearAllMocks();
  revealAction.mockResolvedValue({ ipAddress: "203.0.113.42", ipVersion: "v4" });
});

describe("InquirySubmissionInformation", () => {
  it("shows the masked IP, version and approximate location - and never the full address", () => {
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={info} />);
    const box = screen.getByTestId("inquiry-submission-information");
    expect(box.textContent).toContain("203.x.x.x");
    expect(box.textContent).toMatch(/IPv4/);
    expect(box.textContent).toMatch(/Sydney/);
    expect(box.textContent).toMatch(/New South Wales/);
    expect(box.textContent).toMatch(/Australia/);
    expect(box.textContent).toMatch(/Australia\/Sydney/);
    expect(box.textContent).toMatch(/approximate/i);
    expect(box.textContent).not.toContain("203.0.113.42");
    expect(box.textContent).not.toMatch(/latitude|longitude/i);
  });

  it("Reveal calls the INQUIRY action with this inquiry id and inbox (never the lead action), shows the address briefly, and Hide conceals it", async () => {
    const user = userEvent.setup();
    render(<InquirySubmissionInformation inquiryId="inq-1" source="BUSINESS_FLIGHTS_WEBSITE" createdAt={createdAt} info={info} />);
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    await waitFor(() => expect(revealAction).toHaveBeenCalledWith("inq-1", "BUSINESS_FLIGHTS_WEBSITE"));
    expect(revealLeadSubmissionIp).not.toHaveBeenCalled();
    const shown = await screen.findByTestId("lead-ip-revealed");
    expect(shown.textContent).toContain("203.0.113.42");
    await user.click(within(shown).getByRole("button", { name: /Hide/ }));
    expect(screen.queryByTestId("lead-ip-revealed")).toBeNull();
    expect(screen.getByTestId("inquiry-submission-information").textContent).not.toContain("203.0.113.42");
  });

  it("a refusal (e.g. stale sign-in) is shown inline and no address appears", async () => {
    revealAction.mockResolvedValue({ error: "For security, Reveal requires a sign-in within the last 15 minutes. Sign out, sign back in, then try again." });
    const user = userEvent.setup();
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={info} />);
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign-in within the last 15 minutes/);
    expect(screen.queryByTestId("lead-ip-revealed")).toBeNull();
  });

  it("a thrown (denied) action is shown as a safe message, not a crash", async () => {
    revealAction.mockRejectedValue(new Error("You are not authorized to reveal this inquiry's submission IP"));
    const user = userEvent.setup();
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={info} />);
    await user.click(screen.getByRole("button", { name: /Reveal/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("lead-ip-revealed")).toBeNull();
  });

  it("a location-only record has no Reveal and says the IP is unknown by simply omitting it; an IP-only record says no location could be determined", () => {
    const { unmount } = render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={{ ...info, hasIp: false, ipMasked: null, ipVersion: null }} />);
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
    expect(screen.queryByText("IP Address (masked)")).toBeNull();
    unmount();
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={{ ...info, city: null, region: null, country: null, countryCode: null, timeZone: null }} />);
    expect(screen.getByTestId("inquiry-submission-information").textContent).toMatch(/No location could be determined/);
    expect(screen.queryByText("Approximate City")).toBeNull();
  });

  it("an inquiry with no record says so plainly instead of inventing anything", () => {
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={null} />);
    expect(screen.getByTestId("inquiry-submission-information").textContent).toMatch(/No IP address or location was recorded for this inquiry/);
    expect(screen.queryByRole("button", { name: /Reveal/ })).toBeNull();
  });
});

describe("InquirySubmissionInformation - the data licence credit", () => {
  it("credits DB-IP when the location came from its database, and credits nobody for an edge country or an empty location", () => {
    const { unmount } = render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={{ ...info, geoSource: "DBIP-City-Lite (2026-11-01)" }} />);
    expect(screen.getByTestId("geoip-attribution").textContent).toMatch(/DB-IP .*CC BY 4\.0/);
    unmount();
    const second = render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={{ ...info, geoSource: "Cloudflare edge country (CF-IPCountry)" }} />);
    expect(screen.queryByTestId("geoip-attribution")).toBeNull();
    second.unmount();
    render(<InquirySubmissionInformation inquiryId="inq-1" source="CRM_WEBSITE" createdAt={createdAt} info={{ hasIp: true, ipVersion: "v4", ipMasked: "203.x.x.x", city: null, region: null, country: null, countryCode: null, timeZone: null, geoSource: "DBIP-City-Lite (2026-11-01)" }} />);
    expect(screen.queryByTestId("geoip-attribution")).toBeNull();
  });
});
