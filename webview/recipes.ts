/**
 * Mods (recipes) — stored, named functions over a resolved target. Two kinds,
 * tagged explicitly:
 *
 *   kind: "representation" (Type R) — JS compute in the webview over the
 *     resolved point set, geometry-only (rainbow: per-element scalar in
 *     [0,1] rendered through a colormap into the point-color buffer). The
 *     scalar-then-colormap split is deliberate — the mapping-and-write step
 *     (applyColorScalars in commands.ts) never knows the scalar source.
 *
 *   kind: "analysis" (Type A) — PYTHON compute executed in the PRODUCER
 *     process against the loaded dataset (`code` defines
 *     `compute(data, target_indices) -> list[float]`). `produces` is the
 *     ROUTING KEY: the returned floats are validated FAIL-CLOSED and
 *     packaged as a TypedResult of the declared kind, then handed to the
 *     EXISTING binding layer (per-point-scalar → the per-element write
 *     rails; per-frame-series → the plot tab). `command` is deliberately
 *     not a produces value — a mod that just emits a command is a macro,
 *     out of scope. The typed-result union stays closed.
 *
 * Analysis mods persist as files under `.molaro/mods/` — a plain Python
 * file with a `# molaro-mod` magic first line and `# key: value` header
 * comments before the source, so a human can READ THE CODE before running
 * it (the whole point of the format; parse/serialize below round-trip it).
 * Built-ins are not files; loaded files get origin "workspace".
 *
 * The registry is storage + lookup; `mods` lists it. Pure module: no DOM,
 * no fs — file IO lives with the hosts; this module owns the format.
 */

/** Where a mod came from. Built-ins are code-registered; "workspace" is
 * assigned by the file loader (never trusted from the file itself). */
import { validateFigure, type FigureAxes } from "./plotmodel.ts";
import { parseChannelDelta, type Channel } from "../contract/contract.ts";

export type RecipeOrigin = "built-in" | "workspace";

export type ModKind = "representation" | "analysis";

/** THE single source of truth for the analysis-mod result kinds. Every place
 * that enumerates them — this type, the file parser/validator, the `write_mod`
 * MCP schema, `mods` display, docs — derives from or is asserted against THIS.
 * A `write_mod` schema that hardcoded a stale subset (missing `commands`) is the
 * bug this closes: two lists that must agree, only one updated. See
 * tests/recipes.test.ts for the equality guard. */
export const MOD_PRODUCES = ["per-point-scalar", "per-frame-series", "scatter", "commands", "figure", "channel"] as const;
export type ModProduces = (typeof MOD_PRODUCES)[number];

/** The point axes a `per-point-scalar` mod binds to — the single source the
 * `write_mod` schema and the parser both derive from / are asserted against. */
export const MOD_AXES = ["color", "size", "opacity"] as const;
export type ModAxis = (typeof MOD_AXES)[number];

/** THE single source of truth for a mod parameter's scalar type. This is the
 * ONLY enumerated thing a parameter schema carries — a param's name and default
 * are per-mod DATA, not an enumerated set. Kept closed and small (three scalars,
 * nothing speculative) exactly like MOD_PRODUCES / MOD_AXES, and guarded the same
 * way (tests/recipes.test.ts). Every surface derives from this: the header parser
 * validates against it; the header IS the schema's single source. The wire and
 * the producer carry VALUES, not the type set — so it is a one-language enum, not
 * a cross-language twin (the producer never authors a parameter declaration, it
 * only consumes already-typed values). See reports/MOD_PARAMS_PHASE0.md. */
export const MOD_PARAM_TYPES = ["number", "string", "boolean"] as const;
export type ModParamType = (typeof MOD_PARAM_TYPES)[number];

/** A parameter value once coerced to its declared type. */
export type ParamValue = number | string | boolean;

/** One declared parameter of an analysis mod (a `# param: <name> <type>
 * [<default>]` header line). `default` present ⟺ the header declared one;
 * absent = the parameter is REQUIRED at invocation. */
export interface ModParam {
  name: string;
  type: ModParamType;
  default?: ParamValue;
}

