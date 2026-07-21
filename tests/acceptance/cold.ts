/**
 * COLD acceptance test — the REAL system prompt (src/claudeprompt.ts) and the
 * REAL tool descriptions (src/claudetools.ts), against stateful deps that behave
 * like the live viewer at the CURRENT contract (post P-1/P-2/P-3):
 *   - a produces:channel mod declares its name in the HEADER (write_mod.channel);
 *     the return carries {values, components} and MUST NOT carry "name" (P-2)
 *   - write_mod refuses a channel mod with no channel name (the re-parse fix)
 *   - run_mod carries `parameters`; write_mod carries `params`/`channel`/
 *     `requiresChannel` (P-1/P-2/P-3)
 *   - get_context's live sections reflect declared channels/bindings instantly
 * We observe the SEQUENCE OF TOOL CALLS: which rung, whether live state is read,
 * template vs memory. No hints, no corrections. One request per conversation.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { buildToolDefs, type SceneContext } from "../../src/claudetools.ts";
import { buildSystemPrompt } from "../../src/claudeprompt.ts";
import { parseModFile } from "../../webview/recipes.ts";

// The key is read from a FILE named by KEYFILE and never from an argument, a
// literal, or anything this program writes: transcripts, logs and reports are
// committed, and a key must not be able to reach them by accident.
if (!process.env.KEYFILE || !process.env.OUTDIR) {
  console.error("usage: KEYFILE=<file holding an API key> OUTDIR=<dir> [COLD_SYSTEM=adk|trpcage|nucleic]\n" +
                "       [ONLY=R6] [RUN=a] [REAL_PRODUCER=1 PYBIN=<python with mdtraj>] [COLD_MODS_DIR=<dir>]\n" +
                "see tests/acceptance/README.md");
  process.exit(2);
}
const KEY = readFileSync(process.env.KEYFILE, "utf-8").trim();
const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
const API = "https://api.anthropic.com/v1/messages";
const OUTDIR = process.env.OUTDIR!;

const RESIDUES = ["ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE",
  "LEU","LYS","MET","PHE","PRO","SER","THR","TRP","TYR","VAL"];
type Chan = { name: string; scope: string; components: number };
type ModSpec = { name: string; produces: string; axis?: string; channel?: string;
  requiresChannel?: string; params?: { name: string; type: string; default?: unknown }[]; code: string; description?: string };
const state = {
  channels: [] as Chan[],
  bindings: [] as { channel: string; axis: string; expr: string }[],
  shapes: { points: ["sphere"], bonds: ["tube"], traces: ["tube", "ribbon"] } as Record<string, string[]>,
  activeShape: { points: "sphere", bonds: "tube", traces: "tube" } as Record<string, string>,
  styles: ["standard", "matte", "glossy"],
  mods: {} as Record<string, ModSpec>,
};
let transcript: string[] = [];
const say = (s: string): void => { console.log(s); transcript.push(s); };

/** Top-level string keys of the LAST `return { ... }` dict, or null. */
function returnDictKeys(code: string): string[] | null {
  const i = code.lastIndexOf("return {");
  if (i < 0) return null;
  let depth = 0, j = i + "return ".length; const keys: string[] = [];
  for (; j < code.length; j++) {
    const ch = code[j];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
    else if (depth === 1 && (ch === '"' || ch === "'")) {
      const end = code.indexOf(ch, j + 1); if (end < 0) break;
      const key = code.slice(j + 1, end);
      if (/^\s*:/.test(code.slice(end + 1))) keys.push(key);
      j = end;
    }
  }
  return keys;
}

function liveChannels(): string {
  if (state.channels.length === 0) return "no channels";
  const bound = new Set(state.bindings.map((b) => b.channel));
  return "channels (bake/bind read these):\n" + state.channels.map((c) => {
    const w = c.components === 3 ? "vector (3-wide)" : "scalar";
    return `  ${c.name} — ${w} · per-frame${bound.has(c.name) ? " · bound" : ""}`;
  }).join("\n");
}
const liveBindings = (): string => state.bindings.length === 0 ? "no bindings"
  : `${state.bindings.length} binding(s) (live):\n` + state.bindings.map((b) => `  ${b.channel} → ${b.axis} on "${b.expr}"`).join("\n");
