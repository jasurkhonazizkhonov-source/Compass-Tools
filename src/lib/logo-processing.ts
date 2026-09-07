// Company logo processing pipeline — real, deterministic image processing
// (via `sharp`, a standard local image library) rather than an invented AI
// service dependency, since no AI/cloud image API is configured anywhere
// in this project. Produces three destination-appropriate variants from
// one upload, and a conservative, safe-by-default background-transparency
// heuristic: it only ever acts when very confident a upload has a genuine
// flat backdrop, and otherwise leaves the logo completely untouched rather
// than risk damaging real brand artwork.
import sharp from "sharp";

export const MAX_LOGO_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MIN_DIMENSION = 32;
const MAX_DIMENSION = 6000; // guards against decompression-bomb-style uploads
const ALLOWED_FORMATS = new Set(["jpeg", "jpg", "png", "webp", "gif"]);

export type LogoValidationResult = { ok: true; format: string; width: number; height: number } | { ok: false; error: string };

/** Validates file type, size, dimensions, and image integrity — called
 * before any processing is attempted. Never throws; every failure mode
 * becomes a clear, specific `error` string for the admin UI. */
export async function validateLogoUpload(buffer: Buffer): Promise<LogoValidationResult> {
  if (buffer.length === 0) {
    return { ok: false, error: "The uploaded file is empty." };
  }
  if (buffer.length > MAX_LOGO_FILE_BYTES) {
    return { ok: false, error: `The logo file is too large (max ${MAX_LOGO_FILE_BYTES / 1024 / 1024}MB).` };
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    return { ok: false, error: "This file doesn't appear to be a valid, readable image." };
  }

  if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
    return { ok: false, error: "Unsupported image format — please upload a PNG, JPEG, WEBP, or GIF." };
  }
  if (!metadata.width || !metadata.height) {
    return { ok: false, error: "Could not determine the image's dimensions." };
  }
  if (metadata.width < MIN_DIMENSION || metadata.height < MIN_DIMENSION) {
    return { ok: false, error: `The image is too small (minimum ${MIN_DIMENSION}×${MIN_DIMENSION}px).` };
  }
  if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
    return { ok: false, error: `The image is too large (maximum ${MAX_DIMENSION}×${MAX_DIMENSION}px).` };
  }

  return { ok: true, format: metadata.format, width: metadata.width, height: metadata.height };
}

export type ProcessedLogo = {
  original: Buffer;
  email: Buffer;
  web: Buffer;
  icon: Buffer;
  transparencyApplied: boolean;
};

/**
 * Produces three optimized PNG variants sized for their destination:
 *  - email: small, fixed-height (renders reliably across email clients)
 *  - web: higher-resolution, for the booking page / customer-facing header
 *  - icon: small square, for compact UI usage
 * Never upscales beyond the original's own resolution (`withoutEnlargement`)
 * — a low-res source stays low-res rather than being blown up and blurred.
 */
export async function processLogo(buffer: Buffer): Promise<ProcessedLogo> {
  const withAlpha = await maybeRemoveFlatBackground(buffer);

  const [email, web, icon] = await Promise.all([
    sharp(withAlpha.buffer)
      .resize({ height: 80, withoutEnlargement: true })
      .png({ quality: 90 })
      .toBuffer(),
    sharp(withAlpha.buffer)
      .resize({ width: 480, withoutEnlargement: true })
      .png({ quality: 92 })
      .toBuffer(),
    sharp(withAlpha.buffer)
      .resize({ width: 128, height: 128, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, withoutEnlargement: true })
      .png({ quality: 90 })
      .toBuffer(),
  ]);

  return { original: buffer, email, web, icon, transparencyApplied: withAlpha.transparencyApplied };
}

const COLOR_DISTANCE_THRESHOLD = 18; // conservative — small enough to avoid catching real logo colors
const CORNER_SAMPLE = 4; // px block sampled at each corner

/**
 * Conservative background-transparency heuristic. Only acts when:
 *  1. The image has no meaningful existing transparency (a PNG that's
 *     already transparent is left alone — nothing to do).
 *  2. All four corners sample to a near-identical color (strong signal of
 *     a genuine flat backdrop, not a busy/branded corner design).
 *  3. A real, contiguous flood-fill from every border pixel actually
 *     reaches a large enough portion of the image (a proper BFS, not just
 *     "any pixel matching the color" — this is what prevents punching a
 *     hole through an enclosed shape, e.g. the inside of a letter "O"
 *     that happens to share the background color).
 * Any failure of these conditions leaves the image completely untouched.
 */
