/**
 * The REAL assistant backend — Claude Agent SDK, in the extension host, speaking
 * the FROZEN panel↔backend contract (claudemodel.ts) at the exact boundary the
 * scripted stub sat. Swapping this in changes NOTHING in the panel.
 *
 *   panel command  ──▶  handle()  ──▶  SDK query (streaming input)
 *   SDK messages   ──▶  mapSdkMessage  ──▶  post(ClaudeEvent)  ──▶  panel
 *
 * Mapping: partial stream events → assistant-text deltas; assistant tool_use →
 * tool-proposed; canUseTool (gated tools) → approval-required, awaiting the
 * panel's approval-decision; tool_result → tool-result (a failed mod's FULL
 * traceback rides through as the result text, so the model self-corrects);
 * result → turn-complete; any thrown/auth/model error → error. `cancel` →
 * query.interrupt() then turn-complete.
 *
 * The tools do their work through injected host callbacks (ToolDeps) — every
 * one an EXISTING path. No neutral-tier file is touched.
 */
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCommand, ClaudeEvent } from "../webview/claudemodel.ts";
import {
  buildAgentOptions, createToolServer, describeRunModParams, toolPolicy, MCP_SERVER_NAME,
  type SceneContext, type ToolDeps,
} from "./claudetools.ts";
import { buildSystemPrompt } from "./claudeprompt.ts";

export interface BackendDeps extends ToolDeps {
  /** Resolved key, or null → the backend runs in a disconnected state (every
   * turn reports the missing key; a later setKey() connects it live). */
  apiKey: string | null;
  model: string;
  authHint: string;
  /** Live scene, injected into the system prompt at query start. */
  getSceneContext(): Promise<SceneContext | null>;
}

export interface ClaudeBackend {
  handle(cmd: ClaudeCommand): void;
  dispose(): void;
  /** Called when the stored API key changes (set/clear command); re-drives
   * auth-status and lets the next turn connect. */
  setApiKey(key: string | null): void;
}

const bareName = (qualified: string): string => qualified.split("__").at(-1) ?? qualified;

/** A compact one-line args preview for the tool-proposed block (NOT the
 * approval preview — write_mod's approval preview is the full Python). */
