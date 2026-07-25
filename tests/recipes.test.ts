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
  channelProviders,
  resolveChannelDependency,
  parseModFile,
  parseParamLine,
  resolveEdgeGroup,
  resolveModSelector,
  resolveParameters,
  serializeMod,
  unregisterRecipe,
  validateModValues,
  EDGE_GROUP_RE,
  MOD_AXES,
  MOD_FILE_MAGIC,
  MOD_PARAM_TYPES,
  MOD_PRODUCES,
  type AnalysisMod,
  type Mod,
  type ModParam,
  type ParamValue,
} from "../webview/recipes.ts";
import { parseGroupExpr } from "../webview/address.ts";

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
  const perPoint = { produces: "per-point-scalar" as const, targetCount: 3, frameCount: 150, nPoints: 100 };
  const series = { produces: "per-frame-series" as const, targetCount: 3, frameCount: 4, nPoints: 100 };
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
  const cmds = { produces: "commands" as const, targetCount: 3, frameCount: 10, nPoints: 100 };
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
  const expect = { produces: "scatter" as const, targetCount: 3, frameCount: 10, nPoints: 100 };
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
    { produces: "per-frame-series", targetCount: 0, frameCount: 1, nPoints: 100 }).ok,
    "a dict is still wrong for a series");
});

test("validateModValues: the edges return — a list of in-range distinct integer pairs", () => {
  // nPoints is the authoritative range bound (mirrors the channel arm); the
  // dataset has 5 points here, so a valid index is 0..4.
  const expect = { produces: "edges" as const, targetCount: 0, frameCount: 10, nPoints: 5 };
  // good: a list of [i, j] integer pairs, each in range and non-self-looping
  assert.deepEqual(validateModValues([[0, 4], [1, 2]], expect),
    { ok: true, edges: [[0, 4], [1, 2]] });
  assert.deepEqual(validateModValues([], expect), { ok: true, edges: [] }, "empty list = no new edges");
  // fail-closed matrix: every violation returns nothing
  const bad: [unknown, RegExp][] = [
    ["nope", /must return a list/],                     // not a list
    [{ 0: [0, 1] }, /must return a list/],              // a dict
    [42, /must return a list/],
    [[[0, 1, 2]], /edges\[0\] must be a pair/],         // a triple, not a pair
    [[[0]], /edges\[0\] must be a pair/],               // a single
    [[3], /edges\[0\] must be a pair/],                 // a bare number, not a pair
    [[[0, 1.5]], /edges\[0\] indices must be integers/],// a non-integer index
    [[[0, "1"]], /edges\[0\] indices must be integers/],// a string index
    [[[0, true]], /edges\[0\] indices must be integers/],// a boolean index
    [[[0, 5]], /edges\[0\] index out of range \[0, 5\)/],// out of range (>= nPoints)
    [[[-1, 0]], /edges\[0\] index out of range \[0, 5\)/],// out of range (< 0)
    [[[2, 2]], /edges\[0\] is a self-loop \(2 → 2\)/],   // a self-loop
    [[[0, 1], [3, 3]], /edges\[1\] is a self-loop/],    // self-loop reported at its index
  ];
  for (const [values, want] of bad) {
    const r = validateModValues(values, expect);
    assert.ok(!r.ok, JSON.stringify(values));
    if (!r.ok) assert.match(r.error, want, JSON.stringify(values));
  }
  // the flat-list kinds are UNCHANGED: a list of pairs is still wrong for a series
  assert.ok(!validateModValues([[0, 1]],
    { produces: "per-frame-series", targetCount: 0, frameCount: 1, nPoints: 5 }).ok,
    "a list of pairs is still wrong for a series");
});

