/**
 * Top section — the committed selections (the "operate" surface).
 *
 * Lists every `CommittedSelection` as a named block whose body is the SAME
 * tree component the bottom section uses (see tree.ts), induced to the
 * selection's members — full expandability, same names, same row styling.
 *
 * Gestures (operate, never build):
 *   - left-click a row / the name  → focus the camera on it (yellow pulse)
 *   - left-hold                    → frame the whole selection
 *   - left-drag over rows          → frame the dragged range (back = shrink)
 *   - right-click anywhere in a block → toggle HIDDEN (purple label,
 *     points invisible); camera does not move
 *   - Edit  → the selection becomes the current TARGET (edit mode); member
 *     rows grow a ✕ remove control; the viewer button reads "Done"
 *   - double-click the name (or ✎) → inline rename (unique names)
 *   - ✕ on the header → delete the selection
 *
 * Pure view: renders and dispatches intent through `CommittedActions`; all
 * state lives in SelectionModel and all render-buffer flips happen in main.ts.
 */
import type { TreeModel } from "./classification.ts";
import type { CommittedSelection, Entry, Hierarchy, SelectionModel } from "./sets.ts";
import { induceTree, mountTree, type TreeHandle } from "./tree.ts";

export interface CommittedActions {
  focusEntry(e: Entry): void;
  focusPoints(points: number[]): void;
  toggleHidden(id: number): void;
  beginEdit(id: number): void;
  endEdit(): void;
  rename(id: number, name: string): boolean;
  deleteSelection(id: number): void;
  /** Remove a member entry while its selection is in edit mode. */
  removeEntry(e: Entry): void;
}

export interface CommittedHandle {
  /** Rebuild if the committed state changed (cheap no-op otherwise). */
  render(): void;
}

export function mountCommitted(
  container: HTMLElement,
  model: SelectionModel,
  hierarchy: Hierarchy,
  fullTree: TreeModel,
  actions: CommittedActions,
): CommittedHandle {
  const openState = new Map<number, boolean>();
  const mounted: TreeHandle[] = [];
  let lastSig = "";

  const signature = (): string => {
    const parts = model
      .committed()
      .map((c) => `${c.id}:${c.name}:${c.hidden ? 1 : 0}:${c.set.entryCount}`);
    return `${model.editing?.id ?? -1}|${parts.join("|")}`;
  };

  const render = (): void => {
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;

    for (const t of mounted) t.dispose();
    mounted.length = 0;
    container.innerHTML = "";

    const head = document.createElement("div");
    head.className = "sel-section-head";
    const list = model.committed();
    head.textContent = `Selections — ${list.length}`;
    container.appendChild(head);

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sel-empty";
      empty.textContent = "none yet — build below, then “Create selection”";
      container.appendChild(empty);
      return;
    }

    for (const sel of list) container.appendChild(block(sel));
  };

  const block = (sel: CommittedSelection): HTMLElement => {
    const editingThis = model.editing?.id === sel.id;
    const el = document.createElement("div");
    el.className =
      "sel-block" + (sel.hidden ? " hidden-sel" : "") + (editingThis ? " editing" : "");

    // -- header -----------------------------------------------------------------
    const head = document.createElement("div");
    head.className = "sel-head";

    const caret = document.createElement("span");
    caret.className = "caret row-ctl";
    caret.textContent = openState.get(sel.id) ? "▾" : "▸";

    const name = document.createElement("span");
    name.className = "sel-name";
    name.textContent = sel.name;
    name.title = "click: focus · double-click: rename · right-click: hide/show";

    const count = document.createElement("span");
    count.className = "sel-count";
    count.textContent = `${fmt(sel.set.pointCount)} pts${sel.hidden ? " · hidden" : ""}`;

    const editBtn = document.createElement("button");
    editBtn.className = "sel-ctl row-ctl";
    editBtn.textContent = editingThis ? "done" : "edit";
    editBtn.title = editingThis
      ? "Stop editing this selection"
      : "Edit: new manipulations add to this selection";

    const renameBtn = document.createElement("button");
    renameBtn.className = "sel-ctl row-ctl";
    renameBtn.textContent = "✎";
    renameBtn.title = "Rename";

    const delBtn = document.createElement("button");
    delBtn.className = "sel-ctl row-ctl";
    delBtn.textContent = "✕";
    delBtn.title = "Delete this selection";

    head.append(caret, name, count, editBtn, renameBtn, delBtn);
    el.appendChild(head);

    // -- body: the member tree (shared component, induced model) -----------------
    const body = document.createElement("div");
    body.className = "sel-body";
    body.style.display = openState.get(sel.id) ? "" : "none";
    el.appendChild(body);

    let built = false;
    const buildBody = (): void => {
      if (built) return;
      built = true;
      const induced = induceTree(fullTree, hierarchy, sel.set);
      const tree = mountTree(
        body,
        induced.model,
        hierarchy,
        {
          primaryClick: (e) => actions.focusEntry(e),
          primaryHold: () => actions.focusPoints(sel.set.resolvedPoints()),
          trailEnd: (entries) => {
            const pts: number[] = [];
            for (const e of entries) pts.push(...hierarchy.pointsOf(e));
            actions.focusPoints(pts);
          },
          secondaryClick: () => actions.toggleHidden(sel.id),
        },
        {
          pointsOfSubgroup: induced.pointsOfSubgroup,
          flashOnSecondary: false,
          decorate: (e, row) => {
            row.querySelector(".entry-remove")?.remove();
            if (editingThis && sel.set.has(e)) {
              const rm = document.createElement("span");
              rm.className = "entry-remove row-ctl";
              rm.textContent = "✕";
              rm.title = "Remove this entry from the selection";
              rm.addEventListener("pointerdown", (ev) => ev.stopPropagation());
              rm.addEventListener("click", (ev) => {
                ev.stopPropagation();
                actions.removeEntry(e);
              });
              row.appendChild(rm);
            }
          },
        },
      );
      mounted.push(tree);
    };
    if (openState.get(sel.id)) buildBody();

    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !(openState.get(sel.id) ?? false);
      openState.set(sel.id, open);
      if (open) buildBody();
      body.style.display = open ? "" : "none";
      caret.textContent = open ? "▾" : "▸";
      window.dispatchEvent(new Event("panelrelayout"));
    });

    // header gestures: click name = focus whole selection; dblclick = rename
    name.addEventListener("click", () => actions.focusPoints(sel.set.resolvedPoints()));
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRename();
    });
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename();
    });
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editingThis) actions.endEdit();
      else actions.beginEdit(sel.id);
    });
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      actions.deleteSelection(sel.id);
    });
    // right-click anywhere in the block toggles hidden (the "operate" hide)
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      actions.toggleHidden(sel.id);
    });

    const startRename = (): void => {
      const input = document.createElement("input");
      input.className = "rename-input";
      input.value = sel.name;
      name.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (apply: boolean): void => {
        if (done) return;
        done = true;
        if (apply && input.value.trim() && input.value.trim() !== sel.name) {
          if (!actions.rename(sel.id, input.value)) input.classList.add("rename-bad");
        }
        lastSig = ""; // force re-render to restore the label
        render();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // keep Escape/Ctrl+Z global handlers out of typing
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(false));
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
    };

    return el;
  };

  render();
  return { render };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}
