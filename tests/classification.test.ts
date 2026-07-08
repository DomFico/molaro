/**
 * Unit tests for the classification tree model and bulk-category detection.
 * Pure — no DOM, no producer. Run from viewer/: node --test tests/classification.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import {
  BULK_POINT_THRESHOLD,
  BULK_SUBGROUP_THRESHOLD,
  bulkCategories,
  buildTree,
} from "../webview/classification.ts";

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

test("bulkCategories fires only when a category is large on BOTH axes", () => {
  const n = BULK_POINT_THRESHOLD + BULK_SUBGROUP_THRESHOLD + 10;
  const category: number[] = [];
  const group: number[] = [];
  const subgroup: number[] = [];
  // cat0 "solvent": many points, each its own subgroup -> bulk on both axes.
  for (let i = 0; i < n; i++) {
    category.push(0);
    group.push(0);
    subgroup.push(i); // one subgroup per point -> subgroupCount == n
  }
  // cat1 "protein": many points but few subgroups -> NOT bulk (few subgroups).
  for (let i = 0; i < BULK_POINT_THRESHOLD + 100; i++) {
    category.push(1);
    group.push(1);
    subgroup.push(1_000_000 + (i % 50)); // only 50 subgroups
  }
  const header = makeHeader(category, group, subgroup, ["solvent", "protein"]);

  const bulk = bulkCategories(header);
  assert.ok(bulk.has(0), "solvent (many pts + many subgroups) is bulk");
  assert.ok(!bulk.has(1), "protein (many pts, few subgroups) is not bulk");

  const tree = buildTree(header);
  assert.equal(tree.categories.find((c) => c.categoryIndex === 0)?.bulk, true);
  assert.equal(tree.categories.find((c) => c.categoryIndex === 1)?.bulk, false);
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
