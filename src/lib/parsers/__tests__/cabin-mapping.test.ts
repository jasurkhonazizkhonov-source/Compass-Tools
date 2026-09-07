import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { guessCabinFromBookingClass } from "../shared";

describe("guessCabinFromBookingClass", () => {
  it("maps common first-class RBDs", () => {
    expect(guessCabinFromBookingClass("F")).toBe("FIRST");
    expect(guessCabinFromBookingClass("A")).toBe("FIRST");
  });

  it("maps common business-class RBDs", () => {
    expect(guessCabinFromBookingClass("J")).toBe("BUSINESS");
    expect(guessCabinFromBookingClass("C")).toBe("BUSINESS");
    expect(guessCabinFromBookingClass("D")).toBe("BUSINESS");
  });

  it("maps common premium-economy RBDs", () => {
    expect(guessCabinFromBookingClass("W")).toBe("PREMIUM_ECONOMY");
  });

  it("maps common economy RBDs", () => {
    expect(guessCabinFromBookingClass("Y")).toBe("ECONOMY");
    expect(guessCabinFromBookingClass("Q")).toBe("ECONOMY");
    expect(guessCabinFromBookingClass("L")).toBe("ECONOMY");
  });

  it("is case-insensitive", () => {
    expect(guessCabinFromBookingClass("y")).toBe("ECONOMY");
  });

  it("returns undefined for an unrecognized letter rather than guessing", () => {
    expect(guessCabinFromBookingClass("Ω")).toBeUndefined();
  });
});

describe("parser cabin-class extraction (section 19 example)", () => {
  it("distinguishes booking class Y from flight number 1460 in BA1460Y", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E", 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.flightNumber).toBe("1460");
    expect(seg.bookingClass).toBe("Y");
    expect(seg.cabinGuess).toBe("ECONOMY");
  });

  it("does not ask for confirmation when the booking class confidently maps to a cabin", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E", 2026);
    expect(seg.uncertainFields).not.toContain("cabin");
    expect(seg.uncertainFields).not.toContain("bookingClass");
    expect(seg.warnings.some((w) => w.message.includes("Economy"))).toBe(false);
  });

  it("flags cabin as uncertain without inventing one when booking class is absent", () => {
    const [seg] = parseApolloItinerary("1 BA1460 25SEP LHREDI SS1 600P 725P", 2026);
    expect(seg.bookingClass).toBeUndefined();
    expect(seg.cabinGuess).toBeUndefined();
    expect(seg.uncertainFields).toContain("cabin");
  });

  it("correctly reads business class from J", () => {
    const [seg] = parseApolloItinerary("1 EK202J 15DEC JFKDXB SS1 1130P 800A FR", 2026);
    expect(seg.bookingClass).toBe("J");
    expect(seg.cabinGuess).toBe("BUSINESS");
  });

  it("does not confuse the flight number with the booking class", () => {
    const [seg] = parseApolloItinerary("1 UA905Y 05JUN ORD-LHR HK1 615P 800A", 2026);
    expect(seg.flightNumber).toBe("905");
    expect(seg.bookingClass).toBe("Y");
  });
});
