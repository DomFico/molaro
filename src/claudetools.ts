/**
 * The assistant's tool surface — FIVE in-process MCP tools, and the hard
 * lockdown around them. PURE-ish (the SDK `tool()`/`createSdkMcpServer()`
 * factories + injected host callbacks); no vscode, no live query — unit-tested
 * under `node --test`.
 *
 * The invariant is NOT "exactly four/five tools"; it is **destructive
 * operations are never ungated**. `run_command` and macro execution refuse `rm`
 * because those paths are ungated — nothing the user approves. `delete_mod` is a
 * GATED tool: it surfaces an approve/deny block naming the exact mod and file,
 * and nothing happens without a click — so it is allowed to delete where the
 * ungated paths are not.
 *
 * The security fence lives here, asserted by test:
 *  - `buildAgentOptions` restricts `allowedTools` to EXACTLY our (ungated) MCP
 *    tools, lists the SDK's built-ins in `disallowedTools`, and sets
 *    `settingSources` to [] so no user/project `.claude/` config (tools,
 *    permissions, MCP servers) is loaded. If the model could reach
 *    Bash/Edit/Read, every gate in this system would be a fiction.
 *  - `run_command` refuses `rm` (and any analysis-mod invocation) at the tool
 *    boundary — a returned error the model can see, not a prompt it can talk
 *    around. All destructive or Python-executing actions route through the
 *    GATED tools only.
 */
import { tool, createSdkMcpServer, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MOD_AXES, MOD_PRODUCES, type ModAxis, type ModProduces } from "../webview/recipes.ts";

export const MCP_SERVER_NAME = "molaro";

