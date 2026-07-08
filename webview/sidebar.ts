/**
 * Classification tree — the primary direct-manipulation surface (DOM).
 *
 * Renders category → group → subgroup → point (drill-to-points is the fourth,
 * lazily-built level). Every row is an ENTRY at its level. Gestures drive the
 * persistent selection/hidden sets (see sets.ts); the sets drive the row classes
 * back (.selected green, .hidden-entry struck-through), so the tree and 3D view
 * stay in sync through the shared sets, not cross-surface messaging.
 *
 * Gestures (remappable): left = select, right = hide; plain = only-this,
 * Ctrl/Cmd = toggle/accumulate, Shift = range over the currently-visible rows
 * between the anchor and the clicked row (the file-explorer idiom, generalized to
 * any depth). Double-click zooms. Lazy + capped rendering keeps big trees fast.
 */
import type { CategoryNode, GroupNode, TreeModel } from "./classification.ts";
import type { Entry, Hierarchy, NodeSet } from "./sets.ts";
import { entryKey } from "./sets.ts";

const MAX_SUBGROUP_ROWS = 200;
const MAX_POINT_ROWS = 200;

export interface SidebarActions {
  selectOnly(e: Entry): void;
  selectToggle(e: Entry): void;
  selectRange(entries: Entry[]): void;
  hideToggle(e: Entry): void;
  hideRange(entries: Entry[]): void;
  zoomTo(e: Entry): void;
}

export function mountSidebar(
  container: HTMLElement,
  tree: TreeModel,
  hierarchy: Hierarchy,
  selection: NodeSet,
  hidden: NodeSet,
  actions: SidebarActions,
): void {
  container.innerHTML = "";

  const hint = document.createElement("div");
  hint.className = "sidebar-hint";
  hint.textContent = "left-click select · right-click hide · Ctrl add · Shift range";
  container.appendChild(hint);

  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);

  const rowEntry = new WeakMap<HTMLElement, Entry>();
  const selectableRows: HTMLElement[] = [];
  let anchorEl: HTMLElement | null = null;

  const visibleRows = (): HTMLElement[] =>
    selectableRows.filter((r) => r.isConnected && r.offsetParent !== null);

  const rangeEntries = (clicked: HTMLElement): Entry[] => {
    const rows = visibleRows();
    const ci = rows.indexOf(clicked);
    if (ci < 0) return [];
    const ai = anchorEl ? rows.indexOf(anchorEl) : -1;
    if (ai < 0) return [rowEntry.get(clicked)!];
    const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
    return rows.slice(lo, hi + 1).map((r) => rowEntry.get(r)!);
  };

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
      rowEntry.set(row, entry);
      selectableRows.push(row);

      row.addEventListener("click", (e) => {
        if (e.target === caret) return; // caret toggles expansion, not select
        e.stopPropagation();
        if (e.shiftKey) actions.selectRange(rangeEntries(row));
        else if (e.ctrlKey || e.metaKey) {
          actions.selectToggle(entry);
          anchorEl = row;
        } else {
          actions.selectOnly(entry);
          anchorEl = row;
        }
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) actions.hideRange(rangeEntries(row));
        else {
          actions.hideToggle(entry);
          anchorEl = row;
        }
      });
      row.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        actions.zoomTo(entry);
      });
      applyRowClasses(row, entry);
    }
    return { row, caret };
  };

  const applyRowClasses = (row: HTMLElement, entry: Entry): void => {
    row.classList.toggle("selected", selection.has(entry));
    row.classList.toggle("hidden-entry", hidden.has(entry));
  };
  const refresh = (): void => {
    for (const row of selectableRows) {
      const entry = rowEntry.get(row);
      if (entry) applyRowClasses(row, entry);
    }
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

  const buildPoints = (host: HTMLElement, subgroupId: number, depth: number): void => {
    const pts = hierarchy.subgroupPoints(subgroupId);
    for (const p of pts.slice(0, MAX_POINT_ROWS)) {
      const entry: Entry = { level: "point", id: p };
      const { row } = makeRow(depth, hierarchy.label(entry), { entry });
      host.appendChild(row);
    }
    if (pts.length > MAX_POINT_ROWS) {
      const { row } = makeRow(depth, `…and ${fmt(pts.length - MAX_POINT_ROWS)} more points`);
      host.appendChild(row);
    }
  };

  const buildGroup = (host: HTMLElement, group: GroupNode, depth: number): void => {
    const { row, caret } = makeRow(
      depth,
      `${group.label} — ${fmt(group.pointCount)} pts, ${fmt(group.subgroups.length)} sub`,
      { entry: { level: "group", id: group.groupId }, expandable: group.subgroups.length > 0 },
    );
    host.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    host.appendChild(kids);
    attachExpander(caret, kids, () => {
      for (const subNode of group.subgroups.slice(0, MAX_SUBGROUP_ROWS)) {
        const { row: sr, caret: sc } = makeRow(
          depth + 1,
          `${subNode.label} — ${fmt(subNode.pointCount)} pts`,
          { entry: { level: "subgroup", id: subNode.subgroupId }, expandable: subNode.pointCount > 0 },
        );
        kids.appendChild(sr);
        const pkids = document.createElement("div");
        pkids.style.display = "none";
        kids.appendChild(pkids);
        attachExpander(sc, pkids, () => buildPoints(pkids, subNode.subgroupId, depth + 2));
      }
      if (group.subgroups.length > MAX_SUBGROUP_ROWS) {
        const { row: more } = makeRow(
          depth + 1,
          `…and ${fmt(group.subgroups.length - MAX_SUBGROUP_ROWS)} more subgroups`,
        );
        kids.appendChild(more);
      }
    });
  };

  const buildCategory = (cat: CategoryNode): void => {
    const { row, caret } = makeRow(0, `${cat.label} — ${fmt(cat.pointCount)} pts`, {
      entry: { level: "category", id: cat.categoryIndex },
      expandable: cat.groups.length > 0,
    });
    // Wrap each category so a top/bottom dock can flow categories horizontally.
    const block = document.createElement("div");
    block.className = "cat-block";
    block.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    block.appendChild(kids);
    treeRoot.appendChild(block);
    attachExpander(caret, kids, () => {
      for (const group of cat.groups) buildGroup(kids, group, 1);
    });
  };

  for (const cat of tree.categories) buildCategory(cat);

  selection.onChange(refresh);
  hidden.onChange(refresh);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
