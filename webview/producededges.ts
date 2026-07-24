/**
 * ProducedEdgeLayer — the host-side truth for MID-SESSION AUTHORED edges.
 *
 * A `produces: edges` mod run interactively authors edges LIVE, with no reload.
 * Those edges live HERE — a separate, independently-allocated structure — and
 * are drawn by their own isolated pass (producedEdgeTubesGenerator in main.ts).
 * They are deliberately NOT header.edges and NOT the rep.state edge buffers:
 * `EdgeTubePass`, header serialization, and every header-edge buffer stay
 * byte-for-byte untouched by construction. The GPU resize (the hard seam of a
 * growable pass) exists only in the new pass; this module owns the HOST half.
 *
 * ID DISCIPLINE — an append-only, monotonic id space:
 *   - a produced-edge id is an index into these parallel buffers AND the GPU
 *     instance slot (slot ≡ id, the EdgeTubePass never-compacted rule);
 *   - capacity only ever GROWS (geometric doubling), and a grow copies old
 *     contents to the SAME offsets — no id is ever remapped, so a captured
 *     undo id/slot can never go stale;
 *   - a group's ids never shrink or move. A RE-declared group with the SAME
 *     edge count replaces its pairs in place (authored appearance survives the
 *     recompute-and-see loop; endpoint sizes re-seed for the new endpoints). A
 *     re-declaration with a DIFFERENT count RETIRES the old span (those slots
 *     go permanently dark — visible only through the mask, never re-issued)
 *     and appends the group at fresh ids. Retired slots are the documented
 *     cost of never remapping.
 *
 * VISIBILITY is two-layered: a per-edge authored `visible` slot (the writer
 * family's axis) gated by the GROUP's active flag (the undo unit for a
 * declaration) — plus hidden-wins on the endpoints, applied in fillVisibleMask
 * exactly like the header-edge pass (an edge drops when EITHER endpoint hides).
 *
 * Pure module: no THREE, no DOM — the GPU twin lives with the pass in main.ts.
 */

import { DEFAULT_EDGE_COLOR, DEFAULT_EDGE_SIZE, DEFAULT_OPACITY } from "./representation.ts";

export interface ProducedGroup {
  baseId: number;
  count: number;
  /** false = walked back by undo (or explicitly deactivated): the group's
   * slots draw nothing, but their ids and contents stay allocated so redo
   * (and any recorded appearance op) lands on the same slots. */
  active: boolean;
}

/** First real allocation (the doubling floor). Small on purpose: the E2E
 * capacity-crossing guard authors past it with a few hundred edges. */
export const PRODUCED_EDGE_INITIAL_CAPACITY = 64;

export class ProducedEdgeLayer {
  private cap = 0;
  /** ids handed out so far — monotonic, never decremented. */
  private nextId = 0;
  private readonly byName = new Map<string, ProducedGroup>();

  /** [2 × capacity] endpoint POINT indices per edge. */
  pairs: Int32Array = new Int32Array(0);
  /** [4 × capacity] RGBA at the A end (alpha = the per-edge opacity — the
   * same interleave the header-edge pass uploads as iColorA). */
  colorA: Float32Array = new Float32Array(0);
  /** [4 × capacity] RGBA at the B end. */
  colorB: Float32Array = new Float32Array(0);
  /** [capacity] tube radius (the header-edge pass's edgeSize/iRadius twin). */
  radius: Float32Array = new Float32Array(0);
  /** [capacity] dash scale, 0 = solid (the edgeDash twin). */
  dash: Float32Array = new Float32Array(0);
  /** [capacity] endpoint-sphere size at each end — the junction-trim inputs,
   * seeded from the point size buffer and re-seeded on point-size writes. */
  sizeA: Float32Array = new Float32Array(0);
  sizeB: Float32Array = new Float32Array(0);
  /** [capacity] style registry index (0 = standard). */
  style: Float32Array = new Float32Array(0);
  /** [capacity] per-edge authored visibility (1 = drawn) — gated by the
   * group's active flag and endpoint hidden-wins in fillVisibleMask. */
  visible: Float32Array = new Float32Array(0);