/** Metadata every mod carries regardless of kind. */
interface ModCommon {
  name: string;
  origin: RecipeOrigin;
  /** Attribution / provenance — DISPLAY-ONLY credit `mods` lists. Nothing
   * anywhere resolves, fetches, validates, or acts on these strings. */
  author?: string;
  source?: string;
  description?: string;
}

/** Type R — the existing webview/JS recipe shape, retagged. */
export interface Recipe extends ModCommon {
  kind: "representation";
  /** The buffer family the recipe writes. Only the point-color axis exists
   * today; the field is here so later axes extend the shape, not fork it. */
  axis: "point-color";
  /** Per-element scalar in [0, 1], one per point, in the GIVEN order (the
   * resolved set's existing order — resolution order is the recipe's axis). */
  compute(points: readonly number[]): number[];
  /** scalar in [0,1] → RGB, each component in [0,1]. */
  colormap(t: number): [number, number, number];
}

/** Type A — Python compute in the producer. */
export interface AnalysisMod extends ModCommon {
  kind: "analysis";
  /** The declared result kind (see MOD_PRODUCES — the single source). per-point-
   * scalar/per-frame-series/scatter bind through the typed-result rails;
   * `commands` returns a `list[str]` run through the command path at the mod-run
   * boundary (NOT a TypedResult — the union stays closed at four). */
  produces: ModProduces;
  /** Required iff produces = per-point-scalar: which point axis the scalars
   * bind to (see MOD_AXES). */
  axis?: ModAxis;
  /** Python source defining `compute(data, target_indices)` — or
   * `compute(data, target_indices, params)` when the mod declares parameters.
   * Executed in the producer against the resident dataset handle. Returns a flat
   * `list[float]` — EXCEPT `produces: scatter`, which returns a dict
   * `{x, y, frames?, xLabel?, yLabel?}` (the one deliberate widening). */
  code: string;
  /** Declared parameters (the `# param:` header lines), in header order. Present
   * ⟺ the mod declared at least one; a paramless mod omits it and is invoked and
   * called exactly as before (two-arg `compute`). */
  params?: ModParam[];
}

export type Mod = Recipe | AnalysisMod;

/** Pure HSV → RGB (h in degrees, s/v in [0,1]; returns RGB in [0,1]). */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [r + m, g + m, b + m];
}

/** The rainbow hue sweep: 0 → red … RAINBOW_HUE_MAX → magenta. Stops short
 * of 360 so the ramp's two ends never wrap back to the same color. */
export const RAINBOW_HUE_MAX = 300;

/** `rainbow` — the first recipe: an even ramp from 0 to 1 across the
 * resolved set in its existing order, rendered through one built-in hue
 * sweep. A single-point set yields [0] (no divide-by-zero). */
export const rainbow: Recipe = {
  name: "rainbow",
  kind: "representation",
  axis: "point-color",
  compute: (points) => points.map((_, i) => i / Math.max(points.length - 1, 1)),
  colormap: (t) => hsvToRgb(t * RAINBOW_HUE_MAX, 1, 1),
  origin: "built-in",
  author: "Dominic Fico",
  source: "https://github.com/DomFico/molaro",
};

// -- the in-memory mod registry ---------------------------------------------------

const recipes = new Map<string, Mod>();

export function registerRecipe(mod: Mod): void {
  recipes.set(mod.name, mod);
}

export function getRecipe(name: string): Mod | undefined {
  return recipes.get(name);
}

/** Every registered mod, in registration order — the read accessor the
 * `mods` listing enumerates through. */
export function listRecipes(): Mod[] {
  return [...recipes.values()];
}

registerRecipe(rainbow);

// -- the mod FILE format (analysis mods only — R mods are code) --------------------
//
//   # molaro-mod
//   # name: index_ramp
//   # kind: analysis
//   # produces: per-point-scalar
//   # axis: color
//   # author: …            (optional)
//   # source: …            (optional)
//   # description: …       (optional)
//
//   def compute(data, target_indices):
//       ...
//
// The header is `# key: value` lines directly after the magic line; the
// first non-header line starts the Python source. One mod per file.

