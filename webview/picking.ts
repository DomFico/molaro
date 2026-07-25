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
 * Segments drawn BETWEEN points — edges (bonds) and the segments of a trace /
 * ribbon. Each drawn body has a WIDTH, so the click target is a capsule (the
 * segment thickened by its half-width), not a pair of endpoint dots. Parallel
 * typed arrays, one entry per drawn segment, all indexed the same way:
 *
 *   - `pointA[s]` / `pointB[s]` — the two endpoints' POINT indices (into
 *     `positions` / `visible`, and the id a body-click resolves to).
 *   - `halfA[s]`  / `halfB[s]`  — the SIZE-BUFFER VALUE at each end
 *     (`edgeSize[e]` for an edge — same at both ends; `traceSize[vertex]` for
 *     a trace/ribbon segment — per-end). World half-width = `worldPerSize ×
 *     value`, exactly the tube radius / ribbon half-width the shader draws.
 *     Zero ⇒ collapsed ⇒ never covers, matching the shader's zero-radius
 *     discard.
 *
 * The caller supplies STATIC connectivity once and refreshes the half-width
 * values from the live representation buffers before each pick.
 */
export interface PickSegments {
  count: number;
  pointA: ArrayLike<number>;
  pointB: ArrayLike<number>;
  halfA: ArrayLike<number>;
  halfB: ArrayLike<number>;
}

/**
 * The size-aware geometry a click is tested against: how each candidate's
 * RENDERED extent is derived, so the hit test matches what is actually drawn
 * instead of a fixed pixel radius.
 */
export interface PickGeometry {
  /** per-point size-buffer value (length N) — `rep.state.size`. World sphere
   * radius = `worldPerSize × pointSize[p]`, the impostor's drawn radius. */
  pointSize: ArrayLike<number>;
  /** world units per size-buffer unit (`k`); the ONE scene-scale constant the
   * renderer multiplies every stored size by (geometry.worldPerSizeUnit). */
  worldPerSize: number;
  /** `tan(vertical_fov / 2)` — the projection's vertical half-angle. The
   * impostor sizes by the drawing-buffer HEIGHT, so this (with the CSS pixel
   * height below) reconstructs the exact on-screen radius the shader draws. */
  tanHalfFov: number;
  /** drawn segments (edges + trace/ribbon), or null when the scene has none. */
  segments?: PickSegments | null;
}

/**
 * SIZE-AWARE pick — resolve a click to the element whose RENDERED extent
 * actually covers the cursor, not merely the nearest projected CENTER.
 *
 * The former hit test (`pickPoint`) projected every point's CENTER and took the
 * nearest within a FIXED pixel radius. That ignores how big each element is
 * drawn: clicking a fat sphere, or the body of a thick tube / wide ribbon,
 * would snap to some nearer-center smaller point instead of the thing under the
 * cursor. This walks the SAME O(N) projection but gives every candidate the
 * hit extent it is DRAWN with:
 *
 *   - a POINT covers the cursor when the click lies within its projected sphere
 *     radius (`worldPerSize × size / depth`, in CSS px);
 *   - a SEGMENT (edge / trace / ribbon body) covers the cursor when the click
 *     lies within its projected half-width of the drawn segment — the
 *     distance-to-segment-within-half-width capsule test — and resolves to the
 *     nearer endpoint (t ≤ ½ ⇒ A, else B).
 *
 * Among ALL candidates that cover the cursor, the FRONT-MOST (smallest view
 * depth) wins — matching what the user sees on top when drawn shapes overlap.
 * If NOTHING covers the cursor, it falls back to the legacy nearest-CENTER test
 * within `basePixelThreshold`, so a small/precise element still picks exactly
 * and clicking empty space near it never over-grabs.
 *
 * The size-aware reach only EXTENDS the legacy pick — it never shrinks or
 * reorders it. A point is a "cover" candidate only where its DRAWN radius
 * exceeds `basePixelThreshold`: within that base radius the precise
 * nearest-center rule stays authoritative, so a default-size scene resolves
 * byte-for-byte as before (two default dots a couple of px apart still pick by
 * proximity, never by depth). Front-most ordering therefore engages only among
 * genuinely large silhouettes — the enlarged spheres and thick tube/ribbon
 * bodies this fix is about — which is exactly where "what's on top" matters.
 *
 * Pure math, CPU-side, no GPU readback — same cost class as `pickPoint`.
 *
 * @param positions  3N interleaved xyz float32 for the current frame.
 * @param nPoints    point count.
 * @param visible    length-N mask; entries < 0.5 are not pickable (hidden).
 * @param mvp        column-major view-projection matrix (16 floats).
 * @param ndcX,ndcY  click position in normalized device coords (-1..1, y up).
 * @param width,height  drawing buffer size in CSS px.
 * @param basePixelThreshold  fallback nearest-center radius (the legacy value).
 * @param geom       the rendered-size inputs (see PickGeometry).
 */
