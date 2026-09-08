import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentAccount } from "@/lib/dev-session";
import { ACCESS_DENIED_MESSAGES } from "@/components/layout/google-sign-in-button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DEFAULT_MESSAGE =
  "Your Google account was authenticated successfully, but you are not currently authorized to access this CRM. Please contact your manager or supervisor if you believe you should have access.";

/**
 * Reached only when Google authentication succeeded but the CRM's own
 * authorization check denied access (src/server/actions/google-auth.ts).
 * Deliberately distinct from /login ("not signed in yet"): src/proxy.ts
 * sends an unauthenticated visitor to /login, never here.
 *
 * Pass 37 — `?reason=` now selects one of a small, fixed set of safe
 * messages (ACCESS_DENIED_MESSAGES, shared with the sign-in button so the
 * copy can't drift) rather than always showing one generic sentence. This
 * is a lookup key into a whitelist, never rendered as free text — an
 * unrecognized/missing value falls back to the original generic message.
 * None of these distinctions reveal anything about a SPECIFIC individual
 * account (unknown-email vs. disabled-account are still deliberately
 * merged into one ACCESS_DENIED message, exactly as before) — they only
 * reveal coarse, non-sensitive system state (whether the CRM has any
 * accounts configured yet at all).
 */
export default async function AccessDeniedPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (current) {
    redirect("/dashboard");
  }
  const sp = await searchParams;
  const reason = typeof sp.reason === "string" ? sp.reason : undefined;
  const message = (reason && ACCESS_DENIED_MESSAGES[reason]) || DEFAULT_MESSAGE;

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Access Denied</h1>
          <p className="text-sm text-muted-foreground mt-1">{message}</p>
        </div>
        <div className="flex justify-center pt-1">
          <Button asChild>
            <Link href="/login">Return to Sign In</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
