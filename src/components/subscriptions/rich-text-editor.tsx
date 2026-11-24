"use client";

import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  Indent,
  Outdent,
  Quote,
  LinkIcon,
  Unlink,
  ImageIcon,
  Undo,
  Redo,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Minus,
  MousePointerClick,
  Baseline,
  Highlighter,
  MoveVertical,
  Variable,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputDialog } from "@/components/crm/input-dialog";
import { cn } from "@/lib/utils";
import { COLOR_SWATCHES, FONT_SIZES, HIGHLIGHT_SWATCHES, LINE_SPACINGS, emailEditorExtensions } from "@/components/email-editor/extensions";

/**
 * The ONE visual email editor, shared by the sequence step editor and the campaign form (TipTap, which was already a dependency; the formatting extensions it adds are the
 * official ones). It writes HTML that the server cleans against a strict allow-list before anything is stored or sent (server/email/sanitize-campaign-html.ts), so what is
 * typed or pasted here is never trusted; the editor only has to make good HTML easy to write.
 *
 * Text: styles (paragraph, three heading levels), bold, italic, underline, strikethrough, colour, highlight, size, line spacing, alignment, bulleted and numbered lists with
 * indent, quote. Links. Pictures (address, description, size, optional link). A call-to-action button, a divider and spacers. Undo / redo, and - when `variables` is given - a menu
 * that inserts the sequence's personalization variables.
 */
export type EditorVariable = { token: string; label: string; group: string };

