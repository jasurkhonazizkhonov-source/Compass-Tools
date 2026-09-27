"use client";

import { useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneInput, DEFAULT_PHONE_COUNTRY } from "@/components/crm/phone-input";
import { isValidPhoneInput, type CountryCode } from "@/lib/phone";

// Public CRM marketing-site contact form. Submits to /api/public/crm-inquiry
// — the CRM Inquiries system (rows tagged CRM_WEBSITE, shown only in the
// Admin "CRM Inquiries" inbox), NOT the Business Flights "Get In Touch"
// route. It reuses the shared hardened handler (Zod-validated server-side,
// rate-limited, and — for THIS route only — a required country-validated
// phone number, a honeypot, and a short duplicate-submission window; see
// src/server/public-inquiry.ts) rather than introducing a second
// implementation. The client-side schema below mirrors that route's own
// schema so the same input is rejected consistently at both layers, but the
// SERVER remains authoritative; nothing here can bypass its own validation.
// companyId is a fixed, non-editable value — this visitor never chooses or
// sees it — matching this deployment's established single-company
// convention (the same "default-company" id every migration/seed script
// already uses), not a company selector.
//
// Reuses the CRM's own PhoneInput (searchable, full-country-list selector +
// libphonenumber-js validation) rather than a second phone-input
// implementation or a new dependency.
const SUBJECT_OPTIONS = [
  { value: "FLIGHT_REQUEST_HELP", label: "Flight Booking / Quote Request" },
  { value: "EXISTING_BOOKING", label: "Existing Booking" },
  { value: "CORPORATE_TRAVEL", label: "Group / Corporate Travel" },
  { value: "GENERAL_INQUIRY", label: "General Travel Inquiry" },
  { value: "OTHER", label: "Other" },
] as const;

const contactFormSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(200),
  lastName: z.string().trim().min(1, "Last name is required").max(200),
  email: z.string().trim().min(1, "Email is required").email("Enter a valid email address"),
  phoneCountry: z.custom<CountryCode>((v) => typeof v === "string" && v.length > 0),
  phone: z.string().trim().min(1, "Phone number is required"),
  subject: z.enum(["GENERAL_INQUIRY", "FLIGHT_REQUEST_HELP", "EXISTING_BOOKING", "CORPORATE_TRAVEL", "OTHER"], { message: "Please select an inquiry topic" }),
  message: z.string().trim().min(10, "Please tell us a little more about how we can help (at least 10 characters)").max(5000),
  // Honeypot — real visitors never see or fill this (aria-hidden, tabIndex
  // -1, off-screen). A non-empty value here means the submission is
  // automated; the server silently accepts without creating anything.
  companyWebsite: z.string().max(200).optional(),
}).superRefine((values, ctx) => {
  if (!isValidPhoneInput(values.phone, values.phoneCountry)) {
    ctx.addIssue({ code: "custom", path: ["phone"], message: "Please check the phone number and country code." });
  }
});

type ContactFormValues = z.infer<typeof contactFormSchema>;

const COMPASS_TOOLS_DEFAULT_COMPANY_ID = "default-company";

export function ContactForm() {
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const messageHintId = useId();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: { subject: "GENERAL_INQUIRY", phoneCountry: DEFAULT_PHONE_COUNTRY, phone: "", companyWebsite: "" },
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
          phone: values.phone,
          phoneCountry: values.phoneCountry,
          subject: values.subject,
          message: values.message,
          companyWebsite: values.companyWebsite || undefined,
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        // Never surfaces raw server/database detail — the API route itself
        // already returns only a safe, generic message on failure. The
        // customer's entered values are left in place so a retry is a
        // single click, never a re-typed form.
        setServerError(json?.error || "We couldn't submit your inquiry right now. Please try again in a moment.");
        return;
      }
      setSubmitted(true);
    } catch {
      setServerError("Could not reach the server. Please check your connection and try again.");
    }
  }

  if (submitted) {
    return (
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 flex flex-col items-center rounded-2xl border bg-background p-10 text-center shadow-sm">
        <CheckCircle2 className="h-10 w-10 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <h2 className="mt-4 text-lg font-semibold text-foreground">Thank you — your inquiry has been received</h2>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Your request was submitted successfully and our team will review it. Expect a response through the phone number or
          email address you provided.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 space-y-5 rounded-2xl border bg-background p-6 shadow-sm sm:p-8"
    >
      {/* Honeypot — visually hidden AND removed from the accessibility tree
          (aria-hidden on the wrapper), so a screen reader never announces or
          treats it as a required field, and it never enters the tab order. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="companyWebsite">Company website</label>
        <input id="companyWebsite" type="text" tabIndex={-1} autoComplete="off" {...register("companyWebsite")} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" autoComplete="given-name" placeholder="e.g. Jordan" aria-invalid={!!errors.firstName} aria-describedby={errors.firstName ? "firstName-error" : undefined} {...register("firstName")} />
          {errors.firstName && (
            <p id="firstName-error" className="text-xs text-destructive" role="alert">
              {errors.firstName.message}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" autoComplete="family-name" placeholder="e.g. Rivera" aria-invalid={!!errors.lastName} aria-describedby={errors.lastName ? "lastName-error" : undefined} {...register("lastName")} />
          {errors.lastName && (
            <p id="lastName-error" className="text-xs text-destructive" role="alert">
              {errors.lastName.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email address</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="e.g. jordan@example.com"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p id="email-error" className="text-xs text-destructive" role="alert">
              {errors.email.message}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone number</Label>
          <Controller
            control={control}
            name="phoneCountry"
            render={({ field: countryField }) => (
              <Controller
                control={control}
                name="phone"
                render={({ field: phoneField }) => (
                  <PhoneInput
                    country={countryField.value}
                    onCountryChange={countryField.onChange}
                    nationalNumber={phoneField.value}
                    onNationalNumberChange={phoneField.onChange}
                    onBlur={phoneField.onBlur}
                  />
                )}
              />
            )}
          />
          <p className="sr-only" id="phone-hint">Select your country, then enter your phone number.</p>
          {errors.phone && (
            <p id="phone-error" className="text-xs text-destructive" role="alert">
              {errors.phone.message}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="subject">Inquiry topic</Label>
        <Controller
          control={control}
          name="subject"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="subject" className="w-full" aria-describedby={errors.subject ? "subject-error" : undefined}>
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
        {errors.subject && (
          <p id="subject-error" className="text-xs text-destructive" role="alert">
            {errors.subject.message}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="message">How can we help?</Label>
        <Textarea
          id="message"
          rows={5}
          placeholder="Tell us what you need help with, including your travel dates, destinations, or booking reference if applicable."
          aria-invalid={!!errors.message}
          aria-describedby={`${messageHintId}${errors.message ? " message-error" : ""}`}
          {...register("message")}
        />
        <p id={messageHintId} className="text-xs text-muted-foreground">
          Please do not include payment-card numbers, security codes, passwords, or other sensitive financial information.
        </p>
        {errors.message && (
          <p id="message-error" className="text-xs text-destructive" role="alert">
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

      <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden /> Sent securely over HTTPS. We never share your information with third parties.
      </p>
    </form>
  );
}
