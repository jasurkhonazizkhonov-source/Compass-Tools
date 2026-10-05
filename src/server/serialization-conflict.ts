import { Prisma } from "@/generated/prisma/client";

/**
 * True when `err` is Postgres telling a SERIALIZABLE transaction it lost a race with another one
 * (safe to run again unchanged). Prisma reports this two ways: a P2034 known-request error, or — when
 * the conflict is raised while the driver adapter is running a statement inside the transaction — a
 * raw driver-adapter error whose cause is `TransactionWriteConflict` (SQLSTATE 40001).
 */
export function isSerializationConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === "P2034" || err.meta?.code === "40001";
  if (err instanceof Error && err.name === "DriverAdapterError") {
    const cause = (err as { cause?: { kind?: unknown } }).cause;
    return cause?.kind === "TransactionWriteConflict" || err.message === "TransactionWriteConflict";
  }
  return false;
}
