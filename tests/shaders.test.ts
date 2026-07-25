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

// ---------------------------------------------------------------------------
// The ribbon's renderer-side CENTRIPETAL CATMULL-ROM spline. One flat quad per
// segment faceted every turn into a sharp corner (measured median ~83°/step,
// max ~97°); linear subdivision is a no-op (sub-points stay collinear), only a
// spline rounds it. The spline evaluates in the vertex shader from the control
// hull already on the instance (iPrevPoint/iStart/iEnd/iNextPoint), diced into
// S sub-quads by the base geometry — so no producer/wire/instance change.
// ---------------------------------------------------------------------------

const RIBBON_V = ribbonShaders().vertex;

test("ribbon: the vertex shader evaluates a CENTRIPETAL Catmull-Rom (α=0.5 knots + Hermite basis)", () => {
  // centripetal knot spacing is |Δ|^0.5, floored so coincident control points
  // (chain ends) never divide by zero
  assert.match(RIBBON_V, /float ribbonKnot\(vec3 a, vec3 b\) \{ return sqrt\(max\(length\(a - b\), 1e-5\)\); \}/);
  // the Hermite POSITION basis — pos(0)=P1, pos(1)=P2 falls straight out of it
  assert.match(RIBBON_V, /float h00 = 2\.0 \* ttt - 3\.0 \* tt \+ 1\.0;/);
  assert.match(RIBBON_V, /float h10 = ttt - 2\.0 \* tt \+ t;/);
  assert.match(RIBBON_V, /float h01 = -2\.0 \* ttt \+ 3\.0 \* tt;/);
  assert.match(RIBBON_V, /float h11 = ttt - tt;/);
  assert.match(RIBBON_V, /vec3 pos = h00 \* P1 \+ h10 \* m1 \+ h01 \* P2 \+ h11 \* m2;/);
  // and the basis DERIVATIVE — the true tangent that becomes along(t)
  assert.match(RIBBON_V, /float g00 = 6\.0 \* tt - 6\.0 \* t;/);
  assert.match(RIBBON_V, /vec3 tangent = g00 \* P1 \+ g10 \* m1 \+ g01 \* P2 \+ g11 \* m2;/);
  assert.match(RIBBON_V, /vec3 chordDir = chord \/ segLen;/);
  assert.match(RIBBON_V, /vec3 along = ribbonAlong\(tangent, chordDir\);/);
  // the control hull is the four points the instance already carried
  assert.match(RIBBON_V, /attribute vec3 iPrevPoint; attribute vec3 iNextPoint;/);
  assert.match(RIBBON_V, /vec3 P0 = \(modelViewMatrix \* vec4\(iPrevPoint, 1\.0\)\)\.xyz;/);
  assert.match(RIBBON_V, /vec3 P3 = \(modelViewMatrix \* vec4\(iNextPoint, 1\.0\)\)\.xyz;/);
  // t is read from the base-geometry corner (the sub-quad's t-subrange)
  assert.match(RIBBON_V, /float t = aCorner\.y;/);
});

test("ribbon: across(t) CONDITIONS AT THE ANCHORS, then interpolates ⊥ along(t)", () => {
  assert.match(RIBBON_V, /vec3 ribbonSlerp\(vec3 a, vec3 b, float t\)/);
  // conditioning happens per ANCHOR, against that anchor's OWN tangent — and the
  // anchor tangents come free from m1/m2 (the derivative basis at t=0 and t=1)
  assert.match(RIBBON_V, /vec3 alongA = ribbonAlong\(m1, chordDir\);/);
  assert.match(RIBBON_V, /vec3 alongB = ribbonAlong\(m2, chordDir\);/);
  // same space and same operation as before: view space (rotation only), ⊥, unit
  assert.match(RIBBON_V,
    /vec3 pA = noPlane \? vec3\(0\.0\) : ribbonPerp\(mat3\(modelViewMatrix\) \* normalize\(rawA\), alongA\);/);
  assert.match(RIBBON_V,
    /vec3 pB = noPlane \? vec3\(0\.0\) : ribbonPerp\(mat3\(modelViewMatrix\) \* normalize\(rawB\), alongB\);/);
  assert.match(RIBBON_V, /vec3 ribbonPerp\(vec3 v, vec3 u\) \{ return v - u \* dot\(v, u\); \}/);
  // …and the INTERPOLATION happens inside the plane ⊥ along(t): each conditioned
  // anchor facing is TRANSPORTED into that plane first, so the slerp cannot leave
  // it. It is NOT a slerp of the raw facings re-projected afterwards.
  assert.match(RIBBON_V, /vec3 acrossS = noPlane \? vec3\(0\.0\) : ribbonSlerp\(\s*ribbonTransport\(pA, alongA, along\), ribbonTransport\(pB, alongB, along\), t\);/);
  assert.doesNotMatch(RIBBON_V, /ribbonSlerp\(iAcrossA, iAcrossB, t\)/,
    "the raw supplied facings must NOT be slerped before conditioning (that is the defect)");
  // the anchors take the conditioned anchor facing itself — bit-exactly
  assert.match(RIBBON_V, /vec3 aperp = t <= 0\.0 \? pA : t >= 1\.0 \? pB : ribbonPerp\(acrossS, along\);/);
  // the DEGENERACY rule survives: no defined plane → zero width → collapse
  assert.match(RIBBON_V, /w = w \* \(alen < 1e-6 \? 0\.0 : 1\.0\);/);
  assert.match(RIBBON_V, /vec3 across = alen < 1e-6 \? vec3\(0\.0\) : aperp \/ alen;/);
  // the along fallback is SINGLE-SOURCED now that three tangents need it
  assert.match(RIBBON_V, /vec3 ribbonAlong\(vec3 deriv, vec3 chordDir\) \{\s*float l = length\(deriv\);\s*return l < 1e-9 \? chordDir : deriv \/ l;\s*\}/);
  assert.match(RIBBON_V, /vec3 along = ribbonAlong\(tangent, chordDir\);/);
  // and the transport is the exact expanded half-way-quaternion Rodrigues form
  assert.match(RIBBON_V, /vec3 ribbonTransport\(vec3 v, vec3 a, vec3 b\) \{\s*vec3 k = cross\(a, b\);\s*float c = dot\(a, b\);\s*float d = 1\.0 \+ c;\s*return d < 1e-6 \? v : c \* v \+ cross\(k, v\) \+ k \* \(dot\(k, v\) \/ d\);\s*\}/);
});

