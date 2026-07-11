/**
 * The conversation panel's message contract + transcript reducer. PURE — no
 * DOM, no vscode — unit-tested under `node --test`.
 *
 * THE CONTRACT IS FROZEN. The panel and the backend talk over the existing
 * webview↔extension-host relay in exactly these two message sets; everything
 * in the panel is a renderer over them, and the backend behind them is
 * swappable (today a scripted stub — see claudestub.ts — later the real
 * assistant, with NOTHING in the panel changing).
 *
 * Transcript semantics: user messages and assistant turns interleave;
 * assistant-text deltas concatenate into the current assistant turn; a
 * tool-proposed renders as an inline block under the current turn; an
 * approval-required puts approve/deny on that block; a tool-result resolves
 * the block by callId; turn-complete ends the assistant turn and re-enables
 * input; error renders an error block; auth-status drives a display-only
 * status line (no credential entry — an indicator plus hint text).
 */

// -- backend → panel (events) ---------------------------------------------------

export type AuthState = "connected" | "disconnected";

export interface AuthStatusEvent {
  type: "auth-status";
  state: AuthState;
  hint?: string;
}
export interface AssistantTextEvent {
  type: "assistant-text";
  delta: string;
}
export interface ToolProposedEvent {
  type: "tool-proposed";
  callId: string;
  toolName: string;
  argsPreview: string;
}
export interface ApprovalRequiredEvent {
  type: "approval-required";
  callId: string;
  toolName: string;
  preview: string;
}
/**
 * The typed payload a tool-result may carry — a CLOSED union; an unknown
 * kind is an error at the binding, never a guess. The transcript never
 * reads it (summary stays the display string); the BINDING layer
 * (claudebind.ts, viewer-side) is a separate consumer that turns it into
 * scene changes on the existing rails.
 *
 * per-point-scalar: scalars arrive ALREADY normalized to [0,1] — the
 * binding maps [0,1] → visual and never normalizes or interprets
 * magnitudes. scalars[i] corresponds to the i-th point of `target`
 * resolved in HEADER ORDER (rainbow's exact ordering contract); a length
 * mismatch writes nothing.
 *
 * per-frame-series: RESERVED — recognized and acknowledged, its renderer
 * (a synced plot) is a separate step; today it reaches a placeholder.
 */
export type TypedResult =
  | { kind: "per-point-scalar"; target: string; axis: "color" | "size" | "opacity"; scalars: number[] }
  | { kind: "command"; command: string }
  | { kind: "per-frame-series"; label: string; values: number[] };

export interface ToolResultEvent {
  type: "tool-result";
  callId: string;
  ok: boolean;
  /** OPAQUE display string — the panel shows it and does nothing else with
   * it; any scene effect comes only from `result`. */
  summary: string;
  /** The typed payload, when the tool produced one. parseClaudeEvent
   * attaches it only when valid; the binding dispatch re-validates the raw
   * wire value through the SAME parseTypedResult, so malformed payloads
   * surface as binding errors without touching the transcript. */
  result?: TypedResult;
}
export interface TurnCompleteEvent {
  type: "turn-complete";
}
export interface ErrorEvent {
  type: "error";
  message: string;
}
export type ClaudeEvent =
  | AuthStatusEvent
  | AssistantTextEvent
  | ToolProposedEvent
  | ApprovalRequiredEvent
  | ToolResultEvent
  | TurnCompleteEvent
  | ErrorEvent;

// -- panel → backend (commands) -------------------------------------------------

export interface UserMessageCommand {
  type: "user-message";
  text: string;
}
export interface ApprovalDecisionCommand {
  type: "approval-decision";
  callId: string;
  decision: "approve" | "deny";
}
export interface CancelCommand {
  type: "cancel";
}
export type ClaudeCommand = UserMessageCommand | ApprovalDecisionCommand | CancelCommand;

// -- (de)serialization: unknown wire data → typed messages ------------------------
// The relay passes plain JSON-safe objects; these parsers are the single
// place wire data becomes typed (both hosts call them — no ad-hoc casts).

const isStr = (x: unknown): x is string => typeof x === "string";
const isNumArr = (x: unknown): x is number[] =>
  Array.isArray(x) && x.every((v) => typeof v === "number" && Number.isFinite(v));

/** THE closed-union gate for typed results — the single validator both the
 * event parser and the viewer-side binding dispatch call. Unknown kinds and
 * malformed shapes are null (the binding turns that into an error). No
 * range clamping: scalars are contractually [0,1] and whatever produced
 * them owns their normalization. */
export function parseTypedResult(x: unknown): TypedResult | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  switch (m.kind) {
    case "per-point-scalar":
      return isStr(m.target) &&
        (m.axis === "color" || m.axis === "size" || m.axis === "opacity") &&
        isNumArr(m.scalars)
        ? { kind: "per-point-scalar", target: m.target, axis: m.axis, scalars: m.scalars }
        : null;
    case "command":
      return isStr(m.command) ? { kind: "command", command: m.command } : null;
    case "per-frame-series":
      return isStr(m.label) && isNumArr(m.values)
        ? { kind: "per-frame-series", label: m.label, values: m.values }
        : null;
    default:
      return null;
  }
}

