/**
 * Classification tree model — pure, no DOM, no Three.js (unit-testable in Node).
 *
 * Turns the contract's per-point attributes (category / group_id / subgroup_id)
 * into the hierarchical model the sidebar renders: category -> group -> subgroup.
 *
 * The load-bearing decision here is **bulk-category collapse**. Some categories
 * (solvent, environment) hold tens of thousands of points spread over thousands
 * of subgroups; enumerating them floods and slows the tree and tells the user
 * nothing. Such categories are flagged `bulk` from a client-side cardinality
 * threshold (no contract change) and are meant to be shown as a single summary
 * row, never enumerated by default. The threshold is deliberately conservative
 * (both many points AND many subgroups) so a structured-but-large category — a
 * protein with a few hundred residues — is *not* mistaken for bulk.
 */
import type { Header } from "../contract/contract.ts";

/**
 * A category is "bulk" only if it is large on BOTH axes: many points AND many
 * subgroups. Solvent/environment has ~one subgroup (residue) per few atoms, so
 * it runs to thousands of subgroups; even a large multi-chain protein rarely
 * exceeds ~2000 residues. Keeping the subgroup bar high therefore hides bulk
 * water while leaving the structured polymer visible (verified: on a 222k-atom
 * membrane system, solvent's 14,300 subgroups are bulk but the 1,472-residue
 * polymer is not).
 */
export const BULK_POINT_THRESHOLD = 5_000;
export const BULK_SUBGROUP_THRESHOLD = 2_000;

export interface SubgroupNode {
  subgroupId: number;
  label: string;
  pointCount: number;
}

export interface GroupNode {
  groupId: number;
  label: string;
  pointCount: number;
  subgroups: SubgroupNode[];
}

export interface CategoryNode {
  categoryIndex: number;
  label: string;
  pointCount: number;
  subgroupCount: number;
  groupCount: number;
  bulk: boolean;
  /** Full group->subgroup subtree. Present for every category (bulk included),
   * but the sidebar renders bulk categories as a summary and never expands the
   * whole subtree by default. */
  groups: GroupNode[];
}

export interface TreeModel {
  categories: CategoryNode[];
}

/** Indices of the categories judged "bulk" for this header. */
export function bulkCategories(header: Header): Set<number> {
  const bulk = new Set<number>();
  const nCat = header.categories.length;
  const points = header.points.category;
  const subgroups = header.points.subgroup_id;
  const pointCount = new Array<number>(nCat).fill(0);
  const subSets: Array<Set<number>> = Array.from({ length: nCat }, () => new Set<number>());
  for (let p = 0; p < points.length; p++) {
    const c = points[p];
    pointCount[c]++;
    subSets[c].add(subgroups[p]);
  }
  for (let c = 0; c < nCat; c++) {
    if (pointCount[c] > BULK_POINT_THRESHOLD && subSets[c].size > BULK_SUBGROUP_THRESHOLD) {
      bulk.add(c);
    }
  }
  return bulk;
}

/**
 * Build the full category -> group -> subgroup model in one pass over points.
 * O(n_points). Subgroup order within a group and group order within a category
 * follow first-appearance, so the tree is stable and mirrors the data layout.
 */
export function buildTree(header: Header): TreeModel {
  const nCat = header.categories.length;
  const cat = header.points.category;
  const gid = header.points.group_id;
  const sid = header.points.subgroup_id;
  const bulk = bulkCategories(header);

  // Aggregation keyed by composite ids, built lazily as points are scanned.
  interface GroupAgg {
    groupId: number;
    pointCount: number;
    subs: Map<number, SubgroupNode>;
    order: number;
  }
  interface CatAgg {
    pointCount: number;
    groups: Map<number, GroupAgg>;
    order: number;
  }
  const cats = new Map<number, CatAgg>();

  for (let p = 0; p < cat.length; p++) {
    const c = cat[p];
    let ca = cats.get(c);
    if (!ca) {
      ca = { pointCount: 0, groups: new Map(), order: cats.size };
      cats.set(c, ca);
    }
    ca.pointCount++;
    const g = gid[p];
    let ga = ca.groups.get(g);
    if (!ga) {
      ga = { groupId: g, pointCount: 0, subs: new Map(), order: ca.groups.size };
      ca.groups.set(g, ga);
    }
    ga.pointCount++;
    const s = sid[p];
    let sn = ga.subs.get(s);
    if (!sn) {
      sn = { subgroupId: s, label: subgroupLabel(header, s), pointCount: 0 };
      ga.subs.set(s, sn);
    }
    sn.pointCount++;
  }

  const categories: CategoryNode[] = [];
  for (const [c, ca] of cats) {
    const groups: GroupNode[] = [];
    let subgroupCount = 0;
    for (const ga of [...ca.groups.values()].sort((a, b) => a.order - b.order)) {
      const subs = [...ga.subs.values()];
      subgroupCount += subs.length;
      groups.push({
        groupId: ga.groupId,
        label: groupLabel(header, ga.groupId),
        pointCount: ga.pointCount,
        subgroups: subs,
      });
    }
    categories.push({
      categoryIndex: c,
      label: header.categories[c] ?? `category-${c}`,
      pointCount: ca.pointCount,
      subgroupCount,
      groupCount: groups.length,
      bulk: bulk.has(c),
      groups,
    });
  }
  categories.sort((a, b) => a.categoryIndex - b.categoryIndex);
  return { categories };
}

function groupLabel(header: Header, groupId: number): string {
  return header.groups?.[String(groupId)] ?? `group ${groupId}`;
}

function subgroupLabel(header: Header, subgroupId: number): string {
  return header.subgroups?.[String(subgroupId)] ?? `subgroup ${subgroupId}`;
}
