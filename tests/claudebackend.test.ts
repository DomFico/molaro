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
  buildAgentOptions, buildToolDefs, configuredToolSurface, createToolServer, describeRunModParams,
  blockedCommandReason, toolPolicy, TOOL_NAMES, GATED_TOOLS, DISALLOWED_TOOLS, EXPECTED_TOOL_SURFACE, qualified,
  type ToolDeps, type SceneContext,
} from "../src/claudetools.ts";
import type { ModParam } from "../webview/recipes.ts";
import { mapSdkMessage, approvalPreview, argsPreview, isRuntimeUnavailable, errorMessage, RUNTIME_UNAVAILABLE_HINT } from "../src/claudebackend.ts";
import { MOD_AXES, MOD_PRODUCES } from "../webview/recipes.ts";
import { commandMacroRefusal } from "../webview/commands.ts";
import { resolveModDeletion } from "../src/hostmessages.ts";
import { buildSystemPrompt, GRAMMAR_EXAMPLES } from "../src/claudeprompt.ts";
import { parseClaudeEvent, type ClaudeEvent } from "../webview/claudemodel.ts";

function sampleContext(): SceneContext {
  return {
    system: "adk", nAtoms: 3341, nFrames: 98,
    categories: ["polymer"], groups: ["A"], subgroupCount: 214,
    subgroupKinds: ["ALA", "ARG", "ASP", "GLU", "LYS"], subgroupKindsCapped: false,
    pointTypes: ["C", "N", "O", "S"], pointTypesCapped: false,
    provenance: ["periodic-image centering: off (no unit-cell information — not a periodic system)"],
    targetExamples: ["all", "polymer"], committedSelections: "(none)",
    liveState: { channels: "no channels", bindings: "no bindings", shapes: "(shapes)", styles: "styles:\n  standard (default)" },
    mods: [{ name: "myrmsf", produces: "per-point-scalar", axis: "color" }],
    baseLook: { pointSize: 3, opacity: 1, color: "#e6e6e6" },
  };
}

