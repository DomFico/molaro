/**
 * Unit tests for CPU picking, selection bounds, and neighbor queries. Pure math.
 * Run from viewer/:  node --test tests/picking.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { neighborSubgroups, pickElement, pickPoint, selectionBounds } from "../webview/picking.ts";
import type { PickGeometry } from "../webview/picking.ts";

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

// -- size-aware pick (pickElement) --------------------------------------------
//
// With ORTHO (world x,y → NDC, w=1) on a 200×200 buffer and tanHalfFov = 100,
// pxScale = height/(2·tanHalfFov) = 1, so with worldPerSize (k) = 1 a candidate
// of size-value `v` is drawn with a hit radius of exactly `v` PIXELS. That makes
// the covers/does-not-cover boundary trivial to reason about in the tests.
const geom = (over: Partial<PickGeometry> & { pointSize: ArrayLike<number> }): PickGeometry => ({
  worldPerSize: 1,
  tanHalfFov: 100,
  segments: null,
  ...over,
});

/**
 * A perspective-like view-projection with clip.w = z (positive in front) and
 * NDC = (x/z, y/z): a point farther along +z is deeper. Column-major.
 */
const PERSP_DEPTH = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
  0, 0, 0, 0,
]);

test("pickElement: a large-radius sphere wins over a nearer-CENTER tiny point", () => {
  // BIG at NDC (0,0) drawn with a 30px radius; TINY at NDC (0.1,0) drawn 1px.
  const positions = new Float32Array([0, 0, 0, 0.1, 0, 0]);
  const visible = new Float32Array([1, 1]);
  const g = geom({ pointSize: new Float32Array([30, 1]) });
  // Click at NDC (0.08,0) = px (8,0): TINY's center is 2px away, BIG's is 8px.
  const r = pickElement(positions, 2, visible, ORTHO, 0.08, 0, 200, 200, 12, g);
  assert.equal(r.index, 0); // covered by BIG's drawn silhouette
  // the LEGACY center-only test picks the WRONG one (nearer tiny center):
  const old = pickPoint(positions, 2, visible, ORTHO, 0.08, 0, 200, 200, 12);
  assert.equal(old.index, 1);
});

test("pickElement: clicking a SEGMENT body resolves to the nearer endpoint", () => {
  // A at NDC (-0.5,0)=px(-50,0), B at NDC (0.5,0)=px(50,0); both tiny points.
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0]);
  const visible = new Float32Array([1, 1]);
  const g = geom({
    pointSize: new Float32Array([1, 1]), // endpoints too small to cover the body
    segments: { count: 1, pointA: [0], pointB: [1], halfA: [8], halfB: [8] }, // 8px half-width
  });
  // Click at NDC (0.1,0.03)=px(10,3): on the drawn tube (3px off the axis),
  // 40px from B's center and 60px from A's — no endpoint center is near.
  const r = pickElement(positions, 2, visible, ORTHO, 0.1, 0.03, 200, 200, 12, g);
  assert.equal(r.index, 1); // t≈0.6 along A→B ⇒ nearer endpoint is B
  // legacy center-only finds neither endpoint under the click:
  const old = pickPoint(positions, 2, visible, ORTHO, 0.1, 0.03, 200, 200, 12);
  assert.equal(old.index, -1);
});

test("pickElement: a body-click outside the half-width does NOT cover", () => {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0]);
  const visible = new Float32Array([1, 1]);
  const g = geom({
    pointSize: new Float32Array([1, 1]),
    segments: { count: 1, pointA: [0], pointB: [1], halfA: [2], halfB: [2] }, // only 2px
  });
  // px(10,3): 3px off the axis > 2px half-width ⇒ tube misses; endpoints far ⇒ -1.
  const r = pickElement(positions, 2, visible, ORTHO, 0.1, 0.03, 200, 200, 5, g);
  assert.equal(r.index, -1);
});

test("pickElement: among covering candidates the FRONT-MOST (least depth) wins", () => {
  // Two big spheres on the same screen ray: BACK at z=4 (index 0), FRONT at z=1
  // (index 1). Both project to px (0,0); the click is dead-center. Size 60 keeps
  // BOTH drawn radii above the 12px threshold (BACK is 60/4=15px), so both are
  // genuine cover candidates and the winner is decided purely by DEPTH.
  const positions = new Float32Array([0, 0, 4, 0, 0, 1]);
  const visible = new Float32Array([1, 1]);
  const g = geom({ pointSize: new Float32Array([60, 60]) });
  const r = pickElement(positions, 2, visible, PERSP_DEPTH, 0, 0, 200, 200, 12, g);
  assert.equal(r.index, 1); // FRONT wins despite being second in the array
});

test("pickElement: a SMALL sphere never overrides the nearest-center pick by depth", () => {
  // Two DEFAULT-size dots ~4px apart on screen: BEHIND at index 0 (z close),
  // IN-FRONT at index 1 (z closer). Their drawn radii (~a few px) never exceed
  // the 12px threshold, so neither is a cover candidate — a click on dot 0's
  // center resolves by proximity to dot 0, NOT to the front dot. This is the
  // default-scene invariant the whole existing suite relies on.
  const positions = new Float32Array([0, 0, 2, 0.04, 0, 1]);
  const g = geom({ pointSize: new Float32Array([2, 2]) });
  const r = pickElement(positions, 2, new Float32Array([1, 1]), PERSP_DEPTH, 0, 0, 200, 200, 12, g);
  assert.equal(r.index, 0); // the clicked dot, not the nearer-in-front neighbour
});

