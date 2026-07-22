/**
 * Pure geometry preparation for the renderer: contract connectivity/positions
 * in, flat typed arrays out. No Three.js, no DOM — unit-testable in Node.
 *
 * All index output is Uint32Array pairs suitable for an indexed LineSegments
 * geometry that shares the points' position attribute, so line rendering adds
 * no copy of any position data.
 */

/** Edges [[i,j],...] -> flat segment indices [i,j, i,j, ...]. */
export function edgeSegmentIndices(edges: [number, number][]): Uint32Array {
  const out = new Uint32Array(edges.length * 2);
  for (let e = 0; e < edges.length; e++) {
    out[e * 2] = edges[e][0];
    out[e * 2 + 1] = edges[e][1];
  }
  return out;
}

/** Polylines [[a,b,c,...],...] -> flat segment indices [a,b, b,c, ...]. */
export function polylineSegmentIndices(polylines: number[][]): Uint32Array {
  let segments = 0;
  for (const poly of polylines) segments += Math.max(0, poly.length - 1);
  const out = new Uint32Array(segments * 2);
  let k = 0;
  for (const poly of polylines) {
    for (let i = 0; i + 1 < poly.length; i++) {
      out[k++] = poly[i];
      out[k++] = poly[i + 1];
    }
  }
  return out;
}

/**
 * One path segment per consecutive vertex pair, in the SAME traversal order
 * the flattened polyline-vertex axis uses (`header.polylines.flat()` — the
 * axis every trace buffer is indexed by). Segment k carries BOTH addressings
 * of its two ends: the VERTEX ids (indices into that flat axis → the trace
 * buffers) and the POINT ids (→ positions/visibility). Single-sourced on
 * purpose: instance slots, vertex ids, and point ids all come from this ONE
 * walk, so the segment list and the per-vertex buffers cannot disagree about
 * order (the "two lists that must agree" defect class). A path with fewer
 * than two vertices contributes no segments.
 */
export interface TraceSegments {
  count: number;
  /** per segment: the flat-axis VERTEX id of each end. */
  vertexA: Uint32Array;
  vertexB: Uint32Array;
  /** per segment: the POINT index of each end. */
  pointA: Uint32Array;
  pointB: Uint32Array;
}

export function traceSegments(polylines: number[][]): TraceSegments {
  let count = 0;
  for (const poly of polylines) count += Math.max(0, poly.length - 1);
  const vertexA = new Uint32Array(count);
  const vertexB = new Uint32Array(count);
  const pointA = new Uint32Array(count);
  const pointB = new Uint32Array(count);
  let k = 0;
  let base = 0; // the current path's first vertex id on the flat axis
  for (const poly of polylines) {
    for (let i = 0; i + 1 < poly.length; i++) {
      vertexA[k] = base + i;
      vertexB[k] = base + i + 1;
      pointA[k] = poly[i];
      pointB[k] = poly[i + 1];
      k++;
    }
    base += poly.length;
  }
  return { count, vertexA, vertexB, pointA, pointB };
}

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
}

// -- scene scale: the ONE source both the camera framing and the impostor
// -- world-radius constant derive from ------------------------------------
//
// Pixel parity is a relationship between the world-radius constant `k` and
// the CAMERA, not between `k` and the data: the initial framing distance is
// FRAME_DISTANCE_FACTOR * S, so as long as both consumers read the same S,
// a default-size element subtends its target pixel extent at that framing —
// even on the fallback box (a misframed camera and a misscaled `k` cancel).
// That is why S is computed here, once, and passed to both — never derived
// a second time, and never from frame data (the camera frames before any
// positions exist, and re-aiming it is frozen behavior).