interface Calls { runCommand: string[]; runMod: [string, string][]; writeMod: unknown[]; unlinked: string[] }
function mockDeps(
  over: Partial<ToolDeps> = {},
  // a fake path-map with ONE workspace scratch mod — built-ins/traversal are
  // absent, exactly as on the host (modPaths holds only scanned mod files).
  modPaths: Map<string, string> = new Map([["scratch_cpk", "/ws/.molaro/mods/scratch_cpk.py"]]),
): ToolDeps & { calls: Calls } {
  const calls: Calls = { runCommand: [], runMod: [], writeMod: [], unlinked: [] };
  return {
    getContext: async () => sampleContext(),
    // faithful to the host saveAssistantMod: the disk write is not the answer —
    // `ok` is the VIEWER's registration confirmation, round-tripped back.
    writeMod: async (s) => {
      calls.writeMod.push(s);
      return { ok: true, name: s.name, file: `/ws/.molaro/mods/${s.name}.py`, message: `registered mod "${s.name}"` };
    },
    // faithful to the host deleteAssistantMod: resolve via the SAME path-map
    // discipline (resolveModDeletion), "unlink" only mapped paths, then report.
    deleteMod: async (name) => {
      const r = resolveModDeletion(modPaths, name);
      if ("refused" in r) return { ok: false, message: r.refused };
      calls.unlinked.push(r.file);
      modPaths.delete(name);
      return { ok: true, message: `deleted mod "${name}" (${r.file}) — unregistered.` };
    },
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

  // the FIVE MCP tools exist; the two ungated are auto-allowed, the three gated absent
  assert.deepEqual([...TOOL_NAMES].sort(), ["delete_mod", "get_context", "run_command", "run_mod", "write_mod"].sort());
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

test("the gated tools are write_mod, run_mod and delete_mod (absent from allowedTools so canUseTool fires)", () => {
  assert.deepEqual([...GATED_TOOLS].sort(), ["delete_mod", "run_mod", "write_mod"].sort());
  const opts = buildAgentOptions({
    model: "m", apiKey: "k", toolServer: createToolServer(mockDeps()),
    systemPrompt: "x", abortController: new AbortController(),
  });
  assert.ok(!(opts.allowedTools ?? []).includes(qualified("write_mod")));
  assert.ok(!(opts.allowedTools ?? []).includes(qualified("run_mod")));
  assert.ok(!(opts.allowedTools ?? []).includes(qualified("delete_mod")), "delete_mod is gated → not auto-approved");
  // delete_mod is a DESTRUCTIVE tool, so its policy MUST be gated (approval),
  // never auto — the invariant is 'destructive ops are never ungated'.
  assert.equal(toolPolicy(qualified("delete_mod")), "gated");
});

// ---- the permission-boundary allow-list (Part A: AskUserQuestion et al.) ----
test("toolPolicy is an ALLOW-LIST: only our five MCP tools; everything else DENIED", () => {
  assert.equal(toolPolicy(qualified("get_context")), "auto");
  assert.equal(toolPolicy(qualified("run_command")), "auto");
  assert.equal(toolPolicy(qualified("write_mod")), "gated");
  assert.equal(toolPolicy(qualified("run_mod")), "gated");
  assert.equal(toolPolicy(qualified("delete_mod")), "gated");
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

// -- P-1: the run_mod approval preview shows EFFECTIVE parameters (defaults filled) --

test("describeRunModParams: effective values including defaults; error surfaced; none → ''", () => {
  const schema: ModParam[] = [
    { name: "floor", type: "number", default: 0.5 },
    { name: "label", type: "string" },
  ];
  // an omitted parameter shows its DEFAULT — the human approves what runs, not the passed subset
  assert.equal(describeRunModParams(schema, { label: "x" }), " with floor=0.5, label=x");
  assert.equal(describeRunModParams(schema, { floor: 0.8, label: "y" }), " with floor=0.8, label=y");
  // an invalid set surfaces the reason (so the preview is honest, not silently empty)
  assert.match(describeRunModParams(schema, {}), /parameter error: missing required parameter "label"/);
  // a non-scalar native value is REFUSED in the preview exactly as execution refuses
  // it (both call resolveParameters) — no "preview says error, run succeeds" divergence
  assert.match(describeRunModParams(schema, { label: null }), /parameter error: parameter "label" expects a string/);
  assert.match(describeRunModParams(schema, { label: 'a"b' }), /parameter error: .*double-quote/);
  // a paramless mod contributes nothing
  assert.equal(describeRunModParams(undefined, { x: 1 }), "");
  assert.equal(describeRunModParams([], undefined), "");
});

test("run_mod approval preview appends the effective-parameters suffix", () => {
  const prev = approvalPreview("run_mod", { name: "gated", target: "all" }, " with floor=0.5, label=x");
  assert.match(prev, /run "gated" on target "all" with floor=0.5, label=x/);
  // no suffix → the bare preview, unchanged
  assert.equal(approvalPreview("run_mod", { name: "gated", target: "all" }),
    `run_mod → run "gated" on target "all"`);
});

test("P-2: write_mod approval preview names the declared channel; authoring threads it", async () => {
  // the preview states what the mod will declare (so the human approves it)
  const prev = approvalPreview("write_mod", { name: "flow", produces: "channel", channel: "flow_dir", requiresChannel: undefined, code: "def compute(d,t): return {}" });
  assert.match(prev, /produces: channel, declares channel: flow_dir/);
  // …and the channel name reaches saveAssistantMod (→ the # channel: header line)
  const deps = mockDeps();
  const res = await buildToolDefs(deps).write_mod.handler({
    name: "flow", produces: "channel", axis: undefined, channel: "flow_dir", requiresChannel: undefined,
    description: "a per-frame vector", code: "def compute(data, target_indices):\n    return {'values': [], 'components': 3}",
    params: undefined,
  }, {});
  assert.equal(res.isError, false);
  assert.equal((deps.calls.writeMod[0] as { channel?: unknown }).channel, "flow_dir");
});

test("write_mod can author a PARAMETERIZED mod — params thread through to the save spec", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).write_mod.handler({
    name: "gated", produces: "commands", axis: undefined, channel: undefined, requiresChannel: undefined, description: "a parameterized look",
    code: "def compute(data, target_indices, params):\n    return []",
    params: [{ name: "floor", type: "number", default: 0.5 }, { name: "label", type: "string", default: undefined }],
  }, {});
  assert.equal(res.isError, false);
  assert.equal(deps.calls.writeMod.length, 1);
  assert.deepEqual((deps.calls.writeMod[0] as { params?: unknown }).params,
    [{ name: "floor", type: "number", default: 0.5 }, { name: "label", type: "string", default: undefined }],
    "the declared parameters reach saveAssistantMod (→ # param: header lines)");
});

// ---- self-correction (traceback passthrough) -------------------------------
test("run_mod returns the failure TRACEBACK verbatim, not a generic message", async () => {
  const tb = 'Traceback (most recent call last):\n  File "<mod>", line 3\nValueError: could not broadcast';
  const deps = mockDeps({ runMod: async () => ({ ok: false, message: `rmsf failed: ${tb}` }) });
  const res = await buildToolDefs(deps).run_mod.handler({ name: "rmsf", target: "@all", parameters: undefined }, {});
  assert.equal(res.isError, true);
  assert.ok(text(res).includes("Traceback"), "traceback header present");
  assert.ok(text(res).includes("ValueError: could not broadcast"), "the specific error line is present");
});

test("write_mod saves through the host path and reports registration", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).write_mod.handler(
    { name: "rg", produces: "per-frame-series", axis: undefined, channel: undefined, requiresChannel: undefined, description: "radius of gyration", code: "def compute(d,t): return []", params: undefined }, {},
  );
  assert.equal(res.isError, false);
  assert.equal(deps.calls.writeMod.length, 1);
  assert.match(text(res), /wrote mod "rg"/);
});

