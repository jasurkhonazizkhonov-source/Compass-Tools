import { z } from "zod";

// Split out of booking.ts (a "use server" file) because Next.js only
// allows async function exports from "use server" files — a plain Zod
// schema object export there throws "A 'use server' file can only export
// async functions" at runtime. Kept here so both submitBooking() and the
// schema-level unit tests can import it directly.
export const passengerSchema = z.object({
  type: z.enum(["ADULT", "CHILD", "INFANT"]),
  firstName: z.string().min(1),
  middleName: z.string().optional(),
  lastName: z.string().min(1),
  dateOfBirth: z.string().min(1),
  gender: z.string().min(1),
  tsaKnownTravelerNumber: z.string().optional(),
  globalEntryNumber: z.string().optional(),
  frequentFlyerAirline: z.string().optional(),
  frequentFlyerNumber: z.string().optional(),
});
