import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { themeInitScript } from "@/lib/theme-script";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PRODUCT_NAME, resolveBaseUrl } from "@/lib/company-config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Lets every page's relative `alternates.canonical` / `openGraph.url`
  // resolve against the real deployment origin instead of being silently
  // dropped by Next.js. resolveBaseUrl() already returns the same
  // https://www.compass-tools.com canonical origin the Gmail OAuth redirect
  // logic depends on (via APP_BASE_URL) — reusing it here rather than
  // hardcoding a second copy of that origin.
  metadataBase: new URL(resolveBaseUrl()),
  title: {
    default: PRODUCT_NAME,
    template: `%s — ${PRODUCT_NAME}`,
  },
  description: "CRM for airline ticket sales and travel agents",
  // Site-wide defaults; individual public marketing pages (see
  // src/app/(marketing)/**) override title/description/url per page and
  // inherit this same image/siteName unless they specify their own.
  openGraph: {
    siteName: PRODUCT_NAME,
    images: [{ url: "/logo.png" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary",
    images: ["/logo.png"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Runs before hydration so the very first paint already has the
            right .dark class / color-scheme — no flash of the wrong theme.
            Rendered via next/script (beforeInteractive) from this Server
            Component specifically so it isn't a Client-Component-authored
            <script> — see theme-provider.tsx's own comment for why that
            distinction is what this whole setup is designed around. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`(${themeInitScript.toString()})();`}
        </Script>
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            {children}
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
