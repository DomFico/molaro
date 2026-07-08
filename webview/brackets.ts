/**
 * Bracket overlay for the bottom tree — the in-tree face of selections.
 *
 * A bracket is a vertical span in the tree's left gutter covering the rows a
 * selection touches (its entries, their visible descendants, and the ancestor
 * rows on the path to them — so a collapsed tree still shows where a selection
 * lives). One GREEN bracket tracks the pending target; each committed
 * selection gets a NEUTRAL bracket (PURPLE while hidden) carrying its name.
 *
 * Brackets live INSIDE the tree host, positioned against its content, so they
 * scroll with the rows rather than floating over the viewport. A committed
 * bracket is MOVABLE: drag its name sideways to a different lane so
 * overlapping selections don't collide (persisted + undoable via
 * `SelectionModel.setLane`). Layout is recomputed rAF-debounced on model
 * change, scroll, resize, and tree expand/collapse.
 */
import { entryKey, type Entry, type SelectionModel } from "./sets.ts";
import type { TreeHandle } from "./tree.ts";

export const BRACKET_GUTTER_PX = 36;
const LANE_W = 7;
const LANE_X0 = 3;
const PENDING_X = LANE_X0 + 4 * LANE_W + 2; // pending lane sits nearest the rows

export interface BracketsHandle {
  /** Request a layout pass (rAF-coalesced). */
  schedule(): void;
  dispose(): void;
}

export function mountBrackets(
  host: HTMLElement, // the tree host (position:relative)
  tree: TreeHandle,
  model: SelectionModel,
): BracketsHandle {
  const layer = document.createElement("div");
  layer.className = "bracket-layer";
  host.appendChild(layer);

  interface Span {
    top: number;
    bottom: number;
  }

  /** Rows the given key-set/cover-predicate touches, in layer coordinates. */
  const spanFor = (covers: (e: Entry) => boolean, touch: Set<string>): Span | null => {
    const layerTop = layer.getBoundingClientRect().top;
    let top = Infinity;
    let bottom = -Infinity;
    tree.forEachVisibleRow((e, el) => {
      if (!covers(e) && !touch.has(entryKey(e))) return;
      const r = el.getBoundingClientRect();
      if (r.top - layerTop < top) top = r.top - layerTop;
      if (r.bottom - layerTop > bottom) bottom = r.bottom - layerTop;
    });
    return top === Infinity ? null : { top, bottom };
  };

  const bracketEl = (
    x: number,
    span: Span,
    cls: string,
    name: string | null,
    onDragLane: ((laneDx: number) => void) | null,
  ): HTMLElement => {
    const b = document.createElement("div");
    b.className = `bracket ${cls}`;
    b.style.left = `${x}px`;
    b.style.top = `${span.top}px`;
    b.style.height = `${Math.max(span.bottom - span.top, 6)}px`;
    if (name !== null) {
      const label = document.createElement("span");
      label.className = "bracket-name";
      label.textContent = name;
      label.title = `${name} — drag sideways to move this bracket`;
      b.appendChild(label);
    }
    if (onDragLane) {
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        b.classList.add("dragging");
        const move = (ev: PointerEvent): void => {
          b.style.transform = `translateX(${ev.clientX - startX}px)`;
        };
        const up = (ev: PointerEvent): void => {
          b.removeEventListener("pointermove", move);
          b.removeEventListener("pointerup", up);
          b.classList.remove("dragging");
          b.style.transform = "";
          onDragLane(Math.round((ev.clientX - startX) / LANE_W));
        };
        b.addEventListener("pointermove", move);
        b.addEventListener("pointerup", up);
      });
    }
    return b;
  };

  const layout = (): void => {
    layer.innerHTML = "";
    layer.style.height = `${host.scrollHeight}px`;

    // committed brackets (neutral; purple when hidden)
    for (const sel of model.committed()) {
      if (sel.set.entryCount === 0) continue;
      const touch = model.touchKeys(sel.set);
      const span = spanFor((e) => model.coversEntry(sel.set, e), touch);
      if (!span) continue;
      const cls = sel.hidden ? "committed hidden" : "committed";
      layer.appendChild(
        bracketEl(LANE_X0 + sel.lane * LANE_W, span, cls, sel.name, (laneDx) => {
          if (laneDx !== 0) model.setLane(sel.id, sel.lane + laneDx);
        }),
      );
    }

    // pending bracket (green, innermost lane, unnamed, not draggable)
    const target = model.target;
    if (target.entryCount > 0) {
      const touch = model.touchKeys(target);
      const span = spanFor((e) => model.targetCoversEntry(e), touch);
      if (span) layer.appendChild(bracketEl(PENDING_X, span, "pending", null, null));
    }
  };

  let raf = 0;
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      layout();
    });
  };

  const scrollRoot = (host.closest("#sidebar-content") as HTMLElement) ?? host;
  scrollRoot.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  window.addEventListener("panelrelayout", schedule);
  const unModel = model.onChange(schedule);
  schedule();

  return {
    schedule,
    dispose: () => {
      if (raf) cancelAnimationFrame(raf);
      scrollRoot.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("panelrelayout", schedule);
      unModel();
      layer.remove();
    },
  };
}