export const MOD_FILE_MAGIC = "# molaro-mod";

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export type ModParseResult =
  | { ok: true; mod: AnalysisMod }
  | { ok: false; error: string };

/** Parse one mod file's text. Fail-closed and total: any shape violation is
 * a reported error, never a throw — the loader skips-and-warns, so one bad
 * file can never break startup or the registry. `origin` is ASSIGNED by the
 * caller (the loader passes "workspace"), never read from the file. */
export function parseModFile(text: string, origin: RecipeOrigin): ModParseResult {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== MOD_FILE_MAGIC) {
    return { ok: false, error: `missing "${MOD_FILE_MAGIC}" magic first line` };
  }
  const meta: Record<string, string> = {};
  // `# param:` lines are COLLECTED, not folded into `meta` — a mod declares many
  // and the flat meta map would silently overwrite all but the last (the Q2
  // sleeper: three declared, one survives). They keep header order.
  const paramLines: string[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const m = /^#\s*([a-z][a-z-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) break; // first non-header line starts the code
    if (m[1] === "param") paramLines.push(m[2].trim());
    else meta[m[1]] = m[2].trim();
  }
  const code = lines.slice(i).join("\n").trim();
  const name = meta.name ?? "";
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `invalid or missing name "${name}" (want ${NAME_RE})` };
  }
  if (meta.kind !== "analysis") {
    return { ok: false, error: `kind must be "analysis" for mod files (got "${meta.kind ?? ""}")` };
  }
  const produces = meta.produces;
  if (!(MOD_PRODUCES as readonly string[]).includes(produces ?? "")) {
    return { ok: false, error: `produces must be ${MOD_PRODUCES.join(" | ")} (got "${produces ?? ""}")` };
  }
  const axis = meta.axis;
  if (produces === "per-point-scalar") {
    if (!(MOD_AXES as readonly string[]).includes(axis ?? "")) {
      return { ok: false, error: `per-point-scalar mods need axis: ${MOD_AXES.join(" | ")} (got "${axis ?? ""}")` };
    }
  } else if (axis !== undefined) {
    return { ok: false, error: "axis is only valid on per-point-scalar mods" };
  }
  if (!/\bdef\s+compute\s*\(/.test(code)) {
    return { ok: false, error: "the code must define compute(data, target_indices)" };
  }
  // Parameters: parse each `# param:` line, reject duplicates by name. We do NOT
  // check compute's arity here — the parser sees only source text, and a regex
  // that counts Python parameters is unsound (annotations, defaults, *args,
  // comments, multi-line). The producer's inspect.signature check is the sole
  // authoritative gate (an unsound belt is worse than none — someone trusts it).
  const params: ModParam[] = [];
  const seenParam = new Set<string>();
  for (const line of paramLines) {
    const pr = parseParamLine(line);
    if (!pr.ok) return { ok: false, error: pr.error };
    if (seenParam.has(pr.param.name)) {
      return { ok: false, error: `duplicate parameter "${pr.param.name}"` };
    }
    seenParam.add(pr.param.name);
    params.push(pr.param);
  }
  const mod: AnalysisMod = {
    name,
    kind: "analysis",
    produces: produces as ModProduces, // validated against MOD_PRODUCES above
    ...(produces === "per-point-scalar" ? { axis: axis as ModAxis } : {}),
    code,
    ...(params.length ? { params } : {}),
    origin,
    ...(meta.author ? { author: meta.author } : {}),
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.description ? { description: meta.description } : {}),
  };
  return { ok: true, mod };
}

/** Serialize an analysis mod back to the file format (the save path a later
 * authoring step writes through). Representation mods are JS — they have no
 * file form; refusing keeps the format honest. */
export function serializeMod(mod: Mod): string {
  if (mod.kind !== "analysis") {
    throw new Error("only analysis mods serialize to files (representation mods are code)");
  }
  const head = [
    MOD_FILE_MAGIC,
    `# name: ${mod.name}`,
    `# kind: analysis`,
    `# produces: ${mod.produces}`,
    ...(mod.axis ? [`# axis: ${mod.axis}`] : []),
    ...(mod.params ?? []).map(
      (p) => `# param: ${p.name} ${p.type}${p.default !== undefined ? ` ${p.default}` : ""}`,
    ),
    ...(mod.author ? [`# author: ${mod.author}`] : []),
    ...(mod.source ? [`# source: ${mod.source}`] : []),
    ...(mod.description ? [`# description: ${mod.description}`] : []),
  ];
  return `${head.join("\n")}\n\n${mod.code}\n`;
}

