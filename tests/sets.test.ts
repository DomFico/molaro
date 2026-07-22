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

test("compareEntries orders entries the way the full hierarchy renders", () => {
  const h = new Hierarchy(makeHeader());
  // insertion order deliberately scrambled
  const scrambled: Entry[] = [pt(4), sub(1), cat(1), pt(1), sub(0), grp(1), cat(0)];
  const sorted = [...scrambled].sort((a, b) => h.compareEntries(a, b));
  assert.deepEqual(
    sorted,
    [cat(0), sub(0), pt(1), sub(1), cat(1), grp(1), pt(4)],
    "category before its descendants, siblings in tree order, points by index",
  );
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

test("show wins: a selection inside a hidden region shows its points", () => {
  const m = model();
  m.addToTarget(cat(0)); // {0,1,2}
  const broad = m.commit()!;
  m.setHidden(broad.id, true);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(2));
  m.addToTarget(sub(0)); // {0,1} inside the hidden region
  const inner = m.commit()!;
  assert.ok(!m.isPointHidden(0) && !m.isPointHidden(1), "visible selection shows its points");
  assert.ok(m.isPointHidden(2), "uncovered remainder stays hidden");
  m.setHidden(inner.id, true);
  assert.ok(m.isPointHidden(0), "hiding the inner one too hides everything");
  m.setHidden(inner.id, false);
  const affected = m.deleteSelection(inner.id);
  assert.ok(m.isPointHidden(0) && m.isPointHidden(1), "delete resurfaces the broad hide");
  assert.deepEqual(affected.sort(), [0, 1], "all covered points reported on delete");
});

test("show wins: an OLDER fine selection survives a NEWER broad hide", () => {
  const m = model();
  m.addToTarget(sub(0)); // {0,1} — the lowest-level selection, made FIRST
  const fine = m.commit()!;
  m.addToTarget(cat(0)); // {0,1,2} — then the entire thing
  const broad = m.commit()!;
  m.setHidden(broad.id, true);
  assert.ok(!m.isPointHidden(0) && !m.isPointHidden(1),
    "the first selection stays visible by virtue of being a selection");
  assert.ok(m.isPointHidden(2), "the rest of the broad selection hides");
  m.setHidden(fine.id, true); // hide it explicitly and everything goes
  assert.ok(m.isPointHidden(0) && m.isPointHidden(1));
  assert.ok(!fine.hidden === false && !broad.hidden === false);
});

test("show wins: another visible selection defeats a part-hide of the same points", () => {
  const m = model();
  m.addToTarget(sub(0));
  m.addToTarget(sub(1));
  const a = m.commit()!; // {0,1,2}
  m.setEntryHidden(a.id, sub(0), true);
  assert.ok(m.isPointHidden(0), "part-hide works while only one selection covers");
  m.addToTarget(sub(0));
  m.commit(); // a second, visible selection over the same points
  assert.ok(!m.isPointHidden(0), "the visible selection shows them");
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

// -- entryIntersects: the point-set row matching behind command flash-parity --

test("entryIntersects: any level vs a resolved point set (early-exit scan)", () => {
  const h = new Hierarchy(makeHeader());
  const set = new Set([1, 4]); // one point under sub0/grp0/cat0, one under sub2/grp1/cat1
  assert.ok(h.entryIntersects(pt(1), set));
  assert.ok(!h.entryIntersects(pt(0), set));
  assert.ok(h.entryIntersects(sub(0), set)); // {0,1} ∋ 1
  assert.ok(!h.entryIntersects(sub(1), set)); // {2}
  assert.ok(h.entryIntersects(grp(1), set)); // {3,4,5} ∋ 4
  assert.ok(h.entryIntersects(cat(0), set) && h.entryIntersects(cat(1), set));
  assert.ok(!h.entryIntersects(cat(0), new Set<number>())); // empty set matches nothing
});

test("point-set row selection: rows chosen to flash = rows intersecting the set", () => {
  // a mounted-row simulation across every level; a MULTI-LEVEL resolved set
  // (a whole subgroup's points + one stray point) selects exactly the rows
  // whose coverage intersects — entry identity plays no part
  const h = new Hierarchy(makeHeader());
  const mounted: Entry[] = [cat(0), cat(1), grp(0), grp(1), sub(0), sub(1), sub(2), pt(0), pt(2), pt(5)];
  const resolved = new Set([...h.pointsOf(sub(0)), 5]); // {0,1} ∪ {5}
  const flashed = mounted.filter((e) => h.entryIntersects(e, resolved));
  assert.deepEqual(
    flashed.map((e) => entryKey(e)),
    ["category:0", "category:1", "group:0", "group:1", "subgroup:0", "subgroup:2", "point:0", "point:5"],
    "sub(1) {2} and pt(2) don't intersect; everything covering 0,1,5 does",
  );
});

test("REVERSED: setEntryHidden refuses entries inside a coarse member (members only)", () => {
  // a briefly-wider rule accepted covered entries; it let commands create
  // sub-member hidden state the UI could not display or clear — reversed
  const m = model();
  m.addToTarget(cat(0)); // {0,1,2} stored as ONE coarse entry
  const sel = m.commit()!;
  assert.deepEqual(m.setEntryHidden(sel.id, pt(1), true), [],
    "a point INSIDE the member is not a member — refused");
  assert.ok(!m.isPointHidden(1), "no state was created");
  assert.deepEqual(m.setEntryHidden(sel.id, pt(4), true), [], "outside the selection: refused");
  assert.ok(m.setEntryHidden(sel.id, cat(0), true).length === 3, "the MEMBER itself hides fine");
});

test("clearAllHidden clears the whole flag AND member hides as one undo op", () => {
  // fine members (points committed as members) — the ONLY way to hide a
  // point-subset is to have committed it at that granularity
  const m = model();
  m.addToTarget(pt(3));
  m.addToTarget(pt(4));
  const sel = m.commit()!;
  m.setHidden(sel.id, true);
  m.setEntryHidden(sel.id, pt(4), true); // a stored point MEMBER
  const depth = m.undoDepth;
  m.clearAllHidden(sel.id);
  assert.ok(!sel.hidden && sel.hiddenPart.entryCount === 0);
  assert.ok(!m.isPointHidden(3) && !m.isPointHidden(4));
  assert.equal(m.undoDepth, depth + 1, "one undo op");
  m.undo();
  assert.ok(sel.hidden && m.isPointHidden(4), "undo restores flag + member together");
});

// -- the LIFO invariant commit() rests on ------------------------------------
//
// commit()'s undo closure does NOT capture the post-commit pending set. It reads
// `this.pendingSet` LIVE at undo time and swaps the pre-commit set back in,
// justified by a comment: "LIFO undo has already reverted anything done to the
// interim pending set". Later ops in the same session capture that interim object
// BY REFERENCE, so if the justification ever stopped holding, undo would restore a
// selection while silently losing the pending footprint — with nothing failing.
//
// It holds today, and these pin why: strict LIFO means every op recorded after the
// commit is undone BEFORE it, and nothing mutates the pending set without
// recording. Written now because the claim was load-bearing and unguarded, and
// because a redo stack — which replays forward — is exactly what would break it.

test("commit(): LIFO empties the interim pending set before the commit's own undo runs", () => {
  const m = model();
  m.addToTarget(sub(0));
  const before = m.pending.resolvedPoints().slice().sort();
  m.commit();
  m.addToTarget(sub(1));
  m.addToTarget(sub(2));
  m.undo();
  m.undo();
  assert.equal(m.pending.entryCount, 0, "the interim set is empty by the time commit's undo reads it");
  m.undo();
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), before,
    "undoing the commit restores the ORIGINAL pending set, not a fresh empty one");
  assert.equal(m.committed().length, 0);
});

test("commit(): stacked commits chain their pending swaps correctly", () => {
  const m = model();
  m.addToTarget(sub(0));
  const p1 = m.pending.resolvedPoints().slice().sort();
  m.commit();
  m.addToTarget(sub(1));
  const p2 = m.pending.resolvedPoints().slice().sort();
  m.commit();
  m.addToTarget(sub(2));
  m.undo();                                   // the third set's mutation
  m.undo();                                   // commit #2 → pending must be the second set
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), p2);
  m.undo();                                   // the second set's mutation
  m.undo();                                   // commit #1 → pending must be the first set
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), p1);
});

