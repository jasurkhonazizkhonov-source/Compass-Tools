/**
 * Coarse "how long ago" text for the Updated column of the Leads and Contacts
 * lists: Just now · 2 minutes ago · 18 minutes ago · 2 hours ago · Yesterday ·
 * 3 days ago · 2 weeks ago · 3 months ago · 2 years ago.
 *
 * Deliberately no more precision than that (no seconds, no "about", no
 * "less than"), and based on elapsed time rather than calendar days so the
 * wording is stable wherever the server and the reader happen to be. A
 * timestamp slightly in the future (clock skew between the app server and the
 * database) reads as "Just now" rather than a negative duration.
 */
export function formatRelativeUpdated(date: Date, now: Date = new Date()): string {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