// -- parameters: the header schema, coercion, and the shared resolver --------------

/** A decimal or scientific-notation number literal — the ONLY string forms a
 * `number` parameter accepts. Excludes hex/binary/octal, leading-`+`-only, and
 * `Infinity`/`NaN` (all of which `Number()` would silently swallow). */
const NUMBER_LITERAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Coerce a raw value to a declared type. Accepts BOTH a native JSON scalar
 * (the assistant passes typed values) and a string (the terminal passes
 * `?key=value` text), so ONE resolver serves both entrances — which is what
 * keeps the approval preview and execution from ever disagreeing. A string is
 * the most permissive target (number/boolean fold into it), but a `"` is
 * REFUSED uniformly: parameter values pass through the invocation string, which
 * has no escape, so a `"` cannot round-trip and is rejected loudly on every
 * path rather than silently mangled. `reason` is context-free — callers prefix
 * it with the parameter name. */
function coerceValue(
  type: ModParamType,
  raw: unknown,
): { ok: true; value: ParamValue } | { ok: false; reason: string } {
  if (type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
    if (typeof raw === "string" && NUMBER_LITERAL_RE.test(raw.trim()) && Number.isFinite(Number(raw.trim()))) {
      return { ok: true, value: Number(raw.trim()) };
    }
    return { ok: false, reason: `expects a number, got "${String(raw)}"` };
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return { ok: true, value: raw };
    if (raw === "true") return { ok: true, value: true };
    if (raw === "false") return { ok: true, value: false };
    return { ok: false, reason: `expects true or false, got "${String(raw)}"` };
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const s = String(raw);
    if (s.includes('"')) return { ok: false, reason: `cannot contain a double-quote, got "${s}"` };
    return { ok: true, value: s };
  }
  return { ok: false, reason: `expects a string, got "${String(raw)}"` };
}

const PARAM_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Parse one `# param:` header line: `<name> <type> [<default…>]`. The default
 * is the REST of the line (so a string default may hold spaces) and is coerced
 * against the declared type, so a malformed default fails at parse/registration
 * time — loud, before any run. Total: never throws. */
export function parseParamLine(
  line: string,
): { ok: true; param: ModParam } | { ok: false; error: string } {
  const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim());
  if (!m) {
    return { ok: false, error: `malformed param "${line}" — want: # param: <name> <type> [<default>]` };
  }
  const [, name, typeTok, defRaw] = m;
  if (!PARAM_NAME_RE.test(name)) {
    return { ok: false, error: `invalid parameter name "${name}" (want ${PARAM_NAME_RE})` };
  }
  if (!(MOD_PARAM_TYPES as readonly string[]).includes(typeTok)) {
    return { ok: false, error: `parameter "${name}": type must be ${MOD_PARAM_TYPES.join(" | ")} (got "${typeTok}")` };
  }
  const type = typeTok as ModParamType;
  if (defRaw !== undefined && defRaw.trim() !== "") {
    const c = coerceValue(type, defRaw.trim());
    if (!c.ok) return { ok: false, error: `parameter "${name}" default ${c.reason}` };
    return { ok: true, param: { name, type, default: c.value } };
  }
  return { ok: true, param: { name, type } };
}

/** THE resolver: validate the passed parameters against a mod's declared schema
 * and fill defaults. Single-sourced — the terminal invocation parser AND the
 * host's approval preview both call it, so what the user approves and what the
 * producer runs are computed the same way. Fail-closed by name: an unknown
 * parameter, a wrong-typed value, or a missing required one → error, nothing
 * runs. Returns the EFFECTIVE typed values (defaults included) — the complete
 * set the producer receives. `passed` values may be strings (terminal) or native
 * scalars (assistant); coerceValue handles both. */