export function parseClaudeEvent(x: unknown): ClaudeEvent | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  switch (m.type) {
    case "auth-status":
      if ((m.state === "connected" || m.state === "disconnected") &&
          (m.hint === undefined || isStr(m.hint))) {
        return { type: "auth-status", state: m.state, ...(isStr(m.hint) ? { hint: m.hint } : {}) };
      }
      return null;
    case "assistant-text":
      return isStr(m.delta) ? { type: "assistant-text", delta: m.delta } : null;
    case "tool-proposed":
      return isStr(m.callId) && isStr(m.toolName) && isStr(m.argsPreview)
        ? { type: "tool-proposed", callId: m.callId, toolName: m.toolName, argsPreview: m.argsPreview }
        : null;
    case "approval-required":
      return isStr(m.callId) && isStr(m.toolName) && isStr(m.preview)
        ? { type: "approval-required", callId: m.callId, toolName: m.toolName, preview: m.preview }
        : null;
    case "tool-result": {
      if (!(isStr(m.callId) && typeof m.ok === "boolean" && isStr(m.summary))) return null;
      const ev: ToolResultEvent = { type: "tool-result", callId: m.callId, ok: m.ok, summary: m.summary };
      // attach only a VALID typed result; a malformed one is still forwarded
      // raw by the terminal and errors at the binding dispatch (same gate)
      const typed = m.result === undefined ? null : parseTypedResult(m.result);
      if (typed) ev.result = typed;
      return ev;
    }
    case "turn-complete":
      return { type: "turn-complete" };
    case "error":
      return isStr(m.message) ? { type: "error", message: m.message } : null;
    default:
      return null;
  }
}

export function parseClaudeCommand(x: unknown): ClaudeCommand | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  switch (m.type) {
    case "user-message":
      return isStr(m.text) ? { type: "user-message", text: m.text } : null;
    case "approval-decision":
      return isStr(m.callId) && (m.decision === "approve" || m.decision === "deny")
        ? { type: "approval-decision", callId: m.callId, decision: m.decision }
        : null;
    case "cancel":
      return { type: "cancel" };
    default:
      return null;
  }
}

// -- transcript state (the reducer the panel renders from) -----------------------

export interface ToolBlock {
  callId: string;
  toolName: string;
  argsPreview: string;
  /** null until an approval-required arrives; then the gate's preview plus
   * the user's decision (null while the buttons are live). */
  approval: { preview: string; decision: "approve" | "deny" | null } | null;
  result: { ok: boolean; summary: string } | null;
  /** The viewer's binding outcome for this call's typed result (fed by the
   * claude-bind-result transport reply, like markDecision — panel-local,
   * not a contract event). null = no typed result / not yet bound. */
  bind: { ok: boolean; message: string } | null;
}
export interface UserTurn {
  kind: "user";
  text: string;
}
export interface AssistantTurn {
  kind: "assistant";
  text: string;
  blocks: ToolBlock[];
}
export interface ErrorItem {
  kind: "error";
  message: string;
}
export type TranscriptItem = UserTurn | AssistantTurn | ErrorItem;

export interface TranscriptState {
  items: TranscriptItem[];
  /** true while an assistant turn is in flight — the input is disabled and
   * the cancel affordance is live; turn-complete clears it. */
  busy: boolean;
  /** Latest auth-status, display-only; null until the first event. */
  auth: { state: AuthState; hint: string } | null;
  /** Open assistant turn deltas/blocks append to (turn-complete closes it). */
  openTurn: AssistantTurn | null;
  /** callId → its block, so results resolve across items in O(1). */
  toolIndex: Map<string, ToolBlock>;
}

export function createTranscript(): TranscriptState {
  return { items: [], busy: false, auth: null, openTurn: null, toolIndex: new Map() };
}

/** The panel calls this when the user sends — a user turn enters the
 * transcript and the input locks until the backend's turn-complete. */
export function addUserMessage(state: TranscriptState, text: string): void {
  state.items.push({ kind: "user", text });
  state.openTurn = null;
  state.busy = true;
}

/** The panel calls this the moment approve/deny is clicked, so the buttons
 * render disabled from state (the backend's tool-result lands separately). */
export function markDecision(
  state: TranscriptState,
  callId: string,
  decision: "approve" | "deny",
): void {
  const block = state.toolIndex.get(callId);
  if (block?.approval) block.approval.decision = decision;
}

/** The viewer's answer to a forwarded typed result — rendered as the tool
 * block's binding line (ok or error styling). */
export function setBindOutcome(
  state: TranscriptState,
  callId: string,
  outcome: { ok: boolean; message: string },
): void {
  const block = state.toolIndex.get(callId);
  if (block) block.bind = outcome;
}

function openTurn(state: TranscriptState): AssistantTurn {
  if (!state.openTurn) {
    state.openTurn = { kind: "assistant", text: "", blocks: [] };
    state.items.push(state.openTurn);
  }
  return state.openTurn;
}

export function applyEvent(state: TranscriptState, ev: ClaudeEvent): void {
  switch (ev.type) {
    case "auth-status":
      state.auth = { state: ev.state, hint: ev.hint ?? "" };
      return;
    case "assistant-text":
      openTurn(state).text += ev.delta;
      return;
    case "tool-proposed": {
      const block: ToolBlock = {
        callId: ev.callId,
        toolName: ev.toolName,
        argsPreview: ev.argsPreview,
        approval: null,
        result: null,
        bind: null,
      };
      openTurn(state).blocks.push(block);
      state.toolIndex.set(ev.callId, block);
      return;
    }
    case "approval-required": {
      const block = state.toolIndex.get(ev.callId);
      if (block) block.approval = { preview: ev.preview, decision: null };
      return;
    }
    case "tool-result": {
      const block = state.toolIndex.get(ev.callId);
      if (block) block.result = { ok: ev.ok, summary: ev.summary };
      return;
    }
    case "turn-complete":
      state.openTurn = null;
      state.busy = false;
      return;
    case "error":
      state.items.push({ kind: "error", message: ev.message });
      return;
  }
}
