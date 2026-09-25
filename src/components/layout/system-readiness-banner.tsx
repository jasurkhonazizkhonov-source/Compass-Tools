import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getPaymentProviderStatus } from "@/server/payments/provider";
import { trustedProxyMode } from "@/lib/request-ip";

// Admin-only heads-up for two conditions the customer booking flow depends on
// and that FAIL CLOSED by design — so a missing one never looks like an error
// anywhere obvious; customers just cannot finish a booking, or the signer's
// IP address quietly is not recorded. The full picture (and history) is on the
// Admin-only System Health page. Pure environment inspection (no
// database query, no secret ever shown): it renders nothing when everything
// is in place. The same facts are exposed, as booleans only, by /api/health.
export function SystemReadinessBanner({ role }: { role: string | undefined }) {
  if (role !== "ADMIN") return null;

  const issues: Array<{ title: string; detail: string }> = [];

  // Shown whenever customers genuinely cannot complete a booking (in ANY
  // environment there is no fallback card store): the payment provider is not
  // selected/configured, or a credential is invalid. It disappears only when the
  // provider configuration is valid — System Health additionally probes the
  // provider's API, which this synchronous banner deliberately does not.
  const payment = getPaymentProviderStatus();
  if (payment.state !== "ready") {
    const problems = [...payment.missing.map((m) => `${m} (missing)`), ...payment.invalid.map((m) => `${m} (invalid)`)];
    issues.push({
      title: "Customers cannot complete bookings right now",
      detail:
        `The payment provider isn't ready${problems.length ? `: ${problems.join(", ")}` : ""}. Card entry is turned off, so nothing is charged and nothing is stored. Set the provider's environment variables in Vercel and redeploy — see docs/PAYMENT_ARCHITECTURE.md.`,
    });
  }
  if (trustedProxyMode() === "none") {
    issues.push({
      title: "Signer IP addresses are not being recorded",
      detail:
        "No trusted proxy is configured (TRUSTED_PROXY is unset off Vercel, or explicitly \"none\"), so the customer's IP address is deliberately never read from request headers. Set TRUSTED_PROXY to describe the real proxy (docs/DEPLOYMENT.md, section 5). It also enables rate limiting on the public booking and inquiry forms.",
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
      <p className="pl-7 text-xs text-muted-foreground">
        Only Admins see this notice. <Link href="/system-health" className="font-medium underline underline-offset-2">Open System Health</Link>
      </p>
    </div>
  );
}
