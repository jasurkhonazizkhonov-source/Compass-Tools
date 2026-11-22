// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@/test/rtl-setup";
import { SignInLocationCell, formatLocationLine } from "../sign-in-location";

// The Administrator-only Users table cell: city, region, country (+ code), time zone and source where they exist; honest about a country-only result; never invents a city.

const FULL = { city: "Frankfurt am Main", region: "Hesse", country: "Germany", countryCode: "DE", timeZone: "Europe/Berlin", source: "DBIP-City-Lite (2026-11-01)", note: "Approximate, estimated from the sign-in IP address (DBIP-City-Lite (2026-11-01), looked up 2026-11-22)" };

describe("SignInLocationCell", () => {
  it("shows city, region and country (with its code), the time zone and the source - city included", () => {
    render(<SignInLocationCell details={FULL} signedIn />);
    expect(screen.getByTestId("last-sign-in-place")).toHaveTextContent("Frankfurt am Main, Hesse, Germany (DE)");
    expect(screen.getByTestId("last-sign-in-timezone")).toHaveTextContent("Time zone: Europe/Berlin");
    expect(screen.getByTestId("last-sign-in-source")).toHaveTextContent("Source: DBIP-City-Lite (2026-11-01)");
    expect(screen.queryByTestId("last-sign-in-city-missing")).toBeNull();
  });

  it("a COUNTRY-ONLY result is shown as exactly that: the country, no invented city, and a plain note that the city was not determined", () => {
    render(<SignInLocationCell details={{ city: null, region: null, country: "Germany", countryCode: "DE", timeZone: null, source: "Cloudflare edge country (CF-IPCountry)", note: null }} signedIn />);
    expect(screen.getByTestId("last-sign-in-place")).toHaveTextContent("Germany (DE)");
    expect(screen.getByTestId("last-sign-in-city-missing")).toHaveTextContent(/city not determined/i);
    expect(screen.queryByTestId("last-sign-in-timezone")).toBeNull();
    expect(screen.getByTestId("last-sign-in-source")).toHaveTextContent("Cloudflare edge country (CF-IPCountry)");
  });

  it("region missing: city and country are shown, nothing is filled in", () => {
    render(<SignInLocationCell details={{ ...FULL, region: null }} signedIn />);
    expect(screen.getByTestId("last-sign-in-place")).toHaveTextContent("Frankfurt am Main, Germany (DE)");
  });

  it("a country code with no name is shown as the code; a repeated neighbour is dropped", () => {
    expect(formatLocationLine({ city: null, region: null, country: null, countryCode: "DE" })).toBe("DE");
    expect(formatLocationLine({ city: "Singapore", region: "Singapore", country: "Singapore", countryCode: null })).toBe("Singapore");
  });

  it("no location (the GeoIP database is missing, so nothing could be resolved): the cell says so and does not break", () => {
    const { unmount } = render(<SignInLocationCell details={{ city: null, region: null, country: null, countryCode: null, timeZone: null, source: null, note: null }} signedIn />);
    expect(screen.getByText("Location unavailable")).toBeInTheDocument();
    unmount();
    render(<SignInLocationCell details={undefined} signedIn={false} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("states that it is an estimate (tooltip) and claims no exact position", () => {
    const { container } = render(<SignInLocationCell details={FULL} signedIn />);
    expect(container.querySelector("[title]")?.getAttribute("title")).toMatch(/Approximate, estimated from the sign-in IP address/);
    expect(container.textContent).not.toMatch(/GPS|exact|street|latitude|longitude/i);
  });
});
