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
 * Bulk-category detection — a RELATIVE/proportional heuristic (Increment 4.6),
 * replacing the earlier absolute thresholds that only fired on very large
 * systems (so a 4,500-point cage solvent stayed visible and hairballed the
 * default view). A category is "bulk" — environment to hide by default — when it
 * is BOTH:
 *   - a large fraction of the whole scene (`>= BULK_POINT_FRACTION` of all
 *     points), and
 *   - made of many small repeating units (many subgroups, each tiny on average
 *     — `avg points/subgroup <= BULK_MAX_AVG_SUBGROUP_SIZE`).
 * Two small absolute floors keep it from ever hiding a tiny *whole* system (a
 * 46-bead coarse-grained model is the entire structure, not environment).
 *
 * This catches solvent/water/lipid-tail environments at any scale (a 143k-atom
 * membrane solvent AND a 4,500-atom cage solvent) while never flagging a
 * structured polymer: a protein is a large fraction of points but its residues
 * average ~8–15 atoms each — above the tiny-unit bar — so it stays visible.
 */
export const BULK_POINT_FRACTION = 0.3;
export const BULK_MAX_AVG_SUBGROUP_SIZE = 12;
export const BULK_MIN_POINTS = 500; // floor: never hide a tiny whole system
export const BULK_MIN_SUBGROUPS = 50; // floor: must be many repeating units

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

/** Indices of the categories judged "bulk" for this header (see the heuristic
 * documented on the constants above). */
export function bulkCategories(header: Header): Set<number> {
  const bulk = new Set<number>();
  const nCat = header.categories.length;
  const points = header.points.category;
  const subgroups = header.points.subgroup_id;
  const total = points.length;
  if (total === 0) return bulk;
  const pointCount = new Array<number>(nCat).fill(0);
  const subSets: Array<Set<number>> = Array.from({ length: nCat }, () => new Set<number>());
  for (let p = 0; p < points.length; p++) {
    const c = points[p];
    pointCount[c]++;
    subSets[c].add(subgroups[p]);
  }
  for (let c = 0; c < nCat; c++) {
    const pts = pointCount[c];
    const subCount = subSets[c].size;
    if (subCount === 0) continue;
    const avgSubgroupSize = pts / subCount;
    const fraction = pts / total;
    if (
      pts >= BULK_MIN_POINTS &&
      subCount >= BULK_MIN_SUBGROUPS &&
      fraction >= BULK_POINT_FRACTION &&
      avgSubgroupSize <= BULK_MAX_AVG_SUBGROUP_SIZE
    ) {
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