test("validateModValues: the edges {group, pairs} echo — same pair rules, the group carried through", () => {
  const expect = { produces: "edges" as const, targetCount: 0, frameCount: 10, nPoints: 5 };
  // the producer's transport wrapper: pairs validated IDENTICALLY, group carried
  assert.deepEqual(validateModValues({ group: "contacts", pairs: [[0, 4]] }, expect),
    { ok: true, edges: [[0, 4]], group: "contacts" });
  // group null (the load path's echo) = no group — the bare-list return shape
  assert.deepEqual(validateModValues({ group: null, pairs: [[0, 4]] }, expect),
    { ok: true, edges: [[0, 4]] });
  // pair violations inside the wrapper hear the SAME errors as a bare list
  const bad = validateModValues({ group: "g", pairs: [[2, 2]] }, expect);
  assert.ok(!bad.ok && /edges\[0\] is a self-loop/.test(bad.error), JSON.stringify(bad));
  const nolist = validateModValues({ group: "g", pairs: "nope" }, expect);
  assert.ok(!nolist.ok && /must return a list/.test(nolist.error), JSON.stringify(nolist));
  // a malformed group token is refused (it must survive as a command token)
  const badGroup = validateModValues({ group: "not a token", pairs: [[0, 1]] }, expect);
  assert.ok(!badGroup.ok && /group must be a single token/.test(badGroup.error), JSON.stringify(badGroup));
});

test("validateModValues: the edges per-frame visibility mask — accepted, flattened, fail-closed", () => {
  // frameCount 3, two pairs — the mask must be exactly [3][2]
  const expect = { produces: "edges" as const, targetCount: 0, frameCount: 3, nPoints: 5 };
  const good = validateModValues(
    { pairs: [[0, 1], [2, 3]], visibility: [[1, 0], [0, 1], [1, 1]] }, expect);
  assert.ok(good.ok && "edges" in good && good.visibility !== undefined, JSON.stringify(good));
  if (good.ok && "visibility" in good && good.visibility) {
    assert.ok(good.visibility instanceof Float32Array, "flattened ONCE at the boundary");
    assert.deepEqual([...good.visibility], [1, 0, 0, 1, 1, 1], "[frame * n_pairs + pair] layout");
  }
  // absent = static — no visibility key on the result (the pre-2C shape)
  const stat = validateModValues({ pairs: [[0, 1]] }, expect);
  assert.ok(stat.ok && "edges" in stat && !("visibility" in stat), JSON.stringify(stat));
  // fractional values are legal (validation pins [0,1]; the shader thresholds)
  const frac = validateModValues({ pairs: [[0, 1]], visibility: [[0.5], [0], [1]] }, expect);
  assert.ok(frac.ok, JSON.stringify(frac));
  // the fail-closed matrix: ANY violation rejects the WHOLE declaration
  const bad: [unknown, RegExp][] = [
    ["rows", /visibility must be a list of per-frame rows/],
    [[[1, 0], [0, 1]], /expected 3 rows/],                      // wrong outer (too few)
    [[[1, 0], [0, 1], [1, 1], [1, 1]], /expected 3 rows/],      // wrong outer (too many)
    [[[1], [0, 1], [1, 1]], /visibility\[0\] must have one value per pair \(2\)/], // short row
    [[[1, 0], [0, 1, 1], [1, 1]], /visibility\[1\] must have one value per pair/], // long row
    [[[1, 0], 7, [1, 1]], /visibility\[1\] must have one value per pair/],         // a non-row
    [[[1, 0], [0, NaN], [1, 1]], /visibility\[1\]\[1\] must be a finite number in \[0,1\]/],
    [[[1, 0], [0, 2], [1, 1]], /visibility\[1\]\[1\] must be a finite number in \[0,1\]/],
    [[[1, 0], [0, -0.1], [1, 1]], /visibility\[1\]\[1\] must be a finite number in \[0,1\]/],
    [[[1, 0], [0, "1"], [1, 1]], /visibility\[1\]\[1\] must be a finite number in \[0,1\]/],
  ];
  for (const [vis, want] of bad) {
    const r = validateModValues({ pairs: [[0, 1], [2, 3]], visibility: vis }, expect);
    assert.ok(!r.ok, JSON.stringify(vis));
    if (!r.ok) assert.match(r.error, want, JSON.stringify(vis));
  }
  // pair violations still reject first, mask or not (never a half validation)
  const badPair = validateModValues(
    { pairs: [[2, 2]], visibility: [[1], [1], [1]] }, expect);
  assert.ok(!badPair.ok && /self-loop/.test(badPair.error));
  // a mask over ZERO pairs is vacuous — dropped, the group is static
  const empty = validateModValues({ pairs: [], visibility: [[], [], []] }, expect);
  assert.ok(empty.ok && "edges" in empty && !("visibility" in empty), JSON.stringify(empty));
});

