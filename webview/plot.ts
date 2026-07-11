/**
 * Plot webview — the per-frame-series panel: one active series drawn as an
 * SVG line over frame index, a playhead marker tracking the current frame,
 * and click-to-seek back onto the trajectory (the plot is a CONTROL, not
 * just a readout). Hand-drawn SVG on plotmodel.ts's fixed viewBox — no
 * charting dependency, and drawn content stays assertable.
 *
 * DUMB like the terminal: it holds no trajectory state and validates
 * nothing — the HOST (plothost.ts) owns the current series, validates
 * lengths, and re-pushes on this page's "plot-ready" signal (so a closed
 * and reopened tab restores without webview retention). Messages:
 *
 *   in   {type:"plotSeries", label, values, nFrames}   draw/replace the series
 *   in   {type:"plotFrame", frame}                     move the playhead marker
 *   out  {type:"plotSeek", frame}                      a click → seek the viewer
 *   out  {type:"plot-ready"}                           page listeners are live
 */
import { PLOT_W, frameToX, pointsFor, seriesScale, xToFrame } from "./plotmodel.ts";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

function main(): void {
  const host = acquireVsCodeApi();
  const label = document.getElementById("plot-label");
  const range = document.getElementById("plot-range");
  const empty = document.getElementById("plot-empty");
  const svg = document.getElementById("plot-svg") as unknown as SVGSVGElement | null;
  const line = document.getElementById("plot-line");
  const marker = document.getElementById("plot-marker");
  if (!label || !range || !empty || !svg || !line || !marker) {
    throw new Error("plot: skeleton elements missing");
  }

  let nFrames = 0;
  let haveSeries = false;
  let frame = 0;

  const fmt = (v: number): string => {
    const s = Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.01)
      ? v.toExponential(3)
      : String(Math.round(v * 1000) / 1000);
    return s;
  };

  const renderMarker = (): void => {
    if (!haveSeries || nFrames < 1) {
      marker.setAttribute("hidden", "");
      return;
    }
    marker.removeAttribute("hidden");
    const x = frameToX(Math.min(frame, nFrames - 1), nFrames);
    marker.setAttribute("x1", String(x));
    marker.setAttribute("x2", String(x));
  };

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as
      | { type?: string; label?: string; values?: number[]; nFrames?: number; frame?: number }
      | undefined;
    if (m?.type === "plotSeries" && Array.isArray(m.values)) {
      nFrames = Number(m.nFrames ?? m.values.length);
      haveSeries = true;
      const scale = seriesScale(m.values);
      label.textContent = String(m.label ?? "");
      range.textContent = `min ${fmt(scale.min)} · max ${fmt(scale.max)} · ${m.values.length} frames`;
      line.setAttribute("points", pointsFor(m.values, scale));
      empty.hidden = true;
      svg.removeAttribute("hidden");
      renderMarker();
      return;
    }
    if (m?.type === "plotFrame") {
      frame = Number(m.frame ?? 0);
      renderMarker();
    }
  });

  // click-to-seek: client x → fixed viewBox x → frame (the SAME mapping the
  // marker uses, inverted) → ask the host to seek the viewer there.
  svg.addEventListener("click", (e: MouseEvent) => {
    if (!haveSeries || nFrames < 1) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const vx = ((e.clientX - rect.left) / rect.width) * PLOT_W;
    host.postMessage({ type: "plotSeek", frame: xToFrame(vx, nFrames) });
  });

  // Lifecycle: tell the host this page is listening — it replies by pushing
  // the held series and the current frame (the reopen-restores-the-plot path).
  host.postMessage({ type: "plot-ready" });
}

main();
