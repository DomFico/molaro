/**
 * CPU point picking — pure math, no Three.js or DOM (unit-testable in Node).
 *
 * Given a frame's positions, a per-point visibility mask, and the camera's
 * view-projection matrix, find the visible point nearest to a click in screen
 * space. O(N) per click; at the design ceiling (N≈250k) that is a few
 * milliseconds for a single click — well within budget and far simpler than a
 * GPU id-buffer pass. If picking ever needs to run per-frame, that is the point
 * to switch to a GPU pass or a screen-space grid.
 *
 * `mvp` is the column-major 16-float view-projection matrix (Three's
 * `Matrix4.elements`): clip = mvp * [x, y, z, 1].
 */

export interface PickResult {
  index: number;
  /** pixel distance from the click to the picked point (Infinity if none). */
  distance: number;
}

/**
 * @param positions  3N interleaved xyz float32 for the current frame.
 * @param visible    length-N mask; entries < 0.5 are not pickable (hidden).
 * @param mvp         column-major view-projection matrix (16 floats).
 * @param ndcX,ndcY  click position in normalized device coords (-1..1, y up).
 * @param width,height  drawing buffer size in pixels (for the pixel threshold).
 * @param pixelThreshold  max screen-space distance to accept, in pixels.
 */
export function pickPoint(
  positions: Float32Array,
  nPoints: number,
  visible: Float32Array | null,
  mvp: ArrayLike<number>,
  ndcX: number,
  ndcY: number,
  width: number,
  height: number,
  pixelThreshold: number,
): PickResult {
  const m0 = mvp[0], m4 = mvp[4], m8 = mvp[8], m12 = mvp[12];
  const m1 = mvp[1], m5 = mvp[5], m9 = mvp[9], m13 = mvp[13];
  const m3 = mvp[3], m7 = mvp[7], m11 = mvp[11], m15 = mvp[15];
  const halfW = width / 2;
  const halfH = height / 2;
  const thr2 = pixelThreshold * pixelThreshold;

  let best = -1;
  let bestPixel2 = Infinity;
  // Compare in NDC first (cheap), convert the winner's distance to pixels last.
  const clickPxX = ndcX * halfW;
  const clickPxY = ndcY * halfH;

  for (let p = 0; p < nPoints; p++) {
    if (visible && visible[p] < 0.5) continue;
    const x = positions[p * 3];
    const y = positions[p * 3 + 1];
    const z = positions[p * 3 + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w <= 0) continue; // behind the camera
    const cx = m0 * x + m4 * y + m8 * z + m12;
    const cy = m1 * x + m5 * y + m9 * z + m13;
    const nx = cx / w;
    const ny = cy / w;
    if (nx < -1.05 || nx > 1.05 || ny < -1.05 || ny > 1.05) continue; // offscreen
    const dpx = nx * halfW - clickPxX;
    const dpy = ny * halfH - clickPxY;
    const d2 = dpx * dpx + dpy * dpy;
    if (d2 < bestPixel2) {
      bestPixel2 = d2;
      best = p;
    }
  }

  if (best < 0 || bestPixel2 > thr2) return { index: -1, distance: Infinity };
  return { index: best, distance: Math.sqrt(bestPixel2) };
}

/**
 * Centroid and bounding radius of a set of points at the current frame — used to
 * frame the camera on a selection (zoom-to-selection). Returns null for empty.
 */
export function selectionBounds(
  positions: Float32Array,
  indices: ArrayLike<number>,
): { center: [number, number, number]; radius: number } | null {
  const n = indices.length;
  if (n === 0) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    const p = indices[i];
    cx += positions[p * 3];
    cy += positions[p * 3 + 1];
    cz += positions[p * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let r2 = 0;
  for (let i = 0; i < n; i++) {
    const p = indices[i];
    const dx = positions[p * 3] - cx;
    const dy = positions[p * 3 + 1] - cy;
    const dz = positions[p * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(r2) };
}

/**
 * Neighbor subgroups: subgroups (drawn from `candidatePoints`) with any point
 * within `radius` of any selected point. Brute-force radius query; acceptable
 * over the non-bulk population at current scales. A spatial index (uniform grid
 * / k-d tree) is the future optimization if this gets slow.
 *
 * @param candidatePoints  point indices to consider (e.g. all non-bulk points).
 * @param subgroupOfPoint  subgroup id per point index.
 * @param selfSubgroups    subgroups already in the selection (excluded).
 */
export function neighborSubgroups(
  positions: Float32Array,
  selectedIndices: ArrayLike<number>,
  candidatePoints: ArrayLike<number>,
  subgroupOfPoint: ArrayLike<number>,
  selfSubgroups: Set<number>,
  radius: number,
): number[] {
  const r2 = radius * radius;
  const found = new Set<number>();
  const nSel = selectedIndices.length;
  const nCand = candidatePoints.length;
  for (let ci = 0; ci < nCand; ci++) {
    const cp = candidatePoints[ci];
    const sub = subgroupOfPoint[cp];
    if (selfSubgroups.has(sub) || found.has(sub)) continue;
    const x = positions[cp * 3];
    const y = positions[cp * 3 + 1];
    const z = positions[cp * 3 + 2];
    for (let si = 0; si < nSel; si++) {
      const sp = selectedIndices[si];
      const dx = positions[sp * 3] - x;
      const dy = positions[sp * 3 + 1] - y;
      const dz = positions[sp * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz <= r2) {
        found.add(sub);
        break;
      }
    }
  }
  return [...found];
}