// ---- §3.2: the ack must not claim what the tool did not verify --------------
// write_mod used to report "it is now registered" UNCONDITIONALLY, describing the
// host's disk write, while the viewer silently declined to register the mod — so
// the human approved version B and run_mod kept executing version A. The tool now
// reports the VIEWER's answer. An assistant told the write failed can recover; an
// assistant told it succeeded cannot.
test("write_mod does NOT report success when the viewer declined to register it", async () => {
  const deps = mockDeps({
    writeMod: async (s) => ({
      ok: false,
      name: s.name,
      file: `/ws/.molaro/mods/${s.name}.py`,
      message: `the viewer did NOT register "${s.name}" — "${s.name}" is a built-in command`,
    }),
  });
  const res = await buildToolDefs(deps).write_mod.handler(
    { name: "rainbow", produces: "commands", axis: undefined, channel: undefined, requiresChannel: undefined, description: "x", code: "def compute(d,t): return []", params: undefined }, {},
  );
  assert.equal(res.isError, true, "a declined registration is an ERROR the model can see, not a success");
  assert.doesNotMatch(text(res), /it is now registered/, "it must never claim the registration it was denied");
  assert.match(text(res), /built-in command/, "the REASON reaches the assistant's transcript, not just the terminal");
  assert.match(text(res), /will NOT run/, "and the consequence is stated plainly");
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
    { name: "ab_look", produces: "commands", axis: undefined, channel: undefined, requiresChannel: undefined, description: "the a/b look", code: 'def compute(d,t): return ["colorbonds alpha red"]', params: undefined }, {},
  );
  assert.equal(res.isError, false, text(res));
  assert.equal(deps.calls.writeMod.length, 1);
  const saved = deps.calls.writeMod[0] as { produces: string; axis?: string };
  assert.equal(saved.produces, "commands");
  assert.equal(saved.axis, undefined);
});

