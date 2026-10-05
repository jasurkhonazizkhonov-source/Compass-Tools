import { describe, it, expect } from "vitest";
import { deriveNotificationDestination, UNSPECIFIED_DESTINATION } from "../booking-destination";
import { buildNewSaleSubject } from "../email/templates";

const leg = (city: string, country: string, isExtraLeg = false) => ({ isExtraLeg, arrivalAirport: { city, country } });

describe("deriveNotificationDestination — the New Sale / Cancellation destination", () => {
  it("one-way and round trips report the arrival of the last leg", () => {
    expect(deriveNotificationDestination([leg("Minneapolis", "United States")])).toBe("Minneapolis, United States");
    expect(deriveNotificationDestination([leg("Paris", "France"), leg("New York", "United States")])).toBe("New York, United States");
  });

  it("multi-city: the FINAL stop, not the first or the farthest", () => {
    const trip = [leg("London", "United Kingdom"), leg("Rome", "Italy"), leg("Athens", "Greece"), leg("Istanbul", "Turkey")];
    expect(deriveNotificationDestination(trip)).toBe("Istanbul, Turkey");
  });

  it("extra (positioning / add-on) legs are skipped: the last REAL leg wins", () => {
    expect(deriveNotificationDestination([leg("Tokyo", "Japan"), leg("Osaka", "Japan", true)])).toBe("Tokyo, Japan");
  });

  it("when every leg is flagged extra the last leg is still used rather than inventing nothing", () => {
    expect(deriveNotificationDestination([leg("A", "X", true), leg("B", "Y", true)])).toBe("B, Y");
  });

  it("no itinerary at all falls back to a fixed phrase, never undefined / an IATA code / an internal id", () => {
    expect(deriveNotificationDestination([])).toBe(UNSPECIFIED_DESTINATION);
    expect(UNSPECIFIED_DESTINATION).toBe("an unspecified destination");
  });

  it("does not reorder or mutate the caller's array", () => {
    const trip = [leg("A", "X"), leg("B", "Y")];
    deriveNotificationDestination(trip);
    expect(trip.map((l) => l.arrivalAirport.city)).toEqual(["A", "B"]);
  });
});

describe("the subject for a multi-city sale uses city + country of the final stop", () => {
  it("normal / exchange / cancellation", () => {
    const destination = deriveNotificationDestination([leg("Frankfurt", "Germany"), leg("Minneapolis", "United States")]);
    const base = { agentFullName: "Andrew Kent", agentLocation: "Frankfurt", hireAgeCompact: "0Y0M11D", amount: "$287.00", destination };
    expect(buildNewSaleSubject(base)).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
    expect(buildNewSaleSubject({ ...base, label: "EXCHANGE" })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Exchange");
    expect(buildNewSaleSubject({ ...base, label: "CANCELLATION" })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Cancellation");
  });
});