const liveShapes = (): string => ["points","bonds","traces"].map((d) =>
  `  ${d}: ${state.shapes[d].map((n) => n === state.activeShape[d] ? `${n} (active)` : n).join(", ")}`).join("\n");
const liveStyles = (): string => "styles:\n" + state.styles.map((s, i) => `  ${s}${i === 0 ? " (default)" : ""}`).join("\n");

const SYS_CTX: any = JSON.parse(readFileSync(
  new URL(`./contexts/ctx_${process.env.COLD_SYSTEM ?? "adk"}.json`, import.meta.url), "utf-8"));

function sceneContext(): SceneContext {
  return {
    // SYSTEM-PARAMETERIZED (COLD_SYSTEM). adk stays the default so prior runs
    // reproduce, but adk is 100% polymer with no solvent and no unit cell, which
    // makes an entire defect class — solvent, periodic boundaries, multi-molecule
    // fitting — structurally invisible to this suite. 02_trpcage_atomistic is
    // 6.3% polymer (304 protein / 4497 solvent / 9 ion) and centered+wrapped by
    // the producer, so it can show what adk cannot.
    // Every system-shaped field is DERIVED from that system's real header
    // (scratchpad/gen_context.py mirrors extension.ts), because a cold run that
    // showed adk's categories over another system's atom count would be testing
    // a system that does not exist.
    ...SYS_CTX,
    committedSelections: "(none)",
    liveState: { channels: liveChannels(), bindings: liveBindings(), shapes: liveShapes(), styles: liveStyles() },
    baseLook: { pointSize: 3, opacity: 1, color: "#e6e6e6" },
    mods: Object.values(state.mods).map((m) => ({
      name: m.name, produces: m.produces as never,
      ...(m.axis ? { axis: m.axis as never } : {}),
      ...(m.channel ? { channel: m.channel } : {}),
      ...(m.requiresChannel ? { requiresChannel: m.requiresChannel } : {}),
      ...(m.params ? { params: m.params as never } : {}),
      ...(m.description ? { description: m.description } : {}),
    })),
  };
}

const CH_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

