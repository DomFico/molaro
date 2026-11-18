/**
 * GHOST FRAMES — faint copies of the current representation drawn at other
 * frames, so the spread of an ensemble reads as a blur around the solid copy
 * (the PyMOL "several translucent states" look).
 *
 * SILO. Everything ghost-specific lives here. The rest of the viewer carries
 * only thin hooks that do nothing while no ghosts are set:
 *   - shaders.ts: a `uGhostAlpha` uniform (always 1.0 outside a ghost draw);
 *   - main.ts: the shared uniform on the four geometry materials, the render
 *     call routed through renderWithGhosts, and the `ghost` verb registration;
 *   - playback.ts: pinned frames (kept cached for the ghosts).
 *
 * HOW A GHOST DRAWS. The scene is drawn normally first (it writes depth). Then,
 * for each ghost frame, the host stages that frame exactly as a playhead flip
 * would — bound offsets (align / smooth), positions, every pass's per-frame
 * copy, live style bindings (ribbon orientation, live colours), the produced
 * edges' per-frame mask — and draws the scene again with uGhostAlpha < 1. With
 * the fade every instance falls in the TRANSLUCENT half, which tests depth but
 * never writes it: a ghost is hidden behind the solid copy and blends over it
 * where it sticks out. Finally the displayed frame is staged back, so picking,
 * readouts and the next draw see exactly what they saw before.
 *
 * Pure module: no THREE, no DOM.
 */

import type { CommandHandler, CommandResult } from "./commands.ts";

export interface GhostState {
  /** Frame indices to ghost, ascending, de-duplicated, in range. */
  frames: number[];
  /** Per-ghost opacity multiplier in (0, 1). */
  opacity: number;
}

/** The ONE uniform object every geometry material shares (and its translucent
 * twin, through the uniform spread). Written only by renderWithGhosts. */
export const GHOST_ALPHA: { value: number } = { value: 1 };

export const GHOST_DEFAULT_OPACITY = 0.15;
/** Each ghost redraws the whole scene; past this the frame rate suffers. */
export const GHOST_MAX = 32;

export const GHOST_USAGE =
  "ghost <frames> [opacity <0-1>] | ghost off — e.g. ghost 12 40 77 opacity 0.2, ghost 0-90:10";

/**
 * Parse `ghost` arguments.
 *   frames: integers and ranges a-b or a-b:step, separated by spaces or commas
 *   opacity <x>: the per-ghost opacity (default 0.15)
 *   off | none | clear: remove the ghosts
 *   (empty): report the current ghosts
 */
export function parseGhostArgs(
  args: string,
  nFrames: number,
): { kind: "show" } | { kind: "off" } | { kind: "set"; state: GhostState } | { kind: "error"; message: string } {
  const tokens = args.trim().split(/[\s,]+/).filter((t) => t !== "");
  if (tokens.length === 0) return { kind: "show" };
  if (tokens.length === 1 && /^(off|none|clear)$/i.test(tokens[0])) return { kind: "off" };
  let opacity = GHOST_DEFAULT_OPACITY;
  const frames = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^opacity$/i.test(t)) {
      const v = Number(tokens[i + 1]);
      if (tokens[i + 1] === undefined || !Number.isFinite(v) || v <= 0 || v >= 1) {
        return { kind: "error", message: `ghost: opacity needs a number between 0 and 1 (exclusive) — ${GHOST_USAGE}` };
      }
      opacity = v;
      i++;
      continue;
    }
    const m = /^(\d+)(?:-(\d+)(?::(\d+))?)?$/.exec(t);
    if (!m) return { kind: "error", message: `ghost: "${t}" is not a frame, a range or "opacity" — ${GHOST_USAGE}` };
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (step < 1) return { kind: "error", message: `ghost: range step must be at least 1 ("${t}")` };
    if (b < a) return { kind: "error", message: `ghost: range "${t}" runs backwards` };
    for (let f = a; f <= b; f += step) {
      if (f >= nFrames) {
        return { kind: "error", message: `ghost: frame ${f} is out of range (this trajectory has frames 0-${nFrames - 1})` };
      }
      frames.add(f);
    }
  }
  if (frames.size === 0) return { kind: "error", message: `ghost: no frames given — ${GHOST_USAGE}` };
  if (frames.size > GHOST_MAX) {
    return {
      kind: "error",
      message: `ghost: ${frames.size} frames is too many — at most ${GHOST_MAX} (each one redraws the scene); use a range step, e.g. 0-${nFrames - 1}:${Math.ceil(nFrames / GHOST_MAX)}`,
    };
  }
  return { kind: "set", state: { frames: [...frames].sort((x, y) => x - y), opacity } };
}

export function describeGhosts(s: GhostState | null): string {
  if (s === null || s.frames.length === 0) return "no ghost frames";
  const list = s.frames.length <= 12 ? s.frames.join(" ") : `${s.frames.slice(0, 12).join(" ")} … (${s.frames.length})`;
  return `${s.frames.length} ghost frame${s.frames.length === 1 ? "" : "s"} at opacity ${s.opacity}: ${list}`;
}

export interface GhostCommandContext {
  nFrames: () => number;
  get: () => GhostState | null;
  /** Install (or with null, clear) the ghost set — the host records the undo
   * op. Absent on the macro VALIDATION context: validation writes nothing. */
  set?: (s: GhostState | null) => void;
}

export function makeGhostHandler(ctx: GhostCommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (ctx.nFrames() <= 1) {
      return { status: "nomatch", message: "ghost: this is a single-frame structure — there are no other frames to ghost" };
    }
    const p = parseGhostArgs(args, ctx.nFrames());
    if (p.kind === "error") return { status: "error", message: p.message };
    if (p.kind === "show") return { status: "ok", message: `ghost: ${describeGhosts(ctx.get())}` };
    if (p.kind === "off") {
      if (ctx.get() === null) return { status: "nomatch", message: "ghost: no ghost frames to clear" };
      ctx.set?.(null);
      return { status: "ok", message: "ghost → cleared" };
    }
    ctx.set?.(p.state);
    return { status: "ok", message: `ghost → ${describeGhosts(p.state)}` };
  };
}
