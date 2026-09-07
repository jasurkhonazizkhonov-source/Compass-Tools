"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { updateCompanySignature } from "@/server/actions/company";
import { resolveSignature, SIGNATURE_VARIABLES } from "@/lib/email-signature";

export function CompanySignatureForm({
  initialTemplate,
  exampleFirstName,
  exampleLastName,
  examplePhone,
}: {
  initialTemplate: string;
  /** The signed-in admin's own name/phone — used only to make the live
   * preview concrete, per the spec's "live signature preview with example
   * resolved variables" requirement. Never sent anywhere or saved. */
  exampleFirstName: string;
  exampleLastName: string;
  examplePhone: string;
}) {
  const [template, setTemplate] = useState(initialTemplate);
  const [isPending, startTransition] = useTransition();

  const preview = useMemo(
    () => resolveSignature(template, { firstName: exampleFirstName, lastName: exampleLastName, phone: examplePhone || "(no phone on file)" }),
    [template, exampleFirstName, exampleLastName, examplePhone]
  );

  const onSave = () => {
    startTransition(async () => {
      try {
        await updateCompanySignature({ signatureTemplate: template });
        toast.success("Email signature saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save signature");
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="signature-template">Signature template</Label>
        <Textarea
          id="signature-template"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          rows={4}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Available variables: {SIGNATURE_VARIABLES.map((v) => (
            <code key={v} className="mx-0.5 rounded bg-muted px-1 py-0.5">{v}</code>
          ))}. Resolved automatically for whichever team member actually sends each email — never edited per person.
          Applies immediately to regular emails, quotes, sequences, and booking notifications.
        </p>
      </div>

      <Card size="sm" className="bg-muted/30">
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">Live preview — as {exampleFirstName} {exampleLastName} would send it</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm text-foreground">{preview}</p>
        </CardContent>
      </Card>

      <Button onClick={onSave} disabled={isPending}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save signature
      </Button>
    </div>
  );
}
