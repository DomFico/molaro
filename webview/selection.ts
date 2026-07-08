/**
 * Selection layer — the ephemeral "what is the user pointing at right now".
 *
 * This is the first-class, stateful substrate a future agent-driven layer will
 * act on ("select the points matching predicate X"), so it is intentionally
 * rich: a selection is a set of point indices plus a descriptor of what was
 * picked (a point, a subgroup, a group, or a whole category) and an optional
 * neighbor set.
 *
 * It is ORTHOGONAL to the representation layer: selection never mutates per-point
 * color/size/visibility. The renderer draws it as a highlight OVERLAY on top of
 * whatever the representation layer produced (see main.ts). A wholesale recolor
 * of the base representation would not touch a single field here, and vice
 * versa.
 *
 * The store is the single source of truth both the 3D view and the sidebar tree
 * subscribe to, so selecting in one is reflected in the other with no
 * cross-surface messaging.
 */
import type { Header } from "../contract/contract.ts";

export type SelectionKind = "none" | "point" | "subgroup" | "group" | "category";

export interface SelectionDescriptor {
  kind: SelectionKind;
  /** point index (point), subgroup id, group id, or category index. */
  id: number;
  label: string;
}

export interface SelectionSnapshot {
  descriptor: SelectionDescriptor;
  /** Primary selected point indices (sorted). */
  indices: number[];
  /** Neighboring subgroup ids highlighted alongside the selection (may be empty). */
  neighborSubgroups: number[];
  /** Point indices of the neighbor subgroups (sorted). */
  neighborIndices: number[];
}

/** Computes spatially-nearby subgroups for a selection; injected by main.ts
 * because it needs live positions. Returns [] when unavailable/disabled. */
export type NeighborProvider = (selectedIndices: number[], selfSubgroups: Set<number>) => {
  subgroups: number[];
  indices: number[];
};

const EMPTY: SelectionSnapshot = {
  descriptor: { kind: "none", id: -1, label: "" },
  indices: [],
  neighborSubgroups: [],
  neighborIndices: [],
};

export class SelectionStore {
  private snapshot: SelectionSnapshot = EMPTY;
  private readonly listeners = new Set<(s: SelectionSnapshot) => void>();
  private neighborProvider: NeighborProvider | null = null;

  // Precomputed membership (built once from the header).
  private readonly bySubgroup = new Map<number, number[]>();
  private readonly byGroup = new Map<number, number[]>();
  private readonly byCategory = new Map<number, number[]>();
  private readonly subgroupOfPoint: number[];
  private readonly header: Header;

  constructor(header: Header) {
    this.header = header;
    this.subgroupOfPoint = header.points.subgroup_id;
    const { subgroup_id, group_id, category } = header.points;
    for (let p = 0; p < header.n_points; p++) {
      push(this.bySubgroup, subgroup_id[p], p);
      push(this.byGroup, group_id[p], p);
      push(this.byCategory, category[p], p);
    }
  }

  get current(): SelectionSnapshot {
    return this.snapshot;
  }

  subscribe(fn: (s: SelectionSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  setNeighborProvider(fn: NeighborProvider | null): void {
    this.neighborProvider = fn;
  }

  // -- selection setters ------------------------------------------------------

  selectPoint(point: number): void {
    if (point < 0 || point >= this.header.n_points) {
      this.clear();
      return;
    }
    // A single 3D click selects the point's subgroup — the natural granularity
    // that also lines up with the sidebar's subgroup rows.
    this.selectSubgroup(this.subgroupOfPoint[point]);
  }

  selectSubgroup(subgroupId: number): void {
    const indices = this.bySubgroup.get(subgroupId) ?? [];
    this.commit(
      { kind: "subgroup", id: subgroupId, label: subgroupLabel(this.header, subgroupId) },
      indices,
      new Set([subgroupId]),
    );
  }

  selectGroup(groupId: number): void {
    const indices = this.byGroup.get(groupId) ?? [];
    const subs = new Set<number>();
    for (const p of indices) subs.add(this.subgroupOfPoint[p]);
    this.commit(
      { kind: "group", id: groupId, label: groupLabel(this.header, groupId) },
      indices,
      subs,
    );
  }

  selectCategory(categoryIndex: number): void {
    const indices = this.byCategory.get(categoryIndex) ?? [];
    const subs = new Set<number>();
    for (const p of indices) subs.add(this.subgroupOfPoint[p]);
    this.commit(
      {
        kind: "category",
        id: categoryIndex,
        label: this.header.categories[categoryIndex] ?? `category-${categoryIndex}`,
      },
      indices,
      subs,
    );
  }

  clear(): void {
    if (this.snapshot.descriptor.kind === "none") return;
    this.snapshot = EMPTY;
    this.emit();
  }

  /** Point indices of a subgroup (for zoom-to-selection / neighbor math). */
  subgroupIndices(subgroupId: number): number[] {
    return this.bySubgroup.get(subgroupId) ?? [];
  }

  // -- internals --------------------------------------------------------------

  private commit(
    descriptor: SelectionDescriptor,
    indices: number[],
    selfSubgroups: Set<number>,
  ): void {
    let neighborSubgroups: number[] = [];
    let neighborIndices: number[] = [];
    if (this.neighborProvider && indices.length > 0) {
      const r = this.neighborProvider(indices, selfSubgroups);
      neighborSubgroups = r.subgroups;
      neighborIndices = r.indices;
    }
    this.snapshot = { descriptor, indices, neighborSubgroups, neighborIndices };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.snapshot);
  }
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function groupLabel(header: Header, groupId: number): string {
  return header.groups?.[String(groupId)] ?? `group ${groupId}`;
}

function subgroupLabel(header: Header, subgroupId: number): string {
  return header.subgroups?.[String(subgroupId)] ?? `subgroup ${subgroupId}`;
}
