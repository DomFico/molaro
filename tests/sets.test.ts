/**
 * Unit tests for the selection state model (webview/sets.ts) — the pending
 * target + committed selections + hidden flags + system-wide undo. Pure, no
 * DOM. Run from viewer/:  node --test tests/sets.test.ts
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

function model(): SelectionModel {
  return new SelectionModel(new Hierarchy(makeHeader()));
}

// -- Hierarchy / NodeSet substrate (unchanged semantics) ----------------------

test("Hierarchy resolves entries to points at each level", () => {
  const h = new Hierarchy(makeHeader());
  assert.deepEqual(h.pointsOf(cat(0)).sort(), [0, 1, 2]);
  assert.deepEqual(h.pointsOf(grp(1)).sort(), [3, 4, 5]);
  assert.deepEqual(h.pointsOf(sub(2)).sort(), [3, 4, 5]);
  assert.deepEqual(h.pointsOf(pt(4)), [4]);
  assert.deepEqual(h.subgroupPoints(0).sort(), [0, 1]);
});

test("NodeSet union across mixed-level entries, ref-counted removal", () => {
  const h = new Hierarchy(makeHeader());
  const s = new NodeSet(h);
  s.add(sub(0)); // {0,1}
  s.add(pt(4));
  s.add(cat(0)); // {0,1,2} — overlaps sub(0)
  assert.equal(s.pointCount, 4);
  s.remove(sub(0)); // 0,1 still covered by cat(0)
  assert.ok(s.contains(0) && s.contains(1));
  s.remove(cat(0));
  assert.deepEqual(s.resolvedPoints(), [4]);
});

// -- pending target: build gestures --------------------------------------------

test("toggle/add/remove act on the pending target; green = target footprint", () => {
  const m = model();
  m.toggleInTarget(sub(0));
  assert.ok(m.targetContains(0) && m.targetContains(1) && !m.targetContains(2));
  m.addToTarget(pt(2));
  assert.ok(m.targetContains(2));
  m.removeFromTarget(pt(2));
  assert.ok(!m.targetContains(2));
  m.toggleInTarget(sub(0)); // toggle off
  assert.equal(m.pending.pointCount, 0);
});

test("coversEntry / touchKeys give row semantics (ancestor-covered + path-partial)", () => {
  const m = model();
  m.addToTarget(grp(1));
  // descendants of an entry are covered
  assert.ok(m.targetCoversEntry(sub(2)));
  assert.ok(m.targetCoversEntry(pt(3)));
  assert.ok(!m.targetCoversEntry(cat(0)));
  // ancestors of an entry are "touched" (partial)
  const keys = m.touchKeys(m.target);
  assert.ok(keys.has(entryKey(cat(1))));
  assert.ok(keys.has(entryKey(grp(1))));
  assert.ok(!keys.has(entryKey(cat(0))));
});

test("carving: unselecting a covered descendant splits the coarse entry", () => {
  const m = model();
  m.addToTarget(cat(0)); // {0,1,2} via one category entry
  // clicking a covered subgroup toggles it OFF by carving a hole
  const pts = m.toggleInTarget(sub(1)); // sub1 = {2}
  assert.ok(!m.targetCoversEntry(sub(1)), "clicked node no longer covered");
  assert.ok(m.targetCoversEntry(sub(0)), "siblings stay selected");
  assert.deepEqual(m.pending.resolvedPoints(), [0, 1]);
  assert.ok(pts.includes(2), "affected points include the carved hole");
  // one undo restores the original coarse entry exactly
  m.undo();
  assert.ok(m.pending.has(cat(0)) && !m.pending.has(sub(0)));
  assert.deepEqual(m.pending.resolvedPoints(), [0, 1, 2]);
});

test("carving a point out of a subgroup entry keeps the sibling points", () => {
  const m = model();
  m.addToTarget(sub(2)); // {3,4,5}
  m.toggleInTarget(pt(4));
  assert.deepEqual(m.pending.resolvedPoints().sort(), [3, 5]);
  m.undo();
  assert.deepEqual(m.pending.resolvedPoints().sort(), [3, 4, 5]);
});

// -- commit ---------------------------------------------------------------------

test("commit names uniquely, clears pending, returns the committed selection", () => {
  const m = model();
  m.addToTarget(sub(0));
  const sel = m.commit()!;
  assert.equal(sel.name, "selection_1");
  assert.equal(sel.set.pointCount, 2);
  assert.equal(m.pending.entryCount, 0);
  assert.equal(m.committed().length, 1);
  assert.ok(!m.targetContains(0), "green cleared after commit");
  // empty pending → no commit
  assert.equal(m.commit(), null);
});

test("committed selections do not affect target or hidden until flagged", () => {
  const m = model();
  m.addToTarget(cat(1));
  const sel = m.commit()!;
  assert.ok(!m.isPointHidden(3));
  m.setHidden(sel.id, true);
  assert.ok(m.isPointHidden(3) && m.isPointHidden(5) && !m.isPointHidden(0));
  m.toggleHidden(sel.id);
  assert.ok(!m.isPointHidden(3));
});

test("hidden is the union of hidden committed selections", () => {
  const m = model();
  m.addToTarget(sub(0));
  const a = m.commit()!;
  m.addToTarget(sub(1));
  const b = m.commit()!;
  m.setHidden(a.id, true);
  m.setHidden(b.id, true);
  assert.deepEqual([0, 1, 2].map((p) => m.isPointHidden(p)), [true, true, true]);
  m.setHidden(a.id, false);
  assert.deepEqual([0, 1, 2].map((p) => m.isPointHidden(p)), [false, false, true]);
});

test("overlap precedence: a NEWER selection shows points an older hidden one covers", () => {
  const m = model();
  m.addToTarget(cat(0)); // {0,1,2}
  const older = m.commit()!;
  m.setHidden(older.id, true);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(2));
  m.addToTarget(sub(0)); // {0,1} inside the hidden region
  const newer = m.commit()!;
  assert.ok(!m.isPointHidden(0) && !m.isPointHidden(1), "newer selection shows its points");
  assert.ok(m.isPointHidden(2), "uncovered remainder stays hidden");
  m.setHidden(newer.id, true);
  assert.ok(m.isPointHidden(0), "newest vote flips both ways");
  m.setHidden(newer.id, false);
  const affected = m.deleteSelection(newer.id);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(1), "delete resurfaces the older hide");
  assert.deepEqual(affected.sort(), [0, 1], "all covered points reported on delete");
});

test("overlap precedence: a newer HIDDEN selection hides inside an older visible one", () => {
  const m = model();
  const seedSel = m.seed("everything", [cat(0)]); // visible, covers {0,1,2}
  m.addToTarget(sub(0)); // {0,1}
  const subset = m.commit()!;
  m.setHidden(subset.id, true);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(1), "newer hide wins over the older seed");
  assert.ok(!m.isPointHidden(2), "the rest of the seed stays visible");
  assert.ok(!seedSel.hidden);
});

// -- edit mode --------------------------------------------------------------------

test("edit mode redirects the target to the committed set; Done restores pending", () => {
  const m = model();
  m.addToTarget(sub(0));
  const sel = m.commit()!;
  m.addToTarget(pt(5)); // new pending content
  m.beginEdit(sel.id);
  assert.equal(m.editing?.id, sel.id);
  assert.ok(m.targetContains(0) && !m.targetContains(5), "target = edited set");
  m.toggleInTarget(sub(1)); // add to the committed selection
  assert.equal(sel.set.pointCount, 3);
  m.removeFromTarget(sub(0)); // members removable in edit mode
  assert.equal(sel.set.pointCount, 1);
  m.endEdit();
  assert.equal(m.editing, null);
  assert.ok(m.targetContains(5) && !m.targetContains(2), "pending kept aside and restored");
  // commit is a no-op while editing
  m.beginEdit(sel.id);
  assert.equal(m.commit(), null);
});

// -- rename / delete / lanes --------------------------------------------------------

test("rename enforces unique non-empty names and is undoable", () => {
  const m = model();
  m.addToTarget(pt(0));
  const a = m.commit()!;
  m.addToTarget(pt(1));
  const b = m.commit()!;
  assert.ok(m.rename(a.id, "core"));
  assert.equal(a.name, "core");
  assert.ok(!m.rename(b.id, "core"), "duplicate rejected");
  assert.ok(!m.rename(b.id, "   "), "blank rejected");
  m.undo();
  assert.equal(a.name, "selection_1");
});

test("delete removes the selection, un-hides its points, exits its edit mode", () => {
  const m = model();
  m.addToTarget(cat(0));
  const sel = m.commit()!;
  m.setHidden(sel.id, true);
  m.beginEdit(sel.id);
  const affected = m.deleteSelection(sel.id);
  assert.deepEqual(affected.sort(), [0, 1, 2], "hidden points reported for un-hide");
  assert.equal(m.committed().length, 0);
  assert.equal(m.editing, null);
  assert.ok(!m.isPointHidden(0));
});

test("seed creates a VISIBLE pre-made selection outside the undo stack", () => {
  const m = model();
  const sel = m.seed("alpha", [cat(0)]);
  assert.equal(sel.name, "alpha");
  assert.ok(!sel.hidden, "nothing hidden by default");
  assert.ok(!m.isPointHidden(0));
  assert.equal(m.canUndo, false, "seeding is initial state, not undoable");
  m.setHidden(sel.id, true); // one action hides the environment
  assert.ok(m.isPointHidden(0));
});

test("lanes: each commit auto-picks a free bracket lane", () => {
  const m = model();
  m.addToTarget(pt(0));
  const a = m.commit()!;
  m.addToTarget(pt(1));
  const b = m.commit()!;
  assert.notEqual(a.lane, b.lane);
});

// -- undo -------------------------------------------------------------------------

test("undo walks back build edits, commit, hide, in order", () => {
  const m = model();
  m.toggleInTarget(sub(0)); // 1: add
  const sel = m.commit()!; // 2: commit
  m.setHidden(sel.id, true); // 3: hide
  assert.ok(m.isPointHidden(0));

  const pts = m.undo()!; // undo hide
  assert.ok(!m.isPointHidden(0));
  assert.deepEqual(pts.sort(), [0, 1]);

  m.undo(); // undo commit — pending restored, committed gone
  assert.equal(m.committed().length, 0);
  assert.ok(m.targetContains(0), "pending selection restored green");

  m.undo(); // undo the original toggle
  assert.equal(m.pending.entryCount, 0);
  assert.equal(m.undo(), null, "stack exhausted");
});

test("undo after commit-undo reuses the auto-name (no counter bleed)", () => {
  const m = model();
  m.addToTarget(pt(0));
  m.commit();
  m.undo(); // back to pending
  const again = m.commit()!;
  assert.equal(again.name, "selection_1", "auto counter rewinds with undo");
});

test("auto-numbering restarts: freed names are reused (relative to the list)", () => {
  const m = model();
  m.addToTarget(pt(0));
  const a = m.commit()!; // selection_1
  m.addToTarget(pt(1));
  m.commit(); // selection_2
  m.deleteSelection(a.id);
  m.addToTarget(pt(2));
  assert.equal(m.commit()!.name, "selection_1", "freed number reused");
  m.addToTarget(pt(3));
  assert.equal(m.commit()!.name, "selection_3", "then the next free number");
});

test("a paint stroke undoes as one unit", () => {
  const m = model();
  m.beginStroke();
  m.addToTarget(pt(0));
  m.addToTarget(pt(1));
  m.addToTarget(pt(2));
  m.endStroke();
  assert.equal(m.pending.entryCount, 3);
  const pts = m.undo()!;
  assert.equal(m.pending.entryCount, 0, "whole stroke reverted at once");
  assert.deepEqual(pts.sort(), [0, 1, 2]);
});

test("clearPending (Escape) is undoable", () => {
  const m = model();
  m.addToTarget(sub(2));
  m.clearPending();
  assert.equal(m.pending.entryCount, 0);
  m.undo();
  assert.equal(m.pending.entryCount, 1);
  assert.ok(m.targetContains(4));
});

test("edit-mode edits are undoable after leaving edit mode", () => {
  const m = model();
  m.addToTarget(sub(0));
  const sel = m.commit()!;
  m.beginEdit(sel.id);
  m.toggleInTarget(pt(5));
  m.endEdit();
  assert.ok(sel.set.contains(5));
  m.undo(); // undoes the edit inside the committed set
  assert.ok(!sel.set.contains(5));
  assert.equal(m.committed().length, 1, "commit itself not undone yet");
});

test("per-member hide: entries hide individually, union with whole-hide", () => {
  const m = model();
  m.addToTarget(sub(0)); // {0,1}
  m.addToTarget(sub(1)); // {2}
  const sel = m.commit()!;
  m.setEntryHidden(sel.id, sub(0), true);
  assert.ok(m.entryHidden(sel.id, sub(0)) && !m.entryHidden(sel.id, sub(1)));
  assert.ok(m.isPointHidden(0) && m.isPointHidden(1) && !m.isPointHidden(2));
  m.toggleEntryHidden(sel.id, sub(0));
  assert.ok(!m.isPointHidden(0));
  // non-members can't be part-hidden
  assert.deepEqual(m.setEntryHidden(sel.id, sub(2), true), []);
  // batch hide is one undo unit
  m.setEntriesHidden(sel.id, [sub(0), sub(1)], true);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(2));
  m.undo();
  assert.ok(!m.isPointHidden(0) && !m.isPointHidden(2), "one undo reverts the batch");
});

test("removing an edited member drops its individual hide; delete un-hides parts", () => {
  const m = model();
  m.addToTarget(sub(0));
  const sel = m.commit()!;
  m.setEntryHidden(sel.id, sub(0), true);
  m.beginEdit(sel.id);
  m.removeFromTarget(sub(0));
  assert.ok(!m.isPointHidden(0), "hide dropped with the member");
  m.undo(); // restores member AND its hide in one op
  assert.ok(sel.set.has(sub(0)) && m.isPointHidden(0));
  m.endEdit();
  const affected = m.deleteSelection(sel.id);
  assert.deepEqual(affected.sort(), [0, 1], "part-hidden points reported for un-hide");
  assert.ok(!m.isPointHidden(0));
});

test("clearTarget clears pending, or the edited selection with its hides (one undo)", () => {
  const m = model();
  m.addToTarget(sub(2));
  m.clearTarget();
  assert.equal(m.pending.entryCount, 0);
  m.undo();
  assert.equal(m.pending.entryCount, 1);
  const sel = m.commit()!;
  m.setEntryHidden(sel.id, sub(2), true);
  m.beginEdit(sel.id);
  m.clearTarget();
  assert.equal(sel.set.entryCount, 0);
  assert.ok(!m.isPointHidden(3), "individual hides cleared too");
  m.undo();
  assert.ok(sel.set.has(sub(2)) && m.isPointHidden(3), "one undo restores entries + hides");
});

test("undo of delete restores the selection with its hidden flag", () => {
  const m = model();
  m.addToTarget(sub(1));
  const sel = m.commit()!;
  m.setHidden(sel.id, true);
  m.deleteSelection(sel.id);
  assert.ok(!m.isPointHidden(2));
  m.undo();
  assert.equal(m.committed().length, 1);
  assert.ok(m.isPointHidden(2), "restored still hidden");
});
