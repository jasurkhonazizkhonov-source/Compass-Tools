import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Rendered (not thrown/redirected) directly from a detail page's own return
 * value when a record genuinely exists but the current viewer's visibility
 * scope excludes it — see leadVisibilityWhere/quoteVisibilityWhere/etc in
 * server/visibility.ts. Deliberately distinct from:
 *   - notFound() — reserved for a record that doesn't exist at all, so the
 *     two cases stay visually distinguishable and this page never has to
 *     pretend a record exists when it doesn't.
 *   - /access-denied — reserved for no session at all (an unauthenticated
 *     visitor); that page intentionally sits outside the CRM shell.
 * This one keeps the sidebar/topbar intact since the viewer IS a valid,
 * signed-in CRM user — they're just blocked from this one record — and
 * never names the actual owner (see each page's own comment for why).
 */
export function AccessRestricted() {
  return (
    <div className="flex items-center justify-center py-16 px-4">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Lock className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">You don&apos;t have access to this section</h1>
          <p className="text-sm text-muted-foreground mt-1">
            This information is not available to your account. If you believe you should have access, please contact your supervisor or manager.
          </p>
        </div>
        <div className="flex justify-center pt-1">
          <Button asChild>
            <Link href="/dashboard">Back to Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
