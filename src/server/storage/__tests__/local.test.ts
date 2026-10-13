import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { KEY_PATTERN, hasRoomFor, isValidKey, localStorage, minFreeBytes, newKey, pathForKey, resetStatusCacheForTests, resolveUploadRoot, status, storeUpload } from "../local";

// The local file store, against a REAL temporary directory (no mocks of the filesystem except where a disk error has to be forced).

const PDF = Buffer.from("%PDF-1.7\n%test document\n");
const isPdf = (head: Uint8Array) => Buffer.from(head).subarray(0, 5).toString() === "%PDF-";
const web = (buf: Buffer | Uint8Array, chunk = 7) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < buf.length; i += chunk) c.enqueue(new Uint8Array(buf.subarray(i, i + chunk)));
      c.close();
    },
  });
const store = (key: string, body: Buffer, overrides: Partial<Parameters<typeof storeUpload>[2]> = {}) => storeUpload(key, web(body), { expectedSize: body.length, acceptHead: isPdf, ...overrides });

let root: string;
let consoleError: ReturnType<typeof vi.spyOn>;
const POSIX = process.platform !== "win32";

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "compass-uploads-"));
  vi.stubEnv("UPLOAD_STORAGE_DIR", root);
  vi.stubEnv("UPLOAD_MIN_FREE_MB", "0");
  resetStatusCacheForTests();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

const filesUnder = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
};

describe("where the files go", () => {
  it("production default is /var/lib/compass-tools/uploads; development default is ./.local-uploads", () => {
    expect(resolveUploadRoot({}, "/app", true)).toEqual({ root: path.resolve("/var/lib/compass-tools/uploads") });
    const dev = resolveUploadRoot({}, path.resolve("/work/app"), false);
    expect(dev).toEqual({ root: path.join(path.resolve("/work/app"), ".local-uploads") });
  });

  it("UPLOAD_STORAGE_DIR overrides it (and tolerates the quotes of a pasted .env line)", () => {
    const target = path.join(os.tmpdir(), "elsewhere");
    expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: target }, "/app", true)).toEqual({ root: path.resolve(target) });
    expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: ` "${target}" ` }, "/app", true)).toEqual({ root: path.resolve(target) });
  });

  it("refuses a relative path, a NUL byte, the filesystem root, and - in production - anywhere inside the application directory", () => {
    const abs = path.resolve("/srv/app");
    for (const bad of ["uploads", "./uploads", "../uploads", "", "a\0b"]) {
      if (bad === "") continue; // empty means "use the default"
      expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: bad }, abs, true), bad).toEqual({ problem: "misconfigured" });
    }
    expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: path.parse(abs).root }, abs, true)).toEqual({ problem: "misconfigured" });
    for (const inside of [abs, path.join(abs, "uploads"), path.join(abs, ".next", "x"), path.join(abs, "public")]) {
      expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: inside }, abs, true), inside).toEqual({ problem: "misconfigured" });
    }
    // outside the app directory is fine, and so is inside it when NOT production (the dev default lives there)
    expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: path.resolve("/srv/uploads") }, abs, true)).toEqual({ root: path.resolve("/srv/uploads") });
    expect(resolveUploadRoot({ UPLOAD_STORAGE_DIR: path.join(abs, "uploads") }, abs, false)).toEqual({ root: path.join(abs, "uploads") });
  });
});

