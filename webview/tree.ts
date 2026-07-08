/**
 * Shared hierarchy tree — the ONE tree component both panel sections render
 * through (the bottom "build" tree and each committed selection's member tree
 * in the top section), so expandability, names, and row styling never drift.
 *
 * Renders category → group → subgroup → point with lazy expansion; the
 * subgroup/point lists (the only ones that get huge) are VIRTUALIZED over a
 * flat fixed-height item model (see virtuallist.ts). What a gesture MEANS is
 * injected per mount (`TreeGestures`) — the component only recognizes:
 *
 *   - primary click     (left down+up, movement under the threshold)
 *   - primary hold      (left press, no movement, HOLD_MS)
 *   - primary trail     (left drag past the threshold: paints forward over
 *                        rows, and UN-paints when dragged back over the trail)
 *   - secondary click   (right click / right-drag release on a row)
 *
 * The movement threshold means a jittery click can never misfire as a paint.
 * `induceTree` builds the filtered TreeModel a committed selection shows: the
 * subtree its entries cover (full counts under covered nodes, member points
 * only under partially-covered subgroups).
 */
import type { CategoryNode, GroupNode, SubgroupNode, TreeModel } from "./classification.ts";
import { entryKey, type Entry, type Hierarchy, type NodeSet } from "./sets.ts";
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
  trailStart?(): void;
  /** Trail moved forward onto a row not in the trail. */
  trailAdd?(e: Entry): void;
  /** Trail backtracked off a row (dragging back un-paints). */
  trailRemove?(e: Entry): void;
  /** Trail released; `entries` is the surviving trail in order. */
  trailEnd?(entries: Entry[]): void;
  /** Right click on a row. */
  secondaryClick(e: Entry): void;
}

export interface TreeOptions {
  /** Left px reserved in every row for the bracket gutter (bottom tree). */
  gutter?: number;
  /** Which points a subgroup drills into (filtered mounts restrict this). */
  pointsOfSubgroup?: (subgroupId: number) => number[];
  /** Apply state classes to a row (called on build and on refresh()). */
  decorate?: (e: Entry, row: HTMLElement) => void;
  /** Fired when row layout may have changed (expand/collapse/drill). */
  onLayout?: () => void;
  /** Flash a row briefly when it is secondary-clicked (focus feedback). */
  flashOnSecondary?: boolean;
}

export interface TreeHandle {
  root: HTMLElement;
  /** Re-apply decorate() to every currently rendered row. */
  refresh(): void;
  /** Visit every rendered row that is actually visible (not collapsed away). */
  forEachVisibleRow(fn: (e: Entry, el: HTMLElement) => void): void;
  dispose(): void;
}

