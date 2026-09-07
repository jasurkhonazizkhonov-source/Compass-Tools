"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";

const MESSAGES: Record<string, { kind: "success" | "error"; text: string }> = {
  connected: { kind: "success", text: "Gmail connected — you can now send emails from your Gmail account." },
  cancelled: { kind: "error", text: "Gmail connection cancelled." },
  mismatch: { kind: "error", text: "That Gmail account doesn't match your CRM sign-in email. Please use the same account." },
  error: { kind: "error", text: "Could not connect Gmail. Please try again." },
};

/** One-shot toast for the ?gmail=... flag the OAuth callback route
 * redirects back with, then strips the param so refreshing the page never
 * re-shows it. Mounted once in the CRM layout, mirroring PresenceHeartbeat. */
export function GmailConnectToast() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const gmailParam = searchParams.get("gmail");

  useEffect(() => {
    if (!gmailParam) return;
    const message = MESSAGES[gmailParam];
    if (message) {
      if (message.kind === "success") toast.success(message.text);
      else toast.error(message.text);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("gmail");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailParam]);

  return null;
}
