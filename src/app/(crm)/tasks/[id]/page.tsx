import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getTaskDetail } from "@/server/queries/tasks";
import { listTaskEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewTasks } from "@/lib/permissions";
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel";

export const dynamic = "force-dynamic";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentAccount = await getCurrentAccount();
  if (!canViewTasks(currentAccount?.role)) notFound();
  const [task, agents] = await Promise.all([getTaskDetail(id, currentAccount), currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([])]);
  if (!task) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/tasks" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Tasks
      </Link>
      <TaskDetailPanel task={task} agents={agents} />
    </div>
  );
}
