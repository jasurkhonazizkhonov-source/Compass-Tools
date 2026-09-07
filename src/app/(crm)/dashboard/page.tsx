import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  Users,
  UserPlus,
  PhoneCall,
  Loader2,
  FileText,
  PlaneTakeoff,
  XCircle,
  Activity as ActivityIcon,
  CalendarClock,
  ArrowRight,
} from "lucide-react";
import { prisma } from "@/lib/prisma";
import { StatCard } from "@/components/crm/stat-card";
import { EmptyState } from "@/components/crm/empty-state";
import { LEAD_STATUS_META } from "@/lib/status-meta";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  LeadsByStatusChart,
  CabinClassChart,
  DestinationChart,
  MonthlyGrowthChart,
} from "@/components/crm/dashboard-charts";
import { LeadAcceptanceCard } from "@/components/layout/lead-acceptance-card";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewDashboard } from "@/lib/permissions";
import { getMyQueueStatus } from "@/server/queries/lead-queue";

export const dynamic = "force-dynamic";

const LOST_STATUSES = ["NOT_INTERESTED", "BOOKED_ELSEWHERE", "LOW_BUDGET", "NO_RESPONSE"] as const;

async function getDashboardData() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    totalLeads,
    newLeads,
    statusGroups,
    cabinGroups,
    destinationLeads,
    recentActivities,
    upcomingTasks,
    monthlyLeads,
  ] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["cabinClass"], _count: { _all: true } }),
    prisma.lead.findMany({
      where: { arrivalAirportId: { not: null } },
      select: { arrivalAirport: { select: { city: true, iata: true } } },
    }),
    prisma.activity.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { actor: true, lead: { include: { contact: true } }, contact: true },
    }),
    prisma.task.findMany({
      where: { status: "PENDING", dueAt: { not: null } },
      orderBy: { dueAt: "asc" },
      take: 5,
      include: { lead: { include: { contact: true } }, contact: true },
    }),
    prisma.lead.findMany({
      where: { createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true },
    }),
  ]);

  const statusCountMap = new Map(statusGroups.map((g) => [g.status, g._count._all]));
  const inProcess = statusCountMap.get("IN_PROCESS") ?? 0;
  const reached = statusCountMap.get("REACHED") ?? 0;
  const quoted = statusCountMap.get("QUOTED") ?? 0;
  const booked = statusCountMap.get("BOOKED") ?? 0;
  const lost = LOST_STATUSES.reduce((sum, s) => sum + (statusCountMap.get(s) ?? 0), 0);

  const statusChartData = statusGroups
    .map((g) => ({ status: LEAD_STATUS_META[g.status].label, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const cabinChartData = cabinGroups.map((g) => ({
    name: g.cabinClass.replace("_", " "),
    value: g._count._all,
  }));

  const destinationCounts = new Map<string, number>();
  for (const l of destinationLeads) {
    if (!l.arrivalAirport) continue;
    const key = `${l.arrivalAirport.city || l.arrivalAirport.iata} (${l.arrivalAirport.iata})`;
    destinationCounts.set(key, (destinationCounts.get(key) ?? 0) + 1);
  }
  const destinationChartData = [...destinationCounts.entries()]
    .map(([destination, count]) => ({ destination, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const monthBuckets: { month: string; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthBuckets.push({ month: d.toLocaleString("en-US", { month: "short" }), count: 0 });
  }
  for (const l of monthlyLeads) {
    const monthsAgo =
      (now.getFullYear() - l.createdAt.getFullYear()) * 12 + (now.getMonth() - l.createdAt.getMonth());
    const bucketIndex = 5 - monthsAgo;
    if (bucketIndex >= 0 && bucketIndex < 6) monthBuckets[bucketIndex].count++;
  }

  return {
    totalLeads,
    newLeads,
    inProcess,
    reached,
    quoted,
    booked,
    lost,
    statusChartData,
    cabinChartData,
    destinationChartData,
    recentActivities,
    upcomingTasks,
    monthBuckets,
  };
}

export default async function DashboardPage() {
  const [data, currentAccount] = await Promise.all([getDashboardData(), getCurrentAccount()]);
  if (!canViewDashboard(currentAccount?.role)) notFound();
  const queueStatus = await getMyQueueStatus(currentAccount?.id, currentAccount?.companyId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Overview of leads, quotes, and bookings</p>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <LeadAcceptanceCard initialIsActive={queueStatus.isActive} initialPosition={queueStatus.position} />
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Total Leads" value={data.totalLeads} icon={Users} />
        <StatCard label="New Leads (7d)" value={data.newLeads} icon={UserPlus} tone="info" />
        <StatCard label="In Process" value={data.inProcess} icon={Loader2} tone="info" />
        <StatCard label="Reached" value={data.reached} icon={PhoneCall} tone="warning" />
        <StatCard label="Quoted" value={data.quoted} icon={FileText} tone="info" />
        <StatCard label="Booked" value={data.booked} icon={PlaneTakeoff} tone="success" />
        <StatCard label="Lost" value={data.lost} icon={XCircle} tone="destructive" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <LeadsByStatusChart data={data.statusChartData} />
        <CabinClassChart data={data.cabinChartData} />
        <DestinationChart data={data.destinationChartData} />
        <MonthlyGrowthChart data={data.monthBuckets} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Recent Activity</CardTitle>
            <ActivityIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {data.recentActivities.length === 0 ? (
              <EmptyState icon={ActivityIcon} title="No activity yet" description="Actions across leads and quotes will show up here." />
            ) : (
              <ul className="space-y-4">
                {data.recentActivities.map((a) => (
                  <li key={a.id} className="flex gap-3 text-sm">
                    <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0">
                      <p className="leading-snug">
                        {a.description}
                        {(a.lead?.contact || a.contact) && (
                          <Link
                            href={a.lead ? `/leads/${a.lead.id}` : `/contacts/${a.contact?.id}`}
                            className="ml-1 font-medium text-primary hover:underline"
                          >
                            {(a.lead?.contact ?? a.contact)?.firstName} {(a.lead?.contact ?? a.contact)?.lastName}
                          </Link>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {a.actor?.fullName ?? "System"} · {formatDistanceToNow(a.createdAt, { addSuffix: true })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Upcoming Follow-ups</CardTitle>
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {data.upcomingTasks.length === 0 ? (
              <EmptyState icon={CalendarClock} title="No follow-ups scheduled" description="Tasks with due dates will show up here." />
            ) : (
              <ul className="space-y-3">
                {data.upcomingTasks.map((t) => {
                  const person = t.lead?.contact ?? t.contact;
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{t.title}</p>
                        {person && (
                          <p className="text-xs text-muted-foreground truncate">
                            {person.firstName} {person.lastName}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-muted-foreground">
                          {t.dueAt && formatDistanceToNow(t.dueAt, { addSuffix: true })}
                        </span>
                        {t.lead && (
                          <Link href={`/leads/${t.lead.id}`}>
                            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
