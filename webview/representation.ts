/**
 * Representation layer — the per-point base look the renderer draws.
 *
 * Deliberately a *replaceable* layer holding only DEFAULT state: a uniform color
 * (white), a uniform size, and per-point visibility. A future agent-driven layer
 * is meant to REPLACE how these buffers are computed — from channels, predicates,
 * arbitrary per-point styling — without any other code changing; the renderer
 * only ever reads the three flat buffers below.
 *
 * As of Increment 4.7, visibility is driven by the persistent **hidden set** (see
 * sets.ts): its resolved points get `visible = 0`, everything else `1`. There is
 * no dimmed/transparent middle state — a point is either drawn as a full
 * first-class citizen (white; selection highlights it green) or not drawn at all.
 * No styling controls live here (color schemes/pickers belong to the future
 * agent layer); visibility hide/show is not styling and is in scope.
 */

// Defaults (the flat base look). RGB in 0..1 for a vertex-color attribute.
export const DEFAULT_COLOR: [number, number, number] = [0.9, 0.9, 0.9];
export const DEFAULT_SIZE = 3;

export interface RepresentationState {
  /** length 3N — per-point RGB the base scene draws with. */
  color: Float32Array;
  /** length N — per-point screen-space point size. */
  size: Float32Array;
  /** length N — 1 = drawn, 0 = hidden (driven by the hidden set). */
  visible: Float32Array;
}

export class RepresentationLayer {
  readonly state: RepresentationState;
  /** Set when any buffer changed so the renderer re-uploads attributes. */
  dirty = true;

  constructor(nPoints: number) {
    const color = new Float32Array(nPoints * 3);
    const size = new Float32Array(nPoints);
    const visible = new Float32Array(nPoints);
    for (let p = 0; p < nPoints; p++) {
      color[p * 3] = DEFAULT_COLOR[0];
      color[p * 3 + 1] = DEFAULT_COLOR[1];
      color[p * 3 + 2] = DEFAULT_COLOR[2];
      size[p] = DEFAULT_SIZE;
      visible[p] = 1;
    }
    this.state = { color, size, visible };
  }
}
