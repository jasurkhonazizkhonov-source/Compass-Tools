"use server";

import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { isSerializationConflict } from "@/server/serialization-conflict";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { auditCardEvent } from "@/server/security/card-audit";
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
/**
 * An administrator's change to who someone is, what they may do, or whether they are active is a
 * security event — recorded as an ordinary audit row (who, which account, what kind of change). The
 * metadata carries ONLY roles, field NAMES and flags: never a value such as an email address or a
 * commission rate, and never anything about card data.
 */
async function auditAccountEvent(
  client: Prisma.TransactionClient | typeof prisma,
  params: { actorId: string; action: string; accountId: string; metadata: Record<string, unknown> }
) {
  await client.auditLog.create({
    data: { actorId: params.actorId, action: params.action, entityType: "Account", entityId: params.accountId, metadata: params.metadata as Prisma.InputJsonValue },
  });
}

/**
 * Step-up for changes that GIVE someone more reach: a role change, a changed login email (the email is the identity
 * Google sign-in matches, so changing it can hand an account to someone else), a newly granted payment / booking
 * permission, and creating an Admin. These are Admin-only already; on top of that the Admin must have signed in within the last
 * 15 minutes (the same real step-up as card and IP Reveal), so a stolen or left-open older session cannot quietly escalate
 * anyone. It is a returned message — never a thrown error, which production masks — and the refusal is audited without
 * any values. Revocations and ordinary profile edits are not blocked.
 */
const ADMIN_STEP_UP_MESSAGE = `For security, this change requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.`;
async function stepUpOrRefuse(current: NonNullable<Awaited<ReturnType<typeof assertAdmin>>>, accountId: string, attempted: string): Promise<{ error: string } | null> {
  const stepUp = requireRecentLogin(current.sessionCreatedAt);
  if (stepUp.ok) return null;
  await auditAccountEvent(prisma, { actorId: current.id, action: "ACCOUNT_PRIVILEGE_CHANGE_DENIED", accountId, metadata: { attempted, reason: stepUp.reason } });
  return { error: ADMIN_STEP_UP_MESSAGE };
}

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
async function withSerializableRetryMessage<T>(fn: () => Promise<T>): Promise<T> {
  // A serialization failure is Postgres telling us the transaction lost a race with another
  // one and is safe to run again unchanged — so it is retried (the same idiom the lead and
  // bootstrap code use) before the user is ever asked to. Only when it keeps losing does the
  // message below reach them.
  const ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSerializationConflict(err)) throw err;
      if (attempt >= ATTEMPTS) throw new Error("This request conflicted with another simultaneous change — please try again.");
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.floor(Math.random() * 40)));
    }
  }
}

export async function createAccount(input: z.infer<typeof createAccountSchema>) {
  const current = await assertAdmin();
  const data = createAccountSchema.parse(input);
  if (data.role === "ADMIN") {
    const refused = await stepUpOrRefuse(current!, "new", "new-admin");
    if (refused) return refused;
  }
  // Deliberately not returning the created row — a raw Account carries
  // Decimal fields (commissionPercent/tipPercent) that cannot cross the
  // Server Action -> Client Component boundary. No caller today reads this
  // return value; narrow it explicitly if one ever needs to.
  const created = await prisma.account.create({ data: { ...data, companyId: current!.companyId }, select: { id: true } });
  await auditAccountEvent(prisma, { actorId: current!.id, action: "ACCOUNT_CREATED", accountId: created.id, metadata: { role: data.role, status: data.status ?? "ACTIVE" } });
  revalidatePath("/accounts");
  revalidatePath("/users");
}

