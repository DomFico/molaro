/**
 * SCREENSHOT — the pure half of the `screenshot` verb: argument parsing, the
 * output size, and turning GPU pixels into straight-alpha, top-down RGBA.
 *
 * The capture itself lives in main.ts (it needs the renderer): the current
 * view (ghosts included) is drawn into an offscreen multisampled target at the
 * requested resolution, read back, and handed to the extension host, which
 * writes the file (src/screenshotfile.ts). The visible canvas is never resized.
 *
 * Pure module: no THREE, no DOM.
 */

import type { CommandResult } from "./commands.ts";

export type ShotFormat = "png" | "jpg" | "webp";

export interface ShotOptions {
  /** File name or path as typed (host resolves it); absent = auto-named. */
  path?: string;
  format: ShotFormat;
  /** "transparent" | "current" (the viewer's background) | a CSS-ish colour. */
  background: string;
  /** Multiplier on the view's on-screen pixel size (ignored when width/height given). */
  scale: number;
  width?: number;
  height?: number;
  /** Written into a PNG's pHYs chunk (print size); 0 = none. */
  dpi: number;
}

export const SHOT_DEFAULTS: ShotOptions = { format: "png", background: "transparent", scale: 3, dpi: 300 };

export const SHOT_USAGE =
  "screenshot [file] ?bg=transparent|current|white|<color> ?scale=3 ?width=<px> ?height=<px> " +
  "?format=png|jpg|webp ?dpi=300 — e.g. screenshot, screenshot fig1.png ?scale=4, screenshot ?bg=white ?format=jpg";

const FORMATS: Record<string, ShotFormat> = { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" };

export function parseScreenshotArgs(args: string): { ok: true; opts: ShotOptions } | { ok: false; message: string } {
  const opts: ShotOptions = { ...SHOT_DEFAULTS };
  const tokens = args.trim().split(/\s+/).filter((t) => t !== "");
  const bad = (m: string) => ({ ok: false as const, message: `screenshot: ${m} — ${SHOT_USAGE}` });
  for (const t of tokens) {
    if (!t.startsWith("?")) {
      if (opts.path !== undefined) return bad(`two file names given ("${opts.path}", "${t}")`);
      opts.path = t;
      continue;
    }
    const m = /^\?([a-z]+)=(.+)$/i.exec(t);
    if (!m) return bad(`"${t}" is not ?key=value`);
    const key = m[1].toLowerCase();
    const val = m[2];
    const num = Number(val);
    switch (key) {
      case "bg":
      case "background":
        opts.background = val.toLowerCase() === "none" ? "transparent" : val;
        break;
      case "format": {
        const f = FORMATS[val.toLowerCase()];
        if (!f) {
          return bad(val.toLowerCase() === "svg"
            ? "svg is not offered: the picture is rendered on the GPU as pixels, so an svg would only wrap a png. Use png (transparent) at a high ?scale"
            : `unknown format "${val}" (png, jpg or webp)`);
        }
        opts.format = f;
        break;
      }
      case "scale":
        if (!Number.isFinite(num) || num <= 0 || num > 16) return bad(`?scale must be a number in (0, 16], got "${val}"`);
        opts.scale = num;
        break;
      case "width":
      case "height":
        if (!Number.isInteger(num) || num < 16) return bad(`?${key} must be a whole number of pixels ≥ 16, got "${val}"`);
        opts[key] = num;
        break;
      case "dpi":
        if (!Number.isFinite(num) || num < 0 || num > 10000) return bad(`?dpi must be between 0 and 10000, got "${val}"`);
        opts.dpi = Math.round(num);
        break;
      default:
        return bad(`unknown option ?${key}`);
    }
  }
  // the file extension, when typed, decides the format unless ?format said otherwise
  if (opts.path !== undefined) {
    const ext = /\.([a-z0-9]+)$/i.exec(opts.path)?.[1]?.toLowerCase();
    if (ext !== undefined) {
      if (ext === "svg") return parseScreenshotArgs(args.replace(opts.path, "") + " ?format=svg");
      const f = FORMATS[ext];
      if (!f) return bad(`unknown file type ".${ext}" (png, jpg or webp)`);
      if (!/\?format=/i.test(args)) opts.format = f;
      else if (f !== opts.format) return bad(`the file name says .${ext} but ?format=${opts.format}`);
    }
  }
  if (opts.background === "transparent" && opts.format === "jpg") {
    return bad("jpg has no transparency — use png or webp, or give a background (?bg=white)");
  }
  return { ok: true, opts };
}

/**
 * Output pixel size. width/height win; one alone keeps the view's aspect, both
 * together change it (the camera widens/narrows to match). Otherwise the
 * view's drawing-buffer size × scale. Clamped so the longer side ≤ maxSide.
 */
export function shotSize(
  viewW: number, viewH: number, o: Pick<ShotOptions, "scale" | "width" | "height">, maxSide: number,
): { w: number; h: number; clamped: boolean } {
  let w: number, h: number;
  if (o.width !== undefined && o.height !== undefined) { w = o.width; h = o.height; }
  else if (o.width !== undefined) { w = o.width; h = Math.round((o.width * viewH) / viewW); }
  else if (o.height !== undefined) { h = o.height; w = Math.round((o.height * viewW) / viewH); }
  else { w = Math.round(viewW * o.scale); h = Math.round(viewH * o.scale); }
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)), clamped: k < 1 };
}

/**
 * GPU readback → image rows. The capture is always drawn over a TRANSPARENT
 * clear, so the readback is PREMULTIPLIED (every translucent layer blended over
 * alpha-0 black) and bottom-up. Then either:
 *   - bg null: divide the colour back out (straight alpha) — otherwise every
 *     soft edge and ghost turns dark in an editor;
 *   - bg [r,g,b] (sRGB 0-255): composite over it — exact, and identical for
 *     every format, with no colour-management detour through the GPU clear.
 */
export function finishPixels(
  src: Uint8Array, w: number, h: number, bg: readonly [number, number, number] | null,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * row;
    out.set(src.subarray(from, from + row), y * row);
  }
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (bg !== null) {
      const k = 1 - a / 255;
      out[i] = out[i] + bg[0] * k;
      out[i + 1] = out[i + 1] + bg[1] * k;
      out[i + 2] = out[i + 2] + bg[2] * k;
      out[i + 3] = 255;
    } else if (a !== 0 && a !== 255) {
      const k = 255 / a;
      out[i] = out[i] * k;
      out[i + 1] = out[i + 1] * k;
      out[i + 2] = out[i + 2] * k;
    }
  }
  return out;
}

/** The auto file name: <system>_frame<k>_<YYYYMMDD-HHMMSS>.<ext>. */
export function autoShotName(system: string, frame: number, now: Date, ext: ShotFormat): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const safe = system.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "molaro";
  return `${safe}_frame${frame}_${stamp}.${ext}`;
}

export function shotResultLine(r: { file?: string; bytes?: number; w?: number; h?: number; error?: string }): CommandResult {
  if (r.error) return { status: "error", message: `screenshot failed: ${r.error}` };
  const mb = r.bytes !== undefined ? ` (${(r.bytes / 1e6).toFixed(1)} MB)` : "";
  return { status: "ok", message: `screenshot → saved ${r.w}×${r.h} to ${r.file}${mb}` };
}
