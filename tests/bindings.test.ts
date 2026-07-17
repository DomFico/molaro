/**
 * Unit tests for the binding registry (webview/bindings.ts) — the PER-AXIS
 * DISJOINT COVERAGE invariant (last-bind-wins on add within an axis;
 * cross-axis bindings coexist; element-level release, axis-scoped or not),
 * overlapStats (the read-only takeover report), and the snapshot/restore
 * undo seam. Pure, no DOM. Run from viewer/:
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

test("add: registers and reports an empty takeover on virgin coverage", () => {
  const r = new BindingRegistry();
  const stats = r.add(mk());
  assert.deepEqual(stats, { touched: 0, removed: 0, points: 0 });
  assert.equal(r.count(), 1);
  assert.equal(r.covering(1, "color")?.channel, "energy");
  assert.equal(r.covering(9, "color"), undefined);
  assert.equal(r.covering(1, "size"), undefined, "coverage is per axis");
});

test("add: LAST-BIND-WINS within an axis — overlap released element-level", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1, 2] }));
  const stats = r.add(mk({ channel: "mass", points: [2, 3], expr: "c1" }));
  assert.deepEqual(stats, { touched: 1, removed: 0, points: 1 });
  // the earlier binding SHRANK (partial clear), the new one owns the overlap
  assert.deepEqual(r.all().map((b) => ({ channel: b.channel, points: b.points })), [
    { channel: "energy", points: [0, 1] },
    { channel: "mass", points: [2, 3] },
  ]);
  assert.equal(r.covering(2, "color")?.channel, "mass", "one answer per element per axis");
});

test("add: bindings on DIFFERENT axes coexist over the same elements", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1, 2] })); // color
  const stats = r.add(mk({ channel: "mass", axis: "size", points: [0, 1, 2] }));
  assert.deepEqual(stats, { touched: 0, removed: 0, points: 0 }, "no same-axis overlap → no takeover");
  assert.equal(r.count(), 2);
  assert.equal(r.covering(1, "color")?.channel, "energy");
  assert.equal(r.covering(1, "size")?.channel, "mass");
});

test("add: full same-axis overlap removes the earlier binding entirely", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  const stats = r.add(mk({ channel: "mass", points: [0, 1, 2] }));
  assert.deepEqual(stats, { touched: 1, removed: 1, points: 2 });
  assert.equal(r.count(), 1);
  assert.equal(r.covering(0, "color")?.channel, "mass");
});

test("release: element-wise shrink; emptied bindings drop; axis-scoped when given", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] })); // color
  r.add(mk({ channel: "mass", axis: "size", points: [0, 1] }));
  // axis-scoped: only the color binding loses coverage
  const colorOnly = r.release([1], "color");
  assert.deepEqual(colorOnly, { touched: 1, removed: 0, points: 1 });
  assert.equal(r.covering(1, "size")?.channel, "mass", "the size binding is untouched");
  // unscoped: every axis
  const both = r.release([0], null);
  assert.deepEqual(both, { touched: 2, removed: 1, points: 2 });
  assert.deepEqual(r.all().map((b) => ({ axis: b.axis, points: b.points })), [
    { axis: "size", points: [1] },
  ]);
  const none = r.release([9], null);
  assert.deepEqual(none, { touched: 0, removed: 0, points: 0 });
});

test("release(null): every element — whole-registry or one axis", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  r.add(mk({ channel: "mass", axis: "size", points: [2] }));
  assert.deepEqual(r.release(null, "size"), { touched: 1, removed: 1, points: 1 });
  assert.equal(r.count(), 1);
  assert.deepEqual(r.release(null, null), { touched: 1, removed: 1, points: 2 });
  assert.equal(r.count(), 0);
});

test("overlapStats: reports what release WOULD do, without mutating", () => {
  const r = new BindingRegistry();
  r.add(mk({ points: [0, 1] }));
  r.add(mk({ channel: "mass", axis: "size", points: [0, 1] }));
  assert.deepEqual(r.overlapStats([1, 2], "color"), { touched: 1, removed: 0, points: 1 });
  assert.deepEqual(r.overlapStats([0, 1], "color"), { touched: 1, removed: 1, points: 2 });
  assert.deepEqual(r.overlapStats([9], "color"), { touched: 0, removed: 0, points: 0 });
  assert.equal(r.count(), 2, "overlapStats mutates nothing");
  assert.deepEqual(r.all()[0].points, [0, 1]);
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
  r.release([0], null);
  assert.deepEqual(snap[0].points, [0, 1, 2]);
});
