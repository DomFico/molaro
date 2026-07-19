/**
 * Plot model — the pure math under the plot panel: the y auto-scale, the
 * x↔frame mapping (ONE mapping shared by the line, the playhead marker, and
 * click-to-seek, so they cannot disagree), and the SVG polyline points.
 *
 * All geometry is in fixed viewBox units (PLOT_W × PLOT_H with PLOT_M
 * margins) so drawn content is deterministic and assertable regardless of
 * the panel's on-screen size. Values are RAW — a per-frame observable in
 * whatever units it has; the scale adapts to the series' own min/max and
 * nothing here normalizes or interprets magnitudes.
 *
 * Pure module: no DOM — unit-tested under `node --test`.
 */

export const PLOT_W = 800;
export const PLOT_H = 300;
export const PLOT_M = { left: 44, right: 10, top: 12, bottom: 20 } as const;

const areaX = PLOT_M.left;
const areaW = PLOT_W - PLOT_M.left - PLOT_M.right;
const areaY = PLOT_M.top;
const areaH = PLOT_H - PLOT_M.top - PLOT_M.bottom;

export interface PlotScale {
  min: number;
  max: number;
}

/** The series' own min/max — the readout shows these RAW values; drawing
 * falls back to a unit span when the series is flat (so a constant line
 * renders mid-plot instead of dividing by zero). */
