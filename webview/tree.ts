/**
 * Shared hierarchy tree — the ONE row/gesture substrate both panel sections
 * render through, so names, row styling, and gesture feel never drift.
 *
 * Two mounts share the row factory and the gesture engine:
 *   - `mountTree`      — the full classification tree (bottom section):
 *                        category → group → subgroup → point, lazy expansion,
 *                        the huge subgroup/point lists virtualized.
 *   - `mountEntryList` — a FLAT list of entries at their own level (the top
 *                        section's member view): a selection made of subgroups
 *                        shows exactly those subgroup rows — no ancestors, no
 *                        expansion.
 *
 * The engine recognizes, for BOTH buttons (movement threshold keeps a jittery
 * click from misfiring as a drag):
 *   - primary click / hold / drag-trail (paint; trail reports enter/backtrack)
 *   - secondary click / drag-trail (region gestures)
 * What a gesture MEANS is injected per mount (`TreeGestures`).
 */
import type { CategoryNode, GroupNode, SubgroupNode, TreeModel } from "./classification.ts";
import { entryKey, type Entry, type Hierarchy } from "./sets.ts";
import { VirtualList } from "./virtuallist.ts";

const ROW_H = 18;
const DRAG_THRESHOLD_PX = 5;
const HOLD_MS = 400;

export interface TreeGestures {
  /** Left click (no drag, no hold). */
  primaryClick(e: Entry): void;
  /** Left press-and-hold without movement (optional). */
  primaryHold?(e: Entry): void;
  /** A left drag-trail begins (movement passed the threshold). */
  trailStart?(startEntry: Entry): void;
  /** Trail moved forward onto a row not in the trail. */
  trailAdd?(e: Entry): void;
  /** Trail backtracked off a row (dragging back reverts it). */
  trailRemove?(e: Entry): void;
  /** Trail released; `entries` is the surviving trail in order. */
  trailEnd?(entries: Entry[]): void;
  /** Right click on a row. */
  secondaryClick(e: Entry): void;
  /** A right drag-trail begins (movement passed the threshold). */
  secondaryTrailStart?(startEntry: Entry): void;
  /** Right trail moved onto a row not yet in the trail — fired PER ROW while
   * dragging so state (e.g. hide) can stick as the pointer crosses. */
  secondaryTrailAdd?(e: Entry): void;
  /** Right trail backtracked off a row (dragging back shortens the trail and
   * reverts that row — same semantics as the left trail). */
  secondaryTrailRemove?(e: Entry): void;
  /** Right drag released; `entries` is the surviving trail in order. */
  secondaryTrailEnd?(entries: Entry[]): void;
}

export interface TreeOptions {
  /** Left px reserved in every row for the bracket gutter (bottom tree). */
  gutter?: number;
  /** Which points a subgroup drills into. */
  pointsOfSubgroup?: (subgroupId: number) => number[];
  /** Apply state classes to a row (called on build and on refresh()). */
  decorate?: (e: Entry, row: HTMLElement) => void;
  /** Fired when row layout may have changed (expand/collapse/drill). */
  onLayout?: () => void;
  /** Flash rows touched by secondary gestures (focus feedback). */
  flashOnSecondary?: boolean;
  /** CSS class the secondary flash uses (default "row-flash", the yellow
   * swatch; pass "row-flash-purple" for hide feedback). */
  secondaryFlashClass?: string;
  /** Flash rows touched by primary click/trail (focus feedback, top section). */
  flashOnPrimary?: boolean;
}

export interface TreeHandle {
  root: HTMLElement;
  /** Re-apply decorate() to every currently rendered row. */
  refresh(): void;
  /** Visit every rendered row that is actually visible (not collapsed away). */
  forEachVisibleRow(fn: (e: Entry, el: HTMLElement) => void): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Row factory + gesture engine (shared by both mounts)
// ---------------------------------------------------------------------------

interface RowEngine {
  makeRow(
    depth: number,
    text: string,
    rowOpts?: { entry?: Entry; expandable?: boolean },
  ): { row: HTMLElement; caret: HTMLElement };
  dispose(): void;
}

function entryOf(row: HTMLElement): Entry {
  return { level: row.dataset.level as Entry["level"], id: Number(row.dataset.id) };
}

/** How long a transient flash class stays before the shared background
 * transition fades it back out. */
const FLASH_HOLD_MS = 480;
const flashTimers = new WeakMap<HTMLElement, number>();

/** Transient flash: add the color class, let the standard background
 * transition swell it in, then remove it after a beat so the same transition
 * fades it back out (re-flashes just extend the hold). */
function flashRow(row: HTMLElement, cls = "row-flash"): void {
  const prev = flashTimers.get(row);
  if (prev) clearTimeout(prev);
  row.classList.add(cls);
  flashTimers.set(
    row,
    window.setTimeout(() => {
      row.classList.remove(cls);
      flashTimers.delete(row);
    }, FLASH_HOLD_MS),
  );
}

function createRowEngine(
  container: HTMLElement,
  treeRoot: HTMLElement,
  gestures: TreeGestures,
  opts: TreeOptions,
): RowEngine {
  const gutter = opts.gutter ?? 0;

  const rowUnder = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest?.(".tree-row.selectable") as HTMLElement | null;
    return row && treeRoot.contains(row) ? row : null;
  };

