/**
 * Bracket overlay for the bottom tree — the in-tree face of selections.
 *
 * A bracket is a vertical span in the tree's left gutter covering the visible
 * rows AT OR BELOW a selection's entries (an entry row or its descendants).
 * Ancestor rows do NOT carry a bracket: if the tree is collapsed above the
 * level the entries live at, the bracket simply isn't shown — it appears once
 * the view is expanded down to that level. One GREEN bracket tracks the
 * pending target; each committed selection gets a NEUTRAL bracket (PURPLE
 * while hidden) carrying its name.
 *
 * Brackets live INSIDE the tree host, positioned against its content, so they
 * scroll with the rows rather than floating over the viewport. A committed
 * bracket is MOVABLE: drag its name sideways to a different lane so
 * overlapping selections don't collide (persisted + undoable via
 * `SelectionModel.setLane`). Layout is recomputed rAF-debounced on model
 * change, scroll, resize, and tree expand/collapse.
 */
import type { Entry, NodeSet, SelectionModel } from "./sets.ts";
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

  /** CONTIGUOUS spans of the visible rows covered by `set` (entry rows or
   * descendants — never ancestors). A selection whose covered rows have gaps
   * (e.g. a painted range with the middle removed) yields several segments —
   * several brackets, one selection. Empty while nothing is expanded into
   * view. */
  const spansFor = (set: NodeSet): Span[] => {
    const layerTop = layer.getBoundingClientRect().top;
    const rows: { top: number; bottom: number }[] = [];
    tree.forEachVisibleRow((e: Entry, el) => {
      if (!model.coversEntry(set, e)) return;
      const r = el.getBoundingClientRect();
      rows.push({ top: r.top - layerTop, bottom: r.bottom - layerTop });
    });
    rows.sort((a, b) => a.top - b.top);
    const spans: Span[] = [];
    for (const r of rows) {
      const last = spans[spans.length - 1];
      if (last && r.top - last.bottom < 4) last.bottom = Math.max(last.bottom, r.bottom);
      else spans.push({ top: r.top, bottom: r.bottom });
    }
    return spans;
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
    // the NAME is not rendered in the tree (it lives in the top section);
    // it stays discoverable on hover, and the whole bracket is the drag handle
    if (name !== null) b.title = `${name} — drag sideways to move this bracket`;
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
    // Size the layer to the CONTENT height, never to a height inflated by the
    // layer's own previous size — otherwise a collapse leaves a tall empty
    // scroll area (the "blank panel below" glitch).
    layer.style.height = "0px";
    layer.style.height = `${host.scrollHeight}px`;

    // committed brackets (neutral; purple when hidden) — one bracket PER
    // CONTIGUOUS covered run; the name rides the first segment
    for (const sel of model.committed()) {
      if (sel.set.entryCount === 0) continue;
      const cls = sel.hidden ? "committed hidden" : "committed";
      spansFor(sel.set).forEach((span, i) => {
        layer.appendChild(
          bracketEl(LANE_X0 + sel.lane * LANE_W, span, cls, i === 0 ? sel.name : null, (laneDx) => {
            if (laneDx !== 0) model.setLane(sel.id, sel.lane + laneDx);
          }),
        );
      });
    }

    // pending brackets (green, innermost lane, unnamed, not draggable);
    // pulse phase-locked to the global clock (unison with the rows)
    const target = model.target;
    if (target.entryCount > 0) {
      for (const span of spansFor(target)) {
        const b = bracketEl(PENDING_X, span, "pending", null, null);
        b.style.animationDelay = `-${performance.now() % 1600}ms`;
        layer.appendChild(b);
      }
    }

    // content may have shrunk (collapse / deleted selection): keep the scroll
    // position inside the new range so the viewport never strands on blank
    const sc = host.closest("#sidebar-content") as HTMLElement | null;
    if (sc) {
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      if (sc.scrollTop > max) sc.scrollTop = max;
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
