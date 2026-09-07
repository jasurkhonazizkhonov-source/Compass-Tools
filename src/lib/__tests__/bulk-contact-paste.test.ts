import { describe, it, expect } from "vitest";
import { parsePasteGrid, classifyPasteCell, classifyPasteRows, detectHeaderColumnMap, hasAnyRecognizedHeaderCell, mapPasteRowsByHeader, matchAssignedUser } from "../bulk-contact-paste";

describe("parsePasteGrid", () => {
  it("splits rows by newline and columns by tab", () => {
    const grid = parsePasteGrid("John\tSmith\tjohn@example.com\nJane\tDoe\tjane@example.com");
    expect(grid).toEqual([
      ["John", "Smith", "john@example.com"],
      ["Jane", "Doe", "jane@example.com"],
    ]);
  });

  it("handles a single cell (no tabs/newlines) as a 1x1 grid", () => {
    expect(parsePasteGrid("John")).toEqual([["John"]]);
  });

  it("normalizes Windows-style CRLF line endings", () => {
    const grid = parsePasteGrid("John\tSmith\r\nJane\tDoe");
    expect(grid).toEqual([
      ["John", "Smith"],
      ["Jane", "Doe"],
    ]);
  });

  it("drops a trailing blank line from a copied spreadsheet range", () => {
    const grid = parsePasteGrid("John\tSmith\nJane\tDoe\n");
    expect(grid).toHaveLength(2);
  });

  it("preserves blank cells within a row", () => {
    const grid = parsePasteGrid("Sarah\tJohnson\tsarah@example.com\t\t+442071234567\tExisting client");
    expect(grid[0]).toEqual(["Sarah", "Johnson", "sarah@example.com", "", "+442071234567", "Existing client"]);
  });
});

describe("classifyPasteCell", () => {
  it("classifies an @-containing cell as email", () => {
    expect(classifyPasteCell("john@example.com")).toBe("email");
  });

  it("classifies a +-prefixed international number as phone", () => {
    expect(classifyPasteCell("+14155551234")).toBe("phone");
    expect(classifyPasteCell("+44 20 7123 4567")).toBe("phone");
    expect(classifyPasteCell("+49 151 12345678")).toBe("phone");
  });

  it("classifies a formatted domestic number as phone", () => {
    expect(classifyPasteCell("(415) 555-1234")).toBe("phone");
    expect(classifyPasteCell("415-555-1234")).toBe("phone");
  });

  it("classifies plain text as notes", () => {
    expect(classifyPasteCell("Important customer")).toBe("notes");
    expect(classifyPasteCell("VIP")).toBe("notes");
  });

  it("does not misclassify a short number-like string as a phone", () => {
    expect(classifyPasteCell("12")).toBe("notes");
  });
});

describe("classifyPasteRows — matches the spec's own worked example", () => {
  const grid = parsePasteGrid(
    "John\tSmith\tjohn@example.com\tjohn2@example.com\t+14155551234\tImportant customer\n" +
      "Sarah\tJohnson\tsarah@example.com\t\t+442071234567\tExisting client\n" +
      "Michael\tBrown\tmichael@example.com\tmike@gmail.com\t+4915112345678\tVIP"
  );

  it("extracts first/last name from the first two columns", () => {
    const rows = classifyPasteRows(grid, true);
    expect(rows[0].firstName).toBe("John");
    expect(rows[0].lastName).toBe("Smith");
    expect(rows[1].firstName).toBe("Sarah");
  });

  it("collects every email-shaped cell into emails, in order, without overwriting", () => {
    const rows = classifyPasteRows(grid, true);
    expect(rows[0].emails).toEqual(["john@example.com", "john2@example.com"]);
    expect(rows[2].emails).toEqual(["michael@example.com", "mike@gmail.com"]);
  });

  it("collects phone-shaped cells into phones", () => {
    const rows = classifyPasteRows(grid, true);
    expect(rows[0].phones).toEqual(["+14155551234"]);
    expect(rows[1].phones).toEqual(["+442071234567"]);
  });

  it("puts remaining plain-text cells into notes", () => {
    const rows = classifyPasteRows(grid, true);
    expect(rows[0].notes).toBe("Important customer");
    expect(rows[2].notes).toBe("VIP");
  });

  it("handles a blank email column (Sarah's row) without an empty-string entry", () => {
    const rows = classifyPasteRows(grid, true);
    expect(rows[1].emails).toEqual(["sarah@example.com"]);
  });

  it("skips a copied header row instead of treating it as row 1's data", () => {
    const withHeader = parsePasteGrid("First Name\tLast Name\tEmail\tPhone\nJohn\tSmith\tjohn@example.com\t+14155551234");
    const rows = classifyPasteRows(withHeader, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].firstName).toBe("John");
  });

  it("supports more email/phone columns than any fixed layout would predict — auto-detected by content, not position", () => {
    const wide = parsePasteGrid("Anna\tLee\tanna@work.com\tanna@personal.com\tanna@old.com\t+15551234567\t+15559876543");
    const rows = classifyPasteRows(wide, true);
    expect(rows[0].emails).toHaveLength(3);
    expect(rows[0].phones).toHaveLength(2);
  });
});

