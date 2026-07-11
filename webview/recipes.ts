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
export type RecipeOrigin = "built-in" | "workspace";

export type ModKind = "representation" | "analysis";

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
  /** The declared result kind — the routing key into the existing binding
   * layer. (`command` is deliberately NOT a value here.) */
  produces: "per-point-scalar" | "per-frame-series" | "scatter";
  /** Required iff produces = per-point-scalar: which point axis the scalars
   * bind to. */
  axis?: "color" | "size" | "opacity";
  /** Python source defining `compute(data, target_indices)`, executed in
   * the producer against the resident dataset handle. Returns a flat
   * `list[float]` — EXCEPT `produces: scatter`, which returns a dict
   * `{x, y, frames?, xLabel?, yLabel?}` (the one deliberate widening). */
  code: string;
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
  let i = 1;
  for (; i < lines.length; i++) {
    const m = /^#\s*([a-z][a-z-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) break; // first non-header line starts the code
    meta[m[1]] = m[2].trim();
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
  if (produces !== "per-point-scalar" && produces !== "per-frame-series" && produces !== "scatter") {
    return { ok: false, error: `produces must be per-point-scalar | per-frame-series | scatter (got "${produces ?? ""}")` };
  }
  const axis = meta.axis;
  if (produces === "per-point-scalar") {
    if (axis !== "color" && axis !== "size" && axis !== "opacity") {
      return { ok: false, error: `per-point-scalar mods need axis: color | size | opacity (got "${axis ?? ""}")` };
    }
  } else if (axis !== undefined) {
    return { ok: false, error: "axis is only valid on per-point-scalar mods" };
  }
  if (!/\bdef\s+compute\s*\(/.test(code)) {
    return { ok: false, error: "the code must define compute(data, target_indices)" };
  }
  const mod: AnalysisMod = {
    name,
    kind: "analysis",
    produces,
    ...(produces === "per-point-scalar" ? { axis: axis as "color" | "size" | "opacity" } : {}),
    code,
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
    ...(mod.author ? [`# author: ${mod.author}`] : []),
    ...(mod.source ? [`# source: ${mod.source}`] : []),
    ...(mod.description ? [`# description: ${mod.description}`] : []),
  ];
  return `${head.join("\n")}\n\n${mod.code}\n`;
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
): { ok: true; values: number[] } | { ok: true; scatter: ScatterValues } | { ok: false; error: string } {
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
