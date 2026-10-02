import { Globe, UserPlus } from "lucide-react";
import type { LeadSource } from "@/generated/prisma/client";
import { leadSourceLabel } from "@/lib/status-meta";

// The CRM's own working clock (the header's clock and the Salesboard periods
// use the same zone), shown explicitly so the time is never ambiguous.
const CRM_TIMEZONE = "America/Los_Angeles";

/**
 * "October 2, 2026, 7:00 AM PDT". Built from parts so the wording is identical in every
 * browser and on the server (the built-in long date+time styles vary between engines — some
 * say "at" — and cannot be combined with a named time zone).
 */
export function formatCapturedAt(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CRM_TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("year")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

/**
 * The first entry of a lead's Activity: when the lead was ORIGINALLY created.
 * `createdAt` is the lead row's own creation time — set once by the database
 * when the website form (or an agent) created it and never rewritten — so this
 * is distinct from when the lead was accepted from the queue, reassigned,
 * quoted or last updated (all of which are separate events in the timeline
 * below, or in the "Updated" column of the Leads list). Nothing here is derived
 * from the browser, `updatedAt`, an acceptance or a notification time.
 *
 * Pinned above the timeline rather than appended to it, so it stays in view
 * however long the history is and however much of it has been paged in.
 */
export function LeadCapturedEvent({ createdAt, source }: { createdAt: Date; source: LeadSource }) {
  const fromWebsite = source === "WEBSITE";
  const Icon = fromWebsite ? Globe : UserPlus;
  const title = fromWebsite ? "Lead Captured from Website" : `Lead Created — ${leadSourceLabel(source)}`;
  return (
    <div className="mb-5 flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-3" data-testid="lead-captured-event">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm">
          <time dateTime={createdAt.toISOString()}>{formatCapturedAt(createdAt)}</time>
        </p>
        <p className="text-xs text-muted-foreground">Original {fromWebsite ? "submission" : "creation"} time — not when it was accepted, reassigned or last updated.</p>
      </div>
    </div>
  );
}
