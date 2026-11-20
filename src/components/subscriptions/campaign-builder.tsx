"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Trash2, Monitor, Smartphone, Save, Send, Heading as HeadingIcon, Type, ImageIcon, MousePointerClick, Minus, MoveVertical, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DESIGN_TEMPLATES, hasErrors, newBlock, validateDesign, type BlockAlign, type CampaignBlock, type CampaignDesign, type DesignIssue } from "@/lib/campaign-blocks";
import { previewCampaignDesign, saveCampaignDesign, sendCampaignTest } from "@/server/actions/campaign-delivery";

// The preview frame loads nothing but its own inline styles and images: no scripts, frames, forms or connections (same policy as the campaign editor's preview).
const PREVIEW_CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:";

const PALETTE: Array<{ type: CampaignBlock["type"]; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { type: "heading", label: "Heading", icon: HeadingIcon },
  { type: "text", label: "Text", icon: Type },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "button", label: "Button", icon: MousePointerClick },
  { type: "divider", label: "Divider", icon: Minus },
  { type: "spacer", label: "Spacer", icon: MoveVertical },
];

export type BuilderInitial = { campaignId?: string; name: string; subject: string; previewText: string; design: CampaignDesign };

/**
 * Block-based campaign builder. The author arranges blocks (heading, text, image, button, divider, spacer); the SERVER validates the design again, turns it into
 * email-safe HTML, cleans it and stores both. Buttons and linked images accept only full http(s) addresses. Text may use personalization such as {{firstName|there}}
 * (the part after | is the fallback used when a subscriber has no first name). The preview is rendered by the server with the same shell, sanitizer and personalization the
 * real send uses, so what is shown is what is sent; the unsubscribe link is added by that shell and cannot be removed here.
 */
