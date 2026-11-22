import { describe, it, expect } from "vitest";
import { cleanSearchQuery, contactSearchConditions, isCompleteEmailAddress, phoneSearchNeedles, viaContact } from "../contact-search";

// The filter is evaluated here against an in-memory customer list by a small interpreter of exactly the Prisma subset the module emits
// (AND / OR, string `contains` / `equals` with insensitive mode, and `some` on the emails / phones relations). Visibility (which records a viewer may open) is
// the callers' separate filter and is covered where those queries are tested; here the question is only "which of the visible customers does this text find".

type Row = {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  emails: Array<{ email: string }>;
  phones: Array<{ number: string }>;
};

const CONTACTS: Row[] = [
  { id: "ada", firstName: "Ada", middleName: "King", lastName: "Lovelace", primaryEmail: "ada.lovelace@example.com", primaryPhone: "+14155550123", emails: [{ email: "ada.lovelace@example.com" }, { email: "ada@work.test" }], phones: [{ number: "+14155550123" }, { number: "+61415555012" }] },
  { id: "adam", firstName: "Adam", middleName: null, lastName: "Smith", primaryEmail: "adam@example.com", primaryPhone: "+442071234567", emails: [{ email: "adam@example.com" }], phones: [{ number: "+442071234567" }] },
  { id: "lookalike", firstName: "Ada", middleName: null, lastName: "Lovelace-Byron", primaryEmail: "ada.lovelace@example.co", primaryPhone: "+13105550199", emails: [{ email: "ada.lovelace@example.co" }], phones: [{ number: "+13105550199" }] },
  { id: "grace", firstName: "Grace", middleName: null, lastName: "Hopper", primaryEmail: null, primaryPhone: null, emails: [], phones: [] },
];

type Where = Record<string, unknown>;
const strMatch = (value: string | null, f: { contains?: string; equals?: string; mode?: string }) => {
  if (value === null) return false;
  const a = f.mode === "insensitive" ? value.toLowerCase() : value;
  if (f.contains !== undefined) return a.includes(f.mode === "insensitive" ? f.contains.toLowerCase() : f.contains);
  if (f.equals !== undefined) return a === (f.mode === "insensitive" ? f.equals.toLowerCase() : f.equals);
  throw new Error("unsupported string filter");
};
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, val]) => {
    if (key === "AND") return (val as Where[]).every((w) => matches(row, w));
    if (key === "OR") return (val as Where[]).some((w) => matches(row, w));
    if (key === "emails") return row.emails.some((e) => strMatch(e.email, (val as { some: { email: never } }).some.email));
    if (key === "phones") return row.phones.some((p) => strMatch(p.number, (val as { some: { number: never } }).some.number));
    return strMatch((row as unknown as Record<string, string | null>)[key], val as never);
  });
}
const find = (text: string, emailRestricted: boolean) => {
  const conditions = contactSearchConditions(text, { emailRestricted });
  return CONTACTS.filter((c) => conditions.some((w) => matches(c, w as Where))).map((c) => c.id);
};

describe("searching by a complete email address", () => {
  it.each([true, false])("finds exactly that customer (restricted viewer: %s) - not the look-alike address", (restricted) => {
    expect(find("ada.lovelace@example.com", restricted)).toEqual(["ada"]);
  });
  it("is case-insensitive and ignores surrounding spaces, <> and mailto:", () => {
    for (const text of ["ADA.Lovelace@Example.COM", "  ada.lovelace@example.com  ", "<ada.lovelace@example.com>", "mailto:ada.lovelace@example.com"]) expect(find(text, true), text).toEqual(["ada"]);
  });
  it("finds the customer by a SECONDARY address too", () => {
    expect(find("ada@work.test", true)).toEqual(["ada"]);
  });
  it("a similar but different address finds only its own customer", () => {
    expect(find("ada.lovelace@example.co", true)).toEqual(["lookalike"]);
    expect(find("ada.lovelace@example.org", true)).toEqual([]);
  });
  it("an unknown address finds nothing (and the result does not depend on any other customer)", () => {
    expect(find("nobody@example.com", true)).toEqual([]);
  });
});

