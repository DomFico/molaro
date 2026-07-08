/**
 * Unit tests for the classification tree model and bulk-category detection.
 * Pure — no DOM, no producer. Run from viewer/: node --test tests/classification.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { bulkCategories, buildTree } from "../webview/classification.ts";

/** Build category/group/subgroup arrays for `nSub` subgroups of `perSub` points
 * each, all in one category/group. */
function repeatingCategory(nSub: number, perSub: number, cat: number, subBase: number): {
  category: number[];
  group: number[];
  subgroup: number[];
} {
  const category: number[] = [];
  const group: number[] = [];
  const subgroup: number[] = [];
  for (let s = 0; s < nSub; s++) {
    for (let k = 0; k < perSub; k++) {
      category.push(cat);
      group.push(cat);
      subgroup.push(subBase + s);
    }
  }
  return { category, group, subgroup };
}

/** Minimal Header with just the fields the classifier reads. */
function makeHeader(
  category: number[],
  group_id: number[],
  subgroup_id: number[],
  categories: string[],
): Header {
  const n = category.length;
  return {
    version: "0.1.0",
    name: "t",
    n_points: n,
    n_frames: 1,
    units: "m",
    bbox: null,
    points: { type: new Array(n).fill("x"), group_id, subgroup_id, category },
    categories,
    groups: {},
    subgroups: {},
    edges: [],
    polylines: [],
    channels: [],
  };
}

test("buildTree nests category -> group -> subgroup with counts", () => {
  // 2 categories. cat0: group0{sub0:2pts, sub1:1pt}; cat1: group1{sub2:1pt}.
  const header = makeHeader(
    [0, 0, 0, 1],
    [0, 0, 0, 1],
    [0, 0, 1, 2],
    ["polymer", "ligand"],
  );
  const tree = buildTree(header);
  assert.equal(tree.categories.length, 2);

  const c0 = tree.categories[0];
  assert.equal(c0.label, "polymer");
  assert.equal(c0.pointCount, 3);
  assert.equal(c0.groupCount, 1);
  assert.equal(c0.subgroupCount, 2);
  assert.equal(c0.bulk, false);
  assert.equal(c0.groups[0].subgroups.length, 2);
  const sub0 = c0.groups[0].subgroups.find((s) => s.subgroupId === 0);
  assert.equal(sub0?.pointCount, 2);

  const c1 = tree.categories[1];
  assert.equal(c1.pointCount, 1);
  assert.equal(c1.groups[0].groupId, 1);
});

test("bulkCategories: small solvent (tiny repeating subgroups, dominant) is bulk", () => {
  // A ~4,500-point solvent of 3-atom waters (1,500 subgroups) alongside a small
  // 300-atom / 20-residue polymer — the exact 'cage solvent' case the old
  // absolute thresholds missed. Relative heuristic must flag solvent, not polymer.
  const sol = repeatingCategory(1500, 3, 0, 0); // 4500 pts, 1500 subs, avg 3
  const poly = repeatingCategory(20, 15, 1, 10_000); // 300 pts, 20 subs, avg 15
  const header = makeHeader(
    [...sol.category, ...poly.category],
    [...sol.group, ...poly.group],
    [...sol.subgroup, ...poly.subgroup],
    ["solvent", "polymer"],
  );
  const bulk = bulkCategories(header);
  assert.ok(bulk.has(0), "small dominant tiny-subgroup solvent is bulk");
  assert.ok(!bulk.has(1), "the 20-residue polymer is not bulk");
});

test("bulkCategories: a large polymer (big residues) is never bulk even at 100%", () => {
  // Protein-only: 3,000 atoms / 200 residues => avg 15 atoms/residue. Dominant
  // (100% of points) but its units are not tiny, so it stays visible.
  const poly = repeatingCategory(200, 15, 0, 0);
  const header = makeHeader(poly.category, poly.group, poly.subgroup, ["polymer"]);
  assert.ok(!bulkCategories(header).has(0), "large-residue polymer is not bulk");
});

test("bulkCategories: never hides a tiny whole system", () => {
  // A 46-bead coarse-grained model (20 subgroups): dominant + tiny units, but
  // below the absolute floors, so it must NOT be hidden.
  const cg = repeatingCategory(20, 2, 0, 0); // 40 pts, 20 subs
  const header = makeHeader(cg.category, cg.group, cg.subgroup, ["polymer"]);
  assert.ok(!bulkCategories(header).has(0), "tiny whole system is not bulk");
});

test("buildTree degrades gracefully with no real structure", () => {
  // All points one category, one group, one subgroup — a 'no standard
  // structure' dataset must not error.
  const header = makeHeader([0, 0, 0], [0, 0, 0], [0, 0, 0], ["all"]);
  const tree = buildTree(header);
  assert.equal(tree.categories.length, 1);
  assert.equal(tree.categories[0].groups.length, 1);
  assert.equal(tree.categories[0].groups[0].subgroups.length, 1);
  assert.equal(tree.categories[0].bulk, false);
});