test("ribbon: the MITER is retired — the shared control hull makes joints continuous", () => {
  // no bisector-slide machinery survives (the spline subsumes it)
  assert.doesNotMatch(RIBBON_V, /bisector|miter limit|float shift|float denom/i);
  // the thickness offset is the box normal only — no along-shift term
  assert.match(RIBBON_V, /vec3 vpos = pos \+ across \* \(aCorner\.x \* w\)\s*\+ nrm \* \(aCorner\.z/);
  assert.doesNotMatch(RIBBON_V, /along \* shift/);
});

test("ribbon: exactly the two right varyings, and the per-face normal path intact", () => {
  // the pass declares vColor (vec4) and vNormal (vec3) — and nothing else
  assert.match(RIBBON_V, /varying vec4 vColor;/);
  assert.match(RIBBON_V, /varying vec3 vNormal;/);
  assert.equal((RIBBON_V.match(/\bvarying\b/g) ?? []).length, 3,
    "vColor + vNormal + the shared style varying (vStyleParams) — no stray varying");
  // colour is the per-end LERP (the same interpolation, now sampled at S+1 pts)
  assert.match(RIBBON_V, /vColor = mix\(iColorA, iColorB, t\);/);
  // per-face normal (incr 45) composes unchanged: four faces, four normals
  assert.match(RIBBON_V, /vNormal = aFace < 0\.5 \? nrm\s*: aFace < 1\.5 \? -nrm\s*: aFace < 2\.5 \? across\s*: -across;/);
  // the fragment still shades two-sided on |nz| via the shared chunk
  const f = ribbonShaders().fragment;
  assert.match(f, /float nz = abs\(normalize\(vNormal\)\.z\);/);
  assert.match(f, /impostorShade\(vColor\.rgb, nz\)/);
});

// -- a numeric geometry probe: the SAME centripetal Catmull-Rom the shader runs,
// -- mirrored in JS, proving (a) anchors stay on-curve and (b) angularity drops.
type V3 = [number, number, number];
const v3sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const v3dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const v3len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const v3norm = (a: V3): V3 => { const l = v3len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const rKnot = (a: V3, b: V3): number => Math.sqrt(Math.max(v3len(v3sub(a, b)), 1e-5));

/** The two non-uniform (centripetal Barry-Goldman) Hermite tangents at P1 and
 * P2, scaled to the segment's local [0,1] parameter (× d12) — the error-prone
 * core the shader carries verbatim. Chain ends (P0==P1 / P3==P2) fall back to
 * the chord. Single-sourced so BOTH the position and tangent mirrors use it. */
function catmullMs(P0: V3, P1: V3, P2: V3, P3: V3): { chord: V3; m1: V3; m2: V3 } {
  const chord = v3sub(P2, P1);
  const d01 = rKnot(P0, P1), d12 = rKnot(P1, P2), d23 = rKnot(P2, P3);
  const m1: V3 = v3len(v3sub(P1, P0)) < 1e-6 ? chord
    : v3scl(v3add(v3sub(v3scl(v3sub(P1, P0), 1 / d01), v3scl(v3sub(P2, P0), 1 / (d01 + d12))), v3scl(chord, 1 / d12)), d12);
  const m2: V3 = v3len(v3sub(P3, P2)) < 1e-6 ? chord
    : v3scl(v3add(v3sub(v3scl(chord, 1 / d12), v3scl(v3sub(P3, P1), 1 / (d12 + d23))), v3scl(v3sub(P3, P2), 1 / d23)), d12);
  return { chord, m1, m2 };
}

/** Centripetal Catmull-Rom POSITION at t for segment P1→P2 — the exact math the
 * ribbon vertex shader carries (asserted above). */
function ribbonPos(P0: V3, P1: V3, P2: V3, P3: V3, t: number): V3 {
  const { m1, m2 } = catmullMs(P0, P1, P2, P3);
  const tt = t * t, ttt = tt * t;
  const h00 = 2 * ttt - 3 * tt + 1, h10 = ttt - 2 * tt + t, h01 = -2 * ttt + 3 * tt, h11 = ttt - tt;
  return v3add(v3add(v3scl(P1, h00), v3scl(m1, h10)), v3add(v3scl(P2, h01), v3scl(m2, h11)));
}

/** The TANGENT (position-basis derivative) at t — the shader's along(t) before
 * normalization. Same m1/m2 hull, the derivative basis g00..g11. */
function ribbonTangent(P0: V3, P1: V3, P2: V3, P3: V3, t: number): V3 {
  const { m1, m2 } = catmullMs(P0, P1, P2, P3);
  const tt = t * t;
  const g00 = 6 * tt - 6 * t, g10 = 3 * tt - 4 * t + 1, g01 = -6 * tt + 6 * t, g11 = 3 * tt - 2 * t;
  return v3add(v3add(v3scl(P1, g00), v3scl(m1, g10)), v3add(v3scl(P2, g01), v3scl(m2, g11)));
}

const v3cross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** ribbonAlong / ribbonPerp / ribbonTransport, mirrored expression-for-expression
 * (the grouping matters: these are the operations whose ORDER against the
 * interpolation is the whole subject of the conditioning fix). */
const rAlong = (deriv: V3, chordDir: V3): V3 => {
  const l = v3len(deriv);
  return l < 1e-9 ? chordDir : v3scl(deriv, 1 / l);
};
const rPerp = (v: V3, u: V3): V3 => v3sub(v, v3scl(u, v3dot(v, u)));
function rTransport(v: V3, a: V3, b: V3): V3 {
  const k = v3cross(a, b);
  const c = v3dot(a, b);
  const d = 1 + c;
  if (d < 1e-6) return v;
  return v3add(v3add(v3scl(v, c), v3cross(k, v)), v3scl(k, v3dot(k, v) / d));
}

/** The shader's ribbonSlerp, mirrored — guards BOTH poles with a nlerp fallback. */
function ribbonSlerp(a: V3, b: V3, t: number): V3 {
  const na = v3norm(a), nb = v3norm(b);
  const c = Math.max(-1, Math.min(1, v3dot(na, nb)));
  const ang = Math.acos(c), s = Math.sin(ang);
  if (s < 1e-3) {
    const nl = v3add(v3scl(na, 1 - t), v3scl(nb, t));
    const nll = v3len(nl);
    return nll < 1e-4 ? na : v3scl(nl, 1 / nll);
  }
  return v3add(v3scl(na, Math.sin((1 - t) * ang) / s), v3scl(nb, Math.sin(t * ang) / s));
}

const isFinite3 = (v: V3): boolean => v.every((x) => Number.isFinite(x));

function maxTurnDeg(pts: V3[]): number {
  let mx = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = v3sub(pts[i], pts[i - 1]), b = v3sub(pts[i + 1], pts[i]);
    const la = v3len(a), lb = v3len(b);
    if (la < 1e-9 || lb < 1e-9) continue;
    const c = Math.max(-1, Math.min(1, v3dot(a, b) / (la * lb)));
    mx = Math.max(mx, (Math.acos(c) * 180) / Math.PI);
  }
  return mx;
}

// a representative angular polyline (zigzag, ~90-100° turns, mild z-jitter) —
// the same kind of angularity RIBBON_SIZING measured on the real trace
const ANGULAR_POLY: V3[] = [
  [0, 0, 0], [1, 0, 0.1], [1, 1, 0.0], [2, 1, 0.2], [2, 2, 0.1],
  [3, 2, 0.0], [3, 3, 0.15], [4, 2.9, 0.05], [4.2, 3.9, 0.1],
];

test("ribbon: ANCHORS STAY ON-CURVE — the interpolating spline passes through every supplied vertex", () => {
  // pos(0) == iStart and pos(1) == iEnd EXACTLY for every original segment, so
  // drawn ≡ supplied holds at the anchors; only the path between them is rounded
  let anchorErr = 0;
  for (let i = 0; i + 1 < ANGULAR_POLY.length; i++) {
    const P0 = i > 0 ? ANGULAR_POLY[i - 1] : ANGULAR_POLY[i];
    const P1 = ANGULAR_POLY[i], P2 = ANGULAR_POLY[i + 1];
    const P3 = i + 2 < ANGULAR_POLY.length ? ANGULAR_POLY[i + 2] : ANGULAR_POLY[i + 1];
    anchorErr = Math.max(anchorErr, v3len(v3sub(ribbonPos(P0, P1, P2, P3, 0), P1)));
    anchorErr = Math.max(anchorErr, v3len(v3sub(ribbonPos(P0, P1, P2, P3, 1), P2)));
  }
  assert.equal(anchorErr, 0, "the Hermite basis pins pos(0)=P1 and pos(1)=P2 exactly");
  // and it is a source guarantee, not an accident of these points: h00(0)=1 &
  // h01(1)=1 with the other three basis terms zero at the endpoints
  const at = (t: number): [number, number, number, number] => {
    const tt = t * t, ttt = tt * t;
    return [2 * ttt - 3 * tt + 1, ttt - 2 * tt + t, -2 * ttt + 3 * tt, ttt - tt];
  };
  assert.deepEqual(at(0), [1, 0, 0, 0], "h00(0)=1, rest 0 → pos(0)=P1");
  assert.deepEqual(at(1), [0, 0, 1, 0], "h01(1)=1, rest 0 → pos(1)=P2");
});

test("ribbon: SMOOTHNESS — S=8 spline sub-vertices drop the max turn from ~97° toward ~35°", () => {
  const S = 8; // must mirror RIBBON_SEGMENTS
  // before: flat quads follow the chords, so the drawn turn angles ARE the
  // polyline's own turn angles
  const before = maxTurnDeg(ANGULAR_POLY);
  // after: walk every segment's spline sub-vertices (dropping the duplicated
  // shared endpoint) — the actual drawn silhouette the shader produces
  const drawn: V3[] = [];
  for (let i = 0; i + 1 < ANGULAR_POLY.length; i++) {
    const P0 = i > 0 ? ANGULAR_POLY[i - 1] : ANGULAR_POLY[i];
    const P1 = ANGULAR_POLY[i], P2 = ANGULAR_POLY[i + 1];
    const P3 = i + 2 < ANGULAR_POLY.length ? ANGULAR_POLY[i + 2] : ANGULAR_POLY[i + 1];
    for (let j = 0; j <= S; j++) {
      if (i > 0 && j === 0) continue;
      drawn.push(ribbonPos(P0, P1, P2, P3, j / S));
    }
  }
  const after = maxTurnDeg(drawn);
  assert.ok(before > 90, `precondition: the polyline is genuinely angular (max turn ${before.toFixed(1)}°)`);
  assert.ok(after < before * 0.5,
    `the spline more than halves the max turn (${before.toFixed(1)}° → ${after.toFixed(1)}°)`);
  assert.ok(after < 45,
    `the drawn silhouette rounds toward RIBBON_SIZING's ~35° target (got ${after.toFixed(1)}°)`);
});

test("ribbon: the m1/m2 non-uniform tangent formulas match the exact GLSL (transcription pin)", () => {
  // The Barry-Goldman tangent is the error-prone core: a sign or grouping slip
  // would kink the ribbon with every position/anchor test still green. Pin the
  // GLSL byte-for-byte, and pin the chain-end chord fallback.
  assert.match(RIBBON_V,
    /vec3 m1 = length\(P1 - P0\) < 1e-6\s*\?\s*chord\s*:\s*\(\(P1 - P0\) \/ d01 - \(P2 - P0\) \/ \(d01 \+ d12\) \+ chord \/ d12\) \* d12;/);
  assert.match(RIBBON_V,
    /vec3 m2 = length\(P3 - P2\) < 1e-6\s*\?\s*chord\s*:\s*\(chord \/ d12 - \(P3 - P1\) \/ \(d12 \+ d23\) \+ \(P3 - P2\) \/ d23\) \* d12;/);
});

test("ribbon: the analytic tangent IS the position derivative (finite-difference agreement)", () => {
  // g00..g11 must be the exact derivative of h00..h11 — otherwise along(t) points
  // slightly off the curve and the box twists. Check against a central difference
  // of the position mirror at several t on a curving segment.
  const P0: V3 = [0, 0, 0], P1: V3 = [1, 0, 0.1], P2: V3 = [1, 1, 0], P3: V3 = [2, 1, 0.3];
  const eps = 1e-5;
  for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
    const num = v3scl(v3sub(ribbonPos(P0, P1, P2, P3, t + eps), ribbonPos(P0, P1, P2, P3, t - eps)), 1 / (2 * eps));
    const ana = ribbonTangent(P0, P1, P2, P3, t);
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(num[c] - ana[c]) < 1e-3,
        `tangent[${c}] at t=${t}: analytic ${ana[c].toFixed(5)} vs finite-diff ${num[c].toFixed(5)}`);
    }
  }
});

