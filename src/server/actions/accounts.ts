"use server";

import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import {
  canManageAccounts,
  isPaymentPermission,
  isPaymentPermissionGrantableForRole,
  PAYMENT_PERMISSION_LABELS,
  isBookingPermission,
  isBookingPermissionGrantableForRole,
  BOOKING_PERMISSION_LABELS,
} from "@/lib/permissions";

const ROLE_ENUM = z.enum(["ADMIN", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MANAGER", "MARKETING_AGENT"]);

const createAccountSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  role: ROLE_ENUM,
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

// Runtime-validated — matches createAccountSchema's shape so a role change
// can never be an arbitrary string, even via a manually-constructed request
// that bypasses TypeScript entirely. Previously this function trusted its
// TS parameter type alone with no runtime check at all.
const updateAccountSchema = z.object({
  fullName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: ROLE_ENUM.optional(),
  hiredAt: z.date().nullable().optional(),
  // Part 19 — office/city, admin-editable free text.
  location: z.string().nullable().optional(),
  // Part 14 — admin-set commission rate (percent, e.g. 10.00 = 10%). Only an
  // Admin may ever call updateAccount at all (see assertAdmin above), so no
  // separate self-edit restriction is needed here.
  commissionPercent: z.number().min(0).max(100).nullable().optional(),
  // Part 14 — admin-set tip percentage: how much of applicable gratuity is
  // credited to this user. Same admin-only guarantee as commissionPercent.
  tipPercent: z.number().min(0).max(100).nullable().optional(),
});

/** Every Admin manages only their OWN company's accounts (see the Company
 * model's comment in schema.prisma — there is no platform-level
 * super-admin in this app). Returns the calling admin's own Account. */
async function assertAdmin() {
  const current = await getCurrentAccount();
  if (!canManageAccounts(current?.role)) {
    throw new Error("Only Admins can manage accounts");
  }
  return current;
}

/** Confirms the target account belongs to the caller's own company —
 * without this, an admin could disable/promote/demote another company's
 * user simply by guessing their account id. Never trust the client's
 * navigation/UI to have only ever shown same-company accounts. */
async function assertSameCompany(tx: Prisma.TransactionClient | typeof prisma, accountId: string, callerCompanyId: string) {
  const target = await tx.account.findUnique({ where: { id: accountId }, select: { companyId: true } });
  if (!target || target.companyId !== callerCompanyId) {
    throw new Error("Account not found");
  }
}

/** Active Admins other than (optionally) one excluded account — the count
 * that matters when deciding whether disabling/demoting a specific account
 * would leave the CRM with zero active Administrators. Scoped to one
 * company — a healthy admin count in Company B says nothing about whether
 * Company A is about to lose its last admin. */
async function countOtherActiveAdmins(tx: Prisma.TransactionClient | typeof prisma, companyId: string, excludeAccountId?: string): Promise<number> {
  return tx.account.count({
    where: {
      companyId,
      role: "ADMIN",
      status: "ACTIVE",
      ...(excludeAccountId ? { id: { not: excludeAccountId } } : {}),
    },
  });
}

/** Translates a Postgres SERIALIZABLE conflict (two concurrent admin-safety
 * transactions racing each other) into a message worth retrying, rather
 * than a raw/confusing database error reaching the UI. */
function isSerializationConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2034" || err.meta?.code === "40001");
}
async function withSerializableRetryMessage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isSerializationConflict(err)) {
      throw new Error("This request conflicted with another simultaneous change — please try again.");
    }
    throw err;
  }
}

export async function createAccount(input: z.infer<typeof createAccountSchema>) {
  const current = await assertAdmin();
  const data = createAccountSchema.parse(input);
  // Deliberately not returning the created row — a raw Account carries
  // Decimal fields (commissionPercent/tipPercent) that cannot cross the
  // Server Action -> Client Component boundary. No caller today reads this
  // return value; narrow it explicitly if one ever needs to.
  await prisma.account.create({ data: { ...data, companyId: current!.companyId } });
  revalidatePath("/accounts");
  revalidatePath("/users");
}

