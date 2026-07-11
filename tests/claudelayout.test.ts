/**
 * Unit tests for the Claude/terminal split's layout model — the state
 * object, its pure geometry mapping, the swap/flip rules, and persistence's
 * safe fallbacks. Pure, no DOM. Run from viewer/:
 * node --test tests/claudelayout.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LAYOUT,
  RATIO_MAX,
  RATIO_MIN,
  clampRatio,
  flipped,
  layoutGeometry,
  loadLayout,
  parseLayout,
  saveLayout,
  swapped,
  type LayoutState,
} from "../webview/claudelayout.ts";

test("clampRatio: neither pane can be dragged to nothing", () => {
  assert.equal(clampRatio(0), RATIO_MIN);
  assert.equal(clampRatio(1), RATIO_MAX);
  assert.equal(clampRatio(0.15), 0.15);
  assert.equal(clampRatio(0.85), 0.85);
  assert.equal(clampRatio(0.5), 0.5);
});

test("swap complements the ratio: each pane keeps its size, positions exchange", () => {
  const s: LayoutState = { open: true, orientation: "stacked", order: "claude-first", ratio: 0.6 };
  const t = swapped(s);
  assert.equal(t.order, "terminal-first");
  assert.ok(Math.abs(t.ratio - 0.4) < 1e-12, "first pane's share complements");
  // the claude pane's SHARE is identical before and after — geometry proves it
  assert.equal(layoutGeometry(s).claudeGrow, 0.6);
  assert.ok(Math.abs(layoutGeometry(t).claudeGrow - 0.6) < 1e-12);
  const back = swapped(t);
  assert.deepEqual(back, s, "double swap is identity");
});

test("flip preserves ratio and order; double flip is identity", () => {
  const s: LayoutState = { open: true, orientation: "stacked", order: "terminal-first", ratio: 0.3 };
  const f = flipped(s);
  assert.equal(f.orientation, "side");
  assert.equal(f.ratio, 0.3);
  assert.equal(f.order, "terminal-first");
  assert.deepEqual(flipped(f), s);
});

test("layoutGeometry maps every state to the expected DOM geometry", () => {
  const g1 = layoutGeometry({ open: true, orientation: "stacked", order: "claude-first", ratio: 0.6 });
  assert.deepEqual(g1, { direction: "column", claudeOrder: 0, termOrder: 2, claudeGrow: 0.6, termGrow: 0.4 });
  const g2 = layoutGeometry({ open: true, orientation: "side", order: "terminal-first", ratio: 0.3 });
  assert.deepEqual(g2, { direction: "row", claudeOrder: 2, termOrder: 0, claudeGrow: 0.7, termGrow: 0.3 },
    "ratio is the FIRST pane's share — the terminal's here");
});

test("parseLayout: absent/malformed/partial state falls back per FIELD, never throws", () => {
  assert.deepEqual(parseLayout(undefined), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout("junk"), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout(42), DEFAULT_LAYOUT);
  assert.deepEqual(
    parseLayout({ open: true, orientation: "sideways", order: "terminal-first", ratio: "wide" }),
    { open: true, orientation: "stacked", order: "terminal-first", ratio: 0.6 },
    "invalid fields default; valid neighbors survive");
  assert.deepEqual(parseLayout({ ratio: 7 }).ratio, RATIO_MAX, "out-of-range ratio clamps");
  assert.deepEqual(parseLayout({ ratio: Number.NaN }).ratio, DEFAULT_LAYOUT.ratio);
  assert.deepEqual(parseLayout({ orientation: "side" }),
    { ...DEFAULT_LAYOUT, orientation: "side" }, "partial state merges over defaults");
});

test("persistence round-trips through the webview state API, merge-preserving other keys", () => {
  let store: unknown = { somethingElse: 7 };
  const host = {
    getState: () => store,
    setState: (s: unknown) => {
      store = s;
    },
  };
  const s: LayoutState = { open: true, orientation: "side", order: "terminal-first", ratio: 0.3 };
  saveLayout(host, s);
  assert.deepEqual(loadLayout(host), s, "round-trip");
  assert.equal((store as { somethingElse?: number }).somethingElse, 7,
    "other webview-state keys survive the save");
});

test("persistence is best-effort: an absent or THROWING state API never breaks the layout", () => {
  assert.deepEqual(loadLayout({}), DEFAULT_LAYOUT, "no API at all → defaults");
  const hostile = {
    getState: () => {
      throw new Error("boom");
    },
    setState: () => {
      throw new Error("boom");
    },
  };
  assert.deepEqual(loadLayout(hostile), DEFAULT_LAYOUT, "a throwing getState → defaults");
  saveLayout(hostile, DEFAULT_LAYOUT); // must not throw
  assert.deepEqual(loadLayout({ getState: () => ({ claudeLayout: { ratio: 0.2 } }) }),
    { ...DEFAULT_LAYOUT, ratio: 0.2 }, "partial persisted layout still restores");
});

test("closing preserves the stored layout for the next open (open is just a field)", () => {
  const s: LayoutState = { open: true, orientation: "side", order: "terminal-first", ratio: 0.25 };
  const closed = { ...s, open: false };
  assert.deepEqual({ ...closed, open: true }, s,
    "orientation/order/ratio ride through a close→open cycle untouched");
});
