import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit coverage of the two reliability rules in createWebsiteFlightLead (the real-database proof is in
// actions/__integration__/website-api.integration.test.ts):
//   1. the LEAD_CREATED activity is written by the SAME nested insert as the Lead - never by a second call;
//   2. only a unique violation on the Lead PRIMARY KEY is a "duplicate"; every other failure is "failed", even if a lead with the
//      derived id exists.

const { leadCreate, leadFindUnique, logActivity } = vi.hoisted(() => ({ leadCreate: vi.fn(), leadFindUnique: vi.fn(), logActivity: vi.fn(async () => {}) }));

vi.mock("@/lib/prisma", () => ({
  prisma: { lead: { create: leadCreate, findUnique: leadFindUnique }, contact: { findUnique: vi.fn() } },
}));
vi.mock("@/server/contact-resolution", () => ({ resolveContactForNewLead: vi.fn(async () => ({ contactId: "contact-1", isNewContact: true })) }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/activity-log", () => ({ logActivity }));
vi.mock("@/server/queries/reference-data", () => ({ resolveAirportCodes: vi.fn(async () => ({})) }));

import { Prisma } from "@/generated/prisma/client";
import { createWebsiteFlightLead, isLeadIdCollision, type FlightInquiry } from "../lead-intake";

// The shape Prisma 7.9.1 + @prisma/adapter-pg actually produces (captured against a real PostgreSQL).
function p2002(modelName: string, fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName, driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { fields } } } },
  });
}

const DATA = { firstName: "Jane", lastName: "Traveler", phone: "+14155550100", tripType: "ROUND_TRIP", cabinClass: "ECONOMY", adults: 1, children: 0, infants: 0, submissionId: "submission-0001" } as FlightInquiry;
const params = { data: DATA, companyId: "company-1", submissionInfo: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  leadFindUnique.mockResolvedValue(null);
});

describe("isLeadIdCollision", () => {
  it("accepts only a P2002 on the Lead primary key", () => {
    expect(isLeadIdCollision(p2002("Lead", ["id"]))).toBe(true);
  });

  it.each([
    ["the nested fingerprint's primary key", p2002("LeadIngestFingerprint", ['"leadId"'])],
    ["another Lead column", p2002("Lead", ["contactId"])],
    ["a composite Lead constraint", p2002("Lead", ["id", "contactId"])],
    ["a different model's id", p2002("Contact", ["id"])],
    ["a non-unique Prisma error (P2003)", new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "test", meta: { modelName: "Lead" } })],
    ["a plain Error", new Error("Unique constraint failed on the fields: (`id`)")],
    ["a string", "P2002"],
    ["undefined", undefined],
  ])("rejects %s", (_name, err) => {
    expect(isLeadIdCollision(err)).toBe(false);
  });

  it("honours meta.target when a driver supplies it instead", () => {
    const err = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test", meta: { modelName: "Lead", target: ["id"] } });
    expect(isLeadIdCollision(err)).toBe(true);
  });
});

describe("createWebsiteFlightLead", () => {
  it("writes the LEAD_CREATED activity inside the lead's own insert, not through a second call", async () => {
    leadCreate.mockResolvedValue({ id: "lead-1" });
    const res = await createWebsiteFlightLead(params);
    expect(res).toEqual({ status: "created", id: "lead-1" });
    const data = leadCreate.mock.calls[0][0].data;
    expect(data.activities).toEqual({ create: [{ contactId: "contact-1", type: "LEAD_CREATED", description: "Lead created from website" }] });
    // CONTACT_CREATED is unchanged and still separate; no LEAD_CREATED goes through logActivity any more.
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ type: "CONTACT_CREATED" }));
  });

  it("a lost race on the Lead primary key is a duplicate of the existing lead", async () => {
    leadFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "lead-won" });
    leadCreate.mockRejectedValue(p2002("Lead", ["id"]));
    expect(await createWebsiteFlightLead(params)).toEqual({ status: "duplicate", id: "lead-won" });
  });

  it("any other failure is 'failed' even when a lead with the derived id exists", async () => {
    leadFindUnique.mockResolvedValue(null); // the early pre-check sees nothing...
    leadCreate.mockRejectedValue(new Error("connection terminated")); // ...then something unrelated breaks
    leadFindUnique.mockResolvedValueOnce(null).mockResolvedValue({ id: "lead-exists" }); // a row exists by now, but did not cause this failure
    expect(await createWebsiteFlightLead(params)).toEqual({ status: "failed" });
  });

  it("a unique violation on another table is 'failed', not a duplicate", async () => {
    leadFindUnique.mockResolvedValueOnce(null).mockResolvedValue({ id: "lead-exists" });
    leadCreate.mockRejectedValue(p2002("LeadIngestFingerprint", ['"leadId"']));
    expect(await createWebsiteFlightLead(params)).toEqual({ status: "failed" });
  });

  it("a Lead-id collision whose row cannot be read back is 'failed' (never an unverified duplicate)", async () => {
    leadFindUnique.mockResolvedValue(null);
    leadCreate.mockRejectedValue(p2002("Lead", ["id"]));
    expect(await createWebsiteFlightLead(params)).toEqual({ status: "failed" });
  });
});
