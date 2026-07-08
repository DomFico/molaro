/**
 * Unit tests for the selection/hidden set store (webview/sets.ts). Pure — no DOM.
 * Run from viewer/:  node --test tests/sets.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { Hierarchy, NodeSet, SelectionModel, entryKey, type Entry } from "../webview/sets.ts";

/** Header: cat0 = group0{sub0:[0,1], sub1:[2]}; cat1 = group1{sub2:[3,4,5]}. */
function makeHeader(): Header {
  const category = [0, 0, 0, 1, 1, 1];
  const group_id = [0, 0, 0, 1, 1, 1];
  const subgroup_id = [0, 0, 1, 2, 2, 2];
  const n = category.length;
  return {
    version: "0.1.0", name: "t", n_points: n, n_frames: 1, units: "m", bbox: null,
    points: { type: new Array(n).fill("C"), group_id, subgroup_id, category },
    categories: ["alpha", "beta"], groups: {}, subgroups: {}, edges: [], polylines: [], channels: [],
  };
}

const cat = (id: number): Entry => ({ level: "category", id });
const grp = (id: number): Entry => ({ level: "group", id });
const sub = (id: number): Entry => ({ level: "subgroup", id });
const pt = (id: number): Entry => ({ level: "point", id });

test("Hierarchy resolves entries to points at each level", () => {
  const h = new Hierarchy(makeHeader());
  assert.deepEqual(h.pointsOf(cat(0)).sort(), [0, 1, 2]);
  assert.deepEqual(h.pointsOf(grp(1)).sort(), [3, 4, 5]);
  assert.deepEqual(h.pointsOf(sub(2)).sort(), [3, 4, 5]);
  assert.deepEqual(h.pointsOf(pt(4)), [4]);
  assert.deepEqual(h.subgroupPoints(0).sort(), [0, 1]);
});

test("add/contains/resolve union across mixed-level entries", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "selection");
  s.add(sub(0)); // {0,1}
  s.add(pt(4)); // {4}
  assert.equal(s.entryCount, 2);
  assert.equal(s.pointCount, 3);
  assert.deepEqual(s.resolvedPoints().sort(), [0, 1, 4]);
  assert.ok(s.contains(0) && s.contains(1) && s.contains(4));
  assert.ok(!s.contains(2) && !s.contains(3) && !s.contains(5));
});

test("entry-granularity removal un-covers exactly that entry's points", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "hidden");
  s.add(cat(0)); // {0,1,2}
  assert.equal(s.pointCount, 3);
  // Removing the ONE category entry un-hides all its points.
  s.remove(cat(0));
  assert.equal(s.entryCount, 0);
  assert.equal(s.pointCount, 0);
  assert.ok(!s.contains(0) && !s.contains(1) && !s.contains(2));
});

test("overlapping entries are reference-counted (removal keeps still-covered points)", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "selection");
  s.add(cat(0)); // {0,1,2}
  s.add(sub(0)); // {0,1} — overlaps
  assert.equal(s.pointCount, 3); // union unchanged: {0,1,2}
  s.remove(sub(0)); // 0,1 still covered by cat(0)
  assert.ok(s.contains(0) && s.contains(1) && s.contains(2));
  assert.equal(s.pointCount, 3);
  s.remove(cat(0));
  assert.equal(s.pointCount, 0);
});

test("toggle adds then removes; returns affected points", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "selection");
  const a = s.toggle(sub(2)); // add {3,4,5}
  assert.deepEqual(a.sort(), [3, 4, 5]);
  assert.ok(s.has(sub(2)));
  const b = s.toggle(sub(2)); // remove
  assert.deepEqual(b.sort(), [3, 4, 5]);
  assert.ok(!s.has(sub(2)));
  assert.equal(s.pointCount, 0);
});

test("replaceWith swaps entries in one shot", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "selection");
  s.add(sub(0));
  const affected = s.replaceWith([grp(1)]);
  assert.deepEqual(s.listEntries().map(entryKey), ["group:1"]);
  assert.deepEqual(s.resolvedPoints().sort(), [3, 4, 5]);
  // affected covers both the removed (0,1) and added (3,4,5) points
  assert.ok([0, 1, 3, 4, 5].every((p) => affected.includes(p)));
});

