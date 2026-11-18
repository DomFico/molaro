/** toon style packing + outline option parsing (the drawing is e2e). */
import assert from "node:assert";
import test from "node:test";

import { getStyle, styleIndex, stylesAsUniformArray, TOON_STYLE } from "../webview/styles.ts";
import { OUTLINE_DEFAULT_WIDTH, parseOutlineArgs } from "../webview/outline.ts";
import { IMPOSTOR_SHADE_CHUNK } from "../webview/shaders.ts";

test("toon is registered after matte/standard and packs its band count as a negative power", () => {
  assert.equal(styleIndex("matte"), 0, "matte stays the default (index 0)");
  assert.equal(styleIndex("standard"), 1);
  const i = styleIndex("toon");
  assert.equal(i, 2);
  assert.deepEqual(getStyle("toon"), TOON_STYLE);
  const u = stylesAsUniformArray();
  assert.equal(u[i * 4 + 3], -3);
  assert.ok(u[3] > 0 && u[7] > 0, "non-toon styles keep a positive power (the original branch)");
});

test("the shade chunk branches on the sign and keeps the original formula otherwise", () => {
  assert.match(IMPOSTOR_SHADE_CHUNK, /if \(vStyleParams\.w < 0\.0\)/);
  assert.match(IMPOSTOR_SHADE_CHUNK, /float lambert = vStyleParams\.x \+ vStyleParams\.y \* nz;/);
  assert.match(IMPOSTOR_SHADE_CHUNK, /pow\(max\(nz, 0\.0\), vStyleParams\.w\)/);
});

test("parseOutlineArgs", () => {
  assert.deepEqual(parseOutlineArgs(""), { kind: "show" });
  assert.deepEqual(parseOutlineArgs("off"), { kind: "off" });
  assert.deepEqual(parseOutlineArgs("on"), { kind: "on", width: OUTLINE_DEFAULT_WIDTH, color: "#1a1a1a", detail: "medium" });
  assert.deepEqual(parseOutlineArgs("on ?width=3 ?color=navy ?detail=HIGH"), { kind: "on", width: 3, color: "navy", detail: "high" });
  assert.deepEqual(parseOutlineArgs("?width=2"), { kind: "on", width: 2, color: "#1a1a1a", detail: "medium" });
  for (const bad of ["on ?width=0", "on ?width=50", "on ?detail=max", "on ?zoom=2", "on width", "off ?width=2"]) {
    assert.equal(parseOutlineArgs(bad).kind, "error", bad);
  }
});
