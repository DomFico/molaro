/**
 * The channel→axis GATE and MAPPING — the one choke point between a declared
 * data channel and a representation axis. Written for TWO consumers so they
 * cannot diverge:
 *
 *   Tier 1 (today): `bake <target> <channel> <axis>` — a one-time recorded
 *     write of the displayed frame's values through the per-element writers.
 *   Tier 2 (next): `bind` — a live per-flip re-derive. The bind verb MUST
 *     validate through gateChannelBind and map through normalizeScalars;
 *     growing a second gate or a second normalization is the "two lists that
 *     must agree" defect this module exists to prevent.
 *
 * The gate is where a bind/bake fails LOUDLY: scope, width, range, and a
 * finiteness spot-check of the values in hand (the CURRENT frame only —
 * future frames haven't streamed, and positions set the precedent that block
 * content is otherwise trusted). Nothing applies on failure; every error
 * names its reason.
 *
 * Pure module: no DOM, no Three, no imports from the command layer.
 */

/** What the gate reads of a header channel declaration. `components` is the
 * RESOLVED width (the contract's channelComponents already applied). */
export interface ChannelDecl {
  name: string;
  scope: "per_point" | "per_frame" | "per_point_per_frame";
  components: number;
  min?: number;
  max?: number;
}

/** The point axes a scalar channel can drive — the same three the typed-result
 * binding writes. Orientation (the 3-wide axis) is deliberately NOT here yet:
 * it arrives with the oriented generator, and the gate's width check below is
 * where it will unlock. */
export const BIND_AXES = ["color", "size", "opacity"] as const;
export type BindAxis = (typeof BIND_AXES)[number];

/** size axis: scalar 0..1 → point size 0..BIND_SIZE_MAX (2× the base size 3 —
 * a fixed visual range, NOT an interpretation of the values). The opacity
 * axis needs no mapping: [0,1] IS its full range. Single-sourced here for
 * every scalar→axis consumer (claudebind re-exports it). */
export const BIND_SIZE_MAX = 6;

export type GateResult = { range: [number, number] } | { error: string };

/**
 * Validate one channel→axis request. `explicitRange` is a user-supplied
 * [min, max] that OVERRIDES the declaration; `values` is the per-element
 * block in hand for the current frame (length N × components), which gets
 * the finiteness spot-check. Returns the normalization range to use, or the
 * loud reason nothing will be applied.
 */
export function gateChannelBind(
  decl: ChannelDecl,
  axis: string,
  explicitRange: readonly [number, number] | null,
  values: ArrayLike<number> | null,
): GateResult {
  if (axis === "orientation") {
    // The 3-wide axis is real in the design but has NO consumer: the
    // oriented shape generator does not exist yet. Loud refusal, never a
    // silent no-op — this line is the entire orientation story for now.
    return {
      error: `no consumer for the orientation axis yet (the oriented shape generator does not exist) — bindable axes: ${BIND_AXES.join(" | ")}`,
    };
  }
  if (!(BIND_AXES as readonly string[]).includes(axis)) {
    return { error: `unknown axis "${axis}" — use ${BIND_AXES.join(" | ")}` };
  }
  if (decl.scope === "per_frame") {
    return {
      error: `channel "${decl.name}" is per-frame (one value per frame — a series, not per-element); it cannot drive a point axis`,
    };
  }
  if (decl.components !== 1) {
    return {
      error: `channel "${decl.name}" is a vector channel (components: ${decl.components}) — ${BIND_AXES.join("/")} need a scalar (1-wide) channel`,
    };
  }
  const range: readonly [number, number] | null =
    explicitRange ??
    (decl.min !== undefined && decl.max !== undefined ? [decl.min, decl.max] : null);
  if (range === null) {
    return {
      error: `channel "${decl.name}" does not declare a full min/max range — pass one explicitly: <min> <max>`,
    };
  }
  if (!(range[0] < range[1])) {
    return {
      error: `empty range ${range[0]}..${range[1]} — min must be strictly less than max`,
    };
  }
  if (values === null) {
    return { error: `no values in hand for channel "${decl.name}" at the current frame` };
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      return {
        error: `channel "${decl.name}" has a non-finite value at element ${Math.floor(i / decl.components)} (current frame) — nothing applied`,
      };
    }
  }
  return { range: [range[0], range[1]] };
}

/**
 * Map raw per-element values to [0,1] scalars for the resolved points:
 * t = (v − min) / (max − min), CLAMPED to [0,1] — values outside the range
 * saturate rather than reject (the range is a declared or user-given lens,
 * not a validity bound; other frames of a stream may legally exceed it).
 * `values` is the whole-scene block (element id → value); `points` selects
 * and orders the output.
 */
export function normalizeScalars(
  values: ArrayLike<number>,
  points: readonly number[],
  range: readonly [number, number],
): number[] {
  const [lo, hi] = range;
  const span = hi - lo;
  return points.map((p) => Math.min(1, Math.max(0, (values[p] - lo) / span)));
}
