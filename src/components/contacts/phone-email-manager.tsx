"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Phone, Mail, Plus, Star, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PhoneValueInput } from "@/components/crm/phone-input";
import { formatPhoneInternational } from "@/lib/phone";
import {
  addContactPhone,
  addContactEmail,
  setPrimaryPhone,
  setPrimaryEmail,
  deleteContactPhone,
  deleteContactEmail,
} from "@/server/actions/contacts";

type PhoneRow = { id: string; number: string; type: string; isPrimary: boolean };
type EmailRow = { id: string; email: string; type: string; isPrimary: boolean };

export function PhoneManager({ contactId, phones, leadId }: { contactId: string; phones: PhoneRow[]; leadId?: string }) {
  const [adding, setAdding] = useState(false);
  const [newNumber, setNewNumber] = useState("");
  const [newType, setNewType] = useState("MOBILE");
  const [isPending, startTransition] = useTransition();

  function submitAdd() {
    if (!newNumber.trim()) return;
    startTransition(async () => {
      try {
        await addContactPhone({ contactId, number: newNumber.trim(), type: newType as "MOBILE" | "HOME" | "WORK" | "OTHER", isPrimary: phones.length === 0, leadId });
        toast.success("Phone number added");
        setNewNumber("");
        setAdding(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add phone number");
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Phone className="h-3.5 w-3.5" /> Phone Numbers
        </p>
        <Button variant="ghost" size="icon-sm" onClick={() => setAdding((v) => !v)} aria-label="Add phone number" aria-expanded={adding}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ul className="space-y-1.5">
        {phones.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{formatPhoneInternational(p.number)}</span>
              <span className="text-[10px] uppercase text-muted-foreground shrink-0">{p.type}</span>
              {p.isPrimary && (
                <span className="text-[10px] font-medium text-primary shrink-0">Primary</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!p.isPrimary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Make primary phone number"
                      onClick={() => startTransition(() => setPrimaryPhone(contactId, p.id, leadId))}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Make primary</TooltipContent>
                </Tooltip>
              )}
              {phones.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete phone number"
                  onClick={() => startTransition(() => deleteContactPhone(contactId, p.id, leadId))}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="flex items-center gap-1.5">
          <PhoneValueInput value={newNumber} onChange={setNewNumber} placeholder="Phone number" />
          <Select value={newType} onValueChange={setNewType}>
            <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="MOBILE">Mobile</SelectItem>
              <SelectItem value="HOME">Home</SelectItem>
              <SelectItem value="WORK">Work</SelectItem>
              <SelectItem value="OTHER">Other</SelectItem>
            </SelectContent>
          </Select>
          <Button size="icon-sm" onClick={submitAdd} disabled={isPending} aria-label="Save phone number">
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}

export function EmailManager({ contactId, emails, leadId }: { contactId: string; emails: EmailRow[]; leadId?: string }) {
  const [adding, setAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newType, setNewType] = useState("PERSONAL");
  const [isPending, startTransition] = useTransition();

  function submitAdd() {
    if (!newEmail.trim()) return;
    startTransition(async () => {
      try {
        await addContactEmail({ contactId, email: newEmail.trim(), type: newType as "PERSONAL" | "WORK" | "OTHER", isPrimary: emails.length === 0, leadId });
        toast.success("Email added");
        setNewEmail("");
        setAdding(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add email — check it's a valid address");
      }
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5" /> Email Addresses
        </p>
        <Button variant="ghost" size="icon-sm" onClick={() => setAdding((v) => !v)} aria-label="Add email address" aria-expanded={adding}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ul className="space-y-1.5">
        {emails.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{e.email}</span>
              <span className="text-[10px] uppercase text-muted-foreground shrink-0">{e.type}</span>
              {e.isPrimary && <span className="text-[10px] font-medium text-primary shrink-0">Primary</span>}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!e.isPrimary && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Make primary email address"
                      onClick={() => startTransition(() => setPrimaryEmail(contactId, e.id, leadId))}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Make primary</TooltipContent>
                </Tooltip>
              )}
              {emails.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete email address"
                  onClick={() => startTransition(() => deleteContactEmail(contactId, e.id, leadId))}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="flex items-center gap-1.5">
          <Input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="name@example.com"
            className="h-8"
            autoFocus
          />
          <Select value={newType} onValueChange={setNewType}>
            <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="PERSONAL">Personal</SelectItem>
              <SelectItem value="WORK">Work</SelectItem>
              <SelectItem value="OTHER">Other</SelectItem>
            </SelectContent>
          </Select>
          <Button size="icon-sm" onClick={submitAdd} disabled={isPending} aria-label="Save email address">
            {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}
