"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Single-value input in the CRM's own modal — the replacement for window.prompt.
 *
 * Deliberately NOT a <form>: this dialog is rendered through a portal from inside editors that live in larger forms, and React
 * propagates a portal's submit event to the enclosing form, so a real <form> here could submit the page's form. Enter is
 * handled on the field instead, and every button is type="button".
 *
 * `validate` returns an error message (shown inline, the dialog stays open) or null when the value is acceptable.
 */
type InputDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
};

export function InputDialog(props: InputDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        {/* Mounted only while the dialog is open, so every opening starts with a fresh value and no stale error. */}
        <InputDialogBody {...props} />
      </DialogContent>
    </Dialog>
  );
}

function InputDialogBody({ onOpenChange, title, description, label, placeholder, submitLabel = "Apply", initialValue = "", validate, onSubmit }: InputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = value.trim();
    const problem = validate ? validate(trimmed) : trimmed.length === 0 ? "Enter a value." : null;
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(trimmed);
    onOpenChange(false);
  }

  const inputId = "input-dialog-field";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className={description ? undefined : "sr-only"}>{description ?? title}</DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          value={value}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              submit();
            }
          }}
          autoFocus
        />
        {error && (
          <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="button" onClick={submit}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </>
  );
}
