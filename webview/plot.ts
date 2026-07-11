/**
 * Plot webview — ONE active item at a time, now of two types: a per-frame
 * LINE SERIES (values over frame index, the original path — unchanged) or a
 * SCATTER (raw (x, y) pairs, both axes auto-scaled). A new item of either
 * type replaces the current one. Hand-drawn SVG on plotmodel.ts's fixed
 * viewBox — no charting dependency, drawn content stays assertable.
 *
 * Frame sync: the series shows the playhead as a vertical marker; a scatter
 * WITH `frames` (the per-point frame indices) highlights the current
 * frame's point(s) instead, and clicking a point seeks to ITS frame through
 * the same plotSeek path. A scatter WITHOUT frames is a legitimate static
 * picture: no highlight, no seek.
 *
 * DUMB like the terminal: the HOST (plothost.ts) owns and validates the
 * active item and re-pushes on this page's "plot-ready" signal. Messages:
 *
 *   in   {type:"plotSeries", label, values, nFrames}    draw/replace: line
 *   in   {type:"plotScatter", label, x, y, frames?, xLabel?, yLabel?}
 *                                                       draw/replace: dots
 *   in   {type:"plotFrame", frame}                      playhead update
 *   out  {type:"plotSeek", frame}                       click → seek
 *   out  {type:"plot-ready"}                            page listeners live
 */
import {
  PLOT_H,
  PLOT_W,
  frameToX,
  nearestPoint,
  pointsFor,
  seriesScale,
  valueToX,
  valueToY,
  xToFrame,
  type PlotScale,
} from "./plotmodel.ts";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

type PlotItem =
  | { type: "series"; nFrames: number }
  | {
      type: "scatter";
      x: number[];
      y: number[];
      frames?: number[];
      xScale: PlotScale;
      yScale: PlotScale;
    };

function main(): void {
  const host = acquireVsCodeApi();
  const label = document.getElementById("plot-label");
  const range = document.getElementById("plot-range");
  const empty = document.getElementById("plot-empty");
  const svg = document.getElementById("plot-svg") as unknown as SVGSVGElement | null;
  const line = document.getElementById("plot-line");
  const dots = document.getElementById("plot-dots");
  const marker = document.getElementById("plot-marker");
  if (!label || !range || !empty || !svg || !line || !dots || !marker) {
    throw new Error("plot: skeleton elements missing");
  }

  let item: PlotItem | null = null;
  let frame = 0;

  const fmt = (v: number): string =>
    Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)
      ? v.toExponential(3)
      : String(Math.round(v * 1000) / 1000);

  const show = (): void => {
    empty.hidden = true;
    svg.removeAttribute("hidden");
  };

  /** The playhead, per item type: the vertical marker for a series; the
   * `.current` class on the current frame's dot(s) for a synced scatter. */
  const renderFrame = (): void => {
    if (item?.type === "series" && item.nFrames >= 1) {
      marker.removeAttribute("hidden");
      const x = frameToX(Math.min(frame, item.nFrames - 1), item.nFrames);
      marker.setAttribute("x1", String(x));
      marker.setAttribute("x2", String(x));
      return;
    }
    marker.setAttribute("hidden", "");
    if (item?.type === "scatter" && item.frames) {
      const children = dots.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle("current", item.frames[i] === frame);
      }
    }
  };

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as
      | {
          type?: string; label?: string; values?: number[]; nFrames?: number; frame?: number;
          x?: number[]; y?: number[]; frames?: number[]; xLabel?: string; yLabel?: string;
        }
      | undefined;
    if (m?.type === "plotSeries" && Array.isArray(m.values)) {
      item = { type: "series", nFrames: Number(m.nFrames ?? m.values.length) };
      const scale = seriesScale(m.values);
      label.textContent = String(m.label ?? "");
      range.textContent = `min ${fmt(scale.min)} · max ${fmt(scale.max)} · ${m.values.length} frames`;
      line.setAttribute("points", pointsFor(m.values, scale));
      dots.replaceChildren(); // a series REPLACES a scatter
      show();
      renderFrame();
      return;
    }
    if (m?.type === "plotScatter" && Array.isArray(m.x) && Array.isArray(m.y)) {
      const xScale = seriesScale(m.x);
      const yScale = seriesScale(m.y);
      item = {
        type: "scatter", x: m.x, y: m.y, xScale, yScale,
        ...(Array.isArray(m.frames) ? { frames: m.frames } : {}),
      };
      label.textContent = String(m.label ?? "");
      const xName = m.xLabel ? `${m.xLabel} ` : "x ";
      const yName = m.yLabel ? `${m.yLabel} ` : "y ";
      range.textContent =
        `${xName}${fmt(xScale.min)}…${fmt(xScale.max)} · ` +
        `${yName}${fmt(yScale.min)}…${fmt(yScale.max)} · ${m.x.length} pts`;
      line.setAttribute("points", ""); // a scatter REPLACES a series
      const frag = document.createDocumentFragment();
      for (let i = 0; i < m.x.length; i++) {
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("class", "plot-dot");
        dot.setAttribute("cx", String(valueToX(m.x[i], xScale)));
        dot.setAttribute("cy", String(valueToY(m.y[i], yScale)));
        dot.setAttribute("r", "3.5");
        frag.appendChild(dot);
      }
      dots.replaceChildren(frag);
      show();
      renderFrame();
      return;
    }
    if (m?.type === "plotFrame") {
      frame = Number(m.frame ?? 0);
      renderFrame();
    }
  });

  // click-to-seek, per item type — the SAME plotSeek path either way:
  // series → the frame under the click's x; synced scatter → the frame of
  // the nearest point (within tolerance); frames-less scatter → nothing.
  svg.addEventListener("click", (e: MouseEvent) => {
    if (!item) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const vx = ((e.clientX - rect.left) / rect.width) * PLOT_W;
    if (item.type === "series") {
      if (item.nFrames < 1) return;
      host.postMessage({ type: "plotSeek", frame: xToFrame(vx, item.nFrames) });
      return;
    }
    if (!item.frames) return; // a static scatter has no frame to seek to
    const vy = ((e.clientY - rect.top) / rect.height) * PLOT_H;
    const hit = nearestPoint(vx, vy, item.x, item.y, item.xScale, item.yScale);
    if (hit >= 0) host.postMessage({ type: "plotSeek", frame: item.frames[hit] });
  });

  // Lifecycle: tell the host this page is listening — it replies by pushing
  // the held item and the current frame (the reopen-restores-the-plot path).
  host.postMessage({ type: "plot-ready" });
}

main();
