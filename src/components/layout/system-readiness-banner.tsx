import { AlertTriangle } from "lucide-react";
import { isProductionEnvironment } from "@/lib/env";
import { trustedProxyMode } from "@/lib/request-ip";

// Admin-only heads-up for two settings the customer booking flow depends on
// and that FAIL CLOSED by design — so a missing one never looks like an error
// anywhere obvious; customers just cannot finish a booking, or the signer's
// IP address quietly is not recorded. Pure environment inspection (no
// database query, no secret ever shown): it renders nothing when everything
// is in place. The same facts are exposed, as booleans only, by /api/health.
export function SystemReadinessBanner({ role }: { role: string | undefined }) {
  if (role !== "ADMIN") return null;

  const issues: Array<{ title: string; detail: string }> = [];

  if (isProductionEnvironment()) {
    issues.push({
      title: "Customers cannot complete bookings right now",
      detail:
        "Card details cannot be stored in this production environment (APP_ENV is unset or set to \"production\", and no production-grade card vault is configured), so every customer's \"Finish Booking\" is refused with a message that nothing was charged. Enabling it is a deliberate security decision — see docs/DEPLOYMENT.md, section 5c.",
    });
  }
  if (trustedProxyMode() === "none") {
    issues.push({
      title: "Signer IP addresses are not being recorded",
      detail:
        "TRUSTED_PROXY is not set, so the customer's IP address is deliberately never read from request headers. On Vercel set TRUSTED_PROXY to \"vercel\" (docs/DEPLOYMENT.md, section 5). It also enables rate limiting on the public booking and inquiry forms.",
    });
  }

  if (issues.length === 0) return null;

  return (
    <div role="alert" className="mb-4 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
      {issues.map((issue) => (
        <div key={issue.title} className="flex gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <div>
            <p className="font-medium text-foreground">{issue.title}</p>
            <p className="text-muted-foreground">{issue.detail}</p>
          </div>
        </div>
      ))}
      <p className="pl-7 text-xs text-muted-foreground">Only Admins see this notice.</p>
    </div>
  );
}
