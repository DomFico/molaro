/**
 * Classification sidebar — the primary selection surface (DOM).
 *
 * Renders the category -> group -> subgroup tree from classification.ts and
 * wires it to the SelectionStore, which the 3D view shares: clicking a node
 * selects it in both surfaces; the store's snapshot drives which row is marked
 * active, so tree and 3D stay in sync with no cross-surface messaging.
 *
 * Two rules keep a real dataset's tree fast:
 *  - **Bulk categories** render as a single summary row (count only), never
 *    enumerated by default; they can be expanded on demand.
 *  - **Lazy + capped rendering**: a node's children are built the first time it
 *    is expanded, and any subgroup list is capped (large lists show a truncation
 *    note) so even a category with thousands of subgroups never floods the DOM.
 *
 * Double-clicking a subgroup (or group) requests zoom-to-selection via the
 * injected `onZoom` callback.
 */
import type { TreeModel, CategoryNode, GroupNode } from "./classification.ts";
import type { SelectionSnapshot, SelectionStore } from "./selection.ts";

/** Max subgroup rows rendered under one group before truncating. */
const MAX_SUBGROUP_ROWS = 200;

interface SidebarCallbacks {
  onZoom: (kind: "subgroup" | "group", id: number) => void;
}

export function mountSidebar(
  container: HTMLElement,
  tree: TreeModel,
  selection: SelectionStore,
  callbacks: SidebarCallbacks,
): void {
  container.innerHTML = "";

  const readout = document.createElement("div");
  readout.className = "sel-readout";
  readout.textContent = "no selection";
  container.appendChild(readout);

  const hint = document.createElement("div");
  hint.className = "sidebar-hint";
  hint.textContent = "click a row to select · double-click to zoom";
  container.appendChild(hint);

  const treeRoot = document.createElement("div");
  treeRoot.className = "tree";
  container.appendChild(treeRoot);

  // Rows that carry a selectable target register here so the active-selection
  // highlight can be applied from the store snapshot.
  interface Selectable {
    el: HTMLElement;
    kind: "subgroup" | "group" | "category";
    id: number;
  }
  const selectables: Selectable[] = [];

  const makeRow = (
    depth: number,
    text: string,
    opts: {
      selectable?: { kind: "subgroup" | "group" | "category"; id: number };
      expandable?: boolean;
      muted?: boolean;
    } = {},
  ): { row: HTMLElement; caret: HTMLElement; label: HTMLElement } => {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${6 + depth * 14}px`;
    if (opts.muted) row.classList.add("muted");

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = opts.expandable ? "▸" : "";
    row.appendChild(caret);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = text;
    row.appendChild(label);

    if (opts.selectable) {
      const sel = opts.selectable;
      row.classList.add("selectable");
      selectables.push({ el: row, kind: sel.kind, id: sel.id });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (sel.kind === "subgroup") selection.selectSubgroup(sel.id);
        else if (sel.kind === "group") selection.selectGroup(sel.id);
        else selection.selectCategory(sel.id);
      });
      if (sel.kind !== "category") {
        row.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          callbacks.onZoom(sel.kind as "subgroup" | "group", sel.id);
        });
      }
    }
    return { row, caret, label };
  };

  // Lazy expander: builds children on first expand, toggles thereafter.
  const attachExpander = (
    caret: HTMLElement,
    header: HTMLElement,
    childHost: HTMLElement,
    build: () => void,
  ): void => {
    let built = false;
    let open = false;
    const toggle = (e: Event) => {
      e.stopPropagation();
      open = !open;
      if (open && !built) {
        build();
        built = true;
      }
      childHost.style.display = open ? "block" : "none";
      caret.textContent = open ? "▾" : "▸";
    };
    caret.addEventListener("click", toggle);
    // Clicking the caret toggles; clicking the label selects (wired elsewhere).
  };

  const buildGroup = (host: HTMLElement, group: GroupNode, depth: number): void => {
    const { row, caret } = makeRow(depth, `${group.label} — ${fmt(group.pointCount)} pts, ${fmt(group.subgroups.length)} sub`, {
      selectable: { kind: "group", id: group.groupId },
      expandable: group.subgroups.length > 0,
    });
    host.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    host.appendChild(kids);
    attachExpander(caret, row, kids, () => {
      const shown = group.subgroups.slice(0, MAX_SUBGROUP_ROWS);
      for (const sub of shown) {
        const { row: sr } = makeRow(depth + 1, `${sub.label} — ${fmt(sub.pointCount)} pts`, {
          selectable: { kind: "subgroup", id: sub.subgroupId },
        });
        kids.appendChild(sr);
      }
      if (group.subgroups.length > MAX_SUBGROUP_ROWS) {
        const { row: more } = makeRow(depth + 1, `…and ${fmt(group.subgroups.length - MAX_SUBGROUP_ROWS)} more subgroups`, { muted: true });
        kids.appendChild(more);
      }
    });
  };

  const buildCategory = (cat: CategoryNode): void => {
    const summary = cat.bulk
      ? `${cat.label} — ${fmt(cat.pointCount)} pts, ${fmt(cat.subgroupCount)} subgroups (bulk)`
      : `${cat.label} — ${fmt(cat.pointCount)} pts`;
    const { row, caret } = makeRow(0, summary, {
      selectable: { kind: "category", id: cat.categoryIndex },
      expandable: cat.groups.length > 0,
      muted: cat.bulk,
    });
    treeRoot.appendChild(row);
    const kids = document.createElement("div");
    kids.style.display = "none";
    treeRoot.appendChild(kids);
    attachExpander(caret, row, kids, () => {
      for (const group of cat.groups) buildGroup(kids, group, 1);
    });
  };

  for (const cat of tree.categories) buildCategory(cat);

  // -- selection reflection ---------------------------------------------------
  selection.subscribe((snap: SelectionSnapshot) => {
    const d = snap.descriptor;
    for (const s of selectables) {
      const active = d.kind === s.kind && d.id === s.id;
      s.el.classList.toggle("active", active);
    }
    readout.textContent = renderReadout(snap);
  });
}

function renderReadout(snap: SelectionSnapshot): string {
  const d = snap.descriptor;
  if (d.kind === "none" || snap.indices.length === 0) return "no selection";
  const kindLabel = d.kind === "subgroup" ? "subgroup" : d.kind;
  let text = `${kindLabel}: ${d.label} · ${fmt(snap.indices.length)} pts`;
  if (snap.neighborSubgroups.length > 0) {
    text += ` · +${fmt(snap.neighborSubgroups.length)} neighbor subgroups`;
  }
  return text;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
