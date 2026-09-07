import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 5 audit — addNote/deleteNote/updateNote previously had NO
// authorization or visibility check at all: any caller could attach a
// note to, or delete/rewrite, any lead/contact/note in any company by id
// alone. deleteNote/updateNote in particular took a caller-supplied
// `path: {contactId?, leadId?}` used only for revalidatePath — never
// actually checked against the note's real owner, a classic IDOR (pass a
// real noteId belonging to someone else, plus an unrelated/fabricated
// path, and the mutation still succeeded). This is a small, focused fake
// Prisma — just what the notes functions and the visibility helpers they
// now call actually touch — rather than extending the large existing
// leads.test.ts fake.

type FakeAccount = { id: string; role: string; companyId: string };
type FakeLead = { id: string; assignedAgentId: string | null; contact: { companyId: string } };
type FakeContact = { id: string; ownerId: string | null; companyId: string };
type FakeNote = { id: string; leadId: string | null; contactId: string | null; body: string };

let currentActor: FakeAccount | null;
let leads: Map<string, FakeLead>;
let contacts: Map<string, FakeContact>;
let notes: Map<string, FakeNote>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));

// A minimal but faithful re-implementation of leadVisibilityWhere/
// contactVisibilityWhere's actual matching semantics (canViewAllRecords:
// company-wide; everyone else: only their own assignedAgentId/ownerId) —
// this is what makes the test meaningful: it exercises the real
// canViewAllRecords-based branching, not just an id echo.
function canViewAllRecords(role: string) {
  return role === "ADMIN" || role === "MANAGER" || role === "TICKETING_AGENT";
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const lead = leads.get(where.id);
        if (!lead || !currentActor) return null;
        if (lead.contact.companyId !== currentActor.companyId && !canViewAllRecords(currentActor.role)) return null;
        if (canViewAllRecords(currentActor.role)) return lead.contact.companyId === currentActor.companyId ? { id: lead.id } : null;
        return lead.assignedAgentId === currentActor.id ? { id: lead.id } : null;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const contact = contacts.get(where.id);
        if (!contact || !currentActor) return null;
        if (canViewAllRecords(currentActor.role)) return contact.companyId === currentActor.companyId ? { id: contact.id } : null;
        return contact.ownerId === currentActor.id ? { id: contact.id } : null;
      }),
    },
    note: {
      create: vi.fn(async ({ data }: { data: { contactId?: string; leadId?: string; authorId?: string; body: string } }) => {
        const id = `note-${notes.size + 1}`;
        const note: FakeNote = { id, leadId: data.leadId ?? null, contactId: data.contactId ?? null, body: data.body };
        notes.set(id, note);
        return note;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const note = notes.get(where.id);
        if (!note) throw new Error("Note not found");
        return note;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        notes.delete(where.id);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { body: string } }) => {
        const note = notes.get(where.id)!;
        note.body = data.body;
      }),
    },
  },
}));

const { addNote, deleteNote, updateNote } = await import("../leads");

beforeEach(() => {
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" };
  leads = new Map([
    ["lead-mine", { id: "lead-mine", assignedAgentId: "agent-1", contact: { companyId: "company-1" } }],
    ["lead-other", { id: "lead-other", assignedAgentId: "agent-2", contact: { companyId: "company-1" } }],
  ]);
  contacts = new Map([
    ["contact-mine", { id: "contact-mine", ownerId: "agent-1", companyId: "company-1" }],
    ["contact-other", { id: "contact-other", ownerId: "agent-2", companyId: "company-1" }],
  ]);
  notes = new Map([
    ["note-on-my-lead", { id: "note-on-my-lead", leadId: "lead-mine", contactId: null, body: "original" }],
    ["note-on-other-lead", { id: "note-on-other-lead", leadId: "lead-other", contactId: null, body: "original" }],
  ]);
});

describe("addNote — authorization (Pass 5 IDOR fix)", () => {
  it("a restricted agent can add a note to their own lead", async () => {
    await expect(addNote({ leadId: "lead-mine", body: "hi" })).resolves.toBeDefined();
  });

  it("a restricted agent CANNOT add a note to a lead assigned to someone else", async () => {
    await expect(addNote({ leadId: "lead-other", body: "hi" })).rejects.toThrow("Lead not found");
  });

  it("a restricted agent CANNOT add a note to a contact owned by someone else", async () => {
    await expect(addNote({ contactId: "contact-other", body: "hi" })).rejects.toThrow("Contact not found");
  });

  it("an ADMIN can add a note to any lead in their company", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    await expect(addNote({ leadId: "lead-other", body: "hi" })).resolves.toBeDefined();
  });

  it("rejects a note with neither a leadId nor a contactId", async () => {
    await expect(addNote({ body: "hi" })).rejects.toThrow("must belong to a lead or a contact");
  });
});

describe("deleteNote / updateNote — IDOR fix: authorization is checked against the note's REAL owner, never the caller-supplied path", () => {
  it("a restricted agent can delete a note on their own lead", async () => {
    await expect(deleteNote("note-on-my-lead", {})).resolves.toBeUndefined();
    expect(notes.has("note-on-my-lead")).toBe(false);
  });

  it("a restricted agent CANNOT delete a note on a lead assigned to someone else, even when it passes its OWN lead's id as the revalidate `path` (the exact IDOR shape: real noteId + unrelated path)", async () => {
    await expect(deleteNote("note-on-other-lead", { leadId: "lead-mine" })).rejects.toThrow("Lead not found");
    // The note must still exist — the rejected authorization check must
    // have happened BEFORE the delete, not after.
    expect(notes.has("note-on-other-lead")).toBe(true);
  });

  it("a restricted agent CANNOT update (rewrite) a note on a lead assigned to someone else", async () => {
    await expect(updateNote("note-on-other-lead", "tampered", { leadId: "lead-mine" })).rejects.toThrow("Lead not found");
    expect(notes.get("note-on-other-lead")!.body).toBe("original");
  });

  it("a restricted agent CAN update their own note", async () => {
    await updateNote("note-on-my-lead", "edited", {});
    expect(notes.get("note-on-my-lead")!.body).toBe("edited");
  });
});
