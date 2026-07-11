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
  serializeMod,
  validateModValues,
  MOD_FILE_MAGIC,
  type AnalysisMod,
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
