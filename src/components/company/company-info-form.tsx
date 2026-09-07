"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { updateCompanyInfo } from "@/server/actions/company";

export function CompanyInfoForm({
  initialName,
  initialWebsite,
  initialPhone,
  initialBrandColor,
}: {
  initialName: string;
  initialWebsite: string;
  initialPhone: string;
  initialBrandColor: string;
}) {
  const [name, setName] = useState(initialName);
  const [website, setWebsite] = useState(initialWebsite);
  const [phone, setPhone] = useState(initialPhone);
  const [brandColor, setBrandColor] = useState(initialBrandColor);
  const [isPending, startTransition] = useTransition();

  const onSave = () => {
    startTransition(async () => {
      try {
        await updateCompanyInfo({ name, website, phone, brandColor });
        toast.success("Company information saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save company information");
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="company-name">Company name</Label>
          <Input id="company-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your travel agency's name" />
          <p className="text-xs text-muted-foreground">Shown to customers on quotes, booking pages, and emails. This is separate from &ldquo;Compass Tools&rdquo;, the CRM product itself.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company-website">Website</Label>
          <Input id="company-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company-phone">Phone</Label>
          <Input id="company-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company-brand-color">Brand color</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Brand color picker"
              value={/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#1c3a5e"}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-9 w-10 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
            <Input id="company-brand-color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#1c3a5e" />
          </div>
          <p className="text-xs text-muted-foreground">Used for buttons, links, and accents in emails and the booking page.</p>
        </div>
      </div>
      <Button onClick={onSave} disabled={isPending || name.trim().length === 0}>
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save company information
      </Button>
    </div>
  );
}
