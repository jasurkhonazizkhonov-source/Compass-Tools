"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Check, X, Loader2, Variable, Clock, Eye, PenLine, Code2, Copy, ArrowUp, ArrowDown, AlertTriangle, CircleAlert, Smartphone, Monitor, Mail, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { RichTextEditor, type EditorVariable } from "@/components/subscriptions/rich-text-editor";
import { SEQUENCE_VARIABLES, VARIABLE_TOKEN_META, variableToken } from "@/lib/sequence-variables";
import { draftDiffers, htmlToPlainText, parseStepDraft, stepDraftKey, textToHtml } from "@/lib/sequence-step-draft";
import { addStep, updateStep, deleteStep, duplicateStep, moveStep } from "@/server/actions/sequences";
import { analyzeSequenceStepDraft, previewSequenceStepEmail, type StepPreview } from "@/server/actions/sequence-step-content";
import type { StepAnalysis } from "@/server/email/sequence-content";
import { cn } from "@/lib/utils";

type BodyFormat = "TEXT" | "HTML";
type Step = { id: string; subject: string; body: string; bodyFormat?: BodyFormat; delayMinutes: number; order: number };
type Values = { subject: string; body: string; bodyFormat: BodyFormat; delayDays: number };

const EDITOR_VARIABLES: EditorVariable[] = SEQUENCE_VARIABLES.map((v) => ({ token: variableToken(v.key), label: v.label, group: v.group }));

/** Inserts a variable token at the current cursor position in an input or
 * textarea, falling back to appending it when the field isn't focused. Used
 * for both the subject field and a plain-text body field. */
