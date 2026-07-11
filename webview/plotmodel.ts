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

/** The polyline's `points` attribute: one vertex per frame, x from the
 * SHARED frame mapping, y from the scale. */
export function pointsFor(values: readonly number[], scale: PlotScale): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    parts.push(`${frameToX(i, values.length)},${valueToY(values[i], scale)}`);
  }
  return parts.join(" ");
}
