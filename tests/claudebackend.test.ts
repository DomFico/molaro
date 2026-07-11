/**
 * The assistant backend's SECURITY FENCE and contract conformance, asserted
 * without a live model: the tool surface is exactly our four MCP tools (no
 * Bash/Edit/Read/WebSearch), no external settings are loaded, run_command
 * refuses `rm` and analysis mods at the boundary, write_mod's approval preview
 * is the full Python, a failed run_mod returns its traceback verbatim, and every
 * event the message mapper emits parses through the frozen contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentOptions, buildToolDefs, configuredToolSurface, createToolServer,
  blockedCommandReason, toolPolicy, TOOL_NAMES, GATED_TOOLS, DISALLOWED_TOOLS, EXPECTED_TOOL_SURFACE, qualified,
  type ToolDeps, type SceneContext,
} from "../src/claudetools.ts";
import { mapSdkMessage, approvalPreview, argsPreview, isRuntimeUnavailable, errorMessage, RUNTIME_UNAVAILABLE_HINT } from "../src/claudebackend.ts";
import { MOD_AXES, MOD_PRODUCES } from "../webview/recipes.ts";
import { buildSystemPrompt } from "../src/claudeprompt.ts";
import { parseClaudeEvent, type ClaudeEvent } from "../webview/claudemodel.ts";

function sampleContext(): SceneContext {
  return {
    system: "adk", nAtoms: 3341, nFrames: 98,
    categories: ["polymer"], groups: ["A"], subgroupCount: 214,
    subgroupKinds: ["ALA", "ARG", "ASP", "GLU", "LYS"], subgroupKindsCapped: false,
    targetExamples: ["all", "polymer"], committedSelections: "(none)",
    mods: [{ name: "myrmsf", produces: "per-point-scalar", axis: "color" }],
  };
}

interface Calls { runCommand: string[]; runMod: [string, string][]; writeMod: unknown[] }
function mockDeps(over: Partial<ToolDeps> = {}): ToolDeps & { calls: Calls } {
  const calls: Calls = { runCommand: [], runMod: [], writeMod: [] };
  return {
    getContext: async () => sampleContext(),
    writeMod: async (s) => { calls.writeMod.push(s); return { name: s.name, file: `/ws/.molaro/mods/${s.name}.py` }; },
    runMod: async (n, t) => { calls.runMod.push([n, t]); return { ok: true, message: `ran ${n} on ${t}` }; },
    runCommand: async (t) => { calls.runCommand.push(t); return { ok: true, message: `ran ${t}` }; },
    analysisModNames: () => ["myrmsf"],
    ...over,
    calls,
  } as ToolDeps & { calls: Calls };
}

const text = (res: unknown): string => {
  const c = (res as { content?: { text?: unknown }[] }).content;
  return String(c?.[0]?.text ?? "");
};

// ---- the lockdown config (the BELT; the guarantee is tests/tool_surface.test.ts) ----
// The real allow-list guarantee is the runtime-equality test, which reads the
// SDK's ACTUAL surface. These assert the config that produces it — and that the
// deny-list mistake (asserting only names we remembered) is not repeated: no
// built-in is auto-allowed, ToolSearch is disallowed, MCP is strict.
test("lockdown config: only our two ungated tools auto-approved; built-ins + ToolSearch disallowed; MCP strict; no external settings", () => {
  const opts = buildAgentOptions({
    model: "claude-sonnet-5", apiKey: "sk-test",
    toolServer: createToolServer(mockDeps()), systemPrompt: "x",
    abortController: new AbortController(),
  });
  const surf = configuredToolSurface(opts);

  // the four MCP tools exist; the two ungated are auto-allowed, the two gated absent
  assert.deepEqual([...TOOL_NAMES].sort(), ["get_context", "run_command", "run_mod", "write_mod"].sort());
  assert.deepEqual(
    new Set(surf.allowed),
    new Set([qualified("get_context"), qualified("run_command")]),
  );
  assert.deepEqual([...EXPECTED_TOOL_SURFACE].sort(), TOOL_NAMES.map(qualified).sort());
  // NOTHING outside our MCP namespace is auto-allowed
  for (const t of surf.allowed) assert.ok(surf.mcpTools.includes(t), `allowed "${t}" is one of ours`);
  // built-ins + ToolSearch are disallowed and never auto-allowed
  for (const b of ["Bash", "Edit", "Read", "Write", "WebSearch", "Grep", "Task", "ToolSearch"]) {
    assert.ok(surf.disallowed.includes(b), `"${b}" is disallowed`);
    assert.ok(!surf.allowed.includes(b), `"${b}" is NOT allowed`);
  }
  assert.deepEqual([...DISALLOWED_TOOLS].sort(), [...(opts.disallowedTools ?? [])].sort());
  // MCP restricted to exactly the servers we pass (drops ambient connectors)
  assert.equal((opts as { strictMcpConfig?: boolean }).strictMcpConfig, true);
  // no user/project .claude settings pulled in
  assert.deepEqual(surf.settingSources, []);
  // the key reaches the SDK only through the subprocess env
  assert.equal((opts.env as Record<string, string>).ANTHROPIC_API_KEY, "sk-test");
});

test("the gated tools are write_mod and run_mod (absent from allowedTools so canUseTool fires)", () => {
  assert.deepEqual([...GATED_TOOLS].sort(), ["run_mod", "write_mod"].sort());
  const opts = buildAgentOptions({
    model: "m", apiKey: "k", toolServer: createToolServer(mockDeps()),
    systemPrompt: "x", abortController: new AbortController(),
  });
  assert.ok(!(opts.allowedTools ?? []).includes(qualified("write_mod")));
  assert.ok(!(opts.allowedTools ?? []).includes(qualified("run_mod")));
});

// ---- the permission-boundary allow-list (Part A: AskUserQuestion et al.) ----
test("toolPolicy is an ALLOW-LIST: only our four MCP tools; everything else DENIED", () => {
  assert.equal(toolPolicy(qualified("get_context")), "auto");
  assert.equal(toolPolicy(qualified("run_command")), "auto");
  assert.equal(toolPolicy(qualified("write_mod")), "gated");
  assert.equal(toolPolicy(qualified("run_mod")), "gated");
  // AskUserQuestion — a native user-dialog capability outside the init tool
  // surface — and every other leaked/ambient tool is DENIED at canUseTool, even
  // though it never appears in init.tools for the equality test to catch.
  for (const t of ["AskUserQuestion", "Bash", "Edit", "Read", "WebSearch", "Task", "ToolSearch", "Skill",
                   "get_context", "write_mod", "mcp__other__x", "mcp__molaro__delete"]) {
    assert.equal(toolPolicy(t), "deny", `${t} must be denied at the permission boundary`);
  }
});

test("no dialog/elicitation opt-in — the SDK fails closed on user dialogs", () => {
  const opts = buildAgentOptions({
    model: "m", apiKey: "k", toolServer: createToolServer(mockDeps()),
    systemPrompt: "x", abortController: new AbortController(),
  }) as Record<string, unknown>;
  // AskUserQuestion rides `request_user_dialog`; omitting these entirely means no
  // dialogs are ever emitted to the session.
  assert.equal(opts.onUserDialog, undefined);
  assert.equal(opts.dialogKinds, undefined);
  assert.equal(opts.onElicitation, undefined);
});

// ---- the rm deny-list ------------------------------------------------------
test("blockedCommandReason: rm and analysis-mod invocations are refused; scene verbs pass", () => {
  assert.match(blockedCommandReason("rm rg", [])!, /cannot run `rm`/);
  assert.match(blockedCommandReason("  RM  all ", [])!, /cannot run `rm`/); // case/space-insensitive
  assert.equal(blockedCommandReason("hide solvent", []), null);
  assert.equal(blockedCommandReason("create_sele alpha", ["myrmsf"]), null);
  assert.equal(blockedCommandReason("rainbow alpha", ["myrmsf"]), null); // rainbow is a built-in rep, not analysis
  assert.match(blockedCommandReason("myrmsf all", ["myrmsf"])!, /analysis mod.*run_mod/s);
});

test("run_command tool: `rm` is rejected at the boundary and NEVER reaches the viewer", async () => {
  const deps = mockDeps();
  const defs = buildToolDefs(deps);
  const res = await defs.run_command.handler({ command: "rm rg" }, {});
  assert.equal(res.isError, true);
  assert.match(text(res), /cannot run `rm`/);
  assert.equal(deps.calls.runCommand.length, 0, "rm was never forwarded to the viewer");
});

test("run_command tool: a scene verb passes through to the viewer", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).run_command.handler({ command: "hide solvent" }, {});
  assert.equal(res.isError, false);
  assert.deepEqual(deps.calls.runCommand, ["hide solvent"]);
});

// ---- the approval preview (full python) ------------------------------------
test("write_mod approval preview is the COMPLETE Python source", () => {
  const code = "import numpy as np\n\ndef compute(data, target_indices):\n    return [0.0] * data.trajectory.n_frames";
  const prev = approvalPreview("write_mod", { name: "rg", produces: "per-frame-series", code });
  assert.ok(prev.includes(code), "the full source is the preview");
  assert.ok(prev.includes("rg") && prev.includes("per-frame-series"));
});

test("argsPreview never leaks the code body into the tool-proposed line", () => {
  const p = argsPreview({ name: "rg", produces: "per-frame-series", code: "def compute(): ..." });
  assert.match(p, /code: <python>/);
  assert.ok(!p.includes("def compute"));
});

// ---- self-correction (traceback passthrough) -------------------------------
test("run_mod returns the failure TRACEBACK verbatim, not a generic message", async () => {
  const tb = 'Traceback (most recent call last):\n  File "<mod>", line 3\nValueError: could not broadcast';
  const deps = mockDeps({ runMod: async () => ({ ok: false, message: `rmsf failed: ${tb}` }) });
  const res = await buildToolDefs(deps).run_mod.handler({ name: "rmsf", target: "@all" }, {});
  assert.equal(res.isError, true);
  assert.ok(text(res).includes("Traceback"), "traceback header present");
  assert.ok(text(res).includes("ValueError: could not broadcast"), "the specific error line is present");
});

test("write_mod saves through the host path and reports registration", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).write_mod.handler(
    { name: "rg", produces: "per-frame-series", axis: undefined, description: "radius of gyration", code: "def compute(d,t): return []" }, {},
  );
  assert.equal(res.isError, false);
  assert.equal(deps.calls.writeMod.length, 1);
  assert.match(text(res), /wrote mod "rg"/);
});

// ---- Brief #10a: write_mod's schema MUST equal the mod system's produces ----
// The point of this test: if a new produces (or axis) value is added to one side
// and not the other, this fails. write_mod's z.enum is DERIVED from MOD_PRODUCES,
// so these are the same array object — but assert it so a future hardcode regresses loudly.
test("write_mod's produces/axis enums equal the mod system's supported values", () => {
  const schema = buildToolDefs(mockDeps()).write_mod.inputSchema as Record<string, any>;
  assert.deepEqual([...schema.produces.options].sort(), [...MOD_PRODUCES].sort(),
    "write_mod.produces must offer exactly what the mod parser/validator accept");
  assert.deepEqual([...schema.axis.unwrap().options].sort(), [...MOD_AXES].sort(),
    "write_mod.axis must offer exactly the per-point-scalar axes");
});

test("write_mod schema accepts every real produces (incl. commands) and rejects invented ones", () => {
  const schema = buildToolDefs(mockDeps()).write_mod.inputSchema as Record<string, any>;
  for (const p of MOD_PRODUCES) {
    assert.ok(schema.produces.safeParse(p).success, `produces: ${p} must parse`);
  }
  assert.ok(schema.produces.safeParse("commands").success, "commands is a first-class produces here");
  assert.ok(!schema.produces.safeParse("histogram").success, "an unsupported produces is rejected at the schema");
  // axis is optional — a commands mod legitimately omits it
  assert.ok(schema.axis.safeParse(undefined).success, "axis may be omitted (commands/series/scatter)");
  assert.ok(schema.axis.safeParse("color").success);
  assert.ok(!schema.axis.safeParse("width").success, "an unsupported axis is rejected");
});

test("write_mod accepts a commands mod through the save path (no axis required)", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).write_mod.handler(
    { name: "ab_look", produces: "commands", axis: undefined, description: "the a/b look", code: 'def compute(d,t): return ["colorbonds alpha red"]' }, {},
  );
  assert.equal(res.isError, false, text(res));
  assert.equal(deps.calls.writeMod.length, 1);
  const saved = deps.calls.writeMod[0] as { produces: string; axis?: string };
  assert.equal(saved.produces, "commands");
  assert.equal(saved.axis, undefined);
});

test("get_context reports the LIVE system shape (nothing hardcoded)", async () => {
  const res = await buildToolDefs(mockDeps()).get_context.handler({}, {});
  assert.match(text(res), /System: adk/);
  assert.match(text(res), /Atoms \(N\): 3341/);
  assert.match(text(res), /Frames \(T\): 98/);
  assert.match(text(res), /myrmsf/);
});

// ---- contract conformance of the message mapper ----------------------------
test("mapSdkMessage → only contract-valid events, correctly typed", () => {
  const streamEv = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } };
  const asst = { type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "mcp__molaro__run_mod", input: { name: "rg", target: "@all" } }] } };
  const usr = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: [{ type: "text", text: "ran rg" }] }] } };
  const okResult = { type: "result", subtype: "success", is_error: false, result: "done" };

  const groups: ClaudeEvent[][] = [
    mapSdkMessage(streamEv as never), mapSdkMessage(asst as never),
    mapSdkMessage(usr as never), mapSdkMessage(okResult as never),
  ];
  for (const evs of groups) for (const ev of evs) {
    assert.ok(parseClaudeEvent(ev as unknown) !== null, `emitted event parses: ${JSON.stringify(ev)}`);
  }
  assert.deepEqual(mapSdkMessage(streamEv as never), [{ type: "assistant-text", delta: "Hello" }]);
  const proposed = mapSdkMessage(asst as never)[0];
  assert.equal(proposed.type, "tool-proposed");
  assert.equal((proposed as { toolName: string }).toolName, "run_mod");
  const result = mapSdkMessage(usr as never)[0];
  assert.equal(result.type, "tool-result");
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal((result as { summary: string }).summary, "ran rg");
  assert.deepEqual(mapSdkMessage(okResult as never), [{ type: "turn-complete" }]);
});

test("an errored result maps to error THEN turn-complete (both contract-valid)", () => {
  const evs = mapSdkMessage({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" } as never);
  assert.equal(evs[0].type, "error");
  assert.equal(evs[1].type, "turn-complete");
  for (const ev of evs) assert.ok(parseClaudeEvent(ev as unknown) !== null);
});

test("a failed tool_result maps to a tool-result with ok:false", () => {
  const usr = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c9", is_error: true, content: "boom" }] } };
  const ev = mapSdkMessage(usr as never)[0];
  assert.equal(ev.type, "tool-result");
  assert.equal((ev as { ok: boolean }).ok, false);
});

// ---- runtime-unavailable error path (Part B) -------------------------------
test("a missing/wrong-platform native binary is detected as runtime-unavailable", () => {
  assert.equal(isRuntimeUnavailable(new Error("Native CLI binary for darwin-arm64 not found. Reinstall …")), true);
  assert.equal(isRuntimeUnavailable(new Error("Claude Code executable not found at …")), true);
  assert.equal(isRuntimeUnavailable(new Error("spawn ENOENT")), true);
  // ordinary errors are NOT runtime-unavailable
  assert.equal(isRuntimeUnavailable(new Error("401 authentication_error")), false);
  assert.equal(isRuntimeUnavailable(new Error("rate limit 429")), false);
});

test("runtime-unavailable maps to a clear, actionable message; auth/rate errors keep their own", () => {
  const m = errorMessage(new Error("Native CLI binary for win32-x64 not found."));
  assert.ok(m.includes("can't start on this platform"), m);
  assert.ok(m.includes(RUNTIME_UNAVAILABLE_HINT.slice(0, 30)), m);
  assert.ok(m.includes("viewer, terminal, mods) works normally"), m); // the rest still works
  assert.match(errorMessage(new Error("401 x-api-key invalid")), /authentication failed/);
  assert.match(errorMessage(new Error("429 rate_limit")), /rate limit/);
});

// ---- system prompt ---------------------------------------------------------
test("system prompt injects live context AND keeps every correctness rule", () => {
  const p = buildSystemPrompt(sampleContext());
  assert.match(p, /float64/);                    // rule 1: float64 reduction
  assert.match(p, /nanometers/);                 // rule 2: units
  assert.match(p, /RMSD is selection-driven/);   // rule 3: superposition set
  assert.match(p, /Say what you computed/);      // rule 4: state the convention
  assert.match(p, /adk/);                        // injected identifier
  assert.match(p, /3341/);                       // injected N
});

test("system prompt teaches the command grammar and the command-vs-mod choice (Part C)", () => {
  const p = buildSystemPrompt(sampleContext());
  // command-vs-mod guidance (corrected — run_command is primary, mods compute)
  assert.match(p, /Use `run_command` for anything the viewer can already express/);
  assert.match(p, /Write a mod only when you must COMPUTE something/);
  assert.match(p, /do not write a mod for it/);
  // the grammar reference: the level model + the bond verbs + residue targeting
  assert.match(p, /category → group → subgroup → point/);
  assert.match(p, /colorbonds/);                 // bond verbs exist
  assert.match(p, /incident/);                   // contained vs incident
  assert.match(p, /polymer\.A\.ASP\*,GLU\*/);    // residue-glob example
  assert.match(p, /parse error/);                // self-diagnosis
  // the injected residue vocabulary from get_context
  assert.match(p, /Subgroup kinds \(residues\)/);
  assert.match(p, /ASP/);
});

test("system prompt teaches produces: commands and the colormap fact (Brief 10)", () => {
  const p = buildSystemPrompt(sampleContext());
  // the macro mod: save a look/action as re-runnable commands
  assert.match(p, /produces: commands/);
  assert.match(p, /SAVE A LOOK OR AN ACTION/);
  assert.match(p, /list\[str\]/);
  // the colormap fact it guessed wrong in a live session
  assert.match(p, /one built-in hue ramp \(red→magenta\)/);
  assert.match(p, /CANNOT[\s\S]{0,30}colors with a scalar/i);
  // scalar-vs-commands boundary
  assert.match(p, /Scalar vs\. commands — different tools/);
  // the worked example's target is one the grammar resolves (prompt_examples guards it)
  assert.match(p, /colorbonds polymer\.A\.ASP\*,GLU\* red/);
});

test("system prompt without context still instructs get_context first", () => {
  assert.match(buildSystemPrompt(null), /Call get_context/);
});