export function resolveParameters(
  params: readonly ModParam[],
  passed: ReadonlyMap<string, unknown>,
): { ok: true; values: Record<string, ParamValue> } | { ok: false; error: string } {
  const byName = new Map(params.map((p) => [p.name, p]));
  for (const key of passed.keys()) {
    if (!byName.has(key)) {
      const known = params.length ? params.map((p) => p.name).join(", ") : "this mod declares no parameters";
      return { ok: false, error: `unknown parameter "${key}" (declared: ${known})` };
    }
  }
  const values: Record<string, ParamValue> = {};
  for (const p of params) {
    if (passed.has(p.name)) {
      const c = coerceValue(p.type, passed.get(p.name));
      if (!c.ok) return { ok: false, error: `parameter "${p.name}" ${c.reason}` };
      values[p.name] = c.value;
    } else if (p.default !== undefined) {
      values[p.name] = p.default;
    } else {
      return { ok: false, error: `missing required parameter "${p.name}" (${p.type})` };
    }
  }
  return { ok: true, values };
}

// -- fail-closed validation of an analysis mod's returned floats -------------------

export interface ModRunExpectation {
  produces: AnalysisMod["produces"];
  /** per-point-scalar: the resolved target size. */
  targetCount: number;
  /** per-frame-series length / scatter frames range: the dataset's frame count. */
  frameCount: number;
}

/** A validated scatter return: equal-length finite x/y, optional integer
 * frame indices (the sync hook), optional axis labels. */
export interface ScatterValues {
  x: number[];
  y: number[];
  frames?: number[];
  xLabel?: string;
  yLabel?: string;
}

const finiteNumList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** THE fail-closed gate between the producer's reply and any binding: the
 * return must match the declared kind EXACTLY — a flat list of finite
 * numbers of the expected length (within [0,1] for per-point-scalar — the
 * binding layer's existing contract; the mod owns its own normalization),
 * or, for scatter only, a dict of equal-length non-empty finite x/y with
 * optional in-range integer frames. Any violation → an error and NOTHING
 * is bound or drawn. Never partial-write. */
export function validateModValues(
  values: unknown,
  expect: ModRunExpectation,
): { ok: true; values: number[] } | { ok: true; scatter: ScatterValues }
  | { ok: true; commands: string[] }
  | { ok: true; figure: { png: string; width: number; height: number; axes: FigureAxes[] } }
  | { ok: true; channel: Channel; warning?: string }
  | { ok: false; error: string } {
  if (expect.produces === "channel") {
    // The producer already DECLARED + stored the channel (its data rides
    // subsequent FrameChunks); the reply carries only the declaration + any
    // coherence warning. Re-validate the declaration through THE contract's
    // own delta parser (single source with the wire) — the viewer applies
    // it to its header and the channel becomes bindable, no reload.
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return { ok: false, error: "a channel mod's reply must be a dict {channel, warning?}" };
    }
    const m = values as Record<string, unknown>;
    let channel: Channel;
    try {
      channel = parseChannelDelta(m.channel);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const warning = typeof m.warning === "string" ? m.warning : undefined;
    return { ok: true, channel, warning };
  }
  if (expect.produces === "commands") {
    // The return must be a flat list of NON-EMPTY strings. Anything else →
    // no execution. (Whether each string is a VALID command is checked at the
    // execution boundary, all-or-nothing, before any command runs.)
    if (!Array.isArray(values)) {
      return { ok: false, error: `a commands mod must return a list of command strings, not ${typeof values}` };
    }
    for (let i = 0; i < values.length; i++) {
      if (typeof values[i] !== "string") {
        return { ok: false, error: `commands[${i}] is not a string (a commands mod returns list[str])` };
      }
      if ((values[i] as string).trim() === "") {
        return { ok: false, error: `commands[${i}] is an empty string` };
      }
    }
    return { ok: true, commands: values as string[] };
  }
  if (expect.produces === "figure") {
    // THE one figure validator (plotmodel.validateFigure) — shared with the
    // terminal claude-bind path in plothost, so the two entrances cannot
    // drift. frameCount powers the frames-axis overlap check.
    const fig = validateFigure(values, expect.frameCount);
    return fig.ok ? { ok: true, figure: fig.figure } : { ok: false, error: fig.error };
  }
  if (expect.produces === "scatter") {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return { ok: false, error: "a scatter mod must return a dict {x, y, frames?, xLabel?, yLabel?}" };
    }
    const m = values as Record<string, unknown>;
    if (!finiteNumList(m.x) || !finiteNumList(m.y)) {
      return { ok: false, error: "scatter x and y must be lists of finite numbers" };
    }
    if (m.x.length === 0) return { ok: false, error: "scatter x/y are empty — nothing to draw" };
    if (m.x.length !== m.y.length) {
      return { ok: false, error: `scatter x and y must be equal length (got ${m.x.length} vs ${m.y.length})` };
    }
    let frames: number[] | undefined;
    if (m.frames !== undefined) {
      if (!finiteNumList(m.frames) || m.frames.length !== m.x.length) {
        return { ok: false, error: `scatter frames must match x/y length (${m.x.length})` };
      }
      for (const f of m.frames) {
        if (!Number.isInteger(f) || f < 0 || f >= expect.frameCount) {
          return { ok: false, error: `scatter frames must be integer frame indices in [0, ${expect.frameCount - 1}] — got ${f}` };
        }
      }
      frames = m.frames;
    }
    return {
      ok: true,
      scatter: {
        x: m.x, y: m.y,
        ...(frames ? { frames } : {}),
        ...(typeof m.xLabel === "string" ? { xLabel: m.xLabel } : {}),
        ...(typeof m.yLabel === "string" ? { yLabel: m.yLabel } : {}),
      },
    };
  }
  if (!Array.isArray(values)) {
    return { ok: false, error: `compute returned ${typeof values}, not a list of floats` };
  }
  const want = expect.produces === "per-point-scalar" ? expect.targetCount : expect.frameCount;
  const unit = expect.produces === "per-point-scalar" ? "target index" : "frame";
  if (values.length !== want) {
    return {
      ok: false,
      error: `compute returned ${values.length} values — expected exactly ${want} (one per ${unit})`,
    };
  }
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `compute returned a non-finite value at [${i}]` };
    }
    if (expect.produces === "per-point-scalar" && (v < 0 || v > 1)) {
      return {
        ok: false,
        error: `per-point-scalar values must be in [0,1] — got ${v} at [${i}] (the mod owns its normalization)`,
      };
    }
  }
  return { ok: true, values: values as number[] };
}