async function maybeRemoveFlatBackground(buffer: Buffer): Promise<{ buffer: Buffer; transparencyApplied: boolean }> {
  try {
    const image = sharp(buffer).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (channels !== 4 || width < MIN_DIMENSION || height < MIN_DIMENSION) {
      return { buffer, transparencyApplied: false };
    }

    if (hasMeaningfulExistingTransparency(data, width, height)) {
      return { buffer, transparencyApplied: false };
    }

    const bg = sampleCornerColor(data, width, height);
    if (!bg) {
      return { buffer, transparencyApplied: false };
    }

    const mask = floodFillBackgroundMask(data, width, height, bg);
    const backgroundPixelCount = mask.reduce((sum, v) => sum + (v ? 1 : 0), 0);
    const totalPixels = width * height;
    // Require a substantial contiguous backdrop (not just a thin border) —
    // otherwise this isn't confidently "a flat background", so bail out.
    if (backgroundPixelCount < totalPixels * 0.15) {
      return { buffer, transparencyApplied: false };
    }

    const out = Buffer.from(data);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) out[i * channels + 3] = 0;
    }

    const processed = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return { buffer: processed, transparencyApplied: true };
  } catch {
    // Any unexpected failure in the heuristic — fail safe to the
    // untouched original rather than risk a damaged logo.
    return { buffer, transparencyApplied: false };
  }
}

function hasMeaningfulExistingTransparency(data: Buffer, width: number, height: number): boolean {
  const totalPixels = width * height;
  let transparentCount = 0;
  const step = Math.max(1, Math.floor(totalPixels / 5000)); // sample, don't scan every pixel
  for (let p = 0; p < totalPixels; p += step) {
    if (data[p * 4 + 3] < 250) transparentCount++;
  }
  const sampledCount = Math.ceil(totalPixels / step);
  return transparentCount / sampledCount > 0.05;
}

function pixelAt(data: Buffer, width: number, x: number, y: number): [number, number, number] {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Averages a small block at each of the four corners; returns the
 * background color only if all four corners agree closely — otherwise
 * null (no confident single background color). */
function sampleCornerColor(data: Buffer, width: number, height: number): [number, number, number] | null {
  const corners: [number, number][] = [
    [0, 0],
    [width - CORNER_SAMPLE, 0],
    [0, height - CORNER_SAMPLE],
    [width - CORNER_SAMPLE, height - CORNER_SAMPLE],
  ];
  const samples = corners.map(([cx, cy]) => averageBlock(data, width, height, cx, cy));
  const [first, ...rest] = samples;
  if (rest.some((s) => colorDistance(first, s) > COLOR_DISTANCE_THRESHOLD)) return null;
  return first;
}

function averageBlock(data: Buffer, width: number, height: number, startX: number, startY: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.max(0, startY); y < Math.min(height, startY + CORNER_SAMPLE); y++) {
    for (let x = Math.max(0, startX); x < Math.min(width, startX + CORNER_SAMPLE); x++) {
      const [pr, pg, pb] = pixelAt(data, width, x, y);
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** BFS flood-fill from every border pixel, following only pixels close in
 * color to `bg` — returns a boolean mask of exactly the background region
 * reachable from the outside edge, never isolated interior regions. */
function floodFillBackgroundMask(data: Buffer, width: number, height: number, bg: [number, number, number]): Uint8Array {
  const mask = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  function maybeEnqueue(x: number, y: number) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = y * width + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    if (colorDistance(pixelAt(data, width, x, y), bg) <= COLOR_DISTANCE_THRESHOLD) {
      mask[idx] = 1;
      queue.push(idx);
    }
  }

  for (let x = 0; x < width; x++) {
    maybeEnqueue(x, 0);
    maybeEnqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    maybeEnqueue(0, y);
    maybeEnqueue(width - 1, y);
  }

  while (queue.length > 0) {
    const idx = queue.pop()!;
    const x = idx % width;
    const y = Math.floor(idx / width);
    maybeEnqueue(x + 1, y);
    maybeEnqueue(x - 1, y);
    maybeEnqueue(x, y + 1);
    maybeEnqueue(x, y - 1);
  }

  return mask;
}
