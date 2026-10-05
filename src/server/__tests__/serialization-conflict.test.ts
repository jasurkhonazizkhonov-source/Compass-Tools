import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { isSerializationConflict } from "../serialization-conflict";

describe("isSerializationConflict", () => {
  it("recognises a P2034 known-request error and a 40001 driver code", () => {
    expect(isSerializationConflict(new Prisma.PrismaClientKnownRequestError("x", { code: "P2034", clientVersion: "t" }))).toBe(true);
    expect(isSerializationConflict(new Prisma.PrismaClientKnownRequestError("x", { code: "P2010", clientVersion: "t", meta: { code: "40001" } }))).toBe(true);
  });

  it("recognises a raw driver-adapter TransactionWriteConflict", () => {
    const err = Object.assign(new Error("TransactionWriteConflict"), { name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" } });
    expect(isSerializationConflict(err)).toBe(true);
  });

  it("does not treat other errors as a conflict", () => {
    expect(isSerializationConflict(new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "t" }))).toBe(false);
    expect(isSerializationConflict(Object.assign(new Error("boom"), { name: "DriverAdapterError", cause: { kind: "UniqueConstraintViolation" } }))).toBe(false);
    expect(isSerializationConflict(new Error("TransactionWriteConflict is mentioned"))).toBe(false);
    expect(isSerializationConflict(null)).toBe(false);
  });
});
