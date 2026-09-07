"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function InlineEditField<T>({
  label,
  displayValue,
  editor,
  currentValue,
  onSave,
  successMessage = "Updated",
}: {
  label?: string;
  displayValue: ReactNode;
  currentValue: T;
  editor: (value: T, setValue: (v: T) => void) => ReactNode;
  onSave: (value: T) => Promise<unknown>;
  successMessage?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<T>(currentValue);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      try {
        await onSave(value);
        toast.success(successMessage);
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save changes");
      }
    });
  }

  function handleCancel() {
    setValue(currentValue);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="group flex items-center justify-between gap-2 min-h-8">
        <div className="min-w-0">
          {label && <p className="text-xs text-muted-foreground mb-0.5">{label}</p>}
          <div className="text-sm">{displayValue}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="opacity-0 group-hover:opacity-100 shrink-0"
          onClick={() => {
            setValue(currentValue);
            setEditing(true);
          }}
          aria-label={`Edit ${label ?? "field"}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs text-muted-foreground">{label}</p>}
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">{editor(value, setValue)}</div>
        <Button size="icon-sm" onClick={handleSave} disabled={isPending} aria-label="Save">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="outline" size="icon-sm" onClick={handleCancel} disabled={isPending} aria-label="Cancel">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
