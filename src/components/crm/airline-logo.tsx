"use client";

import { useState } from "react";
import { Plane } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Renders an airline's logo when a real logo URL is on file for that
 * airline, and falls back to its IATA/ICAO code (never a fabricated logo,
 * never a generic aircraft icon when a real code is available) when it
 * isn't. If the image URL 404s at render time, falls back the same way.
 */
export function AirlineLogo({
  name,
  iata,
  icao,
  logoUrl,
  size = 28,
  className,
}: {
  name: string;
  iata?: string | null;
  icao?: string | null;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  const code = iata || icao;

  if (logoUrl && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external, variable-domain logo CDN; next/image would require allow-listing every airline logo host
      <img
        src={logoUrl}
        alt={name}
        width={size}
        height={size}
        onError={() => setErrored(true)}
        className={cn("rounded object-contain bg-white", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={cn("flex items-center justify-center rounded bg-muted text-muted-foreground shrink-0", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.32) }}
      title={name}
      aria-label={name}
    >
      {code ? <span className="font-bold tracking-tight">{code}</span> : <Plane style={{ width: size * 0.5, height: size * 0.5 }} />}
    </div>
  );
}
