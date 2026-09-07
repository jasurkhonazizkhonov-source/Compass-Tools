import Link from "next/link";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentAccount } from "@/lib/dev-session";

export const dynamic = "force-dynamic";

/**
 * Reached only when Google authentication succeeded but the CRM's own
 * authorization check denied access (src/server/actions/google-auth.ts —
 * unknown email or disabled account). Deliberately distinct from /login
 * ("not signed in yet"): src/proxy.ts sends an unauthenticated visitor to
 * /login, never here. The message is intentionally generic regardless of
 * WHY access was denied — never distinguishes "email not found" from
 * "account disabled" to the visitor, only in the server-side log line that
 * produced this redirect.
 */
export default async function AccessDeniedPage() {
  const current = await getCurrentAccount();
  if (current) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Access Denied</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your Google account was authenticated successfully, but you are not currently authorized to access this
            CRM. Please contact your manager or supervisor if you believe you should have access.
          </p>
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
