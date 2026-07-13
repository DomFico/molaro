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
  IMPOSTOR_SIZING_CHUNK,
  edgeTubeShaders,
  focusFlashShaders,
  highlightShaders,
  pointShaders,
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
