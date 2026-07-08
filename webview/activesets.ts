/**
 * Active-sets surface — the inspectable, collapsible view of the two persistent
 * sets (Selected / Hidden). It is deliberately the SHARED-CONTEXT representation:
 * it is what a future agent-driven layer will read ("analyze what's selected")
 * and write ("hide the solvent"). It shows each set's ENTRIES with a count and a
 * per-entry remove control, plus clear-all; collapsed by default (summaries only).
 *
 * It only renders and dispatches intent — all mutation goes through the injected
 * actions so render buffers update incrementally in one place (main.ts).
 */
import type { Entry, Hierarchy, NodeSet } from "./sets.ts";

export interface ActiveSetsActions {
  removeEntry: (kind: "selection" | "hidden", e: Entry) => void;
  clearSet: (kind: "selection" | "hidden") => void;
}

export function mountActiveSets(
  container: HTMLElement,
  selection: NodeSet,
  hidden: NodeSet,
  hierarchy: Hierarchy,
  actions: ActiveSetsActions,
): void {
  container.innerHTML = "";
  const sel = buildSection(container, "Selected", "sel", selection, hierarchy, actions);
  const hid = buildSection(container, "Hidden", "hid", hidden, hierarchy, actions);
  selection.onChange(sel.render);
  hidden.onChange(hid.render);
  sel.render();
  hid.render();
}

function buildSection(
  container: HTMLElement,
  title: string,
  cls: "sel" | "hid",
  set: NodeSet,
  hierarchy: Hierarchy,
  actions: ActiveSetsActions,
): { render: () => void } {
  const kind = cls === "sel" ? "selection" : "hidden";

  const section = document.createElement("div");
  section.className = "set-section"; // collapsed by default (no .open)
  container.appendChild(section);

  const head = document.createElement("div");
  head.className = "set-head";
  const caret = document.createElement("span");
  caret.className = "set-caret";
  caret.textContent = "▸";
  const titleEl = document.createElement("span");
  titleEl.className = `set-title ${cls}`;
  const clearBtn = document.createElement("button");
  clearBtn.className = "set-clear";
  clearBtn.textContent = "clear";
  clearBtn.title = `Clear all ${title.toLowerCase()}`;
  head.append(caret, titleEl, clearBtn);
  section.appendChild(head);

  const entriesEl = document.createElement("div");
  entriesEl.className = "set-entries";
  section.appendChild(entriesEl);

  head.addEventListener("click", (e) => {
    if (e.target === clearBtn) return;
    section.classList.toggle("open");
    caret.textContent = section.classList.contains("open") ? "▾" : "▸";
  });
  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    actions.clearSet(kind);
  });

  const render = (): void => {
    titleEl.textContent = `${title} — ${set.entryCount} ${
      set.entryCount === 1 ? "entry" : "entries"
    } · ${fmt(set.pointCount)} pts`;
    clearBtn.style.display = set.entryCount > 0 ? "" : "none";
    entriesEl.innerHTML = "";
    for (const entry of set.listEntries()) {
      entriesEl.appendChild(entryRow(entry, hierarchy, () => actions.removeEntry(kind, entry)));
    }
  };
  return { render };
}

function entryRow(entry: Entry, hierarchy: Hierarchy, onRemove: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "entry-row";
  const label = document.createElement("span");
  label.className = "entry-label";
  label.textContent = `${entry.level}: ${hierarchy.label(entry)} · ${fmt(hierarchy.pointCount(entry))} pts`;
  const remove = document.createElement("span");
  remove.className = "entry-remove";
  remove.textContent = "✕";
  remove.title = "Remove this entry";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  row.append(label, remove);
  return row;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
