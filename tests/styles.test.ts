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
  STANDARD_STYLE,
  getStyle,
  listStyles,
  registerStyle,
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
