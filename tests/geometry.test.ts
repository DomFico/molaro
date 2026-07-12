/**
 * Unit tests for the renderer's pure geometry prep, plus a parse of the
 * webview fixture (media/fixtures/) through the contract types — the same
 * path the webview takes, minus the GPU.
 *
 * Run from viewer/:  node --test tests/geometry.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SCENE_BOX,
  NO_BBOX_WARNING,
  computeBounds,
  edgeSegmentIndices,
  polylineSegmentIndices,
  sceneExtent,
  worldPerSizeUnit,
} from "../webview/geometry.ts";
import { decodeFrameChunk, parseHeader, validateFrameChunk } from "../contract/contract.ts";

test("edgeSegmentIndices flattens pairs", () => {
  const out = edgeSegmentIndices([
    [0, 1],
    [4, 2],
  ]);
  assert.deepEqual([...out], [0, 1, 4, 2]);
  assert.ok(out instanceof Uint32Array);
});

test("polylineSegmentIndices expands paths into segment pairs", () => {
  const out = polylineSegmentIndices([[3, 5, 9], [7, 2]]);
  assert.deepEqual([...out], [3, 5, 5, 9, 7, 2]);
  assert.deepEqual([...polylineSegmentIndices([])], []);
});

test("computeBounds finds per-axis min/max", () => {
  const pos = new Float32Array([0, -1, 2, 5, 3, -4, -2, 0, 0]);
  const box = computeBounds(pos);
  assert.deepEqual(box.min, [-2, -1, -4]);
  assert.deepEqual(box.max, [5, 3, 2]);
  assert.deepEqual(computeBounds(new Float32Array(0)), { min: [0, 0, 0], max: [0, 0, 0] });
});

test("webview fixture parses, validates, and is a zero-copy frame-0 view", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "media", "fixtures");
  // media/fixtures is regenerable (gitignored), so a fresh clone won't have it.
  // Regenerate it from the synthetic producer on demand (needs python3 + numpy).
  if (!existsSync(join(dir, "header.json")) || !existsSync(join(dir, "chunk0.bin"))) {
    execFileSync("python3", ["tests/make_webview_fixture.py"], { cwd: root, stdio: "inherit" });
  }
  const header = parseHeader(readFileSync(join(dir, "header.json"), "utf-8"));
  const bytes = readFileSync(join(dir, "chunk0.bin"));
  // Fresh copy at offset 0, matching a fetch().arrayBuffer() result.
  const raw = new Uint8Array(bytes);
  const chunk = decodeFrameChunk(raw);
  validateFrameChunk(chunk, header);

  assert.equal(chunk.start, 0);
  assert.equal(chunk.count, 1);
  assert.equal(chunk.positions.length, header.n_points * 3);
  assert.equal(chunk.positions.buffer, raw.buffer, "positions must view the received buffer");

  // Connectivity prep stays within [0, N).
  for (const idx of edgeSegmentIndices(header.edges)) assert.ok(idx < header.n_points);
  for (const idx of polylineSegmentIndices(header.polylines)) assert.ok(idx < header.n_points);

  // Frame-0 positions sit inside the header's bbox.
  const box = computeBounds(chunk.positions);
  assert.ok(header.bbox, "synthetic header carries a bbox");
  for (let c = 0; c < 3; c++) {
    assert.ok(box.min[c] >= header.bbox.min[c] - 1e-4);
    assert.ok(box.max[c] <= header.bbox.max[c] + 1e-4);
  }
});

// -- scene scale: the single source both the camera and `k` consume ---------

test("sceneExtent: bbox present — max extent, no fallback", () => {
  const r = sceneExtent({ min: [-1, -2, 0], max: [3, 5, 1] });
  assert.equal(r.S, 7); // the y extent dominates
  assert.equal(r.fallback, false);
  assert.deepEqual(r.box, { min: [-1, -2, 0], max: [3, 5, 1] });
});

test("sceneExtent: null bbox — the camera's historical default box, flagged loudly", () => {
  const r = sceneExtent(null);
  assert.equal(r.fallback, true, "the null-bbox branch must be flagged (C1)");
  assert.equal(r.S, 20);
  assert.deepEqual(r.box, DEFAULT_SCENE_BOX);
  assert.ok(NO_BBOX_WARNING.includes("bbox"), "warning names the missing bbox");
  assert.ok(/misscal/i.test(NO_BBOX_WARNING), "warning states the consequence");
});

test("sceneExtent: degenerate box clamps to a positive extent", () => {
  const r = sceneExtent({ min: [1, 1, 1], max: [1, 1, 1] });
  assert.ok(r.S > 0);
});

test("worldPerSizeUnit: the pixel-parity formula, pinned", () => {
  // k = FRAME_DISTANCE_FACTOR · S · tan(fov/2) / NOMINAL_VIEWPORT_PX — so at
  // the initial framing distance (FRAME_DISTANCE_FACTOR·S) a size-v element
  // projects to v·(viewportHeight/NOMINAL_VIEWPORT_PX) px. One constant, all
  // three primitives; the 3:1:1 default ratio is geometric.
  const S = 32.687; // the synthetic reference extent measured in Phase 0
  const k = worldPerSizeUnit(S);
  const expected = (1.6 * S * Math.tan((25 * Math.PI) / 180)) / 720;
  assert.ok(Math.abs(k - expected) < 1e-12);
  assert.ok(Math.abs(k - 0.03387) < 1e-4, `k on the reference data (${k})`);
  // linear in S: doubling the scene doubles world radii, pixels stay put
  assert.ok(Math.abs(worldPerSizeUnit(2 * S) - 2 * k) < 1e-12);
});
