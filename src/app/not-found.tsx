import Link from "next/link";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Global Next.js not-found boundary — rendered for any route (App Router
 * page/route segment) that doesn't resolve, and by any page in this app
 * that explicitly calls notFound() (e.g. an unknown/expired public link,
 * or a CRM page's own defense-in-depth check for an unauthorized role).
 * Reachable by BOTH a customer (a broken/expired public link, e.g. an old
 * quote or card-confirmation email link) and staff (a mistyped or stale
 * internal URL) —
 * so, unlike the customer-facing booking/quote pages elsewhere in this
 * app, this one has no company/customer context to brand itself with and
 * deliberately says nothing product- or company-specific: no internal
 * product name, no route names, no hint of what kind of link failed.
 * Renders inside the root layout (app/layout.tsx), so it already has the
 * app's real theme tokens/dark-mode support — no separate provider needed.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-10">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <SearchX className="h-6 w-6" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Page Not Found</h1>
          <p className="text-sm text-muted-foreground mt-1">
            The page you&apos;re looking for doesn&apos;t exist, may have been moved, or the link you followed may be
            out of date.
          </p>
        </div>
        <div className="flex justify-center pt-1">
          <Button asChild>
            <Link href="/">Go to Homepage</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
