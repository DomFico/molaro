/**
 * Unit tests for the plot substrate — plotmodel.ts (the scale and the ONE
 * x↔frame mapping the line, marker, and click-to-seek all share) and
 * plothost.ts (the routing/holding logic the extension host and the harness
 * glue both run). Pure, no DOM. Run from viewer/:
 * node --test tests/plot.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FIGURE_PNG_MAX_BYTES,
  PLOT_H,
  PLOT_M,
  PLOT_W,
  figureAxesYSpan,
  figureContentRect,
  figureFrameToPx,
  figurePxToFrame,
  frameToX,
  pointsFor,
  seriesScale,
  validateFigure,
  valueToY,
  xToFrame,
  type FigureAxes,
} from "../webview/plotmodel.ts";
import { createPlotHost } from "../webview/plothost.ts";

const areaX = PLOT_M.left;
const areaR = PLOT_W - PLOT_M.right;

test("seriesScale: the series' own raw min/max (no normalization)", () => {
  assert.deepEqual(seriesScale([10, 6.5, 13.5, 12]), { min: 6.5, max: 13.5 });
  assert.deepEqual(seriesScale([-3, 0, 7]), { min: -3, max: 7 });
});

test("frameToX: frame 0 at the left edge, T-1 at the right; single frame pins left", () => {
  assert.equal(frameToX(0, 150), areaX);
  assert.equal(frameToX(149, 150), areaR);
  assert.equal(frameToX(1, 150), areaX + (areaR - areaX) / 149);
  assert.equal(frameToX(0, 1), areaX);
});

test("xToFrame is frameToX's inverse (round-trip every frame), clamped at the edges", () => {
  for (const f of [0, 1, 74, 148, 149]) {
    assert.equal(xToFrame(frameToX(f, 150), 150), f, `frame ${f}`);
  }
  assert.equal(xToFrame(-50, 150), 0, "left of the plot clamps to 0");
  assert.equal(xToFrame(PLOT_W + 50, 150), 149, "right of the plot clamps to T-1");
  assert.equal(xToFrame(400, 1), 0, "single-frame series always frame 0");
});

test("valueToY: max at the top, min at the bottom; a FLAT series draws (unit-span fallback)", () => {
  const scale = { min: 5, max: 15 };
  assert.equal(valueToY(15, scale), PLOT_M.top);
  assert.equal(valueToY(5, scale), PLOT_H - PLOT_M.bottom);
  const flat = seriesScale([7, 7, 7]);
  assert.deepEqual(flat, { min: 7, max: 7 }, "the READOUT keeps the real values");
  assert.ok(Number.isFinite(valueToY(7, flat)), "no divide-by-zero on a flat series");
});

test("pointsFor: one vertex per frame on the shared mapping", () => {
  const values = [0, 1, 0.5];
  const pts = pointsFor(values, seriesScale(values)).split(" ");
  assert.equal(pts.length, 3);
  assert.equal(pts[0], `${frameToX(0, 3)},${valueToY(0, { min: 0, max: 1 })}`);
  assert.equal(pts[2], `${frameToX(2, 3)},${valueToY(0.5, { min: 0, max: 1 })}`);
});

// -- plothost: route, validate, hold, re-push -----------------------------------

function makeHost() {
  const posts: { to: "plot" | "viewer" | "terminal"; msg: unknown }[] = [];
  let opened = 0;
  const host = createPlotHost({
    openPlot: () => {
      opened++;
    },
    postToPlot: (msg) => posts.push({ to: "plot", msg }),
    postToViewer: (msg) => posts.push({ to: "viewer", msg }),
    postToTerminal: (msg) => posts.push({ to: "terminal", msg }),
  });
  return { host, posts, openedCount: () => opened };
}
const seriesBind = (values: number[], callId = "call-9") => ({
  type: "claude-bind",
  callId,
  result: { kind: "per-frame-series", label: "example_series", values },
});

test("plothost: viewerInfo sets the frame count the stub and validation read", () => {
  const { host } = makeHost();
  assert.equal(host.nFrames(), 0);
  assert.ok(host.handleViewerMessage({ type: "viewerInfo", nFrames: 150 }));
  assert.equal(host.nFrames(), 150);
});

test("plothost: a VALID series opens the panel, pushes, and answers the ⤷ ok", () => {
  const { host, posts, openedCount } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 3 });
  assert.ok(host.handleTerminalMessage(seriesBind([10, 12, 11])));
  assert.equal(openedCount(), 1, "create/reveal the tab");
  assert.deepEqual(posts[0], {
    to: "plot",
    msg: { type: "plotSeries", label: "example_series", values: [10, 12, 11], nFrames: 3 },
  });
  assert.deepEqual(posts[1], { to: "plot", msg: { type: "plotFrame", frame: 0 } });
  assert.deepEqual(posts[2], {
    to: "terminal",
    msg: {
      type: "claude-bind-result", callId: "call-9", ok: true,
      message: 'series "example_series" drawn (3 frames) — click the plot to seek',
    },
  });
});

test("plothost: a length mismatch draws NOTHING and errors; the previous series stands", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 3 });
  host.handleTerminalMessage(seriesBind([1, 2, 3]));
  posts.length = 0;
  assert.ok(host.handleTerminalMessage(seriesBind([1, 2], "call-10")));
  assert.deepEqual(posts, [{
    to: "terminal",
    msg: {
      type: "claude-bind-result", callId: "call-10", ok: false,
      message: "series length mismatch: 2 values for 3 frames — not drawn",
    },
  }], "no plot post, no open — only the error outcome");
  posts.length = 0;
  host.handlePlotMessage({ type: "plot-ready" });
  assert.deepEqual((posts[0].msg as { values?: number[] }).values, [1, 2, 3],
    "the re-push still carries the LAST VALID series");
});

test("plothost: series claude-binds are consumed; the viewer's kinds pass through", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 2 });
  assert.equal(host.handleTerminalMessage({
    type: "claude-bind", callId: "c",
    result: { kind: "per-point-scalar", target: "alpha", axis: "color", scalars: [1, 0] },
  }), false, "scalar binds relay to the viewer untouched");
  assert.equal(host.handleTerminalMessage({
    type: "claude-bind", callId: "c", result: { kind: "command", command: "view alpha" },
  }), false);
  assert.equal(host.handleTerminalMessage({ type: "command", id: 1, text: "view alpha" }), false);
  assert.equal(posts.length, 0);
});

test("plothost: frameChanged forwards to the plot and is remembered for re-push", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 5 });
  host.handleTerminalMessage(seriesBind([1, 2, 3, 4, 5]));
  posts.length = 0;
  assert.ok(host.handleViewerMessage({ type: "frameChanged", frame: 3 }));
  assert.deepEqual(posts, [{ to: "plot", msg: { type: "plotFrame", frame: 3 } }]);
  posts.length = 0;
  host.handlePlotMessage({ type: "plot-ready" }); // a reopened tab announces itself
  assert.deepEqual(posts.map((p) => (p.msg as { type: string }).type),
    ["plotSeries", "plotFrame"], "the held series AND the current frame re-push");
  assert.deepEqual(posts[1].msg, { type: "plotFrame", frame: 3 });
});

test("plothost: plotSeek routes to the viewer's seek entry", () => {
  const { host, posts } = makeHost();
  assert.ok(host.handlePlotMessage({ type: "plotSeek", frame: 42 }));
  assert.deepEqual(posts, [{ to: "viewer", msg: { type: "seekFrame", frame: 42 } }]);
  assert.equal(host.handlePlotMessage({ type: "plotFrame", frame: 1 }), false,
    "plotFrame is an OUTBOUND message — never consumed as input");
});

// -- the scatter's second scaled axis + the nearest-point hit test ----------------

import { SCATTER_HIT_TOLERANCE, nearestPoint, valueToX } from "../webview/plotmodel.ts";

test("valueToX: the second scaled axis — min at the left edge, max at the right", () => {
  const scale = { min: 5, max: 15 };
  assert.equal(valueToX(5, scale), PLOT_M.left);
  assert.equal(valueToX(15, scale), PLOT_W - PLOT_M.right);
  assert.equal(valueToX(10, scale), (PLOT_M.left + PLOT_W - PLOT_M.right) / 2);
  assert.ok(Number.isFinite(valueToX(7, { min: 7, max: 7 })), "flat x-axis falls back, no NaN");
});

test("nearestPoint is consistent with the render mapping; tolerance bounds it", () => {
  const xs = [1, 2, 3];
  const ys = [10, 20, 30];
  const xScale = { min: 1, max: 3 };
  const yScale = { min: 10, max: 30 };
  for (let i = 0; i < xs.length; i++) {
    assert.equal(
      nearestPoint(valueToX(xs[i], xScale), valueToY(ys[i], yScale), xs, ys, xScale, yScale),
      i, `clicking exactly on dot ${i} hits dot ${i}`);
  }
  const px = valueToX(2, xScale);
  const py = valueToY(20, yScale);
  assert.equal(nearestPoint(px + SCATTER_HIT_TOLERANCE - 1, py, xs, ys, xScale, yScale), 1,
    "within tolerance still hits");
  assert.equal(nearestPoint(px, py + SCATTER_HIT_TOLERANCE * 3, xs, ys, xScale, yScale), -1,
    "outside tolerance is a miss (-1), not a nearest-anything");
  assert.equal(nearestPoint(0, 0, [], [], xScale, yScale), -1, "no points, no hit");
});

test("plothost: a scatter is held, pushed, and re-pushed exactly like a series", () => {
  const { host, posts, openedCount } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 40 });
  const frames = [0, 5, 39];
  assert.ok(host.handleTerminalMessage({
    type: "claude-bind", callId: "c1",
    result: { kind: "scatter", label: "example_scatter", x: [1, 2, 3], y: [4, 5, 6], frames },
  }));
  assert.equal(openedCount(), 1);
  assert.deepEqual(posts[0], {
    to: "plot",
    msg: { type: "plotScatter", label: "example_scatter", x: [1, 2, 3], y: [4, 5, 6], frames },
  });
  assert.match((posts[2].msg as { message: string }).message,
    /scatter "example_scatter" drawn \(3 points — click a point to seek\)/);
  posts.length = 0;
  host.handlePlotMessage({ type: "plot-ready" });
  assert.equal((posts[0].msg as { type: string }).type, "plotScatter", "re-push restores the scatter");
  // …and a SERIES replaces it in place (one active item)
  posts.length = 0;
  host.handleTerminalMessage(seriesBind(Array.from({ length: 40 }, (_, i) => i)));
  posts.length = 0;
  host.handlePlotMessage({ type: "plot-ready" });
  assert.equal((posts[0].msg as { type: string }).type, "plotSeries", "the series replaced the scatter");
});

test("plothost: malformed or out-of-range scatter payloads fail CLOSED on the plot route", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 10 });
  // unequal x/y — structurally malformed: consumed HERE, never the viewer's
  assert.ok(host.handleTerminalMessage({
    type: "claude-bind", callId: "c2",
    result: { kind: "scatter", label: "bad", x: [1, 2], y: [1] },
  }));
  assert.deepEqual(posts, [{
    to: "terminal",
    msg: { type: "claude-bind-result", callId: "c2", ok: false,
      message: "malformed scatter payload — not drawn" },
  }]);
  posts.length = 0;
  // frames out of range — well-formed shape, invalid sync hook
  assert.ok(host.handleTerminalMessage({
    type: "claude-bind", callId: "c3",
    result: { kind: "scatter", label: "bad", x: [1], y: [1], frames: [99] },
  }));
  assert.match((posts[0].msg as { message: string }).message,
    /scatter frames must be integer frame indices in \[0, 9\] — got 99 — not drawn/);
  posts.length = 0;
  host.handlePlotMessage({ type: "plot-ready" });
  assert.equal(posts.filter((p) => p.to === "plot" && (p.msg as { type: string }).type !== "plotFrame").length, 0,
    "nothing was ever held — no item to re-push");
});

test("plothost: a static (frames-less) scatter is legitimate", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 10 });
  assert.ok(host.handleTerminalMessage({
    type: "claude-bind", callId: "c4",
    result: { kind: "scatter", label: "static", x: [1, 2], y: [3, 4] },
  }));
  assert.match((posts[2].msg as { message: string }).message,
    /scatter "static" drawn \(2 points\)$/, "no seek hint without frames");
});

// -- figures: the letterbox + axes mapping (the HEAVY bar's pure core) ------------

const AX = (over: Partial<FigureAxes> = {}): FigureAxes => ({
  bbox: [0.1, 0.1, 0.8, 0.8], xlim: [0, 99], x_is_frames: true, ...over,
});

test("figureContentRect: contain-fit — centered, aspect preserved, never stretched", () => {
  // wide panel, square image: pillarboxed
  assert.deepEqual(figureContentRect(200, 100, 100, 100), { x: 50, y: 0, w: 100, h: 100 });
  // tall panel, wide image: letterboxed
  assert.deepEqual(figureContentRect(200, 200, 400, 100), { x: 0, y: 75, w: 200, h: 50 });
  // exact aspect: fills
  assert.deepEqual(figureContentRect(200, 100, 400, 200), { x: 0, y: 0, w: 200, h: 100 });
  // degenerate inputs collapse instead of dividing by zero
  assert.deepEqual(figureContentRect(0, 100, 10, 10), { x: 0, y: 0, w: 0, h: 0 });
});

test("figureFrameToPx: endpoints land on the bbox edges; mid is linear", () => {
  const rect = { x: 10, y: 5, w: 400, h: 200 };
  const ax = AX();
  assert.equal(figureFrameToPx(0, ax, rect), 10 + 0.1 * 400);
  assert.equal(figureFrameToPx(99, ax, rect), 10 + 0.9 * 400);
  const mid = figureFrameToPx(49.5, ax, rect);
  assert.ok(Math.abs(mid - (10 + 0.5 * 400)) < 1e-9);
});

test("figureAxesYSpan: matplotlib's bottom-left origin flips exactly once", () => {
  const rect = { x: 0, y: 20, w: 100, h: 100 };
  // bbox y0=0.1 h=0.8 → top fraction 0.1 → span [20+10, 20+90]
  assert.deepEqual(figureAxesYSpan(AX(), rect), { y0: 30, y1: 110 });
  // an axes hugging the BOTTOM of the figure sits at the BOTTOM on screen
  const low = AX({ bbox: [0, 0, 1, 0.2] });
  assert.deepEqual(figureAxesYSpan(low, rect), { y0: 20 + 80, y1: 20 + 100 });
});

test("figurePxToFrame: inverse inside a frames-axes; null outside, on static axes, and in the letterbox bars", () => {
  const rect = { x: 10, y: 5, w: 400, h: 200 };
  const ax = AX();
  for (const f of [0, 1, 42, 98, 99]) {
    const px = figureFrameToPx(f, ax, rect);
    const py = 5 + 0.5 * 200; // vertically inside
    assert.equal(figurePxToFrame(px, py, [ax], rect), f, `frame ${f}`);
  }
  assert.equal(figurePxToFrame(0, 105, [ax], rect), null, "left letterbox bar");
  assert.equal(figurePxToFrame(200, 1, [ax], rect), null, "above the bbox");
  assert.equal(figurePxToFrame(200, 105, [AX({ x_is_frames: false })], rect), null, "static axes never seek");
  assert.equal(figurePxToFrame(200, 105, [ax], { x: 0, y: 0, w: 0, h: 0 }), null, "zero rect");
});

test("figurePxToFrame: overlapping frames-axes (twinned) — FIRST MATCH WINS, the chosen rule", () => {
  const rect = { x: 0, y: 0, w: 400, h: 200 };
  const first = AX({ xlim: [0, 99] });
  const twin = AX({ xlim: [1000, 1099] }); // same bbox, different xlim
  const px = figureFrameToPx(50, first, rect);
  assert.equal(figurePxToFrame(px, 100, [first, twin], rect), 50, "the FIRST entry maps the click");
  assert.equal(figurePxToFrame(px, 100, [twin, first], rect), 1050, "order decides — a rule, not an accident");
});

test("validateFigure: the rejection matrix, each by name; a good reply passes", () => {
  const good = {
    png: "aGVsbG8=", width: 640, height: 480,
    axes: [{ bbox: [0.1, 0.1, 0.8, 0.8], xlim: [0, 99], x_is_frames: true }],
  };
  const ok = validateFigure(good, 150);
  assert.ok(ok.ok && ok.figure.axes.length === 1);
  const cases: [unknown, RegExp][] = [
    [[1, 2], /must return a dict/],
    [{ ...good, png: "" }, /non-empty base64/],
    [{ ...good, png: "not base64!!" }, /not valid base64/],
    [{ ...good, png: "A".repeat(Math.ceil(FIGURE_PNG_MAX_BYTES * 4 / 3) + 8) }, /the cap is 2 MiB; lower the dpi or the figsize/],
    [{ ...good, width: 4 }, /integers in \[8, 8192\]/],
    [{ ...good, axes: "nope" }, /axes must be a list/],
    [{ ...good, axes: [{ bbox: [0, 0, 0, 1], xlim: [0, 1], x_is_frames: false }] }, /positive width\/height/],
    [{ ...good, axes: [{ bbox: [0.5, 0.5, 0.6, 0.2], xlim: [0, 1], x_is_frames: false }] }, /within \[0,1\]/],
    [{ ...good, axes: [{ bbox: [0, 0, 1, 1], xlim: [5, 5], x_is_frames: false }] }, /ordered \(lo < hi\)/],
    [{ ...good, axes: [{ bbox: [0, 0, 1, 1], xlim: [0, 1], x_is_frames: "yes" }] }, /x_is_frames must be a boolean/],
    [{ ...good, axes: [{ bbox: [0, 0, 1, 1], xlim: [500, 900], x_is_frames: true }] }, /does not overlap frames 0\.\.149/],
  ];
  for (const [value, want] of cases) {
    const r = validateFigure(value, 150);
    assert.ok(!r.ok, JSON.stringify(value).slice(0, 60));
    if (!r.ok) assert.match(r.error, want, r.error);
  }
});

// -- figures through the plothost rails -------------------------------------------

const figureBind = (over: Record<string, unknown> = {}, callId = "call-f") => ({
  type: "claude-bind",
  callId,
  result: {
    kind: "figure", label: "example_figure", png: "aGVsbG8=", width: 640, height: 480,
    axes: [{ bbox: [0.1, 0.1, 0.8, 0.8], xlim: [0, 149], x_is_frames: true }],
    ...over,
  },
});

test("plothost: a VALID figure opens the panel, pushes plotFigure, answers ok; plot-ready re-pushes", () => {
  const { host, posts, openedCount } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 150 });
  assert.ok(host.handleTerminalMessage(figureBind()));
  assert.equal(openedCount(), 1);
  const push = posts[0];
  assert.equal(push.to, "plot");
  assert.equal((push.msg as { type?: string }).type, "plotFigure");
  assert.equal((push.msg as { width?: number }).width, 640);
  const outcome = posts.find((p) => p.to === "terminal");
  assert.ok(outcome && /figure "example_figure" drawn \(640×480, 1 axes — click a frames axis to seek\)/.test(
    (outcome.msg as { message?: string }).message ?? ""));
  posts.length = 0;
  assert.ok(host.handlePlotMessage({ type: "plot-ready" }));
  assert.equal((posts[0].msg as { type?: string }).type, "plotFigure", "reopen restores the figure");
});

test("plothost: figure validation fails CLOSED — previous item stands, error names the reason", () => {
  const { host, posts } = makeHost();
  host.handleViewerMessage({ type: "viewerInfo", nFrames: 150 });
  assert.ok(host.handleTerminalMessage(seriesBind([1, 2, 3].concat(new Array(147).fill(0)))));
  posts.length = 0;
  // frames-axis that cannot describe this trajectory (the deep rule runs HERE too)
  assert.ok(host.handleTerminalMessage(
    figureBind({ axes: [{ bbox: [0, 0, 1, 1], xlim: [500, 900], x_is_frames: true }] })));
  const fail = posts.find((p) => p.to === "terminal");
  assert.ok(fail && /does not overlap frames 0\.\.149 — not drawn/.test(
    (fail.msg as { message?: string }).message ?? ""));
  assert.ok(!posts.some((p) => p.to === "plot"), "nothing pushed on failure");
  posts.length = 0;
  assert.ok(host.handlePlotMessage({ type: "plot-ready" }));
  assert.equal((posts[0].msg as { type?: string }).type, "plotSeries", "the PREVIOUS series still held");
});
