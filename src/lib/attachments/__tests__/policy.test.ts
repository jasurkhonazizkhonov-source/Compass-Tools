import { describe, it, expect } from "vitest";
import {
  ALLOWED_EXTENSIONS,
  ACCEPT_ATTRIBUTE,
  buildStorageKey,
  contentDisposition,
  extensionOf,
  formatFileSize,
  maxFileSizeBytes,
  sanitizeDescription,
  sanitizeFileName,
  validateFile,
  allowedTypeForMime,
} from "../policy";

const MB = 1024 * 1024;
const ok = (fileName: string, contentType = "", size = 1000) => validateFile({ fileName, contentType, size }, 10 * MB);

describe("allowlist", () => {
  it.each([
    ["scan.pdf", "application/pdf"],
    ["photo.JPG", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["id.png", "image/png"],
    ["pic.webp", "image/webp"],
    ["letter.doc", "application/msword"],
    ["letter.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xls", "application/vnd.ms-excel"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["deck.ppt", "application/vnd.ms-powerpoint"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["notes.txt", "text/plain"],
    ["names.csv", "text/csv"],
  ])("accepts %s", (name, mime) => {
    const r = ok(name, mime);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.type.mime).toBe(mime);
  });

  it.each(["movie.mp4", "movie.mov", "song.mp3", "voice.wav", "run.exe", "setup.msi", "go.bat", "x.sh", "app.js", "page.html", "page.htm", "logo.svg", "pack.zip", "pack.rar", "pack.7z", "macro.docm", "macro.xlsm", "x.php", "noextension", "trailingdot.", ".pdf"])(
    "rejects %s",
    (name) => {
      expect(ok(name).ok).toBe(false);
    },
  );

  it.each(["invoice.exe.pdf", "photo.svg.png", "report.html.pdf", "a.zip.docx", "x.js.txt"])("rejects the double extension %s", (name) => {
    expect(ok(name).ok).toBe(false);
  });

  it("accepts a harmless double extension", () => {
    expect(ok("passport.v2.pdf").ok).toBe(true);
    expect(ok("john.smith.copy.jpg").ok).toBe(true);
  });

  it("does not trust the browser's type: a mismatched declared type is refused, an empty / octet-stream one is allowed", () => {
    expect(ok("a.pdf", "text/html").ok).toBe(false);
    expect(ok("a.pdf", "video/mp4").ok).toBe(false);
    expect(ok("a.png", "image/jpeg").ok).toBe(false);
    expect(ok("a.pdf", "").ok).toBe(true);
    expect(ok("a.pdf", "application/octet-stream").ok).toBe(true);
    expect(ok("a.csv", "application/vnd.ms-excel").ok).toBe(true); // what Windows reports for .csv
  });

  it("stores the CANONICAL type for the extension, whatever the browser said", () => {
    const r = ok("a.csv", "application/vnd.ms-excel");
    expect(r.ok && r.type.mime).toBe("text/csv");
  });

  it("only PDFs and images may be opened inline", () => {
    const inline = ["pdf", "jpg", "jpeg", "png", "webp"];
    for (const ext of ALLOWED_EXTENSIONS) {
      const t = ok(`a.${ext}`);
      expect(t.ok && t.type.inline, ext).toBe(inline.includes(ext));
    }
    expect(allowedTypeForMime("image/svg+xml")).toBeNull();
    expect(allowedTypeForMime("text/html")).toBeNull();
  });

  it("the file picker lists exactly the allowlist", () => {
    expect(ACCEPT_ATTRIBUTE.split(",").sort()).toEqual(ALLOWED_EXTENSIONS.map((e) => `.${e}`).sort());
    for (const bad of ["svg", "html", "zip", "exe", "mp4", "mp3", "js"]) expect(ACCEPT_ATTRIBUTE).not.toContain(`.${bad}`);
  });
});

describe("size", () => {
  it("rejects empty and oversized files, with the limit in the message", () => {
    expect(ok("a.pdf", "", 0).ok).toBe(false);
    expect(ok("a.pdf", "", -5).ok).toBe(false);
    expect(ok("a.pdf", "", 1.5).ok).toBe(false);
    const big = ok("a.pdf", "", 10 * MB + 1);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toContain("10 MB");
    expect(ok("a.pdf", "", 10 * MB).ok).toBe(true);
  });

  it("the limit is configurable, clamped to 1..25 MB, and defaults to 10", () => {
    expect(maxFileSizeBytes({})).toBe(10 * MB);
    expect(maxFileSizeBytes({ MAX_LEAD_ATTACHMENT_SIZE_MB: "5" })).toBe(5 * MB);
    expect(maxFileSizeBytes({ MAX_LEAD_ATTACHMENT_SIZE_MB: "9999" })).toBe(25 * MB);
    expect(maxFileSizeBytes({ MAX_LEAD_ATTACHMENT_SIZE_MB: "0" })).toBe(10 * MB);
    expect(maxFileSizeBytes({ MAX_LEAD_ATTACHMENT_SIZE_MB: "abc" })).toBe(10 * MB);
    expect(formatFileSize(2.4 * MB)).toBe("2.4 MB");
  });
});

describe("file names are untrusted", () => {
  it("drops any directory part (path traversal) and separators", () => {
    expect(sanitizeFileName("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFileName("..\\..\\windows\\system32\\a.pdf")).toBe("a.pdf");
    expect(sanitizeFileName("/abs/path/x.png")).toBe("x.png");
  });

  it("removes control, CRLF, zero-width and bidi-override characters", () => {
    expect(sanitizeFileName("a\r\nSet-Cookie: x.pdf")).not.toMatch(/[\r\n]/);
    expect(sanitizeFileName("a\u0000b.pdf")).toBe("ab.pdf");
    // right-to-left override used to disguise "exe.pdf" as "fdp.exe"
    expect(sanitizeFileName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFileName("a​b.pdf")).toBe("ab.pdf");
  });

  it("caps the length but keeps the extension; never returns empty", () => {
    const long = `${"x".repeat(500)}.pdf`;
    const out = sanitizeFileName(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(sanitizeFileName("")).toBe("document");
    expect(sanitizeFileName("   ...   ")).toBe("document");
  });

  it("keeps HTML as inert text (it is only ever rendered escaped)", () => {
    expect(sanitizeFileName("<img src=x onerror=alert(1)>.png")).toContain("<img");
    expect(extensionOf("<img src=x onerror=alert(1)>.png")).toBe("png");
  });

  it("validation uses the sanitised name's extension, so a bidi trick can't smuggle .exe", () => {
    expect(ok("invoice‮fdp.exe").ok).toBe(false);
  });

  it("descriptions: control characters removed, trimmed, capped at 500, empty becomes null", () => {
    expect(sanitizeDescription("  Passport copy \u0000‮  ")).toBe("Passport copy");
    expect(sanitizeDescription("x".repeat(900))?.length).toBe(500);
    expect(sanitizeDescription("   ")).toBeNull();
    expect(sanitizeDescription(null)).toBeNull();
    expect(sanitizeDescription("line1\r\nline2")).toBe("line1\nline2");
  });
});

describe("storage keys and headers", () => {
  const parts = { companyId: "default-company", leadId: "cmuabc123def", attachmentId: "0b9c1d52-aaaa-bbbb-cccc-1234567890ab", random: "a".repeat(32) };

  it("builds an opaque key that contains nothing from the file name", () => {
    const key = buildStorageKey(parts);
    expect(key).toBe(`companies/default-company/leads/cmuabc123def/attachments/${parts.attachmentId}/${"a".repeat(32)}`);
    expect(key).not.toMatch(/\.\./);
  });

  it("refuses an id that could inject a path segment", () => {
    for (const bad of ["../x", "a/b", "a b", "", "x".repeat(65), "a\nb", "a%2fb"]) {
      expect(() => buildStorageKey({ ...parts, leadId: bad })).toThrow();
      expect(() => buildStorageKey({ ...parts, companyId: bad })).toThrow();
      expect(() => buildStorageKey({ ...parts, attachmentId: bad })).toThrow();
    }
  });

  it("Content-Disposition can't be header-injected and carries a UTF-8 name", () => {
    const h = contentDisposition("attachment", 'evil"\r\nX-Injected: 1.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('attachment; filename="')).toBe(true);
    const u = contentDisposition("inline", "Pasaporte María.pdf");
    expect(u).toContain("filename*=UTF-8''Pasaporte%20Mar%C3%ADa.pdf");
    expect(u).toContain('filename="Pasaporte Mar_a.pdf"');
  });
});