describe("keys are opaque and can never become a path outside the root", () => {
  it("generates 256 random bits laid out as <2 hex>/<64 hex>, unique every time", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k).toMatch(KEY_PATTERN);
      expect(k.slice(0, 2)).toBe(k.slice(3, 5));
      expect(isValidKey(k)).toBe(true);
    }
  });

  const good = newKey();
  it.each([
    ["traversal", "../etc/passwd"],
    ["traversal inside a key", `ab/../${"a".repeat(64)}`],
    ["dotdot shard", `../${"a".repeat(64)}`],
    ["absolute path", "/etc/passwd"],
    ["windows drive", "C:\\Windows\\win.ini"],
    ["backslash", `ab\\${"a".repeat(64)}`],
    ["url-encoded separator", `ab%2F${"a".repeat(64)}`],
    ["URL-encoded dotdot", "%2e%2e/%2e%2e/x"],
    ["NUL byte", `${good}\0.pdf`],
    ["trailing slash", `${good}/`],
    ["extra segment", `${good}/extra`],
    ["leading slash", `/${good}`],
    ["upper-case hex", good.toUpperCase()],
    ["too short", `ab/${"a".repeat(63)}`],
    ["too long", `ab/${"a".repeat(65)}`],
    ["shard that does not match the id", `ab/${"c".repeat(64)}`],
    ["a file name", "passport.pdf"],
    ["the .tmp area", `.tmp/${"a".repeat(32)}.part`],
    ["an old R2 key", "companies/default-company/leads/lead1234567/attachments/0b9c1d52-aaaa-bbbb-cccc-1234567890ab/0123456789abcdef0123456789abcdef"],
    ["empty", ""],
  ])("refuses %s", (_label, key) => {
    expect(isValidKey(key)).toBe(false);
    expect(() => pathForKey(key, root)).toThrow(/invalid_key/);
  });

  it("refuses non-strings", () => {
    for (const bad of [undefined, null, 5, {}, ["ab/" + "a".repeat(64)]]) expect(isValidKey(bad as unknown)).toBe(false);
  });

  it("a valid key resolves to exactly <root>/<shard>/<id>", () => {
    const key = newKey();
    expect(pathForKey(key, root)).toBe(path.join(root, key.slice(0, 2), key.slice(3)));
  });

  it("every storage operation refuses an invalid key instead of touching the disk", async () => {
    await expect(localStorage.head("../x")).rejects.toThrow(/invalid_key/);
    await expect(localStorage.readHead("../x", 10)).rejects.toThrow(/invalid_key/);
    await expect(localStorage.openRead("../x")).rejects.toThrow(/invalid_key/);
    await expect(localStorage.remove("../x")).rejects.toThrow(/invalid_key/);
    expect(await store("../x", PDF)).toEqual({ ok: false, reason: "FAILED" });
  });
});