test("parseModFile: produces edges is accepted (no axis, no channel)", () => {
  const ok = parseModFile(`${MOD_FILE_MAGIC}
# name: link
# kind: analysis
# produces: edges

def compute(data, target_indices):
    return [[0, 1]]
`, "workspace");
  assert.ok(ok.ok && ok.mod.produces === "edges", JSON.stringify(ok));
  if (ok.ok) assert.equal(ok.mod.axis, undefined, "an edges mod has no axis");
  // axis on an edges mod is rejected (axis is per-point-scalar only)
  const bad = parseModFile(`${MOD_FILE_MAGIC}
# name: link
# kind: analysis
# produces: edges
# axis: color

def compute(data, target_indices):
    return [[0, 1]]
`, "workspace");
  assert.ok(!bad.ok && /axis is only valid/.test(bad.error), JSON.stringify(bad));
});

test("parseModFile: # edge-group: — edges mods only, token-validated, round-trips", () => {
  const src = `${MOD_FILE_MAGIC}
# name: link
# kind: analysis
# produces: edges
# edge-group: contacts

def compute(data, target_indices):
    return [[0, 1]]
`;
  const ok = parseModFile(src, "workspace");
  assert.ok(ok.ok, JSON.stringify(ok));
  if (ok.ok) {
    assert.equal(ok.mod.edgeGroup, "contacts");
    // serialize → parse round-trips the header line
    const again = parseModFile(serializeMod(ok.mod), "workspace");
    assert.ok(again.ok && again.mod.edgeGroup === "contacts", JSON.stringify(again));
  }
  // absent = undefined (the invocation defaults to the mod name — not here)
  const bare = parseModFile(`${MOD_FILE_MAGIC}
# name: link
# kind: analysis
# produces: edges

def compute(data, target_indices):
    return [[0, 1]]
`, "workspace");
  assert.ok(bare.ok && bare.mod.edgeGroup === undefined, JSON.stringify(bare));
  // a malformed token is refused at parse time — loud, before any run
  const badTok = parseModFile(src.replace("contacts", "not a token"), "workspace");
  assert.ok(!badTok.ok && /edge-group must be a single token/.test(badTok.error), JSON.stringify(badTok));
  // edge-group on a non-edges mod is dead weight — refused
  const wrongKind = parseModFile(`${MOD_FILE_MAGIC}
# name: series
# kind: analysis
# produces: per-frame-series
# edge-group: contacts

def compute(data, target_indices):
    return [0.0]
`, "workspace");
  assert.ok(!wrongKind.ok && /edge-group is only valid/.test(wrongKind.error), JSON.stringify(wrongKind));
});

