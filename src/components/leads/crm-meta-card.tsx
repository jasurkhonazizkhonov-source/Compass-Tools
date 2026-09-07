"use client";

import { format } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Link from "next/link";
import { InlineEditField } from "@/components/crm/inline-edit-field";
import { updateLeadField, reassignLead } from "@/server/actions/leads";
import { PRIORITY_META, leadSourceLabel } from "@/lib/status-meta";
import { StatusBadge } from "@/components/crm/status-badge";

const SOURCES = ["WEBSITE", "PHONE", "EMAIL", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "REFERRAL", "OTHER"] as const;
const PRIORITIES = ["LOW", "MEDIUM", "HIGH"] as const;

type Agent = { id: string; fullName: string };

export function CrmMetaCard({
  leadId,
  source,
  priority,
  assignedAgentId,
  agents,
  createdAt,
  canReassign,
  referredByContact,
}: {
  leadId: string;
  source: string;
  priority: "LOW" | "MEDIUM" | "HIGH";
  assignedAgentId: string | null;
  agents: Agent[];
  createdAt: Date;
  referredByContact?: { id: string; firstName: string; lastName: string } | null;
  /** Whether the current account may move this lead away from an existing
   * owner. Claiming a currently-unassigned lead is always allowed regardless
   * of this flag — only reassigning AWAY from someone else is gated. This is
   * a UX nicety only; reassignLead() enforces the same rule server-side. */
  canReassign: boolean;
}) {
  const assignedAgentEditable = canReassign || !assignedAgentId;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-medium">CRM Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <InlineEditField<string>
          label="Source"
          currentValue={source}
          displayValue={leadSourceLabel(source as typeof SOURCES[number])}
          editor={(value, setValue) => (
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => <SelectItem key={s} value={s}>{leadSourceLabel(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          onSave={(v) => updateLeadField(leadId, { source: v as typeof SOURCES[number] })}
        />
        {source === "REFERRAL" && referredByContact && (
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Referred By</p>
            <Link href={`/contacts/${referredByContact.id}`} className="text-sm text-primary hover:underline">
              {referredByContact.firstName} {referredByContact.lastName}
            </Link>
          </div>
        )}
        <InlineEditField<string>
          label="Priority"
          currentValue={priority}
          displayValue={<StatusBadge label={PRIORITY_META[priority].label} tone={PRIORITY_META[priority].tone} />}
          editor={(value, setValue) => (
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          onSave={(v) => updateLeadField(leadId, { priority: v as "LOW" | "MEDIUM" | "HIGH" })}
        />
        {assignedAgentEditable ? (
          <InlineEditField<string>
            label="Assigned Agent"
            currentValue={assignedAgentId ?? ""}
            displayValue={agents.find((a) => a.id === assignedAgentId)?.fullName ?? "Unassigned"}
            editor={(value, setValue) => (
              <Select value={value} onValueChange={setValue}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            onSave={(v) => (v ? reassignLead(leadId, v) : updateLeadField(leadId, { assignedAgentId: null }))}
          />
        ) : (
          <div className="min-h-8">
            <p className="text-xs text-muted-foreground mb-0.5">Assigned Agent</p>
            <p className="text-sm">{agents.find((a) => a.id === assignedAgentId)?.fullName ?? "Unassigned"}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-muted-foreground mb-0.5">Created</p>
          <p className="text-sm">{format(createdAt, "MMM d, yyyy 'at' h:mm a")}</p>
        </div>
      </CardContent>
    </Card>
  );
}