describe("writing: bounded, verified, atomic", () => {
  it("stores a file under its key, readable back byte-for-byte, with no temp file left behind", async () => {
    const key = newKey();
    expect(await store(key, PDF)).toEqual({ ok: true, size: PDF.length });
    expect(await filesUnder(root)).toEqual([key]);
    const back = await localStorage.openRead(key);
    expect(back!.size).toBe(PDF.length);
    const chunks: Buffer[] = [];
    for await (const c of back!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(PDF)).toBe(true);
    expect(await localStorage.head(key)).toEqual({ size: PDF.length });
    expect(Buffer.from((await localStorage.readHead(key, 5))!).toString()).toBe("%PDF-");
    expect((await fsp.readdir(path.join(root, ".tmp"))).length).toBe(0);
  });

  it.skipIf(!POSIX)("directories are 0700 and files 0600 - not readable by group or others", async () => {
    const key = newKey();
    await store(key, PDF);
    expect((await fsp.stat(path.join(root, key.slice(0, 2)))).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(pathForKey(key, root))).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.join(root, ".tmp"))).mode & 0o777).toBe(0o700);
  });

  it("accepts a Node stream as well as a web stream", async () => {
    const key = newKey();
    expect(await storeUpload(key, Readable.from([PDF.subarray(0, 4), PDF.subarray(4)]), { expectedSize: PDF.length, acceptHead: isPdf })).toEqual({ ok: true, size: PDF.length });
  });

  it("cuts a body that exceeds the authorised size OFF at the first excess byte and publishes nothing", async () => {
    const key = newKey();
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        produced += 1024;
        c.enqueue(new Uint8Array(1024).fill(0x41));
      },
    });
    const big = Buffer.concat([PDF, Buffer.alloc(10_000)]);
    const result = await storeUpload(key, endless, { expectedSize: 4096, acceptHead: () => true });
    expect(result).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(produced).toBeLessThan(1024 * 1024); // the (unbounded) source was stopped, not drained
    expect(await filesUnder(root)).toEqual([]);
    void big;
  });

  it("rejects a body shorter than authorised (size mismatch) and publishes nothing", async () => {
    const key = newKey();
    expect(await store(key, PDF, { expectedSize: PDF.length + 10 })).toEqual({ ok: false, reason: "SIZE_MISMATCH" });
    expect(await filesUnder(root)).toEqual([]);
    expect(await localStorage.head(key)).toBeNull();
  });

  it("rejects a non-positive or fractional authorised size", async () => {
    for (const expectedSize of [0, -1, 1.5, NaN]) expect(await store(newKey(), PDF, { expectedSize }), String(expectedSize)).toEqual({ ok: false, reason: "SIZE_MISMATCH" });
    expect(await filesUnder(root)).toEqual([]);
  });

  it("rejects content that does not match its format (an executable renamed to .pdf) and publishes nothing", async () => {
    const key = newKey();
    const exe = Buffer.from("MZ\x90\x00\x03\x00\x00\x00 and a lot more bytes");
    expect(await store(key, exe)).toEqual({ ok: false, reason: "SIGNATURE_MISMATCH" });
    expect(await filesUnder(root)).toEqual([]);
  });

  it("an incomplete / cancelled upload (the client goes away mid-body) leaves nothing - not even a temp file", async () => {
    const key = newKey();
    const dropped = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(PDF.subarray(0, 10)));
      },
      pull() {
        throw new Error("connection reset");
      },
    });
    expect(await storeUpload(key, dropped, { expectedSize: PDF.length, acceptHead: isPdf })).toEqual({ ok: false, reason: "FAILED" });
    expect(await filesUnder(root)).toEqual([]);
    expect(await localStorage.head(key)).toBeNull();
  });

  it("an aborted request signal stops the write and cleans up", async () => {
    const ac = new AbortController();
    const slow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(PDF.subarray(0, 8)));
        setTimeout(() => ac.abort(), 20);
      },
      pull: () => new Promise(() => {}), // never produces more
    });
    expect(await storeUpload(newKey(), slow, { expectedSize: PDF.length, acceptHead: isPdf, signal: ac.signal })).toEqual({ ok: false, reason: "FAILED" });
    expect(await filesUnder(root)).toEqual([]);
  });

  it("a second upload to the same key never overwrites the first (exclusive publish)", async () => {
    const key = newKey();
    const other = Buffer.from("%PDF-1.4\nDIFFERENT CONTENT HERE\n");
    expect(await store(key, PDF)).toMatchObject({ ok: true });
    expect(await store(key, other)).toEqual({ ok: false, reason: "EXISTS" });
    const back = await localStorage.openRead(key);
    const chunks: Buffer[] = [];
    for await (const c of back!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(PDF)).toBe(true);
    expect((await fsp.readdir(path.join(root, ".tmp"))).length).toBe(0);
  });

  it("concurrent uploads to ONE key: exactly one wins, the rest see EXISTS, the file is exactly the winner's bytes", async () => {
    const key = newKey();
    const contents = Array.from({ length: 8 }, (_, i) => Buffer.from(`%PDF-1.4\nuploader ${i} ${"x".repeat(2000 + i)}\n`));
    const results = await Promise.all(contents.map((c) => store(key, c)));
    const winners = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "EXISTS")).toBe(true);
    const back = await localStorage.openRead(key);
    const chunks: Buffer[] = [];
    for await (const c of back!.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(contents[winners[0]])).toBe(true);
    expect(await filesUnder(root)).toEqual([key]);
  });

  it("concurrent uploads to DIFFERENT keys all succeed independently", async () => {
    const keys = Array.from({ length: 12 }, () => newKey());
    const results = await Promise.all(keys.map((k) => store(k, PDF)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await filesUnder(root)).sort()).toEqual([...keys].sort());
  });
});