const deps = {
  getContext: async () => sceneContext(),
  runCommand: async (text: string) => {
    const t = text.trim(); const verb = t.split(/\s+/)[0];
    if (verb === "bind" || verb === "bake") {
      const m = t.match(/^(?:bind|bake)\s+(\S+)\s+(\S+)\s+(\S+)/);
      if (m) {
        const [, expr, channel, axis] = m;
        if (!state.channels.some((c) => c.name === channel))
          return { ok: false, message: `no channel "${channel}" for ${verb} — channels: ${state.channels.map((c)=>c.name).join(", ") || "this dataset declares none"}` };
        if (verb === "bind") state.bindings.push({ channel, axis, expr });
        return { ok: true, message: `${verb === "bind" ? "bound" : "baked"} "${channel}" → ${axis} on "${expr}"${verb === "bind" ? " — live: re-derives as the displayed frame changes" : ""}` };
      }
    }
    if (verb === "shape") {
      const m = t.match(/^shape\s+(points|bonds|traces)\s+(\S+)/);
      if (m) {
        const [, dom, name] = m;
        if (!state.shapes[dom]?.includes(name)) return { ok: false, message: `no shape "${name}" for ${dom} — registered: ${state.shapes[dom]?.join(", ")}` };
        state.activeShape[dom] = name;
        const needsOri = dom === "traces" && name === "ribbon";
        const warn = needsOri && !state.bindings.some((b) => b.axis === "orientation")
          ? ` — NOTE: ${name} reads the orientation axis and nothing is bound to it, so nothing will draw (bind a vector channel: bind <target> <channel> orientation)` : "";
        return { ok: true, message: `${dom} now draw as ${name}${warn}` };
      }
    }
    return { ok: true, message: `ok: ${t}` };
  },
  runMod: async (name: string, target: string, parameters?: Record<string, unknown>) => {
    const spec = state.mods[name];
    if (!spec) return { ok: false, message: `no mod named "${name}"` };
    // P-1: unknown/missing parameters fail closed, by name
    const declared = spec.params ?? [];
    for (const k of Object.keys(parameters ?? {})) {
      if (!declared.some((p) => p.name === k))
        return { ok: false, message: `${name}: unknown parameter "${k}" (declared: ${declared.map((p)=>p.name).join(", ") || "this mod declares no parameters"})` };
    }
    for (const p of declared) {
      if (p.default === undefined && (parameters ?? {})[p.name] === undefined)
        return { ok: false, message: `${name}: missing required parameter "${p.name}" (${p.type})` };
    }
    // P-3: a required channel that isn't live sequences its provider first
    if (spec.requiresChannel && !state.channels.some((c) => c.name === spec.requiresChannel)) {
      const provider = Object.values(state.mods).find((m) => m.channel === spec.requiresChannel);
      if (!provider) return { ok: false, message: `${name}: requires channel "${spec.requiresChannel}", but no registered mod declares it` };
      const pr = await deps.runMod(provider.name, target);
      if (!pr.ok) return { ok: false, message: `${name}: provider "${provider.name}" failed — "${name}" NOT run` };
    }
    if (spec.produces === "channel" && process.env.REAL_PRODUCER) {
      // FAITHFUL mode: execute the mod through the REAL producer on REAL adk, so
      // a values-LENGTH / runtime refusal reaches the assistant exactly as live.
      const tmp = `${OUTDIR}/.mod_${spec.name}.py`;
      mkdirSync(OUTDIR, { recursive: true });
      writeFileSync(tmp, spec.code, "utf-8");
      const { execFileSync } = await import("node:child_process");
      let reply: { values?: unknown; error?: string };
      try {
        if (!process.env.PYBIN) throw new Error("REAL_PRODUCER=1 needs PYBIN — a python with mdtraj (see README)");
        const out = execFileSync(process.env.PYBIN, [(process.env.REALRUN ?? new URL("./run_mod_real.py", import.meta.url).pathname), tmp, spec.channel ?? ""],
          { encoding: "utf-8", timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
        reply = JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop()!);
      } catch (e) {
        return { ok: false, message: `${name} failed: ${(e as Error).message.slice(0, 300)}` };
      }
      if (reply.error) return { ok: false, message: `${name} failed: ${reply.error}` };
      const compM = spec.code.match(/["']components["']\s*:\s*(\d)/);
      const decl: Chan = { name: spec.channel!, scope: "per_point_per_frame", components: compM ? Number(compM[1]) : 1 };
      if (!state.channels.some((c) => c.name === decl.name)) state.channels.push(decl);
      return { ok: true, message: `${name} → declared ${decl.components === 3 ? "vector" : "scalar"} channel "${decl.name}" — bindable now (no reload)` };
    }
    if (spec.produces === "channel") {
      const keys = returnDictKeys(spec.code);
      if (keys === null) return { ok: false, message: `${name} failed: a channel mod must return a dict carrying a 'values' list {values, components, min?, max?}` };
      if (keys.includes("name"))
        return { ok: false, message: `${name} failed: a channel mod's return must NOT carry 'name' — the channel name is declared in the mod header (# channel:), not the return` };
      if (!keys.includes("values"))
        return { ok: false, message: `${name} failed: a channel mod must return a dict carrying a 'values' list {values, components, min?, max?}. Got keys: ${keys.slice().sort().join(", ")}` };
      const compM = spec.code.match(/["']components["']\s*:\s*(\d)/);
      const decl: Chan = { name: spec.channel!, scope: "per_point_per_frame", components: compM ? Number(compM[1]) : 1 };
      if (!state.channels.some((c) => c.name === decl.name)) state.channels.push(decl);
      return { ok: true, message: `${name} → declared ${decl.components === 3 ? "vector" : "scalar"} channel "${decl.name}" — bindable now (no reload)` };
    }
    if (spec.produces === "commands") return { ok: true, message: `${name} → ran its commands (one undo stroke)` };
    if (spec.produces === "per-point-scalar") return { ok: true, message: `${name} → ${spec.axis ?? "color"} bound from scalars on "${target}"` };
    return { ok: true, message: `${name} → ran on ${target}` };
  },
  writeMod: async (spec: ModSpec) => {
    // P-2 (+ the re-parse fix): a channel mod MUST declare its channel name
    if (spec.produces === "channel" && (!spec.channel || !CH_NAME_RE.test(spec.channel))) {
      return { ok: false, name: spec.name, file: `.molaro/mods/${spec.name}.py`,
        message: `a channel mod needs channel: <name> (a single token ${CH_NAME_RE}, got "${spec.channel ?? ""}")` };
    }
    if (spec.produces === "per-point-scalar" && !spec.axis) {
      return { ok: false, name: spec.name, file: `.molaro/mods/${spec.name}.py`,
        message: `per-point-scalar mods need axis: color | size | opacity (got "")` };
    }
    state.mods[spec.name] = spec;
    return { ok: true, name: spec.name, file: `.molaro/mods/${spec.name}.py`, message: `registered mod "${spec.name}"` };
  },
  deleteMod: async (name: string) => { delete state.mods[name]; return { ok: true, message: `deleted mod "${name}"` }; },
  analysisModNames: () => Object.keys(state.mods),
  runModParams: (name: string) => state.mods[name]?.params as never,
};

const tools = buildToolDefs(deps as never);
// Schemas mirror the CURRENT tool inputs (P-1/P-2/P-3 fields included).
const TOOL_SCHEMAS: Record<string, unknown> = {
  get_context: { type: "object", properties: {}, additionalProperties: false },
  run_command: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  run_mod: { type: "object", properties: {
    name: { type: "string" }, target: { type: "string" },
    parameters: { type: "object", additionalProperties: true },
  }, required: ["name", "target"] },
  write_mod: { type: "object", properties: {
    name: { type: "string" },
    produces: { type: "string", enum: ["per-point-scalar","per-frame-series","scatter","commands","figure","channel"] },
    axis: { type: "string", enum: ["color","size","opacity"] },
    channel: { type: "string" },
    requiresChannel: { type: "string" },
    params: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, type: { type: "string", enum: ["number","string","boolean"] },
      default: {} }, required: ["name","type"] } },
    description: { type: "string" }, code: { type: "string" },
  }, required: ["name","produces","description","code"] },
  delete_mod: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};
const apiTools = Object.keys(TOOL_SCHEMAS).map((n) => ({
  name: n, description: (tools as never as Record<string, { description: string }>)[n].description,
  input_schema: TOOL_SCHEMAS[n],
}));

async function callAPI(system: string, messages: unknown[]): Promise<never> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, tools: apiTools, messages }),
    });
    if (r.status === 429 || r.status >= 500) { await new Promise((res) => setTimeout(res, 2500 * (attempt + 1))); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`API ${r.status}: ${j.error.message}`);
    return j as never;
  }
  throw new Error("API: exhausted retries");
}

