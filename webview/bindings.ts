/**
 * The channel-binding REGISTRY — the durable scene-state object behind the
 * bind/unbind/bindings verbs. A Binding says "this channel drives this axis
 * over these points"; the registry owns the list and its one structural
 * invariant:
 *
 *   COVERAGES ARE DISJOINT — an element is covered by AT MOST ONE binding.
 *   `add` enforces it (last-bind-wins: the new binding's points are released
 *   from every earlier binding first, in the same operation), and every
 *   later consumer — the per-flip apply, the LWW-clear rule — leans on it:
 *   "which binding covers element p" always has one answer.
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

  /** Register a binding, enforcing disjointness LAST-BIND-WINS: the new
   * coverage is released from every earlier binding first (shrink; emptied
   * bindings drop). Returns what that release did, for the verb's report. */
  add(b: Binding): ReleaseStats {
    const stats = this.release(b.points);
    this.list.push({ ...b, points: [...b.points], range: [...b.range] as [number, number] });
    return stats;
  }

  /** Release the given elements from every binding's coverage (shrink;
   * empty → removed). The partial-clear granularity is the ruled LWW shape:
   * "the last explicit action wins, visibly, element-by-element". */
  release(points: readonly number[]): ReleaseStats {
    const drop = new Set(points);
    const stats: ReleaseStats = { touched: 0, removed: 0, points: 0 };
    this.list = this.list.filter((b) => {
      const kept = b.points.filter((p) => !drop.has(p));
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

  /** Release everything (unbind over the whole system rides `release`, but
   * a dataset-independent clear keeps "remove all bindings" exact). */
  clear(): ReleaseStats {
    const stats: ReleaseStats = {
      touched: this.list.length,
      removed: this.list.length,
      points: this.list.reduce((n, b) => n + b.points.length, 0),
    };
    this.list = [];
    return stats;
  }

  /** The one-answer lookup the disjointness invariant exists for (the flip
   * apply and the LWW-clear rule will read through this). */
  covering(point: number): Binding | undefined {
    return this.list.find((b) => b.points.includes(point));
  }
}