/** The bare tool names our MCP server exposes. */
export const TOOL_NAMES = ["get_context", "write_mod", "run_mod", "run_command", "delete_mod"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Gated tools require human approval (they write/delete files or execute
 * Python). The ungated two are auto-allowed: `get_context` is read-only,
 * `run_command` runs only undoable scene verbs (with the deny-list below).
 * `delete_mod` is gated precisely BECAUSE it is destructive — the approve/deny
 * block is what makes file deletion permissible from the assistant at all. */
export const GATED_TOOLS: ToolName[] = ["write_mod", "run_mod", "delete_mod"];

/** The MCP-qualified name the SDK matches against `allowedTools`. */
export const qualified = (name: ToolName): string => `mcp__${MCP_SERVER_NAME}__${name}`;

/** The permission-boundary ALLOW-LIST, keyed on the EXACT MCP-qualified name.
 * canUseTool fires for any tool not auto-approved; this decides what happens:
 *  - `auto`  : our two ungated tools (they are in allowedTools, so they never
 *              actually reach canUseTool — listed for completeness/tests);
 *  - `gated` : our two gated tools → human approval;
 *  - `deny`  : EVERYTHING else, by default.
 * This is the second layer under disallowedTools: even a tool that bypassed the
 * deny-list or the init tool surface entirely (a leaked SDK tool, or a native
 * capability like AskUserQuestion emitted as a tool_use) is refused here unless
 * it is EXACTLY one of our four. An allow-list, not a deny-list. */
export function toolPolicy(toolName: string): "auto" | "gated" | "deny" {
  if (toolName === qualified("get_context") || toolName === qualified("run_command")) return "auto";
  if (GATED_TOOLS.some((t) => toolName === qualified(t))) return "gated";
  return "deny";
}

/** The EXPECTED runtime tool surface — exactly our four MCP tools and nothing
 * else. This is the allow-list the surface test asserts EQUALITY against; any
 * tool the SDK actually exposes beyond this set is a leak and fails the test.
 * `allowedTools` only auto-APPROVES; it does not remove — so the guarantee is
 * enforced by (a) disallowing every non-molaro tool below, (b) strictMcpConfig
 * dropping ambient MCP servers, and (c) the runtime-equality test as the guard
 * that catches anything the deny-list missed or a future SDK adds. */
export const EXPECTED_TOOL_SURFACE: string[] = TOOL_NAMES.map(qualified);

/** Every non-molaro tool the SDK can surface, named for `disallowedTools` so it
 * is stripped from the model's context entirely. This is deliberately broad —
 * the SDK's own file/shell built-ins (Bash/Edit/Read/…) AND the managed-agent
 * orchestration tools it also ships (Task/Cron/Workflow/Skill/ToolSearch/…),
 * the latter discovered only by enumerating the REAL runtime surface, not by
 * recollection. A by-name deny-list is inherently incomplete, which is exactly
 * why it is the BELT and the runtime-equality surface test is the guarantee:
 * disallow suppresses today's known tools (ToolSearch included), the test fails
 * the moment any unnamed tool appears. */
export const DISALLOWED_TOOLS = [
  // the SDK's file/shell/search built-ins
  "Bash", "Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "NotebookRead",
  "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "KillShell",
  "BashOutput", "ExitPlanMode", "SlashCommand", "Task", "Agent",
  // the managed-agent orchestration tools the SDK also ships
  "Artifact", "CronCreate", "CronDelete", "CronList", "DesignSync",
  "EnterWorktree", "ExitWorktree", "Monitor", "PushNotification", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "ToolSearch", "Workflow",
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
  /** The distinct subgroup-label kinds present (a residue's name is its
   * subgroup label's first token: "ASP 33" → "ASP"), CAPPED — the residue
   * vocabulary the model globs as `<group>.<kind>*`, not guesses. */
  subgroupKinds: string[];
  subgroupKindsCapped: boolean;
  /** The distinct POINT types present (on a molecular system, the atom's
   * element symbol: C, N, O, …), CAPPED — the vocabulary the model addresses
   * with the grammar's 4th segment as `*.*.*.<type>` (e.g. all carbons),
   * instead of a per-index list. Same shape/guard as subgroupKinds. */
  pointTypes: string[];
  pointTypesCapped: boolean;
  /** e.g. "alpha.group-0" — a few real, constructible target examples. */
  targetExamples: string[];
  committedSelections: string;
  mods: { name: string; produces: ModProduces; axis?: ModAxis; description?: string }[];
  /** The viewer's base look for any element not written by a command — the real
   * defaults from representation.ts, so the model states the true baseline
   * instead of guessing (and knows undo restores it). */
  baseLook: { pointSize: number; opacity: number; color: string };
}

/** Example targets get_context advertises to the model. The whole-system token
 * is the BARE `all` keyword (NOT `@all`, which is the union of committed
 * selections); category names are valid top-level grammar targets. Callers pass
 * ONLY present (non-empty) categories, so every example resolves non-empty —
 * enforced against the real resolver by tests/get_context.test.ts. */
export function buildTargetExamples(presentCategories: string[]): string[] {
  return ["all", ...presentCategories.slice(0, 3)];
}

export interface WriteModSpec {
  name: string;
  produces: ModProduces;
  axis?: ModAxis;
  description: string;
  code: string;
}

/** The host callbacks the tools drive — every one an EXISTING path (the
 * command relay, saveWorkspaceMod, the header/mod mirrors). The tools own no
 * state and touch no neutral-tier file directly. */
export interface ToolDeps {
  getContext(): Promise<SceneContext>;
  writeMod(spec: WriteModSpec): Promise<{ name: string; file: string }>;
  /** Delete a WORKSPACE mod file and reconcile the registry. Refuses (ok:false)
   * anything not a scanned `.molaro/mods/*.py` mod — built-ins, unknown names,
   * traversal — by construction (it deletes only paths the mod scan recorded,
   * never a path derived from `name`). Reached only after the approval gate. */
  deleteMod(name: string): Promise<{ ok: boolean; message: string }>;
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
      const kinds = c.subgroupKinds.length
        ? `Subgroup kinds (residue names — target as <group>.<kind>*, e.g. ${c.groups[0] ?? "A"}.${c.subgroupKinds[0]}*): ` +
          `${c.subgroupKinds.join(", ")}${c.subgroupKindsCapped ? ", … (capped)" : ""}\n`
        : "";
      const types = c.pointTypes.length
        ? `Point types (atom elements — target a whole class across the system as *.*.*.<type>, ` +
          `e.g. *.*.*.${c.pointTypes[0]}): ${c.pointTypes.join(", ")}${c.pointTypesCapped ? ", … (capped)" : ""}\n`
        : "";
      const base = `Base look (defaults for any element not written by a command; undo restores these): ` +
        `point size ${c.baseLook.pointSize}, opacity ${c.baseLook.opacity}, color ${c.baseLook.color}\n`;
      return ok(
        `System: ${c.system}\nAtoms (N): ${c.nAtoms}\nFrames (T): ${c.nFrames}\n` +
        `Categories: ${c.categories.join(", ") || "(none)"}\n` +
        `Groups (${c.groups.length}): ${c.groups.slice(0, 24).join(", ")}${c.groups.length > 24 ? ", …" : ""}\n` +
        `Subgroups: ${c.subgroupCount}\n` + kinds + types + base +
        `Example targets: ${c.targetExamples.join(", ") || "all"}\n` +
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
      "per-frame-series, scatter, or commands (a macro returning list[str] — no " +
      "axis). Author it to the mod contract in the system prompt. This does not " +
      "run it — call run_mod after it is saved.",
    {
      name: z.string().describe("mod name: lowercase, [a-z][a-z0-9_-]*"),
      // DERIVED from the mod system's single source (recipes.MOD_PRODUCES /
      // MOD_AXES) so this schema can never drift from what the parser accepts —
      // the whole point of Brief #10a. Asserted in tests/recipes.test.ts.
      produces: z.enum(MOD_PRODUCES),
      axis: z.enum(MOD_AXES).optional()
        .describe("required when produces is per-point-scalar; omit for the others"),
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

  const deleteMod = tool(
    "delete_mod",
    "Delete a workspace mod file (.molaro/mods/<name>.py) and unregister it. " +
      "GATED: the human sees the mod name and file path and must approve before " +
      "anything is deleted. Only workspace mods can be deleted — built-ins are " +
      "refused, and nothing outside .molaro/mods is ever touched. Use it to clean " +
      "up YOUR OWN scratch/debug mods; do not delete the user's mods unless asked.",
    { name: z.string().describe("the workspace mod's name (as shown in get_context)") },
    async (args) => {
      const r = await deps.deleteMod(String(args.name));
      return r.ok ? ok(r.message) : err(r.message);
    },
  );

  return { get_context: getContext, write_mod: writeMod, run_mod: runMod, run_command: runCommand, delete_mod: deleteMod };
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
    // NOTE: allowedTools only auto-APPROVES — it does not restrict the surface;
    // that is what disallowedTools + strictMcpConfig (below) are for.
    allowedTools: [qualified("get_context"), qualified("run_command")],
    // Strip every non-molaro tool from the model's context entirely (belt).
    disallowedTools: DISALLOWED_TOOLS,
    // Restrict MCP to EXACTLY the servers we pass — drop any ambient MCP server
    // the environment would otherwise inject (e.g. the user's claude.ai
    // connectors: Gmail, Drive, Calendar). Without this, `settingSources: []`
    // alone does NOT stop MCP discovery.
    strictMcpConfig: true,
    // Do NOT load the user's ~/.claude or project .claude settings — this is a
    // gated product surface, not a general coding agent.
    settingSources: [],
    // We intentionally set NO onUserDialog / dialogKinds and NO onElicitation.
    // The SDK FAILS CLOSED on user dialogs — "omitting the option entirely means
    // no dialogs are emitted" — so AskUserQuestion (a native `request_user_dialog`
    // capability, NOT a tool and NOT in the init tool surface) degrades to its
    // no-dialog behavior. Belt to the canUseTool allow-list's suspenders.
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
