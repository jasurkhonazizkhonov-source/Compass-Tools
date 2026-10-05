import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BOOKING_REFERENCE_PREFIX, generateBookingReference } from "../booking-reference";
import { buildBookingConfirmationEmail, buildBookingSignedNotificationEmail } from "@/server/email/templates";

const company = { id: "c", name: "Test Travel Co", website: "https://t.example.com", phone: "1", brandColor: "#1c3a5e", logoEmailUrl: null, logoWebUrl: null, logoIconUrl: null, signatureTemplate: "Regards" } as never;
const pricing = { adults: 1, children: 0, infants: 0, adultPrice: 1, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1 };

describe("booking reference generation", () => {
  it("is one prefix constant plus 7 unambiguous characters, and effectively unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const ref = generateBookingReference();
      expect(ref).toMatch(new RegExp(`^${BOOKING_REFERENCE_PREFIX}[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{7}$`));
      seen.add(ref);
    }
    expect(seen.size).toBe(5000);
  });

  it("nothing else in the application generates or parses the prefix: the literal appears only in booking-reference.ts", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "__tests__" || e.name === "__integration__" || e.name === "generated" || e.name === "node_modules") continue;
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && /BFT-?/.test(fs.readFileSync(p, "utf8"))) {
          hits.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual(["src/lib/booking-reference.ts"]);
  });
});

describe("where the reference is (and is not) shown — the basis for treating it as an internal identifier", () => {
  it("the CUSTOMER booking confirmation email never prints the reference, whatever its value", () => {
    for (const ref of ["BFT-OLD1234", "BK-NEW1234", "ANYTHING"]) {
      const html = buildBookingConfirmationEmail({
        customerFirstName: "Jane", bookingReference: ref, segments: [], pricing, paymentMethods: [], paymentPaid: true, passengers: [],
        contactName: "Jane Doe", contactEmail: "j@example.com", contactPhone: "1", confirmations: [{ id: "1", airlineName: null, confirmationNumber: "ABC123", eTicketNumbers: [] }], company,
      }).html;
      expect(html).not.toContain(ref);
    }
  });

  it("the INTERNAL 'Booking Form Signed' staff email shows it exactly as stored — an old reference is never rewritten", () => {
    const e = (bookingReference: string) =>
      buildBookingSignedNotificationEmail({
        customerFullName: "Jane Doe", contactEmail: "j@example.com", contactPhone: "1", bookingReference, signedName: "Jane Doe", signedAt: new Date("2026-01-01T00:00:00Z"),
        ipAddress: null, segments: [], passengers: [], pricing, paymentMethods: [], paymentPaid: true, bookingUrl: "https://example.com/b/1", company,
      });
    for (const ref of ["BFT-OLD1234", generateBookingReference()]) {
      const r = e(ref);
      expect(r.subject).toBe(`Booking Form Signed — ${ref}`);
      expect(r.html).toContain(ref);
    }
  });
});