test("ribbon: the tangent DIRECTION is continuous at an interior joint (G1 → the miter never forms)", () => {
  // The retired miter rests entirely on this: at a shared anchor the END tangent
  // of the left segment and the START tangent of the right point the SAME way
  // (they differ only in magnitude, which is why it is G1 not C1). If this ever
  // failed the joint would kink and a wedge would reopen.
  const poly: V3[] = [[0, 0, 0], [1, 0, 0.1], [1, 1, 0], [2, 0.9, 0.2], [2.3, 1.9, 0.1]];
  for (let i = 1; i + 1 < poly.length; i++) {
    // left segment (poly[i-1] → poly[i]) end tangent at t=1
    const L0 = i - 2 >= 0 ? poly[i - 2] : poly[i - 1];
    const endTan = ribbonTangent(L0, poly[i - 1], poly[i], poly[i + 1], 1);
    // right segment (poly[i] → poly[i+1]) start tangent at t=0
    const R3 = i + 2 < poly.length ? poly[i + 2] : poly[i + 1];
    const startTan = ribbonTangent(poly[i - 1], poly[i], poly[i + 1], R3, 0);
    const cos = v3dot(v3norm(endTan), v3norm(startTan));
    assert.ok(cos > 0.9999, `joint ${i}: end/start tangent directions must agree (cos=${cos.toFixed(6)})`);
  }
});

