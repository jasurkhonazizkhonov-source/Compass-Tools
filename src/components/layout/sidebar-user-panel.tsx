"use client";

import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ROLE_LABELS } from "@/lib/permissions";
import { initials, splitName, formatTenure } from "@/lib/account-format";
import { cn } from "@/lib/utils";
import type { AccountRole } from "@/generated/prisma/client";

export type SidebarAccount = {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: AccountRole;
  hiredAt: Date | null;
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words">{value}</p>
    </div>
  );
}

export function SidebarUserPanel({ current, collapsed = false }: { current: SidebarAccount | null; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);

  if (!current) {
    return collapsed ? null : (
      <div className="px-4 py-4 text-[11px] text-sidebar-foreground/40 border-t border-sidebar-border">Compass Tools v0.1 — dev mode</div>
    );
  }

  const { firstName, lastName } = splitName(current.fullName);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* DialogTrigger (not a plain onClick) so Radix restores keyboard
          focus here on close instead of falling back to <body> — matches
          the fix applied to cancellation-dialog.tsx for the same reason. */}
      <DialogTrigger asChild>
        <button
          type="button"
          title={collapsed ? current.fullName : undefined}
          className={cn(
            "flex items-center gap-2.5 py-3 border-t border-sidebar-border text-left hover:bg-sidebar-accent/60 transition-colors",
            collapsed ? "justify-center px-2" : "px-4"
          )}
        >
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-xs bg-sidebar-primary text-sidebar-primary-foreground">
              {initials(current.fullName)}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{current.fullName}</p>
              <p className="text-[11px] text-sidebar-foreground/60 truncate">{ROLE_LABELS[current.role]}</p>
            </div>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                <AvatarFallback className="text-base bg-primary text-primary-foreground">
                  {initials(current.fullName)}
                </AvatarFallback>
              </Avatar>
              <div>
                <DialogTitle>{current.fullName}</DialogTitle>
                <p className="text-xs text-muted-foreground">{ROLE_LABELS[current.role]}</p>
              </div>
            </div>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <Field label="First Name" value={firstName || "—"} />
            <Field label="Last Name" value={lastName || "—"} />
            <Field label="Phone Number" value={current.phone || "—"} />
            <Field label="Email" value={current.email} />
            <Field
              label="Hiring Date"
              value={current.hiredAt ? current.hiredAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Not set"}
            />
            <Field label="Current Age at Company" value={formatTenure(current.hiredAt)} />
          </div>
        </DialogContent>
    </Dialog>
  );
}
