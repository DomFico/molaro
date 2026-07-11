/**
 * Plot HOST orchestration — the routing/holding logic between the three
 * webviews, factored PURE (no vscode, no DOM) so the extension host
 * (src/extension.ts) and the test harness's loopback glue run the IDENTICAL
 * code — the claudestub.ts pattern. Responsibilities:
 *
 *   - learn the frame count from the viewer's one-shot viewerInfo;
 *   - intercept per-frame-series claude-binds from the terminal BEFORE the
 *     viewer relay (the other kinds pass through untouched), validate
 *     values.length === nFrames (mismatch → error outcome, NOTHING drawn,
 *     the previous series stays), hold the ONE active series, open/reveal
 *     the plot panel, push the series, and answer on the EXACT
 *     claude-bind-result channel #2a built (the transcript's ⤷ line);
 *   - forward the viewer's frameChanged to the plot (the playhead marker);
 *   - forward the plot's plotSeek to the viewer (click-to-seek);
 *   - re-push the held series + current frame on the plot page's
 *     "plot-ready" (a closed/reopened tab restores host-side — the plot
 *     webview needs no retention).
 *
 * The handle* methods return true when the message was consumed.
 */
import { parseTypedResult } from "./claudemodel.ts";

export interface PlotHostIO {
  /** Create or reveal the plot editor panel (no-op in the harness). */
  openPlot(): void;
  postToPlot(msg: unknown): void;
  postToViewer(msg: unknown): void;
  postToTerminal(msg: unknown): void;
}

export interface PlotHost {
  /** claude-bind carrying per-frame-series → consumed here; anything else
   * → false (the caller relays to the viewer as before). */
  handleTerminalMessage(msg: unknown): boolean;
  /** viewerInfo (frame count) and frameChanged (playhead forward). */
  handleViewerMessage(msg: unknown): boolean;
  /** plotSeek (→ viewer seekFrame) and plot-ready (re-push held state). */
  handlePlotMessage(msg: unknown): boolean;
  /** The viewer-reported frame count (0 until viewerInfo arrives) — also
   * the stub's frameCount() source, so it can emit length-T series. */
  nFrames(): number;
}

export function createPlotHost(io: PlotHostIO): PlotHost {
  let nFrames = 0;
  /** THE one active item — a line series or a scatter; a new result of
   * either kind replaces it in place. */
  let item:
    | { type: "series"; label: string; values: number[] }
    | { type: "scatter"; label: string; x: number[]; y: number[];
        frames?: number[]; xLabel?: string; yLabel?: string }
    | null = null;
  let lastFrame = 0;

  const pushItem = (): void => {
    if (!item) return;
    if (item.type === "series") {
      io.postToPlot({ type: "plotSeries", label: item.label, values: item.values, nFrames });
    } else {
      io.postToPlot({
        type: "plotScatter", label: item.label, x: item.x, y: item.y,
        ...(item.frames ? { frames: item.frames } : {}),
        ...(item.xLabel ? { xLabel: item.xLabel } : {}),
        ...(item.yLabel ? { yLabel: item.yLabel } : {}),
      });
    }
  };

  return {
    handleTerminalMessage(msg: unknown): boolean {
      const m = msg as { type?: string; callId?: string; result?: unknown } | undefined;
      if (m?.type !== "claude-bind") return false;
      // Consume by RAW kind, so a malformed plot payload fails CLOSED here
      // with a proper error instead of leaking to the viewer's binding.
      const rawKind = (m.result as { kind?: unknown } | null | undefined)?.kind;
      if (rawKind !== "per-frame-series" && rawKind !== "scatter") return false;
      const fail = (message: string): true => {
        io.postToTerminal({ type: "claude-bind-result", callId: m.callId, ok: false, message });
        return true; // consumed: NOTHING drawn, the previous item stands
      };
      const typed = parseTypedResult(m.result);
      if (!typed || (typed.kind !== "per-frame-series" && typed.kind !== "scatter")) {
        return fail(`malformed ${rawKind} payload — not drawn`);
      }
      if (typed.kind === "per-frame-series") {
        if (nFrames < 1 || typed.values.length !== nFrames) {
          return fail(`series length mismatch: ${typed.values.length} values for ${nFrames} frames — not drawn`);
        }
        item = { type: "series", label: typed.label, values: typed.values };
      } else {
        // frames (the sync hook) must be valid in-range frame indices
        if (typed.frames) {
          for (const f of typed.frames) {
            if (!Number.isInteger(f) || f < 0 || f >= nFrames) {
              return fail(`scatter frames must be integer frame indices in [0, ${nFrames - 1}] — got ${f} — not drawn`);
            }
          }
        }
        item = {
          type: "scatter", label: typed.label, x: typed.x, y: typed.y,
          ...(typed.frames ? { frames: typed.frames } : {}),
          ...(typed.xLabel ? { xLabel: typed.xLabel } : {}),
          ...(typed.yLabel ? { yLabel: typed.yLabel } : {}),
        };
      }
      io.openPlot();
      pushItem();
      io.postToPlot({ type: "plotFrame", frame: lastFrame });
      io.postToTerminal({
        type: "claude-bind-result", callId: m.callId, ok: true,
        message: typed.kind === "per-frame-series"
          ? `series "${typed.label}" drawn (${typed.values.length} frames) — click the plot to seek`
          : `scatter "${typed.label}" drawn (${typed.x.length} points${typed.frames ? " — click a point to seek" : ""})`,
      });
      return true;
    },
    handleViewerMessage(msg: unknown): boolean {
      const m = msg as { type?: string; nFrames?: number; frame?: number } | undefined;
      if (m?.type === "viewerInfo") {
        nFrames = Number(m.nFrames ?? 0);
        return true;
      }
      if (m?.type === "frameChanged") {
        lastFrame = Number(m.frame ?? 0);
        io.postToPlot({ type: "plotFrame", frame: lastFrame });
        return true;
      }
      return false;
    },
    handlePlotMessage(msg: unknown): boolean {
      const m = msg as { type?: string; frame?: number } | undefined;
      if (m?.type === "plotSeek") {
        io.postToViewer({ type: "seekFrame", frame: Number(m.frame ?? 0) });
        return true;
      }
      if (m?.type === "plot-ready") {
        pushItem();
        io.postToPlot({ type: "plotFrame", frame: lastFrame });
        return true;
      }
      return false;
    },
    nFrames(): number {
      return nFrames;
    },
  };
}
