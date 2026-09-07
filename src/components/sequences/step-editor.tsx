"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Check, X, Loader2, Variable, Clock, Eye, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SEQUENCE_VARIABLES, VARIABLE_TOKEN_META, variableToken } from "@/lib/sequence-variables";
import { addStep, updateStep, deleteStep } from "@/server/actions/sequences";
import { cn } from "@/lib/utils";

type Step = { id: string; subject: string; body: string; delayMinutes: number; order: number };

/** Inserts a variable token at the current cursor position in an input or
 * textarea, falling back to appending it when the field isn't focused. Used
 * for both the subject field and the body field — same insertion behavior
 * for either. */
function insertAtCursor(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  setValue: (next: string) => void,
  token: string
) {
  if (!el) {
    setValue(value + token);
    return;
  }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const next = value.slice(0, start) + token + value.slice(end);
  setValue(next);
  requestAnimationFrame(() => {
    el.focus();
    el.selectionStart = el.selectionEnd = start + token.length;
  });
}

function InsertVariableMenu({ onInsert }: { onInsert: (token: string) => void }) {
  const groups = [...new Set(SEQUENCE_VARIABLES.map((v) => v.group))];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5">
          <Variable className="h-3.5 w-3.5" /> Insert Variable
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {groups.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{group}</DropdownMenuLabel>
            {SEQUENCE_VARIABLES.filter((v) => v.group === group).map((v) => (
              <DropdownMenuItem key={v.key} onSelect={() => onInsert(variableToken(v.key))}>
                {v.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Splits template text on {{token}} boundaries and renders recognized tokens as
 * polished chips instead of raw syntax — either their human label or, in "sample"
 * mode, a realistic placeholder value so agents can see roughly what a customer
 * will receive without needing to send a real email first. */
function TemplateChips({ text, mode }: { text: string; mode: "labels" | "sample" }) {
  if (!text.trim()) {
    return <p className="text-xs text-muted-foreground italic">Nothing written yet.</p>;
  }
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  const tokenRe = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
  while ((match = tokenRe.exec(text))) {
    if (match.index > lastIndex) nodes.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    const meta = VARIABLE_TOKEN_META[match[1].toLowerCase()];
    if (meta) {
      nodes.push(
        <span
          key={key++}
          className={cn(
            "inline-flex items-center rounded-md px-1.5 py-0.5 mx-0.5 text-xs font-medium align-baseline",
            mode === "labels" ? "bg-primary/10 text-primary" : "bg-success/15 text-success"
          )}
        >
          {mode === "labels" ? meta.label : meta.sample}
        </span>
      );
    } else {
      nodes.push(<span key={key++}>{match[0]}</span>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  return <p className="text-xs whitespace-pre-wrap leading-relaxed">{nodes}</p>;
}

function ComposerBody({
  subject,
  body,
  subjectRef,
  bodyRef,
  onSubjectChange,
  onBodyChange,
  onInsertSubject,
  onInsertBody,
}: {
  subject: string;
  body: string;
  subjectRef: React.RefObject<HTMLInputElement | null>;
  bodyRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubjectChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onInsertSubject: (token: string) => void;
  onInsertBody: (token: string) => void;
}) {
  return (
    <Tabs defaultValue="edit">
      <TabsList>
        <TabsTrigger value="edit" className="gap-1.5">
          <PenLine className="h-3.5 w-3.5" /> Edit
        </TabsTrigger>
        <TabsTrigger value="preview" className="gap-1.5">
          <Eye className="h-3.5 w-3.5" /> Preview
        </TabsTrigger>
      </TabsList>
      <TabsContent value="edit" className="space-y-2 mt-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Subject</Label>
            <InsertVariableMenu onInsert={onInsertSubject} />
          </div>
          <Input ref={subjectRef} value={subject} onChange={(e) => onSubjectChange(e.target.value)} placeholder="Email subject" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Body</Label>
            <InsertVariableMenu onInsert={onInsertBody} />
          </div>
          <Textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => onBodyChange(e.target.value)}
            rows={5}
            placeholder={"Hi {{contact_first_name}},\n\nI wanted to follow up regarding your trip from {{departure_city}} to {{arrival_city}}."}
          />
        </div>
      </TabsContent>
      <TabsContent value="preview" className="mt-2 space-y-3 rounded-md border bg-muted/30 p-3">
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Subject</p>
          <TemplateChips text={subject} mode="labels" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Body — with sample data</p>
          <TemplateChips text={body} mode="sample" />
        </div>
      </TabsContent>
    </Tabs>
  );
}

function DelayLabel(minutes: number) {
  if (minutes === 0) return "Send immediately";
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `Wait ${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `Wait ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `Wait ${minutes} minutes`;
}

function NewStepForm({ sequenceId, order, onDone }: { sequenceId: string; order: number; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [delayDays, setDelayDays] = useState(order === 0 ? 0 : 2);
  const [isPending, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and body are required");
      return;
    }
    startTransition(async () => {
      await addStep({ sequenceId, subject, body, delayMinutes: delayDays * 24 * 60 });
      toast.success("Step added");
      onDone();
    });
  }

  return (
    <div className="rounded-lg border border-dashed p-4 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Step {order + 1}</p>
        <Button variant="ghost" size="icon-sm" onClick={onDone} title="Remove step" aria-label="Remove step">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Label className="text-xs shrink-0 flex items-center gap-1"><Clock className="h-3 w-3" /> Delay (days)</Label>
        <Input type="number" min={0} value={delayDays} onChange={(e) => setDelayDays(Number(e.target.value) || 0)} className="w-20 h-8" />
      </div>
      <ComposerBody
        subject={subject}
        body={body}
        subjectRef={subjectRef}
        bodyRef={bodyRef}
        onSubjectChange={setSubject}
        onBodyChange={setBody}
        onInsertSubject={(token) => insertAtCursor(subjectRef.current, subject, setSubject, token)}
        onInsertBody={(token) => insertAtCursor(bodyRef.current, body, setBody, token)}
      />
      <div className="flex gap-2">
        <Button onClick={submit} disabled={isPending} size="sm" className="gap-1.5">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Add Step
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ExistingStep({ step }: { step: Step }) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(step.subject);
  const [body, setBody] = useState(step.body);
  const [delayDays, setDelayDays] = useState(step.delayMinutes / (24 * 60));
  const [isPending, startTransition] = useTransition();
  const [deleting, startDeleteTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function save() {
    startTransition(async () => {
      await updateStep(step.id, { subject, body, delayMinutes: delayDays * 24 * 60 });
      setEditing(false);
      toast.success("Step updated");
    });
  }

  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-3 transition-opacity duration-150",
        deleting && "opacity-40 pointer-events-none"
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Step {step.order + 1} · {DelayLabel(step.delayMinutes)}</p>
        <div className="flex gap-1">
          {!editing ? (
            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /></Button>
          ) : (
            <>
              <Button variant="ghost" size="icon-sm" onClick={save} disabled={isPending}>
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setEditing(false)}><X className="h-3.5 w-3.5" /></Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Remove step"
            aria-label="Remove step"
            onClick={() => startDeleteTransition(() => deleteStep(step.id))}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs shrink-0">Delay (days)</Label>
            <Input type="number" min={0} value={delayDays} onChange={(e) => setDelayDays(Number(e.target.value) || 0)} className="w-20 h-8" />
          </div>
          <ComposerBody
            subject={subject}
            body={body}
            subjectRef={subjectRef}
            bodyRef={bodyRef}
            onSubjectChange={setSubject}
            onBodyChange={setBody}
            onInsertSubject={(token) => insertAtCursor(subjectRef.current, subject, setSubject, token)}
            onInsertBody={(token) => insertAtCursor(bodyRef.current, body, setBody, token)}
          />
        </div>
      ) : (
        <div>
          <div className="text-sm font-medium">
            <TemplateChips text={step.subject} mode="labels" />
          </div>
          <div className="mt-1.5">
            <TemplateChips text={step.body} mode="labels" />
          </div>
        </div>
      )}
    </div>
  );
}

export function StepEditor({ sequenceId, steps }: { sequenceId: string; steps: Step[] }) {
  // The draft "new step" form is only mounted when explicitly requested, and can
  // always be dismissed with no side effects — including while completely empty —
  // so agents are never left with an uncancellable in-progress step.
  const [showNewStep, setShowNewStep] = useState(steps.length === 0);

  return (
    <div className="space-y-3">
      {steps.map((s) => (
        <ExistingStep key={s.id} step={s} />
      ))}
      {showNewStep ? (
        <NewStepForm sequenceId={sequenceId} order={steps.length} onDone={() => setShowNewStep(false)} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 border-dashed animate-in fade-in duration-200"
          onClick={() => setShowNewStep(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Add Step
        </Button>
      )}
    </div>
  );
}
