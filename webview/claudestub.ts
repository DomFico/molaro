/**
 * ⚠ STUB — replaced by the real backend.
 *
 * A throwaway scripted emitter that speaks the FROZEN panel↔backend contract
 * (claudemodel.ts) so the conversation panel is fully provable without any
 * assistant, model, network, or credentials. It sits at the SAME BOUNDARY
 * the real backend will — instantiated in the extension host, emitting over
 * the existing relay (src/extension.ts); the test harness wires this same
 * module through its host-loopback shim — so swapping the real backend in
 * later changes nothing in the panel.
 *
 * Script per user-message: streamed assistant-text; one AUTO-APPROVED tool
 * whose result carries per-point COLOR SCALARS over "#0-99" (a typed
 * result the viewer binds); one GATED tool whose approved result carries a
 * COMMAND ("create_sele alpha.group-0" — approval literally gates a scene
 * change; deny carries no result); turn-complete. Sentinel words route
 * alternate single-tool turns: "trigger-error" → the error path,
 * "scalar-size"/"scalar-opacity" → per-point scalars on those axes,
 * "series-demo" → a VALID length-T per-frame-series (a raw-valued sine —
 * the plot draws it), "series-mismatch" → a short series (the plot's
 * no-draw error path), "mismatch-demo" → a scalar-count mismatch (the
 * viewer binding's no-write error path).
 * `cancel` stops the script and emits turn-complete. Tool names/args are
 * fully generic and neutral (example_tool_a/example_tool_b, synthetic
 * labels, dataset-independent #index targets).
 *
 * Pure module: no DOM, no vscode — unit-tested under `node --test`.
 */
import type { AuthState, ClaudeCommand, ClaudeEvent, TypedResult } from "./claudemodel.ts";

/** A hermetic, hand-made 64×32 solid-color PNG (148 bytes) — the
 * figure-demo payload. Generated once (zlib/struct), embedded so the
 * scripted path never needs a rendering library. */
export const FIGURE_DEMO_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAW0lEQVR4nO3QMREAIBDAsJeCfmb8gYwMdMje66yz789GB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoDVAB2gN0AFaA3SA1gAdoD0QyekeUhFG1AAAAABJRU5ErkJggg==";

export interface ClaudeStubOptions {
  /** The auth-status emitted at creation (display-only; both states must be
   * testable). Defaults to "connected". */
  auth?: AuthState;
  authHint?: string;
  /** Gap between scripted events. Small for tests; keep >0 so streaming is
   * observably incremental. */
  delayMs?: number;
  /** The trajectory's frame count, supplied by the host (which learns it
   * from the viewer) — the stub can't know the dataset, but a VALID
   * per-frame series must be length-T. 0/absent = unknown (the series-demo
   * then emits a fallback length, which the plot route rejects honestly). */
  frameCount?: () => number;
}

export interface ClaudeStub {
  handle(cmd: ClaudeCommand): void;
  dispose(): void;
}