describe("disk errors and missing files", () => {
  it("a full disk while writing is reported as NO_SPACE, and nothing is left behind", async () => {
    const real = fs.createWriteStream.bind(fs);
    vi.spyOn(fs, "createWriteStream").mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      const stream = real(p, opts as Parameters<typeof real>[1]);
      // every write fails the way a full disk does - with an error message that names a path
      const full = () => Object.assign(new Error("ENOSPC: no space left on device, write '" + root + "'"), { code: "ENOSPC" });
      stream._write = (_chunk, _enc, cb) => cb(full());
      stream._writev = (_chunks, cb) => cb(full());
      return stream;
    }) as typeof fs.createWriteStream);
    expect(await store(newKey(), PDF)).toEqual({ ok: false, reason: "NO_SPACE" });
    vi.restoreAllMocks();
    expect(await filesUnder(root)).toEqual([]);
    expect(await fsp.readdir(path.join(root, ".tmp"))).toEqual([]);
  });

  it("an unexpected filesystem error is a generic FAILED; the log carries only the error code, never a path", async () => {
    vi.spyOn(fsp, "mkdir").mockRejectedValue(Object.assign(new Error(`EACCES: permission denied, mkdir '${root}/.tmp'`), { code: "EACCES" }));
    expect(await store(newKey(), PDF)).toEqual({ ok: false, reason: "FAILED" });
    const logged = consoleError.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain(root);
    expect(logged).not.toMatch(/permission denied|mkdir/);
  });

  it("a missing file is null for head / readHead / openRead and an idempotent success for remove", async () => {
    const key = newKey();
    expect(await localStorage.head(key)).toBeNull();
    expect(await localStorage.readHead(key, 100)).toBeNull();
    expect(await localStorage.openRead(key)).toBeNull();
    await expect(localStorage.remove(key)).resolves.toBeUndefined();
    await store(key, PDF);
    await expect(localStorage.remove(key)).resolves.toBeUndefined();
    await expect(localStorage.remove(key)).resolves.toBeUndefined();
    expect(await filesUnder(root)).toEqual([]);
  });

  it("a delete that fails throws a generic error (the caller keeps its record) and leaks no path", async () => {
    const key = newKey();
    await store(key, PDF);
    vi.spyOn(fsp, "unlink").mockRejectedValue(Object.assign(new Error(`EPERM: operation not permitted, unlink '${root}'`), { code: "EPERM" }));
    const err = await localStorage.remove(key).then(() => null, (e: Error) => e);
    expect(err?.message).toBe("Local storage failed");
    expect(err?.message).not.toContain(root);
    expect(consoleError.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n")).not.toContain(root);
  });

  it("an unreadable file is a generic error, not a path", async () => {
    const key = newKey();
    await store(key, PDF);
    vi.spyOn(fsp, "open").mockRejectedValue(Object.assign(new Error(`EIO: i/o error, open '${root}'`), { code: "EIO" }));
    const err = await localStorage.openRead(key).then(() => null, (e: Error) => e);
    expect(err?.message).toBe("Local storage failed");
  });

  it.skipIf(!POSIX)("never serves a symlink planted at a key, nor a directory", async () => {
    const secret = path.join(root, "outside-secret.txt");
    await fsp.writeFile(secret, "top secret");
    const key = newKey();
    await fsp.mkdir(path.join(root, key.slice(0, 2)), { recursive: true });
    await fsp.symlink(secret, pathForKey(key, root));
    expect(await localStorage.openRead(key)).toBeNull();
    expect(await localStorage.head(key)).toBeNull();
    expect(await localStorage.readHead(key, 10)).toBeNull();
    const dirKey = newKey();
    await fsp.mkdir(pathForKey(dirKey, root), { recursive: true });
    expect(await localStorage.openRead(dirKey)).toBeNull();
  });
});