test("ribbon: coincident / zero-length control points never NaN (chain ends + collapsed hulls)", () => {
  // chain start (P0==P1) and chain end (P3==P2): the shader's chord fallback
  const cases: [V3, V3, V3, V3][] = [
    [[1, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]],   // P0==P1 (chain start)
    [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 0]],   // P3==P2 (chain end)
    [[1, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 0]],   // both ends of a lone segment
    [[5, 5, 5], [5, 5, 5], [5, 5, 5], [5, 5, 5]],   // fully coincident hull
  ];
  for (const [P0, P1, P2, P3] of cases) {
    for (const t of [0, 0.5, 1]) {
      assert.ok(isFinite3(ribbonPos(P0, P1, P2, P3, t)), `pos finite for ${JSON.stringify([P0, P1, P2, P3])} @${t}`);
      assert.ok(isFinite3(ribbonTangent(P0, P1, P2, P3, t)), `tangent finite for ${JSON.stringify([P0, P1, P2, P3])} @${t}`);
    }
  }
});

test("ribbon: ribbonSlerp is finite and unit at BOTH poles (parallel AND antiparallel)", () => {
  const parallel: [V3, V3] = [[0, 1, 0], [0, 2, 0]];       // ang → 0
  const antipar: [V3, V3] = [[0, 1, 0], [0, -1, 0]];        // ang → π (the new guard)
  const perp: [V3, V3] = [[1, 0, 0], [0, 1, 0]];            // the well-conditioned 90°
  for (const [name, [a, b]] of [["parallel", parallel], ["antiparallel", antipar], ["perp", perp]] as const) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const r = ribbonSlerp(a, b, t);
      assert.ok(isFinite3(r), `${name} @${t} must be finite, got ${JSON.stringify(r)}`);
      assert.ok(Math.abs(v3len(r) - 1) < 1e-4, `${name} @${t} must stay unit (len=${v3len(r).toFixed(5)})`);
    }
  }
  // the guard is a source fact too: the poles fall back to a normalized lerp,
  // there is no bare division by sin(ang) left unguarded
  assert.match(RIBBON_V, /if \(s < 1e-3\) \{/);
  assert.match(RIBBON_V, /return nll < 1e-4 \? na : nl \/ nll;/);
});

