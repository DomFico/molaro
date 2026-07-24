/**
 * ProducedEdgeLayer — the host half of the mid-session authored-edge pass.
 *
 * What must hold (the design's at-risk list, host side):
 *   - ensureCapacity is the ONLY resize surface: geometric growth from the
 *     initial floor, contents copied to the SAME offsets (no id remap), never
 *     shrinking;
 *   - setGroup: a NEW group appends at [nextId, nextId+count); a re-declared
 *     SAME-COUNT group replaces pairs in place (authored appearance survives,
 *     endpoint sizes re-seed); a re-declared DIFFERENT-COUNT group retires the
 *     old span (permanently dark, never reused) and appends fresh — the id
 *     space is append-only and monotonic;
 *   - activeSpan is the DRAW span (highest active group end, 0 when none) —
 *     inactive/retired slots inside it collapse through fillVisibleMask;
 *   - fillVisibleMask: group-active ∧ per-edge visible ∧ BOTH endpoints
 *     visible (hidden wins, the covalent rule);
 *   - new slots carry the covalent default look (an unstyled produced edge is
 *     indistinguishable from a load-time edge).
 */
import assert from "node:assert";
import test from "node:test";

import {
  PRODUCED_EDGE_INITIAL_CAPACITY,
  ProducedEdgeLayer,
} from "../webview/producededges.ts";
import {
  DEFAULT_EDGE_COLOR,
  DEFAULT_EDGE_SIZE,
  DEFAULT_OPACITY,
} from "../webview/representation.ts";

const sizeOf = (p: number): number => 10 + p; // distinguishable endpoint sizes

test("ensureCapacity: doubles from the floor, copies to the SAME offsets, never shrinks", () => {
  const layer = new ProducedEdgeLayer();
  assert.equal(layer.capacity, 0, "empty until something is authored");
  assert.equal(layer.ensureCapacity(1), true);
  assert.equal(layer.capacity, PRODUCED_EDGE_INITIAL_CAPACITY, "first grow lands on the floor");
  // seed a recognizable slot, then cross the floor and prove the copy
  layer.setGroup("a", [[1, 2]], sizeOf);
  layer.colorA[0] = 0.123;
  const wantCap = PRODUCED_EDGE_INITIAL_CAPACITY * 4;
  assert.equal(layer.ensureCapacity(PRODUCED_EDGE_INITIAL_CAPACITY * 2 + 1), true);
  assert.equal(layer.capacity, wantCap, "doubles until ≥ n");
  assert.equal(layer.pairs[0], 1, "pair copied to the SAME offset");
  assert.equal(layer.pairs[1], 2);
  assert.equal(layer.colorA[0], Math.fround(0.123), "appearance copied verbatim");
  assert.equal(layer.ensureCapacity(3), false, "≤ capacity → no reallocation");
  assert.equal(layer.capacity, wantCap, "never shrinks");
});

test("setGroup: a NEW group appends with the covalent default look", () => {
  const layer = new ProducedEdgeLayer();
  const r = layer.setGroup("g", [[0, 1], [2, 3]], sizeOf);
  assert.deepEqual(r, { baseId: 0, count: 2, grew: true });
  assert.deepEqual(layer.groupIds("g"), [0, 1]);
  assert.deepEqual(layer.groups(), [{ name: "g", baseId: 0, count: 2, active: true }]);
  assert.equal(layer.allocated, 2);
  for (const id of [0, 1]) {
    for (const buf of [layer.colorA, layer.colorB]) {
      assert.equal(buf[id * 4], Math.fround(DEFAULT_EDGE_COLOR[0]));
      assert.equal(buf[id * 4 + 1], Math.fround(DEFAULT_EDGE_COLOR[1]));
      assert.equal(buf[id * 4 + 2], Math.fround(DEFAULT_EDGE_COLOR[2]));
      assert.equal(buf[id * 4 + 3], DEFAULT_OPACITY, "alpha rides both halves");
    }
    assert.equal(layer.radius[id], DEFAULT_EDGE_SIZE);
    assert.equal(layer.dash[id], 0, "solid — the byte-identical default");
    assert.equal(layer.style[id], 0);
    assert.equal(layer.visible[id], 1);
  }
  assert.equal(layer.sizeA[0], sizeOf(0), "junction end-sizes seed from the endpoints");
  assert.equal(layer.sizeB[0], sizeOf(1));
  assert.equal(layer.sizeA[1], sizeOf(2));
  assert.equal(layer.sizeB[1], sizeOf(3));
  assert.equal(layer.groupIds("nope"), null);
});

test("setGroup: SAME-count re-declare replaces pairs in place; authored appearance survives", () => {
  const layer = new ProducedEdgeLayer();
  layer.setGroup("g", [[0, 1], [2, 3]], sizeOf);
  layer.colorA[0] = 0.5; // an authored write
  layer.radius[1] = 9;
  layer.setActive("g", false); // even a walked-back group re-activates on re-declare
  const r = layer.setGroup("g", [[4, 5], [6, 7]], sizeOf);
  assert.deepEqual(r, { baseId: 0, count: 2, grew: false }, "SAME ids — no append");
  assert.equal(layer.allocated, 2, "no new ids handed out");
  assert.equal(layer.pairs[0], 4, "pairs replaced");
  assert.equal(layer.sizeA[0], sizeOf(4), "end sizes re-seed for the NEW endpoints");
  assert.equal(layer.colorA[0], 0.5, "authored appearance survives the recompute");
  assert.equal(layer.radius[1], 9);
  assert.equal(layer.group("g")?.active, true, "a re-declaration re-activates");
});