test("seed() records nothing and never touches the pending set", () => {
  // The one candidate for an UNRECORDED pending mutation, which would put a
  // change outside LIFO's reach and invalidate commit()'s justification.
  const m = model();
  m.addToTarget(sub(0));
  const depth = m.undoDepth;
  const pendingBefore = m.pending.resolvedPoints().slice().sort();
  m.seed("prefab", [sub(1)]);
  assert.equal(m.undoDepth, depth, "seed is initial state, not an undoable op");
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), pendingBefore,
    "seed builds its own set — it must not disturb the pending one");
});

// -- redo -----------------------------------------------------------------------

test("redo re-applies the last undone op and moves it back to the undo stack", () => {
  const m = model();
  m.addToTarget(sub(0));
  const after = m.pending.resolvedPoints().slice().sort();
  m.undo();
  assert.equal(m.pending.entryCount, 0);
  assert.equal(m.redoDepth, 1, "the undone op is retained, not discarded");
  m.redo();
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), after);
  assert.equal(m.redoDepth, 0);
  assert.equal(m.undoDepth, 1, "redone ops go back where they came from");
});

test("undo → redo returns a byte-identical prior state across every selection op", () => {
  // Walk a session all the way down and all the way back up; the fingerprint at
  // each depth on the way up must equal the one at the same depth on the way down.
  const m = model();
  const shot = (): string => JSON.stringify({
    pending: m.pending.resolvedPoints().slice().sort(),
    committed: m.committed().map((c) => [c.name, c.hidden, c.set.resolvedPoints().slice().sort()]),
  });
  const down: string[] = [shot()];
  m.addToTarget(sub(0)); down.push(shot());
  m.addToTarget(sub(1)); down.push(shot());
  m.commit();           down.push(shot());
  m.addToTarget(sub(2)); down.push(shot());
  m.setHidden(m.committed()[0].id, true); down.push(shot());
  m.rename(m.committed()[0].id, "renamed"); down.push(shot());
  const depth = m.undoDepth;
  for (let i = 0; i < depth; i++) m.undo();
  assert.equal(shot(), down[0], "undoing everything returns the starting state");
  for (let i = 0; i < depth; i++) {
    m.redo();
    assert.equal(shot(), down[i + 1], `redo step ${i + 1} must reproduce the state exactly`);
  }
});

