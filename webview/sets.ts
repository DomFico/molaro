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
  private readonly subOfPoint: ReadonlyArray<number>;
  private readonly ancestorOfSub = new Map<number, { category: number; group: number }>();
  private readonly catOfGroup = new Map<number, number>();
  private readonly header: Header;

  constructor(header: Header) {
    this.header = header;
    this.n = header.n_points;
    const { category, group_id, subgroup_id } = header.points;
    this.subOfPoint = subgroup_id;
    for (let p = 0; p < this.n; p++) {
      push(this.byCategory, category[p], p);
      push(this.byGroup, group_id[p], p);
      push(this.bySubgroup, subgroup_id[p], p);
      if (!this.ancestorOfSub.has(subgroup_id[p])) {
        this.ancestorOfSub.set(subgroup_id[p], { category: category[p], group: group_id[p] });
      }
      if (!this.catOfGroup.has(group_id[p])) this.catOfGroup.set(group_id[p], category[p]);
    }
  }

  /** The subgroup a point belongs to (for coarse 3D resolution). */
  subgroupOfPoint(point: number): number {
    return this.subOfPoint[point];
  }

  /** The category + group a subgroup sits under (for scroll-to-selection). */
  ancestorsOfSubgroup(subgroupId: number): { category: number; group: number } | undefined {
    return this.ancestorOfSub.get(subgroupId);
  }

  /** The category a group sits under. */
  categoryOfGroup(groupId: number): number | undefined {
    return this.catOfGroup.get(groupId);
  }

  /** category → group → subgroup path of an entry (for the active-sets tree). */
  pathOf(e: Entry): Entry[] {
    switch (e.level) {
      case "category":
        return [e];
      case "group": {
        const c = this.catOfGroup.get(e.id);
        return c === undefined ? [e] : [{ level: "category", id: c }, e];
      }
      case "subgroup": {
        const a = this.ancestorOfSub.get(e.id);
        return a
          ? [{ level: "category", id: a.category }, { level: "group", id: a.group }, e]
          : [e];
      }
      case "point": {
        const s = this.subOfPoint[e.id];
        const a = this.ancestorOfSub.get(s);
        return a
          ? [
              { level: "category", id: a.category },
              { level: "group", id: a.group },
              { level: "subgroup", id: s },
              e,
            ]
          : [e];
      }
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

/**
 * A single named selection group (`selection_1`, …). Each wraps a `NodeSet`, so
 * a group holds hierarchical entries and resolves to points exactly like the
 * hidden set does.
 */
export interface SelectionGroup {
  id: number;
  name: string;
  set: NodeSet;
}

/**
 * The named-group selection model (Increment 4.8) — the addressable substrate a
 * future agent-driven layer points at ("analyze selection_2"). Selection is
 * organized into multiple named groups; exactly one is ACTIVE and every select
 * action toggles in the active group only. An entry may live in several groups
 * (overlap is allowed). Rendering consumes the UNION of all groups (all green);
 * groups are distinguished in the panel, not by color.
 */
export class SelectionModel {
  private readonly hierarchy: Hierarchy;
  private readonly groups: SelectionGroup[] = [];
  private activeId = -1;
  private nextId = 1;
  private autoCounter = 0;
  private readonly listeners = new Set<() => void>();

  constructor(hierarchy: Hierarchy) {
    this.hierarchy = hierarchy;
    this.newGroup(); // always start with selection_1 active
  }

  list(): readonly SelectionGroup[] {
    return this.groups;
  }
  get active(): SelectionGroup {
    return this.byId(this.activeId)!;
  }
  get activeId_(): number {
    return this.activeId;
  }
  private byId(id: number): SelectionGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  /** Create a new group, auto-named, and make it active. */
  newGroup(): SelectionGroup {
    const g: SelectionGroup = {
      id: this.nextId++,
      name: `selection_${++this.autoCounter}`,
      set: new NodeSet(this.hierarchy, "selection"),
    };
    this.groups.push(g);
    this.activeId = g.id;
    this.emit();
    return g;
  }
  rename(id: number, name: string): void {
    const g = this.byId(id);
    if (g) {
      g.name = name.trim() || g.name;
      this.emit();
    }
  }
  /** Delete a group (always keeps ≥1); returns its resolved points so the caller
   * can re-flip the union for those points. */
  delete(id: number): number[] {
    const idx = this.groups.findIndex((g) => g.id === id);
    if (idx < 0) return [];
    const affected = this.groups[idx].set.resolvedPoints();
    this.groups.splice(idx, 1);
    if (this.groups.length === 0) {
      this.newGroup(); // emits
      return affected;
    }
    if (this.activeId === id) this.activeId = this.groups[Math.min(idx, this.groups.length - 1)].id;
    this.emit();
    return affected;
  }
  setActive(id: number): void {
    if (this.byId(id) && id !== this.activeId) {
      this.activeId = id;
      this.emit();
    }
  }

  /** Toggle an entry in the ACTIVE group; returns affected points. */
  toggle(e: Entry): number[] {
    const pts = this.active.set.toggle(e);
    this.emit();
    return pts;
  }
  /** Add an entry to the ACTIVE group (idempotent; for drag-paint). */
  addToActive(e: Entry): number[] {
    const pts = this.active.set.add(e) ?? [];
    this.emit();
    return pts;
  }
  /** Remove one entry from a specific group; returns affected points. */
  removeEntryFrom(groupId: number, e: Entry): number[] {
    const g = this.byId(groupId);
    if (!g) return [];
    const pts = g.set.remove(e) ?? [];
    this.emit();
    return pts;
  }
  /** Clear one group's entries; returns affected points. */
  clearGroup(groupId: number): number[] {
    const g = this.byId(groupId);
    if (!g) return [];
    const pts = g.set.clear();
    this.emit();
    return pts;
  }

  /** Union membership across ALL groups (what the green overlay draws). */
  containsPoint(point: number): boolean {
    for (const g of this.groups) if (g.set.contains(point)) return true;
    return false;
  }
  /** Whether ANY group holds this exact entry (drives the tree row's green). */
  anyHas(e: Entry): boolean {
    for (const g of this.groups) if (g.set.has(e)) return true;
    return false;
  }
  /** Union of resolved points across all groups (for zoom-to-selection). */
  resolvedPoints(): number[] {
    const out: number[] = [];
    for (let p = 0; p < this.hierarchy.n; p++) if (this.containsPoint(p)) out.push(p);
    return out;
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
