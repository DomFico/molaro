/**
 * Unit tests for the binding registry (webview/bindings.ts) — the DISJOINT
 * COVERAGE invariant (last-bind-wins on add, element-level release), and the
 * snapshot/restore undo seam. Pure, no DOM. Run from viewer/:
 *   node --test tests/bindings.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BindingRegistry, type Binding } from "../webview/bindings.ts";

const mk = (over: Partial<Binding> = {}): Binding => ({
  channel: "energy",
  axis: "color",
  points: [0, 1, 2],
  expr: "all",
  range: [0, 2.5],
  ...over,
});

test("add: registers and reports an empty release on virgin coverage", () => {
  const r = new BindingRegistry();
  const stats = r.add(mk());
  assert.deepEqual(stats, { touched: 0, removed: 0, points: 0 });
  assert.equal(r.count(), 1);
  assert.equal(r.covering(1)?.channel, "energy");
  assert.equal(r.covering(9), undefined);
});

test("add: LAST-BIND-WINS — overlap is released from the earlier binding, element-level", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1, 2] }));
  const stats = r.add(mk({ channel: "mass", axis: "size", points: [2, 3], expr: "c1" }));
  assert.deepEqual(stats, { touched: 1, removed: 0, points: 1 });
  // the earlier binding SHRANK (partial clear), the new one owns the overlap
  assert.deepEqual(r.all().map((b) => ({ channel: b.channel, points: b.points })), [
    { channel: "energy", points: [0, 1] },
    { channel: "mass", points: [2, 3] },
  ]);
  assert.equal(r.covering(2)?.channel, "mass", "one answer per element");
});

test("add: full overlap removes the earlier binding entirely", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  const stats = r.add(mk({ channel: "mass", points: [0, 1, 2] }));
  assert.deepEqual(stats, { touched: 1, removed: 1, points: 2 });
  assert.equal(r.count(), 1);
  assert.equal(r.covering(0)?.channel, "mass");
});

test("release: shrinks per element; emptied bindings drop; disjointness means no double-count", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  r.add(mk({ channel: "mass", points: [2, 3] }));
  const stats = r.release([1, 2, 3]);
  assert.deepEqual(stats, { touched: 2, removed: 1, points: 3 });
  assert.deepEqual(r.all().map((b) => b.points), [[0]]);
  const none = r.release([9]);
  assert.deepEqual(none, { touched: 0, removed: 0, points: 0 });
});

test("clear: releases everything at once", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  r.add(mk({ channel: "mass", points: [2] }));
  assert.deepEqual(r.clear(), { touched: 2, removed: 2, points: 3 });
  assert.equal(r.count(), 0);
});

test("snapshot/restore: the undo seam round-trips exactly and OWNS its arrays", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1, 2] }));
  const snap = r.snapshot();
  r.add(mk({ channel: "mass", points: [1, 2] })); // shrinks the first binding
  assert.deepEqual(r.all().map((b) => b.points), [[0], [1, 2]]);
  r.restore(snap);
  assert.deepEqual(r.all().map((b) => ({ channel: b.channel, points: b.points })), [
    { channel: "energy", points: [0, 1, 2] },
  ]);
  // the snapshot is not aliased: mutating the registry never edits the snap
  r.release([0]);
  assert.deepEqual(snap[0].points, [0, 1, 2]);
});
