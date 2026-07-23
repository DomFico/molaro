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

/** The scalar axes, by ELEMENT DOMAIN. Every scalar axis takes a 1-wide
 * channel through the normalization lens; they differ only in which
 * elements they cover and how a per-POINT channel value reaches them:
 *   point axes — the element's own value;
 *   trace axes — the vertex's OWN point's value (the orientation map);
 *   edge axes  — the ENDPOINT MEAN of the edge's two points (the ruled
 *                combining rule; mean of raws, THEN the lens) — EXCEPT
 *                `bondcolorends`, which is PER-ENDPOINT by definition:
 *                each half of the edge takes its OWN endpoint's value
 *                through the lens (no mean — the whole point of the axis).
 * Edge axis tokens say "bond" because that is the verb family's
 * established vocabulary (colorbonds/bondsize/bondopacity). */
export const BIND_AXES = ["color", "size", "opacity"] as const;
export const EDGE_AXES = ["bondcolor", "bondcolorends", "bondsize", "bondopacity", "bonddash"] as const;
export const TRACE_AXES = ["tracecolor", "tracesize", "traceopacity"] as const;
export const SCALAR_AXES = [...BIND_AXES, ...EDGE_AXES, ...TRACE_AXES] as const;
export type ScalarAxis = (typeof SCALAR_AXES)[number];
/** The first vector axis: a 3-wide channel consumed RAW (no range, no
 * normalization — the A-1 ruling made min/max on 3-wide a contract
 * violation). Per-vertex "across" vectors; the oriented shapes draw it. */
export const ORIENTATION_AXIS = "orientation" as const;
/** The second vector axis: a bound 3-wide channel DISPLACES the drawn
 * positions — shown = supplied raw + bound supplied offset. Vector-on-POINT
 * (orientation is vector-on-vertex). Consumed raw like orientation; unlike
 * every other axis, releasing offset coverage ZEROES it (positions snap
 * back to raw — a frozen per-frame offset over a moving trajectory would
 * be a broken static shift). Bind-only: bake refuses it. */
export const OFFSET_AXIS = "offset" as const;
/** The vector axes: 3-wide channels consumed RAW. The gate's vector arm is
 * membership here — a third vector axis joins this list, never a second
 * gate branch. */
export const VECTOR_AXES = [ORIENTATION_AXIS, OFFSET_AXIS] as const;
export type VectorAxis = (typeof VECTOR_AXES)[number];
/** Every bindable axis. Code that MAPS scalars must take ScalarAxis; code
 * that routes bindings takes BindAxis and branches on the vector case. */
export type BindAxis = ScalarAxis | VectorAxis;
/** Which element DOMAIN an axis covers — the id space its coverage lives
 * in. Point ids, edge ids, and polyline-vertex ids overlap numerically;
 * every consumer keys releases and applies by THIS map, never by numbers
 * alone. */
export const AXIS_DOMAIN: Record<BindAxis, "point" | "edge" | "vertex"> = {
  color: "point", size: "point", opacity: "point",
  bondcolor: "edge", bondcolorends: "edge", bondsize: "edge", bondopacity: "edge",
  bonddash: "edge",
  tracecolor: "vertex", tracesize: "vertex", traceopacity: "vertex",
  orientation: "vertex",
  offset: "point",
};

/** size axis: scalar 0..1 → point size 0..BIND_SIZE_MAX (2× the base size 3 —
 * a fixed visual range, NOT an interpretation of the values). The opacity
 * axis needs no mapping: [0,1] IS its full range. Single-sourced here for
 * every scalar→axis consumer (claudebind re-exports it). */
export const BIND_SIZE_MAX = 6;
/** bonddash axis: scalar 0..1 → dash scale 0..BIND_DASH_MAX (BIND_SIZE_MAX's
 * exact pattern — a fixed visual range, NOT an interpretation of the
 * values). 0 = solid; the top of the range is a long, unmistakable period
 * (dash units are k-anchored world lengths — see DASH_SCALE, shaders.ts). */
export const BIND_DASH_MAX = 4;

/** `range` is the scalar normalization lens; NULL means a vector axis
 * (vectors are consumed raw — there is no range, by ruling). */
export type GateResult = { range: [number, number] | null } | { error: string };

/**
 * Validate one channel→axis request. `explicitRange` is a user-supplied
 * [min, max] that OVERRIDES the declaration (scalar axes only — meaningless
 * for the vector axes and refused); `values` is the per-element block in
 * hand for the current frame (length N × components), which gets the
 * finiteness spot-check on every path. Returns the normalization range to
 * use (null for a vector axis), or the loud reason nothing will be applied.
 */
export function gateChannelBind(
  decl: ChannelDecl,
  axis: string,
  explicitRange: readonly [number, number] | null,
  values: ArrayLike<number> | null,
): GateResult {
  if (
    !(VECTOR_AXES as readonly string[]).includes(axis) &&
    !(SCALAR_AXES as readonly string[]).includes(axis)
  ) {
    return { error: `unknown axis "${axis}" — use ${SCALAR_AXES.join(" | ")} | ${VECTOR_AXES.join(" | ")}` };
  }
  if (decl.scope === "per_frame") {
    return {
      error: `channel "${decl.name}" is per-frame (one value per frame — a series, not per-element); it cannot drive a point axis`,
    };
  }
  let range: readonly [number, number] | null = null;
  if ((VECTOR_AXES as readonly string[]).includes(axis)) {
    // A vector axis: width 3, consumed RAW. A range is a category error
    // (the contract already forbids min/max on 3-wide declarations; the
    // gate refuses the explicit form for the same reason).
    if (decl.components !== 3) {
      return {
        error: `${axis} needs a vector (3-wide) channel — "${decl.name}" is scalar (components: ${decl.components})`,
      };
    }
    if (explicitRange !== null) {
      return {
        error: `a min/max range is meaningless for the ${axis} axis — vector values are consumed raw`,
      };
    }
  } else {
    if (decl.components !== 1) {
      return {
        error: `channel "${decl.name}" is a vector channel (components: ${decl.components}) — the scalar axes need a scalar (1-wide) channel`,
      };
    }
    range =
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
  return { range: range === null ? null : [range[0], range[1]] };
}

/** THE normalization atom — one raw value through the range lens,
 * SATURATING: t = (v − min) / (max − min) clamped to [0,1] (the range is a
 * declared or user-given lens, not a validity bound; other frames of a
 * stream may legally exceed it). The command-cadence path
 * (normalizeScalars below) and the per-flip applier (main.ts) both ride
 * THIS function — one mapping, two cadences, no second formula. */
export function mapScalar(v: number, lo: number, hi: number): number {
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/**
 * Map raw per-element values to [0,1] scalars for the resolved points
 * (mapScalar over the selection). `values` is the whole-scene block
 * (element id → value); `points` selects and orders the output.
 */
export function normalizeScalars(
  values: ArrayLike<number>,
  points: readonly number[],
  range: readonly [number, number],
): number[] {
  const [lo, hi] = range;
  return points.map((p) => mapScalar(values[p], lo, hi));
}
