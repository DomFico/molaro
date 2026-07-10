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
/** Per-edge base look (was the uniform LineBasicMaterial color 0x5a7a9a). */
export const DEFAULT_EDGE_COLOR: [number, number, number] = [0x5a / 255, 0x7a / 255, 0x9a / 255];
/** Per-trace-vertex base look (was the uniform polyline color 0x9a7a5a). */
export const DEFAULT_TRACE_COLOR: [number, number, number] = [0x9a / 255, 0x7a / 255, 0x5a / 255];
/** Edge/trace base widths. NOTE: these buffers are STATE ONLY today — WebGL
 * rasterizes GL lines at 1px regardless (no per-vertex width exists in GL),
 * so visible thickness awaits an impostor/mesh-line pass. The command layer,
 * undo, and tests are complete against the buffers; only pixels lag. */
export const DEFAULT_EDGE_SIZE = 1;
export const DEFAULT_TRACE_SIZE = 1;

export interface RepresentationState {
  /** length 3N — per-point RGB the base scene draws with. */
  color: Float32Array;
  /** length N — per-point screen-space point size. */
  size: Float32Array;
  /** length N — 1 = drawn, 0 = hidden (driven by the hidden set). */
  visible: Float32Array;
  /** length 3E — per-EDGE RGB, indexed by the header's edge order. The base
   * look is the initial value (like `color`), so an edge never written keeps
   * the uniform look with no sentinel/override machinery. */
  edgeColor: Float32Array;
  /** length 3V — per-POLYLINE-VERTEX RGB, in header vertex order (the
   * flattened `header.polylines`). Same no-sentinel pattern: the base look
   * is the initial value. The renderer interpolates between vertex colors
   * along each segment, so a colored↔uncolored boundary renders as a
   * gradient — inherent to per-vertex color, and intended. */
  traceColor: Float32Array;
  /** length E — per-EDGE width, header edge order (bondsize/bondsizeof both
   * write it — LWW per edge, like edgeColor). Size and hide are ORTHOGONAL:
   * 0 is a literal extent, never a hide. State-only pending an impostor
   * pass (see DEFAULT_EDGE_SIZE note). */
  edgeSize: Float32Array;
  /** length V — per-POLYLINE-VERTEX thickness, header vertex order. Same
   * orthogonality and same state-only-pending-geometry caveat. */
  traceSize: Float32Array;
}

export class RepresentationLayer {
  readonly state: RepresentationState;
  /** Set when any buffer changed so the renderer re-uploads attributes. */
  dirty = true;

  constructor(nPoints: number, nEdges = 0, nTraceVertices = 0) {
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
    const edgeColor = new Float32Array(nEdges * 3);
    for (let e = 0; e < nEdges; e++) {
      edgeColor[e * 3] = DEFAULT_EDGE_COLOR[0];
      edgeColor[e * 3 + 1] = DEFAULT_EDGE_COLOR[1];
      edgeColor[e * 3 + 2] = DEFAULT_EDGE_COLOR[2];
    }
    const traceColor = new Float32Array(nTraceVertices * 3);
    for (let v = 0; v < nTraceVertices; v++) {
      traceColor[v * 3] = DEFAULT_TRACE_COLOR[0];
      traceColor[v * 3 + 1] = DEFAULT_TRACE_COLOR[1];
      traceColor[v * 3 + 2] = DEFAULT_TRACE_COLOR[2];
    }
    const edgeSize = new Float32Array(nEdges).fill(DEFAULT_EDGE_SIZE);
    const traceSize = new Float32Array(nTraceVertices).fill(DEFAULT_TRACE_SIZE);
    this.state = { color, size, visible, edgeColor, traceColor, edgeSize, traceSize };
  }
}