export function RichTextEditor({
  value,
  onChange,
  variables,
  minHeight = 240,
  label = "Email content",
}: {
  value: string;
  onChange: (html: string) => void;
  /** The personalization variables the editor may insert (sequences). Omitted for campaigns, which have their own {{firstName}} fields. */
  variables?: EditorVariable[];
  minHeight?: number;
  label?: string;
}) {
  const [dialog, setDialog] = useState<null | "link" | "image" | "button">(null);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: emailEditorExtensions(),
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none px-3 py-2",
        style: `min-height:${minHeight}px`,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
      },
    },
  });

  // What is active at the cursor, so the buttons show their state; re-read on every change of selection or content.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            link: e.isActive("link"),
            image: e.isActive("image"),
            button: e.isActive("ctaButton"),
            alignLeft: e.isActive({ textAlign: "left" }),
            alignCenter: e.isActive({ textAlign: "center" }),
            alignRight: e.isActive({ textAlign: "right" }),
            block: e.isActive("heading", { level: 1 }) ? "h1" : e.isActive("heading", { level: 2 }) ? "h2" : e.isActive("heading", { level: 3 }) ? "h3" : "p",
            size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "",
            spacing: (e.getAttributes("paragraph").lineHeight as string | undefined) ?? (e.getAttributes("textStyle").lineHeight as string | undefined) ?? "",
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  if (!editor || !state) return null;
  const chain = () => editor.chain().focus();

  return (
    <div className="rounded-md border overflow-hidden" data-testid="email-editor">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1.5">
        <ToolbarSelect
          label="Text style"
          value={state.block}
          onChange={(v) => (v === "p" ? chain().setParagraph().run() : chain().toggleHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run())}
          options={[
            ["p", "Paragraph"],
            ["h1", "Heading 1"],
            ["h2", "Heading 2"],
            ["h3", "Heading 3"],
          ]}
        />
        <ToolbarSelect
          label="Font size"
          value={state.size}
          onChange={(v) => (v ? chain().setFontSize(v).run() : chain().unsetFontSize().run())}
          options={[["", "Size"], ...FONT_SIZES.map((s) => [s.value, s.label] as [string, string])]}
        />
        <ToolbarSelect
          label="Line spacing"
          value={state.spacing}
          onChange={(v) => (v ? chain().setLineHeight(v).run() : chain().unsetLineHeight().run())}
          options={[["", "Spacing"], ...LINE_SPACINGS.map((s) => [s.value, s.label] as [string, string])]}
        />
        <Divider />
        <ToolbarButton active={state.bold} onClick={() => chain().toggleBold().run()} label="Bold">
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.italic} onClick={() => chain().toggleItalic().run()} label="Italic">
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.underline} onClick={() => chain().toggleUnderline().run()} label="Underline">
          <Underline className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.strike} onClick={() => chain().toggleStrike().run()} label="Strikethrough">
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ColorMenu label="Text colour" icon={<Baseline className="h-3.5 w-3.5" />} swatches={COLOR_SWATCHES} onPick={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run())} />
        <ColorMenu label="Highlight colour" icon={<Highlighter className="h-3.5 w-3.5" />} swatches={HIGHLIGHT_SWATCHES} onPick={(c) => (c ? chain().setBackgroundColor(c).run() : chain().unsetBackgroundColor().run())} />
        <Divider />
        <ToolbarButton active={state.alignLeft} onClick={() => chain().setTextAlign("left").run()} label="Align left">
          <AlignLeft className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.alignCenter} onClick={() => chain().setTextAlign("center").run()} label="Align centre">
          <AlignCenter className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.alignRight} onClick={() => chain().setTextAlign("right").run()} label="Align right">
          <AlignRight className="h-3.5 w-3.5" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton active={state.bullet} onClick={() => chain().toggleBulletList().run()} label="Bulleted list">
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.ordered} onClick={() => chain().toggleOrderedList().run()} label="Numbered list">
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => chain().sinkListItem("listItem").run()} label="Indent">
          <Indent className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => chain().liftListItem("listItem").run()} label="Outdent">
          <Outdent className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.quote} onClick={() => chain().toggleBlockquote().run()} label="Quote">
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton active={state.link} onClick={() => setDialog("link")} label="Add or edit link">
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => chain().unsetLink().run()} label="Remove link" disabled={!state.link}>
          <Unlink className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.image} onClick={() => setDialog("image")} label={state.image ? "Edit image" : "Add image"}>
          <ImageIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton active={state.button} onClick={() => setDialog("button")} label={state.button ? "Edit button" : "Add button"}>
          <MousePointerClick className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => chain().setHorizontalRule().run()} label="Add divider">
          <Minus className="h-3.5 w-3.5" />
        </ToolbarButton>
        <SpacerMenu onPick={(height) => chain().insertContent({ type: "spacer", attrs: { height } }).run()} />
        {variables && variables.length > 0 && (
          <>
            <Divider />
            <VariableMenu variables={variables} onPick={(token) => chain().insertContent(token).run()} />
          </>
        )}
        <Divider />
        <ToolbarButton onClick={() => chain().undo().run()} label="Undo" disabled={!state.canUndo}>
          <Undo className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => chain().redo().run()} label="Redo" disabled={!state.canRedo}>
          <Redo className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
      <EditorContent editor={editor} />

      <InputDialog
        open={dialog === "link"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Add link"
        label="Link address"
        placeholder="https://"
        submitLabel="Add link"
        validate={(v) => validateEditorUrl(v, false)}
        onSubmit={(url) => chain().extendMarkRange("link").setLink({ href: url }).run()}
      />
      <ImageDialog open={dialog === "image"} onOpenChange={(o) => !o && setDialog(null)} editor={editor} />
      <ButtonDialog open={dialog === "button"} onOpenChange={(o) => !o && setDialog(null)} editor={editor} />
    </div>
  );
}

/** http(s) only (plus mailto: for links) — never javascript:, data: or a bare string. */
export function validateEditorUrl(value: string, imageOnly: boolean): string | null {
  if (value.length === 0) return "Enter a URL.";
  const ok = imageOnly ? /^https?:\/\/\S+$/i.test(value) : /^(https?:\/\/\S+|mailto:\S+@\S+)$/i.test(value);
  return ok ? null : imageOnly ? "Enter a full image address starting with https://" : "Enter a full address starting with https:// (or mailto:).";
}

