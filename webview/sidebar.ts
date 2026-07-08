/**
 * Classification tree — the primary direct-manipulation surface (DOM).
 *
 * Renders category → group → subgroup → point. Every row is an ENTRY at its
 * level. Gestures are TOGGLE-only (Increment 4.8): a left-click toggles the
 * entry in the ACTIVE selection group, a click-hold-drag paints (adds) each row
 * it passes, and a right-click toggles the entry in the hidden set — no
 * plain-click-replace, no modifier keys. The selection/hidden sets drive the row
 * classes back (.selected green, .hidden-entry struck-through).
 *
 * The subgroup/point lists (the only ones that get huge) are VIRTUALIZED over a
 * flat, fixed-height item model, so the full list renders with no truncation and
 * stays fast; drilling a subgroup to its points splices point items into the same
 * flat model. `revealSubgroup` expands ancestors and scrolls a subgroup into view
 * (used by 3D scroll-to-selection).
 */
import type { CategoryNode, GroupNode, SubgroupNode, TreeModel } from "./classification.ts";
import type { Entry, Hierarchy, NodeSet, SelectionModel } from "./sets.ts";
import { VirtualList } from "./virtuallist.ts";

const ROW_H = 18;

export interface SidebarActions {
  toggleSelect(e: Entry): void; // left-click
  addSelect(e: Entry): void; // paint-drag
  toggleHide(e: Entry): void; // right-click
}

export interface SidebarHandle {
  revealSubgroup(subgroupId: number): void;
}

export function mountSidebar(
  container: HTMLElement,
  tree: TreeModel,
  hierarchy: Hierarchy,
  selection: SelectionModel,
  hidden: NodeSet,
  actions: SidebarActions,
): SidebarHandle {
  container.innerHTML = "";
  const scrollRoot = (container.closest("#sidebar-content") as HTMLElement) ?? container;

  const hint = document.createElement("div");
  hint.className = "sidebar-hint";
  hint.textContent = "left-click select · drag to paint · right-click hide";
  container.appendChild(hint);

  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);

  const isSelected = (e: Entry): boolean => selection.anyHas(e);
  const isHidden = (e: Entry): boolean => hidden.has(e);
  const entryOf = (row: HTMLElement): Entry => ({
    level: row.dataset.level as Entry["level"],
    id: Number(row.dataset.id),
  });
  const applyClasses = (row: HTMLElement): void => {
    const e = entryOf(row);
    row.classList.toggle("selected", isSelected(e));
    row.classList.toggle("hidden-entry", isHidden(e));
  };

  // -- drag-paint state (shared; delegated move/up on window) ------------------
  let paint: { startEntry: Entry; moved: boolean; painted: Set<string> } | null = null;
  const rowUnder = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest?.(".tree-row.selectable") as HTMLElement | null;
    return row && treeRoot.contains(row) ? row : null;
  };
  const paintKey = (e: Entry): string => `${e.level}:${e.id}`;
  window.addEventListener("pointermove", (e) => {
    if (!paint) return;
    const row = rowUnder(e.clientX, e.clientY);
    if (!row) return;
    if (!paint.moved) {
      // first movement turns the gesture into a paint: add the start row too
      paint.moved = true;
      paint.painted.add(paintKey(paint.startEntry));
      actions.addSelect(paint.startEntry);
    }
    const entry = entryOf(row);
    const key = paintKey(entry);
    if (!paint.painted.has(key)) {
      paint.painted.add(key);
      actions.addSelect(entry);
    }
  });
  window.addEventListener("pointerup", () => {
    if (!paint) return;
    if (!paint.moved) actions.toggleSelect(paint.startEntry); // a plain click = toggle
    paint = null;
  });

  const makeRow = (
    depth: number,
    text: string,
    opts: { entry?: Entry; expandable?: boolean } = {},
  ): { row: HTMLElement; caret: HTMLElement } => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${6 + depth * 14}px`;

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = opts.expandable ? "▸" : "";
    row.appendChild(caret);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = text;
    row.appendChild(label);

    if (opts.entry) {
      const entry = opts.entry;
      row.classList.add("selectable");
      row.dataset.level = entry.level;
      row.dataset.id = String(entry.id);
      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target === caret) return;
        e.preventDefault();
        paint = { startEntry: entry, moved: false, painted: new Set() };
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        actions.toggleHide(entry);
      });
      applyClasses(row);
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
    });
  };

  // A group's subgroup+point list, virtualized over a flat, fixed-height model.
  type FlatItem = { kind: "sub"; node: SubgroupNode; expanded: boolean } | { kind: "point"; id: number };
  interface Subtree {
    vlist: VirtualList;
    reveal(subId: number): void;
  }
  const buildGroupSubtree = (group: GroupNode): Subtree => {
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
          const pts = hierarchy.subgroupPoints(s.subgroupId);
          flat.splice(at + 1, 0, ...pts.map((p) => ({ kind: "point", id: p }) as FlatItem));
          item.expanded = true;
        } else {
          let rm = 0;
          while (flat[at + 1 + rm]?.kind === "point") rm++;
          flat.splice(at + 1, rm);
          item.expanded = false;
        }
        vlist.setCount(flat.length);
      });
      return row;
    };
    vlist = new VirtualList(scrollRoot, flat.length, ROW_H, renderRow);
    return {
      vlist,
      reveal: (subId) => {
        const idx = flat.findIndex((it) => it.kind === "sub" && it.node.subgroupId === subId);
        if (idx >= 0) vlist.scrollToIndex(idx);
      },
    };
  };

  // category → group scaffolding (few of each; not virtualized)
  const catExpand = new Map<number, () => void>();
  const groupExpand = new Map<number, () => void>();
  const groupSubtree = new Map<number, Subtree>();

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
      const st = buildGroupSubtree(group);
      groupSubtree.set(group.groupId, st);
      kids.appendChild(st.vlist.el);
    });
    groupExpand.set(group.groupId, () => {
      if (kids.style.display === "none") caret.dispatchEvent(new MouseEvent("click"));
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
    catExpand.set(cat.categoryIndex, () => {
      if (kids.style.display === "none") caret.dispatchEvent(new MouseEvent("click"));
    });
  };

  for (const cat of tree.categories) buildCategory(cat);

  const refresh = (): void => {
    for (const row of treeRoot.querySelectorAll<HTMLElement>(".tree-row.selectable")) applyClasses(row);
  };
  selection.onChange(refresh);
  hidden.onChange(refresh);

  return {
    revealSubgroup: (subId) => {
      const anc = hierarchy.ancestorsOfSubgroup(subId);
      if (!anc) return;
      catExpand.get(anc.category)?.();
      groupExpand.get(anc.group)?.();
      // let the group's list mount, then scroll to the subgroup
      requestAnimationFrame(() => groupSubtree.get(anc.group)?.reveal(subId));
    },
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
