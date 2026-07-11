/**
 * The assistant's tool surface — FOUR in-process MCP tools, and the hard
 * lockdown around them. PURE-ish (the SDK `tool()`/`createSdkMcpServer()`
 * factories + injected host callbacks); no vscode, no live query — unit-tested
 * under `node --test`.
 *
 * The security fence lives here, asserted by test:
 *  - `buildAgentOptions` restricts `allowedTools` to EXACTLY our four MCP tools,
 *    lists the SDK's built-ins in `disallowedTools`, and sets `settingSources`
 *    to [] so no user/project `.claude/` config (tools, permissions, MCP
 *    servers) is loaded. If the model could reach Bash/Edit/Read, every gate in
 *    this system would be a fiction.
 *  - `run_command` refuses `rm` (and any analysis-mod invocation) at the tool
 *    boundary — a returned error the model can see, not a prompt it can talk
 *    around. All destructive or Python-executing actions route through the
 *    GATED tools only.
 */
import { tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const MCP_SERVER_NAME = "molaro";

/** The bare tool names our MCP server exposes. */
export const TOOL_NAMES = ["get_context", "write_mod", "run_mod", "run_command"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Gated tools require human approval (they write files / execute Python). The
 * ungated two are auto-allowed: `get_context` is read-only, `run_command` runs
 * only undoable scene verbs (with the deny-list below). */
export const GATED_TOOLS: ToolName[] = ["write_mod", "run_mod"];

/** The MCP-qualified name the SDK matches against `allowedTools`. */
export const qualified = (name: ToolName): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/** Every built-in tool the Agent SDK can ship — named explicitly in
 * `disallowedTools` so they are stripped from the model's context entirely,
 * belt-and-suspenders with the allowedTools allowlist and the canUseTool
 * deny-by-default. */
export const SDK_BUILTIN_TOOLS = [
  "Bash", "Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "NotebookRead",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite",
  "KillShell", "BashOutput", "ExitPlanMode",
];

/** The live scene shape `get_context` reports, assembled host-side from the
 * cached producer header + workspace mod scan + an `ls` of committed
 * selections. Nothing here is hardcoded. */
export interface SceneContext {
  system: string;
  nAtoms: number;
  nFrames: number;
  categories: string[];
  groups: string[];
  subgroupCount: number;
  /** e.g. "alpha.group-0" — a few real, constructible target examples. */
  targetExamples: string[];
  committedSelections: string;
  mods: { name: string; produces: string; axis?: string; description?: string }[];
}

export interface WriteModSpec {
  name: string;
  produces: "per-point-scalar" | "per-frame-series" | "scatter";
  axis?: "color" | "size" | "opacity";
  description: string;
  code: string;
}

/** The host callbacks the tools drive — every one an EXISTING path (the
 * command relay, saveWorkspaceMod, the header/mod mirrors). The tools own no
 * state and touch no neutral-tier file directly. */
export interface ToolDeps {
  getContext(): Promise<SceneContext>;
  writeMod(spec: WriteModSpec): Promise<{ name: string; file: string }>;
  runMod(name: string, target: string): Promise<{ ok: boolean; message: string }>;
  runCommand(text: string): Promise<{ ok: boolean; message: string }>;
  /** Analysis-mod names, so run_command can refuse Python-executing verbs and
   * force them through the gated run_mod. Re-read each call (mods change). */
  analysisModNames(): string[];
}

/** THE deny-list at the run_command boundary. Returns a refusal reason, or null
 * to allow. Refuses `rm` (destructive, outside undo) and any analysis-mod
 * invocation (that is Python execution — it must go through the GATED run_mod,
 * never this ungated verb). Static + guaranteed, not a prompt suggestion. */
export function blockedCommandReason(text: string, analysisModNames: string[]): string | null {
  const verb = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (verb === "rm") {
    return "run_command cannot run `rm`. Deleting mod files is destructive and " +
      "outside the undo model; there is no path to file deletion from the assistant.";
  }
  if (analysisModNames.map((n) => n.toLowerCase()).includes(verb)) {
    return `"${verb}" is an analysis mod (it executes Python). Run it through ` +
      "the run_mod tool, which is gated for approval — not run_command.";
  }
  return null;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Build the four tool definitions (exported for tests, which invoke the
 * handlers directly to prove the rm deny-list and the traceback passthrough). */
export function buildToolDefs(deps: ToolDeps) {
  const getContext = tool(
    "get_context",
    "Return the loaded molecular system's shape and current scene state: system " +
      "identifier, atom count N, frame count T, the category/group structure for " +
      "building targets, the committed selections, and the registered mods. Call " +
      "this before anything else; never guess names or counts.",
    {},
    async () => {
      const c = await deps.getContext();
      const modLines = c.mods.length
        ? c.mods.map((m) => `  - ${m.name} (${m.produces}${m.axis ? ` → ${m.axis}` : ""})${m.description ? `: ${m.description}` : ""}`).join("\n")
        : "  (none yet)";
      return ok(
        `System: ${c.system}\nAtoms (N): ${c.nAtoms}\nFrames (T): ${c.nFrames}\n` +
        `Categories: ${c.categories.join(", ") || "(none)"}\n` +
        `Groups (${c.groups.length}): ${c.groups.slice(0, 24).join(", ")}${c.groups.length > 24 ? ", …" : ""}\n` +
        `Subgroups: ${c.subgroupCount}\n` +
        `Example targets: ${c.targetExamples.join(", ") || "@all"}\n` +
        `Committed selections:\n${c.committedSelections}\n` +
        `Registered mods:\n${modLines}`,
      );
    },
  );

  const writeMod = tool(
    "write_mod",
    "Write (or overwrite) an analysis mod as a .molaro/mods/<name>.py file. The " +
      "FULL Python source is shown to the human for approval before it is saved. " +
      "`produces` is one of per-point-scalar (declare axis: color|size|opacity), " +
      "per-frame-series, or scatter. Author it to the mod contract in the system " +
      "prompt. This does not run it — call run_mod after it is saved.",
    {
      name: z.string().describe("mod name: lowercase, [a-z][a-z0-9_-]*"),
      produces: z.enum(["per-point-scalar", "per-frame-series", "scatter"]),
      axis: z.enum(["color", "size", "opacity"]).optional()
        .describe("required when produces is per-point-scalar"),
      description: z.string().describe("one line: what the mod computes"),
      code: z.string().describe("the complete Python source defining compute(data, target_indices)"),
    },
    async (args) => {
      try {
        const saved = await deps.writeMod(args as WriteModSpec);
        return ok(`wrote mod "${saved.name}" to ${saved.file} — it is now registered; run it with run_mod.`);
      } catch (e) {
        return err(`write_mod failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const runMod = tool(
    "run_mod",
    "Run a registered mod on a target, binding its typed result to the viewer " +
      "(a per-frame-series draws a plot curve; a per-point-scalar colors/sizes " +
      "the structure; a scatter draws points). The target is a grammar address " +
      "like @all, a category (alpha), or alpha.group-0. On failure you get the " +
      "Python traceback back — read it and fix the mod. Gated for approval.",
    {
      name: z.string().describe("the mod's name"),
      target: z.string().describe("grammar target, e.g. @all, alpha, alpha.group-0"),
    },
    async (args) => {
      const r = await deps.runMod(String(args.name), String(args.target));
      return r.ok ? ok(r.message) : err(r.message);
    },
  );

  const runCommand = tool(
    "run_command",
    "Run one grammar command for scene manipulation the user asked for directly " +
      "(selections, hiding/showing, constant coloring) — e.g. `create_sele alpha`, " +
      "`hide solvent`, `ls`. Every scene verb is undoable. Cannot run `rm` or an " +
      "analysis mod (use run_mod for those). Do not use it to fake an analysis.",
    { command: z.string().describe("the full grammar command string") },
    async (args) => {
      const text = String(args.command);
      const blocked = blockedCommandReason(text, deps.analysisModNames());
      if (blocked) return err(blocked);
      const r = await deps.runCommand(text);
      return r.ok ? ok(r.message) : err(r.message);
    },
  );

  return { get_context: getContext, write_mod: writeMod, run_mod: runMod, run_command: runCommand };
}

/** Build the in-process MCP server holding our four tools. The gated tools
 * (write_mod/run_mod) do their work here; approval is enforced separately by
 * the SDK's canUseTool handler (they are absent from allowedTools). */
export function createToolServer(deps: ToolDeps) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: Object.values(buildToolDefs(deps)),
  });
}

/** The agent Options with the hard lockdown baked in. The API key reaches the
 * SDK subprocess through `env.ANTHROPIC_API_KEY` (never logged, never in the
 * webview). Only the four MCP tools are allowed; built-ins are disallowed;
 * settingSources is [] so no external config can widen the surface. */
export function buildAgentOptions(params: {
  model: string;
  apiKey: string;
  toolServer: ReturnType<typeof createToolServer>;
  systemPrompt: string;
  abortController: AbortController;
}): Options {
  return {
    model: params.model,
    systemPrompt: params.systemPrompt,
    // ONLY our four tools are pre-approved; the two gated ones are intentionally
    // ABSENT so canUseTool fires for them (mapped to the panel's approval gate).
    allowedTools: [qualified("get_context"), qualified("run_command")],
    // Strip every built-in from the model's context entirely.
    disallowedTools: SDK_BUILTIN_TOOLS,
    // Do NOT load the user's ~/.claude or project .claude settings — this is a
    // gated product surface, not a general coding agent.
    settingSources: [],
    mcpServers: { [MCP_SERVER_NAME]: params.toolServer },
    includePartialMessages: true, // stream assistant text as deltas
    env: { ...process.env, ANTHROPIC_API_KEY: params.apiKey },
    abortController: params.abortController,
    maxTurns: 40,
  };
}

/** The set of tool names the model can actually invoke, for the lockdown
 * assertion: the four MCP tools and nothing else. */
export function configuredToolSurface(opts: Options): {
  allowed: string[];
  disallowed: string[];
  settingSources: unknown;
  mcpTools: string[];
} {
  return {
    allowed: opts.allowedTools ?? [],
    disallowed: opts.disallowedTools ?? [],
    settingSources: opts.settingSources,
    mcpTools: TOOL_NAMES.map(qualified),
  };
}