/** A picture must be reachable by the people who receive the email: a public https address, never a file on this computer or inside the CRM. */
export function validateEmailImageUrl(value: string): string | null {
  if (!value.trim()) return "Enter the picture's address.";
  if (!/^https:\/\/[^\s]+$/i.test(value.trim())) return "Enter a public address starting with https://. A picture stored on this computer or inside the CRM cannot be shown to recipients.";
  return null;
}

function validateSize(value: string, label: string): string | null {
  if (!value.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 16 && n <= 1200 ? null : `${label} must be a whole number between 16 and 1200.`;
}

// ───────────────────────── dialogs ─────────────────────────

function ImageDialog({ open, onOpenChange, editor }: { open: boolean; onOpenChange: (open: boolean) => void; editor: Editor }) {
  const current = editor.isActive("image") ? editor.getAttributes("image") : null;
  // The form is remounted every time the dialog opens, so it always starts from the selected picture (or empty).
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open && <ImageForm key={String(open)} editor={editor} current={current} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ImageForm({ editor, current, onClose }: { editor: Editor; current: Record<string, string> | null; onClose: () => void }) {
  const [src, setSrc] = useState<string>(current?.src ?? "");
  const [alt, setAlt] = useState<string>(current?.alt ?? "");
  const [decorative, setDecorative] = useState(false);
  const [width, setWidth] = useState<string>(current?.width ?? "");
  const [height, setHeight] = useState<string>(current?.height ?? "");
  const [href, setHref] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const problem = validateEmailImageUrl(src) ?? (!alt.trim() && !decorative ? "Describe the picture, or tick 'decorative' if it adds no information." : null) ?? validateSize(width, "Width") ?? validateSize(height, "Height") ?? (href.trim() ? validateEditorUrl(href.trim(), false) : null);
    if (problem) {
      setError(problem);
      return;
    }
    const attrs = { src: src.trim(), alt: decorative ? "" : alt.trim(), width: width.trim() || null, height: height.trim() || null };
    if (current) editor.chain().focus().updateAttributes("image", attrs).run();
    else editor.chain().focus().setImage(attrs as never).run();
    // A linked picture: the picture is selected right after it is inserted, so the link goes round it.
    if (href.trim()) editor.chain().focus().setLink({ href: href.trim() }).run();
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{current ? "Edit image" : "Add image"}</DialogTitle>
        <DialogDescription>The picture must be on the web, so the people who receive the email can see it.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Field label="Image address" htmlFor="img-src">
          <Input id="img-src" value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://" autoFocus />
        </Field>
        <Field label="Description (alt text)" htmlFor="img-alt" hint="Shown when pictures are blocked and read out by screen readers.">
          <Input id="img-alt" value={alt} onChange={(e) => setAlt(e.target.value)} disabled={decorative} placeholder="A beach in Lisbon at sunset" />
        </Field>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={decorative} onChange={(e) => setDecorative(e.target.checked)} /> This picture is decorative (no description needed)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Width (pixels)" htmlFor="img-w" hint="Optional">
            <Input id="img-w" inputMode="numeric" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="auto" />
          </Field>
          <Field label="Height (pixels)" htmlFor="img-h" hint="Optional">
            <Input id="img-h" inputMode="numeric" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="auto" />
          </Field>
        </div>
        {!current && (
          <Field label="Link the picture to (optional)" htmlFor="img-href">
            <Input id="img-href" value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" />
          </Field>
        )}
        <p className="text-xs text-muted-foreground">To align the picture, use the alignment buttons while it is selected.</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={submit}>
          {current ? "Save image" : "Add image"}
        </Button>
      </DialogFooter>
    </>
  );
}

function ButtonDialog({ open, onOpenChange, editor }: { open: boolean; onOpenChange: (open: boolean) => void; editor: Editor }) {
  const current = editor.isActive("ctaButton") ? editor.getAttributes("ctaButton") : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">{open && <ButtonForm key={String(open)} editor={editor} current={current} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ButtonForm({ editor, current, onClose }: { editor: Editor; current: Record<string, string> | null; onClose: () => void }) {
  const [label, setLabel] = useState(current?.label ?? "Book now");
  const [href, setHref] = useState(current?.href ?? "");
  const [align, setAlign] = useState(current?.align ?? "center");
  const [bg, setBg] = useState(current?.bg ?? "#1d4ed8");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const problem = !label.trim() ? "Enter the button text." : label.trim().length > 40 ? "Keep the button text under 40 characters." : validateEditorUrl(href.trim(), false);
    if (problem) {
      setError(problem);
      return;
    }
    const attrs = { label: label.trim(), href: href.trim(), align, bg, color: "#ffffff" };
    if (current) editor.chain().focus().updateAttributes("ctaButton", attrs).run();
    else editor.chain().focus().insertContent({ type: "ctaButton", attrs }).run();
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{current ? "Edit button" : "Add button"}</DialogTitle>
        <DialogDescription>A button that opens a web page. It looks the same in every email program.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Field label="Button text" htmlFor="btn-label">
          <Input id="btn-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoFocus />
        </Field>
        <Field label="Where it goes" htmlFor="btn-href">
          <Input id="btn-href" value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Alignment" htmlFor="btn-align">
            <select id="btn-align" value={align} onChange={(e) => setAlign(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </Field>
          <Field label="Colour" htmlFor="btn-bg">
            <select id="btn-bg" value={bg} onChange={(e) => setBg(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {[
                ["#1d4ed8", "Blue"],
                ["#15803d", "Green"],
                ["#b91c1c", "Red"],
                ["#c2410c", "Orange"],
                ["#6d28d9", "Purple"],
                ["#111827", "Black"],
              ].map(([v, name]) => (
                <option key={v} value={v}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={submit}>
          {current ? "Save button" : "Add button"}
        </Button>
      </DialogFooter>
    </>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ───────────────────────── toolbar parts ─────────────────────────

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />;
}

function ToolbarButton({ children, onClick, active, label, disabled }: { children: React.ReactNode; onClick: () => void; active?: boolean; label: string; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
      className={cn(active && "bg-accent text-accent-foreground")}
    >
      {children}
    </Button>
  );
}

function ToolbarSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]> }) {
  return (
    <select
      aria-label={label}
      title={label}
      value={options.some(([v]) => v === value) ? value : options[0][0]}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-md border bg-background px-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

function ColorMenu({ label, icon, swatches, onPick }: { label: string; icon: React.ReactNode; swatches: readonly string[]; onPick: (color: string | null) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" title={label} aria-label={label}>
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
        <div className="grid grid-cols-6 gap-1.5 p-2">
          {swatches.map((c) => (
            <button key={c} type="button" aria-label={`${label} ${c}`} title={c} onClick={() => onPick(c)} className="h-5 w-5 rounded border" style={{ backgroundColor: c }} />
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onPick(null)}>No colour</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SpacerMenu({ onPick }: { onPick: (height: number) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" title="Add space" aria-label="Add space">
          <MoveVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Empty space</DropdownMenuLabel>
        {[
          [16, "Small (16 px)"],
          [32, "Medium (32 px)"],
          [56, "Large (56 px)"],
        ].map(([h, name]) => (
          <DropdownMenuItem key={h} onSelect={() => onPick(h as number)}>
            {name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function VariableMenu({ variables, onPick }: { variables: EditorVariable[]; onPick: (token: string) => void }) {
  const groups = [...new Set(variables.map((v) => v.group))];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
          <Variable className="h-3.5 w-3.5" /> Insert variable
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        {groups.map((group, i) => (
          <div key={group}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{group}</DropdownMenuLabel>
            {variables
              .filter((v) => v.group === group)
              .map((v) => (
                <DropdownMenuItem key={v.token} onSelect={() => onPick(v.token)}>
                  {v.label}
                </DropdownMenuItem>
              ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
