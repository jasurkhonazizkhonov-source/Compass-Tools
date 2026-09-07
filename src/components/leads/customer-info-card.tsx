"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { InlineEditField } from "@/components/crm/inline-edit-field";
import { PhoneValueInput } from "@/components/crm/phone-input";
import { PhoneManager, EmailManager } from "@/components/contacts/phone-email-manager";
import { formatPhoneInternational } from "@/lib/phone";
import { updatePrimaryPhoneNumber, updatePrimaryEmailAddress, updateContactField } from "@/server/actions/contacts";

type PhoneRow = { id: string; number: string; type: string; isPrimary: boolean };
type EmailRow = { id: string; email: string; type: string; isPrimary: boolean };

export function CustomerInfoCard({
  contactId,
  firstName,
  lastName,
  phones,
  emails,
  showProfileLink = true,
  leadId,
}: {
  contactId: string;
  firstName: string;
  lastName: string;
  phones: PhoneRow[];
  emails: EmailRow[];
  showProfileLink?: boolean;
  /** Set when rendered from a Lead detail page — grants access to a
   * restricted-role viewer whose Lead was individually reassigned to them
   * without the parent Contact being reassigned too (see
   * assertContactAccess's doc comment in server/actions/contacts.ts).
   * Omitted on the Contact detail page, where no Lead context exists. */
  leadId?: string;
}) {
  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Customer</CardTitle>
        {showProfileLink && (
          <Link href={`/contacts/${contactId}`} className="text-xs text-primary flex items-center gap-1 hover:underline">
            View full profile <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <InlineEditField<string>
            label="First Name"
            currentValue={firstName}
            displayValue={firstName}
            editor={(value, setValue) => <Input value={value} onChange={(e) => setValue(e.target.value)} />}
            onSave={(v) => updateContactField(contactId, { firstName: v }, leadId)}
          />
          <InlineEditField<string>
            label="Last Name"
            currentValue={lastName}
            displayValue={lastName}
            editor={(value, setValue) => <Input value={value} onChange={(e) => setValue(e.target.value)} />}
            onSave={(v) => updateContactField(contactId, { lastName: v }, leadId)}
          />
        </div>

        <InlineEditField<string>
          label="Primary Phone"
          currentValue={phones.find((p) => p.isPrimary)?.number ?? ""}
          displayValue={phones.find((p) => p.isPrimary)?.number ? formatPhoneInternational(phones.find((p) => p.isPrimary)!.number) : "Not set"}
          editor={(value, setValue) => <PhoneValueInput value={value} onChange={setValue} />}
          onSave={(v) => updatePrimaryPhoneNumber(contactId, v, leadId)}
          successMessage="Phone updated"
        />

        <InlineEditField<string>
          label="Primary Email"
          currentValue={emails.find((e) => e.isPrimary)?.email ?? ""}
          displayValue={emails.find((e) => e.isPrimary)?.email ?? "Not set"}
          editor={(value, setValue) => <Input type="email" value={value} onChange={(e) => setValue(e.target.value)} />}
          onSave={(v) => updatePrimaryEmailAddress(contactId, v, leadId)}
          successMessage="Email updated"
        />

        <Separator />
        <PhoneManager contactId={contactId} phones={phones} leadId={leadId} />
        <Separator />
        <EmailManager contactId={contactId} emails={emails} leadId={leadId} />
      </CardContent>
    </Card>
  );
}
