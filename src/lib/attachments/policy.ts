// What a Lead document may be, and how its name / key / size are decided. Pure (no I/O, no server-only imports) so the browser can use
// the same lists for its pre-checks while the SERVER remains the only authority: every rule here is re-applied in the upload action and
// the stored object is re-verified (size + magic bytes) before an attachment becomes visible.
//
// Deliberately an ALLOWLIST of ordinary business-document formats. Not allowed, by design: video, audio, executables / scripts,
// HTML, SVG (it can carry script), archives (ZIP / RAR / 7z), macro-enabled Office files (.docm / .xlsm / .pptm) and anything not listed.

export type SignatureKind = "pdf" | "jpeg" | "png" | "webp" | "ole" | "zip" | "text";

export type AllowedType = {
  ext: string;
  /** The canonical MIME type stored and served for this extension — chosen here, never taken from the browser. */
  mime: string;
  /** Other MIME types browsers legitimately report for this extension (e.g. Windows reports .csv as application/vnd.ms-excel). */
  alsoAccepted: string[];
  signature: SignatureKind;
  /** Safe to open in the browser tab; everything else is always served as a download. */
  inline: boolean;
  label: string;
};

const OOXML = (ext: string, mime: string, label: string): AllowedType => ({ ext, mime, alsoAccepted: [], signature: "zip", inline: false, label });

export const ALLOWED_TYPES: AllowedType[] = [
  { ext: "pdf", mime: "application/pdf", alsoAccepted: ["application/x-pdf"], signature: "pdf", inline: true, label: "PDF" },
  { ext: "jpg", mime: "image/jpeg", alsoAccepted: ["image/pjpeg"], signature: "jpeg", inline: true, label: "JPEG image" },
  { ext: "jpeg", mime: "image/jpeg", alsoAccepted: ["image/pjpeg"], signature: "jpeg", inline: true, label: "JPEG image" },
  { ext: "png", mime: "image/png", alsoAccepted: [], signature: "png", inline: true, label: "PNG image" },
  { ext: "webp", mime: "image/webp", alsoAccepted: [], signature: "webp", inline: true, label: "WebP image" },
  { ext: "doc", mime: "application/msword", alsoAccepted: [], signature: "ole", inline: false, label: "Word document" },
  OOXML("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Word document"),
  { ext: "xls", mime: "application/vnd.ms-excel", alsoAccepted: [], signature: "ole", inline: false, label: "Excel spreadsheet" },
  OOXML("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Excel spreadsheet"),
  { ext: "ppt", mime: "application/vnd.ms-powerpoint", alsoAccepted: [], signature: "ole", inline: false, label: "PowerPoint presentation" },
  OOXML("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "PowerPoint presentation"),
  { ext: "txt", mime: "text/plain", alsoAccepted: [], signature: "text", inline: false, label: "Text file" },
  { ext: "csv", mime: "text/csv", alsoAccepted: ["application/csv", "application/vnd.ms-excel", "text/plain"], signature: "text", inline: false, label: "CSV file" },
];

const BY_EXT = new Map(ALLOWED_TYPES.map((t) => [t.ext, t]));

/** For the file picker's `accept` attribute and the UI's help text. */
export const ALLOWED_EXTENSIONS = ALLOWED_TYPES.map((t) => t.ext);
export const ACCEPT_ATTRIBUTE = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",");
export const ALLOWED_EXTENSIONS_LABEL = "PDF, JPG, PNG, WebP, Word, Excel, PowerPoint, TXT, CSV";

/** An earlier extension segment ("invoice.exe.pdf") that would make the file look like something it is not. */
const DANGEROUS_SEGMENTS = new Set([
  "exe", "dll", "com", "bat", "cmd", "scr", "msi", "msp", "jar", "js", "mjs", "vbs", "vbe", "wsf", "ps1", "psm1", "sh", "bash", "php",
  "py", "rb", "pl", "html", "htm", "xhtml", "svg", "hta", "lnk", "reg", "apk", "app", "dmg", "iso", "zip", "rar", "7z", "gz", "tar",
  "docm", "xlsm", "pptm",
]);

export const MAX_FILE_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 500;
/** Hard ceiling regardless of configuration; ordinary CRM documents are far smaller. */
export const HARD_MAX_SIZE_MB = 25;
export const DEFAULT_MAX_SIZE_MB = 10;
/** An upload that is requested but never completed is treated as abandoned after this long. */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const UPLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_URL_TTL_SECONDS = 60;
/** A single lead can't accumulate unbounded files. */
export const MAX_ATTACHMENTS_PER_LEAD = 200;