test("ribbon: a PARTIALLY-bound segment TAPERS — a zero-facing anchor draws no ribbon (no invented facing)", () => {
  // drawn ≡ supplied at partial binding: the width collapses at the unbound end
  // and grows to the bound end, rather than borrowing the neighbour's facing at
  // full width. Pin the per-end taper in the shader source.
  assert.match(RIBBON_V, /float wA_def = lenA < 1e-9 \? 0\.0 : wA;/);
  assert.match(RIBBON_V, /float wB_def = lenB < 1e-9 \? 0\.0 : wB;/);
  assert.match(RIBBON_V, /float w = mix\(wA_def, wB_def, t\);/);
  // and it must NOT be the old full-width mix over the raw widths
  assert.doesNotMatch(RIBBON_V, /float w = mix\(wA, wB, t\);/);
});

// ---------------------------------------------------------------------------
// across(t) — THE CONDITIONING. The ribbon's face direction comes from a
// 3-wide channel bound to the orientation axis. Conditioning it (view space,
// ⊥ the local tangent, unit) and INTERPOLATING it are two operations whose
// ORDER decides whether the band twists smoothly or folds: projecting AFTER
// the interpolation is a near-cancellation wherever the interpolated facing
// approaches the tangent, and the tangent rotates a lot WITHIN one segment.
// Both orderings are mirrored below so the fix is proved, not asserted.
// ---------------------------------------------------------------------------

/** the drawn face direction at t: the CURRENT ordering (condition at each
 * anchor against that anchor's own tangent, transport both into the plane
 * ⊥ along(t), slerp there). `M` is mat3(modelViewMatrix). */
function acrossNow(P0: V3, P1: V3, P2: V3, P3: V3, A: V3, B: V3, t: number, M: V3[]): { across: V3; alen: number; along: V3 } {
  const { chord, m1, m2 } = catmullMs(P0, P1, P2, P3);
  const chordDir = v3scl(chord, 1 / v3len(chord));
  const along = rAlong(ribbonTangent(P0, P1, P2, P3, t), chordDir);
  const lenA = v3len(A), lenB = v3len(B);
  const noPlane = lenA < 1e-9 && lenB < 1e-9;
  const rawA: V3 = lenA < 1e-9 ? B : A;
  const rawB: V3 = lenB < 1e-9 ? A : B;
  const alongA = rAlong(m1, chordDir), alongB = rAlong(m2, chordDir);
  const pA: V3 = noPlane ? [0, 0, 0] : rPerp(mat3mul(M, v3norm(rawA)), alongA);
  const pB: V3 = noPlane ? [0, 0, 0] : rPerp(mat3mul(M, v3norm(rawB)), alongB);
  const acrossS: V3 = noPlane ? [0, 0, 0]
    : ribbonSlerp(rTransport(pA, alongA, along), rTransport(pB, alongB, along), t);
  const aperp = t <= 0 ? pA : t >= 1 ? pB : rPerp(acrossS, along);
  const alen = v3len(aperp);
  return { across: alen < 1e-6 ? [0, 0, 0] : v3scl(aperp, 1 / alen), alen, along };
}