describe("classifyPasteRows — paste started in a non-name column", () => {
  it("does not assume name columns when assumeNameColumns is false", () => {
    const grid = parsePasteGrid("second@example.com\nthird@example.com");
    const rows = classifyPasteRows(grid, false);
    expect(rows[0].firstName).toBe("");
    expect(rows[0].lastName).toBe("");
    expect(rows[0].emails).toEqual(["second@example.com"]);
  });
});

describe("detectHeaderColumnMap — arbitrary column order (Part 9 / prior limitation #1)", () => {
  it("maps the spec's own example: Last Name | Email | First Name | Phone | Notes", () => {
    const map = detectHeaderColumnMap(["Last Name", "Email", "First Name", "Phone", "Notes"]);
    expect(map).toEqual(["lastName", "email", "firstName", "phone", "notes"]);
  });

  it("recognizes common header variants case-insensitively", () => {
    expect(detectHeaderColumnMap(["firstname", "LASTNAME", "EMAIL ADDRESS", "mobile phone"])).toEqual([
      "firstName",
      "lastName",
      "email",
      "phone",
    ]);
  });

  it("recognizes numbered email/phone headers", () => {
    expect(detectHeaderColumnMap(["First Name", "Last Name", "Email 1", "Email 2", "Phone 1"])).toEqual([
      "firstName",
      "lastName",
      "email",
      "email",
      "phone",
    ]);
  });

  it("recognizes an Assigned User header", () => {
    expect(detectHeaderColumnMap(["First Name", "Last Name", "Assigned User"])).toEqual(["firstName", "lastName", "assignedUser"]);
  });

  it("returns null (fall back to positional detection) when a column isn't recognized", () => {
    expect(detectHeaderColumnMap(["First Name", "Last Name", "Company", "Email"])).toBeNull();
  });

  it("returns null for a plain data row (not a header at all)", () => {
    expect(detectHeaderColumnMap(["John", "Smith", "john@example.com"])).toBeNull();
  });

  it("tolerates a blank trailing header cell", () => {
    expect(detectHeaderColumnMap(["First Name", "Last Name", "Email", ""])).toEqual(["firstName", "lastName", "email", null]);
  });
});

describe("hasAnyRecognizedHeaderCell", () => {
  it("is true when at least one cell is a recognized header, even if others aren't", () => {
    expect(hasAnyRecognizedHeaderCell(["First Name", "Last Name", "Company"])).toBe(true);
  });

  it("is false for a plain data row", () => {
    expect(hasAnyRecognizedHeaderCell(["John", "Smith", "john@example.com"])).toBe(false);
  });
});

describe("mapPasteRowsByHeader", () => {
  it("maps data rows using a reordered header, skipping the header row itself", () => {
    const grid = [
      ["Last Name", "Email", "First Name", "Phone", "Notes"],
      ["Smith", "john@example.com", "John", "+14155551234", "Important customer"],
    ];
    const columnMap = detectHeaderColumnMap(grid[0])!;
    const rows = mapPasteRowsByHeader(grid, columnMap);
    expect(rows).toEqual([
      { firstName: "John", lastName: "Smith", emails: ["john@example.com"], phones: ["+14155551234"], notes: "Important customer", assignedUserRaw: "" },
    ]);
  });

  it("accumulates multiple columns mapped to the same field, in left-to-right order", () => {
    const grid = [
      ["First Name", "Last Name", "Email 1", "Email 2"],
      ["John", "Smith", "john@work.com", "john@home.com"],
    ];
    const columnMap = detectHeaderColumnMap(grid[0])!;
    const rows = mapPasteRowsByHeader(grid, columnMap);
    expect(rows[0].emails).toEqual(["john@work.com", "john@home.com"]);
  });

  it("captures the Assigned User column's raw text for the caller to match", () => {
    const grid = [
      ["First Name", "Last Name", "Assigned User"],
      ["John", "Smith", "Nigora Dadabaeva"],
    ];
    const columnMap = detectHeaderColumnMap(grid[0])!;
    const rows = mapPasteRowsByHeader(grid, columnMap);
    expect(rows[0].assignedUserRaw).toBe("Nigora Dadabaeva");
  });
});

describe("matchAssignedUser — exact match only (Part 10)", () => {
  const agents = [
    { id: "a1", fullName: "Nigora Dadabaeva", email: "nigora@example.com" },
    { id: "a2", fullName: "Andrew Kent", email: "andrew@example.com" },
    { id: "a3", fullName: "Nigora Dadabaeva", email: "nigora2@example.com" }, // duplicate name on purpose
  ];

  it("matches an exact, unambiguous full name (case-insensitive)", () => {
    expect(matchAssignedUser("andrew kent", agents)).toBe("a2");
  });

  it("matches an exact email", () => {
    expect(matchAssignedUser("nigora@example.com", agents)).toBe("a1");
  });

  it("does NOT guess when the name is ambiguous (two agents share it)", () => {
    expect(matchAssignedUser("Nigora Dadabaeva", agents)).toBeNull();
  });

  it("returns null for no match at all, rather than a partial/fuzzy guess", () => {
    expect(matchAssignedUser("Someone Else", agents)).toBeNull();
  });

  it("returns null for a blank value", () => {
    expect(matchAssignedUser("", agents)).toBeNull();
    expect(matchAssignedUser("   ", agents)).toBeNull();
  });
});