export async function updateAccount(accountId: string, patch: z.infer<typeof updateAccountSchema>) {
  const current = await assertAdmin();
  const data = updateAccountSchema.parse(patch);
  if (data.role !== undefined || data.email !== undefined) {
    const refused = await stepUpOrRefuse(current!, accountId, [data.role !== undefined ? "role" : null, data.email !== undefined ? "email" : null].filter(Boolean).join("+"));
    if (refused) return refused;
  }

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

        const before = await tx.account.findUniqueOrThrow({ where: { id: accountId }, select: { role: true } });
        await tx.account.update({ where: { id: accountId }, data });
        const changedFields = Object.entries(data).filter(([, v]) => v !== undefined).map(([k]) => k);
        await auditAccountEvent(tx, {
          actorId: current!.id,
          action: data.role && data.role !== before.role ? "ACCOUNT_ROLE_CHANGED" : "ACCOUNT_UPDATED",
          accountId,
          metadata: { changedFields, ...(data.role && data.role !== before.role ? { roleFrom: before.role, roleTo: data.role } : {}) },
        });

        // Team membership follows role. Only a Manager can have team members and
        // only a Travel Agent can be one, so a role change that breaks either
        // end clears the relationship (records are untouched — only the
        // manager's reach over them ends). Done in the same transaction as the
        // role change so the two can never disagree.
        if (data.role) {
          if (data.role !== "MANAGER") {
            await tx.account.updateMany({ where: { managerId: accountId }, data: { managerId: null } });
          }
          if (data.role !== "TRAVEL_AGENT") {
            await tx.account.update({ where: { id: accountId }, data: { managerId: null } });
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
  revalidatePath("/leads");
  revalidatePath("/contacts");
  return undefined;
}

/**
 * Admin-only: set EXACTLY which Travel Agents are on a Manager's team.
 *
 * A Manager's access to leads, contacts, quotes and bookings is their own
 * records plus their team's (src/server/visibility.ts) — so this is the one
 * place that grants or removes it, and it is validated entirely here on the
 * server, whatever the UI offered:
 *   • the caller must be an Admin of the same company;
 *   • the target must currently be a MANAGER (nobody else can have a team);
 *   • every member must be a TRAVEL_AGENT of the same company — never an
 *     Admin, another Manager, a Ticketing Agent, a Flight Expert or a
 *     Marketing Agent;
 *   • an agent belongs to at most one Manager: naming an agent here moves
 *     them off any previous manager's team.
 * Agents named in the list are added; agents previously on this team but not
 * in the list are removed. Removal only ends the manager's reach — no lead,
 * contact, quote or booking is changed, moved or deleted. A hidden or inactive
 * agent can be a member (their records stay in scope); membership does not make
 * a hidden account visible anywhere.
 */
export async function setManagerTeam(managerId: string, memberIds: string[]) {
  const current = await assertAdmin();
  const ids = [...new Set(memberIds)];

  const result = await withSerializableRetryMessage(() =>
    prisma.$transaction(
      async (tx) => {
        const manager = await tx.account.findUnique({ where: { id: managerId }, select: { id: true, role: true, companyId: true, fullName: true } });
        if (!manager || manager.companyId !== current!.companyId) throw new Error("Account not found");
        if (manager.role !== "MANAGER") throw new Error("Only a Manager can have team members");

        const members = ids.length
          ? await tx.account.findMany({ where: { id: { in: ids } }, select: { id: true, role: true, companyId: true, fullName: true, managerId: true } })
          : [];
        if (members.length !== ids.length || members.some((m) => m.companyId !== current!.companyId)) throw new Error("Account not found");
        if (members.some((m) => m.role !== "TRAVEL_AGENT")) throw new Error("Only Travel Agents can be team members");

        const before = await tx.account.findMany({ where: { managerId }, select: { id: true, fullName: true } });
        const beforeIds = new Set(before.map((m) => m.id));
        const added = members.filter((m) => !beforeIds.has(m.id));
        const removed = before.filter((m) => !ids.includes(m.id));

        await tx.account.updateMany({ where: { managerId, id: { notIn: ids } }, data: { managerId: null } });
        if (ids.length) await tx.account.updateMany({ where: { id: { in: ids } }, data: { managerId } });

        await tx.auditLog.create({
          data: {
            actorId: current!.id,
            action: "MANAGER_TEAM_CHANGED",
            entityType: "Account",
            entityId: managerId,
            metadata: {
              managerName: manager.fullName,
              added: added.map((m) => ({ id: m.id, name: m.fullName, movedFromManagerId: m.managerId })),
              removed: removed.map((m) => ({ id: m.id, name: m.fullName })),
              teamSize: ids.length,
            },
          },
        });
        return { added: added.length, removed: removed.length, teamSize: ids.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
  revalidatePath("/leads");
  revalidatePath("/contacts");
  revalidatePath("/quotes");
  revalidatePath("/bookings");
  return result;
}

/**
 * Admin-only: add and/or remove SPECIFIC Travel Agents on a Manager's team — an
 * incremental change, unlike setManagerTeam's "this is the whole team" replacement.
 *
 * The Users page edits a team from a snapshot the browser loaded earlier. Replacing the
 * whole team from a stale snapshot silently undoes whatever changed in between: an agent
 * another Admin (or this Admin, on a different Manager's row) just moved to this team
 * would be pulled back, taking the access away from the Manager they were moved to.
 * Sending only what the Admin actually changed makes that impossible — an agent the
 * Admin did not touch is never read or written.
 *   • add:    every id must be a TRAVEL_AGENT of the caller's company; they join this team
 *             and leave any team they were on (one manager per agent);
 *   • remove: only ids CURRENTLY on this manager's team are affected (anyone else, e.g.
 *             someone since moved to another manager, is left exactly where they are);
 *   • the same Admin/company/role validation as setManagerTeam, the same audit entry, and
 *     like it no lead, contact, quote or booking is changed — only the Manager's reach.
 * Access follows on the very next query: visibility is a live relation filter on
 * Account.managerId, so there is nothing cached to invalidate.
 */
export async function changeManagerTeam(managerId: string, change: { add?: string[]; remove?: string[] }) {
  const current = await assertAdmin();
  const add = [...new Set(change.add ?? [])];
  const remove = [...new Set(change.remove ?? [])].filter((id) => !add.includes(id));

  const result = await withSerializableRetryMessage(() =>
    prisma.$transaction(
      async (tx) => {
        const manager = await tx.account.findUnique({ where: { id: managerId }, select: { id: true, role: true, companyId: true, fullName: true } });
        if (!manager || manager.companyId !== current!.companyId) throw new Error("Account not found");
        if (manager.role !== "MANAGER") throw new Error("Only a Manager can have team members");

        const toAdd = add.length ? await tx.account.findMany({ where: { id: { in: add } }, select: { id: true, role: true, companyId: true, fullName: true, managerId: true } }) : [];
        if (toAdd.length !== add.length || toAdd.some((m) => m.companyId !== current!.companyId)) throw new Error("Account not found");
        if (toAdd.some((m) => m.role !== "TRAVEL_AGENT")) throw new Error("Only Travel Agents can be team members");

        // Only agents genuinely on THIS team can be removed from it.
        const toRemove = remove.length ? await tx.account.findMany({ where: { id: { in: remove }, managerId }, select: { id: true, fullName: true } }) : [];

        const newlyAdded = toAdd.filter((m) => m.managerId !== managerId);
        if (toRemove.length) await tx.account.updateMany({ where: { id: { in: toRemove.map((m) => m.id) }, managerId }, data: { managerId: null } });
        if (toAdd.length) await tx.account.updateMany({ where: { id: { in: toAdd.map((m) => m.id) } }, data: { managerId } });

        const teamSize = await tx.account.count({ where: { managerId } });
        if (newlyAdded.length || toRemove.length) {
          await tx.auditLog.create({
            data: {
              actorId: current!.id,
              action: "MANAGER_TEAM_CHANGED",
              entityType: "Account",
              entityId: managerId,
              metadata: {
                managerName: manager.fullName,
                added: newlyAdded.map((m) => ({ id: m.id, name: m.fullName, movedFromManagerId: m.managerId })),
                removed: toRemove.map((m) => ({ id: m.id, name: m.fullName })),
                teamSize,
              },
            },
          });
        }
        return { added: newlyAdded.length, removed: toRemove.length, teamSize };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
  revalidatePath("/leads");
  revalidatePath("/contacts");
  revalidatePath("/quotes");
  revalidatePath("/bookings");
  return result;
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
        await auditAccountEvent(tx, { actorId: current!.id, action: "ACCOUNT_STATUS_CHANGED", accountId, metadata: { status } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
  );

  revalidatePath("/accounts");
  revalidatePath("/users");
}

/**
 * Admin-only toggle for whether this account is part of the current visible
 * team: the /accounts directory, the Lead Acceptance roster and queue
 * positions, lead distribution, and the assignment pickers (see the
 * accountsVisible field comment in schema.prisma for the full list and for
 * what it deliberately does NOT affect). Deliberately its own
 * tiny, focused mutation rather than folded into updateAccountSchema —
 * this is a directory-display preference, not an identity/compensation
 * field, and keeping it separate means it can never accidentally ride
 * along with (or be blocked by) the role/email admin-safety transaction
 * updateAccount runs. Does NOT touch status, the LeadQueueEntry row,
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
  await auditAccountEvent(prisma, { actorId: current!.id, action: "ACCOUNT_VISIBILITY_CHANGED", accountId, metadata: { accountsVisible: visible } });

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
  const before = await prisma.account.findUnique({ where: { id: accountId }, select: { paymentPermissions: true } });
  if (requested.some((p) => !before?.paymentPermissions.includes(p))) {
    const refused = await stepUpOrRefuse(current!, accountId, "grant-payment-permission");
    if (refused) return refused;
  }
  await prisma.account.update({
    where: { id: accountId },
    data: { paymentPermissions: requested },
  });
  // Administrator changes to who may touch card data are security events.
  await auditCardEvent({
    actorId: current!.id,
    action: "PAYMENT_PERMISSIONS_CHANGED",
    entityType: "Account",
    entityId: accountId,
    success: true,
    details: {
      targetRole: target.role,
      granted: requested.filter((p) => !before?.paymentPermissions.includes(p)),
      revoked: (before?.paymentPermissions ?? []).filter((p) => !requested.includes(p)),
    },
  });
  revalidatePath("/users");
  return undefined;
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
  const before = await prisma.account.findUnique({ where: { id: accountId }, select: { bookingPermissions: true } });
  if (requested.some((p) => !before?.bookingPermissions.includes(p))) {
    const refused = await stepUpOrRefuse(current!, accountId, "grant-booking-permission");
    if (refused) return refused;
  }
  await prisma.account.update({
    where: { id: accountId },
    data: { bookingPermissions: requested },
  });
  // Who may reveal a signer's IP is a security setting — audited like the payment grants above.
  await auditAccountEvent(prisma, {
    actorId: current!.id,
    action: "BOOKING_PERMISSIONS_CHANGED",
    accountId,
    metadata: {
      targetRole: target.role,
      granted: requested.filter((p) => !before?.bookingPermissions.includes(p)),
      revoked: (before?.bookingPermissions ?? []).filter((p) => !requested.includes(p)),
    },
  });
  revalidatePath("/users");
  return undefined;
}