// ---- delete_mod: the fifth, GATED tool (Part B — the full bar) --------------
test("delete_mod approval preview names the mod and its file path (nothing deleted unseen)", () => {
  const prev = approvalPreview("delete_mod", { name: "scratch_cpk" });
  assert.match(prev, /delete_mod/);
  assert.match(prev, /scratch_cpk/);
  assert.match(prev, /\.molaro\/mods\/scratch_cpk\.py/);
  assert.match(prev, /permanently/i);
});

test("delete_mod deletes ONLY a scanned workspace mod, via the path-map (approve path)", async () => {
  const deps = mockDeps();
  const res = await buildToolDefs(deps).delete_mod.handler({ name: "scratch_cpk" }, {});
  assert.equal(res.isError, false, text(res));
  assert.deepEqual(deps.calls.unlinked, ["/ws/.molaro/mods/scratch_cpk.py"],
    "it unlinked exactly the mapped path — never one derived from the name");
  assert.match(text(res), /deleted mod "scratch_cpk".*unregistered/s);
});

test("delete_mod REFUSES a built-in — nothing is deleted", async () => {
  const deps = mockDeps(); // modPaths has no built-in (they are code, never scanned)
  const res = await buildToolDefs(deps).delete_mod.handler({ name: "rainbow" }, {});
  assert.equal(res.isError, true);
  assert.match(text(res), /not a workspace mod/);
  assert.equal(deps.calls.unlinked.length, 0, "no unlink happened");
});

test("delete_mod REFUSES a path-traversal / non-mod name — nothing outside .molaro/mods is touched", async () => {
  const deps = mockDeps();
  for (const bad of ["../../etc/passwd", "/etc/shadow", "scratch_cpk/../../x", "nope"]) {
    const res = await buildToolDefs(deps).delete_mod.handler({ name: bad }, {});
    assert.equal(res.isError, true, bad);
    assert.match(text(res), /not a workspace mod/, bad);
  }
  assert.equal(deps.calls.unlinked.length, 0, "not a single unlink for any refused name");
});

test("resolveModDeletion: the path-map discipline — only mapped names resolve, everything else refuses", () => {
  const modPaths = new Map([["scratch_cpk", "/ws/.molaro/mods/scratch_cpk.py"]]);
  assert.deepEqual(resolveModDeletion(modPaths, "scratch_cpk"), { file: "/ws/.molaro/mods/scratch_cpk.py" });
  for (const bad of ["rainbow", "../../etc/passwd", "scratch_cpk.py", "unknown"]) {
    const r = resolveModDeletion(modPaths, bad);
    assert.ok("refused" in r, `${bad} must refuse (absent from the scanned map)`);
  }
});

test("rm stays refused where it always was — run_command AND macro execution (must not regress)", () => {
  // run_command boundary (ungated path)
  assert.match(blockedCommandReason("rm all", ["myrmsf"])!, /cannot run `rm`/);
  assert.match(blockedCommandReason("rm scratch_cpk", [])!, /destructive/);
  // macro execution boundary (ungated path) — delete_mod being gated does NOT
  // relax these; they are the ungated paths and stay closed.
  assert.match(commandMacroRefusal("rm all", new Set())!, /rm.*not allowed/);
});

