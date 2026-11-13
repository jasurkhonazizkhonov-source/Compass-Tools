import { describe, it, expect } from "vitest";
import { PUBLIC_JSON_MAX_BYTES } from "../read-limited-json";
import { PUBLIC_FORM_MAX_BYTES } from "../read-limited-form";
import { MAX_UNSUBSCRIBE_REASON_LENGTH } from "@/lib/unsubscribe-reasons";

// Compatibility evidence for the request-size caps: the LARGEST request the real forms and the website's server can legitimately send must sit well below
// each cap, so no genuine submission can be refused. Synthetic data only. The field limits are the ones the endpoints themselves validate (see
// public-inquiry.ts, lead-intake.ts, unsubscribe-reasons.ts): names 200, phone 50, message 5,000, submission key 200, comment 1,000.

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const cjk = (n: number) => "中".repeat(n); // 3 bytes in UTF-8 each - the widest ordinary text
const control = (n: number) => "\u0001".repeat(n); // 6 bytes each once JSON-escaped - adversarial, not genuine

describe("JSON endpoints (contact-inquiry, crm-inquiry, lead-capture, subscribe): cap 64 KB", () => {
  const contactWorstCase = (message: string) => ({
    companyId: "c".repeat(30),
    firstName: cjk(200),
    lastName: cjk(200),
    email: `${"a".repeat(64)}@${"b".repeat(185)}.com`, // the longest address an email can have
    phone: "+".concat("1".repeat(49)),
    phoneCountry: "US",
    subject: "FLIGHT_REQUEST_HELP",
    message,
    companyWebsite: "",
    submissionId: `${"x".repeat(36)}.${"f".repeat(16)}`,
  });

  it("the largest genuine contact message (5,000 characters of 3-byte text, every other field at its maximum) is under a third of the cap", () => {
    const size = bytes(JSON.stringify(contactWorstCase(cjk(5000))));
    expect(size).toBeLessThan(PUBLIC_JSON_MAX_BYTES / 3);
  });

  it("even a message of 5,000 characters that each need a six-byte JSON escape stays under the cap (so only an abusive body can reach it)", () => {
    expect(bytes(JSON.stringify(contactWorstCase(control(5000))))).toBeLessThan(PUBLIC_JSON_MAX_BYTES);
  });

  it("the website API's own cap (32 KB, unchanged) leaves the same headroom for the largest genuine flight request", () => {
    const flight = {
      tripType: "MULTI_CITY",
      segments: Array.from({ length: 6 }, (_, i) => ({ from: "JFK", to: "LHR", departureDate: `2027-01-0${i + 1}` })),
      cabinClass: "BUSINESS",
      adults: 20,
      children: 20,
      infants: 20,
      preferredAirline: cjk(200),
      additionalNotes: cjk(5000),
      firstName: cjk(200),
      lastName: cjk(200),
      email: `${"a".repeat(64)}@${"b".repeat(185)}.com`,
      phone: "1".repeat(50),
      submissionId: "x".repeat(200),
    };
    expect(bytes(JSON.stringify(flight))).toBeLessThan(32 * 1024);
  });
});

describe("unsubscribe form: cap 32 KB", () => {
  it("a full-length comment of the widest text, with the token and reason, is far below the cap in either encoding", () => {
    const comment = cjk(MAX_UNSUBSCRIBE_REASON_LENGTH); // the textarea's maxlength
    const urlencoded = new URLSearchParams({ token: "t".repeat(64), reason: "TOO_MANY_EMAILS", comment }).toString();
    expect(bytes(urlencoded)).toBeLessThan(PUBLIC_FORM_MAX_BYTES / 2);
    // multipart adds a boundary and headers per field; allow generously for them
    const multipart = bytes(comment) + 3 * 200 + 64;
    expect(multipart).toBeLessThan(PUBLIC_FORM_MAX_BYTES / 2);
  });

  it("the caps are the documented values", () => {
    expect(PUBLIC_JSON_MAX_BYTES).toBe(64 * 1024);
    expect(PUBLIC_FORM_MAX_BYTES).toBe(32 * 1024);
    expect(MAX_UNSUBSCRIBE_REASON_LENGTH).toBe(1000);
  });
});