test("undo → new op → redo does NOTHING (the redo stack is invalidated)", () => {
  const m = model();
  m.addToTarget(sub(0));
  m.undo();
  assert.equal(m.redoDepth, 1);
  m.addToTarget(sub(1));                       // a NEW op after the undo
  assert.equal(m.redoDepth, 0, "the walked-back future is unreachable now");
  const after = m.pending.resolvedPoints().slice().sort();
  assert.equal(m.redo(), null, "redo reports there is nothing to do");
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), after, "…and changes nothing");
});

test("undo → new COMPOUND op → redo does nothing — the case a pushUndo-only hook would miss", () => {
  // endStroke used to push straight onto the stack, bypassing pushUndo. A redo
  // hook installed only in pushUndo would therefore have failed to invalidate for
  // paint drags, create_sele, hide batches and every commands macro — the most
  // common mutations there are. This is that exact shape.
  const m = model();
  m.addToTarget(sub(0));
  m.undo();
  assert.equal(m.redoDepth, 1);
  m.beginStroke();
  m.addToTarget(sub(1));
  m.addToTarget(sub(2));
  m.endStroke();
  assert.equal(m.redoDepth, 0, "a compound stroke invalidates the redo stack like any other op");
  assert.equal(m.redo(), null);
});

test("a compound stroke redoes as ONE entry, forward in recording order", () => {
  const m = model();
  m.beginStroke();
  m.addToTarget(sub(0));
  m.addToTarget(sub(1));
  m.addToTarget(sub(2));
  m.endStroke();
  const after = m.pending.resolvedPoints().slice().sort();
  assert.equal(m.undoDepth, 1, "three ops, one entry");
  m.undo();
  assert.equal(m.pending.entryCount, 0);
  m.redo();
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), after);
  assert.equal(m.undoDepth, 1);
});

test("redo of a commit reuses the SAME interim pending set later ops captured", () => {
  // The Item B failure, as a test. A redo that installed a fresh pending set would
  // leave the trailing op mutating an orphan: the selection would come back and
  // the pending footprint would silently not.
  const m = model();
  m.addToTarget(sub(0));
  m.commit();
  m.addToTarget(sub(1));                       // captures the INTERIM set by reference
  const pendingAfter = m.pending.resolvedPoints().slice().sort();
  m.undo();                                    // the trailing add
  m.undo();                                    // the commit
  m.redo();                                    // the commit
  m.redo();                                    // the trailing add
  assert.equal(m.committed().length, 1, "the selection is back");
  assert.deepEqual(m.pending.resolvedPoints().slice().sort(), pendingAfter,
    "and so is the pending footprint — the trailing op found the set it captured");
});