  interface Arm {
    entry: Entry;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    holdFired: boolean;
    holdTimer: number;
    trail: { key: string; entry: Entry; row: HTMLElement | null }[];
  }
  let left: Arm | null = null;
  let right: Arm | null = null;

  // Trail feedback HOLDS while the button is down (the color stays present
  // until release); removing the class rides the standard background
  // transition back out — never disappearing mid-drag.
  const pCls = "row-flash";
  const sCls = opts.secondaryFlashClass ?? "row-flash";
  const holdOn = (row: HTMLElement, cls: string): void => {
    row.classList.add(`${cls}-hold`);
  };
  const holdOff = (row: HTMLElement, cls: string): void => {
    row.classList.remove(`${cls}-hold`);
  };

  /** Visit every row along the segment from the arm's last position to
   * (x1,y1) — pointermove samples are sparse, so a fast drag would otherwise
   * skip rows between events. Steps at half a row height. */
  const walkRows = (arm: Arm, x1: number, y1: number, visit: (row: HTMLElement) => void): void => {
    const dist = Math.hypot(x1 - arm.lastX, y1 - arm.lastY);
    const steps = Math.max(1, Math.ceil(dist / (ROW_H / 2)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const row = rowUnder(arm.lastX + (x1 - arm.lastX) * t, arm.lastY + (y1 - arm.lastY) * t);
      if (row) visit(row);
    }
    arm.lastX = x1;
    arm.lastY = y1;
  };

  const enterLeft = (entry: Entry, row?: HTMLElement | null): void => {
    if (!left) return;
    const key = entryKey(entry);
    const t = left.trail;
    if (t.length > 0 && t[t.length - 1].key === key) return;
    const at = t.findIndex((it) => it.key === key);
    if (at >= 0) {
      // dragged back onto an earlier trail row: revert everything after it
      while (t.length - 1 > at) {
        const popped = t.pop()!;
        if (opts.flashOnPrimary && popped.row) holdOff(popped.row, pCls);
        gestures.trailRemove?.(popped.entry);
      }
    } else {
      t.push({ key, entry, row: row ?? null });
      if (opts.flashOnPrimary && row) holdOn(row, pCls);
      gestures.trailAdd?.(entry);
    }
  };
  const enterRight = (entry: Entry, row: HTMLElement): void => {
    if (!right) return;
    const key = entryKey(entry);
    const t = right.trail;
    if (t.length > 0 && t[t.length - 1].key === key) return;
    const at = t.findIndex((it) => it.key === key);
    if (at >= 0) {
      // dragged back onto an earlier trail row: shorten — revert the tail
      while (t.length - 1 > at) {
        const popped = t.pop()!;
        if (opts.flashOnSecondary && popped.row) holdOff(popped.row, sCls);
        gestures.secondaryTrailRemove?.(popped.entry);
      }
    } else {
      t.push({ key, entry, row });
      if (opts.flashOnSecondary) holdOn(row, sCls);
      gestures.secondaryTrailAdd?.(entry);
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (left) {
      if (!left.moved) {
        if (Math.hypot(e.clientX - left.x, e.clientY - left.y) <= DRAG_THRESHOLD_PX) return;
        left.moved = true;
        clearTimeout(left.holdTimer);
        gestures.trailStart?.(left.entry);
        enterLeft(left.entry, rowUnder(left.x, left.y)); // the start row joins the trail
      }
      walkRows(left, e.clientX, e.clientY, (row) => enterLeft(entryOf(row), row));
    } else if (right) {
      if (!right.moved) {
        if (Math.hypot(e.clientX - right.x, e.clientY - right.y) <= DRAG_THRESHOLD_PX) return;
        right.moved = true;
        gestures.secondaryTrailStart?.(right.entry);
        const startRow = rowUnder(right.x, right.y);
        if (startRow) enterRight(right.entry, startRow);
      }
      walkRows(right, e.clientX, e.clientY, (row) => enterRight(entryOf(row), row));
    }
  };
  const onUp = (e: PointerEvent): void => {
    if (e.button === 0 && left) {
      const a = left;
      left = null;
      clearTimeout(a.holdTimer);
      if (a.moved) {
        if (opts.flashOnPrimary) {
          for (const it of a.trail) if (it.row) holdOff(it.row, pCls);
        }
        gestures.trailEnd?.(a.trail.map((t) => t.entry));
      } else if (!a.holdFired) {
        if (opts.flashOnPrimary) {
          const row = rowUnder(e.clientX, e.clientY);
          if (row) flashRow(row);
        }
        gestures.primaryClick(a.entry);
      }
    } else if (e.button === 2 && right) {
      const a = right;
      right = null;
      if (a.moved && a.trail.length > 0) {
        if (opts.flashOnSecondary) {
          for (const it of a.trail) if (it.row) holdOff(it.row, sCls);
        }
        (gestures.secondaryTrailEnd ?? ((entries: Entry[]) => gestures.secondaryClick(entries[0])))(
          a.trail.map((t) => t.entry),
        );
      } else {
        if (opts.flashOnSecondary) {
          const row = rowUnder(e.clientX, e.clientY);
          if (row) flashRow(row, opts.secondaryFlashClass);
        }
        gestures.secondaryClick(a.entry);
      }
    }
  };
  const onContext = (e: MouseEvent): void => {
    // secondary actions run on pointerup (so right-DRAG can be a gesture);
    // the native menu is suppressed for the whole mount.
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  container.addEventListener("contextmenu", onContext);

  const makeRow = (
    depth: number,
    text: string,
    rowOpts: { entry?: Entry; expandable?: boolean } = {},
  ): { row: HTMLElement; caret: HTMLElement } => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${6 + gutter + depth * 14}px`;

    const caret = document.createElement("span");
    // expandable carets get a generous hit box (class .exp) so aiming at the
    // arrow can't accidentally land a selection on the row
    caret.className = rowOpts.expandable ? "caret row-ctl exp" : "caret row-ctl";
    caret.textContent = rowOpts.expandable ? "▸" : "";
    row.appendChild(caret);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = text;
    row.appendChild(label);

    if (rowOpts.entry) {
      const entry = rowOpts.entry;
      row.classList.add("selectable");
      row.dataset.level = entry.level;
      row.dataset.id = String(entry.id);
      row.addEventListener("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest(".row-ctl")) return;
        if (e.button === 0) {
          e.preventDefault();
          left = {
            entry,
            x: e.clientX,
            y: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            moved: false,
            holdFired: false,
            trail: [],
            holdTimer: gestures.primaryHold
              ? window.setTimeout(() => {
                  if (left && !left.moved) {
                    left.holdFired = true;
                    gestures.primaryHold!(entry);
                  }
                }, HOLD_MS)
              : 0,
          };
        } else if (e.button === 2) {
          right = {
            entry,
            x: e.clientX,
            y: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            moved: false,
            holdFired: false,
            holdTimer: 0,
            trail: [],
          };
        }
      });
      opts.decorate?.(entry, row);
    }
    return { row, caret };
  };

  return {
    makeRow,
    dispose: () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      container.removeEventListener("contextmenu", onContext);
    },
  };
}

// ---------------------------------------------------------------------------
// The full classification tree (bottom section)
// ---------------------------------------------------------------------------

export function mountTree(
  container: HTMLElement,
  tree: TreeModel,
  hierarchy: Hierarchy,
  gestures: TreeGestures,
  opts: TreeOptions = {},
): TreeHandle {
  container.innerHTML = "";
  const pointsOf = opts.pointsOfSubgroup ?? ((s: number) => hierarchy.subgroupPoints(s));
  const scrollRoot = (container.closest("#sidebar-content") as HTMLElement) ?? container;

  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);
  const engine = createRowEngine(container, treeRoot, gestures, opts);

  const attachExpander = (caret: HTMLElement, childHost: HTMLElement, build: () => void): void => {
    let built = false;
    let open = false;
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      open = !open;
      if (open && !built) {
        build();
        built = true;
      }
      childHost.style.display = open ? "" : "none";
      caret.textContent = open ? "▾" : "▸";
      opts.onLayout?.();
    });
  };

  // A group's subgroup+point list, virtualized over a flat fixed-height model.
  type FlatItem = { kind: "sub"; node: SubgroupNode; expanded: boolean } | { kind: "point"; id: number };
  const vlists: VirtualList[] = [];
  const buildGroupSubtree = (group: GroupNode): VirtualList => {
    const flat: FlatItem[] = group.subgroups.map((s) => ({ kind: "sub", node: s, expanded: false }));
    let vlist!: VirtualList;
    const renderRow = (i: number): HTMLElement => {
      const item = flat[i];
      if (item.kind === "point") {
        const entry: Entry = { level: "point", id: item.id };
        return engine.makeRow(3, hierarchy.label(entry), { entry }).row;
      }
      const s = item.node;
      const entry: Entry = { level: "subgroup", id: s.subgroupId };
      const { row, caret } = engine.makeRow(2, `${s.label} — ${fmt(s.pointCount)} pts`, {
        entry,
        expandable: s.pointCount > 0,
      });
      caret.textContent = item.expanded ? "▾" : s.pointCount > 0 ? "▸" : "";
      caret.addEventListener("click", (e) => {
        e.stopPropagation();
        const at = flat.indexOf(item);
        if (at < 0) return;
        if (!item.expanded) {
          const pts = pointsOf(s.subgroupId);
          flat.splice(at + 1, 0, ...pts.map((p) => ({ kind: "point", id: p }) as FlatItem));
          item.expanded = true;
        } else {
          let rm = 0;
          while (flat[at + 1 + rm]?.kind === "point") rm++;
          flat.splice(at + 1, rm);
          item.expanded = false;
        }
        vlist.setCount(flat.length);
        opts.onLayout?.();
      });
      return row;
    };
    vlist = new VirtualList(scrollRoot, flat.length, ROW_H, renderRow);
    vlists.push(vlist);
    return vlist;
  };

  const buildGroup = (host: HTMLElement, group: GroupNode): void => {
    const { row, caret } = engine.makeRow(
      1,
      `${group.label} — ${fmt(group.pointCount)} pts, ${fmt(group.subgroups.length)} sub`,
      { entry: { level: "group", id: group.groupId }, expandable: group.subgroups.length > 0 },
    );
    host.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    host.appendChild(kids);
    attachExpander(caret, kids, () => {
      kids.appendChild(buildGroupSubtree(group).el);
    });
  };

  const buildCategory = (cat: CategoryNode): void => {
    const { row, caret } = engine.makeRow(0, `${cat.label} — ${fmt(cat.pointCount)} pts`, {
      entry: { level: "category", id: cat.categoryIndex },
      expandable: cat.groups.length > 0,
    });
    const block = document.createElement("div");
    block.className = "cat-block";
    block.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    block.appendChild(kids);
    treeRoot.appendChild(block);
    attachExpander(caret, kids, () => {
      for (const group of cat.groups) buildGroup(kids, group);
    });
  };

  for (const cat of tree.categories) buildCategory(cat);
  opts.onLayout?.();

  return {
    root: treeRoot,
    refresh: () => {
      if (!opts.decorate) return;
      for (const row of treeRoot.querySelectorAll<HTMLElement>(".tree-row.selectable")) {
        opts.decorate(entryOf(row), row);
      }
    },
    forEachVisibleRow: (fn) => {
      for (const row of treeRoot.querySelectorAll<HTMLElement>(".tree-row.selectable")) {
        if (row.getBoundingClientRect().height === 0) continue; // collapsed away
        fn(entryOf(row), row);
      }
    },
    dispose: () => {
      engine.dispose();
      for (const v of vlists) v.dispose();
      container.innerHTML = "";
    },
  };
}

// ---------------------------------------------------------------------------
// Flat entry list (top section) — entries at their OWN level, no expansion.
// ---------------------------------------------------------------------------

export interface EntryListHandle {
  root: HTMLElement;
  refresh(): void;
  dispose(): void;
}

export function mountEntryList(
  container: HTMLElement,
  hierarchy: Hierarchy,
  entries: Entry[],
  gestures: TreeGestures,
  opts: TreeOptions = {},
): EntryListHandle {
  container.innerHTML = "";
  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);
  const engine = createRowEngine(container, treeRoot, gestures, opts);

  for (const e of entries) {
    const { row } = engine.makeRow(0, `${hierarchy.label(e)} — ${fmt(hierarchy.pointCount(e))} pts`, {
      entry: e,
    });
    treeRoot.appendChild(row);
  }

  return {
    root: treeRoot,
    refresh: () => {
      if (!opts.decorate) return;
      for (const row of treeRoot.querySelectorAll<HTMLElement>(".tree-row.selectable")) {
        opts.decorate(entryOf(row), row);
      }
    },
    dispose: () => {
      engine.dispose();
      container.innerHTML = "";
    },
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