/** The camera's historical fallback framing box for headers without a bbox. */
export const DEFAULT_SCENE_BOX: Box3Like = { min: [-10, -10, -10], max: [10, 10, 10] };
/** Camera field of view (degrees) — shared by the projection and `k`. */
export const CAMERA_FOV_DEG = 50;
/** Initial camera distance = this factor × the scene extent. */
export const FRAME_DISTANCE_FACTOR = 1.6;
/** Nominal viewport height (device px) pinning size-value → pixel parity:
 * at the initial framing a size-v element spans v·(H/H_NOM) px, matching the
 * pre-impostor screen-space pixel sizes at a typical viewport. */
export const NOMINAL_VIEWPORT_PX = 720;

/** The loud null-bbox warning (C1): shown whenever `sceneExtent` falls back.
 * `k` stays anchored to the default box permanently while later camera moves
 * find the real data — sizes may be misscaled for such a dataset, and that
 * must never happen quietly. */
export const NO_BBOX_WARNING =
  "⚠ header has no bbox — scene scale fell back to the default box; element sizes may be misscaled";

/** Max bbox extent + whether the fallback box was used (no bbox in the
 * header). `fallback: true` must be surfaced loudly — element sizes are
 * anchored to the default box, not the data (see the known-trade-offs doc). */
export function sceneExtent(
  bbox: Box3Like | null,
): { S: number; box: Box3Like; fallback: boolean } {
  const box = bbox ?? DEFAULT_SCENE_BOX;
  const S = Math.max(
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
    1e-3,
  );
  return { S, box, fallback: bbox === null };
}

/** World units per size-buffer unit (`k`): world radius = k × stored value,
 * for ALL THREE primitives (points/edges/traces — the 3:1:1 default ratio is
 * geometric). Derived so that at the initial camera framing a size-v element
 * projects to ≈v CSS px — the meaning size numbers always had. */
export function worldPerSizeUnit(S: number): number {
  const tanHalf = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);
  return (FRAME_DISTANCE_FACTOR * S * tanHalf) / NOMINAL_VIEWPORT_PX;
}

/** Axis-aligned bounds of an interleaved xyz float32 block (length 3*N). */
export function computeBounds(positions: Float32Array): Box3Like {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = positions[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/**
 * Pack a ribbon end's WIDTH and its instance's VISIBILITY into one float.
 *
 * The ribbon's vertex-attribute budget is 14 and it used all 14, so per-face
 * normals had nowhere to go. `iWidthA`, `iWidthB` and `iVisible` collapse into one
 * `vec2` by riding visibility on the sign of the magnitude — three attributes into
 * one, two slots freed, no precision lost.
 *
 * THE INVARIANT LIVES HERE, not in whatever produced the number. The encoding only
 * works because a width is never negative — today `parseSize` clamps negatives to
 * zero, in a different file, for reasons that have nothing to do with this packing.
 * Two things that must agree, in different places, is the shape this project has
 * paid for repeatedly, and it fails SILENTLY here: a negative width would read as
 * "hidden" and the band would vanish with nothing reporting why. So the packer
 * refuses the input rather than trusting the clamp to stay put.
 *
 * The one ambiguous case is benign by construction: a hidden end whose width is
 * exactly 0 packs to -0, which reads back as visible — and a zero width already
 * draws nothing, so the picture is identical either way.
 */
export function packRibbonWidth(magnitude: number, visible: boolean): number {
  if (!(magnitude >= 0)) {
    // NaN included — `!(x >= 0)` catches it where `x < 0` would not.
    throw new RangeError(
      `ribbon width must be non-negative to pack visibility into its sign (got ${magnitude}). ` +
      "The sign is the visibility bit; a negative magnitude would silently hide the band.",
    );
  }
  return visible ? magnitude : -magnitude;
}

/** Read back what packRibbonWidth wrote — the shader does the same two operations
 * (abs for the width, sign test for visibility), so this is what the tests pin. */
export function unpackRibbonWidth(packed: number): { magnitude: number; visible: boolean } {
  return { magnitude: Math.abs(packed), visible: !(packed < 0) };
}
