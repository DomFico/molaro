/**
 * Unit tests for the style registry — shading parameter sets as DATA.
 *
 * The load-bearing pin: STANDARD_STYLE must equal, number for number, the
 * constants the shared shading chunk carried before styles existed — that
 * identity is what makes "default style selected" byte-identical to the
 * pre-style picture (the E2E fast lane proves the pixels; this proves the
 * numbers).
 *
 * Run from viewer/:  node --test tests/styles.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MATTE_STYLE,
  MAX_STYLES,
  STANDARD_STYLE,
  getStyle,
  listStyles,
  registerStyle,
  styleIndex,
  stylesAsUniformArray,
  type Style,
} from "../webview/styles.ts";

test("THE ANCHOR: the standard style is the former hardcoded constants, exactly", () => {
  assert.equal(STANDARD_STYLE.name, "standard");
  assert.equal(STANDARD_STYLE.lambertFloor, 0.55);
  assert.equal(STANDARD_STYLE.lambertScale, 0.45);
  assert.equal(STANDARD_STYLE.specStrength, 0.35);
  assert.equal(STANDARD_STYLE.specPower, 48);
});

test("a style is data, never code: every field is a finite number (or the name)", () => {
  for (const s of listStyles()) {
    assert.equal(typeof s.name, "string");
    for (const [k, v] of Object.entries(s)) {
      if (k === "name") continue;
      assert.equal(typeof v, "number", `${s.name}.${k} must be a number`);
      assert.ok(Number.isFinite(v as number), `${s.name}.${k} must be finite`);
    }
  }
});

test("the registry: both built-ins registered, lookup by name, registration order", () => {
  assert.equal(getStyle("standard"), STANDARD_STYLE);
  assert.equal(getStyle("matte"), MATTE_STYLE);
  assert.equal(getStyle("nope"), undefined);
  const names = listStyles().map((s) => s.name);
  assert.deepEqual(names.slice(0, 2), ["standard", "matte"]);
});

test("matte differs from standard ONLY in the specular strength", () => {
  assert.equal(MATTE_STYLE.specStrength, 0);
  assert.equal(MATTE_STYLE.lambertFloor, STANDARD_STYLE.lambertFloor);
  assert.equal(MATTE_STYLE.lambertScale, STANDARD_STYLE.lambertScale);
  assert.equal(MATTE_STYLE.specPower, STANDARD_STYLE.specPower);
});

test("register replaces by name (the mod-registry discipline)", () => {
  const custom: Style = { name: "zz_test", lambertFloor: 0.5, lambertScale: 0.5, specStrength: 0.1, specPower: 8 };
  registerStyle(custom);
  assert.equal(getStyle("zz_test"), custom);
  const replaced: Style = { ...custom, specStrength: 0.2 };
  registerStyle(replaced);
  assert.equal(getStyle("zz_test"), replaced);
});

test("A-2: the registry packs for the shader — index = registration order, capacity fails closed", () => {
  assert.equal(styleIndex("standard"), 0, "standard is index 0 — the buffers' default");
  assert.equal(styleIndex("matte"), 1);
  assert.equal(styleIndex("nope"), -1);
  const arr = stylesAsUniformArray();
  assert.equal(arr.length, MAX_STYLES * 4);
  assert.deepEqual([...arr.slice(0, 4)], [0.55, 0.45, 0.35, 48].map(Math.fround),
    "vec4[0] = standard exactly (float32)");
  assert.deepEqual([...arr.slice(4, 8)], [0.55, 0.45, 0, 48].map(Math.fround),
    "vec4[1] = matte exactly (float32)");
  assert.equal(arr[listStyles().length * 4], 0, "past the registry: zero-padded");
  // capacity: registering beyond MAX_STYLES throws (fail closed, no silent
  // truncation of the uniform array); re-registering an EXISTING name is
  // fine at capacity (it replaces, not grows)
  // NOTE: fillers stay registered for the remainder of THIS file's process —
  // this test is therefore deliberately LAST in the file.
  for (let i = listStyles().length; i < MAX_STYLES; i++) {
    registerStyle({ name: "filler-" + i, lambertFloor: 0, lambertScale: 1, specStrength: 0, specPower: 1 });
  }
  assert.throws(
    () => registerStyle({ name: "overflow", lambertFloor: 0, lambertScale: 1, specStrength: 0, specPower: 1 }),
    /style registry is full/,
  );
  // re-registering an EXISTING name at capacity is fine (replace, not grow)
  registerStyle({ ...STANDARD_STYLE });
});
