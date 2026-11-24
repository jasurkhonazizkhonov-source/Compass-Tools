import { describe, it, expect } from "vitest";
import { recipientToStore } from "@/server/sequence-recipients";
import { activitySubject, enrollmentSender, senderForNewContactEnrollment, senderIsOneOf, type SenderAccount } from "@/server/sequence-sender";

const acct = (id: string): SenderAccount => ({ id, fullName: `Agent ${id}`, email: `${id}@example.test`, phone: null, companyId: "co" });

describe("what an enrollment stores as its recipient", () => {
  it("'primary' never stores anything (the primary is read at send time)", () => {
    expect(recipientToStore("primary", ["a@example.test"], "a@example.test")).toBeUndefined();
    expect(recipientToStore("primary", ["b@example.test"], "a@example.test")).toBeUndefined();
  });
  it("'all' stores the usable list - including a LONE address that is not the primary (the primary was unsubscribed, suppressed or invalid), which used to be dropped and then failed at send time", () => {
    expect(recipientToStore("all", ["a@example.test", "b@example.test"], "a@example.test")).toBe("a@example.test, b@example.test");
    expect(recipientToStore("all", ["b@example.test"], "a@example.test")).toBe("b@example.test");
    expect(recipientToStore("all", ["b@example.test"], null)).toBe("b@example.test");
  });
  it("'all' with only the primary usable needs no storing, whatever its case", () => {
    expect(recipientToStore("all", ["a@example.test"], "A@Example.test")).toBeUndefined();
    expect(recipientToStore("all", [], "a@example.test")).toBeUndefined();
  });
});

describe("who sends a sequence email", () => {
  it("a lead-based enrollment is sent by the lead's assigned agent, whatever the contact's owner or the enroller", () => {
    expect(enrollmentSender({ leadId: "l1", lead: { assignedAgent: acct("lead-agent") }, contact: { owner: acct("owner") }, enrolledBy: acct("enroller") })?.id).toBe("lead-agent");
    expect(enrollmentSender({ leadId: "l1", lead: { assignedAgent: null }, contact: { owner: acct("owner") }, enrolledBy: acct("enroller") })).toBeNull();
  });
  it("a contact-only enrollment is sent by the contact's owner, else by the account that enrolled it, else nobody", () => {
    expect(enrollmentSender({ leadId: null, lead: null, contact: { owner: acct("owner") }, enrolledBy: acct("enroller") })?.id).toBe("owner");
    expect(enrollmentSender({ leadId: null, lead: null, contact: { owner: null }, enrolledBy: acct("enroller") })?.id).toBe("enroller");
    expect(enrollmentSender({ leadId: null, lead: null, contact: { owner: null }, enrolledBy: null })).toBeNull();
  });
  it("the sender chosen at enrollment follows the same rule", () => {
    expect(senderForNewContactEnrollment(acct("owner"), acct("me"))?.id).toBe("owner");
    expect(senderForNewContactEnrollment(null, acct("me"))?.id).toBe("me");
  });
  it("the sender filter covers BOTH kinds, so a mailbox out of capacity holds back all of its rows", () => {
    expect(senderIsOneOf(["x"])).toEqual({
      OR: [{ lead: { assignedAgentId: { in: ["x"] } } }, { leadId: null, contact: { ownerId: { in: ["x"] } } }, { leadId: null, contact: { ownerId: null }, enrolledById: { in: ["x"] } }],
    });
  });
  it("history goes on the lead for a lead-based enrollment and on the contact for a contact-only one", () => {
    expect(activitySubject({ leadId: "l1", contactId: "c1" })).toEqual({ leadId: "l1" });
    expect(activitySubject({ leadId: null, contactId: "c1" })).toEqual({ contactId: "c1" });
  });
});
