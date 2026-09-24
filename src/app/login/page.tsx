import { getCurrentAccount } from "@/lib/dev-session";
import { getGoogleClientId } from "@/server/auth/google-config";
import { GoogleSignInButton } from "@/components/layout/google-sign-in-button";
import { CompassMark } from "@/components/brand/compass-mark";
import { PRODUCT_NAME } from "@/lib/company-config";
import { redirect } from "next/navigation";
import { Users2, FileText, PlaneTakeoff, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Purely presentational copy for the branded panel — describes existing,
// real CRM capabilities (lead/quote/booking workflow, role-based
// permissions) rather than inventing anything. Never rendered on the
// authenticated side of the app; this file's only functional imports
// (getCurrentAccount, redirect, getGoogleClientId, GoogleSignInButton) are
// completely unchanged from before this redesign.
const VALUE_PROPS = [
  { icon: Users2, text: "Manage leads and customers in one place" },
  { icon: FileText, text: "Build and send professional fare quotes" },
  { icon: PlaneTakeoff, text: "Track bookings from quote to ticketing" },
  { icon: ShieldCheck, text: "Role-based access for your whole team" },
];

/**
 * Sign-in entry point — the only way into the CRM. Reached either directly
 * (a fresh browser with no session) or via src/proxy.ts's redirect for any
 * CRM route visited without a valid session. Distinct from /access-denied,
 * which is reserved for "Google authenticated successfully but the CRM
 * denied access" — this page is for "not signed in yet." ?reason=expired
 * (set only by proxy.ts, only for a session that genuinely passed its 24h
 * absolute lifetime) shows a specific message instead of the generic one —
 * every other path into this page (fresh browser, signed out, deactivated
 * account) keeps the plain "Sign in" copy.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const current = await getCurrentAccount();
  if (current) {
    redirect("/dashboard");
  }
  const sp = await searchParams;
  const expired = sp.reason === "expired";

  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Branded panel — hidden below lg, where the sign-in card alone
          carries the brand mark instead. Purely decorative/informational:
          no interactive or authentication logic lives here. */}
      <div className="hidden lg:flex relative flex-col justify-between overflow-hidden bg-[#12233a] px-12 py-12 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 20%, rgba(212,162,78,0.25), transparent 45%), radial-gradient(circle at 85% 85%, rgba(255,255,255,0.08), transparent 50%)",
          }}
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/95 shadow-sm">
            <CompassMark className="h-8 w-8" />
          </div>
          <span className="text-lg font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </div>

        <div className="relative max-w-md space-y-8">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Run your travel agency&apos;s entire workflow from one place.
          </h2>
          <ul className="space-y-4">
            {VALUE_PROPS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-white/85">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/50">Business Flights Travel · Internal CRM</p>
      </div>

      {/* Sign-in panel */}
      <div className="flex items-center justify-center bg-muted/30 px-4 py-16 sm:px-6">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center text-center lg:hidden">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-white/95 shadow-sm">
              <CompassMark className="h-11 w-11" />
            </div>
            <span className="mt-3 text-base font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</span>
          </div>

          <div className="rounded-2xl border bg-background p-6 shadow-sm sm:p-8">
            <div className="space-y-2 text-center">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">Sign in</h1>
              {expired ? (
                <p className="text-sm text-muted-foreground">
                  Your session has expired for security reasons. Please sign in again.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This area is for {PRODUCT_NAME} staff only. If you&apos;re a customer, please use the link from
                  your quote email.
                </p>
              )}
            </div>

            <div className="mt-6 flex justify-center">
              <GoogleSignInButton clientId={getGoogleClientId()} />
            </div>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Trouble signing in? Contact your administrator.
          </p>
        </div>
      </div>
    </div>
  );
}
