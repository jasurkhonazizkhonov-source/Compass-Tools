// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@/test/rtl-setup";
import { AirlineLogo } from "../airline-logo";

// Portability pass, Item 3/9/15 — the airline-logo prop-wiring bug (a
// component reading the raw, unresolved DB column instead of the
// already-resolved fallback value) went undetected by every existing
// automated test because this codebase had no component-render test
// infrastructure at all. This file is the first of a small, targeted set
// added to close that specific gap — not a general testing-framework
// migration (see vitest.config.ts: the project-wide default stays
// environment: "node"; this file opts into jsdom for itself only via the
// `@vitest-environment` docblock above).
describe("AirlineLogo", () => {
  it("renders the real logo image when a logoUrl is provided", () => {
    render(<AirlineLogo name="Cathay Pacific" iata="CX" icao="CPA" logoUrl="https://images.kiwi.com/airlines/64x64/CX.png" />);
    const img = screen.getByRole("img", { name: "Cathay Pacific" });
    expect(img).toHaveAttribute("src", "https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("falls back to the boxed IATA code when logoUrl is null — the exact state every airline is in on a fresh/self-healed database", () => {
    render(<AirlineLogo name="Cathay Pacific" iata="CX" icao="CPA" logoUrl={null} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("falls back to the ICAO code when no IATA code is available", () => {
    render(<AirlineLogo name="Some Charter Airline" iata={null} icao="CHT" logoUrl={null} />);
    expect(screen.getByText("CHT")).toBeInTheDocument();
  });

  it("falls back to a generic plane icon (never a broken/empty box) when there is no logo AND no code at all", () => {
    const { container } = render(<AirlineLogo name="Unknown Airline" iata={null} icao={null} logoUrl={null} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("falls back to the boxed code if the logo image itself fails to load at render time (e.g. a broken/invalid stored URL) — never leaves a broken image showing", () => {
    render(<AirlineLogo name="Cathay Pacific" iata="CX" icao="CPA" logoUrl="https://images.kiwi.com/airlines/64x64/CX.png" />);
    const img = screen.getByRole("img", { name: "Cathay Pacific" });
    fireEvent.error(img);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("CX")).toBeInTheDocument();
  });

  it("exposes the airline name as the accessible name on the fallback badge too, not just the image case", () => {
    render(<AirlineLogo name="Cathay Pacific" iata="CX" icao={null} logoUrl={null} />);
    expect(screen.getByLabelText("Cathay Pacific")).toBeInTheDocument();
  });
});
