import type { SignatureKind } from "@/lib/attachments/policy";

// Content verification of the stored object's first bytes against what its extension claims. This catches "evil.exe renamed to
// statement.pdf" and similar mismatches; it is NOT malware scanning (no file content is scanned for viruses).
const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

export function matchesSignature(kind: SignatureKind, bytes: Uint8Array): boolean {
  switch (kind) {
    case "pdf":
      // The PDF header may be preceded by a little junk, but within the first 1024 bytes.
      for (let i = 0; i <= Math.min(bytes.length - 5, 1024); i++) if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
      return false;
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "webp":
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "ole":
      // Legacy .doc / .xls / .ppt (Compound File Binary).
      return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "zip":
      // .docx / .xlsx / .pptx are ZIP containers.
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case "text": {
      if (bytes.length === 0) return false;
      // Plain text has no NUL bytes, and a Windows / ELF executable or an HTML/SVG/script payload is not "text".
      if (bytes.includes(0)) return false;
      if (startsWith(bytes, [0x4d, 0x5a]) || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(bytes, [0x23, 0x21])) return false;
      const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 512)).trimStart().toLowerCase();
      return !(head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<svg") || head.startsWith("<script") || head.startsWith("<?xml"));
    }
  }
}

/** How many leading bytes the verifier needs. */
export const SIGNATURE_PROBE_BYTES = 4096;