// -- rm: mod-name selector resolution + runtime unregistration --------------------

export function unregisterRecipe(name: string): boolean {
  return recipes.delete(name);
}

/** The buckets an rm selector resolves to. */
export interface ModSelection {
  /** Deletable: workspace mods, in selector order, deduped. */
  workspace: string[];
  /** Named but refused: built-ins are code, not files. */
  builtins: string[];
  /** Named but unknown. */
  nomatch: string[];
}

/** Resolve an rm selector against MOD NAMES — a different namespace from
 * the point grammar (the point resolver is deliberately NOT in this path).
 * Syntactic conventions only are shared: terms split on `+`, `all` is a
 * keyword when it is the whole term (and means all WORKSPACE mods, never
 * built-ins), everything else is an exact name. Pure and total: an empty
 * selector is the one error. */
export function resolveModSelector(
  selector: string,
  mods: readonly Mod[],
): ModSelection | { error: string } {
  const terms = selector.split("+").map((t) => t.trim());
  if (terms.some((t) => t === "")) {
    return { error: "empty term in the mod selector — rm <name> [+ <name>…] or rm all" };
  }
  const byName = new Map(mods.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const out: ModSelection = { workspace: [], builtins: [], nomatch: [] };
  const bucket = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const mod = byName.get(name);
    if (!mod) out.nomatch.push(name);
    else if (mod.origin === "built-in") out.builtins.push(name);
    else out.workspace.push(name);
  };
  for (const term of terms) {
    if (term === "all") {
      for (const m of mods) if (m.origin !== "built-in") bucket(m.name);
    } else {
      bucket(term);
    }
  }
  return out;
}
