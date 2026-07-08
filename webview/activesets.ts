/**
 * Active-sets surface (Increment 4.8) — the inspectable context and the future
 * agent handle. It lists each NAMED selection group as a collapsible, hierarchical
 * tree (category → group → subgroup, bottoming out at points only where points
 * were individually selected — never a flat point list), with the active group
 * marked and rename / delete / "+ new selection" controls; and the single Hidden
 * set the same hierarchical way with per-entry remove and clear.
 *
 * It only renders and dispatches intent — all mutation goes through the injected
 * actions so render buffers update incrementally in one place (main.ts). The
 * selection groups + hidden set are the clean, addressable state a future
 * agent-driven layer will read and write.
 */
import type { Entry, Hierarchy, NodeSet, SelectionModel } from "./sets.ts";
import { entryKey } from "./sets.ts";

export interface ActiveSetsActions {
  newGroup(): void;
  renameGroup(id: number, name: string): void;
  deleteGroup(id: number): void;
  setActiveGroup(id: number): void;
  removeSelectionEntry(groupId: number, e: Entry): void;
  removeHiddenEntry(e: Entry): void;
  clearHidden(): void;
}

export function mountActiveSets(
  container: HTMLElement,
  selection: SelectionModel,
  hidden: NodeSet,
  hierarchy: Hierarchy,
  actions: ActiveSetsActions,
): void {
  container.innerHTML = "";

  // ---- Selections (named groups) -------------------------------------------
  const selSection = section(container, "Selections", "sel");
  const newBtn = document.createElement("button");
  newBtn.className = "set-mini-btn";
  newBtn.textContent = "+ new";
  newBtn.title = "New selection group";
  newBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.newGroup();
  });
  selSection.head.insertBefore(newBtn, selSection.head.lastChild);

  const renderSelections = (): void => {
    const groups = selection.list();
    const totalPts = selection.resolvedPoints().length;
    selSection.title.textContent = `Selections — ${groups.length} ${
      groups.length === 1 ? "group" : "groups"
    } · ${fmt(totalPts)} pts`;
    selSection.body.innerHTML = "";
    for (const g of groups) {
      const active = g.id === selection.active.id;
      const gEl = document.createElement("div");
      gEl.className = "sel-group" + (active ? " active" : "");

      const gHead = document.createElement("div");
      gHead.className = "sel-group-head";
      const dot = document.createElement("span");
      dot.className = "sel-dot";
      dot.textContent = active ? "●" : "○";
      const name = document.createElement("span");
      name.className = "sel-group-name";
      name.textContent = `${g.name} · ${fmt(g.set.pointCount)} pts`;
      name.title = "Click to make active · double-click to rename";
      name.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.setActiveGroup(g.id);
      });
      name.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const next = window.prompt("Rename selection group", g.name);
        if (next) actions.renameGroup(g.id, next);
      });
      const del = document.createElement("span");
      del.className = "entry-remove";
      del.textContent = "✕";
      del.title = "Delete this group";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        actions.deleteGroup(g.id);
      });
      gHead.append(dot, name, del);
      gEl.appendChild(gHead);

      gEl.appendChild(
        entryTree(g.set.listEntries(), hierarchy, (e) => actions.removeSelectionEntry(g.id, e)),
      );
      selSection.body.appendChild(gEl);
    }
  };

  // ---- Hidden (single set) --------------------------------------------------
  const hidSection = section(container, "Hidden", "hid");
  const hidClear = document.createElement("button");
  hidClear.className = "set-mini-btn";
  hidClear.textContent = "clear";
  hidClear.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.clearHidden();
  });
  hidSection.head.insertBefore(hidClear, hidSection.head.lastChild);

  const renderHidden = (): void => {
    hidSection.title.textContent = `Hidden — ${hidden.entryCount} ${
      hidden.entryCount === 1 ? "entry" : "entries"
    } · ${fmt(hidden.pointCount)} pts`;
    hidClear.style.display = hidden.entryCount > 0 ? "" : "none";
    hidSection.body.innerHTML = "";
    hidSection.body.appendChild(
      entryTree(hidden.listEntries(), hierarchy, (e) => actions.removeHiddenEntry(e)),
    );
  };

  selection.onChange(renderSelections);
  hidden.onChange(renderHidden);
  renderSelections();
  renderHidden();
}

// -- a collapsible section shell --------------------------------------------
function section(
  container: HTMLElement,
  titleText: string,
  cls: "sel" | "hid",
): { head: HTMLElement; title: HTMLElement; body: HTMLElement } {
  const sec = document.createElement("div");
  sec.className = "set-section";
  container.appendChild(sec);
  const head = document.createElement("div");
  head.className = "set-head";
  const caret = document.createElement("span");
  caret.className = "set-caret";
  caret.textContent = "▸";
  const title = document.createElement("span");
  title.className = `set-title ${cls}`;
  const spacer = document.createElement("span");
  head.append(caret, title, spacer);
  sec.appendChild(head);
  const body = document.createElement("div");
  body.className = "set-entries";
  sec.appendChild(body);
  head.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    sec.classList.toggle("open");
    caret.textContent = sec.classList.contains("open") ? "▾" : "▸";
  });
  return { head, title, body };
}

// -- render a set of entries as a hierarchical tree (mirrors the classifier) --
interface TreeNode {
  label: string;
  entry?: Entry;
  children: Map<string, TreeNode>;
}

function entryTree(entries: Entry[], hierarchy: Hierarchy, onRemove: (e: Entry) => void): HTMLElement {
  const root: TreeNode = { label: "", children: new Map() };
  for (const e of entries) {
    let node = root;
    for (const seg of hierarchy.pathOf(e)) {
      const key = entryKey(seg);
      let child = node.children.get(key);
      if (!child) {
        child = { label: hierarchy.label(seg), children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.entry = e; // the leaf is the actual stored entry
  }
  const host = document.createElement("div");
  host.className = "entry-tree";
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children.values()) {
      const row = document.createElement("div");
      row.className = "entry-row";
      row.style.paddingLeft = `${8 + depth * 12}px`;
      const label = document.createElement("span");
      label.className = "entry-label";
      label.textContent = child.entry
        ? `${child.entry.level}: ${child.label} · ${fmt(hierarchy.pointCount(child.entry))} pts`
        : child.label;
      row.appendChild(label);
      if (child.entry) {
        const e = child.entry;
        const rm = document.createElement("span");
        rm.className = "entry-remove";
        rm.textContent = "✕";
        rm.title = "Remove this entry";
        rm.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onRemove(e);
        });
        row.appendChild(rm);
      } else {
        row.classList.add("structural");
      }
      host.appendChild(row);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return host;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
