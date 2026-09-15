import { describe, it, expect } from "vitest";
import { safeErrorTag } from "../safe-error-log";

// Shared by google-auth.ts and proxy.ts (see safe-error-log.ts's own
// comment) specifically so a Prisma/driver error's message — which can
// embed connection-string fragments or other sensitive detail — never
// reaches a server log. This proves the contract every caller relies on:
// only the error's class name is ever returned, never its message.

describe("safeErrorTag", () => {
  it("returns the constructor name for a plain Error", () => {
    expect(safeErrorTag(new Error("connection terminated"))).toBe("Error");
  });

  it("returns the constructor name for a named Error subclass, never the message", () => {
    class PrismaClientInitializationError extends Error {}
    const err = new PrismaClientInitializationError("postgresql://user:secret@host/db unreachable");
    const tag = safeErrorTag(err);
    expect(tag).toBe("PrismaClientInitializationError");
    expect(tag).not.toContain("secret");
    expect(tag).not.toContain("postgresql");
  });

  it("never throws and returns a safe typeof-based tag for a non-Error thrown value", () => {
    expect(safeErrorTag("a raw string throw")).toBe("string");
    expect(safeErrorTag(null)).toBe("object");
    expect(safeErrorTag(undefined)).toBe("undefined");
    expect(safeErrorTag(42)).toBe("number");
  });
});
