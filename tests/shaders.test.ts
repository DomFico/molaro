/**
 * Unit tests for the impostor shader sources — the single-sourcing
 * guarantees that keep the base pass and the overlays from disagreeing
 * about how a stored size value becomes pixels.
 *
 * Run from viewer/:  node --test tests/shaders.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IMPOSTOR_DEPTH_DEFINE,
  IMPOSTOR_SHADE_CHUNK,
  IMPOSTOR_SIZING_CHUNK,
  edgeTubeShaders,
  focusFlashShaders,
  highlightShaders,
  pointShaders,
  traceTubeShaders,
} from "../webview/shaders.ts";

const ALL_VERTEX = {
  points: pointShaders().vertex,
  highlight: highlightShaders().vertex,
  focusFlash: focusFlashShaders().vertex,
};

test("every sprite-sizing vertex shader embeds THE shared sizing chunk exactly once", () => {
  for (const [name, src] of Object.entries(ALL_VERTEX)) {
    const hits = src.split(IMPOSTOR_SIZING_CHUNK).length - 1;
    assert.equal(hits, 1, `${name} must embed IMPOSTOR_SIZING_CHUNK exactly once`);
  }
});

test("the chunk declares both shared uniforms and the one projection function", () => {
  assert.match(IMPOSTOR_SIZING_CHUNK, /uniform float uWorldPerSize;/);
  assert.match(IMPOSTOR_SIZING_CHUNK, /uniform float uPxPerWorld;/);
  assert.match(IMPOSTOR_SIZING_CHUNK, /float impostorDiameterPx\(/);
});

test("every consumer derives radius as uWorldPerSize * aSize — no local scale factor", () => {
  for (const [name, src] of Object.entries(ALL_VERTEX)) {
    assert.match(src, /uWorldPerSize \* aSize/, `${name} radius formula`);
    assert.doesNotMatch(src, /uPixelRatio|uSize\b/, `${name} must not carry legacy sizing`);
  }
});

test("depth variants live in ONE fragment source behind the define", () => {
  const frag = pointShaders().fragment;
  assert.match(frag, new RegExp(`#ifdef ${IMPOSTOR_DEPTH_DEFINE}`));
  assert.match(frag, /gl_FragDepth/);
  // exactly one gl_FragDepth write, inside the guarded block
  assert.equal(frag.split("gl_FragDepth").length - 1, 1);
});

test("overlays never write depth — they are tints, not geometry", () => {
  assert.doesNotMatch(highlightShaders().fragment, /gl_FragDepth/);
  assert.doesNotMatch(focusFlashShaders().fragment, /gl_FragDepth/);
});

test("zero radius and zero alpha discard: literal zeros draw nothing", () => {
  const frag = pointShaders().fragment;
  assert.match(frag, /vRadius <= 0\.0/);
  assert.match(frag, /vOpacity <= 0\.0/);
  // overlays gate on radius in the vertex stage
  assert.match(highlightShaders().vertex, /radius > 0\.0/);
  assert.match(focusFlashShaders().vertex, /radius > 0\.0/);
});

// -- edge tube pass (increment B) --------------------------------------------

test("edge tube: radius derives from THE shared k uniform, no local scale", () => {
  const v = edgeTubeShaders().vertex;
  assert.match(v, /uniform float uWorldPerSize;/);
  assert.match(v, /uWorldPerSize \* iRadius/);
  assert.doesNotMatch(v, /uPixelRatio|uSize\b/);
});

test("edge tube: ONE depth write behind the same define; same uProjZ row", () => {
  const f = edgeTubeShaders().fragment;
  assert.match(f, new RegExp(`#ifdef ${IMPOSTOR_DEPTH_DEFINE}`));
  assert.equal(f.split("gl_FragDepth").length - 1, 1);
  assert.match(f, /uProjZ/);
});

test("edge tube: collapsed instances leave the clip volume; zero alpha discards", () => {
  const { vertex, fragment } = edgeTubeShaders();
  assert.match(vertex, /iVisible < 0\.5 \|\| radius <= 0\.0/);
  assert.match(fragment, /vColor\.a <= 0\.0/);
});

// -- the junction trim (B′ §2) ------------------------------------------------

test("junction: the analytic trim formula and endpoint sizes are in the vertex stage", () => {
  const v = edgeTubeShaders().vertex;
  assert.match(v, /attribute float iSizeA; attribute float iSizeB;/);
  assert.match(v, /sqrt\(max\(0\.0, rsA \* rsA - radius \* radius\)\)/);
  assert.match(v, /dA \+ dB >= len/, "a swallowed tube collapses");
  // the quad extends ONE RADIUS past each trimmed end — the fragment shader,
  // not the quad boundary, decides where the tube ends
  assert.match(v, /dA - radius/);
  assert.match(v, /len - dB \+ radius/);
});

test("junction: covered ends discard, exposed ends grow a hemispherical cap", () => {
  const f = edgeTubeShaders().fragment;
  assert.match(f, />= vRadius\) discard/, "sphere >= tube: the sphere owns the end zone");
  assert.match(f, /q2 > 1\.0\) discard/, "outside the cap silhouette");
  assert.match(f, /sqrt\(1\.0 - q2\)/, "cap shades as a sphere");
  // still exactly ONE depth write, shared by wall and cap, behind the define
  assert.equal(f.split("gl_FragDepth").length - 1, 1);
});

// -- trace tube pass (the path-tube generator) ---------------------------------

test("trace tube: PER-END radii derive from THE shared k uniform, no local scale", () => {
  const v = traceTubeShaders().vertex;
  assert.match(v, /uniform float uWorldPerSize;/);
  assert.match(v, /uWorldPerSize \* iRadiusA/);
  assert.match(v, /uWorldPerSize \* iRadiusB/);
  assert.doesNotMatch(v, /uPixelRatio|uSize\b/);
});

test("trace tube: ONE depth write behind the same define; same uProjZ row", () => {
  const f = traceTubeShaders().fragment;
  assert.match(f, new RegExp(`#ifdef ${IMPOSTOR_DEPTH_DEFINE}`));
  assert.equal(f.split("gl_FragDepth").length - 1, 1);
  assert.match(f, /uProjZ/);
});

test("trace tube: collapsed instances leave the clip volume; literal zeros discard", () => {
  const { vertex, fragment } = traceTubeShaders();
  assert.match(vertex, /iVisible < 0\.5 \|\| len \* len < 1e-16 \|\| max\(rA, rB\) <= 0\.0/);
  assert.match(fragment, /vColor\.a <= 0\.0 \|\| vRadius <= 0\.0/);
});

test("trace tube: NO trim/extension/cap machinery — the joint sphere owns the ends", () => {
  const { vertex, fragment } = traceTubeShaders();
  // no endpoint-size attributes, no trim distance, no quad extension, no cap zone
  assert.doesNotMatch(vertex, /iSizeA|iSizeB|dA|dB/);
  assert.doesNotMatch(fragment, /vDA|vDB|q2|startEnd/);
});

test("trace tube: per-end RGBA varies — the along-segment gradient is interpolation", () => {
  const v = traceTubeShaders().vertex;
  assert.match(v, /attribute vec4 iColorA; attribute vec4 iColorB;/);
  assert.match(v, /vColor = atB \? iColorB : iColorA;/);
});

// -- the shared shading chunk (B′ §3) -----------------------------------------

test("shading is single-sourced: every geometry fragment embeds THE shade chunk, no local formula", () => {
  const pf = pointShaders().fragment;
  const ef = edgeTubeShaders().fragment;
  const tf = traceTubeShaders().fragment;
  assert.equal(pf.split(IMPOSTOR_SHADE_CHUNK).length - 1, 1, "point fragment embeds the chunk once");
  assert.equal(ef.split(IMPOSTOR_SHADE_CHUNK).length - 1, 1, "edge fragment embeds the chunk once");
  assert.equal(tf.split(IMPOSTOR_SHADE_CHUNK).length - 1, 1, "trace fragment embeds the chunk once");
  assert.match(pf, /impostorShade\(vColor, nz\)/);
  assert.match(ef, /impostorShade\(vColor\.rgb, nz\)/);
  assert.match(tf, /impostorShade\(vColor\.rgb, nz\)/);
  // The shading NUMBERS are style uniforms now (webview/styles.ts) — no
  // fragment may carry a hardcoded lambert/specular constant; the chunk
  // declares each of the four style uniforms exactly once.
  for (const u of ["uLambertFloor", "uLambertScale", "uSpecStrength", "uSpecPower"]) {
    assert.equal(
      IMPOSTOR_SHADE_CHUNK.split(`uniform float ${u};`).length - 1, 1,
      `chunk declares ${u} once`,
    );
  }
  for (const [name, src] of [["point", pf], ["edge", ef], ["trace", tf]] as const) {
    assert.doesNotMatch(src, /0\.55|0\.45 \* nz|0\.35 \* pow/,
      `${name}: no hardcoded shading constants outside the style`);
  }
});

test("the highlight is restrained: one specular term, no second light, overlays untouched", () => {
  assert.match(IMPOSTOR_SHADE_CHUNK, /uSpecStrength \* pow\(max\(nz, 0\.0\), uSpecPower\)/);
  assert.doesNotMatch(highlightShaders().fragment, /impostorShade|pow\(/);
  assert.doesNotMatch(focusFlashShaders().fragment, /impostorShade|pow\(/);
});
