/**
 * Plot panel skeleton — DOM + CSS for the per-frame-series plot webview,
 * shared by BOTH hosts (src/extension.ts renders the real editor tab;
 * tests/bridge.ts serves the harness surface) so the two never drift — the
 * same rule as hud.ts and terminalhud.ts. The SVG uses a FIXED viewBox
 * (plotmodel.ts geometry) so drawn content is assertable at any panel size.
 */
import { PLOT_H, PLOT_M, PLOT_W } from "./plotmodel.ts";

export const PLOT_CSS = /* css */ `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    background: #1e1e1e; color: #cccccc; font: 12px monospace; }
  * { box-sizing: border-box; }
  #plot-root { position: absolute; inset: 0; display: flex; flex-direction: column; }
  #plot-head { flex: none; display: flex; align-items: center; gap: 12px;
    padding: 6px 10px; background: #252526; border-bottom: 1px solid #3a3a3a; }
  #plot-label { color: #9fbde8; }
  #plot-range { color: #8a8a8a; margin-left: auto; }
  #plot-body { flex: 1 1 auto; min-height: 0; position: relative; }
  #plot-empty { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; color: #6a6a6a; }
  /* an explicit display beats the UA [hidden] rule — restate it */
  #plot-empty[hidden] { display: none; }
  #plot-svg { width: 100%; height: 100%; display: block; cursor: crosshair;
    position: relative; z-index: 1; }
  /* the figure image sits UNDER the SVG overlay (which keeps the marker
     and the click listener); object-fit contain — the mapping goes through
     the letterboxed content rect (plotmodel.figureContentRect) */
  #plot-img { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: contain; z-index: 0; }
  #plot-img[hidden] { display: none; }
  .plot-fig-marker { stroke: #dcb96a; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  #plot-svg[hidden] { display: none; }
  #plot-line { fill: none; stroke: #9fe8cd; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  #plot-marker { stroke: #dcb96a; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  /* SVG elements never get the HTML UA [hidden] rule — restate it (the
     same display-beats-[hidden] class of bug as #plot-empty, SVG flavor) */
  #plot-marker[hidden] { display: none; }
  #plot-frame-axis { stroke: #3a3a3a; stroke-width: 1; }
  .plot-dot { fill: #9fe8cd; opacity: 0.7; }
  .plot-dot.current { fill: #dcb96a; opacity: 1; }
`;

export const PLOT_BODY = /* html */ `
  <div id="plot-root">
    <div id="plot-head">
      <span id="plot-label">no series</span>
      <span id="plot-range"></span>
    </div>
    <div id="plot-body">
      <div id="plot-empty">no series yet — results arrive from the conversation panel</div>
      <img id="plot-img" hidden />
      <svg id="plot-svg" viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" hidden>
        <line id="plot-frame-axis" x1="${PLOT_M.left}" y1="${PLOT_H - PLOT_M.bottom}"
              x2="${PLOT_W - PLOT_M.right}" y2="${PLOT_H - PLOT_M.bottom}"></line>
        <polyline id="plot-line" points=""></polyline>
        <g id="plot-dots"></g>
        <line id="plot-marker" x1="0" y1="${PLOT_M.top}" x2="0" y2="${PLOT_H - PLOT_M.bottom}" hidden></line>
        <g id="plot-fig-markers"></g>
      </svg>
    </div>
  </div>
`;
