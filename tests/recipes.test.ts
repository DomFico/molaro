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

test("registerRecipe: a name → recipe map future recipes register into", () => {
  const flat: Recipe = {
    name: "flat-test",
    axis: "point-color",
    compute: (points) => points.map(() => 0.5),
    colormap: () => [0, 0, 0],
  };
  registerRecipe(flat);
  assert.equal(getRecipe("flat-test"), flat);
});