test("redo is refused while a stroke is open rather than interleaving with a live edit", () => {
  const m = model();
  m.addToTarget(sub(0));
  m.undo();
  m.beginStroke();
  m.addToTarget(sub(1));
  assert.equal(m.redo(), null, "an in-flight mutation is not a place to replay into");
  m.endStroke();
});

test("dropRedo refuses the future and says why, without touching undo", () => {
  const m = model();
  m.addToTarget(sub(0));
  m.addToTarget(sub(1));
  m.undo();
  assert.equal(m.redoDepth, 1);
  m.dropRedo("the values those ops read were replaced");
  assert.equal(m.redoDepth, 0);
  assert.equal(m.redo(), null, "the walked-back future is gone");
  assert.match(m.redoBlockedReason ?? "", /replaced/, "and the refusal can say why");
  assert.equal(m.undoDepth, 1, "undo is untouched — only the forward direction is refused");
  m.undo();
  assert.equal(m.redoBlockedReason, null, "a fresh future clears the spent refusal");
  assert.equal(m.redoDepth, 1);
});

test("dropRedo on an empty redo stack sets no reason (nothing was refused)", () => {
  const m = model();
  m.addToTarget(sub(0));
  m.dropRedo("irrelevant");
  assert.equal(m.redoBlockedReason, null, "a refusal message with nothing to refuse would be noise");
});

test("the stack cap trims the OLDEST heavy entries and never below the floor", () => {
  const m = model();
  // Each op declares 8 MB retained; the budget is 64 MB with a 20-entry floor.
  const heavy = 8 * 1024 * 1024;
  for (let i = 0; i < 30; i++) m.recordOp(() => [], () => [], heavy);
  assert.equal(m.undoDepth, 20, "trimmed to the entry floor, not below it");
  // Light ops are not trimmed: the budget is bytes, not entries.
  const light = model();
  for (let i = 0; i < 200; i++) light.recordOp(() => [], () => []);
  assert.equal(light.undoDepth, 200, "a byte budget must not punish cheap history");
});

test("eviction does not corrupt what remains: surviving ops still undo/redo exactly", () => {
  // The E2E lane cannot reach this. Its scenes are 6000 points, so a full-scene
  // representation write retains ~141 KB and it would take ~466 of them to cross
  // the 64 MB budget — no scenario does that. Eviction is therefore a
  // SIZE-DEPENDENT path: unexercised on small data, reachable on large. This is
  // the unit-level stand-in.
  const m = model();
  const heavy = 8 * 1024 * 1024;
  const fired: number[] = [];
  for (let i = 0; i < 30; i++) m.recordOp(() => { fired.push(-i); return []; }, () => { fired.push(i); return []; }, heavy);
  assert.equal(m.undoDepth, 20, "trimmed to the floor");
  // The SURVIVORS are the newest 20 (indices 10..29) — walk them all back and forward.
  for (let i = 0; i < 20; i++) m.undo();
  assert.equal(m.undoDepth, 0);
  assert.equal(m.redoDepth, 20, "every survivor is redoable");
  assert.deepEqual(fired.slice(0, 20), [-29, -28, -27, -26, -25, -24, -23, -22, -21, -20,
    -19, -18, -17, -16, -15, -14, -13, -12, -11, -10],
    "newest-first on the way down, and the evicted oldest ten never ran");
  fired.length = 0;
  for (let i = 0; i < 20; i++) m.redo();
  assert.deepEqual(fired, [10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
    "and oldest-first on the way back up, in the order they were recorded");
  assert.equal(m.undoDepth, 20);
});

test("an evicted op is unreachable, not silently re-run", () => {
  const m = model();
  const heavy = 8 * 1024 * 1024;
  let evictedRan = false;
  m.recordOp(() => { evictedRan = true; return []; }, () => { evictedRan = true; return []; }, heavy);
  for (let i = 0; i < 30; i++) m.recordOp(() => [], () => [], heavy);
  while (m.canUndo) m.undo();
  while (m.canRedo) m.redo();
  assert.equal(evictedRan, false,
    "the dropped op must be gone entirely — a half-present op is worse than an absent one");
});
