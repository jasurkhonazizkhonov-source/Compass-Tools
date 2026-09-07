import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneClass, type StatusTone } from "@/lib/status-meta";

export function StatusBadge({
  label,
  tone,
  className,
}: {
  label: string;
  tone: StatusTone;
  className?: string;
}) {
  return (
    <Badge variant="outline" className={cn(toneClass(tone), "font-medium", className)}>
      {label}
    </Badge>
  );
}
