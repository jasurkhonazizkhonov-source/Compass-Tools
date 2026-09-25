"use client";

import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Public CRM marketing-site contact form. Submits to /api/public/crm-inquiry
// — the CRM Inquiries system (rows tagged CRM_WEBSITE, shown only in the
// Admin "CRM Inquiries" inbox), NOT the Business Flights "Get In Touch"
// route. It reuses the shared hardened handler (Zod-validated server-side,
// rate-limited) rather than introducing a second implementation — the client-side schema below
// mirrors that route's own schema exactly so the same input is rejected
// consistently at both layers, but the SERVER remains authoritative;
// nothing here can bypass its own validation. companyId is a fixed,
// non-editable value — this visitor never chooses or sees it — matching
// this deployment's established single-company convention (the same
// "default-company" id every migration/seed script already uses), not a
// company selector.
const SUBJECT_OPTIONS = [
  { value: "GENERAL_INQUIRY", label: "General inquiry" },
  { value: "FLIGHT_REQUEST_HELP", label: "Help with a flight request" },
  { value: "EXISTING_BOOKING", label: "An existing booking" },
  { value: "CORPORATE_TRAVEL", label: "Corporate travel" },
  { value: "OTHER", label: "Other" },
] as const;

const contactFormSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(200),
  lastName: z.string().trim().min(1, "Last name is required").max(200),
  email: z.string().trim().email("Enter a valid email address"),
  phone: z.string().trim().max(50).optional().or(z.literal("")),
  subject: z.enum(["GENERAL_INQUIRY", "FLIGHT_REQUEST_HELP", "EXISTING_BOOKING", "CORPORATE_TRAVEL", "OTHER"]),
  message: z.string().trim().min(1, "Please include a short message").max(5000),
});

type ContactFormValues = z.infer<typeof contactFormSchema>;

const COMPASS_TOOLS_DEFAULT_COMPANY_ID = "default-company";

export function ContactForm() {
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: { subject: "GENERAL_INQUIRY" },
  });

  async function onSubmit(values: ContactFormValues) {
    setServerError(null);
    try {
      const res = await fetch("/api/public/crm-inquiry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId: COMPASS_TOOLS_DEFAULT_COMPANY_ID,
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          phone: values.phone || undefined,
          subject: values.subject,
          message: values.message,
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        // Never surfaces raw server/database detail — the API route itself
        // already returns only a safe, generic message on failure.
        setServerError(json?.error || "Something went wrong. Please try again.");
        return;
      }
      setSubmitted(true);
    } catch {
      setServerError("Could not reach the server. Please check your connection and try again.");
    }
  }

  if (submitted) {
    return (
      <div className="flex flex-col items-center rounded-2xl border bg-background p-10 text-center shadow-sm">
        <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h2 className="mt-4 text-lg font-semibold text-foreground">Thank you — we&apos;ve received your message</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          A member of our team will get back to you shortly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5 rounded-2xl border bg-background p-6 shadow-sm sm:p-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" autoComplete="given-name" aria-invalid={!!errors.firstName} {...register("firstName")} />
          {errors.firstName && (
            <p className="text-xs text-destructive" role="alert">
              {errors.firstName.message}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" autoComplete="family-name" aria-invalid={!!errors.lastName} {...register("lastName")} />
          {errors.lastName && (
            <p className="text-xs text-destructive" role="alert">
              {errors.lastName.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register("email")} />
          {errors.email && (
            <p className="text-xs text-destructive" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone (optional)</Label>
          <Input id="phone" type="tel" autoComplete="tel" {...register("phone")} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="subject">Subject</Label>
        <Controller
          control={control}
          name="subject"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="subject" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUBJECT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="message">Message</Label>
        <Textarea id="message" rows={5} aria-invalid={!!errors.message} {...register("message")} />
        {errors.message && (
          <p className="text-xs text-destructive" role="alert">
            {errors.message.message}
          </p>
        )}
      </div>

      {serverError && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {serverError}
        </p>
      )}

      <Button type="submit" size="lg" className="w-full gap-2" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {isSubmitting ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}
