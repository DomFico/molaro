/**
 * Unit tests for CPU picking, selection bounds, and neighbor queries. Pure math.
 * Run from viewer/:  node --test tests/picking.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { neighborSubgroups, pickPoint, selectionBounds } from "../webview/picking.ts";

/**
 * An orthographic-ish view-projection that maps world x,y directly to NDC and
 * keeps w=1, so a point at world (a,b,0) lands at NDC (a,b). Column-major.
 */
const ORTHO = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

test("pickPoint returns the visible point nearest the click", () => {
  // three points at NDC (-0.5,0), (0.5,0), (0.4,0.02)
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.4, 0.02, 0]);
  const visible = new Float32Array([1, 1, 1]);
  const r = pickPoint(positions, 3, visible, ORTHO, 0.5, 0, 200, 200, 12);
  assert.equal(r.index, 1); // closest to click NDC (0.5, 0)
});

test("pickPoint skips hidden points", () => {
  const positions = new Float32Array([0.5, 0, 0, 0.52, 0, 0]);
  const visible = new Float32Array([0, 1]); // nearest is hidden
  const r = pickPoint(positions, 2, visible, ORTHO, 0.5, 0, 200, 200, 12);
  assert.equal(r.index, 1);
});

test("pickPoint returns -1 when nothing is within the pixel threshold", () => {
  const positions = new Float32Array([-0.9, -0.9, 0]);
  const visible = new Float32Array([1]);
  // click far away on a 200px buffer; threshold 5px.
  const r = pickPoint(positions, 1, visible, ORTHO, 0.9, 0.9, 200, 200, 5);
  assert.equal(r.index, -1);
});

test("pickPoint ignores points behind the camera (w<=0)", () => {
  // A perspective-like matrix where w = -z. Point at z=1 -> w=-1 (behind).
  const persp = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, -1,
    0, 0, 0, 0,
  ]);
  const positions = new Float32Array([0, 0, 1]);
  const r = pickPoint(positions, 1, null, persp, 0, 0, 200, 200, 100);
  assert.equal(r.index, -1);
});

test("selectionBounds returns centroid and enclosing radius", () => {
  const positions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    1, 0, 0, // unrelated, not selected
  ]);
  const b = selectionBounds(positions, [0, 1]);
  assert.ok(b);
  assert.deepEqual(b!.center, [1, 0, 0]);
  assert.equal(b!.radius, 1);
  assert.equal(selectionBounds(positions, []), null);
});

test("neighborSubgroups finds nearby subgroups, excludes self", () => {
  // selected point 0 at origin (subgroup 0). candidates: p1 near (sub1), p2 far
  // (sub2), p3 near but subgroup 0 (self, excluded).
  const positions = new Float32Array([
    0, 0, 0, // p0 selected, sub0
    1, 0, 0, // p1, sub1 (within radius 2)
    10, 0, 0, // p2, sub2 (outside)
    0.5, 0, 0, // p3, sub0 (self)
  ]);
  const subgroupOfPoint = [0, 1, 2, 0];
  const out = neighborSubgroups(
    positions,
    [0],
    [1, 2, 3],
    subgroupOfPoint,
    new Set([0]),
    2,
  );
  assert.deepEqual(out.sort(), [1]);
});
