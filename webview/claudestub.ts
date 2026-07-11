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
 * (proposed → result, no gate); one GATED tool (proposed → approval-required,
 * result only after the panel's approval-decision); turn-complete. A message
 * containing the sentinel word "trigger-error" emits an error instead.
 * `cancel` stops the script and emits turn-complete. Tool names/args are
 * fully generic and neutral (example_tool_a/example_tool_b, synthetic
 * labels).
 *
 * Pure module: no DOM, no vscode — unit-tested under `node --test`.
 */
import type { AuthState, ClaudeCommand, ClaudeEvent } from "./claudemodel.ts";

export interface ClaudeStubOptions {
  /** The auth-status emitted at creation (display-only; both states must be
   * testable). Defaults to "connected". */
  auth?: AuthState;
  authHint?: string;
  /** Gap between scripted events. Small for tests; keep >0 so streaming is
   * observably incremental. */
  delayMs?: number;
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
            summary: "example_tool_b completed on subgroup-3",
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
      const auto = `call-${++seq}`;
      const gated = `call-${++seq}`;
      at(1, () => post({ type: "assistant-text", delta: "Looking at " }));
      at(2, () => post({ type: "assistant-text", delta: "the target " }));
      at(3, () => post({ type: "assistant-text", delta: "now." }));
      at(4, () => post({
        type: "tool-proposed", callId: auto, toolName: "example_tool_a",
        argsPreview: '{ target: "group-0", n: 42 }',
      }));
      at(5, () => post({
        type: "tool-result", callId: auto, ok: true,
        summary: "example_tool_a completed on group-0",
      }));
      at(6, () => post({
        type: "tool-proposed", callId: gated, toolName: "example_tool_b",
        argsPreview: '{ target: "subgroup-3" }',
      }));
      at(7, () => {
        awaiting = gated;
        post({
          type: "approval-required", callId: gated, toolName: "example_tool_b",
          preview: "example_tool_b on subgroup-3",
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