/** the drawn face direction at t under the PRE-CHANGE ordering (slerp the raw
 * supplied facings, then project ⊥ along(t)). FROZEN: it exists only as the
 * reference the anchors must still reproduce bit-for-bit. It is deliberately
 * NOT what the shader does any more — the interior test below asserts the two
 * disagree, so this cannot quietly become a copy of `acrossNow`. */
function acrossInterpolateThenProject(P0: V3, P1: V3, P2: V3, P3: V3, A: V3, B: V3, t: number, M: V3[]): { across: V3; alen: number } {
  const { chord } = catmullMs(P0, P1, P2, P3);
  const chordDir = v3scl(chord, 1 / v3len(chord));
  const along = rAlong(ribbonTangent(P0, P1, P2, P3, t), chordDir);
  const lenA = v3len(A), lenB = v3len(B);
  const acrossWorld: V3 = (lenA < 1e-9 && lenB < 1e-9) ? [0, 0, 0]
    : lenA < 1e-9 ? v3norm(B) : lenB < 1e-9 ? v3norm(A) : ribbonSlerp(A, B, t);
  const aperp = rPerp(mat3mul(M, acrossWorld), along);
  const alen = v3len(aperp);
  return { across: alen < 1e-6 ? [0, 0, 0] : v3scl(aperp, 1 / alen), alen };
}

const mat3mul = (M: V3[], v: V3): V3 => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
];
const M_ID: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// an arbitrary camera rotation, so the view-space conditioning is exercised with
// a modelView that actually mixes the axes (yaw 0.7, pitch 0.4)
const M_ROT: V3[] = (() => {
  const cy = Math.cos(0.7), sy = Math.sin(0.7), cp = Math.cos(0.4), sp = Math.sin(0.4);
  return [[cy, -sy * cp, sy * sp], [sy, cy * cp, -cy * sp], [0, sp, cp]];
})();

/** a deterministic angular polyline + per-anchor facings, in several regimes —
 * a swept range of facing/tangent configurations rather than one lucky case. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function condPoly(n: number, seed: number): V3[] {
  const r = lcg(seed); const p: V3[] = [[0, 0, 0]];
  let dir: V3 = [1, 0, 0];
  for (let i = 1; i < n; i++) {
    const ax = v3norm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const ang = (70 + 40 * r()) * Math.PI / 180;   // a hard turn every step
    const kk = v3scl(ax, v3dot(ax, dir));
    dir = v3norm(v3add(v3add(v3scl(v3sub(dir, kk), Math.cos(ang)), v3scl(v3cross(ax, dir), Math.sin(ang))), kk));
    p.push(v3add(p[i - 1], v3scl(dir, 0.35 + 0.05 * r())));
  }
  return p;
}
type Regime = "perp-twist" | "perp-chase" | "tilted" | "world-fixed";
function condFacings(p: V3[], regime: Regime, seed: number): V3[] {
  const r = lcg(seed);
  const T = p.map((_, i) => v3norm(v3sub(i + 1 < p.length ? p[i + 1] : p[i], i > 0 ? p[i - 1] : p[i])));
  return T.map((tv, i) => {
    const refRaw: V3 = [0.3, 0.9, 0.31];
    const u = v3norm(rPerp(Math.abs(v3dot(tv, refRaw)) > 0.95 ? [1, 0, 0] : refRaw, tv));
    const v = v3cross(tv, u);
    const phi = (i * 25 + 20 * (r() - 0.5)) * Math.PI / 180;
    const spun = v3add(v3scl(u, Math.cos(phi)), v3scl(v, Math.sin(phi)));
    switch (regime) {
      // ⊥ its own tangent, twisting along the path (anchor conditioning ~1)
      case "perp-twist": return spun;
      // ⊥ its own tangent but pointing where the tangent is GOING — the
      // adversarial case: anchor conditioning is perfect and the interior
      // still crosses the tangent, so a merely-reordered projection cannot help
      case "perp-chase": {
        const nxt = i + 1 < T.length ? T[i + 1] : T[i];
        const q = rPerp(nxt, tv);
        return v3len(q) < 1e-6 ? u : v3norm(q);
      }
      // a large TANGENTIAL component: poorly conditioned AT the anchors too
      case "tilted": return v3add(spun, v3scl(tv, 2.5 * (r() - 0.5) * 2));
      // one fixed world direction for every anchor
      case "world-fixed": return [0, 1, 0];
    }
  });
}
const COND_REGIMES: Regime[] = ["perp-twist", "perp-chase", "tilted", "world-fixed"];
const COND_S = 8; // must mirror RIBBON_SEGMENTS

/** walk every segment × every sub-sample of a regime, reporting the two things
 * the fold was made of: how short the ⊥ residue gets, and how far the face
 * direction can swing between two ADJACENT sub-samples. */