test("setGroup: DIFFERENT-count re-declare retires the old span and appends fresh (monotonic ids)", () => {
  const layer = new ProducedEdgeLayer();
  layer.setGroup("g", [[0, 1], [2, 3]], sizeOf);
  layer.setGroup("other", [[4, 5]], sizeOf); // sits between — proves no compaction
  const r = layer.setGroup("g", [[6, 7], [8, 9], [0, 2]], sizeOf);
  assert.deepEqual(r, { baseId: 3, count: 3, grew: false }, "appends AFTER everything allocated");
  assert.equal(layer.allocated, 6);
  assert.deepEqual(layer.groupIds("g"), [3, 4, 5]);
  assert.deepEqual(layer.groupIds("other"), [2], "the intervening group never moved");
  // the retired span [0,2) belongs to NO group → dark in the mask forever
  const mask = new Float32Array(layer.capacity);
  const allVisible = new Float32Array(16).fill(1);
  layer.fillVisibleMask(allVisible, mask);
  assert.deepEqual([...mask.slice(0, 6)], [0, 0, 1, 1, 1, 1], "retired slots stay dark");
});

test("activeSpan: the highest ACTIVE group end; 0 when none (draws nothing at zero cost)", () => {
  const layer = new ProducedEdgeLayer();
  assert.equal(layer.activeSpan(), 0);
  layer.setGroup("a", [[0, 1], [2, 3]], sizeOf);
  layer.setGroup("b", [[4, 5]], sizeOf);
  assert.equal(layer.activeSpan(), 3);
  assert.equal(layer.setActive("b", false), true);
  assert.equal(layer.activeSpan(), 2, "span shrinks to the highest active end");
  layer.setActive("a", false);
  assert.equal(layer.activeSpan(), 0, "no active group → nothing drawn");
  layer.setActive("b", true);
  assert.equal(layer.activeSpan(), 3, "an inactive LOWER group still uploads under the span");
  assert.equal(layer.setActive("ghost", true), false, "unknown name refused");
});

test("fillVisibleMask: group active ∧ per-edge slot ∧ endpoint hidden-wins", () => {
  const layer = new ProducedEdgeLayer();
  layer.setGroup("a", [[0, 1], [2, 3]], sizeOf);
  layer.setGroup("b", [[1, 3]], sizeOf);
  const pointVisible = new Float32Array([1, 1, 0, 1]); // point 2 hidden
  const mask = new Float32Array(layer.capacity);
  layer.fillVisibleMask(pointVisible, mask);
  assert.deepEqual([...mask.slice(0, 3)], [1, 0, 1], "an edge drops when EITHER endpoint hides");
  layer.visible[2] = 0; // the authored per-edge slot
  layer.fillVisibleMask(pointVisible, mask);
  assert.deepEqual([...mask.slice(0, 3)], [1, 0, 0], "the authored slot gates too");
  layer.visible[2] = 1;
  layer.setActive("a", false);
  layer.fillVisibleMask(pointVisible, mask);
  assert.deepEqual([...mask.slice(0, 3)], [0, 0, 1], "an inactive group's slots go dark, others stand");
});

test("reseedEndSizes: point-size writes reach exactly the incident produced edges", () => {
  const layer = new ProducedEdgeLayer();
  layer.setGroup("a", [[0, 1], [2, 3]], sizeOf);
  const sizes = new Float32Array([7, 8, 9, 11]);
  layer.reseedEndSizes(sizes, [1]); // only point 1 changed
  assert.equal(layer.sizeA[0], 7, "the incident edge re-reads BOTH its ends");
  assert.equal(layer.sizeB[0], 8);
  assert.equal(layer.sizeA[1], sizeOf(2), "a non-incident edge is untouched");
  layer.reseedEndSizes(sizes); // undefined = every allocated edge
  assert.equal(layer.sizeA[1], 9);
  assert.equal(layer.sizeB[1], 11);
});

test("a grow mid-life keeps every group's ids and contents (the undo-slot stability guarantee)", () => {
  const layer = new ProducedEdgeLayer();
  layer.setGroup("a", [[0, 1]], sizeOf);
  layer.colorA[3] = 0.25; // authored alpha on id 0
  const before = layer.groupIds("a");
  // author enough to force reallocation past the floor
  const many: [number, number][] = [];
  for (let i = 0; i < PRODUCED_EDGE_INITIAL_CAPACITY * 2; i++) many.push([0, 1 + (i % 5)]);
  layer.setGroup("big", many, sizeOf);
  assert.ok(layer.capacity >= PRODUCED_EDGE_INITIAL_CAPACITY * 2 + 1, "capacity crossed");
  assert.deepEqual(layer.groupIds("a"), before, "pre-grow ids unmoved");
  assert.equal(layer.colorA[3], 0.25, "pre-grow contents verbatim");
  assert.equal(layer.pairs[0], 0);
  assert.equal(layer.pairs[1], 1);
});