export function CampaignBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter();
  const [campaignId, setCampaignId] = useState(initial.campaignId);
  const [name, setName] = useState(initial.name);
  const [subject, setSubject] = useState(initial.subject);
  const [previewText, setPreviewText] = useState(initial.previewText);
  const [design, setDesign] = useState<CampaignDesign>(initial.design);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [previewHtml, setPreviewHtml] = useState("");
  const [serverIssues, setServerIssues] = useState<DesignIssue[] | null>(null);
  const [pending, startTransition] = useTransition();
  const seq = useRef(0);

  // Instant client-side validation (a convenience; the server decides on save).
  const issues = useMemo(() => validateDesign(design, subject), [design, subject]);
  const blocked = hasErrors(issues);

  // Debounced server-rendered preview; a slower, older response never overwrites a newer one.
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await previewCampaignDesign(design, subject);
        if (seq.current === mine) setPreviewHtml(r.html);
      } catch {
        /* the previous preview stays */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [design, subject]);

  function update(id: string, patch: Partial<CampaignBlock>) {
    setDesign((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as CampaignBlock) : b)) }));
  }
  function move(id: string, delta: -1 | 1) {
    setDesign((d) => {
      const i = d.blocks.findIndex((b) => b.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.blocks.length) return d;
      const blocks = [...d.blocks];
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
      return { ...d, blocks };
    });
  }
  const remove = (id: string) => setDesign((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));
  const add = (type: CampaignBlock["type"]) => setDesign((d) => ({ ...d, blocks: [...d.blocks, newBlock(type)] }));

  function save() {
    startTransition(async () => {
      try {
        const r = await saveCampaignDesign({ campaignId, name, subject, previewText, design });
        setServerIssues(r.issues ?? null);
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        toast.success("Draft saved");
        if (!campaignId) {
          setCampaignId(r.campaignId);
          router.replace(`/subscriptions/campaigns/builder?id=${r.campaignId}`);
        }
      } catch {
        toast.error("The draft could not be saved right now.");
      }
    });
  }

  function test() {
    if (!campaignId) {
      toast.error("Save the draft first.");
      return;
    }
    startTransition(async () => {
      const r = await sendCampaignTest(campaignId);
      if (r.ok) toast.success("Test email sent to your own address (sample name and details)");
      else toast.error(r.error);
    });
  }

  const shown = serverIssues ?? issues;
  const frameWidth = device === "mobile" ? 375 : 680;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="campaign-builder">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cb-name">Campaign name</Label>
            <Input id="cb-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter schedule 2026" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cb-subject">Subject line</Label>
            <Input id="cb-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Use {{firstName|there}} to personalize" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cb-preview">Inbox preview text (optional)</Label>
            <Input id="cb-preview" value={previewText} onChange={(e) => setPreviewText(e.target.value)} placeholder="The short line shown after the subject in the inbox" maxLength={200} />
          </div>
        </div>

        {design.blocks.length === 0 && (
          <div className="flex flex-wrap gap-2" data-testid="builder-templates">
            <span className="text-xs text-muted-foreground">Start from a template:</span>
            {DESIGN_TEMPLATES.map((t) => (
              <Button key={t.id} type="button" size="sm" variant="outline" onClick={() => setDesign(t.design())}>{t.name}</Button>
            ))}
          </div>
        )}

        <ol className="space-y-3" aria-label="Blocks">
          {design.blocks.map((b, i) => (
            <li key={b.id} className="space-y-2 rounded-lg border bg-card p-3" data-testid="builder-block">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{b.type}</span>
                <span className="flex items-center gap-1">
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move block ${i + 1} up`} disabled={i === 0} onClick={() => move(b.id, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move block ${i + 1} down`} disabled={i === design.blocks.length - 1} onClick={() => move(b.id, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete block ${i + 1}`} onClick={() => remove(b.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </span>
              </div>
              <BlockEditor block={b} onChange={(p) => update(b.id, p)} issues={shown.filter((x) => x.blockId === b.id)} />
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Add a block">
          {PALETTE.map(({ type, label, icon: Icon }) => (
            <Button key={type} type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => add(type)}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="cb-accent" className="text-xs">Accent colour</Label>
          <input id="cb-accent" type="color" value={design.accent} onChange={(e) => setDesign((d) => ({ ...d, accent: e.target.value }))} className="h-8 w-10 cursor-pointer rounded border" />
        </div>

        <ul className="space-y-1" aria-label="Checks" data-testid="builder-issues">
          {shown.filter((i) => i.blockId === null).map((i, k) => <IssueLine key={k} issue={i} />)}
          {blocked && <li className="text-xs text-muted-foreground">Fix the items marked above before this campaign can be queued.</li>}
        </ul>

        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button type="button" size="sm" className="gap-1.5" onClick={save} disabled={pending}><Save className="h-3.5 w-3.5" /> Save draft</Button>
          <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={test} disabled={pending || !campaignId}><Send className="h-3.5 w-3.5" /> Send test to me</Button>
          {campaignId && <Button type="button" size="sm" variant="ghost" onClick={() => router.push(`/subscriptions/campaigns/${campaignId}`)}>Open campaign</Button>}
        </div>
      </div>

      <Card className="h-fit shadow-none lg:sticky lg:top-4">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium">Preview (sample name: Alex)</CardTitle>
          <div className="flex items-center gap-1" role="group" aria-label="Preview size">
            <Button type="button" size="icon-sm" variant={device === "desktop" ? "secondary" : "ghost"} aria-label="Desktop preview" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")}><Monitor className="h-3.5 w-3.5" /></Button>
            <Button type="button" size="icon-sm" variant={device === "mobile" ? "secondary" : "ghost"} aria-label="Mobile preview" aria-pressed={device === "mobile"} onClick={() => setDevice("mobile")}><Smartphone className="h-3.5 w-3.5" /></Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <iframe
            title="Campaign preview"
            data-testid="builder-preview"
            sandbox=""
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${previewHtml}`}
            style={{ width: frameWidth, maxWidth: "100%", height: 640 }}
            className="mx-auto rounded border bg-white"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function IssueLine({ issue }: { issue: DesignIssue }) {
  const Icon = issue.severity === "error" ? XCircle : AlertTriangle;
  return (
    <li className={`flex items-start gap-1.5 text-xs ${issue.severity === "error" ? "text-destructive" : "text-warning-foreground"}`} data-severity={issue.severity}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> <span>{issue.message}</span>
    </li>
  );
}

const ALIGNS: BlockAlign[] = ["left", "center", "right"];
function AlignSelect({ value, onChange, label }: { value: BlockAlign; onChange: (v: BlockAlign) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as BlockAlign)} className="h-8 rounded-md border bg-background px-2 text-xs">
      {ALIGNS.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );
}

function BlockEditor({ block, onChange, issues }: { block: CampaignBlock; onChange: (patch: Partial<CampaignBlock>) => void; issues: DesignIssue[] }) {
  const problems = issues.length > 0 && (
    <ul className="space-y-0.5" aria-label="Problems with this block">{issues.map((i, k) => <IssueLine key={k} issue={i} />)}</ul>
  );
  switch (block.type) {
    case "heading":
      return (
        <div className="space-y-2">
          <Input aria-label="Heading text" value={block.text} onChange={(e) => onChange({ text: e.target.value })} />
          <div className="flex gap-2">
            <select aria-label="Heading size" value={block.level} onChange={(e) => onChange({ level: Number(e.target.value) as 1 | 2 | 3 })} className="h-8 rounded-md border bg-background px-2 text-xs">
              <option value={1}>Large</option><option value={2}>Medium</option><option value={3}>Small</option>
            </select>
            <AlignSelect label="Heading alignment" value={block.align} onChange={(align) => onChange({ align })} />
          </div>
          {problems}
        </div>
      );
    case "text":
      return (
        <div className="space-y-2">
          <Textarea aria-label="Text" rows={5} value={block.text} onChange={(e) => onChange({ text: e.target.value })} />
          <div className="flex items-center justify-between">
            <AlignSelect label="Text alignment" value={block.align} onChange={(align) => onChange({ align })} />
            <span className="text-[11px] text-muted-foreground">Fields: {"{{firstName|there}}"}, {"{{lastName}}"}, {"{{fullName}}"}, {"{{email}}"}</span>
          </div>
          {problems}
        </div>
      );
    case "image":
      return (
        <div className="space-y-2">
          <Input aria-label="Image address" placeholder="https://… (the image must already be online)" value={block.src} onChange={(e) => onChange({ src: e.target.value })} />
          <Input aria-label="Image description (alt text)" placeholder="Describe the image for people who cannot see it" value={block.alt} onChange={(e) => onChange({ alt: e.target.value })} />
          <Input aria-label="Image link (optional)" placeholder="https://… where a click goes (optional)" value={block.href} onChange={(e) => onChange({ href: e.target.value })} />
          <label className="flex items-center gap-2 text-xs">Width
            <input type="range" min={20} max={100} step={5} value={block.widthPercent} onChange={(e) => onChange({ widthPercent: Number(e.target.value) })} aria-label="Image width percent" /> {block.widthPercent}%
          </label>
          {problems}
        </div>
      );
    case "button":
      return (
        <div className="space-y-2">
          <Input aria-label="Button label" value={block.label} onChange={(e) => onChange({ label: e.target.value })} />
          <Input aria-label="Button link" placeholder="https://…" value={block.url} onChange={(e) => onChange({ url: e.target.value })} />
          <div className="flex items-center gap-2">
            <AlignSelect label="Button alignment" value={block.align} onChange={(align) => onChange({ align })} />
            <input type="color" aria-label="Button colour" value={block.color} onChange={(e) => onChange({ color: e.target.value })} className="h-8 w-10 cursor-pointer rounded border" />
          </div>
          {problems}
        </div>
      );
    case "spacer":
      return (
        <label className="flex items-center gap-2 text-xs">Height
          <input type="range" min={4} max={120} step={4} value={block.height} onChange={(e) => onChange({ height: Number(e.target.value) })} aria-label="Spacer height" /> {block.height}px
        </label>
      );
    case "divider":
      return <p className="text-xs text-muted-foreground">A thin horizontal line.</p>;
  }
}
