/**
 * The host half of `screenshot`: decide where the image goes and write it.
 * Shared by the extension host and the e2e bridge so both write identically.
 *
 *   - no name        → <baseDir>/<auto name>
 *   - relative name  → under <baseDir>; `~/…` → home; absolute → as given
 *   - a directory    → <dir>/<auto name>
 *   - no extension   → the format's extension is added
 *   - NEVER overwrites: an existing name gets _1, _2, … before the extension
 *   - PNG: a pHYs chunk records the print resolution (?dpi), so 3000 px at
 *     300 dpi opens as 10 inches wide in Illustrator / Word / Inkscape.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join } from "node:path";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert (or replace) a pHYs chunk right after IHDR. A non-PNG buffer, or
 * dpi ≤ 0, is returned unchanged. */
export function pngWithDpi(png: Buffer, dpi: number): Buffer {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (dpi <= 0 || png.length < 33 || !png.subarray(0, 8).equals(SIG)) return png;
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4; // sig + (len,type) + data + crc
  // drop any existing pHYs (browsers usually write none; be safe)
  const parts: Buffer[] = [png.subarray(0, ihdrEnd)];
  let at = ihdrEnd;
  const rest: Buffer[] = [];
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const end = at + 12 + len;
    if (type !== "pHYs") rest.push(png.subarray(at, end));
    at = end;
  }
  const ppm = Math.round(dpi / 0.0254);
  const body = Buffer.alloc(13);
  body.write("pHYs", 0, "latin1");
  body.writeUInt32BE(ppm, 4);
  body.writeUInt32BE(ppm, 8);
  body.writeUInt8(1, 12); // unit: metre
  const chunk = Buffer.alloc(4 + 13 + 4);
  chunk.writeUInt32BE(9, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 17);
  return Buffer.concat([...parts, chunk, ...rest]);
}

export function resolveShotPath(
  requested: string | undefined, autoName: string, ext: string, baseDir: string, home: string,
): string {
  let p: string;
  if (requested === undefined || requested === "") p = join(baseDir, autoName);
  else {
    p = requested === "~" ? home : requested.startsWith("~/") ? join(home, requested.slice(2)) : requested;
    if (!isAbsolute(p)) p = join(baseDir, p);
    const isDir = /[\\/]$/.test(requested) || (existsSync(p) && statSync(p).isDirectory());
    if (isDir) p = join(p, autoName);
    else if (extname(p) === "") p = `${p}.${ext}`;
  }
  if (!existsSync(p)) return p;
  const e = extname(p);
  const stem = p.slice(0, p.length - e.length);
  for (let i = 1; ; i++) {
    const q = `${stem}_${i}${e}`;
    if (!existsSync(q)) return q;
  }
}

export function saveScreenshot(o: {
  requested?: string; autoName: string; ext: string; baseDir: string; home: string;
  data: Buffer; dpi: number;
}): { file: string; bytes: number } {
  const file = resolveShotPath(o.requested, o.autoName, o.ext, o.baseDir, o.home);
  const bytes = o.ext === "png" ? pngWithDpi(o.data, o.dpi) : o.data;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length };
}
