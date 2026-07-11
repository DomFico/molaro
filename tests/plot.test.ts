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
  PLOT_H,
  PLOT_M,
  PLOT_W,
  frameToX,
  pointsFor,
  seriesScale,
  valueToY,
  xToFrame,
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
