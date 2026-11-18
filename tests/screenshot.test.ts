/** screenshot.ts (pure half) + src/screenshotfile.ts (the host write). The GPU capture is e2e. */
import assert from "node:assert";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

import { autoShotName, finishPixels, parseScreenshotArgs, SHOT_DEFAULTS, shotSize } from "../webview/screenshot.ts";
import { pngWithDpi, resolveShotPath, saveScreenshot } from "../src/screenshotfile.ts";

const opts = (a: string) => {
  const r = parseScreenshotArgs(a);
  assert.ok(r.ok, (r as { message?: string }).message ?? "");
  return (r as { opts: typeof SHOT_DEFAULTS }).opts;
};
const err = (a: string) => {
  const r = parseScreenshotArgs(a);
  assert.ok(!r.ok, a);
  return (r as { message: string }).message;
};

test("defaults: transparent png at 3× the view, 300 dpi", () => {
  assert.deepEqual(opts(""), { format: "png", background: "transparent", scale: 3, dpi: 300 });
});

test("options and file names", () => {
  assert.deepEqual(opts("fig1.png ?scale=4 ?bg=white"), { ...SHOT_DEFAULTS, path: "fig1.png", scale: 4, background: "white" });
  assert.equal(opts("a.jpg ?bg=white").format, "jpg", "extension decides the format");
  assert.equal(opts("a.webp").format, "webp");
  assert.equal(opts("?bg=none").background, "transparent");
  assert.equal(opts("?width=2000").width, 2000);
  assert.match(err("a.jpg"), /jpg has no transparency/);
  assert.match(err("?format=svg"), /svg is not offered/);
  assert.match(err("fig.svg"), /svg is not offered/);
  assert.match(err("a.png ?format=jpg ?bg=white"), /file name says \.png/);
  assert.match(err("?scale=0"), /scale/);
  assert.match(err("?width=12.5"), /width/);
  assert.match(err("?zoom=2"), /unknown option/);
  assert.match(err("a.png b.png"), /two file names/);
});

test("shotSize: scale, one side keeps aspect, both sides set it, GPU clamp", () => {
  assert.deepEqual(shotSize(800, 600, { scale: 3 }, 16384), { w: 2400, h: 1800, clamped: false });
  assert.deepEqual(shotSize(800, 600, { scale: 3, width: 4000 }, 16384), { w: 4000, h: 3000, clamped: false });
  assert.deepEqual(shotSize(800, 600, { scale: 3, width: 1000, height: 1000 }, 16384), { w: 1000, h: 1000, clamped: false });
  assert.deepEqual(shotSize(800, 600, { scale: 30 }, 8192), { w: 8192, h: 6144, clamped: true });
});

test("finishPixels: flips rows; transparent un-premultiplies; a background composites", () => {
  // 1×2 image, bottom-up: row0 (bottom) = half-transparent premultiplied red, row1 (top) = opaque blue
  const src = new Uint8Array([128, 0, 0, 128, 0, 0, 255, 255]);
  const t = finishPixels(src, 1, 2, null);
  assert.deepEqual([...t.slice(0, 4)], [0, 0, 255, 255], "top row first");
  assert.deepEqual([...t.slice(4, 8)], [255, 0, 0, 128], "straight alpha: full red at half opacity");
  const w = finishPixels(src, 1, 2, [255, 255, 255]);
  assert.deepEqual([...w.slice(4, 8)], [255, 127, 127, 255], "red over white at 50%");
  assert.deepEqual([...finishPixels(new Uint8Array([0, 0, 0, 0]), 1, 1, null)], [0, 0, 0, 0]);
});

test("autoShotName: safe system name, frame, timestamp", () => {
  assert.equal(autoShotName("03 adk/psf", 12, new Date(2026, 10, 18, 9, 5, 7), "png"), "03_adk_psf_frame12_20261118-090507.png");
});

test("resolveShotPath: base dir, ~, absolute, directories, added extension, never overwrite", () => {
  const base = mkdtempSync(join(tmpdir(), "shot-"));
  const home = mkdtempSync(join(tmpdir(), "home-"));
  assert.equal(resolveShotPath(undefined, "auto.png", "png", base, home), join(base, "auto.png"));
  assert.equal(resolveShotPath("fig", "auto.png", "png", base, home), join(base, "fig.png"));
  assert.equal(resolveShotPath("~/x.png", "auto.png", "png", base, home), join(home, "x.png"));
  assert.equal(resolveShotPath("/tmp/abs.png", "auto.png", "png", base, home), "/tmp/abs.png".replace("/tmp", "/tmp"));
  assert.equal(resolveShotPath("figs/", "auto.png", "png", base, home), join(base, "figs", "auto.png"));
  mkdirSync(join(base, "dir"));
  assert.equal(resolveShotPath("dir", "auto.png", "png", base, home), join(base, "dir", "auto.png"));
  writeFileSync(join(base, "fig.png"), "x");
  writeFileSync(join(base, "fig_1.png"), "x");
  assert.equal(resolveShotPath("fig.png", "auto.png", "png", base, home), join(base, "fig_2.png"));
});

test("pngWithDpi: inserts a valid pHYs after IHDR; saveScreenshot writes it", () => {
  // a real 1×1 PNG
  const raw = Buffer.from([0, 255, 0, 0, 255]);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  const out = pngWithDpi(png, 300);
  assert.equal(out.toString("latin1", 33 + 4, 33 + 8), "pHYs");
  assert.equal(out.readUInt32BE(33 + 8), Math.round(300 / 0.0254));
  assert.equal(out.readUInt32BE(33 + 17), zlib.crc32(out.subarray(33 + 4, 33 + 17)), "CRC is valid");
  assert.equal(pngWithDpi(pngWithDpi(png, 300), 600).length, out.length, "re-stamping replaces, never stacks");
  assert.equal(pngWithDpi(Buffer.from("not a png"), 300).toString(), "not a png");
  const base = mkdtempSync(join(tmpdir(), "shot-"));
  const r = saveScreenshot({ autoName: "a.png", ext: "png", baseDir: join(base, "new"), home: base, data: png, dpi: 300 });
  assert.equal(r.file, join(base, "new", "a.png"));
  assert.deepEqual(readFileSync(r.file), out);
});