/** The REAL shipped workspace inventory (.molaro/mods), parsed with the real
 * parser — so get_context advertises the same mods, params, channels and
 * requires-channel the live system does. Without this the assistant cannot be
 * observed reaching for an EXISTING parameterized mod. */
function shippedMods(): Record<string, ModSpec> {
  const dir = process.env.COLD_MODS_DIR ?? new URL("../../.molaro/mods", import.meta.url).pathname;
  const out: Record<string, ModSpec> = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".py")).sort()) {
    const r = parseModFile(readFileSync(`${dir}/${f}`, "utf-8"), "workspace");
    if (!r.ok) continue;
    const m = r.mod;
    out[m.name] = {
      name: m.name, produces: m.produces, code: m.code,
      ...(m.axis ? { axis: m.axis } : {}),
      ...(m.channel ? { channel: m.channel } : {}),
      ...(m.requiresChannel ? { requiresChannel: m.requiresChannel } : {}),
      ...(m.params ? { params: m.params as never } : {}),
      ...(m.description ? { description: m.description } : {}),
    };
  }
  return out;
}

async function runConversation(label: string, request: string): Promise<void> {
  // COLD: fresh scene, fresh conversation, no carried context. The workspace mod
  // inventory is the REAL shipped one (as live), not empty.
  state.channels = []; state.bindings = []; state.mods = shippedMods();
  state.activeShape = { points: "sphere", bonds: "tube", traces: "tube" };
  transcript = [];
  const log: { tool: string; input: Record<string, unknown> }[] = [];
  const system = buildSystemPrompt(sceneContext());
  const messages: unknown[] = [{ role: "user", content: request }];
  say(`${"=".repeat(78)}\n${label} — COLD, no hints\nUSER: "${request}"\n${"=".repeat(78)}`);

  let turns = 0;
  for (let turn = 0; turn < 14; turn++) {
    turns = turn + 1;
    const resp = await callAPI(system, messages) as unknown as { content: { type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }[] };
    messages.push({ role: "assistant", content: resp.content });
    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    for (const b of resp.content) if (b.type === "text" && b.text?.trim()) say(`\n[assistant turn ${turns}]\n${b.text.trim()}`);
    if (toolUses.length === 0) break;
    const results: unknown[] = [];
    for (const tu of toolUses) {
      const handler = (tools as never as Record<string, { handler: (i: unknown) => Promise<{ content?: { text: string }[] }> }>)[tu.name!].handler;
      const out = await handler(tu.input);
      const text = out.content?.map((c) => c.text).join("\n") ?? JSON.stringify(out);
      log.push({ tool: tu.name!, input: tu.input! });
      const shown = tu.name === "write_mod"
        ? JSON.stringify({ name: tu.input!.name, produces: tu.input!.produces, axis: tu.input!.axis, channel: tu.input!.channel, requiresChannel: tu.input!.requiresChannel, params: tu.input!.params })
        : JSON.stringify(tu.input);
      say(`\n>>> TOOL ${tu.name}(${shown})\n<<< ${text}`);
      if (tu.name === "write_mod") say(`--- mod source (${tu.input!.name}) ---\n${tu.input!.code}\n--- end ---`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: text });
    }
    messages.push({ role: "user", content: results });
  }
  const seq = log.map((e) => e.tool + (e.tool === "write_mod" ? `:${e.input.produces}` : e.tool === "run_command" ? `:${String(e.input.command).split(/\s+/)[0]}` : ""));
  say(`\nTOOL SEQUENCE: ${seq.join(" → ")}`);
  say(`get_context calls: ${log.filter((e) => e.tool === "get_context").length} · turns: ${turns}`);
  say(`used mod parameters: ${log.some((e) => (e.tool === "write_mod" && e.input.params) || (e.tool === "run_mod" && e.input.parameters)) ? "YES" : "no"}`);
  mkdirSync(OUTDIR, { recursive: true });
  writeFileSync(`${OUTDIR}/${label}.log`, transcript.join("\n"), "utf-8");
}

const REQUESTS: [string, string][] = [
  ["R1", "Color the acidic residues red and the basic ones blue."],
  ["R2", "Color it by how much each atom moves, as it plays."],
  ["R3", "Make a cartoon of the backbone with everything else faded."],
  ["R4", "Make the backbone thicker and use a warmer color."],
  ["R5", "Give me that two-panel figure at print resolution."],
  ["R6", "Color the atoms by how floppy they are."],
  ["R7", "Show me how compact it gets over time."],
  ["R8", "Save the charged-residue coloring so I can apply it again later."],
];
(async () => {
  const only = process.env.ONLY;      // e.g. "R2"
  const run = process.env.RUN ?? "a"; // run label (a | b)
  for (const [id, req] of REQUESTS) {
    if (only && only !== id) continue;
    await runConversation(`${id}_run${run}`, req);
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