test("addMany (range) unions and de-dupes; clear empties", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "selection");
  s.addMany([sub(0), sub(1), sub(0)]); // {0,1} ∪ {2}, dup ignored
  assert.equal(s.entryCount, 2);
  assert.deepEqual(s.resolvedPoints().sort(), [0, 1, 2]);
  s.clear();
  assert.equal(s.entryCount, 0);
  assert.equal(s.pointCount, 0);
});

test("onChange fires on mutation, unsubscribes cleanly", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h, "hidden");
  let n = 0;
  const off = s.onChange(() => n++);
  s.add(sub(0));
  s.toggle(pt(3));
  assert.equal(n, 2);
  off();
  s.clear();
  assert.equal(n, 2);
});

test("Hierarchy exposes ancestors + subgroup-of-point", () => {
  const h = new Hierarchy(makeHeader());
  assert.equal(h.subgroupOfPoint(4), 2);
  assert.deepEqual(h.ancestorsOfSubgroup(2), { category: 1, group: 1 });
  assert.deepEqual(h.ancestorsOfSubgroup(0), { category: 0, group: 0 });
});

// ---- SelectionModel (named groups) ----------------------------------------

test("SelectionModel starts with one active group, auto-named", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  assert.equal(m.list().length, 1);
  assert.equal(m.list()[0].name, "selection_1");
  assert.equal(m.active.id, m.list()[0].id);
});

test("newGroup creates + activates; setActive switches", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  const g2 = m.newGroup();
  assert.equal(m.list().length, 2);
  assert.equal(m.active.id, g2.id);
  assert.equal(g2.name, "selection_2");
  m.setActive(m.list()[0].id);
  assert.equal(m.active.id, m.list()[0].id);
});

test("rename changes the group name", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  m.rename(m.active.id, "waters");
  assert.equal(m.list()[0].name, "waters");
});

test("toggle affects only the ACTIVE group; other groups untouched", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  const g1 = m.active;
  m.toggle(sub(0)); // into g1
  const g2 = m.newGroup(); // now active
  m.toggle(sub(2)); // into g2
  assert.ok(g1.set.has(sub(0)) && !g1.set.has(sub(2)));
  assert.ok(g2.set.has(sub(2)) && !g2.set.has(sub(0)));
  // union covers both groups' points
  assert.ok(m.containsPoint(0) && m.containsPoint(3));
  assert.deepEqual(m.resolvedPoints().sort((a, b) => a - b), [0, 1, 3, 4, 5]);
});

test("toggle add then toggle remove leaves siblings intact (no replace)", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  m.toggle(sub(0)); // {0,1}
  m.toggle(pt(4)); // add, not replace -> {0,1,4}
  assert.deepEqual(m.resolvedPoints().sort((a, b) => a - b), [0, 1, 4]);
  m.toggle(sub(0)); // remove just sub(0) -> {4}
  assert.deepEqual(m.resolvedPoints(), [4]);
  assert.ok(m.anyHas(pt(4)) && !m.anyHas(sub(0)));
});

test("an entry can live in two groups (overlap); union stays until both gone", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  m.toggle(sub(2)); // g1: {3,4,5}
  const g2 = m.newGroup();
  m.toggle(sub(2)); // g2 also: {3,4,5}
  assert.ok(m.containsPoint(3));
  m.setActive(m.list()[0].id);
  m.toggle(sub(2)); // remove from g1; still in g2
  assert.ok(m.containsPoint(3));
  m.setActive(g2.id);
  m.toggle(sub(2)); // remove from g2
  assert.ok(!m.containsPoint(3));
});

test("delete removes a group (keeps >=1) and un-covers only its points", () => {
  const m = new SelectionModel(new Hierarchy(makeHeader()));
  m.toggle(sub(0)); // g1 {0,1}
  const g2 = m.newGroup();
  m.toggle(sub(2)); // g2 {3,4,5}
  const affected = m.delete(g2.id);
  assert.deepEqual(affected.sort((a, b) => a - b), [3, 4, 5]);
  assert.ok(m.containsPoint(0) && !m.containsPoint(3));
  assert.equal(m.list().length, 1);
  // deleting the last remaining group keeps at least one (fresh, empty)
  m.delete(m.list()[0].id);
  assert.equal(m.list().length, 1);
  assert.equal(m.resolvedPoints().length, 0);
});