test("get_context reports the LIVE system shape (nothing hardcoded)", async () => {
  const res = await buildToolDefs(mockDeps()).get_context.handler({}, {});
  assert.match(text(res), /System: adk/);
  assert.match(text(res), /Atoms \(N\): 3341/);
  assert.match(text(res), /Frames \(T\): 98/);
  assert.match(text(res), /myrmsf/);
  // Part A — point types advertised with the *.*.*.<type> address form
  assert.match(text(res), /Point types.*C, N, O, S/);
  assert.match(text(res), /\*\.\*\.\*\.C/);
  // Part C — the real base look (not a guessed size of 1)
  assert.match(text(res), /Base look.*point size 3, opacity 1, color #e6e6e6/);
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
  // command-vs-mod guidance — the precedence LADDER (stop at the first that
  // fits): rung 1 keeps commands ahead of mods; rung 5 is the categorical fence
  assert.match(p, /stop at the first that fits/);
  assert.match(p, /Do not write a mod for something a command says directly/);
  assert.match(p, /A scalar mod cannot express/);
  assert.match(p, /it has one ramp and writes every point/);
  // the eight surfaces the pass made reachable: bake/bind, style/shape, and
  // the two new produces kinds (channel, figure) — guarded so they can't rot
  assert.match(p, /bake <target> <channel> <axis>/);
  assert.match(p, /bind <target> <channel> <axis>/);
  assert.match(p, /produces: channel/);
  assert.match(p, /produces: figure/);
  assert.match(p, /channel_flow\.py/);       // the template is still cited as a worked example
  // the return shapes are stated INLINE (the cartoon-test fix): Claude has no
  // tool to read the templates, so pointing at them for the mechanical shape
  // left it reconstructing from memory and getting the keys wrong. These
  // assertions trip if the shapes ever regress back to template-only.
  // P-2: the channel NAME is declared in the header (# channel:), NOT the return
  assert.match(p, /# channel: <name>/);           // the header declares the name
  assert.doesNotMatch(p, /"name": "<channel name>"/); // …and it is no longer in the return
  assert.match(p, /"values":/);
  assert.match(p, /ONE FLAT list, frame-major/);  // the flat-list layout named inline
  assert.match(p, /"components": 1/);
  assert.match(p, /"png": "<base64 PNG>"/);       // figure return dict, stated inline
  assert.match(p, /x_is_frames/);
  assert.match(p, /frame-to-frame coherence/);    // the coherence prose that DID land
  assert.match(p, /Seed each frame from the previous/);
  assert.match(p, /nothing bound to\s+`orientation` draws \*\*nothing\*\*/); // the shape dependency

  // -- the three attended prompt-pass changes (cold acceptance test findings) --
  // Each guards a SPECIFIC observed failure; see reports/ACCEPTANCE_COLD.md.
  // (1) the per-point BROADCAST trap — every cold R3 mod produced a per-residue
  // array for a per-point channel and was refused on length. The correction must
  // sit where the return is composed, and must SHOW the idiom, not restate the
  // formula (prompt_examples.test guards example TARGETS; this has none).
  assert.match(p, /a channel is PER-POINT/);
  assert.match(p, /BROADCAST it: every atom inherits its residue's value/);
  assert.match(p, /res_of_atom/);                 // the atom→residue index idiom
  assert.match(p, /per_res\[:, res_of_atom, :\]/); // the corrected shape, shown
  // (2) the vocabulary clause: "cartoon" → ribbon (one run approximated with a tube)
  assert.match(p, /\*\*cartoon\*\* \(or ribbon\) rendering of a\s+backbone is `shape traces ribbon`/);
  // (3) get_context is CONDITIONAL, not absolute — but the after-declaration case
  // is strengthened, because R2's whole success was reading live Channels first.
  assert.doesNotMatch(p, /Before anything, call/);            // the old absolute is gone
  assert.match(p, /before you write or bind a channel, or swap a shape/);
  assert.match(p, /again after anything is declared/);
  assert.match(p, /Never guess a channel, shape, or selection name/);
  // NEGATIVE guard (the stale-claim class): the prompt must not tell Claude it
  // CANNOT produce a visual kind it actually can. `produces: figure` renders
  // histograms/contact maps; a leftover "only the three result kinds"
  // prohibition would suppress it. This trips if a stale count/prohibition
  // returns — the "grep the prompt for what Claude can't do" checklist, codified.
  assert.doesNotMatch(p, /cannot produce histograms|only the three (result kinds|above)|one of the three result kinds/);
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

test("system prompt teaches data.labels, all-vs-@all, and the trajectory-None guard (Brief 11)", () => {
  const p = buildSystemPrompt(sampleContext());
  // C1 — address by data.labels, never a guessed chain label
  assert.match(p, /data\.labels\[i\]/);
  assert.match(p, /chr\(65 \+ chain\.index\)/, "it names the specific anti-pattern it forbids");
  assert.match(p, /\(category, group, subgroup\)/);
  // the worked example READS the group label from data.labels (an f-string target)
  assert.match(p, /data\.labels\[\(target_indices or \[0\]\)\[0\]\]/);
  // C2 — whole system is `all`, not `@all`
  assert.match(p, /use the bare keyword `all` — not `@all`/);
  // C3 — the trajectory can be None; guard it
  assert.match(p, /if data\.trajectory is None:/);
});

test("system prompt teaches durability: derive vocabulary at run time, respect target_indices (Brief 13)", () => {
  const p = buildSystemPrompt(sampleContext());
  // the durability rule — a mod outlives the system; don't freeze get_context's vocabulary
  assert.match(p, /A mod outlives the system it was written on/);
  assert.match(p, /never hardcode its vocabulary into a mod/i);
  assert.match(p, /derive that set at run time/i);
  // the WRONG/RIGHT worked contrast — derive present elements + handle the unexpected
  assert.match(p, /WRONG — freezes the elements/);
  assert.match(p, /a\.element\.symbol for a in data\.trajectory\.topology\.atoms if a\.element/);
  assert.match(p, /cpk\.get\(sym, 'pink'\)/, "the RIGHT example has a fallback for unanticipated elements");
  // the specific silent-failure it prevents (phosphorus in a nucleic system)
  assert.match(p, /phosphorus/i);
  // respect target_indices guidance
  assert.match(p, /Respect `target_indices`/);
});

// -- the 2026-07-23 attended prompt pass: offset axis, background, and the
// run-use correctness rules folded from reports/PROMPT_DELTA.md. Each guards a
// shipped surface with a documented failure so it can't rot back out.
test("system prompt teaches the offset axis and its smooth/delay mods (PROMPT_DELTA 2026-07-23)", () => {
  const p = buildSystemPrompt(sampleContext());
  // the offset axis mechanism + the two shipped commands mods on it
  assert.match(p, /shown = raw \+\s*offset/);
  assert.match(p, /smooth <region> \?window=N/);
  assert.match(p, /delay <region> \?frames=k/);
  // the authoring PAIR: a produces:channel offset mod + a requires-channel macro that binds
  assert.match(p, /bind all <channel> offset/);
  // offset is a bind-only vector axis in the bake/bind reference
  assert.match(p, /\bbind-only\b/);
});

test("system prompt teaches the targetless `background` command in prose, not as a target example", () => {
  const p = buildSystemPrompt(sampleContext());
  assert.match(p, /background <color>/);
  assert.match(p, /[Tt]argetless/);
  // and it is NOT smuggled into the resolved-target examples (it has no address)
  for (const e of GRAMMAR_EXAMPLES) assert.ok(!/^\s*background\b/.test(e.cmd), `\`${e.cmd}\` is targetless — keep it out of GRAMMAR_EXAMPLES`);
});

test("system prompt teaches the run-use correctness rules folded in the 2026-07-23 pass", () => {
  const p = buildSystemPrompt(sampleContext());
  // a channel is whole-system (resolves the Rule-6 conflict for channel mods)
  assert.match(p, /A channel spans the WHOLE SYSTEM/);
  // direction channels as unit vectors (the false 'hard swing' trap)
  assert.match(p, /should be returned as UNIT vectors/);
  // a per-point-scalar's ramp is min-maxed over the TARGET (the RMSF-on-solvent trap)
  assert.match(p, /min-maxed over\s+whatever was TARGETED/);
  assert.match(p, /the molecule comes out uniformly flat/);
  // figure dpi / size-cap recovery
  assert.match(p, /lower `dpi`/);
});

test("system prompt without context still instructs get_context first", () => {
  assert.match(buildSystemPrompt(null), /Call get_context/);
});
