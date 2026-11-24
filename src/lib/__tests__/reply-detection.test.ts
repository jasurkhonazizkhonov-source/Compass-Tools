import { describe, it, expect } from "vitest";
import { automatedReason, classifyInboundMessage, extractEmailAddress, REPLY_METADATA_HEADERS, type InboundMessageMeta } from "../reply-detection";

// What counts as "the customer replied" - and, as importantly, what does not. A false stop silently ends a customer's follow-ups; a missed reply emails someone who already answered.
const OWN = ["agent@crm.example", "jane.doe@gmail.example"];
const msg = (over: Partial<InboundMessageMeta> & { headers?: Record<string, string> } = {}): InboundMessageMeta => ({
  id: "m-reply",
  threadId: "t-1",
  labelIds: ["INBOX", "UNREAD"],
  ...over,
  headers: { From: "Customer Name <Customer@Example.com>", ...(over.headers ?? {}) },
});

describe("a genuine reply", () => {
  it("a person's message in the conversation, not from our mailbox, is a reply (address lower-cased)", () => {
    expect(classifyInboundMessage(msg(), OWN)).toEqual({ kind: "reply", fromEmail: "customer@example.com" });
  });

  it("a reply from a DIFFERENT address than the one emailed (an assistant, a second address) is still a reply: the conversation ties it to our email", () => {
    expect(classifyInboundMessage(msg({ headers: { From: "assistant@other.example" } }), OWN)).toMatchObject({ kind: "reply", fromEmail: "assistant@other.example" });
  });

  it("a message that Gmail filed out of the inbox, or flagged as spam, is still a reply (it is a person answering)", () => {
    expect(classifyInboundMessage(msg({ labelIds: ["SPAM"] }), OWN).kind).toBe("reply");
    expect(classifyInboundMessage(msg({ labelIds: ["CATEGORY_UPDATES"] }), OWN).kind).toBe("reply");
  });

  it("Auto-Submitted: no (a human message that merely says so) is not treated as automatic", () => {
    expect(classifyInboundMessage(msg({ headers: { "Auto-Submitted": "no" } }), OWN).kind).toBe("reply");
  });

  it("header names are matched in any case", () => {
    expect(classifyInboundMessage(msg({ headers: { from: "x@example.com", "auto-submitted": "auto-replied" } }), OWN)).toMatchObject({ kind: "automated" });
  });
});

describe("our own mail never counts", () => {
  it("a message labelled SENT or DRAFT is ours", () => {
    expect(classifyInboundMessage(msg({ labelIds: ["SENT"] }), OWN)).toEqual({ kind: "own" });
    expect(classifyInboundMessage(msg({ labelIds: ["DRAFT"] }), OWN)).toEqual({ kind: "own" });
  });

  it("a message from the connected mailbox or the agent's CRM address is ours, whatever its labels", () => {
    expect(classifyInboundMessage(msg({ headers: { From: "Jane <JANE.DOE@gmail.example>" } }), OWN)).toEqual({ kind: "own" });
    expect(classifyInboundMessage(msg({ headers: { From: "agent@crm.example" } }), OWN)).toEqual({ kind: "own" });
  });

  it("the sequence email itself (a Gmail id the CRM recorded) is never a reply", () => {
    expect(classifyInboundMessage(msg({ id: "m-sent-1" }), OWN, new Set(["m-sent-1"]))).toEqual({ kind: "known-message" });
  });
});

describe("machine-generated messages never count", () => {
  it.each([
    ["an out-of-office answer", { "Auto-Submitted": "auto-replied" }, "auto-submitted"],
    ["an auto-generated notice", { "Auto-Submitted": "auto-generated" }, "auto-submitted"],
    ["a bulk-mail marker", { Precedence: "bulk" }, "precedence"],
    ["a list marker", { Precedence: "list" }, "precedence"],
    ["an auto-reply header", { "X-Autoreply": "yes" }, "auto-response"],
    ["an Exchange auto-response marker", { "X-Auto-Response-Suppress": "All" }, "auto-response"],
    ["a delivery failure", { "X-Failed-Recipients": "gone@example.com" }, "delivery-failure"],
    ["a bounce (empty return path)", { "Return-Path": "<>" }, "bounce"],
    ["a delivery-status report", { "Content-Type": 'multipart/report; report-type=delivery-status; boundary="x"' }, "delivery-report"],
    ["a read receipt", { "Content-Type": "multipart/report; report-type=disposition-notification" }, "delivery-report"],
  ])("%s", (_name, headers, reason) => {
    expect(classifyInboundMessage(msg({ headers }), OWN)).toEqual({ kind: "automated", reason });
  });

  it.each(["MAILER-DAEMON@mail.example", "postmaster@example.com", "noreply@shop.example", "no-reply@shop.example", "donotreply@shop.example", "bounces+abc@mg.example"])("a message from %s", (from) => {
    expect(classifyInboundMessage(msg({ headers: { From: from } }), OWN)).toEqual({ kind: "automated", reason: "machine-sender" });
  });

  it("a message with no usable sender cannot be called a person's reply", () => {
    expect(classifyInboundMessage(msg({ headers: { From: "" } }), OWN)).toEqual({ kind: "automated", reason: "no-sender" });
    expect(automatedReason(msg({ headers: { From: "(undisclosed)" } }))).toBeNull(); // automatedReason alone does not judge the sender's presence
  });
});

describe("extractEmailAddress", () => {
  it.each([
    ["Ann Lee <Ann.Lee@Example.com>", "ann.lee@example.com"],
    ['"Lee, Ann" <ann@example.com>', "ann@example.com"],
    ["ann@example.com", "ann@example.com"],
    ["mailto:ann@example.com", "ann@example.com"],
    ["", ""],
    ["no address here", ""],
  ])("%j -> %j", (input, expected) => {
    expect(extractEmailAddress(input)).toBe(expected);
  });
});

describe("what is requested from Gmail", () => {
  it("asks only for the few headers the rules need - never the subject, the recipient list or the body", () => {
    expect([...REPLY_METADATA_HEADERS]).toEqual(["From", "Auto-Submitted", "Precedence", "X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress", "X-Failed-Recipients", "Return-Path", "Content-Type"]);
    expect(REPLY_METADATA_HEADERS).not.toContain("Subject");
    expect(REPLY_METADATA_HEADERS).not.toContain("To");
  });
});
