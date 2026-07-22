/**
 * Selection state — the first-class, addressable substrate the whole
 * interaction model points at.
 *
 * The model (interaction redesign): there is ONE **pending selection** being
 * built at a time (the "target"). Gestures in the tree and the 3D view add
 * entries to it; "Create selection" **commits** it as a named
 * `CommittedSelection` (a `NodeSet` + unique name + `hidden` flag + bracket
 * lane). Hiding is a flag on committed selections — the invisible points are
 * the union of all hidden committed selections; there is no standalone hidden
 * set. A committed selection can be re-opened as the target (**edit mode**).
 * Every state change (build edits, commit, hide/unhide, rename, delete,
 * bracket moves) is undoable via one system-wide stack; camera moves are not.
 *
 * Entries reference nodes at ANY level of the hierarchy — a `category`,
 * `group`, `subgroup`, or individual `point` — at the granularity the user
 * clicked (a whole category is ONE entry). Each `NodeSet` resolves its entries
 * to a POINT set via reference counting: `count[p]` is how many entries cover
 * point p, so mutations touch only that entry's points, and mutators return
 * the affected point indices so the renderer can flip just those bits (smooth
 * at N≈250k). Pure state — no DOM, no Three.js — unit-tested directly.
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

  private readonly groupsOfCat = new Map<number, number[]>();
  private readonly subsOfGrp = new Map<number, number[]>();
  /** position of a group within its category / a subgroup within its group,
   * in first-appearance order — the order the bottom tree renders them. */
  private readonly orderOfGroup = new Map<number, number>();
  private readonly orderOfSub = new Map<number, number>();

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
        this.orderOfSub.set(subgroup_id[p], this.subsOfGrp.get(group_id[p])?.length ?? 0);
        push(this.subsOfGrp, group_id[p], subgroup_id[p]);
      }
      if (!this.catOfGroup.has(group_id[p])) {
        this.catOfGroup.set(group_id[p], category[p]);
        this.orderOfGroup.set(group_id[p], this.groupsOfCat.get(category[p])?.length ?? 0);
        push(this.groupsOfCat, category[p], group_id[p]);
      }
    }
  }

  /** Sort key placing an entry at its position in the bottom tree's traversal
   * (category asc → groups → subgroups in first-appearance order → point
   * index); -1 at unused levels puts a parent entry before its descendants. */
  private entryOrder(e: Entry): [number, number, number, number] {
    switch (e.level) {
      case "category":
        return [e.id, -1, -1, -1];
      case "group":
        return [this.catOfGroup.get(e.id) ?? -1, this.orderOfGroup.get(e.id) ?? -1, -1, -1];
      case "subgroup": {
        const a = this.ancestorOfSub.get(e.id);
        return a
          ? [a.category, this.orderOfGroup.get(a.group) ?? -1, this.orderOfSub.get(e.id) ?? -1, -1]
          : [-1, -1, this.orderOfSub.get(e.id) ?? -1, -1];
      }
      case "point": {
        const s = this.subOfPoint[e.id];
        const a = this.ancestorOfSub.get(s);
        return a
          ? [a.category, this.orderOfGroup.get(a.group) ?? -1, this.orderOfSub.get(s) ?? -1, e.id]
          : [-1, -1, -1, e.id];
      }
    }
  }

  /** Comparator ordering entries the way the full hierarchy renders them. */
  compareEntries(a: Entry, b: Entry): number {
    const ka = this.entryOrder(a);
    const kb = this.entryOrder(b);
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  }

  /** Direct children of a node (for carving finer holes out of coarse entries). */
  childrenOf(e: Entry): Entry[] {
    switch (e.level) {
      case "category":
        return (this.groupsOfCat.get(e.id) ?? []).map((id) => ({ level: "group", id }));
      case "group":
        return (this.subsOfGrp.get(e.id) ?? []).map((id) => ({ level: "subgroup", id }));
      case "subgroup":
        return (this.bySubgroup.get(e.id) ?? []).map((id) => ({ level: "point", id }));
      case "point":
        return [];
    }
  }

  /** The subgroup a point belongs to (for coarse 3D resolution). */
  subgroupOfPoint(point: number): number {
    return this.subOfPoint[point];
  }

  /** The category + group a subgroup sits under. */
  ancestorsOfSubgroup(subgroupId: number): { category: number; group: number } | undefined {
    return this.ancestorOfSub.get(subgroupId);
  }

  /** The category a group sits under. */
  categoryOfGroup(groupId: number): number | undefined {
    return this.catOfGroup.get(groupId);
  }

  /** category → group → subgroup path of an entry (self included, last). */
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

  /** Does the entry cover at least one of these points? Early-exit scan —
   * the point-set row matching the command layer's flash-parity relies on. */
  entryIntersects(e: Entry, points: ReadonlySet<number>): boolean {
    if (e.level === "point") return points.has(e.id);
    for (const p of this.pointsOf(e)) if (points.has(p)) return true;
    return false;
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

/**
 * One persistent set of entries with a reference-counted resolved point set.
 * Mutators return the point indices they touched (or null when a no-op) so the
 * caller can update render buffers incrementally; `onChange` fires for UI.
 */
export class NodeSet {
  private readonly hierarchy: Hierarchy;
  private readonly countArr: Uint32Array; // per-point entry coverage count
  private covered = 0; // number of points with count > 0
  private readonly entries = new Map<string, Entry>(); // insertion-ordered
  private readonly listeners = new Set<() => void>();

  constructor(hierarchy: Hierarchy) {
    this.hierarchy = hierarchy;
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
  clear(): number[] {
    const affected: number[] = [];
    for (let p = 0; p < this.countArr.length; p++) if (this.countArr[p] > 0) affected.push(p);
    this.countArr.fill(0);
    this.covered = 0;
    this.entries.clear();
    this.emit();
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
 * A committed selection — the named object the top section operates on.
 * `hidden` makes ALL its resolved points invisible; `hiddenPart` holds the
 * individually hidden member entries (a subset of `set`) so a few members can
 * be hidden without hiding the whole selection. `lane` is the horizontal
 * bracket lane its bracket occupies in the bottom tree — assigned once at
 * construction by freeLane() and never changed; there is no move operation.
 */
export interface CommittedSelection {
  id: number;
  name: string;
  set: NodeSet;
  hidden: boolean;
  hiddenPart: NodeSet;
  lane: number;
}

export const MAX_BRACKET_LANES = 4;

/** One undoable state change: `undo()` reverts it and returns affected points. */
interface UndoOp {
  undo(): number[];
}

/**
 * The pending-target + committed-selections model with a system-wide undo
 * stack. All build gestures mutate the TARGET — the pending set, or, in edit
 * mode, the committed selection being edited. Rendering consumes:
 *   - `targetContains(p)`  → the green (pending) footprint
 *   - `isPointHidden(p)`   → union of hidden committed selections
 * Undo covers state changes only (never camera): build edits, clear-pending,
 * commit, hide/unhide, rename, delete — each `undo()`
 * returns the affected point indices so the renderer can flip just those bits.
 */
export class SelectionModel {
  private readonly hierarchy: Hierarchy;
  private pendingSet: NodeSet;
  private readonly committedList: CommittedSelection[] = [];
  private editingId: number | null = null;
  private nextId = 1;
  private readonly undoStack: UndoOp[] = [];
  /** When non-null, undoable ops coalesce here (one paint stroke = one undo). */
  private strokeOps: UndoOp[] | null = null;
  /** Stroke nesting depth — beginStroke/endStroke are REENTRANT: a command that
   * internally strokes (create_sele/hide) can run inside an outer stroke (a
   * commands mod's batch) without its endStroke closing the outer one. The
   * compound entry is pushed only when the OUTERMOST stroke ends. */
  private strokeDepth = 0;
  private readonly listeners = new Set<() => void>();

  constructor(hierarchy: Hierarchy) {
    this.hierarchy = hierarchy;
    this.pendingSet = new NodeSet(hierarchy);
  }

  // -- queries ----------------------------------------------------------------

  /** The set build gestures currently write into. */
  get target(): NodeSet {
    return this.editing?.set ?? this.pendingSet;
  }
  /** The raw pending (uncommitted) set. */
  get pending(): NodeSet {
    return this.pendingSet;
  }
  get editing(): CommittedSelection | null {
    return this.editingId === null ? null : (this.byId(this.editingId) ?? null);
  }
  committed(): readonly CommittedSelection[] {
    return this.committedList;
  }
  byId(id: number): CommittedSelection | undefined {
    return this.committedList.find((c) => c.id === id);
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get undoDepth(): number {
    return this.undoStack.length;
  }

  /** Green footprint: is p covered by the current target? */
  targetContains(point: number): boolean {
    return this.target.contains(point);
  }
  /** Invisible footprint. SHOW WINS: a visible committed selection always
   * shows its points — "by virtue of being a selection it is shown" — no
   * matter what older or newer hidden selections overlap it. A point is
   * hidden only when at least one selection hides it (whole-hide, or its own
   * part-hidden members) AND no visible selection covers it. Points covered
   * by no selection are simply visible. */
  isPointHidden(point: number): boolean {
    let hideVote = false;
    for (const c of this.committedList) {
      if (!c.set.contains(point)) continue;
      if (c.hidden || c.hiddenPart.contains(point)) hideVote = true;
      else return false; // a visible selection shows the point — show wins
    }
    return hideVote;
  }
  /** Is this member entry individually hidden within its selection? */
  entryHidden(id: number, e: Entry): boolean {
    return this.byId(id)?.hiddenPart.has(e) ?? false;
  }
  /** Entry (or one of its ancestors) is in `set` — its row is fully covered. */
  coversEntry(set: NodeSet, e: Entry): boolean {
    for (const seg of this.hierarchy.pathOf(e)) if (set.has(seg)) return true;
    return false;
  }
  targetCoversEntry(e: Entry): boolean {
    return this.coversEntry(this.target, e);
  }
  /** Keys of every entry AND its ancestors in `set` — rows on the path to an
   * entry (used for partial row marks and bracket spans). */
  touchKeys(set: NodeSet): Set<string> {
    const keys = new Set<string>();
    for (const e of set.listEntries()) {
      for (const seg of this.hierarchy.pathOf(e)) keys.add(entryKey(seg));
    }
    return keys;
  }

  // -- build gestures (undoable; write to the TARGET) --------------------------

  /** Click semantics: a row that is selected — as an entry OR covered by a
   * coarser ancestor entry — toggles OFF (carving a hole if needed);
   * everything else toggles ON. */
  toggleInTarget(e: Entry): number[] {
    return this.target.has(e) || this.coversEntry(this.target, e)
      ? this.removeFromTarget(e)
      : this.addToTarget(e);
  }
  /** Idempotent add (paint forward). */
  addToTarget(e: Entry): number[] {
    const set = this.target;
    const pts = set.add(e);
    if (!pts) return [];
    this.pushUndo({ undo: () => set.remove(e) ?? [] });
    this.emit();
    return pts;
  }
  /** Idempotent remove (paint backtrack / remove-paint). Removing a member
   * from an EDITED selection also drops its individual-hide (one undo op).
   * Removing a node covered only by a COARSER ancestor entry CARVES it out:
   * the ancestor is replaced by its complement at the clicked level, so the
   * green footprint and the brackets visibly break around the hole. */
  removeFromTarget(e: Entry): number[] {
    const set = this.target;
    if (!set.has(e)) return this.carveFromTarget(e);
    const pts = set.remove(e) ?? [];
    const sel = this.editing;
    const droppedHide = sel && sel.hiddenPart.has(e) ? sel : null;
    const hpPts = droppedHide ? (droppedHide.hiddenPart.remove(e) ?? []) : [];
    this.pushUndo({
      undo: () => {
        const a = set.add(e) ?? [];
        if (droppedHide) a.push(...(droppedHide.hiddenPart.add(e) ?? []));
        return a;
      },
    });
    this.emit();
    return hpPts.length ? pts.concat(hpPts) : pts;
  }
  /** Replace every ancestor entry covering `e` with its complement down to
   * `e`'s level (one undo op). No-op when nothing covers `e`. */
  private carveFromTarget(e: Entry): number[] {
    const set = this.target;
    const sel = this.editing;
    const path = this.hierarchy.pathOf(e); // ancestors …, e (last)
    const affected: number[] = [];
    const removed: { entry: Entry; hpDropped: boolean }[] = [];
    const added: Entry[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      if (!set.has(a)) continue;
      const hpDropped = (sel?.hiddenPart.has(a) ?? false) as boolean;
      affected.push(...(set.remove(a) ?? []));
      if (hpDropped) affected.push(...(sel!.hiddenPart.remove(a) ?? []));
      removed.push({ entry: a, hpDropped });
      // walk the path from a toward e, adding every sibling of the next step
      for (let l = i; l < path.length - 1; l++) {
        const excludeKey = entryKey(path[l + 1]);
        for (const child of this.hierarchy.childrenOf(path[l])) {
          if (entryKey(child) === excludeKey) continue;
          const pts = set.add(child);
          if (pts) {
            affected.push(...pts);
            added.push(child);
          }
        }
      }
    }
    if (removed.length === 0) return [];
    this.pushUndo({
      undo: () => {
        const a: number[] = [];
        for (const c of added) a.push(...(set.remove(c) ?? []));
        for (const r of removed) {
          a.push(...(set.add(r.entry) ?? []));
          if (r.hpDropped) a.push(...(sel!.hiddenPart.add(r.entry) ?? []));
        }
        return a;
      },
    });
    this.emit();
    return affected;
  }
  /** Escape: discard the pending selection (undoable). */
  clearPending(): number[] {
    if (this.pendingSet.entryCount === 0) return [];
    const set = this.pendingSet;
    const entries = set.listEntries();
    const pts = set.clear();
    this.pushUndo({ undo: () => set.addMany(entries) });
    this.emit();
    return pts;
  }
  /** Clear the CURRENT target — the pending set, or, in edit mode, the edited
   * selection's entries (with their individual hides). One undo op. */
  clearTarget(): number[] {
    const set = this.target;
    if (set.entryCount === 0) return [];
    const sel = this.editing;
    const entries = set.listEntries();
    const hpEntries = sel ? sel.hiddenPart.listEntries() : [];
    const pts = set.clear();
    const hpPts = sel ? sel.hiddenPart.clear() : [];
    this.pushUndo({
      undo: () => {
        const a = set.addMany(entries);
        if (sel) a.push(...sel.hiddenPart.addMany(hpEntries));
        return a;
      },
    });
    this.emit();
    return pts.concat(hpPts);
  }

  /** Coalesce subsequent undoable ops into ONE undo entry (a paint stroke).
   * Reentrant: nested begin/end pairs collapse into the outermost stroke. */
  beginStroke(): void {
    if (this.strokeDepth === 0) this.strokeOps = [];
    this.strokeDepth++;
  }
  endStroke(): void {
    if (this.strokeDepth === 0) return; // unbalanced end — nothing open
    this.strokeDepth--;
    if (this.strokeDepth > 0) return; // still inside an outer stroke
    const ops = this.strokeOps;
    this.strokeOps = null;
    if (!ops || ops.length === 0) return;
    this.undoStack.push({
      undo: () => {
        const affected: number[] = [];
        for (let i = ops.length - 1; i >= 0; i--) affected.push(...ops[i].undo());
        return affected;
      },
    });
  }

  /** Record an EXTERNAL undoable mutation — state living outside this model
   * (e.g. a per-point representation write) — on the SAME stack system-wide
   * Ctrl+Z drives, so no second undo system can ever exist. The closure must
   * revert that external state itself and return the affected point indices;
   * between beginStroke/endStroke it coalesces like any other op. */
  recordOp(undo: () => number[]): void {
    this.pushUndo({ undo });
  }

  // -- lifecycle ----------------------------------------------------------------

  /** Commit the pending selection as a named committed selection (undoable).
   * Returns it, or null when pending is empty or we're in edit mode. */
  commit(): CommittedSelection | null {
    if (this.editingId !== null) return null;
    if (this.pendingSet.entryCount === 0) return null;
    const set = this.pendingSet;
    const sel: CommittedSelection = {
      id: this.nextId++,
      name: this.autoName(),
      set,
      hidden: false,
      hiddenPart: new NodeSet(this.hierarchy),
      lane: this.freeLane(),
    };
    this.committedList.push(sel);
    this.pendingSet = new NodeSet(this.hierarchy);
    this.pushUndo({
      undo: () => {
        const i = this.committedList.indexOf(sel);
        if (i >= 0) this.committedList.splice(i, 1);
        if (this.editingId === sel.id) this.editingId = null;
        // Swap the ORIGINAL set back in as pending (LIFO undo has already
        // reverted anything done to the interim pending set), so earlier undo
        // ops — which captured this set object — still apply to it.
        const affected = this.pendingSet.resolvedPoints();
        this.pendingSet = set;
        return affected.concat(set.resolvedPoints());
      },
    });
    this.emit();
    return sel;
  }

  /** Make a committed selection the target (edit mode). Returns the points
   * whose green state changes (old target ∪ new target). Not undoable (a mode,
   * not a state change); the edits made inside it are individually undoable. */
  beginEdit(id: number): number[] {
    const sel = this.byId(id);
    if (!sel || this.editingId === id) return [];
    const before = this.target.resolvedPoints();
    this.editingId = id;
    const after = sel.set.resolvedPoints();
    this.emit();
    return before.concat(after);
  }
  /** Exit edit mode ("Done" / Escape). Returns green-affected points. */
  endEdit(): number[] {
    if (this.editingId === null) return [];
    const before = this.target.resolvedPoints();
    this.editingId = null;
    const after = this.pendingSet.resolvedPoints();
    this.emit();
    return before.concat(after);
  }

  // -- operate (undoable) -------------------------------------------------------

  setHidden(id: number, hidden: boolean): number[] {
    const sel = this.byId(id);
    if (!sel || sel.hidden === hidden) return [];
    sel.hidden = hidden;
    this.pushUndo({
      undo: () => {
        sel.hidden = !hidden;
        return sel.set.resolvedPoints();
      },
    });
    this.emit();
    return sel.set.resolvedPoints();
  }
  toggleHidden(id: number): number[] {
    const sel = this.byId(id);
    return sel ? this.setHidden(id, !sel.hidden) : [];
  }

  /** Hide/show ONE member entry of a committed selection (undoable). Only
   * exact stored MEMBERS can be part-hidden — never a node inside a coarse
   * member (a briefly-wider rule was reversed: sub-member hides created
   * state the panel could neither display per row nor clear by gesture —
   * consistency principle 2). */
  setEntryHidden(id: number, e: Entry, hidden: boolean): number[] {
    const sel = this.byId(id);
    if (!sel) return [];
    if (hidden && !sel.set.has(e)) return []; // only members can be part-hidden
    if (sel.hiddenPart.has(e) === hidden) return [];
    const pts = (hidden ? sel.hiddenPart.add(e) : sel.hiddenPart.remove(e)) ?? [];
    this.pushUndo({
      undo: () => (hidden ? (sel.hiddenPart.remove(e) ?? []) : (sel.hiddenPart.add(e) ?? [])),
    });
    this.emit();
    return pts;
  }
  toggleEntryHidden(id: number, e: Entry): number[] {
    return this.setEntryHidden(id, e, !this.entryHidden(id, e));
  }
  /** Hide/show several member entries at once (one undo unit — a drag). */
  setEntriesHidden(id: number, entries: Entry[], hidden: boolean): number[] {
    this.beginStroke();
    const affected: number[] = [];
    for (const e of entries) affected.push(...this.setEntryHidden(id, e, hidden));
    this.endStroke();
    return affected;
  }

  // NOTE (consistency principle 2): a setPointsHidden method that could hide
  // arbitrary point-subsets INSIDE coarse members existed briefly and was
  // REMOVED — commands operate at whole-member granularity, exactly like the
  // panel gestures, so no command can produce state the UI cannot reverse.

  /** Clear ALL hidden state on one selection — the whole-selection flag AND
   * every per-member hide — as ONE undo op. "Show the whole selection" means
   * make all of it visible, whatever granularity hid it. */
  clearAllHidden(id: number): number[] {
    const sel = this.byId(id);
    if (!sel) return [];
    const affected: number[] = [];
    this.beginStroke();
    affected.push(...this.setHidden(id, false));
    for (const e of sel.hiddenPart.listEntries()) {
      affected.push(...this.setEntryHidden(id, e, false));
    }
    this.endStroke();
    return affected;
  }

  /** Rename (unique names enforced). Returns false if rejected. */
  rename(id: number, name: string): boolean {
    const sel = this.byId(id);
    const next = name.trim();
    if (!sel || !next || next === sel.name) return false;
    if (this.committedList.some((c) => c.id !== id && c.name === next)) return false;
    const prev = sel.name;
    sel.name = next;
    this.pushUndo({
      undo: () => {
        sel.name = prev;
        return [];
      },
    });
    this.emit();
    return true;
  }

  deleteSelection(id: number): number[] {
    const idx = this.committedList.findIndex((c) => c.id === id);
    if (idx < 0) return [];
    const sel = this.committedList[idx];
    this.committedList.splice(idx, 1);
    if (this.editingId === id) this.editingId = null;
    // ALL covered points may change visibility: the selection's own vote
    // disappears, so older overlapping selections' votes resurface.
    this.pushUndo({
      undo: () => {
        this.committedList.splice(Math.min(idx, this.committedList.length), 0, sel);
        return sel.set.resolvedPoints();
      },
    });
    this.emit();
    return sel.set.resolvedPoints();
  }

  /** Startup prefab: a pre-made VISIBLE committed selection (NOT undoable —
   * it is initial state, e.g. one per bulk category so the user can hide the
   * environment with one right-click; nothing is hidden by default). */
  seed(name: string, entries: Entry[]): CommittedSelection {
    const set = new NodeSet(this.hierarchy);
    set.addMany(entries);
    const sel: CommittedSelection = {
      id: this.nextId++,
      name: this.uniqueName(name),
      set,
      hidden: false,
      hiddenPart: new NodeSet(this.hierarchy),
      lane: this.freeLane(),
    };
    this.committedList.push(sel);
    this.emit();
    return sel;
  }

  // -- undo ---------------------------------------------------------------------

  /** Undo the most recent state change; returns affected points (null if none). */
  undo(): number[] | null {
    // A stroke in progress is undone as a unit — force it closed regardless of
    // nesting depth (a Ctrl+Z should never land mid-stroke, but be defensive).
    if (this.strokeOps && this.strokeOps.length > 0) { this.strokeDepth = 1; this.endStroke(); }
    const op = this.undoStack.pop();
    if (!op) return null;
    const pts = op.undo();
    this.emit();
    return pts;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -- internals ------------------------------------------------------------------

  private pushUndo(op: UndoOp): void {
    if (this.strokeOps) this.strokeOps.push(op);
    else this.undoStack.push(op);
  }
  /** Default name for a new commit: the numbering RESTARTS — the smallest
   * `selection_N` not currently in use (deleting selection_1 frees the name
   * for the next commit; counts stay relative to the list, never bleeding
   * upward forever). */
  private autoName(): string {
    let n = 1;
    while (this.committedList.some((c) => c.name === `selection_${n}`)) n++;
    return `selection_${n}`;
  }
  private uniqueName(base: string): string {
    if (!this.committedList.some((c) => c.name === base)) return base;
    let k = 2;
    while (this.committedList.some((c) => c.name === `${base} (${k})`)) k++;
    return `${base} (${k})`;
  }
  /** Lowest lane not used yet (cycling when all are taken). */
  private freeLane(): number {
    const used = new Set(this.committedList.map((c) => c.lane));
    for (let l = 0; l < MAX_BRACKET_LANES; l++) if (!used.has(l)) return l;
    return this.committedList.length % MAX_BRACKET_LANES;
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
