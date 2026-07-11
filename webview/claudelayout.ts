/**
 * The Claude/terminal split layout — a small explicit state object
 * (LayoutState), a PURE geometry function over it (unit-testable without a
 * browser), and a DOM controller that applies it, drives the divider drag
 * (the viewer panel's exact pointer-capture pattern), the flip/swap chrome
 * controls, and persistence through the webview state API.
 *
 * Persistence is LAYOUT ONLY — orientation, order, ratio, open — stored
 * under its own key with merge-preserve (the viewer panel's exact getState/
 * setState pattern; the API is optional and absent state or malformed
 * fields fall back to defaults, never a throw). Transcript, series, and
 * scene state remain non-persistent.
 */

export interface LayoutState {
  /** Is the Claude panel shown at all (false = the full terminal). */
  open: boolean;
  orientation: "stacked" | "side";
  order: "claude-first" | "terminal-first";
  /** The FIRST pane's share of the split axis (per `order`), clamped. */
  ratio: number;
}

export const DEFAULT_LAYOUT: LayoutState = {
  open: false,
  orientation: "stacked",
  order: "claude-first",
  ratio: 0.6,
};

/** Neither pane can be dragged to nothing. Symmetric bounds, so the swap
 * rule (ratio → 1-ratio) always lands back inside them. */
export const RATIO_MIN = 0.15;
export const RATIO_MAX = 0.85;

export function clampRatio(r: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** Swapping keeps each pane the SAME SIZE while exchanging positions: the
 * ratio (the first pane's share) complements. */
export function swapped(s: LayoutState): LayoutState {
  return {
    ...s,
    order: s.order === "claude-first" ? "terminal-first" : "claude-first",
    ratio: clampRatio(1 - s.ratio),
  };
}

/** Flipping the orientation preserves order and ratio. */
export function flipped(s: LayoutState): LayoutState {
  return { ...s, orientation: s.orientation === "stacked" ? "side" : "stacked" };
}

/** Malformed or partial persisted state NEVER breaks the panel: each field
 * validates independently and falls back to its default. */
export function parseLayout(x: unknown): LayoutState {
  const m = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return {
    open: typeof m.open === "boolean" ? m.open : DEFAULT_LAYOUT.open,
    orientation:
      m.orientation === "stacked" || m.orientation === "side"
        ? m.orientation
        : DEFAULT_LAYOUT.orientation,
    order:
      m.order === "claude-first" || m.order === "terminal-first"
        ? m.order
        : DEFAULT_LAYOUT.order,
    ratio:
      typeof m.ratio === "number" && Number.isFinite(m.ratio)
        ? clampRatio(m.ratio)
        : DEFAULT_LAYOUT.ratio,
  };
}

/** The pure state → geometry mapping the DOM applier (and the unit tests)
 * consume. Fractional flex-grow shares split the axis exactly; CSS `order`
 * arranges panes around the fixed DOM order (claude, divider, terminal). */
export interface LayoutGeometry {
  direction: "column" | "row";
  claudeOrder: number;
  termOrder: number;
  claudeGrow: number;
  termGrow: number;
}

export function layoutGeometry(s: LayoutState): LayoutGeometry {
  const claudeFirst = s.order === "claude-first";
  return {
    direction: s.orientation === "stacked" ? "column" : "row",
    claudeOrder: claudeFirst ? 0 : 2,
    termOrder: claudeFirst ? 2 : 0,
    // each share computed straight from the ratio (no double subtraction —
    // 1-(1-r) drifts in floating point)
    claudeGrow: claudeFirst ? s.ratio : 1 - s.ratio,
    termGrow: claudeFirst ? 1 - s.ratio : s.ratio,
  };
}

// -- persistence (the viewer panel's getState/setState pattern) ------------------

interface StateHost {
  getState?(): unknown;
  setState?(s: unknown): void;
}

export function loadLayout(host: StateHost): LayoutState {
  try {
    return parseLayout((host.getState?.() as { claudeLayout?: unknown } | undefined)?.claudeLayout);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(host: StateHost, s: LayoutState): void {
  try {
    host.setState?.({ ...((host.getState?.() as object | undefined) ?? {}), claudeLayout: s });
  } catch {
    /* persistence is best-effort — layout still applies in-memory */
  }
}

// -- the DOM controller ----------------------------------------------------------

export interface ClaudeLayout {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
}

export function mountClaudeLayout(host: StateHost): ClaudeLayout {
  const stack = document.getElementById("term-stack");
  const claude = document.getElementById("claude-root");
  const term = document.getElementById("term-root");
  const divider = document.getElementById("claude-divider");
  const flipBtn = document.getElementById("claude-flip");
  const swapBtn = document.getElementById("claude-swap");
  const closeBtn = document.getElementById("claude-close");
  if (!stack || !claude || !term || !divider || !flipBtn || !swapBtn || !closeBtn) {
    throw new Error("claude layout: skeleton elements missing");
  }

  let state = loadLayout(host);

  const apply = (): void => {
    const g = layoutGeometry(state);
    stack.style.flexDirection = g.direction;
    stack.classList.toggle("side", state.orientation === "side");
    claude.classList.toggle("collapsed", !state.open);
    divider.hidden = !state.open;
    claude.style.order = String(g.claudeOrder);
    term.style.order = String(g.termOrder);
    divider.style.order = "1";
    claude.style.flex = `${g.claudeGrow} 1 0`;
    term.style.flex = state.open ? `${g.termGrow} 1 0` : "1 1 0";
  };
  const commit = (): void => {
    apply();
    saveLayout(host, state);
  };

  // -- divider drag: the viewer divider's exact pointer-capture pattern ----------
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    (e.target as Element).setPointerCapture((e as PointerEvent).pointerId);
    e.preventDefault(); // no text selection mid-drag
  });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const r = stack.getBoundingClientRect();
    const pe = e as PointerEvent;
    const t =
      state.orientation === "stacked"
        ? (pe.clientY - r.top) / Math.max(r.height, 1)
        : (pe.clientX - r.left) / Math.max(r.width, 1);
    state = { ...state, ratio: clampRatio(t) }; // t IS the first pane's share
    apply();
  });
  const endDrag = (e: Event): void => {
    if (!dragging) return;
    dragging = false;
    try {
      (e.target as Element).releasePointerCapture((e as PointerEvent).pointerId);
    } catch {
      /* gone */
    }
    saveLayout(host, state);
  };
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);

  // -- chrome controls -------------------------------------------------------------
  flipBtn.addEventListener("click", () => {
    state = flipped(state);
    commit();
  });
  swapBtn.addEventListener("click", () => {
    state = swapped(state);
    commit();
  });
  const close = (): void => {
    state = { ...state, open: false };
    commit();
    document.getElementById("term-input")?.focus();
  };
  closeBtn.addEventListener("click", close);

  // restore the persisted layout at boot (no focus-stealing on restore)
  apply();

  return {
    toggle(): void {
      state = { ...state, open: !state.open };
      commit();
      if (state.open) (document.getElementById("claude-input") as HTMLInputElement | null)?.focus();
      else document.getElementById("term-input")?.focus();
    },
    close,
    isOpen(): boolean {
      return state.open;
    },
  };
}
