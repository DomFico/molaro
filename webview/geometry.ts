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

export interface Box3Like {
  min: [number, number, number];
  max: [number, number, number];
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
