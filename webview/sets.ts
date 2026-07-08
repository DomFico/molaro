/**
 * Persistent selection & hidden sets — the first-class, addressable state the
 * whole interaction model (and a future agent-driven layer) points at.
 *
 * Two independent `NodeSet`s (a selection set and a hidden set) each hold
 * ENTRIES. An entry references a node at ANY level of the hierarchy — a
 * `category`, `group`, `subgroup`, or individual `point`. Entries are what the
 * user sees and removes at the granularity they clicked (hiding a whole category
 * is ONE entry, not thousands). Each set also resolves to a POINT set — the union
 * of points its entries cover — which is what rendering (and later the agent)
 * consumes.
 *
 * Resolution is reference-counted and INCREMENTAL: `count[p]` is how many entries
 * cover point p, so adding/removing an entry only touches that entry's points and
 * a point is covered iff `count[p] > 0`. Mutators return the affected point
 * indices so the renderer can flip just those bits (smooth at N≈250k). The sets
 * are pure state — no DOM, no Three.js — and unit-tested directly.
 */
import type { Header } from "../contract/contract.ts";

export type EntryLevel = "category" | "group" | "subgroup" | "point";

export interface Entry {
  level: EntryLevel;
  id: number; // category index / group id / subgroup id / point index
}

export function entryKey(e: Entry): string {
  return `${e.level}:${e.id}`;
}

/** Membership maps + labels for the four hierarchy levels, built once. */
export class Hierarchy {
  readonly n: number;
  private readonly byCategory = new Map<number, number[]>();
  private readonly byGroup = new Map<number, number[]>();
  private readonly bySubgroup = new Map<number, number[]>();
  private readonly header: Header;

  constructor(header: Header) {
    this.header = header;
    this.n = header.n_points;
    const { category, group_id, subgroup_id } = header.points;
    for (let p = 0; p < this.n; p++) {
      push(this.byCategory, category[p], p);
      push(this.byGroup, group_id[p], p);
      push(this.bySubgroup, subgroup_id[p], p);
    }
  }

  /** Point indices covered by an entry. */
  pointsOf(e: Entry): number[] {
    switch (e.level) {
      case "category":
        return this.byCategory.get(e.id) ?? [];
      case "group":
        return this.byGroup.get(e.id) ?? [];
      case "subgroup":
        return this.bySubgroup.get(e.id) ?? [];
      case "point":
        return e.id >= 0 && e.id < this.n ? [e.id] : [];
    }
  }

  pointCount(e: Entry): number {
    if (e.level === "point") return e.id >= 0 && e.id < this.n ? 1 : 0;
    return this.pointsOf(e).length;
  }

  /** Points of a subgroup (for the tree's drill-to-points level). */
  subgroupPoints(subgroupId: number): number[] {
    return this.bySubgroup.get(subgroupId) ?? [];
  }

  label(e: Entry): string {
    const h = this.header;
    switch (e.level) {
      case "category":
        return h.categories[e.id] ?? `category ${e.id}`;
      case "group":
        return h.groups?.[String(e.id)] ?? `group ${e.id}`;
      case "subgroup":
        return h.subgroups?.[String(e.id)] ?? `subgroup ${e.id}`;
      case "point": {
        const t = h.points.type[e.id];
        return t ? `${t} #${e.id}` : `point #${e.id}`;
      }
    }
  }
}

export type SetKind = "selection" | "hidden";

/**
 * One persistent set of entries with a reference-counted resolved point set.
 * Mutators return the point indices they touched (or null when a no-op) so the
 * caller can update render buffers incrementally; `onChange` fires for UI.
 */
export class NodeSet {
  readonly kind: SetKind;
  private readonly hierarchy: Hierarchy;
  private readonly countArr: Uint32Array; // per-point entry coverage count
  private covered = 0; // number of points with count > 0
  private readonly entries = new Map<string, Entry>(); // insertion-ordered
  private readonly listeners = new Set<() => void>();

  constructor(hierarchy: Hierarchy, kind: SetKind) {
    this.hierarchy = hierarchy;
    this.kind = kind;
    this.countArr = new Uint32Array(hierarchy.n);
  }

  has(e: Entry): boolean {
    return this.entries.has(entryKey(e));
  }
  contains(point: number): boolean {
    return this.countArr[point] > 0;
  }
  listEntries(): Entry[] {
    return [...this.entries.values()];
  }
  get entryCount(): number {
    return this.entries.size;
  }
  /** Number of resolved points (size of the union). */
  get pointCount(): number {
    return this.covered;
  }

  /** All resolved point indices (O(N) scan; for occasional consumers like zoom). */
  resolvedPoints(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.countArr.length; p++) if (this.countArr[p] > 0) out.push(p);
    return out;
  }

  private addSilent(e: Entry): number[] | null {
    const key = entryKey(e);
    if (this.entries.has(key)) return null;
    this.entries.set(key, e);
    const pts = this.hierarchy.pointsOf(e);
    for (const p of pts) {
      if (this.countArr[p] === 0) this.covered++;
      this.countArr[p]++;
    }
    return pts;
  }
  private removeSilent(e: Entry): number[] | null {
    const key = entryKey(e);
    if (!this.entries.has(key)) return null;
    this.entries.delete(key);
    const pts = this.hierarchy.pointsOf(e);
    for (const p of pts) {
      this.countArr[p]--;
      if (this.countArr[p] === 0) this.covered--;
    }
    return pts;
  }

  add(e: Entry): number[] | null {
    const pts = this.addSilent(e);
    if (pts) this.emit();
    return pts;
  }
  remove(e: Entry): number[] | null {
    const pts = this.removeSilent(e);
    if (pts) this.emit();
    return pts;
  }
  /** Toggle membership; returns the affected points (never null). */
  toggle(e: Entry): number[] {
    const pts = this.has(e) ? this.removeSilent(e) : this.addSilent(e);
    this.emit();
    return pts ?? [];
  }
  /** Add many entries (skipping ones already present); one change event. */
  addMany(list: Entry[]): number[] {
    const affected: number[] = [];
    for (const e of list) {
      const pts = this.addSilent(e);
      if (pts) affected.push(...pts);
    }
    this.emit();
    return affected;
  }
  /** Replace the whole set with `list` (single event); returns union of removed+added points. */
  replaceWith(list: Entry[]): number[] {
    const affected = this.clearSilent();
    for (const e of list) {
      const pts = this.addSilent(e);
      if (pts) affected.push(...pts);
    }
    this.emit();
    return affected;
  }
  clear(): number[] {
    const affected = this.clearSilent();
    this.emit();
    return affected;
  }
  private clearSilent(): number[] {
    const affected: number[] = [];
    for (let p = 0; p < this.countArr.length; p++) if (this.countArr[p] > 0) affected.push(p);
    this.countArr.fill(0);
    this.covered = 0;
    this.entries.clear();
    return affected;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