function condStats(p: V3[], F: V3[], M: V3[], mode: "now" | "pre") {
  let interiorMin = Infinity, anchorMin = Infinity, worstRotDeg = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const P0 = i > 0 ? p[i - 1] : p[i], P1 = p[i], P2 = p[i + 1];
    const P3 = i + 2 < p.length ? p[i + 2] : p[i + 1];
    let prev: V3 | null = null;
    for (let j = 0; j <= COND_S; j++) {
      const t = j / COND_S;
      const o = mode === "now"
        ? acrossNow(P0, P1, P2, P3, F[i], F[i + 1], t, M)
        : acrossInterpolateThenProject(P0, P1, P2, P3, F[i], F[i + 1], t, M);
      if (j === 0 || j === COND_S) anchorMin = Math.min(anchorMin, o.alen);
      else interiorMin = Math.min(interiorMin, o.alen);
      if (prev) {
        const c = Math.max(-1, Math.min(1, v3dot(prev, o.across)));
        worstRotDeg = Math.max(worstRotDeg, (Math.acos(c) * 180) / Math.PI);
      }
      prev = o.across;
    }
  }
  return { interiorMin, anchorMin, worstRotDeg };
}

test("ribbon: ribbonTransport carries a ⊥ facing into the NEXT tangent's plane (never cancels)", () => {
  // the one property the interior conditioning rests on: v ⊥ a ⟹ Rv ⊥ b. A
  // PROJECTION would instead subtract two nearly-equal vectors as v → b.
  const r = lcg(4242);
  let worstResidual = 0, worstLenDrift = 0;
  for (let n = 0; n < 4000; n++) {
    const a = v3norm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const b = v3norm([r() - 0.5, r() - 0.5, r() - 0.5]);
    const v = v3norm(rPerp([r() - 0.5, r() - 0.5, r() - 0.5], a)); // v ⊥ a, unit
    const out = rTransport(v, a, b);
    worstResidual = Math.max(worstResidual, Math.abs(v3dot(v3norm(out), b)));
    worstLenDrift = Math.max(worstLenDrift, Math.abs(v3len(out) - 1)); // a rotation is an isometry
  }
  assert.ok(worstResidual < 1e-12, `transported facing must stay ⊥ the target tangent (worst |cos| ${worstResidual.toExponential(2)})`);
  assert.ok(worstLenDrift < 1e-12, `transport must preserve length (worst drift ${worstLenDrift.toExponential(2)})`);
  // a → a is the identity (so the anchors are reached by the same vector), and
  // the b ≈ -a pole passes v through — still ⊥, still finite, never NaN
  const a: V3 = v3norm([0.3, -0.7, 0.5]);
  const v: V3 = v3norm(rPerp([1, 0.2, -0.4], a));
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(rTransport(v, a, a)[c] - v[c]) < 1e-15, "a→a is the identity");
  const flipped = rTransport(v, a, v3scl(a, -1));
  assert.ok(isFinite3(flipped) && Math.abs(v3dot(v3norm(flipped), a)) < 1e-15,
    "at the b ≈ -a pole the facing passes through, still ⊥ (v ⊥ a ⟹ v ⊥ -a)");
});

test("ribbon: the ANCHORS are BIT-IDENTICAL to the pre-change ordering (drawn ≡ supplied)", () => {
  // The reordering is allowed to move the segment INTERIOR and nothing else. At
  // t=0 and t=1 both orderings reduce to projecting iAcrossA / iAcrossB against
  // that anchor's own tangent — but only because the shader TAKES pA / pB there
  // rather than re-projecting a renormalized slerp (float projection is not
  // idempotent). Exact equality, not a tolerance: aperp's direction AND its
  // length, which is what the alen belt reads.
  const p = condPoly(60, 12345);
  for (const M of [M_ID, M_ROT]) {
    for (const regime of COND_REGIMES) {
      const F = condFacings(p, regime, 999);
      let checked = 0;
      for (let i = 0; i + 1 < p.length; i++) {
        const P0 = i > 0 ? p[i - 1] : p[i], P1 = p[i], P2 = p[i + 1];
        const P3 = i + 2 < p.length ? p[i + 2] : p[i + 1];
        for (const t of [0, 1]) {
          const now = acrossNow(P0, P1, P2, P3, F[i], F[i + 1], t, M);
          const pre = acrossInterpolateThenProject(P0, P1, P2, P3, F[i], F[i + 1], t, M);
          assert.equal(now.alen, pre.alen, `${regime} seg ${i} t=${t}: anchor residue LENGTH must be identical`);
          for (let c = 0; c < 3; c++) {
            assert.equal(now.across[c], pre.across[c],
              `${regime} seg ${i} t=${t} component ${c}: anchor face direction must be identical`);
          }
          checked++;
        }
      }
      assert.ok(checked === 118, `every anchor of every segment was compared (got ${checked})`);
    }
  }
  // and the PARTIALLY-bound anchors too: one end zero (the taper case) still
  // conditions the surviving facing against the tangent it always did
  const P0: V3 = [0, 0, 0], P1: V3 = [1, 0, 0.1], P2: V3 = [1, 1, 0], P3: V3 = [2, 1, 0.3];
  for (const [A, B] of [[[0, 0, 0], [0.2, 1, 0.3]], [[0.2, 1, 0.3], [0, 0, 0]], [[0, 0, 0], [0, 0, 0]]] as [V3, V3][]) {
    for (const t of [0, 1]) {
      const now = acrossNow(P0, P1, P2, P3, A, B, t, M_ROT);
      const pre = acrossInterpolateThenProject(P0, P1, P2, P3, A, B, t, M_ROT);
      for (let c = 0; c < 3; c++) {
        assert.equal(now.across[c], pre.across[c], `partial binding ${JSON.stringify([A, B])} t=${t}: anchor identical`);
      }
    }
  }
});

