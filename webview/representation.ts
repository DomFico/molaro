/**
 * Representation layer — the per-point base look the renderer draws.
 *
 * This is deliberately a *replaceable* layer holding only DEFAULT state: a
 * uniform color, a uniform size, and per-point visibility (with bulk categories
 * hidden by default). A future agent-driven layer is meant to REPLACE how these
 * buffers are computed — from channels, predicates, arbitrary per-point styling
 * — without any other code changing. So the renderer only ever reads the three
 * flat buffers below; no representation policy lives in the render loop.
 *
 * It ships exactly ONE control: bulk-category visibility. There are no color
 * pickers, schemes, or per-subset controls here on purpose — that space belongs
 * to the future layer, and selection is a separate overlay (see selection.ts),
 * never a mutation of `color`. If you find selection writing into `color`, that
 * is the bug the two-layer split exists to prevent.
 */
import type { Header } from "../contract/contract.ts";
import { bulkCategories } from "./classification.ts";

// Defaults (the flat base look). RGB in 0..1 for a vertex-color attribute.
export const DEFAULT_COLOR: [number, number, number] = [0.83, 0.83, 0.83];
export const DEFAULT_SIZE = 3;

export interface RepresentationState {
  /** length 3N — per-point RGB the base scene draws with. */
  color: Float32Array;
  /** length N — per-point screen-space point size. */
  size: Float32Array;
  /** length N — 1 = drawn, 0 = hidden. */
  visible: Float32Array;
}

export class RepresentationLayer {
  readonly state: RepresentationState;
  /** Point indices belonging to bulk categories (hidden unless toggled on). */
  private readonly bulkPoints: number[] = [];
  private bulkVisible = false;
  /** Set when any buffer changed so the renderer re-uploads attributes. */
  dirty = true;

  constructor(header: Header) {
    const n = header.n_points;
    const color = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const visible = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      color[p * 3] = DEFAULT_COLOR[0];
      color[p * 3 + 1] = DEFAULT_COLOR[1];
      color[p * 3 + 2] = DEFAULT_COLOR[2];
      size[p] = DEFAULT_SIZE;
      visible[p] = 1;
    }
    const bulk = bulkCategories(header);
    if (bulk.size > 0) {
      const cat = header.points.category;
      for (let p = 0; p < n; p++) {
        if (bulk.has(cat[p])) {
          this.bulkPoints.push(p);
          visible[p] = 0; // bulk hidden by default — an un-hidden bulk is a hairball
        }
      }
    }
    this.state = { color, size, visible };
  }

  get hasBulk(): boolean {
    return this.bulkPoints.length > 0;
  }

  get bulkShown(): boolean {
    return this.bulkVisible;
  }

  /** The one representation control: show/hide all bulk-category points. */
  setBulkVisible(on: boolean): void {
    if (on === this.bulkVisible) return;
    this.bulkVisible = on;
    const v = on ? 1 : 0;
    for (const p of this.bulkPoints) this.state.visible[p] = v;
    this.dirty = true;
  }

  toggleBulk(): boolean {
    this.setBulkVisible(!this.bulkVisible);
    return this.bulkVisible;
  }
}