export function seriesScale(values: readonly number[]): PlotScale {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** frame index → viewBox x. frame 0 sits on the left edge of the plot
 * area, frame nFrames-1 on the right; a single-frame series pins left. */
export function frameToX(frame: number, nFrames: number): number {
  if (nFrames <= 1) return areaX;
  return areaX + (frame / (nFrames - 1)) * areaW;
}

/** viewBox x → nearest frame index (the click-to-seek inverse; clamped). */
export function xToFrame(x: number, nFrames: number): number {
  if (nFrames <= 1) return 0;
  const t = (x - areaX) / areaW;
  return Math.min(nFrames - 1, Math.max(0, Math.round(t * (nFrames - 1))));
}

/** value → viewBox y under a scale (larger values higher on screen). */
export function valueToY(v: number, scale: PlotScale): number {
  const span = scale.max - scale.min || 1;
  return areaY + (1 - (v - scale.min) / span) * areaH;
}

/** value → viewBox x under a scale — the scatter's second scaled axis (the
 * line path keeps its frame-index x via frameToX, untouched). */
export function valueToX(v: number, scale: PlotScale): number {
  const span = scale.max - scale.min || 1;
  return areaX + ((v - scale.min) / span) * areaW;
}

/** The scatter's click hit test: the nearest point to a viewBox position,
 * within the tolerance (viewBox units), else -1. Uses THE SAME value→pixel
 * mapping the render uses, so hit and dot cannot disagree. */
export const SCATTER_HIT_TOLERANCE = 14;

export function nearestPoint(
  vx: number,
  vy: number,
  xs: readonly number[],
  ys: readonly number[],
  xScale: PlotScale,
  yScale: PlotScale,
  tolerance = SCATTER_HIT_TOLERANCE,
): number {
  let best = -1;
  let bestD = tolerance * tolerance;
  for (let i = 0; i < xs.length; i++) {
    const dx = valueToX(xs[i], xScale) - vx;
    const dy = valueToY(ys[i], yScale) - vy;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** The polyline's `points` attribute: one vertex per frame, x from the
 * SHARED frame mapping, y from the scale. */
export function pointsFor(values: readonly number[], scale: PlotScale): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    parts.push(`${frameToX(i, values.length)},${valueToY(values[i], scale)}`);
  }
  return parts.join(" ");
}

// -- figures (produces: figure): the letterbox + axes mapping ---------------------
//
// A FIGURE is a raster image plus per-axes metadata ({bbox, xlim,
// x_is_frames}); the playhead marker and click-to-seek pass through the
// functions below and NOWHERE else. Two facts are contained here so no
// caller ever re-derives them:
//   - the LETTERBOX: the image displays object-fit:contain, so every
//     mapping goes through the contain-fitted CONTENT RECT, not the panel;
//   - the Y-FLIP: matplotlib bboxes are bottom-left-origin figure
//     fractions; screen y grows downward. Flipped exactly once, here.
// Units: all rect inputs/outputs are CSS px. DPR NEVER enters — both
// dimensions arrive in the same units, so the ratio is DPR-free; do not
// "fix" anything by multiplying by devicePixelRatio.

/** One axes' metadata, as validated (bbox = [x0, y0, w, h] figure-fraction,
 * bottom-left origin; xlim = data x-range; x_is_frames marks the frame
 * axis this brief's interactions ride). */
export interface FigureAxes {
  bbox: [number, number, number, number];
  xlim: [number, number];
  x_is_frames: boolean;
}

/** Decoded-size cap for the figure image (fail-closed; the rejection
 * message tells the author the remedy). */
export const FIGURE_PNG_MAX_BYTES = 2 * 1024 * 1024;

/** The contain-fit content rect: where the image's pixels actually land
 * inside a panelW×panelH box (centered, aspect preserved, never
 * stretched). */
export function figureContentRect(
  panelW: number,
  panelH: number,
  imgW: number,
  imgH: number,
): { x: number; y: number; w: number; h: number } {
  if (panelW <= 0 || panelH <= 0 || imgW <= 0 || imgH <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(panelW / imgW, panelH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (panelW - w) / 2, y: (panelH - h) / 2, w, h };
}

/** Frame → panel x (CSS px) for one frames-axes, through the content rect. */
export function figureFrameToPx(
  frame: number,
  ax: FigureAxes,
  rect: { x: number; y: number; w: number; h: number },
): number {
  const [lo, hi] = ax.xlim;
  const t = (frame - lo) / (hi - lo);
  return rect.x + (ax.bbox[0] + t * ax.bbox[2]) * rect.w;
}

/** The marker's vertical span for one axes (panel y, CSS px): matplotlib's
 * bottom-left bbox origin flipped ONCE, here. */
export function figureAxesYSpan(
  ax: FigureAxes,
  rect: { x: number; y: number; w: number; h: number },
): { y0: number; y1: number } {
  const top = 1 - (ax.bbox[1] + ax.bbox[3]);
  return { y0: rect.y + top * rect.h, y1: rect.y + (top + ax.bbox[3]) * rect.h };
}

/** Panel (x, y) → frame, hit-testing the FRAMES axes only. Overlapping
 * bboxes (e.g. twinned axes sharing one rectangle): FIRST MATCH WINS, in
 * axes-list order — a chosen rule, not an accident. null = the click
 * landed in no frames-axes (a static panel or the letterbox bars): no
 * seek, exactly like the frames-less scatter. */
export function figurePxToFrame(
  px: number,
  py: number,
  axes: readonly FigureAxes[],
  rect: { x: number; y: number; w: number; h: number },
): number | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  for (const ax of axes) {
    if (!ax.x_is_frames) continue;
    const x0 = rect.x + ax.bbox[0] * rect.w;
    const x1 = x0 + ax.bbox[2] * rect.w;
    const { y0, y1 } = figureAxesYSpan(ax, rect);
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    const t = (px - x0) / (x1 - x0);
    const [lo, hi] = ax.xlim;
    return Math.round(lo + t * (hi - lo));
  }
  return null;
}

/** THE ONE figure validator — shared by the mod boundary
 * (recipes.validateModValues) and the terminal claude-bind path
 * (plothost), so the two entrances cannot drift. Fail-closed, every
 * rejection BY NAME; frameCount powers the well-formed-but-wrong check (a
 * frames-axis describing a range that cannot be this trajectory's). */
export function validateFigure(
  value: unknown,
  frameCount: number,
): { ok: true; figure: { png: string; width: number; height: number; axes: FigureAxes[] } }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "a figure mod must return a dict {png, width, height, axes}" };
  }
  const m = value as Record<string, unknown>;
  if (typeof m.png !== "string" || m.png.length === 0) {
    return { ok: false, error: "figure.png must be a non-empty base64 string" };
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(m.png)) {
    return { ok: false, error: "figure.png is not valid base64" };
  }
  const decodedBytes = Math.floor(m.png.length * 3 / 4);
  if (decodedBytes > FIGURE_PNG_MAX_BYTES) {
    return {
      ok: false,
      error: `figure image is ${(decodedBytes / (1024 * 1024)).toFixed(1)} MiB — the cap is 2 MiB; lower the dpi or the figsize`,
    };
  }
  const dim = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 8 && (v as number) <= 8192;
  if (!dim(m.width) || !dim(m.height)) {
    return { ok: false, error: "figure width/height must be integers in [8, 8192]" };
  }
  if (!Array.isArray(m.axes)) {
    return { ok: false, error: "figure.axes must be a list (one entry per subplot; it may be empty)" };
  }
  const axes: FigureAxes[] = [];
  for (let i = 0; i < m.axes.length; i++) {
    const a = m.axes[i] as Record<string, unknown> | null;
    if (!a || typeof a !== "object") return { ok: false, error: `figure.axes[${i}] is not an object` };
    const bbox = a.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => Number.isFinite(v))) {
      return { ok: false, error: `figure.axes[${i}].bbox must be 4 finite numbers [x0, y0, w, h]` };
    }
    const [x0, y0, w, h] = bbox as number[];
    if (w <= 0 || h <= 0 || x0 < 0 || y0 < 0 || x0 + w > 1 || y0 + h > 1) {
      return { ok: false, error: `figure.axes[${i}].bbox must lie within [0,1]² with positive width/height` };
    }
    const xlim = a.xlim;
    if (!Array.isArray(xlim) || xlim.length !== 2 || !xlim.every((v) => Number.isFinite(v))) {
      return { ok: false, error: `figure.axes[${i}].xlim must be 2 finite numbers` };
    }
    if ((xlim[0] as number) >= (xlim[1] as number)) {
      return { ok: false, error: `figure.axes[${i}].xlim must be ordered (lo < hi)` };
    }
    if (typeof a.x_is_frames !== "boolean") {
      return { ok: false, error: `figure.axes[${i}].x_is_frames must be a boolean` };
    }
    if (a.x_is_frames) {
      // well-formed-but-wrong: a "frames" axis whose range cannot describe
      // this trajectory at all
      const [lo, hi] = xlim as [number, number];
      if (hi < 0 || lo > frameCount - 1) {
        return {
          ok: false,
          error: `figure.axes[${i}] declares x_is_frames but its xlim ${lo}..${hi} does not overlap frames 0..${frameCount - 1}`,
        };
      }
    }
    axes.push({
      bbox: [x0, y0, w, h],
      xlim: [xlim[0] as number, xlim[1] as number],
      x_is_frames: a.x_is_frames,
    });
  }
  return { ok: true, figure: { png: m.png, width: m.width as number, height: m.height as number, axes } };
}
