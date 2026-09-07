"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";

export function OnlineOnlyToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get("online") === "1";

  function toggle() {
    const params = new URLSearchParams(searchParams.toString());
    if (active) params.delete("online");
    else params.set("online", "1");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <Button variant={active ? "default" : "outline"} size="sm" onClick={toggle} className="gap-1.5">
      <Wifi className="h-3.5 w-3.5" /> Online Only
    </Button>
  );
}