test("resolveEdgeGroup: a run-time ?group overrides header/name, is token-validated, and falls back", () => {
  const mod: Pick<AnalysisMod, "edgeGroup" | "name"> = { edgeGroup: "hdr", name: "hb" };

  // FALLBACK (no ?group): the header wins, else the name — byte-identical to the
  // pre-param behavior. undefined params, empty params, and an empty-string
  // ?group all resolve the same way.
  const fallbackParams: (Record<string, ParamValue> | undefined)[] = [undefined, {}, { group: "" }];
  for (const params of fallbackParams) {
    const r = resolveEdgeGroup(mod, params);
    assert.deepEqual(r, { ok: true, group: "hdr" }, JSON.stringify(params));
  }
  // no header → the mod name is the fallback
  assert.deepEqual(resolveEdgeGroup({ name: "hb" }, undefined), { ok: true, group: "hb" });
  // a NON-string ?group (a mod could declare a numeric `group` param) is ignored
  // → fallback, never coerced into a group name
  assert.deepEqual(resolveEdgeGroup(mod, { group: 3 }), { ok: true, group: "hdr" });

  // OVERRIDE: a valid ?group token wins over BOTH header and name
  assert.deepEqual(resolveEdgeGroup(mod, { group: "alpha" }), { ok: true, group: "alpha" });
  assert.deepEqual(resolveEdgeGroup(mod, { group: "beta" }), { ok: true, group: "beta" });
  // single-token shapes that EDGE_GROUP_RE accepts
  for (const g of ["A", "a1", "con-tacts", "d_2", "Z9_-"]) {
    assert.deepEqual(resolveEdgeGroup(mod, { group: g }), { ok: true, group: g }, g);
  }

  // MALFORMED ?group: a LOUD refusal (never a silently-wrong group), and the
  // rejected set is EXACTLY what EDGE_GROUP_RE and a `%group` target reject.
  for (const bad of ["1abc", "-x", "_y", "has space", "a.b", "c/d", "e!", "%f"]) {
    const r = resolveEdgeGroup(mod, { group: bad });
    assert.ok(!r.ok && /invalid \?group/.test(r.error), `${bad}: ${JSON.stringify(r)}`);
    assert.equal(EDGE_GROUP_RE.test(bad), false, `EDGE_GROUP_RE should reject ${bad}`);
    // the SAME token rule a %group target accepts — %<bad> must NOT parse as a
    // well-formed group expr, proving one source of truth
    const g = parseGroupExpr(`%${bad}`);
    assert.ok(g !== null && "error" in g, `%${bad} should be a %group parse error: ${JSON.stringify(g)}`);
  }
  // conversely, every accepted token IS addressable as %<token>
  for (const g of ["alpha", "beta", "con-tacts", "d_2"]) {
    assert.ok(EDGE_GROUP_RE.test(g));
    assert.deepEqual(parseGroupExpr(`%${g}`), { names: [g] }, g);
  }
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
test("MOD_PRODUCES is exactly the seven supported kinds, and parseModFile validates against it", () => {
  assert.deepEqual([...MOD_PRODUCES].sort(),
    ["channel", "commands", "edges", "figure", "per-frame-series", "per-point-scalar", "scatter"].sort());
  // EVERY supported produces value parses (with axis / channel where required)
  for (const p of MOD_PRODUCES) {
    const axisLine = p === "per-point-scalar" ? "# axis: color\n" : "";
    const channelLine = p === "channel" ? "# channel: ch\n" : "";
    const file = `${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: ${p}\n${axisLine}${channelLine}\ndef compute(data, target_indices):\n    return []\n`;
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

test("MOD_PARAM_TYPES is exactly the scalar types plus color, and parseParamLine validates against it", () => {
  assert.deepEqual([...MOD_PARAM_TYPES].sort(), ["boolean", "color", "number", "string"].sort());
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

test("color param type: coerces its token to a string (a color IS a token), a default round-trips", () => {
  // a `color` value coerces to a STRING — a CSS name or hex both survive as their
  // plain token (NOT color-validated at coerce: parseColor lives in commands.ts
  // and importing it into recipes.ts would be a circular import; the command/mod
  // path validates downstream). resolveParameters is the coerce entrance.
  const schema: ModParam[] = [{ name: "c", type: "color", default: "green" }];
  // string input (terminal path): a CSS name and a hex both pass through as-is
  assert.deepEqual(resolveParameters(schema, new Map<string, unknown>([["c", "lightgreen"]])),
    { ok: true, values: { c: "lightgreen" } });
  assert.deepEqual(resolveParameters(schema, new Map<string, unknown>([["c", "#ff8800"]])),
    { ok: true, values: { c: "#ff8800" } });
  // an unrecognized token still coerces (validation is downstream, not here)
  assert.deepEqual(resolveParameters(schema, new Map<string, unknown>([["c", "notacolor"]])),
    { ok: true, values: { c: "notacolor" } });
  // default fills when nothing is passed
  assert.deepEqual(resolveParameters(schema, new Map()), { ok: true, values: { c: "green" } });
  // the `"` refusal is uniform across string-valued types (it can't round-trip)
  assert.match((resolveParameters(schema, new Map<string, unknown>([["c", 'a"b']])) as { error: string }).error,
    /cannot contain a double-quote/);
  // a color default parses/round-trips through the header format
  assert.deepEqual(parseParamLine("tint color steelblue"),
    { ok: true, param: { name: "tint", type: "color", default: "steelblue" } });
  const mod: AnalysisMod = {
    name: "tinted", kind: "analysis", produces: "per-frame-series", origin: "workspace",
    params: [{ name: "tint", type: "color", default: "steelblue" }],
    code: "def compute(data, target_indices, params):\n    return [1.0]",
  };
  const back = parseModFile(serializeMod(mod), "workspace");
  assert.ok(back.ok, back.ok ? "" : back.error);
  if (back.ok) assert.deepEqual(back.mod, mod);
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

// -- P-2: static channel name — header field, round-trip, provider index ----------

test("parseModFile: # channel is required for channel mods, forbidden otherwise, token-validated", () => {
  const chFile = (produces: string, channelLine: string) =>
    `${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: ${produces}\n${channelLine}\ndef compute(data, target_indices):\n    return {"values": [], "components": 1}\n`;
  // a valid channel mod declares its name in the header
  const ok = parseModFile(chFile("channel", "# channel: flow_dir\n"), "workspace");
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  if (ok.ok) assert.equal(ok.mod.channel, "flow_dir");
  // missing channel on a channel mod → error naming the field
  assert.match((parseModFile(chFile("channel", ""), "workspace") as { error: string }).error, /channel mod needs channel:/);
  // a non-token channel name is rejected
  assert.match((parseModFile(chFile("channel", "# channel: has space\n"), "workspace") as { error: string }).error, /single token/);
  // channel on a NON-channel mod is rejected
  assert.match(
    (parseModFile(`${MOD_FILE_MAGIC}\n# name: m\n# kind: analysis\n# produces: per-frame-series\n# channel: x\n\ndef compute(d,t): return []\n`, "workspace") as { error: string }).error,
    /channel is only valid on produces: channel/);
});

test("mod files: a channel mod round-trips serialize → parse with its declared name", () => {
  const mod: AnalysisMod = {
    name: "flow", kind: "analysis", produces: "channel", channel: "flow_dir", origin: "workspace",
    code: 'def compute(data, target_indices):\n    return {"values": [], "components": 3}',
  };
  const back = parseModFile(serializeMod(mod), "workspace");
  assert.ok(back.ok, back.ok ? "" : back.error);
  if (back.ok) assert.deepEqual(back.mod, mod);
});

test("channelProviders: maps channel name → declaring mods; a name with >1 provider is a collision", () => {
  const ch = (name: string, channel: string): Mod => ({
    name, kind: "analysis", produces: "channel", channel, origin: "workspace",
    code: "def compute(d,t,p): return {'values': [], 'components': 1}",
  });
  const providers = channelProviders([
    ch("heat_a", "heat"), ch("heat_b", "heat"), ch("flow", "flow_dir"),
    rainbow, // a representation mod contributes nothing
  ]);
  assert.deepEqual(providers.get("heat"), ["heat_a", "heat_b"], "the collision — two providers");
  assert.deepEqual(providers.get("flow_dir"), ["flow"], "a unique provider");
  const collisions = [...providers].filter(([, mods]) => mods.length > 1).map(([c]) => c);
  assert.deepEqual(collisions, ["heat"]);
});

// -- P-3: requires-channel — header field + the static dependency resolver --------

test("parseModFile: # requires-channel parses (any produces), token-validated; round-trips", () => {
  const file = (line: string) =>
    `${MOD_FILE_MAGIC}\n# name: c\n# kind: analysis\n# produces: commands\n${line}\ndef compute(data, target_indices):\n    return []\n`;
  const ok = parseModFile(file("# requires-channel: flow_dir\n"), "workspace");
  assert.ok(ok.ok, ok.ok ? "" : ok.error);
  if (ok.ok) assert.equal(ok.mod.requiresChannel, "flow_dir");
  assert.match((parseModFile(file("# requires-channel: has space\n"), "workspace") as { error: string }).error, /single token/);
  // round-trip
  const mod: AnalysisMod = {
    name: "c", kind: "analysis", produces: "commands", requiresChannel: "flow_dir",
    origin: "workspace", code: "def compute(data, target_indices):\n    return []",
  };
  const back = parseModFile(serializeMod(mod), "workspace");
  assert.ok(back.ok, back.ok ? "" : back.error);
  if (back.ok) assert.deepEqual(back.mod, mod);
});

test("resolveChannelDependency: direct / provider / missing / ambiguous / self / one-level", () => {
  const provider = (name: string, channel: string, requires?: string): AnalysisMod => ({
    name, kind: "analysis", produces: "channel", channel, origin: "workspace",
    ...(requires ? { requiresChannel: requires } : {}),
    code: "def compute(d,t): return {'values': [], 'components': 1}",
  });
  const consumer = (name: string, requires?: string): AnalysisMod => ({
    name, kind: "analysis", produces: "commands", origin: "workspace",
    ...(requires ? { requiresChannel: requires } : {}),
    code: "def compute(d,t): return []",
  });
  const flow = provider("flow", "flow_dir");
  // no requirement → direct
  assert.deepEqual(resolveChannelDependency(consumer("plain"), [flow]), { direct: true });
  // one provider → run it first
  assert.deepEqual(resolveChannelDependency(consumer("needs", "flow_dir"), [flow, consumer("needs", "flow_dir")]), { provider: "flow" });
  // no provider → error naming the channel
  assert.match((resolveChannelDependency(consumer("needs", "ghost"), [flow]) as { error: string }).error, /no registered mod declares it/);
  // two providers → ambiguous
  assert.match((resolveChannelDependency(consumer("needs", "flow_dir"), [flow, provider("flow2", "flow_dir")]) as { error: string }).error, /ambiguous provider/);
  // a channel mod requiring its OWN channel → refused
  const selfch = provider("selfch", "s", "s");
  assert.match((resolveChannelDependency(selfch, [selfch]) as { error: string }).error, /cannot require its own channel/);
  // provider that ITSELF requires a channel → one level only
  const deepProvider = provider("deep", "d", "flow_dir");
  assert.match((resolveChannelDependency(consumer("needs", "d"), [flow, deepProvider]) as { error: string }).error, /one level only/);
  // a self-requirement WITH a co-provider → self error, NOT "ambiguous" (order-independent)
  const selfco = provider("selfco", "s", "s");
  const other = provider("other", "s");
  assert.match((resolveChannelDependency(selfco, [selfco, other]) as { error: string }).error, /cannot require its own channel/);
  assert.match((resolveChannelDependency(selfco, [other, selfco]) as { error: string }).error, /cannot require its own channel/);
  // a provider that needs a REQUIRED parameter can't be auto-run → refused
  const paramProvider: AnalysisMod = { ...provider("pp", "p"), params: [{ name: "k", type: "number" }] };
  assert.match((resolveChannelDependency(consumer("needs", "p"), [paramProvider, consumer("needs", "p")]) as { error: string }).error, /needs required parameters/);
  // …but a provider whose params all have DEFAULTS is fine (auto-runnable)
  const okProvider: AnalysisMod = { ...provider("okp", "q"), params: [{ name: "k", type: "number", default: 1 }] };
  assert.deepEqual(resolveChannelDependency(consumer("needs", "q"), [okProvider, consumer("needs", "q")]), { provider: "okp" });
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
