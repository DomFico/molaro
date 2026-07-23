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
  ALPHA_PASS_CHUNK,
  DASH_DUTY,
  DASH_SCALE,
  IMPOSTOR_DEPTH_DEFINE,
  IMPOSTOR_SHADE_CHUNK,
  STYLE_VERTEX_CHUNK,
  IMPOSTOR_SIZING_CHUNK,
  edgeTubeShaders,
  focusFlashShaders,
  highlightShaders,
  pointShaders,
  ribbonShaders,
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
  assert.match(fragment, /col\.a <= 0\.0/);
});

// -- the bicolor pair (per-endpoint edge color) --------------------------------

test("edge tube: declares the per-end color PAIR and mixes by the along-axis coordinate", () => {
  const { vertex, fragment } = edgeTubeShaders();
  assert.match(vertex, /attribute vec4 iColorA; attribute vec4 iColorB;/);
  assert.match(vertex, /vColorA = iColorA; vColorB = iColorB;/);
  // the ONE split rule: s = clamp(vT/vLen, 0, 1) picks the half — the same
  // world coordinate the depth interpolation rides, so caps and trim zones
  // take their end's color whole and equal halves collapse (mix(a,a,s)==a)
  assert.match(fragment, /float s = clamp\(vT \/ vLen, 0\.0, 1\.0\);/);
  assert.match(fragment, /vec4 col = mix\(vColorA, vColorB, s\);/);
  // no residual single-color plumbing anywhere in the pass
  assert.doesNotMatch(vertex, /\biColor\b|\bvColor\b/);
  assert.doesNotMatch(fragment, /\bvColor\b/);
  // still exactly ONE depth write behind the define (the bicolor split adds none)
  assert.equal(fragment.split("gl_FragDepth").length - 1, 1);
});

test("edge tube: the collapse classifies by the DIMMEST end, like every two-ended pass", () => {
  assert.match(edgeTubeShaders().vertex, /inAlphaPass\(min\(iColorA\.a, iColorB\.a\)\)/);
});

// -- the dash primitive (per-edge solid/dashed) --------------------------------