export function argsPreview(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (k === "code") { parts.push("code: <python>"); continue; }
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 60 ? s.slice(0, 57) + "…" : s}`);
  }
  return `{ ${parts.join(", ")} }`;
}

/** The human-facing approval preview for a gated tool. write_mod shows the FULL
 * Python source (the "nothing runs unseen" beat); run_mod shows what will run. */
export function approvalPreview(
  bareTool: string,
  input: Record<string, unknown>,
  /** run_mod only: the effective-parameters suffix (defaults filled) so the
   * human approves what will actually happen — computed host-side from the mod's
   * schema (describeRunModParams), "" when the mod declares no parameters. */
  paramsSuffix = "",
): string {
  if (bareTool === "write_mod") {
    const header = `write_mod → .molaro/mods/${String(input.name ?? "?")}.py` +
      ` (produces: ${String(input.produces ?? "?")}${input.axis ? `, axis: ${String(input.axis)}` : ""})`;
    return `${header}\n\n${String(input.code ?? "")}`;
  }
  if (bareTool === "run_mod") {
    return `run_mod → run "${String(input.name ?? "?")}" on target "${String(input.target ?? "?")}"${paramsSuffix}`;
  }
  if (bareTool === "delete_mod") {
    const name = String(input.name ?? "?");
    return `delete_mod → DELETE mod "${name}" (.molaro/mods/${name}.py). This removes the file permanently.`;
  }
  return `${bareTool} ${JSON.stringify(input)}`;
}

/** Pure map: one SDK message → zero or more contract events (approval events
 * come from canUseTool, handled by the orchestrator, not here). Exported for
 * conformance tests — every event it yields must parse via parseClaudeEvent. */
export function mapSdkMessage(msg: SDKMessage): ClaudeEvent[] {
  const out: ClaudeEvent[] = [];
  switch (msg.type) {
    case "stream_event": {
      const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        if (ev.delta.text.length > 0) out.push({ type: "assistant-text", delta: ev.delta.text });
      }
      return out;
    }
    case "assistant": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === "tool_use" && typeof block.id === "string") {
            out.push({
              type: "tool-proposed",
              callId: block.id,
              toolName: bareName(String(block.name ?? "tool")),
              argsPreview: argsPreview((block.input ?? {}) as Record<string, unknown>),
            });
          }
        }
      }
      return out;
    }
    case "user": {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
          if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
            out.push({
              type: "tool-result",
              callId: block.tool_use_id,
              ok: block.is_error !== true,
              summary: toolResultText(block.content),
            });
          }
        }
      }
      return out;
    }
    case "result": {
      const r = msg as { is_error?: boolean; subtype?: string; result?: string };
      if (r.is_error === true && r.subtype !== "success") {
        out.push({ type: "error", message: r.result || `assistant error (${r.subtype ?? "unknown"})` });
      }
      out.push({ type: "turn-complete" });
      return out;
    }
    default:
      return out;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n") || "(no output)";
  }
  return "(no output)";
}

/** Spawn the SDK with the REAL hardened options (a fake key) and read the
 * model's TRUE runtime tool surface + MCP servers from the `init` system
 * message — the authoritative allow-list check. `init` is emitted locally
 * before any API call, so a fake key and no network suffice; we abort the
 * moment we have it. This is what the surface test asserts equality against —
 * a deny-list can only catch names we thought to write down; this reads what
 * the SDK actually exposes. */
export async function probeRuntimeToolSurface(
  deps: ToolDeps,
  timeoutMs = 20000,
): Promise<{ tools: string[]; mcpServers: string[] }> {
  const abortController = new AbortController();
  const options = buildAgentOptions({
    model: "claude-sonnet-5",
    apiKey: "sk-ant-surface-probe",
    toolServer: createToolServer(deps),
    systemPrompt: "runtime tool-surface probe",
    abortController,
  });
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    for await (const msg of query({ prompt: "probe", options })) {
      const m = msg as { type?: string; subtype?: string; tools?: string[]; mcp_servers?: { name: string }[] };
      if (m.type === "system" && m.subtype === "init") {
        return {
          tools: (m.tools ?? []).slice().sort(),
          mcpServers: (m.mcp_servers ?? []).map((s) => s.name).sort(),
        };
      }
    }
    throw new Error("no init system message before the stream ended");
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

export function createClaudeBackend(
  post: (ev: ClaudeEvent) => void,
  deps: BackendDeps,
): ClaudeBackend {
  let apiKey = deps.apiKey;
  let active = false;               // a turn is in flight
  let started = false;              // the query loop has been launched
  let disposed = false;

  // Streaming input: user messages are pushed into this queue; the query
  // consumes it for the life of the session (multi-turn context preserved).
  let pushInput: ((m: SDKUserMessage) => void) | null = null;
  let closeInput: (() => void) | null = null;
  let queryHandle: Query | null = null;
  let abort: AbortController | null = null;

  const proposed = new Set<string>();
  const pendingApprovals = new Map<string, (decision: "approve" | "deny") => void>();

  const emit = (ev: ClaudeEvent): void => {
    if (ev.type === "tool-proposed") {
      if (proposed.has(ev.callId)) return; // dedupe: canUseTool may pre-emit
      proposed.add(ev.callId);
    }
    post(ev);
  };

  const emitAuth = (): void =>
    post(apiKey
      ? { type: "auth-status", state: "connected", hint: deps.authHint }
      : { type: "auth-status", state: "disconnected", hint: deps.authHint });
  emitAuth();

  const makeInputIterable = (): AsyncIterable<SDKUserMessage> => {
    const buffer: SDKUserMessage[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    pushInput = (m) => { buffer.push(m); notify?.(); };
    closeInput = () => { done = true; notify?.(); };
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (buffer.length) yield buffer.shift()!;
          if (done) return;
          await new Promise<void>((r) => { notify = r; });
          notify = null;
        }
      },
    };
  };

  const userMessage = (text: string): SDKUserMessage =>
    ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as unknown as SDKUserMessage);

  const startQuery = async (): Promise<void> => {
    if (queryHandle || !apiKey) return;
    abort = new AbortController();
    const ctx = await deps.getSceneContext().catch(() => null);
    const options: Options = buildAgentOptions({
      model: deps.model,
      apiKey,
      toolServer: createToolServer(deps),
      systemPrompt: buildSystemPrompt(ctx),
      abortController: abort,
    });
    // The approval gate AND the permission-boundary allow-list. canUseTool fires
    // for every tool not auto-approved (our gated two, plus anything that
    // bypassed the deny-list/init surface). toolPolicy is an ALLOW-LIST: gated →
    // approval; DENY everything else — a leaked SDK tool or a native capability
    // (e.g. AskUserQuestion) emitted as a tool_use is refused here, not allowed.
    options.canUseTool = async (toolName, input, opts) => {
      const bare = bareName(toolName);
      const callId = (opts as { toolUseID?: string })?.toolUseID ?? `call-${Math.random().toString(36).slice(2)}`;
      if (toolPolicy(toolName) !== "gated") {
        return { behavior: "deny", message: `"${bare}" is not one of Molaro's tools.` };
      }
      emit({ type: "tool-proposed", callId, toolName: bare, argsPreview: argsPreview(input) });
      // run_mod's preview shows the EFFECTIVE parameters (defaults filled) so the
      // human approves what will actually run, not just the passed subset.
      const paramsSuffix = bare === "run_mod" && deps.runModParams
        ? describeRunModParams(deps.runModParams(String(input.name ?? "")), input.parameters as Record<string, unknown> | undefined)
        : "";
      post({ type: "approval-required", callId, toolName: bare, preview: approvalPreview(bare, input, paramsSuffix) });
      const decision = await new Promise<"approve" | "deny">((resolve) => {
        pendingApprovals.set(callId, resolve);
      });
      pendingApprovals.delete(callId);
      return decision === "approve"
        ? { behavior: "allow" }
        : { behavior: "deny", message: "The user denied this tool call in the Molaro panel." };
    };

    const input = makeInputIterable(); // sets pushInput/closeInput synchronously
    started = true;
    void (async () => {
      try {
        // query() is called INSIDE the try: it can throw synchronously when the
        // SDK runtime is unavailable (missing/wrong-platform native binary), and
        // that must surface through the contract, not escape as an unhandled
        // rejection (which would leave the panel hung — the bug this guards).
        queryHandle = query({ prompt: input, options });
        for await (const msg of queryHandle) {
          if (disposed) break;
          for (const ev of mapSdkMessage(msg)) {
            // the query is long-lived (multi-turn) and never ends between
            // turns, so a turn boundary — not loop exit — re-enables input.
            if (ev.type === "turn-complete") active = false;
            emit(ev);
          }
        }
      } catch (e) {
        if (!disposed) {
          post({ type: "error", message: errorMessage(e) });
          // if the SDK RUNTIME itself is unavailable (e.g. the native binary is
          // missing / wrong platform — the assistant cannot run at all on this
          // machine), reflect it in the status line too, so the user isn't left
          // with a connected indicator over a dead assistant.
          if (isRuntimeUnavailable(e)) {
            post({ type: "auth-status", state: "disconnected", hint: RUNTIME_UNAVAILABLE_HINT });
          }
          post({ type: "turn-complete" });
        }
      } finally {
        // the loop only exits on error/dispose (a healthy multi-turn query never
        // returns between turns) — reset so the NEXT message re-attempts and, on
        // a hard runtime failure, re-reports loudly rather than silently dropping.
        active = false;
        started = false;
        queryHandle = null;
        closeInput?.();
      }
    })();
  };

  return {
    handle(cmd: ClaudeCommand): void {
      if (disposed) return;
      if (cmd.type === "cancel") {
        if (!active) return;
        // release any in-flight approval so the SDK unwinds, then interrupt
        for (const [, resolve] of pendingApprovals) resolve("deny");
        pendingApprovals.clear();
        void queryHandle?.interrupt().catch(() => {});
        active = false;
        post({ type: "turn-complete" });
        return;
      }
      if (cmd.type === "approval-decision") {
        pendingApprovals.get(cmd.callId)?.(cmd.decision);
        return;
      }
      // user-message
      if (active) return; // input is disabled mid-turn; ignore strays
      if (!apiKey) {
        post({ type: "error", message: deps.authHint });
        post({ type: "turn-complete" });
        return;
      }
      active = true;
      if (!started) {
        void startQuery().then(() => pushInput?.(userMessage(cmd.text)));
      } else {
        pushInput?.(userMessage(cmd.text));
      }
    },
    setApiKey(key: string | null): void {
      apiKey = key;
      emitAuth();
      // a freshly-set key connects on the NEXT turn; a cleared key leaves any
      // running session alone but blocks new turns.
    },
    dispose(): void {
      disposed = true;
      for (const [, resolve] of pendingApprovals) resolve("deny");
      pendingApprovals.clear();
      void queryHandle?.interrupt().catch(() => {});
      closeInput?.();
      abort?.abort();
      queryHandle = null;
    },
  };
}

export const RUNTIME_UNAVAILABLE_HINT =
  "The assistant runtime isn't available on this platform. The Claude Agent SDK needs its " +
  "native binary, which this build ships only for its packaged platform.";

/** True when the SDK could not launch its agent runtime at all (missing/wrong
 * platform native binary, or the executable failed to spawn) — a hard, machine-
 * level unavailability, distinct from an auth or rate-limit error. Must surface
 * loudly through the contract, never as a hang or silent no-op. */
export function isRuntimeUnavailable(e: unknown): boolean {
  const raw = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /native cli binary|executable not found|failed to launch|pathtoclaudecodeexecutable|enoent/.test(raw);
}

export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (isRuntimeUnavailable(e)) {
    return `The analysis assistant can't start on this platform — ${RUNTIME_UNAVAILABLE_HINT} ` +
      "The rest of Molaro (viewer, terminal, mods) works normally.";
  }
  if (/api key|401|authentication|x-api-key/i.test(raw)) {
    return "Anthropic API authentication failed — check your API key (Molaro: Set Anthropic API Key).";
  }
  if (/rate.?limit|429/i.test(raw)) return "Anthropic rate limit reached — try again shortly.";
  return `Assistant error: ${raw}`;
}
