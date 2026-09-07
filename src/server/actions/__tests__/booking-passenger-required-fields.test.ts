import { describe, it, expect } from "vitest";
import { passengerSchema } from "../booking-schema";

// §19: DOB and gender must be required on every booking passenger, both
// client-side (booking-flow.tsx's validate()) and server-side (this
// schema) — the server side is the authoritative boundary since the
// client check alone can always be bypassed by calling the action
// directly. Tested here at the schema level directly rather than through
// the full submitBooking() pipeline (which needs an extensive mock of
// prisma/card-vault/session/headers unrelated to this specific rule).

const VALID_PASSENGER = {
  type: "ADULT" as const,
  firstName: "Jane",
  lastName: "Doe",
  dateOfBirth: "1990-01-01",
  gender: "FEMALE",
};

describe("passengerSchema — DOB and gender required", () => {
  it("accepts a passenger with both dateOfBirth and gender present", () => {
    expect(passengerSchema.safeParse(VALID_PASSENGER).success).toBe(true);
  });

  it("rejects a passenger missing dateOfBirth", () => {
    const { dateOfBirth, ...rest } = VALID_PASSENGER;
    void dateOfBirth;
    expect(passengerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a passenger with an empty-string dateOfBirth", () => {
    expect(passengerSchema.safeParse({ ...VALID_PASSENGER, dateOfBirth: "" }).success).toBe(false);
  });

  it("rejects a passenger missing gender", () => {
    const { gender, ...rest } = VALID_PASSENGER;
    void gender;
    expect(passengerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a passenger with an empty-string gender", () => {
    expect(passengerSchema.safeParse({ ...VALID_PASSENGER, gender: "" }).success).toBe(false);
  });

  it("still accepts a passenger with no optional fields beyond the required set", () => {
    expect(passengerSchema.safeParse(VALID_PASSENGER).success).toBe(true);
  });
});