test("edge tube: the dash block is GUARDED (0 = solid skips it — byte-identical)", () => {
  const { vertex, fragment } = edgeTubeShaders();
  assert.match(vertex, /attribute float iDash;/);
  // the dash unit is anchored to k in the VERTEX stage, so the fragment's
  // period is a plain world length (zoom- and dataset-scale-stable)
  assert.match(vertex, /vDash = iDash \* uWorldPerSize;/);
  assert.match(fragment, /if \(vDash > 0\.0\) \{/);
  assert.match(fragment, /fract\(vT \/ period\)/);
  // the pattern is a discard — never a color change, never a depth write
  const block = fragment.slice(fragment.indexOf("if (vDash > 0.0)"));
  assert.match(block.slice(0, 220), /discard;/);
  assert.equal(fragment.split("gl_FragDepth").length - 1, 1,
    "still exactly one depth write — the dash adds none");
  // period and duty are THE module constants, not shader-local numbers
  assert.match(fragment, new RegExp(`vDash \\* ${DASH_SCALE.toFixed(1).replace(".", "\\.")}`));
  assert.match(fragment, new RegExp(`> ${DASH_DUTY.toFixed(2).replace(".", "\\.")}\\) discard`));
  assert.ok(DASH_DUTY > 0 && DASH_DUTY < 1, "duty is a fraction of the period");
  assert.ok(DASH_SCALE > 0);
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
  assert.match(ef, /impostorShade\(col\.rgb, nz\)/); // the mixed bicolor value
  assert.match(tf, /impostorShade\(vColor\.rgb, nz\)/);
  // The shading NUMBERS arrive per element via the style varying (A-2:
  // per-target style — the vertex stage looks up `uniform vec4 uStyles[8]`
  // by the element's style index and hands the params over as a varying).
  // No fragment may carry a hardcoded lambert/specular constant, and no
  // fragment may index the style array (GLSL ES 1.00 only guarantees
  // dynamic uniform-array indexing in the VERTEX stage).
  assert.equal(
    IMPOSTOR_SHADE_CHUNK.split("varying vec4 vStyleParams;").length - 1, 1,
    "chunk reads the style varying",
  );
  assert.doesNotMatch(IMPOSTOR_SHADE_CHUNK, /uStyles/, "fragment never indexes the style array");
  assert.equal(
    STYLE_VERTEX_CHUNK.split("uniform vec4 uStyles[8];").length - 1, 1,
    "vertex chunk declares the packed style array once",
  );
  for (const [name, src] of [["point", pf], ["edge", ef], ["trace", tf]] as const) {
    assert.doesNotMatch(src, /0\.55|0\.45 \* nz|0\.35 \* pow/,
      `${name}: no hardcoded shading constants outside the style`);
  }
  // every geometry VERTEX shader performs the lookup exactly once
  for (const [name, src] of [
    ["point", pointShaders().vertex],
    ["edge", edgeTubeShaders().vertex],
    ["trace", traceTubeShaders().vertex],
  ] as const) {
    assert.equal(src.split("vStyleParams = styleParams(").length - 1, 1,
      `${name}: one style lookup in the vertex stage`);
  }
});

test("the highlight is restrained: one specular term, no second light, overlays untouched", () => {
  assert.match(IMPOSTOR_SHADE_CHUNK, /vStyleParams\.z \* pow\(max\(nz, 0\.0\), vStyleParams\.w\)/);
  assert.doesNotMatch(highlightShaders().fragment, /impostorShade|pow\(/);
  assert.doesNotMatch(focusFlashShaders().fragment, /impostorShade|pow\(/);
});


// ---------------------------------------------------------------------------
// The alpha-class split. Every geometry pass draws twice — an opaque half that
// writes depth and a translucent half that does not — because one pass doing
// both kept only the running minima of an arbitrary instance order, which made
// the SAME atoms at the SAME alpha read solid from one side and see-through
// from the other (adk: front/back gap 7.9 → 0.2 once the split landed).
// ---------------------------------------------------------------------------

const GEOMETRY_VERTEX = {
  points: pointShaders().vertex,
  edgeTube: edgeTubeShaders().vertex,
  traceTube: traceTubeShaders().vertex,
  ribbon: ribbonShaders().vertex,
};

test("every GEOMETRY vertex shader embeds THE shared alpha-split chunk exactly once", () => {
  for (const [name, src] of Object.entries(GEOMETRY_VERTEX)) {
    assert.equal(src.split(ALPHA_PASS_CHUNK).length - 1, 1,
      `${name} must embed the shared chunk exactly once — a local copy of the ` +
      `classifier is how the two halves start disagreeing about which instances they own`);
  }
});

test("the chunk is a PARTITION: every instance belongs to exactly one half", () => {
  // opaque half keeps alpha >= 1, translucent half keeps alpha < 1 — complementary
  // predicates over one boundary, so nothing is drawn twice and nothing is dropped.
  assert.match(ALPHA_PASS_CHUNK, /uAlphaPass < 0\.5 \? alpha >= 1\.0 : alpha < 1\.0/);
  assert.match(ALPHA_PASS_CHUNK, /uniform float uAlphaPass/);
});

test("every geometry pass CONSULTS the split — declaring the chunk is not using it", () => {
  for (const [name, src] of Object.entries(GEOMETRY_VERTEX)) {
    const body = src.slice(src.indexOf("void main"));
    assert.match(body, /inAlphaPass\(/,
      `${name} embeds the chunk but never calls inAlphaPass — the pass would draw ` +
      `its whole instance set in BOTH halves, double-blending every translucent element`);
  }
});

test("the two-ended passes classify by their DIMMEST end", () => {
  // A segment running alpha 1.0 → 0.4 is translucent material; classifying it by
  // either end alone would let it stamp depth and re-create the bug it fixes.
  for (const name of ["traceTube", "ribbon"] as const) {
    assert.match(GEOMETRY_VERTEX[name], /inAlphaPass\(min\(iColorA\.a, iColorB\.a\)\)/,
      `${name} must classify on min(A, B), not on one end`);
  }
});
