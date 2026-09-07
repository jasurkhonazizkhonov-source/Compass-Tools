"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ROLE_LABELS,
  PAYMENT_PERMISSIONS,
  PAYMENT_PERMISSION_LABELS,
  isPaymentPermissionGrantableForRole,
  isPaymentPermission,
  type PaymentPermission,
  BOOKING_PERMISSIONS,
  BOOKING_PERMISSION_LABELS,
  isBookingPermissionGrantableForRole,
  isBookingPermission,
  type BookingPermission,
} from "@/lib/permissions";
import { updateAccount, setAccountStatus, setAccountsVisibility, updatePaymentPermissions, updateBookingPermissions } from "@/server/actions/accounts";
import type { AccountRole, AccountStatus } from "@/generated/prisma/client";

export function AccountRoleSelect({
  accountId,
  role,
  canEdit,
  isLastActiveAdmin,
}: {
  accountId: string;
  role: AccountRole;
  canEdit: boolean;
  /** This account's own row, and it's the only active Administrator — role
   * changes are blocked (server-side, this is just the preemptive UI
   * signal) since demoting it would leave the CRM with no active admin. */
  isLastActiveAdmin?: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  if (!canEdit) return <span className="text-sm">{ROLE_LABELS[role]}</span>;

  if (isLastActiveAdmin) {
    return (
      <span
        className="text-sm text-muted-foreground"
        title="This account is protected because it is currently the only active administrator."
      >
        {ROLE_LABELS[role]}
      </span>
    );
  }

  return (
    <Select
      value={role}
      onValueChange={(v) =>
        startTransition(async () => {
          try {
            await updateAccount(accountId, { role: v as AccountRole });
            toast.success("Role updated");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to update role");
          }
        })
      }
      disabled={isPending}
    >
      <SelectTrigger className="h-8 w-[150px]">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SelectValue />}
      </SelectTrigger>
      <SelectContent>
        {Object.entries(ROLE_LABELS).map(([value, label]) => (
          <SelectItem key={value} value={value}>{label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AccountFullNameEditor({ accountId, fullName, canEdit }: { accountId: string; fullName: string; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fullName);

  if (!canEdit) return <span className="text-sm">{fullName}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(fullName);
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm"
      >
        {fullName}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    const trimmed = value.trim();
    if (!trimmed) {
      toast.error("Name cannot be empty");
      return;
    }
    startTransition(async () => {
      try {
        await updateAccount(accountId, { fullName: trimmed });
        toast.success("Name updated");
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update name");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[170px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

export function AccountPhoneEditor({ accountId, phone, canEdit }: { accountId: string; phone: string | null; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(phone ?? "");

  if (!canEdit) return <span className="text-sm text-muted-foreground">{phone ?? "—"}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(phone ?? "");
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {phone ?? "—"}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    startTransition(async () => {
      try {
        await updateAccount(accountId, { phone: value });
        toast.success("Phone number updated");
        setEditing(false);
      } catch {
        toast.error("Failed to update phone number");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[140px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

export function AccountEmailEditor({
  accountId,
  email,
  canEdit,
  isLastActiveAdmin,
}: {
  accountId: string;
  email: string;
  canEdit: boolean;
  /** This account's own row, and it's the only active Administrator —
   * changing this identity would lock the company out of the CRM, since
   * it's what Google Sign-In matches against. Server-enforced; this only
   * pre-empts the round trip with an explanatory tooltip. */
  isLastActiveAdmin?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email);

  if (!canEdit) return <span className="text-sm text-muted-foreground">{email}</span>;

  if (isLastActiveAdmin) {
    return (
      <span
        className="text-sm text-muted-foreground"
        title="This account is protected because it is currently the only active administrator."
      >
        {email}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(email);
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {email}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    startTransition(async () => {
      try {
        await updateAccount(accountId, { email: value });
        toast.success("Email updated");
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update email");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[190px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

export function AccountHiredAtEditor({ accountId, hiredAt, canEdit }: { accountId: string; hiredAt: Date | null; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(hiredAt ? hiredAt.toISOString().slice(0, 10) : "");

  const display = hiredAt ? hiredAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Not set";

  if (!canEdit) return <span className="text-sm text-muted-foreground">{display}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(hiredAt ? hiredAt.toISOString().slice(0, 10) : "");
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {display}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    startTransition(async () => {
      try {
        await updateAccount(accountId, { hiredAt: value ? new Date(`${value}T00:00:00.000Z`) : null });
        toast.success("Hire date updated");
        setEditing(false);
      } catch {
        toast.error("Failed to update hire date");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="date"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[150px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

export function AccountLocationEditor({ accountId, location, canEdit }: { accountId: string; location: string | null; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(location ?? "");

  if (!canEdit) return <span className="text-sm text-muted-foreground">{location ?? "—"}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(location ?? "");
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {location ?? "—"}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    startTransition(async () => {
      try {
        await updateAccount(accountId, { location: value.trim() || null });
        toast.success("Location updated");
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update location");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. San Francisco"
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[150px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

/** Admin-only — agents/managers cannot modify their own commission %
 * (updateAccount itself is admin-gated via assertAdmin(), so this
 * component simply has no non-admin rendering path at all). Percent stored
 * as e.g. 10.00, not a fraction. */
export function AccountCommissionPercentEditor({ accountId, commissionPercent, canEdit }: { accountId: string; commissionPercent: number | null; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(commissionPercent != null ? String(commissionPercent) : "");

  const display = commissionPercent != null ? `${commissionPercent}%` : "Not set";

  if (!canEdit) return <span className="text-sm text-muted-foreground">{display}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(commissionPercent != null ? String(commissionPercent) : "");
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {display}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed != null && (Number.isNaN(parsed) || parsed < 0 || parsed > 100)) {
      toast.error("Commission % must be between 0 and 100");
      return;
    }
    startTransition(async () => {
      try {
        await updateAccount(accountId, { commissionPercent: parsed });
        toast.success("Commission % updated");
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update commission %");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        type="number"
        min={0}
        max={100}
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 10"
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[90px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

/** Admin-only — agents/managers cannot modify their own tip % (updateAccount
 * is admin-gated via assertAdmin(), so this component has no non-admin
 * rendering path). Determines how much of applicable tips is credited to
 * this user (see Commission Summary). Percent stored as e.g. 5.00, not a
 * fraction. */
export function AccountTipPercentEditor({ accountId, tipPercent, canEdit }: { accountId: string; tipPercent: number | null; canEdit: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(tipPercent != null ? String(tipPercent) : "");

  const display = tipPercent != null ? `${tipPercent}%` : "Not set";

  if (!canEdit) return <span className="text-sm text-muted-foreground">{display}</span>;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(tipPercent != null ? String(tipPercent) : "");
          setEditing(true);
        }}
        className="group flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {display}
        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
      </button>
    );
  }

  function save() {
    const trimmed = value.trim();
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed != null && (Number.isNaN(parsed) || parsed < 0 || parsed > 100)) {
      toast.error("Tip % must be between 0 and 100");
      return;
    }
    startTransition(async () => {
      try {
        await updateAccount(accountId, { tipPercent: parsed });
        toast.success("Tip % updated");
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update tip %");
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        type="number"
        min={0}
        max={100}
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. 5"
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        disabled={isPending}
        className="h-8 w-[90px]"
      />
      <Button size="icon-sm" variant="ghost" onClick={save} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✓"}
      </Button>
    </div>
  );
}

export function AccountStatusSwitch({
  accountId,
  status,
  canEdit,
  isSelf,
  accountName,
}: {
  accountId: string;
  status: AccountStatus;
  canEdit: boolean;
  /** The current admin's own row — deactivating yourself would strand you
   * with no self-service reactivation path in this dev-session auth. */
  isSelf: boolean;
  accountName: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);
  const wasConfirmOpen = useRef(false);

  // The confirm dialog's trigger is the Switch itself, but it can't be a
  // <DialogTrigger> (matching every other dialog in this app) because the
  // Switch has conditional behavior: turning ON calls setAccountStatus
  // directly with no dialog at all, turning OFF opens this confirmation
  // first. So DialogTrigger's automatic focus-restoration-on-close doesn't
  // apply here — restore focus manually instead, on every path that closes
  // the dialog (Escape, outside click, Cancel, or a successful Deactivate).
  useEffect(() => {
    if (wasConfirmOpen.current && !confirmOpen) {
      switchRef.current?.focus();
    }
    wasConfirmOpen.current = confirmOpen;
  }, [confirmOpen]);

  function deactivate() {
    startTransition(async () => {
      try {
        await setAccountStatus(accountId, "INACTIVE");
        toast.success("Account deactivated");
        setConfirmOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update status");
      }
    });
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Switch
          ref={switchRef}
          checked={status === "ACTIVE"}
          disabled={!canEdit || isPending || (isSelf && status === "ACTIVE")}
          title={isSelf && status === "ACTIVE" ? "You cannot disable your own account" : undefined}
          onCheckedChange={(checked) => {
            if (checked) {
              startTransition(async () => {
                try {
                  await setAccountStatus(accountId, "ACTIVE");
                  toast.success("Account activated");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to update status");
                }
              });
            } else {
              setConfirmOpen(true);
            }
          }}
        />
        <span className="text-xs text-muted-foreground">{status === "ACTIVE" ? "Active" : "Inactive"}</span>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate {accountName}?</DialogTitle>
            <DialogDescription>
              They will immediately lose access to the CRM. You can reactivate their account at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deactivate} disabled={isPending}>
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Admin-only "Visible in Accounts" toggle (Pass 11 Part 1) — purely a
 * directory-visibility preference for the general read-only /accounts page
 * every CRM user sees, NOT a deactivation/deletion control (that's the
 * Status switch above). No confirmation dialog: unlike Deactivate, hiding
 * an account has no effect on login, sessions, lead/contact ownership,
 * commission history, or queue membership, so it doesn't need the same
 * "are you sure" friction. Only rendered on the admin-only /users page —
 * updateAccount/setAccountsVisibility already independently re-check
 * assertAdmin() server-side regardless of what this component does.
 */
export function AccountVisibilityToggle({ accountId, visible }: { accountId: string; visible: boolean }) {
  const [isPending, startTransition] = useTransition();

  function toggle(checked: boolean) {
    startTransition(async () => {
      try {
        await setAccountsVisibility(accountId, checked);
        toast.success(checked ? "Now visible in Accounts directory" : "Hidden from Accounts directory");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update Accounts visibility");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={visible}
        disabled={isPending}
        aria-label="Visible in Accounts directory"
        onCheckedChange={toggle}
      />
      <span
        className="text-xs text-muted-foreground"
        title="When disabled, this account no longer appears in the Accounts directory visible to CRM users. Existing records, ownership, history, and account data are not affected."
      >
        {visible ? "Visible" : "Hidden from Accounts"}
      </span>
    </div>
  );
}

/**
 * Admin-only "Remove User" affordance — distinct from the Status switch
 * above so removal reads as an unambiguous, deliberate action rather than
 * a toggle an admin might flip by accident. Under the hood this calls the
 * exact same setAccountStatus(accountId, "INACTIVE") the Status switch
 * already uses — there is no separate "delete" mechanism in this schema
 * (historical leads/quotes/bookings/activity are preserved by design, see
 * setAccountStatus's own documentation), so every existing safety
 * guarantee (admin-only, last-active-admin protection, self-removal
 * protection, immediate session invalidation on the account's next
 * request) already applies with zero new server code. Hidden once the
 * account is already INACTIVE — nothing left to remove.
 */
export function RemoveUserButton({
  accountId,
  accountName,
  status,
  canRemove,
  isSelf,
  isLastActiveAdmin,
}: {
  accountId: string;
  accountName: string;
  status: AccountStatus;
  canRemove: boolean;
  isSelf: boolean;
  isLastActiveAdmin?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!canRemove || status !== "ACTIVE") return null;

  const blockedReason = isSelf
    ? "You cannot remove your own account"
    : isLastActiveAdmin
      ? "This account is protected because it is currently the only active administrator"
      : undefined;

  function remove() {
    startTransition(async () => {
      try {
        await setAccountStatus(accountId, "INACTIVE");
        toast.success(`${accountName} removed`);
        setConfirmOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove user");
      }
    });
  }

  return (
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      {/* Unlike AccountStatusSwitch's Switch trigger, this button always
          opens the dialog unconditionally — no branching logic — so it can
          safely use DialogTrigger (matching every other dialog in this app)
          for automatic focus-restoration-on-close instead of a manual ref. */}
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          disabled={!!blockedReason || isPending}
          title={blockedReason ?? "Remove user"}
          aria-label="Remove user"
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {accountName}?</DialogTitle>
          <DialogDescription>
            They will immediately lose access to Compass Tools — their next sign-in and any current session will
            both be rejected. Their historical leads, quotes, bookings, and activity are preserved and not
            deleted. This can be undone at any time from their Status toggle.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={isPending}>
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AccountPaymentPermissionsEditor({
  accountId,
  role,
  permissions,
}: {
  accountId: string;
  role: AccountRole;
  permissions: string[];
}) {
  const [isPending, startTransition] = useTransition();
  const [current, setCurrent] = useState<string[]>(permissions);
  const [open, setOpen] = useState(false);

  function toggle(permission: PaymentPermission, checked: boolean) {
    const next = checked ? [...current, permission] : current.filter((p) => p !== permission);
    setCurrent(next);
    startTransition(async () => {
      try {
        await updatePaymentPermissions(accountId, next);
        toast.success("Payment permissions updated");
      } catch (err) {
        setCurrent(current);
        toast.error(err instanceof Error ? err.message : "Failed to update payment permissions");
      }
    });
  }

  // Every Admin has full access regardless of this grant array (see
  // canRevealPaymentMethod et al. in permissions.ts) — showing live,
  // individually-toggleable checkboxes here would be misleading, since
  // toggling them off would have no actual effect for an Admin.
  if (role === "ADMIN") {
    return (
      <Badge variant="outline" className="text-[10px] font-normal">
        Full access (Admin)
      </Badge>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex flex-wrap items-center gap-1 max-w-[220px] text-left">
          {current.length === 0 ? (
            <span className="text-sm text-muted-foreground">None</span>
          ) : (
            current.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">
                {isPaymentPermission(p) ? PAYMENT_PERMISSION_LABELS[p] : p}
              </Badge>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs font-medium mb-1">Payment Permissions</p>
        <p className="text-xs text-muted-foreground mb-2">
          Explicit, default-deny grants. Role alone never enables a payment-sensitive action.
        </p>
        <div className="space-y-2">
          {PAYMENT_PERMISSIONS.map((permission) => {
            const grantable = isPaymentPermissionGrantableForRole(permission, role);
            return (
              <label
                key={permission}
                className={`flex items-start gap-2 text-sm ${grantable ? "" : "opacity-40"}`}
                title={grantable ? undefined : `Not grantable for ${ROLE_LABELS[role]}`}
              >
                <Checkbox
                  checked={current.includes(permission)}
                  disabled={isPending || !grantable}
                  onCheckedChange={(v) => toggle(permission, v === true)}
                  className="mt-0.5"
                />
                <span>{PAYMENT_PERMISSION_LABELS[permission]}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function AccountBookingPermissionsEditor({
  accountId,
  role,
  permissions,
}: {
  accountId: string;
  role: AccountRole;
  permissions: string[];
}) {
  const [isPending, startTransition] = useTransition();
  const [current, setCurrent] = useState<string[]>(permissions);
  const [open, setOpen] = useState(false);

  function toggle(permission: BookingPermission, checked: boolean) {
    const next = checked ? [...current, permission] : current.filter((p) => p !== permission);
    setCurrent(next);
    startTransition(async () => {
      try {
        await updateBookingPermissions(accountId, next);
        toast.success("Booking permissions updated");
      } catch (err) {
        setCurrent(current);
        toast.error(err instanceof Error ? err.message : "Failed to update booking permissions");
      }
    });
  }

  // Every Admin has full access regardless of this grant array (see
  // canRevealBookingIp in permissions.ts) — same reasoning as
  // AccountPaymentPermissionsEditor above.
  if (role === "ADMIN") {
    return (
      <Badge variant="outline" className="text-[10px] font-normal">
        Full access (Admin)
      </Badge>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="flex flex-wrap items-center gap-1 max-w-[220px] text-left">
          {current.length === 0 ? (
            <span className="text-sm text-muted-foreground">None</span>
          ) : (
            current.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px] font-normal">
                {isBookingPermission(p) ? BOOKING_PERMISSION_LABELS[p] : p}
              </Badge>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs font-medium mb-1">Booking Security Permissions</p>
        <p className="text-xs text-muted-foreground mb-2">
          Explicit, default-deny grants. Role alone never enables revealing a booking&apos;s submission IP.
        </p>
        <div className="space-y-2">
          {BOOKING_PERMISSIONS.map((permission) => {
            const grantable = isBookingPermissionGrantableForRole(permission, role);
            return (
              <label
                key={permission}
                className={`flex items-start gap-2 text-sm ${grantable ? "" : "opacity-40"}`}
                title={grantable ? undefined : `Not grantable for ${ROLE_LABELS[role]}`}
              >
                <Checkbox
                  checked={current.includes(permission)}
                  disabled={isPending || !grantable}
                  onCheckedChange={(v) => toggle(permission, v === true)}
                  className="mt-0.5"
                />
                <span>{BOOKING_PERMISSION_LABELS[permission]}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