function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, setValue: (next: string) => void, token: string) {
  if (!el) {
    setValue(value + token);
    return;
  }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  setValue(value.slice(0, start) + token + value.slice(end));
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

/** Splits template text on {{token}} boundaries and renders recognized tokens as chips instead of raw syntax (their label, or a realistic sample value). */
function TemplateChips({ text, mode }: { text: string; mode: "labels" | "sample" }) {
  if (!text.trim()) return <p className="text-xs text-muted-foreground italic">Nothing written yet.</p>;
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
        <span key={key++} className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 mx-0.5 text-xs font-medium align-baseline", mode === "labels" ? "bg-primary/10 text-primary" : "bg-success/15 text-success")}>
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

// ───────────────────────── preview, source and checks ─────────────────────────

const DEVICES = [
  { key: "desktop", label: "Desktop", width: 720, icon: Monitor },
  { key: "email", label: "Email width", width: 600, icon: Mail },
  { key: "mobile", label: "Mobile", width: 375, icon: Smartphone },
] as const;

/** The email exactly as the server renders it for a customer (sample data, the signature and the unsubscribe footer included), in a sandboxed frame, or as its source. */
function RenderedEmail({ values, view }: { values: Values; view: "preview" | "source" }) {
  const [device, setDevice] = useState<(typeof DEVICES)[number]["key"]>("email");
  const [result, setResult] = useState<StepPreview | null>(null);
  const draft = JSON.stringify({ s: values.subject, b: values.body, f: values.bodyFormat });
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      previewSequenceStepEmail({ subject: values.subject, body: values.body, bodyFormat: values.bodyFormat })
        .then((r) => !stale && setResult(r))
        .catch(() => !stale && setResult({ ok: false, error: "The preview could not be prepared. Please try again." }));
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // The draft string stands for subject, body and format together.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (!result) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing the preview...
      </p>
    );
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {result.error}
      </p>
    );
  }
  if (view === "source") {
    return (
      <pre data-testid="email-source" aria-label="Email HTML source (read only)" className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">
        {result.html}
      </pre>
    );
  }
  const width = DEVICES.find((d) => d.key === device)!.width;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs">
          <span className="text-muted-foreground">Subject: </span>
          <span className="font-medium">{result.subject}</span> <span className="text-muted-foreground">(sample data)</span>
        </p>
        <div role="group" aria-label="Preview width" className="inline-flex max-w-full rounded-md border p-0.5">
          {DEVICES.map((d) => (
            <Button key={d.key} type="button" size="sm" variant={device === d.key ? "secondary" : "ghost"} aria-pressed={device === d.key} aria-label={d.label} title={d.label} className="h-7 gap-1 px-2 text-xs" onClick={() => setDevice(d.key)}>
              <d.icon className="h-3.5 w-3.5" /> <span className="hidden sm:inline">{d.label}</span>
            </Button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border bg-muted/30 p-2">
        {/* Sandboxed with no permissions: nothing in the email can run, navigate the page or reach the CRM. */}
        <iframe title="Email preview" sandbox="" srcDoc={result.html} data-testid="email-preview" data-device={device} style={{ width, maxWidth: "100%", height: 480, border: 0, background: "#fff", display: "block", margin: "0 auto" }} />
      </div>
    </div>
  );
}

/** Errors (they stop the step being saved) and warnings (advice), from the server's own checks. */
function Checks({ values, onAnalysis }: { values: Values; onAnalysis: (a: StepAnalysis | null) => void }) {
  const [analysis, setAnalysis] = useState<StepAnalysis | null>(null);
  const draft = JSON.stringify({ s: values.subject, b: values.body, f: values.bodyFormat });
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      analyzeSequenceStepDraft({ subject: values.subject, body: values.body, bodyFormat: values.bodyFormat })
        .then((a) => {
          if (stale) return;
          setAnalysis(a);
          onAnalysis(a);
        })
        .catch(() => !stale && onAnalysis(null));
    }, 500);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  if (!analysis || (analysis.errors.length === 0 && analysis.warnings.length === 0)) {
    return analysis ? (
      <p className="text-xs text-success" role="status" data-testid="step-checks">
        No problems found.
      </p>
    ) : null;
  }
  return (
    <ul className="space-y-1" aria-label="Checks" data-testid="step-checks">
      {analysis.errors.map((e, i) => (
        <li key={`e${i}`} role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{e.message}</span>
        </li>
      ))}
      {analysis.warnings.map((w, i) => (
        <li key={`w${i}`} className="flex items-start gap-1.5 text-xs text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{w.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────── the composer (new and existing steps) ─────────────────────────

function StepComposer({
  initial,
  draftKey,
  isNew,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: Values;
  draftKey: string;
  isNew: boolean;
  saveLabel: string;
  onSave: (values: Values) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Values>(initial);
  const [analysis, setAnalysis] = useState<StepAnalysis | null>(null);
  const [offered, setOffered] = useState<Values | null>(null);
  const [isPending, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));

  // A draft kept in this browser from an earlier, unsaved session: offered once, never applied silently.
  useEffect(() => {
    // Read after mount (never during render: the server has no browser storage) and set from a callback, so the first paint is identical on server and client.
    const timer = setTimeout(() => {
      try {
        const stored = parseStepDraft(window.localStorage.getItem(draftKey));
        if (stored && draftDiffers(stored, initial)) setOffered({ subject: stored.subject, body: stored.body, bodyFormat: stored.bodyFormat, delayDays: stored.delayDays });
      } catch {
        // storage unavailable (private window, blocked): drafts simply are not kept
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  // Autosave while writing (only when there is something that differs from what is saved).
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (draftDiffers({ ...values, savedAt: 0 }, initial)) window.localStorage.setItem(draftKey, JSON.stringify({ ...values, savedAt: Date.now() }));
        else window.localStorage.removeItem(draftKey);
      } catch {
        // see above
      }
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, draftKey]);

  const blocked = !!analysis && !analysis.ok;

  function submit() {
    if (!values.subject.trim() || !values.body.trim()) {
      toast.error("Subject and body are required");
      return;
    }
    startTransition(async () => {
      try {
        await onSave(values);
        try {
          window.localStorage.removeItem(draftKey);
        } catch {
          // ignore
        }
      } catch (err) {
        toast.error(err instanceof Error && err.message.startsWith("This email cannot be saved") ? err.message : "The step could not be saved. Please try again.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {offered && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="draft-offer">
          <span>You have an unsaved draft of this step from earlier in this browser.</span>
          <span className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setValues(offered);
                setOffered(null);
              }}
            >
              Restore draft
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                try {
                  window.localStorage.removeItem(draftKey);
                } catch {
                  // ignore
                }
                setOffered(null);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Label className="text-xs shrink-0 flex items-center gap-1" htmlFor={`delay-${draftKey}`}>
          <Clock className="h-3 w-3" /> Delay (days)
        </Label>
        <Input id={`delay-${draftKey}`} type="number" min={0} value={values.delayDays} onChange={(e) => set({ delayDays: Number(e.target.value) || 0 })} className="w-20 h-8" />
      </div>

      <Tabs defaultValue="edit">
        <TabsList className="max-w-full">
          <TabsTrigger value="edit" className="gap-1.5">
            <PenLine className="h-3.5 w-3.5" /> Edit
          </TabsTrigger>
          <TabsTrigger value="preview" className="gap-1.5">
            <Eye className="h-3.5 w-3.5" /> Preview
          </TabsTrigger>
          <TabsTrigger value="source" className="gap-1.5">
            <Code2 className="h-3.5 w-3.5" /> HTML
          </TabsTrigger>
        </TabsList>
        <TabsContent value="edit" className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground" htmlFor={`subject-${draftKey}`}>
                Subject
              </Label>
              <InsertVariableMenu onInsert={(token) => insertAtCursor(subjectRef.current, values.subject, (v) => set({ subject: v }), token)} />
            </div>
            <Input id={`subject-${draftKey}`} ref={subjectRef} value={values.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Email subject" />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-muted-foreground">Body</Label>
              {values.bodyFormat === "TEXT" && (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setConvertOpen(true)}>
                    <Wand2 className="h-3.5 w-3.5" /> Use the visual editor
                  </Button>
                  <InsertVariableMenu onInsert={(token) => insertAtCursor(bodyRef.current, values.body, (v) => set({ body: v }), token)} />
                </div>
              )}
            </div>
            {values.bodyFormat === "HTML" ? (
              <RichTextEditor value={values.body} onChange={(html) => set({ body: html })} variables={EDITOR_VARIABLES} label="Email body" />
            ) : (
              <Textarea
                ref={bodyRef}
                value={values.body}
                onChange={(e) => set({ body: e.target.value })}
                rows={5}
                aria-label="Email body (plain text)"
                placeholder={"Hi {{contact_first_name}},\n\nI wanted to follow up regarding your trip from {{departure_city}} to {{arrival_city}}."}
              />
            )}
          </div>
        </TabsContent>
        <TabsContent value="preview" className="mt-2">
          <RenderedEmail values={values} view="preview" />
        </TabsContent>
        <TabsContent value="source" className="mt-2">
          <p className="mb-1.5 text-[11px] text-muted-foreground">What the customer&apos;s mail program receives (read only). Edit the email in the Edit tab.</p>
          <RenderedEmail values={values} view="source" />
        </TabsContent>
      </Tabs>

      <Checks values={values} onAnalysis={setAnalysis} />

      <div className="flex gap-2">
        <Button onClick={submit} disabled={isPending || blocked} size="sm" className="gap-1.5" title={blocked ? "Fix the problems listed above first" : undefined}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isNew ? <Plus className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          {saveLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>

      <ConfirmDialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        title="Use the visual editor for this step?"
        description="The step keeps its words, paragraphs and links, and you can then add formatting, pictures and buttons. This step will be saved as a visual email from now on."
        confirmLabel="Use the visual editor"
        onConfirm={async () => {
          set({ bodyFormat: "HTML", body: textToHtml(values.body) });
        }}
      />
    </div>
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
  return (
    <div className="rounded-lg border border-dashed p-4 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">Step {order + 1}</p>
        <Button variant="ghost" size="icon-sm" onClick={onDone} title="Remove step" aria-label="Remove step">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <StepComposer
        // New steps start in the visual editor; every older step stays plain text until someone chooses to convert it.
        initial={{ subject: "", body: "", bodyFormat: "HTML", delayDays: order === 0 ? 0 : 2 }}
        draftKey={stepDraftKey(null, sequenceId)}
        isNew
        saveLabel="Add Step"
        onSave={async (v) => {
          await addStep({ sequenceId, subject: v.subject, body: v.body, bodyFormat: v.bodyFormat, delayMinutes: v.delayDays * 24 * 60 });
          toast.success("Step added");
          onDone();
        }}
        onCancel={onDone}
      />
    </div>
  );
}

function ExistingStep({ step, sequenceId, index, total }: { step: Step; sequenceId: string; index: number; total: number }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, startTransition] = useTransition();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const format: BodyFormat = step.bodyFormat === "HTML" ? "HTML" : "TEXT";
  const saved: Values = { subject: step.subject, body: step.body, bodyFormat: format, delayDays: step.delayMinutes / (24 * 60) };

  function duplicate() {
    startTransition(async () => {
      try {
        await duplicateStep(step.id);
        toast.success("Step copied to the end of the sequence");
        router.refresh();
      } catch {
        toast.error("The step could not be copied.");
      }
    });
  }
  function move(direction: "up" | "down") {
    startTransition(async () => {
      try {
        const r = await moveStep(step.id, direction);
        if (!r.ok) toast.error(r.error);
        else router.refresh();
      } catch {
        toast.error("The step could not be moved.");
      }
    });
  }

  return (
    <div className={cn("rounded-lg border p-4 space-y-3")} data-testid="sequence-step" data-format={format}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">
          Step {step.order + 1} · {DelayLabel(step.delayMinutes)}
          {format === "HTML" && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">Visual email</span>}
        </p>
        <div className="flex gap-1">
          {!editing && (
            <>
              <Button variant="ghost" size="icon-sm" title="Move earlier" aria-label={`Move step ${step.order + 1} earlier`} disabled={busy || index === 0} onClick={() => move("up")}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Move later" aria-label={`Move step ${step.order + 1} later`} disabled={busy || index === total - 1} onClick={() => move("down")}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Duplicate step" aria-label={`Duplicate step ${step.order + 1}`} disabled={busy} onClick={duplicate}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon-sm" title="Edit step" aria-label={`Edit step ${step.order + 1}`} onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon-sm" title="Remove step" aria-label="Remove step" onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      {editing ? (
        <StepComposer
          initial={saved}
          draftKey={stepDraftKey(step.id, sequenceId)}
          isNew={false}
          saveLabel="Save step"
          onSave={async (v) => {
            await updateStep(step.id, { subject: v.subject, body: v.body, bodyFormat: v.bodyFormat, delayMinutes: v.delayDays * 24 * 60 });
            setEditing(false);
            toast.success("Step updated");
            router.refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div>
          <div className="text-sm font-medium">
            <TemplateChips text={step.subject} mode="labels" />
          </div>
          <div className="mt-1.5">{format === "HTML" ? <TemplateChips text={htmlToPlainText(step.body)} mode="labels" /> : <TemplateChips text={step.body} mode="labels" />}</div>
        </div>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Remove this step?"
        description="The step is removed from the sequence. This cannot be undone."
        confirmLabel="Remove step"
        onConfirm={async () => {
          await deleteStep(step.id);
        }}
      />
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
      {steps.map((s, i) => (
        <ExistingStep key={s.id} step={s} sequenceId={sequenceId} index={i} total={steps.length} />
      ))}
      {showNewStep ? (
        <NewStepForm sequenceId={sequenceId} order={steps.length} onDone={() => setShowNewStep(false)} />
      ) : (
        <Button variant="outline" size="sm" className="gap-1.5 border-dashed animate-in fade-in duration-200" onClick={() => setShowNewStep(true)}>
          <Plus className="h-3.5 w-3.5" /> Add Step
        </Button>
      )}
    </div>
  );
}