export function pickElement(
  positions: Float32Array,
  nPoints: number,
  visible: Float32Array | null,
  mvp: ArrayLike<number>,
  ndcX: number,
  ndcY: number,
  width: number,
  height: number,
  basePixelThreshold: number,
  geom: PickGeometry,
): PickResult {
  const m0 = mvp[0], m4 = mvp[4], m8 = mvp[8], m12 = mvp[12];
  const m1 = mvp[1], m5 = mvp[5], m9 = mvp[9], m13 = mvp[13];
  const m3 = mvp[3], m7 = mvp[7], m11 = mvp[11], m15 = mvp[15];
  const halfW = width / 2;
  const halfH = height / 2;
  const clickPxX = ndcX * halfW;
  const clickPxY = ndcY * halfH;
  // px per (worldRadius / viewDepth): a world radius r at clip.w = depth spans
  // r · pxScale / depth CSS px vertically — the impostor's height-based sizing.
  const pxScale = height / (2 * geom.tanHalfFov);
  const k = geom.worldPerSize;

  // FRONT-MOST-covering winner (across points AND segments) — smallest depth.
  let coverIndex = -1;
  let coverDepth = Infinity;
  let coverDist = Infinity;
  // Legacy fallback: nearest point CENTER within basePixelThreshold.
  let fbIndex = -1;
  let fbPixel2 = basePixelThreshold * basePixelThreshold;

  // Project a point to CSS px; returns depth (clip.w, positive in front) or a
  // non-positive value when behind the camera. Writes sx/sy into `out`.
  const out = { sx: 0, sy: 0 };
  const project = (p: number): number => {
    const x = positions[p * 3];
    const y = positions[p * 3 + 1];
    const z = positions[p * 3 + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w <= 0) return w; // behind the camera
    out.sx = ((m0 * x + m4 * y + m8 * z + m12) / w) * halfW;
    out.sy = ((m1 * x + m5 * y + m9 * z + m13) / w) * halfH;
    return w;
  };

  // -- point candidates -------------------------------------------------------
  const pointSize = geom.pointSize;
  for (let p = 0; p < nPoints; p++) {
    if (visible && visible[p] < 0.5) continue;
    const w = project(p);
    if (w <= 0) continue;
    const sx = out.sx, sy = out.sy;
    // offscreen cull (same slack as the legacy test): NDC beyond ±1.05.
    if (sx < -1.05 * halfW || sx > 1.05 * halfW || sy < -1.05 * halfH || sy > 1.05 * halfH) continue;
    const dpx = sx - clickPxX;
    const dpy = sy - clickPxY;
    const d2 = dpx * dpx + dpy * dpy;
    // size-aware reach: an ENLARGED sphere (drawn radius past the base
    // threshold) covers the cursor out to its silhouette. Small default
    // spheres are NOT cover candidates — they resolve through the legacy
    // nearest-center fallback below, so default scenes are unchanged.
    const rPx = k * pointSize[p] * pxScale / w;
    if (rPx > basePixelThreshold && d2 <= rPx * rPx && w < coverDepth) {
      coverDepth = w;
      coverIndex = p;
      coverDist = Math.sqrt(d2);
    }
    // legacy nearest-center pick (unchanged): closest center within threshold.
    if (d2 < fbPixel2) {
      fbPixel2 = d2;
      fbIndex = p;
    }
  }

  // -- segment candidates (edges + trace/ribbon bodies) -----------------------
  const seg = geom.segments;
  if (seg && seg.count > 0) {
    for (let s = 0; s < seg.count; s++) {
      const a = seg.pointA[s];
      const b = seg.pointB[s];
      if (visible && (visible[a] < 0.5 || visible[b] < 0.5)) continue; // tube collapses if either end hidden
      const wA = project(a);
      if (wA <= 0) continue;
      const axA = out.sx, ayA = out.sy;
      const wB = project(b);
      if (wB <= 0) continue;
      const bx = out.sx, by = out.sy;
      // nearest point on the screen-space segment [A,B] to the click.
      const dx = bx - axA;
      const dy = by - ayA;
      const L2 = dx * dx + dy * dy;
      let t = L2 < 1e-12 ? 0 : ((clickPxX - axA) * dx + (clickPxY - ayA) * dy) / L2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = axA + t * dx;
      const py = ayA + t * dy;
      const ex = px - clickPxX;
      const ey = py - clickPxY;
      const d2 = ex * ex + ey * ey;
      // half-width and depth interpolated along the drawn segment.
      const depthT = wA + t * (wB - wA);
      if (depthT <= 0) continue;
      const halfVal = seg.halfA[s] + t * (seg.halfB[s] - seg.halfA[s]);
      const halfPx = k * halfVal * pxScale / depthT;
      if (d2 <= halfPx * halfPx && depthT < coverDepth) {
        coverDepth = depthT;
        coverIndex = t <= 0.5 ? a : b; // resolve the body-click to the nearer endpoint
        coverDist = Math.sqrt(d2);
      }
    }
  }

  if (coverIndex >= 0) return { index: coverIndex, distance: coverDist };
  if (fbIndex >= 0) return { index: fbIndex, distance: Math.sqrt(fbPixel2) };
  return { index: -1, distance: Infinity };
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