test("pickElement: nothing covers ⇒ legacy nearest-center fallback (small element still picks)", () => {
  // One tiny (1px) point at NDC (0,0). A click 5px away is beyond its drawn
  // radius but within the fallback threshold ⇒ it still picks (as before).
  const positions = new Float32Array([0, 0, 0]);
  const visible = new Float32Array([1]);
  const g = geom({ pointSize: new Float32Array([1]) });
  assert.equal(pickElement(positions, 1, visible, ORTHO, 0.05, 0, 200, 200, 12, g).index, 0);
  // ...but a click 20px away (beyond BOTH the drawn radius and the threshold)
  // returns nothing — no over-grab near a small element.
  assert.equal(pickElement(positions, 1, visible, ORTHO, 0.2, 0, 200, 200, 12, g).index, -1);
});

test("pickElement: hidden points and hidden-endpoint segments are skipped", () => {
  const positions = new Float32Array([0, 0, 0, 0.02, 0, 0]);
  // point 0 hidden; point 1 visible. Click dead-center on 0.
  const g = geom({
    pointSize: new Float32Array([30, 1]),
    segments: { count: 1, pointA: [0], pointB: [1], halfA: [20], halfB: [20] },
  });
  const r = pickElement(positions, 2, new Float32Array([0, 1]), ORTHO, 0, 0, 200, 200, 12, g);
  // the big hidden sphere (0) and the segment (endpoint 0 hidden ⇒ tube gone)
  // are both out; only the visible tiny point 1 remains, reached via fallback.
  assert.equal(r.index, 1);
});

test("pickElement: a zero-size sphere is not covered but stays fallback-pickable", () => {
  const positions = new Float32Array([0, 0, 0]);
  const g = geom({ pointSize: new Float32Array([0]) });
  // dead-center click: zero radius never "covers", but the nearest-center
  // fallback still reaches it (parity with the renderer's zero-radius points
  // staying pickable).
  assert.equal(pickElement(positions, 1, new Float32Array([1]), ORTHO, 0, 0, 200, 200, 12, g).index, 0);
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

// -- pick state does not leak between calls -----------------------------------
// pickElement is called on EVERY pointermove during a Ctrl-drag paint, and its
// cost is O(N + 2E) — covalent-bond inference grew E on the corpus membrane from
// 50 488 to 173 940, so a per-call projection MEMO is the obvious optimisation
// and was built. It was then MEASURED to be a net loss (see the note above
// `const out` in webview/picking.ts: it makes the common N >> E case 56% worse to
// make the dense case 15% better) and removed.
//
// These stay, because they are what any future attempt has to survive: they pin
// that two picks in a row cannot share state through the coordinates, the camera,
// or a grown buffer. They pass today by construction — nothing is cached — which
// is the point: they are the trap, armed in advance.

test("two picks in a row do not share state across a frame flip", () => {
  const g = geom({
    pointSize: new Float32Array([30, 30]),
    segments: { count: 1, pointA: [0], pointB: [1], halfA: [1], halfB: [1] },
  });
  const frame0 = new Float32Array([-0.5, 0, 0, 0.9, 0, 0]);
  const frame1 = new Float32Array([0.9, 0, 0, -0.5, 0, 0]); // the two points swap
  const a = pickElement(frame0, 2, new Float32Array([1, 1]), ORTHO, -0.5, 0, 200, 200, 12, g);
  const b = pickElement(frame1, 2, new Float32Array([1, 1]), ORTHO, -0.5, 0, 200, 200, 12, g);
  assert.equal(a.index, 0, "frame 0: point 0 sits under the click");
  assert.equal(b.index, 1, "frame 1: point 1 does — shared state would still say 0");
});

test("two picks in a row do not share state across a camera move", () => {
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0]);
  const g = geom({ pointSize: new Float32Array([1, 1]) });
  // A second view-projection that mirrors x, so the same click lands on the
  // other point without any coordinate changing.
  const MIRROR = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const a = pickElement(positions, 2, new Float32Array([1, 1]), ORTHO, -0.5, 0, 200, 200, 12, g);
  const b = pickElement(positions, 2, new Float32Array([1, 1]), MIRROR, -0.5, 0, 200, 200, 12, g);
  assert.equal(a.index, 0);
  assert.equal(b.index, 1, "shared state would answer with the previous camera");
});

test("a pick on a bigger scene is not answered from a smaller earlier one", () => {
  const small = new Float32Array([0, 0, 0]);
  const gSmall = geom({ pointSize: new Float32Array([1]) });
  assert.equal(pickElement(small, 1, new Float32Array([1]), ORTHO, 0, 0, 200, 200, 12, gSmall).index, 0);
  const N = 500;
  const big = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) big[p * 3] = -0.9 + (1.8 * p) / (N - 1);
  const gBig = geom({ pointSize: new Float32Array(N).fill(1) });
  const r = pickElement(big, N, new Float32Array(N).fill(1), ORTHO, 0.9, 0, 200, 200, 12, gBig);
  assert.equal(r.index, N - 1, "the rightmost point, not whatever index 0 held");
});