export function createClaudeStub(
  post: (ev: ClaudeEvent) => void,
  opts: ClaudeStubOptions = {},
): ClaudeStub {
  const delay = opts.delayMs ?? 40;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** callId of the gated tool awaiting the panel's decision, if any. */
  let awaiting: string | null = null;
  let active = false;
  let seq = 0;

  const at = (step: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, step * delay);
    timers.add(t);
  };
  const stop = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    awaiting = null;
  };
  const endTurn = (): void => {
    active = false;
    post({ type: "turn-complete" });
  };

  // The panel renders whatever auth-status it last saw; emitting at creation
  // covers the status line from first open (the host creates the stub on the
  // terminal's "claude-ready" signal, so this first emission always lands).
  post({
    type: "auth-status",
    state: opts.auth ?? "connected",
    hint: opts.authHint ?? "stub backend (scripted)",
  });

  return {
    handle(cmd: ClaudeCommand): void {
      if (cmd.type === "cancel") {
        if (!active) return;
        stop();
        endTurn();
        return;
      }
      if (cmd.type === "approval-decision") {
        if (!awaiting || cmd.callId !== awaiting) return;
        awaiting = null;
        const gated = cmd.callId;
        if (cmd.decision === "approve") {
          at(1, () => post({
            type: "tool-result", callId: gated, ok: true,
            summary: "example_tool_b ran create_sele alpha.group-0",
            result: { kind: "command", command: "create_sele alpha.group-0" },
          }));
        } else {
          at(1, () => post({
            type: "tool-result", callId: gated, ok: false,
            summary: "denied — example_tool_b did not run",
          }));
        }
        at(2, endTurn);
        return;
      }
      // user-message
      if (active) return; // the panel disables input mid-turn; ignore strays
      active = true;
      if (cmd.text.includes("trigger-error")) {
        at(1, () => post({ type: "error", message: "stub error — triggered by sentinel" }));
        at(2, endTurn);
        return;
      }
      // One auto-approved tool whose result carries the given typed payload,
      // then turn-complete — the sentinel turns that prove each result kind.
      // Point-index targets (#lo-hi) resolve to fixed counts on ANY dataset,
      // so the stub never has to know how many points exist.
      const oneToolTurn = (argsPreview: string, summary: string, result: TypedResult): void => {
        const id = `call-${++seq}`;
        at(1, () => post({ type: "assistant-text", delta: "Producing a typed result." }));
        at(2, () => post({
          type: "tool-proposed", callId: id, toolName: "example_tool_a", argsPreview,
        }));
        at(3, () => post({ type: "tool-result", callId: id, ok: true, summary, result }));
        at(4, endTurn);
      };
      const ramp = (n: number): number[] =>
        Array.from({ length: n }, (_, i) => i / Math.max(n - 1, 1));
      if (cmd.text.includes("scalar-size")) {
        oneToolTurn('{ target: "#100-149", axis: "size" }',
          "example_tool_a produced 50 size scalars",
          { kind: "per-point-scalar", target: "#100-149", axis: "size", scalars: ramp(50) });
        return;
      }
      if (cmd.text.includes("scalar-opacity")) {
        oneToolTurn('{ target: "#150-199", axis: "opacity" }',
          "example_tool_a produced 50 opacity scalars",
          { kind: "per-point-scalar", target: "#150-199", axis: "opacity", scalars: ramp(50) });
        return;
      }
      if (cmd.text.includes("scatter-mismatch")) {
        // x and y of unequal length — the plot route's fail-closed path
        oneToolTurn('{ label: "example_scatter" }',
          "example_tool_a produced a malformed scatter",
          { kind: "scatter", label: "example_scatter",
            x: [1, 2, 3, 4, 5], y: [1, 2, 3, 4] } as unknown as TypedResult);
        return;
      }
      if (cmd.text.includes("scatter-static")) {
        // NO frames: a legitimate static picture (no highlight, no seek)
        const n = 30;
        oneToolTurn('{ label: "example_scatter" }',
          "example_tool_a produced a static scatter",
          {
            kind: "scatter", label: "example_scatter",
            xLabel: "quantity_a", yLabel: "quantity_b",
            x: Array.from({ length: n }, (_, i) => 2 + (i % 6)),
            y: Array.from({ length: n }, (_, i) => 10 + ((i * 7) % 11)),
          });
        return;
      }
      if (cmd.text.includes("scatter-demo")) {
        // (x, y) per frame index 0..39 — a loop the playhead walks around
        const n = 40;
        const frames = Array.from({ length: n }, (_, i) => i);
        oneToolTurn('{ label: "example_scatter" }',
          "example_tool_a produced a synced scatter",
          {
            kind: "scatter", label: "example_scatter",
            xLabel: "quantity_a", yLabel: "quantity_b",
            x: frames.map((i) => 5 + 2 * Math.cos((i / n) * 2 * Math.PI)),
            y: frames.map((i) => 10 + 3 * Math.sin((i / n) * 2 * Math.PI)),
            frames,
          });
        return;
      }
      if (cmd.text.includes("figure-demo")) {
        // a VALID figure: a hermetic hand-made 64×32 PNG (solid color — the
        // harness patch-samples it) + two axes: one frames axis spanning
        // the trajectory, one static. Every mapping assertion drives off
        // this crafted metadata; matplotlib is never involved.
        const n = opts.frameCount?.() || 24;
        oneToolTurn('{ label: "example_figure" }',
          "example_tool_a produced a rendered figure",
          {
            kind: "figure", label: "example_figure",
            png: FIGURE_DEMO_PNG, width: 64, height: 32,
            axes: [
              { bbox: [0.125, 0.25, 0.75, 0.5], xlim: [0, n - 1], x_is_frames: true },
              { bbox: [0.125, 0.03125, 0.75, 0.125], xlim: [0, 1], x_is_frames: false },
            ],
          });
        return;
      }
      if (cmd.text.includes("figure-bad")) {
        // a frames-axis whose xlim cannot describe this trajectory — the
        // well-formed-but-wrong rejection (plothost's no-draw error path)
        oneToolTurn('{ label: "example_figure" }',
          "example_tool_a produced a mis-declared figure",
          {
            kind: "figure", label: "example_figure",
            png: FIGURE_DEMO_PNG, width: 64, height: 32,
            axes: [{ bbox: [0.1, 0.1, 0.8, 0.8], xlim: [5000, 9000], x_is_frames: true }],
          });
        return;
      }
      if (cmd.text.includes("series-mismatch")) {
        // 7 values regardless of T — the plot route's no-draw error path
        oneToolTurn('{ label: "example_series" }',
          "example_tool_a produced a short per-frame series",
          { kind: "per-frame-series", label: "example_series", values: ramp(7) });
        return;
      }
      if (cmd.text.includes("series-demo")) {
        // a VALID length-T series with an unmistakable shape: a raw-valued
        // sine (amplitude 3.5 around 10 — REAL numbers, the plot auto-scales)
        const n = opts.frameCount?.() || 24;
        const values = Array.from({ length: n }, (_, i) =>
          10 + 3.5 * Math.sin((i / Math.max(n - 1, 1)) * 2 * Math.PI));
        oneToolTurn('{ label: "example_series" }',
          `example_tool_a produced a per-frame series (${n} values)`,
          { kind: "per-frame-series", label: "example_series", values });
        return;
      }
      if (cmd.text.includes("mismatch-demo")) {
        // 5 scalars for 10 points — the binding must write NOTHING and error
        oneToolTurn('{ target: "#0-9", axis: "color" }',
          "example_tool_a produced a malformed scalar set",
          { kind: "per-point-scalar", target: "#0-9", axis: "color", scalars: ramp(5) });
        return;
      }
      // The default turn: streamed text; an AUTO-APPROVED tool whose result
      // carries per-point color scalars; a GATED tool whose approved result
      // carries a command (approval literally gates a scene change).
      const auto = `call-${++seq}`;
      const gated = `call-${++seq}`;
      at(1, () => post({ type: "assistant-text", delta: "Looking at " }));
      at(2, () => post({ type: "assistant-text", delta: "the target " }));
      at(3, () => post({ type: "assistant-text", delta: "now." }));
      at(4, () => post({
        type: "tool-proposed", callId: auto, toolName: "example_tool_a",
        argsPreview: '{ target: "#0-99", axis: "color" }',
      }));
      at(5, () => post({
        type: "tool-result", callId: auto, ok: true,
        summary: "example_tool_a produced 100 color scalars",
        result: { kind: "per-point-scalar", target: "#0-99", axis: "color", scalars: ramp(100) },
      }));
      at(6, () => post({
        type: "tool-proposed", callId: gated, toolName: "example_tool_b",
        argsPreview: '{ command: "create_sele alpha.group-0" }',
      }));
      at(7, () => {
        awaiting = gated;
        post({
          type: "approval-required", callId: gated, toolName: "example_tool_b",
          preview: "example_tool_b will run: create_sele alpha.group-0",
        });
        // …and now the script WAITS for the panel's approval-decision.
      });
    },
    dispose(): void {
      stop();
      active = false;
    },
  };
}
