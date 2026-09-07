import { getCurrentAccount } from "@/lib/dev-session";
import { getGoogleClientId } from "@/server/auth/google-config";
import { GoogleSignInButton } from "@/components/layout/google-sign-in-button";
import { CompassMark } from "@/components/brand/compass-mark";
import { PRODUCT_NAME } from "@/lib/company-config";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4">
      <div className="max-w-sm w-full rounded-xl border bg-background p-8 text-center space-y-4">
        {/* Pass 13 §2 — larger on the login screen specifically, where
            there's ample dedicated space and no competing nav content
            (48px badge/36px mark -> 56px badge/44px mark), well within the
            card's own max-w-sm (384px) width on every viewport. */}
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-white/95 shadow-sm">
          <CompassMark className="h-11 w-11" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Sign in</h1>
          {expired ? (
            <p className="text-sm text-muted-foreground mt-1">
              Your session has expired for security reasons. Please sign in again.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">
              This area is for {PRODUCT_NAME} staff only. If you&apos;re a customer, please use the link from
              your quote email.
            </p>
          )}
        </div>
        <div className="flex justify-center pt-1">
          <GoogleSignInButton clientId={getGoogleClientId()} />
        </div>
      </div>
    </div>
  );
}