export async function updateAccount(accountId: string, patch: z.infer<typeof updateAccountSchema>) {
  const current = await assertAdmin();
  const data = updateAccountSchema.parse(patch);

  // Deliberately not returning the updated row (see createAccount's same
  // comment) — no caller reads it today, and it would carry raw Decimal
  // commissionPercent/tipPercent straight into whichever Client Component
  // awaited this action.
  await withSerializableRetryMessage(() =>
    prisma.$transaction(
      async (tx) => {
        await assertSameCompany(tx, accountId, current!.companyId);

        if (data.role || data.email) {
          const existing = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { role: true, status: true } });
          const isLastActiveAdmin =
            existing.role === "ADMIN" && existing.status === "ACTIVE" && (await countOtherActiveAdmins(tx, current!.companyId, accountId)) === 0;

          // Guard against demoting the last active Admin away from ADMIN —
          // without this, an admin could accidentally (or another admin
          // could) leave the company with zero active Administrators and
          // no one left who can undo it.
          if (data.role && data.role !== "ADMIN" && isLastActiveAdmin) {
            throw new Error("Cannot change this account's role — it is the last active Administrator");
          }

          // Guard against the last active Admin changing their OWN email —
          // this is the CRM identity Google Sign-In matches against, so
          // losing track of it (typo, wrong address) would lock the
          // company out of the CRM entirely with no other admin left to
          // fix it. Only self-changes are blocked: an admin may still
          // change a DIFFERENT user's email freely (including another
          // admin's), same as any other field.
          if (data.email && accountId === current?.id && isLastActiveAdmin) {
            throw new Error("You cannot change your own email — you are currently the only active administrator");
          }
        }

        await tx.account.update({ where: { id: accountId }, data });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
}

export async function setAccountStatus(accountId: string, status: "ACTIVE" | "INACTIVE") {
  const current = await assertAdmin();
  // This dev-session auth has no self-service reactivation path — an admin
  // deactivating their own account would strand them with no way back in.
  if (status === "INACTIVE" && accountId === current?.id) {
    throw new Error("You cannot disable your own account");
  }

  await withSerializableRetryMessage(() =>
    prisma.$transaction(
      async (tx) => {
        await assertSameCompany(tx, accountId, current!.companyId);

        if (status === "INACTIVE") {
          const existing = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { role: true } });
          if (existing.role === "ADMIN") {
            const remaining = await countOtherActiveAdmins(tx, current!.companyId, accountId);
            if (remaining === 0) {
              throw new Error("Cannot disable this account — it is the last active Administrator");
            }
          }
          // Removing a user must also pull them out of active lead
          // distribution immediately — a stale LeadQueueEntry.isActive=true
          // row must never let a removed account receive a new lead. The
          // row itself (and its permanent position/history) is preserved,
          // not deleted, matching the same "deactivate, don't destroy"
          // policy applied to the Account itself.
          await tx.leadQueueEntry.updateMany({ where: { accountId }, data: { isActive: false } });
        }

        await tx.account.update({ where: { id: accountId }, data: { status } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
}

/**
 * Admin-only toggle for whether this account appears in the general
 * read-only /accounts directory (Pass 11 Part 1). Deliberately its own
 * tiny, focused mutation rather than folded into updateAccountSchema —
 * this is a directory-display preference, not an identity/compensation
 * field, and keeping it separate means it can never accidentally ride
 * along with (or be blocked by) the role/email admin-safety transaction
 * updateAccount runs. Does NOT touch status, lead queue membership,
 * sessions, ownership, or any other field — same same-company IDOR guard
 * as every other account mutation in this file.
 */
export async function setAccountsVisibility(accountId: string, visible: boolean) {
  const current = await assertAdmin();
  await assertSameCompany(prisma, accountId, current!.companyId);

  await prisma.account.update({
    where: { id: accountId },
    data: { accountsVisible: visible },
  });

  revalidatePath("/accounts");
  revalidatePath("/users");
}

const paymentPermissionsSchema = z.array(z.string());

/**
 * Admin-only grant/revoke of payment permissions — the explicit-grant layer
 * described in permissions.ts (a role opens the door, this array is the
 * only thing that actually opens the lock). Every value is re-validated
 * against the fixed PAYMENT_PERMISSIONS list and against the target
 * account's own role ceiling server-side, never trusting the client to
 * only ever send a legal combination.
 */
export async function updatePaymentPermissions(accountId: string, permissions: string[]) {
  const current = await assertAdmin();
  const requested = paymentPermissionsSchema.parse(permissions);

  const target = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { role: true, companyId: true } });
  if (target.companyId !== current!.companyId) {
    throw new Error("Account not found");
  }

  for (const permission of requested) {
    if (!isPaymentPermission(permission)) {
      throw new Error(`"${permission}" is not a recognized payment permission`);
    }
    if (!isPaymentPermissionGrantableForRole(permission, target.role)) {
      throw new Error(`${PAYMENT_PERMISSION_LABELS[permission]} cannot be granted to this role`);
    }
  }

  // Deliberately not returning the updated row — see createAccount's
  // comment on why a raw Account (Decimal fields included) must never be
  // handed back to the "use client" caller.
  await prisma.account.update({
    where: { id: accountId },
    data: { paymentPermissions: requested },
  });
  revalidatePath("/users");
}

const bookingPermissionsSchema = z.array(z.string());

/**
 * Admin-only grant/revoke of booking security permissions (currently just
 * bookings.reveal_ip) — same default-deny, explicit-grant, role-ceiling
 * validation as updatePaymentPermissions, kept as an independent array so
 * granting IP-reveal access is a separate decision from payment-reveal.
 */
export async function updateBookingPermissions(accountId: string, permissions: string[]) {
  const current = await assertAdmin();
  const requested = bookingPermissionsSchema.parse(permissions);

  const target = await prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { role: true, companyId: true } });
  if (target.companyId !== current!.companyId) {
    throw new Error("Account not found");
  }

  for (const permission of requested) {
    if (!isBookingPermission(permission)) {
      throw new Error(`"${permission}" is not a recognized booking permission`);
    }
    if (!isBookingPermissionGrantableForRole(permission, target.role)) {
      throw new Error(`${BOOKING_PERMISSION_LABELS[permission]} cannot be granted to this role`);
    }
  }

  // Deliberately not returning the updated row — see createAccount's
  // comment.
  await prisma.account.update({
    where: { id: accountId },
    data: { bookingPermissions: requested },
  });
  revalidatePath("/users");
}