export function maxFileSizeBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MAX_LEAD_ATTACHMENT_SIZE_MB);
  const mb = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), HARD_MAX_SIZE_MB) : DEFAULT_MAX_SIZE_MB;
  return mb * 1024 * 1024;
}

// ── names ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Control characters, zero-width / bidirectional-override characters (they reorder text to disguise an extension) and path separators.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\\/]/g;

/**
 * The name shown to people. Treated as hostile input: any directory part is dropped, control / bidi / separator characters are removed,
 * whitespace collapsed, length capped (the extension is kept). It is only ever rendered as text (React escapes it) and never used to
 * build a storage key or a path.
 */
export function sanitizeFileName(raw: string): string {
  let name = String(raw ?? "").normalize("NFC");
  name = name.replace(/\\/g, "/").split("/").pop() ?? "";
  name = name.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!name) return "document";
  if (name.length > MAX_FILE_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    name = name.slice(0, Math.max(1, MAX_FILE_NAME_LENGTH - ext.length)) + ext;
  }
  return name;
}

export function sanitizeDescription(raw: string | null | undefined): string | null {
  const text = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return text ? text.slice(0, MAX_DESCRIPTION_LENGTH) : null;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function allowedTypeForName(name: string): AllowedType | null {
  return BY_EXT.get(extensionOf(name)) ?? null;
}

export function allowedTypeForMime(mime: string | null | undefined): AllowedType | null {
  return ALLOWED_TYPES.find((t) => t.mime === mime) ?? null;
}

export type FileValidation =
  | { ok: true; fileName: string; type: AllowedType }
  | { ok: false; error: string };

export const ERR_UNSUPPORTED = "This file type is not supported. Upload a PDF, image, Word, Excel, PowerPoint, TXT or CSV file.";

/** The single server-side admission check for a name + declared type + size. */
export function validateFile(input: { fileName: string; contentType: string | null | undefined; size: number }, maxBytes = maxFileSizeBytes()): FileValidation {
  const fileName = sanitizeFileName(input.fileName);
  const type = allowedTypeForName(fileName);
  if (!type) return { ok: false, error: ERR_UNSUPPORTED };
  // "invoice.exe.pdf": a dangerous earlier segment is refused even though the last one is allowed.
  const segments = fileName.toLowerCase().split(".").slice(1, -1);
  if (segments.some((s) => DANGEROUS_SEGMENTS.has(s.trim()))) return { ok: false, error: ERR_UNSUPPORTED };
  const declared = String(input.contentType ?? "").split(";")[0].trim().toLowerCase();
  // Browsers sometimes leave the type empty; when they do state one it has to be consistent with the extension.
  if (declared && declared !== "application/octet-stream" && declared !== type.mime && !type.alsoAccepted.includes(declared)) {
    return { ok: false, error: ERR_UNSUPPORTED };
  }
  if (!Number.isInteger(input.size) || input.size <= 0) return { ok: false, error: "This file is empty." };
  if (input.size > maxBytes) return { ok: false, error: `This file is too large. The maximum size is ${Math.floor(maxBytes / (1024 * 1024))} MB.` };
  return { ok: true, fileName, type };
}

// ── object keys ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * An opaque, server-generated object key: companies/{companyId}/leads/{leadId}/attachments/{attachmentId}/{random}. Nothing from the
 * file name or the browser is in it, so it can't traverse, collide or be guessed; ids are validated so a malformed id can't inject a
 * path segment either.
 */
export function buildStorageKey(parts: { companyId: string; leadId: string; attachmentId: string; random: string }): string {
  for (const [label, value] of Object.entries(parts)) {
    if (!SAFE_ID.test(value)) throw new Error(`Unsafe object key part: ${label}`);
  }
  return `companies/${parts.companyId}/leads/${parts.leadId}/attachments/${parts.attachmentId}/${parts.random}`;
}

// ── response headers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name; CR/LF/quotes can never appear in it. */
export function contentDisposition(kind: "inline" | "attachment", fileName: string): string {
  const clean = sanitizeFileName(fileName);
  const ascii = clean.replace(/[^\x20-\x7E]/g, "_").replace(/["\\;]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