  get capacity(): number {
    return this.cap;
  }

  /** Total ids ever handed out (retired spans included) — the fill span. */
  get allocated(): number {
    return this.nextId;
  }

  /**
   * THE ONLY RESIZE SURFACE: grow every buffer geometrically (double until
   * ≥ n, from the initial-capacity floor), copying old contents to the SAME
   * offsets. Returns true when a reallocation happened — the GPU pass mirrors
   * this capacity, so the caller knows a GPU grow is due. Never shrinks.
   */
  ensureCapacity(n: number): boolean {
    if (n <= this.cap) return false;
    let c = Math.max(this.cap, PRODUCED_EDGE_INITIAL_CAPACITY);
    while (c < n) c *= 2;
    const grownF = (old: Float32Array, stride: number): Float32Array => {
      const out = new Float32Array(c * stride);
      out.set(old); // verbatim, same offsets — no id remap
      return out;
    };
    const p = new Int32Array(c * 2);
    p.set(this.pairs);
    this.pairs = p;
    this.colorA = grownF(this.colorA, 4);
    this.colorB = grownF(this.colorB, 4);
    this.radius = grownF(this.radius, 1);
    this.dash = grownF(this.dash, 1);
    this.sizeA = grownF(this.sizeA, 1);
    this.sizeB = grownF(this.sizeB, 1);
    this.style = grownF(this.style, 1);
    this.visible = grownF(this.visible, 1);
    this.cap = c;
    return true;
  }

  hasGroup(name: string): boolean {
    return this.byName.has(name);
  }

  group(name: string): ProducedGroup | undefined {
    return this.byName.get(name);
  }

  /** Every group, insertion order — {name, baseId, count, active}. */
  groups(): { name: string; baseId: number; count: number; active: boolean }[] {
    return [...this.byName.entries()].map(([name, g]) => ({ name, ...g }));
  }

  /** The ids a group owns (its contiguous slot span), or null if unknown —
   * the enumeration surface a %group target resolves through later. */
  groupIds(name: string): number[] | null {
    const g = this.byName.get(name);
    if (!g) return null;
    return Array.from({ length: g.count }, (_, i) => g.baseId + i);
  }