describe("a restricted viewer can never search by a FRAGMENT of an address (no oracle that rebuilds a hidden address piece by piece)", () => {
  it.each(["ada.love", "@example.com", "example.com", "ada.lovelace@", "lovelace@example", "ada@work", "work.test", "example"])("%s", (fragment) => {
    const restricted = find(fragment, true);
    // Only a NAME that happens to contain the text may match; the address itself never does for a restricted viewer.
    for (const id of restricted) {
      const c = CONTACTS.find((x) => x.id === id)!;
      expect(`${c.firstName} ${c.middleName ?? ""} ${c.lastName}`.toLowerCase()).toContain(fragment.toLowerCase());
    }
  });
  it("whereas a viewer who may see full addresses can search by a fragment", () => {
    expect(find("work.test", false)).toEqual(["ada"]);
    expect(find("@example.com", false).sort()).toEqual(["ada", "adam"]);
    expect(find("example.co", false).sort()).toEqual(["ada", "adam", "lookalike"]);
  });
  it("the conditions built for a restricted viewer contain no partial-email clause at all", () => {
    const text = JSON.stringify(contactSearchConditions("ada.love", { emailRestricted: true }));
    expect(text).not.toContain("primaryEmail");
    expect(text).not.toContain('"emails"');
  });
});

describe("searching by phone number", () => {
  it.each(["+14155550123", "4155550123", "415 555 0123", "(415) 555-0123", "+1 (415) 555-0123", "1-415-555-0123", "001 415 555 0123", "415.555.0123"])("%s finds Ada", (text) => {
    expect(find(text, true)).toEqual(["ada"]);
  });
  it("finds a customer by a secondary number, and by a national number with a trunk zero", () => {
    expect(find("+61 415 555 012", true)).toEqual(["ada"]);
    expect(find("0415 555 012", true)).toEqual(["ada"]);
  });
  it("a partial number of at least five digits finds by digits; shorter or non-phone texts are not treated as numbers", () => {
    expect(find("55501", true).sort()).toEqual(["ada", "lookalike"]);
    expect(phoneSearchNeedles("1234")).toEqual([]);
    expect(phoneSearchNeedles("ada 4155550123")).toEqual([]);
    expect(phoneSearchNeedles("1".repeat(16))).toEqual([]);
  });
  it("a phone number finds nobody else", () => {
    expect(find("+44 20 7123 4567", true)).toEqual(["adam"]);
    expect(find("999 999 9999", true)).toEqual([]);
  });
});

describe("searching by name", () => {
  it.each([
    ["ada", ["ada", "adam", "lookalike"]],
    ["Lovelace", ["ada", "lookalike"]],
    ["lovelace ada", ["ada", "lookalike"]],
    ["Ada Lovelace", ["ada", "lookalike"]],
    ["ada king lovelace", ["ada"]],
    ["love", ["ada", "lookalike"]],
    ["GRACE hopper", ["grace"]],
    ["smith adam", ["adam"]],
  ])("%s", (text, expected) => {
    expect(find(text as string, true).sort()).toEqual([...(expected as string[])].sort());
  });
  it("every word must match: an extra unknown word narrows to nothing", () => {
    expect(find("Ada Hopper", true)).toEqual([]);
    expect(find("Ada Smith", true)).toEqual(["adam"]); // partial words: "Ada" is part of "Adam"
  });
  it("a blank search finds nothing and builds no condition", () => {
    expect(contactSearchConditions("   ", { emailRestricted: true })).toEqual([]);
  });
});

describe("helpers", () => {
  it("cleanSearchQuery trims, collapses whitespace, strips mailto:/<> and bounds the length", () => {
    expect(cleanSearchQuery("  Ada    Lovelace ")).toBe("Ada Lovelace");
    expect(cleanSearchQuery("mailto:a@b.co")).toBe("a@b.co");
    expect(cleanSearchQuery("<a@b.co>")).toBe("a@b.co");
    expect(cleanSearchQuery("x".repeat(500))).toHaveLength(200);
  });
  it("isCompleteEmailAddress accepts ordinary addresses only", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.com", "o'brien@example.ie"]) expect(isCompleteEmailAddress(ok), ok).toBe(true);
    for (const bad of ["a@b", "@b.co", "a@", "a b@c.de", "a@b..co", "a@-b.co", "ada.lovelace@", "plain text", ""]) expect(isCompleteEmailAddress(bad), bad).toBe(false);
  });
  it("viaContact wraps every condition for a Lead / Quote / Booking filter, unchanged", () => {
    const c = contactSearchConditions("Ada", { emailRestricted: true });
    expect(viaContact(c)).toEqual(c.map((x) => ({ contact: x })));
  });
});