test("ribbon: the INTERIOR is where the two orderings differ — this net is not vacuous", () => {
  // If the shader were ever reverted to slerp-then-project, the anchor test above
  // would still pass (the anchors coincide) and the conditioning test below would
  // be the only thing to catch it. Pin that the mirrors genuinely differ inside
  // the segment, so the pre-change reference cannot rot into a copy.
  const p = condPoly(60, 12345);
  const F = condFacings(p, "perp-twist", 999);
  let maxInteriorDelta = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const P0 = i > 0 ? p[i - 1] : p[i], P1 = p[i], P2 = p[i + 1];
    const P3 = i + 2 < p.length ? p[i + 2] : p[i + 1];
    for (let j = 1; j < COND_S; j++) {
      const t = j / COND_S;
      const now = acrossNow(P0, P1, P2, P3, F[i], F[i + 1], t, M_ID);
      const pre = acrossInterpolateThenProject(P0, P1, P2, P3, F[i], F[i + 1], t, M_ID);
      for (let c = 0; c < 3; c++) maxInteriorDelta = Math.max(maxInteriorDelta, Math.abs(now.across[c] - pre.across[c]));
    }
  }
  assert.ok(maxInteriorDelta > 0.1,
    `the two orderings must visibly disagree in the segment interior (max |Δ| ${maxInteriorDelta.toFixed(4)})`);
});

test("ribbon: CONDITIONING FLOOR — the interior residue is ⊥ by construction, never a near-cancellation", () => {
  // THE REGRESSION NET FOR THIS CLASS OF BUG. A violation looks like this: some
  // sub-sample's ⊥ residue gets short, so the face direction is the normalized
  // difference of two nearly-equal vectors; it reverses as the interpolated
  // facing crosses the tangent, and the band shows a hard fold (and pinches to
  // zero width where the residue falls under the 1e-6 belt).
  //
  // MEASURED on a 214-vertex polyline of hard turns (within-segment tangent
  // rotation mean 47.6°, max 97.6°), over four supplied-facing regimes:
  //   pre-change (slerp raw, then project)  interior residue min 0.0116 … 0.1030
  //   now        (condition, transport, slerp inside the plane)  min 1.000000
  // The floor is 1 rather than "large" because the interpolation happens INSIDE
  // the plane ⊥ along(t): a slerp of two vectors of one plane through the origin
  // stays in it, so the final ribbonPerp removes only rounding.
  const p = condPoly(214, 12345);
  for (const M of [M_ID, M_ROT]) {
    for (const regime of COND_REGIMES) {
      const F = condFacings(p, regime, 999);
      const now = condStats(p, F, M, "now");
      const pre = condStats(p, F, M, "pre");
      assert.ok(now.interiorMin > 1 - 1e-9,
        `${regime}: the interior residue must be ⊥ by construction (min ${now.interiorMin.toFixed(9)})`);
      // …and the ANCHOR floor is untouched: it is the supplied facing's own ⊥
      // component, a property of the DATA, which no ordering may improve (that
      // would mean inventing a facing) or worsen.
      assert.equal(now.anchorMin, pre.anchorMin,
        `${regime}: the anchor conditioning floor is the supplied data's, unchanged`);
      // the whole-segment floor is therefore exactly the anchor floor
      assert.ok(Math.min(now.interiorMin, now.anchorMin) === now.anchorMin,
        `${regime}: conditioning is never worse inside a segment than at its anchors`);
    }
  }
  // and the pre-change ordering DID break that: on the adversarial regime the
  // interior conditioned an order of magnitude worse than the anchors it came from
  const F = condFacings(p, "perp-chase", 999);
  const pre = condStats(p, F, M_ID, "pre");
  assert.ok(pre.interiorMin < pre.anchorMin / 5,
    `precondition: the old ordering degraded the interior far below its anchors ` +
    `(interior ${pre.interiorMin.toFixed(4)} vs anchor ${pre.anchorMin.toFixed(4)})`);
});
