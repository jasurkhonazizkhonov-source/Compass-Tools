"use client";

import { useId } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { RecipientMode } from "@/server/sequence-recipients";

/**
 * Which of a person's email addresses a sequence goes to. Shown wherever people are enrolled in bulk. The default is the primary address only; "all" is the explicit
 * choice, and it says plainly that one person with several addresses will receive the sequence at each of them.
 */
export function RecipientModeChoice({ value, onChange, disabled = false }: { value: RecipientMode; onChange: (mode: RecipientMode) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-sm font-medium">Send to</legend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v === "all" ? "all" : "primary")} aria-label="Email addresses to send to" className="gap-1.5" disabled={disabled}>
        <label htmlFor={`${id}-primary`} className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
          <RadioGroupItem id={`${id}-primary`} value="primary" className="mt-0.5" />
          <span>
            <span className="font-medium">Primary email only</span> <span className="text-xs text-muted-foreground">(default)</span>
            <span className="block text-xs text-muted-foreground">Each person receives the sequence at their primary email address.</span>
          </span>
        </label>
        <label htmlFor={`${id}-all`} className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
          <RadioGroupItem id={`${id}-all`} value="all" className="mt-0.5" />
          <span>
            <span className="font-medium">All available email addresses</span>
            <span className="block text-xs text-muted-foreground">
              A person with more than one address receives the same sequence at <strong>each</strong> of them. Each valid address is used once; addresses that unsubscribed or are suppressed are left out.
            </span>
          </span>
        </label>
      </RadioGroup>
    </fieldset>
  );
}
