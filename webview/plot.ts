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
  figureAxesYSpan,
  figureContentRect,
  figureFrameToPx,
  figurePxToFrame,
  frameToX,
  nearestPoint,
  pointsFor,
  seriesScale,
  valueToX,
  valueToY,
  xToFrame,
  type FigureAxes,
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
    }
  | { type: "figure"; width: number; height: number; axes: FigureAxes[] };

function main(): void {
  const host = acquireVsCodeApi();
  const label = document.getElementById("plot-label");
  const range = document.getElementById("plot-range");
  const empty = document.getElementById("plot-empty");
  const svg = document.getElementById("plot-svg") as unknown as SVGSVGElement | null;
  const line = document.getElementById("plot-line");
  const dots = document.getElementById("plot-dots");
  const marker = document.getElementById("plot-marker");
  const img = document.getElementById("plot-img") as HTMLImageElement | null;
  const figMarkers = document.getElementById("plot-fig-markers");
  const frameAxis = document.getElementById("plot-frame-axis");
  if (!label || !range || !empty || !svg || !line || !dots || !marker || !img || !figMarkers || !frameAxis) {
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
    if (item?.type === "figure") renderFigMarkers();
  };

  /** Figure playhead: ONE marker line per frames-axes, positioned through
   * plotmodel's letterboxed mapping in CSS px, then converted to the SVG's
   * stretched viewBox units (x/panelW·PLOT_W — a vertical line stays
   * vertical under the non-uniform stretch). Re-run on every frame AND on
   * every resize: the content rect is a function of the panel size, so a
   * window drag would silently drift every marker otherwise. The image
   * itself is NEVER touched here — zero per-frame cost beyond line
   * coordinates. */
  const renderFigMarkers = (): void => {
    if (item?.type !== "figure") return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const content = figureContentRect(rect.width, rect.height, item.width, item.height);
    const frag = document.createDocumentFragment();
    for (const ax of item.axes) {
      if (!ax.x_is_frames) continue;
      const [lo, hi] = ax.xlim;
      const f = Math.min(Math.max(frame, Math.ceil(lo)), Math.floor(hi));
      const px = figureFrameToPx(f, ax, content);
      const span = figureAxesYSpan(ax, content);
      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("class", "plot-fig-marker");
      const vx = (px / rect.width) * PLOT_W;
      el.setAttribute("x1", String(vx));
      el.setAttribute("x2", String(vx));
      el.setAttribute("y1", String((span.y0 / rect.height) * PLOT_H));
      el.setAttribute("y2", String((span.y1 / rect.height) * PLOT_H));
      frag.appendChild(el);
    }
    figMarkers.replaceChildren(frag);
  };

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as
      | {
          type?: string; label?: string; values?: number[]; nFrames?: number; frame?: number;
          x?: number[]; y?: number[]; frames?: number[]; xLabel?: string; yLabel?: string;
          png?: string; width?: number; height?: number; axes?: unknown[];
        }
      | undefined;
    if (m?.type === "plotFigure" && typeof m.png === "string") {
      item = {
        type: "figure",
        width: Number(m.width ?? 0),
        height: Number(m.height ?? 0),
        axes: Array.isArray(m.axes) ? (m.axes as FigureAxes[]) : [],
      };
      label.textContent = String(m.label ?? "");
      const nAxes = (item.axes ?? []).length;
      range.textContent = `${item.width}×${item.height} · ${nAxes} axes`;
      img.src = `data:image/png;base64,${m.png}`;
      img.removeAttribute("hidden");
      // the SVG stays visible as the OVERLAY; its chart furniture hides
      line.setAttribute("points", "");
      dots.replaceChildren();
      frameAxis.setAttribute("hidden", "");
      show();
      renderFrame();
      return;
    }
    if (m?.type === "plotSeries" && Array.isArray(m.values)) {
      item = { type: "series", nFrames: Number(m.nFrames ?? m.values.length) };
      img.setAttribute("hidden", "");
      figMarkers.replaceChildren();
      frameAxis.removeAttribute("hidden");
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
      img.setAttribute("hidden", "");
      figMarkers.replaceChildren();
      frameAxis.removeAttribute("hidden");
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
    if (item.type === "figure") {
      // CSS-px click through the SAME letterboxed mapping (first frames-
      // axes match wins on overlap — plotmodel's chosen rule); outside
      // every frames-axes = no seek, the frames-less-scatter stance
      const content = figureContentRect(rect.width, rect.height, item.width, item.height);
      const f = figurePxToFrame(e.clientX - rect.left, e.clientY - rect.top, item.axes, content);
      if (f !== null) host.postMessage({ type: "plotSeek", frame: f });
      return;
    }
    if (!item.frames) return; // a static scatter has no frame to seek to
    const vy = ((e.clientY - rect.top) / rect.height) * PLOT_H;
    const hit = nearestPoint(vx, vy, item.x, item.y, item.xScale, item.yScale);
    if (hit >= 0) host.postMessage({ type: "plotSeek", frame: item.frames[hit] });
  });

  // Resize: the letterboxed content rect is a function of the panel size —
  // recompute the figure markers or they silently drift off their true
  // frame positions (the same silent-misalignment class the letterbox
  // mapping exists to contain).
  window.addEventListener("resize", () => {
    if (item?.type === "figure") renderFigMarkers();
  });

  // Lifecycle: tell the host this page is listening — it replies by pushing
  // the held item and the current frame (the reopen-restores-the-plot path).
  host.postMessage({ type: "plot-ready" });
}

main();
