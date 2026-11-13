import { BUSINESS_TIMEZONE } from "@/lib/pay-period";
import { cn } from "@/lib/utils";

/**
 * "Nov 5, 2026 9:45 AM" - the exact date and time a note was written, in the CRM's own business time zone (the same
 * America/Los_Angeles zone as the header clock, lead-capture times and the pay periods). Fixed on purpose: the notes panel renders on the
 * server and again in the browser, and a browser-local format would differ between the two. Built from parts so the wording is identical
 * in every engine. Returns null for a missing or invalid value - the caller shows a fallback instead of inventing a time.
 */
export function formatNoteTimestamp(value: Date | string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("year")} ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

/**
 * Who wrote a note and when, on two lines: the author's name in bold, then the full date and time beneath it. Shared by every note
 * display (lead / contact notes, inquiry internal notes); it is not used by activity feeds, audit logs or task history.
 */
export function NoteMeta({ authorName, createdAt, className }: { authorName: string | null | undefined; createdAt: Date | string | null | undefined; className?: string }) {
  const name = authorName?.trim() || "Unknown author";
  const stamp = formatNoteTimestamp(createdAt);
  const iso = stamp && createdAt ? new Date(createdAt).toISOString() : undefined;
  return (
    <div className={cn("text-xs leading-snug", className)} data-testid="note-meta">
      <p className="font-semibold text-foreground" data-testid="note-author">
        {name}
      </p>
      <p className="text-muted-foreground" data-testid="note-timestamp">
        {stamp ? (
          <time dateTime={iso} title="Pacific Time">
            {stamp}
          </time>
        ) : (
          "Date unavailable"
        )}
      </p>
    </div>
  );
}
