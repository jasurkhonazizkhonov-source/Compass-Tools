import { describe, it, expect } from "vitest";
import { renderSequenceTemplate, type SequenceVariableContext } from "../sequence-variables";

const ctx: SequenceVariableContext = {
  contactFirstName: "Emma",
  contactLastName: "Rodriguez",
  contactPhone: "+13055550199",
  contactEmail: "emma@example.com",
  departureCity: "Miami",
  departureAirport: "MIA",
  arrivalCity: "London",
  arrivalAirport: "LHR",
  departureDate: "Sep 25, 2026",
  returnDate: "Oct 7, 2026",
  tripType: "Round Trip",
  cabinClass: "Economy",
  senderFirstName: "James",
  senderLastName: "Okafor",
  senderPhone: "+1-212-555-0104",
  senderEmail: "james.okafor@compasstools.dev",
  companyName: "Business Flights Travel",
};

describe("renderSequenceTemplate", () => {
  it("replaces lead/travel variables", () => {
    const out = renderSequenceTemplate(
      "Hi {{contact_first_name}}, following up on your trip from {{departure_city}} to {{arrival_city}}.",
      ctx
    );
    expect(out).toBe("Hi Emma, following up on your trip from Miami to London.");
  });

  it("replaces sender/agent variables per-enrollment", () => {
    const out = renderSequenceTemplate("Best, {{sender_first_name}} at {{company_name}}", ctx);
    expect(out).toBe("Best, James at Business Flights Travel");
  });

  it("is case-insensitive on the variable token", () => {
    const out = renderSequenceTemplate("{{CONTACT_FIRST_NAME}}", ctx);
    expect(out).toBe("Emma");
  });

  it("leaves unknown tokens untouched", () => {
    const out = renderSequenceTemplate("Hello {{not_a_real_variable}}", ctx);
    expect(out).toBe("Hello {{not_a_real_variable}}");
  });

  it("replaces the same variable used multiple times", () => {
    const out = renderSequenceTemplate("{{contact_first_name}} {{contact_first_name}}", ctx);
    expect(out).toBe("Emma Emma");
  });

  it("substitutes different sender variables for different agents on the same template", () => {
    const template = "Regards, {{sender_first_name}}";
    const out1 = renderSequenceTemplate(template, ctx);
    const out2 = renderSequenceTemplate(template, { ...ctx, senderFirstName: "Maria" });
    expect(out1).toBe("Regards, James");
    expect(out2).toBe("Regards, Maria");
  });
});
