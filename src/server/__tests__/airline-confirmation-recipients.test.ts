import { describe, it, expect } from "vitest";
import { buildRecipientOptions, normalizeRecipientEmail, resolveSelectedRecipients } from "../airline-confirmation-recipients";

describe("normalizeRecipientEmail", () => {
  it("trims and lower-cases a valid address", () => {
    expect(normalizeRecipientEmail("  Jane.Doe@Example.COM \n")).toBe("jane.doe@example.com");
  });
  it("rejects anything that is not exactly one plain address", () => {
    for (const bad of ["", "   ", "nope", "a@b", "a b@example.com", "a@example.com, b@example.com", "A <a@example.com>", "a@example.com\r\nBcc: b@example.com", "a@example.com;b@example.com", null, undefined, 42, {}]) {
      expect(normalizeRecipientEmail(bad)).toBeNull();
    }
  });
});

describe("buildRecipientOptions — which addresses are offered, and the default", () => {
  it("one address in both the Booking Form and the Contact is ONE entry listing both sources, selected by default", () => {
    const r = buildRecipientOptions({ bookingFormEmail: "jane@example.com", contactPrimaryEmail: "jane@example.com", contactEmails: [{ email: "jane@example.com", isPrimary: true }] });
    expect(r.options).toEqual([{ email: "jane@example.com", sources: ["booking-form", "contact"] }]);
    expect(r.defaultSelected).toEqual(["jane@example.com"]);
  });

  it("Booking Form address first, then every Contact address (primary first); only the Booking Form address is pre-selected", () => {
    const r = buildRecipientOptions({
      bookingFormEmail: "booking@example.com",
      contactPrimaryEmail: "primary@example.com",
      contactEmails: [
        { email: "work@example.com", isPrimary: false },
        { email: "primary@example.com", isPrimary: true },
      ],
    });
    expect(r.options.map((o) => o.email)).toEqual(["booking@example.com", "primary@example.com", "work@example.com"]);
    expect(r.defaultSelected).toEqual(["booking@example.com"]);
  });

  it("uppercase / whitespace duplicates collapse into one entry", () => {
    const r = buildRecipientOptions({
      bookingFormEmail: " JANE@example.com ",
      contactPrimaryEmail: "Jane@Example.com",
      contactEmails: [
        { email: "jane@example.com", isPrimary: true },
        { email: "JANE@EXAMPLE.COM", isPrimary: false },
      ],
    });
    expect(r.options).toEqual([{ email: "jane@example.com", sources: ["booking-form", "contact"] }]);
  });

  it("missing Booking Form address: the Contact's primary address becomes the default", () => {
    const r = buildRecipientOptions({ bookingFormEmail: null, contactPrimaryEmail: "primary@example.com", contactEmails: [{ email: "other@example.com", isPrimary: false }, { email: "primary@example.com", isPrimary: true }] });
    expect(r.options.map((o) => o.email)).toEqual(["primary@example.com", "other@example.com"]);
    expect(r.defaultSelected).toEqual(["primary@example.com"]);
  });

  it("missing Contact address(es): the Booking Form address alone is offered and selected", () => {
    const r = buildRecipientOptions({ bookingFormEmail: "booking@example.com", contactPrimaryEmail: null, contactEmails: [] });
    expect(r.options).toEqual([{ email: "booking@example.com", sources: ["booking-form"] }]);
    expect(r.defaultSelected).toEqual(["booking@example.com"]);
  });

  it("an invalid stored Booking Form address is dropped; the Contact's primary is then the default", () => {
    const r = buildRecipientOptions({ bookingFormEmail: "garbage", contactPrimaryEmail: "ok@example.com", contactEmails: [{ email: "ok@example.com", isPrimary: true }, { email: "also garbage", isPrimary: false }] });
    expect(r.options.map((o) => o.email)).toEqual(["ok@example.com"]);
    expect(r.defaultSelected).toEqual(["ok@example.com"]);
  });

  it("nothing valid anywhere: no options and nothing pre-selected", () => {
    const r = buildRecipientOptions({ bookingFormEmail: "", contactPrimaryEmail: undefined, contactEmails: [{ email: "x", isPrimary: true }] });
    expect(r).toEqual({ options: [], defaultSelected: [] });
  });

  it("when only non-primary Contact addresses exist and no Booking Form address, nothing is pre-selected (never 'send to everyone')", () => {
    const r = buildRecipientOptions({ bookingFormEmail: null, contactPrimaryEmail: null, contactEmails: [{ email: "a@example.com", isPrimary: false }, { email: "b@example.com", isPrimary: false }] });
    expect(r.options).toHaveLength(2);
    expect(r.defaultSelected).toEqual([]);
  });
});

describe("resolveSelectedRecipients — the server-side check of what the user ticked", () => {
  const options = [
    { email: "a@example.com", sources: ["booking-form" as const] },
    { email: "b@example.com", sources: ["contact" as const] },
    { email: "c@example.com", sources: ["contact" as const] },
  ];

  it("one, two and all selected come back normalized in option order", () => {
    expect(resolveSelectedRecipients(["b@example.com"], options)).toEqual({ ok: true, recipients: ["b@example.com"] });
    expect(resolveSelectedRecipients(["c@example.com", "a@example.com"], options)).toEqual({ ok: true, recipients: ["a@example.com", "c@example.com"] });
    expect(resolveSelectedRecipients(["a@example.com", "b@example.com", "c@example.com"], options)).toEqual({ ok: true, recipients: ["a@example.com", "b@example.com", "c@example.com"] });
  });

  it("none selected (or not a list) is refused with the required message", () => {
    for (const none of [[], undefined, null, "a@example.com", {}]) {
      expect(resolveSelectedRecipients(none, options)).toEqual({ ok: false, error: "Select at least one email address." });
    }
  });

  it("duplicates and case/whitespace variants collapse", () => {
    expect(resolveSelectedRecipients([" A@EXAMPLE.com", "a@example.com", "a@example.com "], options)).toEqual({ ok: true, recipients: ["a@example.com"] });
  });

  it("an address that is not one of the booking's verified addresses is rejected outright — no partial send", () => {
    for (const bad of [["z@evil.test"], ["a@example.com", "z@evil.test"], ["a@example.com\r\nBcc: z@evil.test"], [""], [null], [7]]) {
      const r = resolveSelectedRecipients(bad, options);
      expect(r.ok).toBe(false);
    }
  });
});