  /**
   * Declare (or re-declare) a group's pairs. `endSizeOf` supplies the CURRENT
   * point size for each endpoint (the junction-trim seed — the layer stays
   * pure of the rep buffers). See the module doc for the id discipline; the
   * appearance of NEW slots is the header-edge pass's default look, so a
   * produced edge is indistinguishable from a load-time one until styled.
   */
  setGroup(
    name: string,
    pairs: readonly (readonly [number, number])[],
    endSizeOf: (point: number) => number,
  ): { baseId: number; count: number; grew: boolean } {
    const existing = this.byName.get(name);
    if (existing && existing.count === pairs.length) {
      // replace IN PLACE: pairs + endpoint sizes re-seed; authored appearance
      // (color/radius/dash/style/visible) survives the recompute — the
      // channel discipline (data replaced under whatever styling stands).
      const { baseId } = existing;
      for (let i = 0; i < pairs.length; i++) {
        const id = baseId + i;
        this.pairs[id * 2] = pairs[i][0];
        this.pairs[id * 2 + 1] = pairs[i][1];
        this.sizeA[id] = endSizeOf(pairs[i][0]);
        this.sizeB[id] = endSizeOf(pairs[i][1]);
      }
      existing.active = true;
      return { baseId, count: existing.count, grew: false };
    }
    if (existing) {
      // count changed: RETIRE the old span (ids never remap/shrink) — the
      // slots go dark via the mask (no group owns them) and are never reused.
      this.byName.delete(name);
    }
    const baseId = this.nextId;
    const count = pairs.length;
    const grew = this.ensureCapacity(baseId + count);
    this.nextId = baseId + count;
    for (let i = 0; i < count; i++) {
      const id = baseId + i;
      this.pairs[id * 2] = pairs[i][0];
      this.pairs[id * 2 + 1] = pairs[i][1];
      // the header-edge defaults, so an unstyled produced edge looks exactly
      // like a load-time edge (alpha rides both halves, like iColorA/iColorB)
      this.colorA[id * 4] = DEFAULT_EDGE_COLOR[0];
      this.colorA[id * 4 + 1] = DEFAULT_EDGE_COLOR[1];
      this.colorA[id * 4 + 2] = DEFAULT_EDGE_COLOR[2];
      this.colorA[id * 4 + 3] = DEFAULT_OPACITY;
      this.colorB[id * 4] = DEFAULT_EDGE_COLOR[0];
      this.colorB[id * 4 + 1] = DEFAULT_EDGE_COLOR[1];
      this.colorB[id * 4 + 2] = DEFAULT_EDGE_COLOR[2];
      this.colorB[id * 4 + 3] = DEFAULT_OPACITY;
      this.radius[id] = DEFAULT_EDGE_SIZE;
      this.dash[id] = 0;
      this.sizeA[id] = endSizeOf(pairs[i][0]);
      this.sizeB[id] = endSizeOf(pairs[i][1]);
      this.style[id] = 0;
      this.visible[id] = 1;
    }
    this.byName.set(name, { baseId, count, active: true });
    return { baseId, count, grew };
  }

  /** Activate/deactivate a whole group (the declaration's undo unit —
   * contents and ids stay put). Returns false for an unknown name. */
  setActive(name: string, active: boolean): boolean {
    const g = this.byName.get(name);
    if (!g) return false;
    g.active = active;
    return true;
  }

  /**
   * Instances to DRAW: the end of the highest ACTIVE group's span. Slot ≡ id,
   * so inactive/retired slots INSIDE the span still upload — they collapse
   * through the visibility mask, exactly like a hidden header edge. 0 when
   * no group is active: the pass draws nothing at zero cost.
   */
  activeSpan(): number {
    let span = 0;
    for (const g of this.byName.values()) {
      if (g.active) span = Math.max(span, g.baseId + g.count);
    }
    return span;
  }

  /**
   * Effective per-instance visibility over [0, allocated): group active AND
   * the per-edge authored slot AND both endpoints visible (hidden wins — the
   * header-edge pass's rule). Retired slots stay 0 (no group claims them).
   * `out` must hold at least `allocated` floats.
   */
  fillVisibleMask(pointVisible: ArrayLike<number>, out: Float32Array): void {
    out.fill(0, 0, this.nextId);
    for (const g of this.byName.values()) {
      if (!g.active) continue;
      for (let i = 0; i < g.count; i++) {
        const id = g.baseId + i;
        const a = this.pairs[id * 2];
        const b = this.pairs[id * 2 + 1];
        out[id] =
          this.visible[id] > 0.5 && pointVisible[a] > 0.5 && pointVisible[b] > 0.5 ? 1 : 0;
      }
    }
  }

  /** Re-seed the junction-trim end sizes from the CURRENT point sizes — the
   * point `size` rep-channel subscription's target. `pointIds` scopes the
   * write (undefined = every allocated edge), mirroring fillEdgeEndSizes. */
  reseedEndSizes(pointSize: ArrayLike<number>, pointIds?: readonly number[]): void {
    const scope = pointIds ? new Set(pointIds) : null;
    for (let id = 0; id < this.nextId; id++) {
      const a = this.pairs[id * 2];
      const b = this.pairs[id * 2 + 1];
      if (scope && !scope.has(a) && !scope.has(b)) continue;
      this.sizeA[id] = pointSize[a];
      this.sizeB[id] = pointSize[b];
    }
  }
}