describe("readiness and disk space", () => {
  it("ready for a writable directory; creates the root outside production", async () => {
    const fresh = path.join(root, "not-yet");
    vi.stubEnv("UPLOAD_STORAGE_DIR", fresh);
    resetStatusCacheForTests();
    expect((await status()).state).toBe("ready");
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("in PRODUCTION a missing root is 'unavailable' and is NOT created (a missing bind mount must not silently use the container's own disk)", async () => {
    const missing = path.join(root, "not-mounted");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("UPLOAD_STORAGE_DIR", missing);
    resetStatusCacheForTests();
    expect((await status()).state).toBe("unavailable");
    expect(fs.existsSync(missing)).toBe(false);
    expect(await hasRoomFor(1)).toBe(false);
    expect(await store(newKey(), PDF)).toMatchObject({ ok: false });
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("unavailable when the path is a file, or misconfigured", async () => {
    const file = path.join(root, "a-file");
    await fsp.writeFile(file, "x");
    vi.stubEnv("UPLOAD_STORAGE_DIR", file);
    resetStatusCacheForTests();
    expect((await status()).state).toBe("unavailable");
    vi.stubEnv("UPLOAD_STORAGE_DIR", "relative/path");
    resetStatusCacheForTests();
    expect((await status()).state).toBe("unavailable");
  });

  it("reports low_space (and refuses new uploads) when free space is below the reserve", async () => {
    vi.stubEnv("UPLOAD_MIN_FREE_MB", "999999999"); // far more than any disk has
    resetStatusCacheForTests();
    const s = await status();
    expect(["low_space", "ready"]).toContain(s.state); // statfs may be unavailable on an exotic filesystem
    if (s.state === "low_space") {
      expect(await hasRoomFor(1)).toBe(false);
      expect(typeof s.freeBytes).toBe("number");
    }
  });

  it("room is judged against the reserve: a request larger than the free space minus the reserve is refused", async () => {
    resetStatusCacheForTests();
    const s = await status();
    if (s.state === "ready" && s.freeBytes !== undefined) {
      expect(await hasRoomFor(1024)).toBe(true);
      expect(await hasRoomFor(s.freeBytes + 1)).toBe(false);
    }
  });

  it("UPLOAD_MIN_FREE_MB: a number (0 allowed) or the 1024 MB default", () => {
    expect(minFreeBytes({})).toBe(1024 * 1024 * 1024);
    expect(minFreeBytes({ UPLOAD_MIN_FREE_MB: "0" })).toBe(0);
    expect(minFreeBytes({ UPLOAD_MIN_FREE_MB: "2048" })).toBe(2048 * 1024 * 1024);
    for (const bad of ["abc", "-5", "", " "]) expect(minFreeBytes({ UPLOAD_MIN_FREE_MB: bad }), bad).toBe(1024 * 1024 * 1024);
  });

  it("status never returns a path", async () => {
    expect(JSON.stringify(await status())).not.toContain(root);
  });
});

describe("the temp-file sweeper can only ever remove stale upload temp files", () => {
  const HOUR = 3_600_000;
  const old = (p: string, ageMs: number) => fsp.utimes(p, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));

  it("removes old <32 hex>.part files in .tmp, keeps young ones, and never touches stored attachments or anything else", async () => {
    const stored = newKey();
    await store(stored, PDF);
    await old(pathForKey(stored, root), 10 * HOUR); // an OLD stored attachment must survive
    const tmp = path.join(root, ".tmp");
    const oldPart = path.join(tmp, `${"a".repeat(32)}.part`);
    const youngPart = path.join(tmp, `${"b".repeat(32)}.part`);
    const lookalike = path.join(tmp, "notes.txt");
    const wrongLength = path.join(tmp, `${"c".repeat(31)}.part`);
    const outside = path.join(root, `${"d".repeat(32)}.part`); // right name, wrong directory
    for (const p of [oldPart, youngPart, lookalike, wrongLength, outside]) await fsp.writeFile(p, "x");
    for (const p of [oldPart, lookalike, wrongLength, outside]) await old(p, 10 * HOUR);

    expect(await localStorage.sweepTempFiles(Date.now(), HOUR)).toBe(1);
    expect(fs.existsSync(oldPart)).toBe(false);
    for (const p of [youngPart, lookalike, wrongLength, outside, pathForKey(stored, root)]) expect(fs.existsSync(p), p).toBe(true);
  });

  it.skipIf(!POSIX)("does not follow a symlink named like a temp file", async () => {
    const target = path.join(root, "precious.txt");
    await fsp.writeFile(target, "keep me");
    await old(target, 10 * HOUR);
    await fsp.mkdir(path.join(root, ".tmp"), { recursive: true });
    await fsp.symlink(target, path.join(root, ".tmp", `${"e".repeat(32)}.part`));
    expect(await localStorage.sweepTempFiles(Date.now(), HOUR)).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is a quiet no-op when there is no .tmp directory or the root is misconfigured", async () => {
    expect(await localStorage.sweepTempFiles(Date.now(), HOUR)).toBe(0);
    vi.stubEnv("UPLOAD_STORAGE_DIR", "relative");
    expect(await localStorage.sweepTempFiles(Date.now(), HOUR)).toBe(0);
  });
});
