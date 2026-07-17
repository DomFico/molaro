/**
 * The channel-binding REGISTRY — the durable scene-state object behind the
 * bind/unbind/bindings verbs. A Binding says "this channel drives this axis
 * over these points"; the registry owns the list and its one structural
 * invariant:
 *
 *   COVERAGES ARE DISJOINT PER AXIS — an element is covered by AT MOST ONE
 *   binding ON EACH AXIS. Bindings on DIFFERENT axes coexist over the same
 *   elements (color driven by one channel, size by another, independently —
 *   the axes are orthogonal buffers). `add` enforces the invariant
 *   (last-bind-wins: the new binding's points are released from every
 *   earlier SAME-AXIS binding first, in the same operation), and every
 *   later consumer — the per-flip apply, the LWW-clear rule — leans on it:
 *   "which binding drives element p's axis a" always has one answer.
 *
 * THIS INCREMENT (C-2) BINDINGS ARE INERT: created, applied ONCE at bind
 * time through the ordinary recorded writers, listed, badged, undoable —
 * but nothing re-derives on frame flips yet (the flip apply is the next,
 * attended increment). The verbs' messages say so.
 *
 * Undo rides one seam: `snapshot()` before a mutation, `restore(snap)` in
 * the recorded op — whole-list, so no index/order bookkeeping can drift.
 * Registry methods NEVER touch buffers or record ops themselves; the
 * composite (write + registry + one stroke) is assembled in main.ts.
 *
 * Pure module: no DOM, no Three. Lifetime = the webview (like every buffer
 * and the undo stack; retainContextWhenHidden keeps it across tab-aways).
 */
import type { BindAxis } from "./channelmap.ts";

export interface Binding {
  /** Header-declared channel name (gate-validated before entry). */
  channel: string;
  axis: BindAxis;
  /** Covered element ids, header order — the resolved target MINUS any
   * coverage later bindings took (disjointness). */
  points: number[];
  /** The address text as typed, for display only. */
  expr: string;
  /** Normalization range frozen at bind time. */
  range: [number, number];
}

export interface ReleaseStats {
  /** Bindings that lost at least one point (removed ones included). */
  touched: number;
  /** Bindings whose coverage emptied and were dropped from the list. */
  removed: number;
  /** Total coverage points released (coverages are disjoint, so no
   * double-count is possible). */
  points: number;
}

export class BindingRegistry {
  private list: Binding[] = [];

  count(): number {
    return this.list.length;
  }

  all(): readonly Binding[] {
    return this.list;
  }

  /** Deep copy for the undo seam (points/range arrays owned by the copy). */
  snapshot(): Binding[] {
    return this.list.map((b) => ({ ...b, points: [...b.points], range: [...b.range] as [number, number] }));
  }

  restore(snap: Binding[]): void {
    this.list = snap.map((b) => ({ ...b, points: [...b.points], range: [...b.range] as [number, number] }));
  }

  /** Register a binding, enforcing per-axis disjointness LAST-BIND-WINS:
   * the new coverage is released from every earlier SAME-AXIS binding first
   * (shrink; emptied bindings drop). Returns what that release did, for the
   * verb's report. */
  add(b: Binding): ReleaseStats {
    const stats = this.release(b.points, b.axis);
    this.list.push({ ...b, points: [...b.points], range: [...b.range] as [number, number] });
    return stats;
  }

  /** Release coverage element-wise (the ruled LWW granularity: "the last
   * explicit action wins, visibly, element-by-element"): shrink each
   * matching binding to the elements NOT named; empty → removed.
   * `points` null = every element; `axis` null = every axis. */
  release(points: readonly number[] | null, axis: BindAxis | null = null): ReleaseStats {
    const drop = points === null ? null : new Set(points);
    const stats: ReleaseStats = { touched: 0, removed: 0, points: 0 };
    this.list = this.list.filter((b) => {
      if (axis !== null && b.axis !== axis) return true;
      const kept = drop === null ? [] : b.points.filter((p) => !drop.has(p));
      const lost = b.points.length - kept.length;
      if (lost === 0) return true;
      stats.touched++;
      stats.points += lost;
      if (kept.length === 0) {
        stats.removed++;
        return false;
      }
      b.points = kept;
      return true;
    });
    return stats;
  }

  /** What `release(points, axis)` WOULD do, without doing it — the bind
   * verb reports its last-bind-wins takeover from this, since the actual
   * clearing happens inside the write/add composite. */
  overlapStats(points: readonly number[], axis: BindAxis): ReleaseStats {
    const drop = new Set(points);
    const stats: ReleaseStats = { touched: 0, removed: 0, points: 0 };
    for (const b of this.list) {
      if (b.axis !== axis) continue;
      const lost = b.points.reduce((n, p) => n + (drop.has(p) ? 1 : 0), 0);
      if (lost === 0) continue;
      stats.touched++;
      stats.points += lost;
      if (lost === b.points.length) stats.removed++;
    }
    return stats;
  }

  /** The one-answer lookup the per-axis disjointness invariant exists for
   * (the flip apply and the LWW-clear rule read through this). */
  covering(point: number, axis: BindAxis): Binding | undefined {
    return this.list.find((b) => b.axis === axis && b.points.includes(point));
  }
}
