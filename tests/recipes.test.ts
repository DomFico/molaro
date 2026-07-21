/**
 * Unit tests for the recipe layer — the ramp, the hue colormap, and the
 * in-memory registry. Pure, no DOM. Run from viewer/:
 * node --test tests/recipes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RAINBOW_HUE_MAX,
  getRecipe,
  hsvToRgb,
  listRecipes,
  rainbow,
  registerRecipe,
  type Recipe,
} from "../webview/recipes.ts";

test("rainbow.compute: an even 0→1 ramp across the set in its given order", () => {
  assert.deepEqual(rainbow.compute([10, 20, 30, 40, 50]), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(rainbow.compute([7, 3]), [0, 1], "two points span the whole ramp");
  // the scalar depends on POSITION in the set, never on the ids themselves
  assert.deepEqual(rainbow.compute([50, 40, 30, 20, 10]), [0, 0.25, 0.5, 0.75, 1]);
});

test("rainbow.compute: a single-point set yields [0] — no divide-by-zero", () => {
  assert.deepEqual(rainbow.compute([124]), [0]);
});

test("hsvToRgb: the primary/secondary anchors, s=0 gray, hue wrap", () => {
  assert.deepEqual(hsvToRgb(0, 1, 1), [1, 0, 0], "red");
  assert.deepEqual(hsvToRgb(60, 1, 1), [1, 1, 0], "yellow");
  assert.deepEqual(hsvToRgb(120, 1, 1), [0, 1, 0], "green");
  assert.deepEqual(hsvToRgb(240, 1, 1), [0, 0, 1], "blue");
  assert.deepEqual(hsvToRgb(300, 1, 1), [1, 0, 1], "magenta");
  assert.deepEqual(hsvToRgb(0, 0, 0.5), [0.5, 0.5, 0.5], "s=0 is a gray of value v");
  assert.deepEqual(hsvToRgb(360, 1, 1), hsvToRgb(0, 1, 1), "360 wraps to 0");
  assert.deepEqual(hsvToRgb(-60, 1, 1), hsvToRgb(300, 1, 1), "negative hues normalize");
});

test("rainbow.colormap: one built-in hue sweep, ends never coincide", () => {
  assert.deepEqual(rainbow.colormap(0), [1, 0, 0], "t=0 → hue 0 (red)");
  assert.deepEqual(rainbow.colormap(1), hsvToRgb(RAINBOW_HUE_MAX, 1, 1), "t=1 → the sweep's far end");
  assert.notDeepEqual(rainbow.colormap(0), rainbow.colormap(1),
    "the sweep stops short of 360 so the ramp's ends stay distinct");
  assert.deepEqual(rainbow.colormap(0.5), [0, 1, 0.5], "t=0.5 → hue 150");
});

test("the registry holds rainbow under its name, axis point-color (storage only)", () => {
  const r = getRecipe("rainbow");
  assert.ok(r, "rainbow registered at module load");
  assert.equal(r, rainbow, "the registry resolves to THE recipe object the verb runs");
  assert.equal(r.name, "rainbow");
  assert.equal(r.axis, "point-color");
  assert.equal(getRecipe("nothere"), undefined);
});

test("rainbow carries honest attribution: built-in, project author and repo", () => {
  assert.equal(rainbow.origin, "built-in");
  assert.equal(rainbow.author, "Dominic Fico");
  assert.equal(rainbow.source, "https://github.com/DomFico/molaro");
});

test("registerRecipe: a name → recipe map future recipes register into", () => {
  const flat: Recipe = {
    name: "flat-test",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0.5),
    colormap: () => [0, 0, 0],
    origin: "built-in",
  };
  registerRecipe(flat);
  assert.equal(getRecipe("flat-test"), flat);
  assert.deepEqual(listRecipes().map((r) => r.name), ["rainbow", "flat-test"],
    "listRecipes enumerates in registration order");
});

// -- the mod FILE format + the fail-closed validation gate (brief #3) -------------

import {
  parseModFile,
  parseParamLine,
  resolveModSelector,
  resolveParameters,
  serializeMod,
  unregisterRecipe,
  validateModValues,
  MOD_AXES,
  MOD_FILE_MAGIC,
  MOD_PARAM_TYPES,
  MOD_PRODUCES,
  type AnalysisMod,
  type ModParam,
} from "../webview/recipes.ts";

const GOOD_FILE = `# molaro-mod
# name: index_ramp
# kind: analysis
# produces: per-point-scalar
# axis: color
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example

def compute(data, target_indices):
    n = max(len(target_indices) - 1, 1)
    return [i / n for i in range(len(target_indices))]
`;

test("mod files: parse extracts metadata + code; origin is ASSIGNED, never read", () => {
  const r = parseModFile(GOOD_FILE, "workspace");
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.equal(r.mod.name, "index_ramp");
    assert.equal(r.mod.kind, "analysis");
    assert.equal(r.mod.produces, "per-point-scalar");
    assert.equal(r.mod.axis, "color");
    assert.equal(r.mod.author, "Example Author");
    assert.equal(r.mod.origin, "workspace", "the loader assigns origin");
    assert.match(r.mod.code, /^def compute\(data, target_indices\):/);
  }
});

test("mod files: save → load round-trips the mod exactly", () => {
  const mod: AnalysisMod = {
    name: "frame_metric",
    kind: "analysis",
    produces: "per-frame-series",
    code: "def compute(data, target_indices):\n    return [1.0]",
    origin: "workspace",
    author: "Example Author",
    description: "synthetic example",
  };
  const text = serializeMod(mod);
  assert.ok(text.startsWith(MOD_FILE_MAGIC), "the magic line leads the file");
  const back = parseModFile(text, "workspace");
  assert.ok(back.ok, JSON.stringify(back));
  if (back.ok) assert.deepEqual(back.mod, mod);
});

test("mod files: representation mods have no file form (they are code)", () => {
  assert.throws(() => serializeMod(rainbow), /only analysis mods serialize/);
});

test("mod files: every malformed shape is a reported skip, never a throw", () => {
  const bad: [string, RegExp][] = [
    ["def compute(data, t):\n    pass\n", /magic first line/],
    [`${MOD_FILE_MAGIC}\n# kind: analysis\n# produces: per-frame-series\n\ndef compute(d, t):\n    pass\n`, /invalid or missing name/],
    [`${MOD_FILE_MAGIC}\n# name: Bad Name!\n# kind: analysis\n# produces: per-frame-series\n\ndef compute(d, t):\n    pass\n`, /invalid or missing name/],
    [`${MOD_FILE_MAGIC}\n# name: x\n# kind: representation\n# produces: per-frame-series\n\ndef compute(d, t):\n    pass\n`, /kind must be "analysis"/],
    [`${MOD_FILE_MAGIC}\n# name: x\n# kind: analysis\n# produces: histogram\n\ndef compute(d, t):\n    pass\n`, /produces must be/],
    [`${MOD_FILE_MAGIC}\n# name: x\n# kind: analysis\n# produces: per-point-scalar\n\ndef compute(d, t):\n    pass\n`, /need axis/],
    [`${MOD_FILE_MAGIC}\n# name: x\n# kind: analysis\n# produces: per-frame-series\n# axis: color\n\ndef compute(d, t):\n    pass\n`, /axis is only valid/],
    [`${MOD_FILE_MAGIC}\n# name: x\n# kind: analysis\n# produces: per-frame-series\n\nprint('no compute here')\n`, /must define compute/],
  ];
  for (const [text, want] of bad) {
    const r = parseModFile(text, "workspace");
    assert.ok(!r.ok, text.slice(0, 40));
    if (!r.ok) assert.match(r.error, want, text.slice(0, 60));
  }
});

test("validateModValues: the FAIL-CLOSED matrix — any violation binds nothing", () => {
  const perPoint = { produces: "per-point-scalar" as const, targetCount: 3, frameCount: 150 };
  const series = { produces: "per-frame-series" as const, targetCount: 3, frameCount: 4 };
  // the good paths
  assert.deepEqual(validateModValues([0, 0.5, 1], perPoint), { ok: true, values: [0, 0.5, 1] });
  assert.deepEqual(validateModValues([9, -2, 0.5, 1e6], series), { ok: true, values: [9, -2, 0.5, 1e6] },
    "series values are RAW — any finite magnitude");
  // every violation
  const cases: [unknown, typeof perPoint | typeof series, RegExp][] = [
    ["nope", perPoint, /not a list/],
    [{ 0: 1 }, perPoint, /not a list/],
    [[0, 0.5], perPoint, /returned 2 values — expected exactly 3 \(one per target index\)/],
    [[0, 0.5, 1, 1], perPoint, /expected exactly 3/],
    [[0, 0.5, 1], series, /expected exactly 4 \(one per frame\)/],
    [[0, Number.NaN, 1], perPoint, /non-finite value at \[1\]/],
    [[0, Infinity, 1], perPoint, /non-finite/],
    [[0, "x", 1], perPoint, /non-finite value at \[1\]/],
    [[0, 1.5, 1], perPoint, /must be in \[0,1\] — got 1.5 at \[1\]/],
    [[-0.1, 0.5, 1], perPoint, /must be in \[0,1\]/],
  ];
  for (const [values, expect, want] of cases) {
    const r = validateModValues(values, expect);
    assert.ok(!r.ok, JSON.stringify(values));
    if (!r.ok) assert.match(r.error, want, JSON.stringify(values));
  }
});

test("validateModValues: the commands return — a flat list of NON-EMPTY strings", () => {
  const cmds = { produces: "commands" as const, targetCount: 3, frameCount: 10 };
  // good: a list of non-empty command strings
  assert.deepEqual(
    validateModValues(["colorbonds alpha red", "hide beta"], cmds),
    { ok: true, commands: ["colorbonds alpha red", "hide beta"] });
  assert.deepEqual(validateModValues([], cmds), { ok: true, commands: [] }, "empty list = no commands");
  // fail-closed matrix
  const bad: [unknown, RegExp][] = [
    ["colorbonds alpha red", /must return a list/],          // a bare string, not a list
    [{ 0: "x" }, /must return a list/],                       // a dict
    [42, /must return a list/],
    [["ok", 3, "ok"], /commands\[1\] is not a string/],      // a non-string element
    [["ok", "", "ok"], /commands\[1\] is an empty string/],  // an empty string
    [["  ", "ok"], /commands\[0\] is an empty string/],       // whitespace-only
  ];
  for (const [values, want] of bad) {
    const r = validateModValues(values, cmds);
    assert.ok(!r.ok, JSON.stringify(values));
    if (!r.ok) assert.match(r.error, want, JSON.stringify(values));
  }
});

test("validateModValues: the scatter dict return — good paths and the full fail matrix", () => {
  const expect = { produces: "scatter" as const, targetCount: 3, frameCount: 10 };
  const good = validateModValues(
    { x: [1, 2], y: [3, 4], frames: [0, 9], xLabel: "a", yLabel: "b" }, expect);
  assert.deepEqual(good,
    { ok: true, scatter: { x: [1, 2], y: [3, 4], frames: [0, 9], xLabel: "a", yLabel: "b" } });
  assert.deepEqual(validateModValues({ x: [1], y: [2] }, expect),
    { ok: true, scatter: { x: [1], y: [2] } }, "frames and labels are optional");
  const bad: [unknown, RegExp][] = [
    [[1, 2, 3], /must return a dict/],
    ["nope", /must return a dict/],
    [{ x: [1, 2] }, /x and y must be lists of finite numbers/],
    [{ x: [1], y: [Number.NaN] }, /finite/],
    [{ x: [], y: [] }, /empty — nothing to draw/],
    [{ x: [1, 2], y: [1] }, /equal length \(got 2 vs 1\)/],
    [{ x: [1], y: [1], frames: [0, 1] }, /frames must match x\/y length/],
    [{ x: [1], y: [1], frames: [10] }, /integer frame indices in \[0, 9\] — got 10/],
    [{ x: [1], y: [1], frames: [0.5] }, /integer frame indices/],
    [{ x: [1], y: [1], frames: [-1] }, /integer frame indices/],
  ];
  for (const [values, want] of bad) {
    const r = validateModValues(values, expect);
    assert.ok(!r.ok, JSON.stringify(values));
    if (!r.ok) assert.match(r.error, want, JSON.stringify(values));
  }
  // the flat-list kinds are UNCHANGED by the widening
  assert.ok(!validateModValues({ x: [1], y: [1] },
    { produces: "per-frame-series", targetCount: 0, frameCount: 1 }).ok,
    "a dict is still wrong for a series");
});

test("parseModFile: produces scatter is accepted; axis on a scatter is rejected", () => {
  const ok = parseModFile(`${MOD_FILE_MAGIC}
# name: xy
# kind: analysis
# produces: scatter

def compute(data, target_indices):
    return {"x": [1.0], "y": [1.0]}
`, "workspace");
  assert.ok(ok.ok && ok.mod.produces === "scatter", JSON.stringify(ok));
  const bad = parseModFile(`${MOD_FILE_MAGIC}
# name: xy
# kind: analysis
# produces: scatter
# axis: color

def compute(data, target_indices):
    return {}
`, "workspace");
  assert.ok(!bad.ok);
  if (!bad.ok) assert.match(bad.error, /axis is only valid on per-point-scalar/);
});

test("resolveModSelector: names, + unions, all (workspace only), the three buckets", () => {
  const mods: AnalysisMod[] = [
    { name: "aa_mod", kind: "analysis", produces: "per-frame-series", code: "def compute(d,t):\n pass", origin: "workspace" },
    { name: "bb_mod", kind: "analysis", produces: "per-frame-series", code: "def compute(d,t):\n pass", origin: "workspace" },
  ];
  const pool = [rainbow, ...mods];
  assert.deepEqual(resolveModSelector("aa_mod", pool),
    { workspace: ["aa_mod"], builtins: [], nomatch: [] }, "bare name");
  assert.deepEqual(resolveModSelector("aa_mod + bb_mod", pool),
    { workspace: ["aa_mod", "bb_mod"], builtins: [], nomatch: [] }, "+ union");
  assert.deepEqual(resolveModSelector("all", pool),
    { workspace: ["aa_mod", "bb_mod"], builtins: [], nomatch: [] },
    "all = every WORKSPACE mod — never built-ins");
  assert.deepEqual(resolveModSelector("nothere", pool),
    { workspace: [], builtins: [], nomatch: ["nothere"] }, "nomatch");
  assert.deepEqual(resolveModSelector("rainbow + aa_mod + nothere", pool),
    { workspace: ["aa_mod"], builtins: ["rainbow"], nomatch: ["nothere"] },
    "a mixed selector fills all three buckets");
  const deduped = resolveModSelector("aa_mod + aa_mod + all", pool);
  assert.ok(!("error" in deduped));
  if (!("error" in deduped)) {
    assert.deepEqual(deduped.workspace, ["aa_mod", "bb_mod"], "deduped, selector order first");
  }
  assert.deepEqual(resolveModSelector("aa_mod + ", pool),
    { error: "empty term in the mod selector — rm <name> [+ <name>…] or rm all" });
});

test("unregisterRecipe removes a mod from the registry (and only that mod)", () => {
  registerRecipe({
    name: "zz_doomed", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "workspace",
  });
  assert.ok(getRecipe("zz_doomed"));
  assert.equal(unregisterRecipe("zz_doomed"), true);
  assert.equal(getRecipe("zz_doomed"), undefined);
  assert.ok(getRecipe("rainbow"), "neighbors untouched");
  assert.equal(unregisterRecipe("zz_doomed"), false, "second delete is a no-op");
});

// -- Brief #10a: MOD_PRODUCES / MOD_AXES as the single source ------------------
test("MOD_PRODUCES is exactly the six supported kinds, and parseModFile validates against it", () => {
  assert.deepEqual([...MOD_PRODUCES].sort(),
    ["channel", "commands", "figure", "per-frame-series", "per-point-scalar", "scatter"].sort());
  // EVERY supported produces value parses (with axis where required)
  for (const p of MOD_PRODUCES) {
    const axisLine = p === "per-point-scalar" ? "# axis: color\n" : "";
    const file = `${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: ${p}\n${axisLine}\ndef compute(data, target_indices):\n    return []\n`;
    const r = parseModFile(file, "workspace");
    assert.ok(r.ok, `parseModFile must accept produces: ${p}${r.ok ? "" : " — " + r.error}`);
    if (r.ok) assert.equal(r.mod.produces, p);
  }
  // a value NOT in MOD_PRODUCES is rejected, and the message names the real set
  const bad = parseModFile(`${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: histogram\n\ndef compute(d,t): return []\n`, "workspace");
  assert.ok(!bad.ok);
  if (!bad.ok) for (const p of MOD_PRODUCES) assert.ok(bad.error.includes(p), `error should list ${p}`);
});

test("a commands mod round-trips through serialize → parse (the write_mod file path is valid)", () => {
  const mod: AnalysisMod = {
    name: "macro", kind: "analysis", produces: "commands", origin: "workspace",
    author: "Molaro assistant", description: "a saved look",
    code: 'def compute(data, target_indices):\n    return ["colorbonds alpha red"]',
  };
  const parsed = parseModFile(serializeMod(mod), "workspace");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  if (parsed.ok) {
    assert.equal(parsed.mod.produces, "commands");
    assert.equal(parsed.mod.axis, undefined, "a commands mod has no axis");
  }
});

// -- P-1: parameters — MOD_PARAM_TYPES single source, parse, resolve, round-trip --

test("MOD_PARAM_TYPES is exactly the three scalar types, and parseParamLine validates against it", () => {
  assert.deepEqual([...MOD_PARAM_TYPES].sort(), ["boolean", "number", "string"].sort());
  for (const t of MOD_PARAM_TYPES) {
    const r = parseParamLine(`p ${t}`);
    assert.ok(r.ok, `type ${t} must parse${r.ok ? "" : " — " + r.error}`);
    if (r.ok) assert.equal(r.param.type, t);
  }
  // a type NOT in the set is rejected and the message names the real set
  const bad = parseParamLine("p complex");
  assert.ok(!bad.ok);
  if (!bad.ok) for (const t of MOD_PARAM_TYPES) assert.ok(bad.error.includes(t), `error should list ${t}`);
});

test("parseParamLine: name/type/default, required vs optional, malformed, default coercion", () => {
  assert.deepEqual(parseParamLine("radius number 0.8"), { ok: true, param: { name: "radius", type: "number", default: 0.8 } });
  assert.deepEqual(parseParamLine("invert boolean false"), { ok: true, param: { name: "invert", type: "boolean", default: false } });
  assert.deepEqual(parseParamLine("label string a few words"), { ok: true, param: { name: "label", type: "string", default: "a few words" } },
    "a string default keeps its spaces (rest of line)");
  assert.deepEqual(parseParamLine("floor number"), { ok: true, param: { name: "floor", type: "number" } },
    "no default → required (no default key)");
  // malformed / bad name / bad default
  assert.ok(!parseParamLine("onlyname").ok, "a lone token is malformed (no type)");
  assert.match((parseParamLine("Bad number") as { error: string }).error, /invalid parameter name/);
  assert.match((parseParamLine("x number abc") as { error: string }).error, /default expects a number/);
  assert.match((parseParamLine("b boolean maybe") as { error: string }).error, /default expects true or false/);
});

test("resolveParameters: fill defaults, coerce strings and natives, reject unknown/missing/wrong-type", () => {
  const schema: ModParam[] = [
    { name: "floor", type: "number", default: 0.5 },
    { name: "label", type: "string" }, // required
    { name: "invert", type: "boolean", default: false },
  ];
  // string inputs (terminal path) coerce to the declared types; defaults fill
  const a = resolveParameters(schema, new Map<string, unknown>([["floor", "0.8"], ["label", "hi there"]]));
  assert.deepEqual(a, { ok: true, values: { floor: 0.8, label: "hi there", invert: false } });
  // native inputs (assistant path) validate as-is
  const b = resolveParameters(schema, new Map<string, unknown>([["floor", 2], ["label", "x"], ["invert", true]]));
  assert.deepEqual(b, { ok: true, values: { floor: 2, label: "x", invert: true } });
  // a required parameter with no default and none passed → error by name
  assert.match((resolveParameters(schema, new Map()) as { error: string }).error, /missing required parameter "label"/);
  // an unknown parameter → error naming the declared set
  assert.match((resolveParameters(schema, new Map<string, unknown>([["label", "x"], ["nope", "1"]])) as { error: string }).error,
    /unknown parameter "nope"/);
  // a wrong-typed value → error by name
  assert.match((resolveParameters(schema, new Map<string, unknown>([["floor", "big"], ["label", "x"]])) as { error: string }).error,
    /parameter "floor" expects a number/);
  // a paramless mod: passing anything is "unknown"; passing nothing is ok/empty
  assert.deepEqual(resolveParameters([], new Map()), { ok: true, values: {} });
  assert.match((resolveParameters([], new Map<string, unknown>([["x", "1"]])) as { error: string }).error, /this mod declares no parameters/);
});

test("resolveParameters: number coercion is decimal/scientific only; a double-quote is refused", () => {
  const num: ModParam[] = [{ name: "n", type: "number" }];
  const str: ModParam[] = [{ name: "s", type: "string" }];
  const okNum = (v: string) => resolveParameters(num, new Map<string, unknown>([["n", v]]));
  const badNum = (v: string) => resolveParameters(num, new Map<string, unknown>([["n", v]]));
  // accepted decimal / signed / scientific forms
  for (const v of ["5", "  5  ", "-2.5", "+3", ".5", "1e3", "2.5e-2"]) {
    const r = okNum(v);
    assert.ok(r.ok, `"${v}" should parse as a number${r.ok ? "" : " — " + r.error}`);
  }
  // rejected: hex / infinity / thousands-comma / empty / non-numeric
  for (const v of ["0x1f", "Infinity", "NaN", "5,000", "1,2", "", "  ", "abc"]) {
    assert.ok(!badNum(v).ok, `"${v}" must NOT parse as a number`);
  }
  // a double-quote in a string value is refused uniformly (it can't round-trip
  // through the invocation grammar) — the same rule preview and execution share
  assert.match((resolveParameters(str, new Map<string, unknown>([["s", 'a"b']])) as { error: string }).error,
    /cannot contain a double-quote/);
  // a non-scalar native for a string slot is refused (not stringified to garbage)
  assert.match((resolveParameters(str, new Map<string, unknown>([["s", null]])) as { error: string }).error,
    /parameter "s" expects a string/);
});

test("mod files: params round-trip through serialize → parse, header order preserved", () => {
  const mod: AnalysisMod = {
    name: "paramized", kind: "analysis", produces: "per-frame-series", origin: "workspace",
    params: [
      { name: "floor", type: "number", default: 0.5 },
      { name: "label", type: "string" },
      { name: "invert", type: "boolean", default: true },
    ],
    code: "def compute(data, target_indices, params):\n    return [1.0]",
  };
  const back = parseModFile(serializeMod(mod), "workspace");
  assert.ok(back.ok, back.ok ? "" : back.error);
  if (back.ok) assert.deepEqual(back.mod, mod);
});

test("parseModFile: repeated # param: lines are COLLECTED (not overwritten), duplicates rejected", () => {
  const file = `${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: per-frame-series\n` +
    `# param: a number 1\n# param: b string\n# param: c boolean false\n\ndef compute(data, target_indices, params):\n    return []\n`;
  const r = parseModFile(file, "workspace");
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (r.ok) assert.deepEqual(r.mod.params?.map((p) => p.name), ["a", "b", "c"], "all three survive, in order");
  const dup = parseModFile(`${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: per-frame-series\n# param: a number\n# param: a string\n\ndef compute(d,t,p): return []\n`, "workspace");
  assert.ok(!dup.ok);
  if (!dup.ok) assert.match(dup.error, /duplicate parameter "a"/);
});
