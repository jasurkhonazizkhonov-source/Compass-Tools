import { Badge } from "@/components/ui/badge";

// Fictional, illustrative CRM interface panels for the public marketing
// site — never real customer/business data. All names, routes, and
// figures below are made up for demonstration purposes only.
const SAMPLE_ROWS = [
  { name: "J. Alvarez", route: "LAX → CDG", status: "Quoted", tone: "info" as const },
  { name: "M. Okafor", route: "JFK → NRT", status: "Booked", tone: "success" as const },
  { name: "S. Kowalski", route: "ORD → LHR", status: "New", tone: "default" as const },
  { name: "R. Tanaka", route: "SFO → SYD", status: "Signed", tone: "warning" as const },
];

const TONE_CLASSES: Record<string, string> = {
  success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  info: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  warning: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  default: "bg-muted text-muted-foreground",
};

/** A stylized, fictional "Leads" list — used on the homepage and the
 * Lead Management / Customer Management feature pages. */
export function MockLeadsPanel() {
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-lg" aria-hidden>
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-3">
        <span className="text-xs font-semibold text-foreground">Leads</span>
        <span className="text-[11px] text-muted-foreground">Sample data</span>
      </div>
      <div className="divide-y">
        {SAMPLE_ROWS.map((row) => (
          <div key={row.name} className="flex items-center justify-between px-4 py-2.5 text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{row.name}</p>
              <p className="text-muted-foreground">{row.route}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${TONE_CLASSES[row.tone]}`}>{row.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A stylized, fictional fare-quote card — used on the Quote & Itinerary
 * feature page. */
export function MockQuotePanel() {
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-lg" aria-hidden>
      <div className="border-b bg-muted/40 px-4 py-3">
        <span className="text-xs font-semibold text-foreground">Quote Q-10482 · Sample data</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Los Angeles (LAX) → Zurich (ZRH)</p>
            <p className="text-xs text-muted-foreground">Business · Round trip · 2 adults</p>
          </div>
          <Badge variant="outline">Sent</Badge>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Total fare</span>
          <span className="font-semibold text-foreground">$4,280.00</span>
        </div>
        <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Sample Airlines · Boeing 787</span>
          <span className="text-muted-foreground">Nonstop</span>
        </div>
      </div>
    </div>
  );
}

/** A stylized, fictional dashboard summary strip — used on the homepage
 * and the Sales Visibility feature page. */
export function MockDashboardPanel() {
  const stats = [
    { label: "Open Leads", value: "24" },
    { label: "Quotes Sent (7d)", value: "11" },
    { label: "Booked", value: "6" },
  ];
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-lg" aria-hidden>
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-3">
        <span className="text-xs font-semibold text-foreground">Dashboard</span>
        <span className="text-[11px] text-muted-foreground">Sample data</span>
      </div>
      <div className="grid grid-cols-3 divide-x">
        {stats.map((s) => (
          <div key={s.label} className="px-3 py-4 text-center">
            <p className="text-lg font-semibold text-foreground">{s.value}</p>
            <p className="mt-1 text-[10px] text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
