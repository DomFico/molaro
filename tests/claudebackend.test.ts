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
  blockedCommandReason, TOOL_NAMES, GATED_TOOLS, SDK_BUILTIN_TOOLS, qualified,
  type ToolDeps, type SceneContext,
} from "../src/claudetools.ts";
import { mapSdkMessage, approvalPreview, argsPreview } from "../src/claudebackend.ts";
import { buildSystemPrompt } from "../src/claudeprompt.ts";
import { parseClaudeEvent, type ClaudeEvent } from "../webview/claudemodel.ts";

function sampleContext(): SceneContext {
  return {
    system: "adk", nAtoms: 3341, nFrames: 98,
    categories: ["polymer"], groups: ["A"], subgroupCount: 214,
    targetExamples: ["@all", "polymer"], committedSelections: "(none)",
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

// ---- the lockdown (the single most important test) -------------------------
test("tool-surface lockdown: ONLY our four MCP tools, no built-ins, no external settings", () => {
  const opts = buildAgentOptions({
    model: "claude-sonnet-5", apiKey: "sk-test",
    toolServer: createToolServer(mockDeps()), systemPrompt: "x",
    abortController: new AbortController(),
  });
  const surf = configuredToolSurface(opts);

  // exactly the four MCP tools exist; the two ungated are auto-allowed
  assert.deepEqual([...TOOL_NAMES].sort(), ["get_context", "run_command", "run_mod", "write_mod"].sort());
  assert.deepEqual(
    new Set(surf.allowed),
    new Set([qualified("get_context"), qualified("run_command")]),
  );
  // NOTHING outside our MCP namespace is allowed
  for (const t of surf.allowed) assert.ok(surf.mcpTools.includes(t), `allowed "${t}" is one of ours`);
  // every SDK built-in is explicitly disallowed — Bash/Edit/Read/Write/WebSearch and the rest
  for (const b of ["Bash", "Edit", "Read", "Write", "WebSearch", "Grep", "Glob", "Task", "NotebookEdit"]) {
    assert.ok(surf.disallowed.includes(b), `built-in "${b}" is disallowed`);
    assert.ok(!surf.allowed.includes(b), `built-in "${b}" is NOT allowed`);
  }
  assert.deepEqual([...SDK_BUILTIN_TOOLS].sort(), [...(opts.disallowedTools ?? [])].sort());
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

// ---- system prompt ---------------------------------------------------------
test("system prompt injects live context AND keeps every correctness rule", () => {
  const p = buildSystemPrompt(sampleContext());
  assert.match(p, /float64/);                    // rule 1: float64 reduction
  assert.match(p, /nanometers/);                 // rule 2: units
  assert.match(p, /RMSD is selection-driven/);   // rule 3: superposition set
  assert.match(p, /Say what you computed/);      // rule 4: state the convention
  assert.match(p, /AUTHORING MODS/);             // the working model
  assert.match(p, /adk/);                        // injected identifier
  assert.match(p, /3341/);                       // injected N
});

test("system prompt without context still instructs get_context first", () => {
  assert.match(buildSystemPrompt(null), /Call get_context/);
});