export function mountTree(
  container: HTMLElement,
  tree: TreeModel,
  hierarchy: Hierarchy,
  gestures: TreeGestures,
  opts: TreeOptions = {},
): TreeHandle {
  container.innerHTML = "";
  const gutter = opts.gutter ?? 0;
  const pointsOf = opts.pointsOfSubgroup ?? ((s: number) => hierarchy.subgroupPoints(s));
  const scrollRoot = (container.closest("#sidebar-content") as HTMLElement) ?? container;

  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);

  const entryOf = (row: HTMLElement): Entry => ({
    level: row.dataset.level as Entry["level"],
    id: Number(row.dataset.id),
  });
  const rowUnder = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest?.(".tree-row.selectable") as HTMLElement | null;
    return row && treeRoot.contains(row) ? row : null;
  };
  const flashRow = (row: HTMLElement): void => {
    row.classList.remove("row-flash");
    void row.offsetWidth; // restart the animation
    row.classList.add("row-flash");
    row.addEventListener("animationend", () => row.classList.remove("row-flash"), { once: true });
  };

  // -- gesture recognizer (per mount; move/up delegated on window) -------------
  interface Arm {
    entry: Entry;
    x: number;
    y: number;
    moved: boolean;
    holdFired: boolean;
    holdTimer: number;
    trail: { key: string; entry: Entry }[];
  }
  let arm: Arm | null = null;

  const enterRow = (entry: Entry): void => {
    if (!arm) return;
    const key = entryKey(entry);
    const t = arm.trail;
    if (t.length > 0 && t[t.length - 1].key === key) return; // still on the same row
    const at = t.findIndex((it) => it.key === key);
    if (at >= 0) {
      // dragged back onto an earlier trail row: un-paint everything after it
      while (t.length - 1 > at) {
        const popped = t.pop()!;
        gestures.trailRemove?.(popped.entry);
      }
    } else {
      t.push({ key, entry });
      gestures.trailAdd?.(entry);
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!arm) return;
    if (!arm.moved) {
      if (Math.hypot(e.clientX - arm.x, e.clientY - arm.y) <= DRAG_THRESHOLD_PX) return;
      arm.moved = true;
      clearTimeout(arm.holdTimer);
      gestures.trailStart?.();
      enterRow(arm.entry); // the start row is part of the trail
    }
    const row = rowUnder(e.clientX, e.clientY);
    if (row) enterRow(entryOf(row));
  };
  const onUp = (e: PointerEvent): void => {
    if (!arm || e.button !== 0) return;
    const a = arm;
    arm = null;
    clearTimeout(a.holdTimer);
    if (a.moved) gestures.trailEnd?.(a.trail.map((t) => t.entry));
    else if (!a.holdFired) gestures.primaryClick(a.entry);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  const onContext = (e: MouseEvent): void => {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest?.(".tree-row.selectable") as HTMLElement | null;
    if (!row || !treeRoot.contains(row)) return;
    e.stopPropagation();
    if (opts.flashOnSecondary) flashRow(row);
    gestures.secondaryClick(entryOf(row));
  };
  container.addEventListener("contextmenu", onContext);

  // -- rows ---------------------------------------------------------------------
  const makeRow = (
    depth: number,
    text: string,
    rowOpts: { entry?: Entry; expandable?: boolean } = {},
  ): { row: HTMLElement; caret: HTMLElement } => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${6 + gutter + depth * 14}px`;

    const caret = document.createElement("span");
    caret.className = "caret row-ctl";
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
        if (e.button !== 0 || (e.target as HTMLElement).closest(".row-ctl")) return;
        e.preventDefault();
        arm = {
          entry,
          x: e.clientX,
          y: e.clientY,
          moved: false,
          holdFired: false,
          trail: [],
          holdTimer: gestures.primaryHold
            ? window.setTimeout(() => {
                if (arm && !arm.moved) {
                  arm.holdFired = true;
                  gestures.primaryHold!(entry);
                }
              }, HOLD_MS)
            : 0,
        };
      });
      opts.decorate?.(entry, row);
    }
    return { row, caret };
  };

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
        return makeRow(3, hierarchy.label(entry), { entry }).row;
      }
      const s = item.node;
      const entry: Entry = { level: "subgroup", id: s.subgroupId };
      const { row, caret } = makeRow(2, `${s.label} — ${fmt(s.pointCount)} pts`, {
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
    const { row, caret } = makeRow(
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
    const { row, caret } = makeRow(0, `${cat.label} — ${fmt(cat.pointCount)} pts`, {
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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      container.removeEventListener("contextmenu", onContext);
      for (const v of vlists) v.dispose();
      container.innerHTML = "";
    },
  };
}

// ---------------------------------------------------------------------------
// Induced (filtered) tree — the subtree a committed selection's entries cover.
// ---------------------------------------------------------------------------

export interface InducedTree {
  model: TreeModel;
  /** Drill resolver: all points under fully-covered subgroups, member points
   * only under partially-covered ones. */
  pointsOfSubgroup: (subgroupId: number) => number[];
}

export function induceTree(full: TreeModel, hierarchy: Hierarchy, set: NodeSet): InducedTree {
  const covered = (e: Entry): boolean => {
    for (const seg of hierarchy.pathOf(e)) if (set.has(seg)) return true;
    return false;
  };
  const touch = new Set<string>();
  const memberPtsBySub = new Map<number, number[]>();
  for (const e of set.listEntries()) {
    for (const seg of hierarchy.pathOf(e)) touch.add(entryKey(seg));
    if (e.level === "point") {
      const s = hierarchy.subgroupOfPoint(e.id);
      const arr = memberPtsBySub.get(s);
      if (arr) arr.push(e.id);
      else memberPtsBySub.set(s, [e.id]);
    }
  }

  const categories: CategoryNode[] = [];
  for (const cat of full.categories) {
    const cEntry: Entry = { level: "category", id: cat.categoryIndex };
    if (!covered(cEntry) && !touch.has(entryKey(cEntry))) continue;
    const groups: GroupNode[] = [];
    let subgroupCount = 0;
    for (const g of cat.groups) {
      const gEntry: Entry = { level: "group", id: g.groupId };
      const gTouched = covered(gEntry) || touch.has(entryKey(gEntry));
      if (!gTouched) continue;
      const subs: SubgroupNode[] = [];
      for (const s of g.subgroups) {
        const sEntry: Entry = { level: "subgroup", id: s.subgroupId };
        const pts = covered(sEntry)
          ? s.pointCount
          : (memberPtsBySub.get(s.subgroupId)?.length ?? 0);
        if (pts === 0 && !touch.has(entryKey(sEntry))) continue;
        subs.push({ subgroupId: s.subgroupId, label: s.label, pointCount: pts });
      }
      if (subs.length === 0) continue;
      subgroupCount += subs.length;
      groups.push({
        groupId: g.groupId,
        label: g.label,
        pointCount: subs.reduce((a, s) => a + s.pointCount, 0),
        subgroups: subs,
      });
    }
    if (groups.length === 0) continue;
    categories.push({
      categoryIndex: cat.categoryIndex,
      label: cat.label,
      pointCount: groups.reduce((a, g) => a + g.pointCount, 0),
      subgroupCount,
      groupCount: groups.length,
      bulk: cat.bulk,
      groups,
    });
  }
  return {
    model: { categories },
    pointsOfSubgroup: (subId) =>
      covered({ level: "subgroup", id: subId })
        ? hierarchy.subgroupPoints(subId)
        : (memberPtsBySub.get(subId) ?? []),
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
