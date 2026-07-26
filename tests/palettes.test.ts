/**
 * Unit tests for the palette registry (webview/palettes.ts) — the registry
 * surface (registration order, name → index, the default), THE BYTE-IDENTITY
 * ANCHOR (the default palette IS the recipe's own colormap function, by
 * reference), the two added ramps' defining properties MEASURED rather than
 * asserted, and the assert-unreachable unknown-name instrument. Pure, no DOM.
 * Run from viewer/:
 *   node --test tests/palettes.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLUEWHITERED_PALETTE,
  colormapFor,
  DEFAULT_PALETTE_NAME,
  GRAY_PALETTE,
  listPalettes,
  luminanceToLstar,
  lstarToLuminance,
  luminanceToSrgb,
  paletteIndex,
  paletteNames,
  paletteResolutionCount,
  RAINBOW_PALETTE,
  registerPalette,
  srgbToLuminance,
  unknownPaletteHitCount,
} from "../webview/palettes.ts";
import { hsvToRgb, rainbow } from "../webview/recipes.ts";

// -- the registry surface (styles.ts's shape) --------------------------------

test("the registry holds three palettes in REGISTRATION ORDER; index 0 is the default", () => {
  assert.deepEqual(paletteNames(), ["rainbow", "bluewhitered", "gray"]);
  assert.equal(paletteIndex("rainbow"), 0);
  assert.equal(paletteIndex("bluewhitered"), 1);
  assert.equal(paletteIndex("gray"), 2);
  // the default is index 0 BY CONSTRUCTION — a reordered registration must
  // not silently move it
  assert.equal(DEFAULT_PALETTE_NAME, listPalettes()[0].name);
  assert.equal(DEFAULT_PALETTE_NAME, "rainbow");
});

test("paletteIndex: -1 for an unknown name (styleIndex's contract — the membership test)", () => {
  assert.equal(paletteIndex("viridis"), -1);
  assert.equal(paletteIndex(""), -1);
  assert.equal(paletteIndex("RAINBOW"), -1, "names are exact, not case-folded");
});

test("every registered palette is total on [0,1] and stays in gamut", () => {
  for (const p of listPalettes()) {
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const rgb = p.colormap(t);
      assert.equal(rgb.length, 3, `${p.name} at t=${t}`);
      for (const c of rgb) {
        assert.ok(Number.isFinite(c), `${p.name} at t=${t}: ${c} is not finite`);
        assert.ok(c >= 0 && c <= 1, `${p.name} at t=${t}: ${c} outside [0,1]`);
      }
    }
    assert.ok(p.description.length > 0, `${p.name} has a listing description`);
  }
});

test("registerPalette appends without disturbing the default (the registry is a map)", () => {
  const before = paletteNames();
  registerPalette({ name: "zz-test", colormap: () => [0, 0, 0], description: "test" });
  try {
    assert.deepEqual(paletteNames(), [...before, "zz-test"], "appended at the end");
    assert.equal(paletteIndex("rainbow"), 0, "the default did not move");
    assert.equal(DEFAULT_PALETTE_NAME, "rainbow");
  } finally {
    // no unregister in the surface (nothing needs one); this file runs in its
    // own process, so the extra entry cannot leak into another suite
  }
});

test("registerPalette: a name that could not survive save_rep's replay line is REFUSED", () => {
  // The name is embedded in the emitted `?palette=<name>` command — a space,
  // `?`, or quote would write a mod file the parser later refuses, at replay
  // time, far from the mistake. Loud at registration instead (NAME_RE's rule).
  const before = paletteNames();
  for (const bad of ["Bad", "two words", "a?b", 'q"uote', "", "-lead", "9lead", "gray extra"]) {
    assert.throws(
      () => registerPalette({ name: bad, colormap: () => [0, 0, 0], description: "x" }),
      /invalid palette name/,
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(paletteNames(), before, "no refusal registered anything");
});

// -- THE BYTE-IDENTITY ANCHOR ------------------------------------------------

test("BYTE-IDENTITY: the default palette is the recipe's colormap FUNCTION, not a copy", () => {
  // The strongest form of "the default path is unchanged": identity, not
  // equality of sampled values. A re-implementation of the sweep could drift;
  // the same function object cannot.
  assert.equal(RAINBOW_PALETTE.colormap, rainbow.colormap);
  assert.equal(colormapFor(undefined), rainbow.colormap,
    "an unnamed palette resolves to the very function the hardcoded call used");
  assert.equal(colormapFor("rainbow"), rainbow.colormap,
    "naming the default explicitly resolves to the same function");
  assert.equal(colormapFor(DEFAULT_PALETTE_NAME), colormapFor(undefined));
});

test("BYTE-IDENTITY: the default's samples equal the sweep's, exactly, across the ramp", () => {
  // Redundant with the identity above BY DESIGN — it is the check that would
  // still fail if someone replaced the shared reference with a copy.
  const cmap = colormapFor(undefined);
  for (let i = 0; i <= 300; i++) {
    const t = i / 300;
    assert.deepEqual(cmap(t), rainbow.colormap(t), `t=${t}`);
  }
  assert.deepEqual(cmap(0), [1, 0, 0], "t=0 → red, the sweep's low end");
  assert.deepEqual(cmap(1), [1, 0, 1], "t=1 → magenta, the sweep's high end");
});

// -- the diverging ramp: measured, not asserted ------------------------------

test("bluewhitered: pure blue → white → pure red, HIGH END RED, exact at the anchors", () => {
  const c = BLUEWHITERED_PALETTE.colormap;
  assert.deepEqual(c(0), [0, 0, 1], "low end is pure blue");
  assert.deepEqual(c(0.5), [1, 1, 1], "the midpoint is white — the diverging pivot");
  assert.deepEqual(c(1), [1, 0, 0], "high end is pure red (the whole point of the name order)");
  assert.deepEqual(c(0.25), [0.5, 0.5, 1], "piecewise-linear below the pivot");
  assert.deepEqual(c(0.75), [1, 0.5, 0.5], "piecewise-linear above it");
});

test("bluewhitered: red rises and blue falls MONOTONICALLY across the whole ramp", () => {
  // The property that makes a diverging map readable: no reversal anywhere,
  // so "further from the pivot" always reads as "more saturated toward that
  // end". Measured over 1025 samples.
  const N = 1024;
  let prev = BLUEWHITERED_PALETTE.colormap(0);
  for (let i = 1; i <= N; i++) {
    const cur = BLUEWHITERED_PALETTE.colormap(i / N);
    assert.ok(cur[0] >= prev[0] - 1e-15, `red decreased at t=${i / N}`);
    assert.ok(cur[2] <= prev[2] + 1e-15, `blue increased at t=${i / N}`);
    prev = cur;
  }
});

test("bluewhitered is genuinely DISTINCT from the default sweep (not a re-spelling)", () => {
  let maxDiff = 0;
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    const a = BLUEWHITERED_PALETTE.colormap(t);
    const b = RAINBOW_PALETTE.colormap(t);
    for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(a[k] - b[k]));
  }
  assert.equal(maxDiff, 1, "the two ramps differ by a full channel somewhere");
  assert.notDeepEqual(BLUEWHITERED_PALETTE.colormap(1), RAINBOW_PALETTE.colormap(1));
});

// -- the perceptually-uniform sequential ramp: the property is MEASURED -----

test("gray: L* is LINEAR in t — recovered from the emitted RGB, max deviation 2.2e-14", () => {
  // The uniformity claim is not taken on trust from the construction: this
  // inverts the emitted sRGB back to luminance and then to L*, and pins the
  // largest departure from 100·t. MEASURED at 1025 samples: 2.132e-14 (pure
  // floating-point noise — the ramp is exactly L*-linear by construction).
  const N = 1024;
  let maxDev = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [r, g, b] = GRAY_PALETTE.colormap(t);
    assert.equal(r, g, `t=${t}: not neutral`);
    assert.equal(g, b, `t=${t}: not neutral`);
    const lstar = luminanceToLstar(srgbToLuminance(r));
    maxDev = Math.max(maxDev, Math.abs(lstar - 100 * t));
  }
  assert.ok(maxDev < 1e-13, `max |L* − 100t| = ${maxDev.toExponential(3)} — expected ~2.1e-14`);
});

test("gray: black at the low end, white at the high end (to one ulp), monotone between", () => {
  assert.deepEqual(GRAY_PALETTE.colormap(0), [0, 0, 0]);
  // The high end is 1.055·1^(1/2.4) − 0.055, which in binary64 lands one ulp
  // short of 1 (measured: 0.9999999999999999). Left unbranched because the
  // ulp is ERASED before it can matter: every destination buffer is a
  // Float32Array (rep.state.*, representation.ts), and the nearest float32
  // to that value IS 1 — asserted below, not argued from smallness.
  const hi = GRAY_PALETTE.colormap(1)[0];
  assert.ok(Math.abs(hi - 1) <= 2 ** -52, `high end ${hi} is white to within one ulp`);
  assert.equal(Math.fround(hi), 1, "the float32 store rounds it to exactly 1 — the ulp never reaches the GPU");
  const N = 512;
  for (let i = 1; i <= N; i++) {
    assert.ok(
      GRAY_PALETTE.colormap(i / N)[0] >= GRAY_PALETTE.colormap((i - 1) / N)[0],
      `not monotone at t=${i / N}`,
    );
  }
});

test("gray is NOT the naive [t,t,t] ramp — the difference is 3.39 L* at the midpoint", () => {
  // Why the ramp exists: sRGB is gamma-encoded, so [0.5,0.5,0.5] is NOT the
  // perceptual half-way point. MEASURED: it recovers L* = 53.3890, while a
  // uniform ramp's midpoint is L* = 50 exactly.
  const naiveMid = luminanceToLstar(srgbToLuminance(0.5));
  assert.ok(Math.abs(naiveMid - 53.389) < 5e-4, `naive mid L* = ${naiveMid}`);
  const uniformMid = luminanceToLstar(srgbToLuminance(GRAY_PALETTE.colormap(0.5)[0]));
  assert.ok(Math.abs(uniformMid - 50) < 1e-12, `uniform mid L* = ${uniformMid}`);
  assert.ok(Math.abs(naiveMid - uniformMid - 3.389) < 5e-4, "the gap is 3.39 L*");
});

test("the L*/sRGB conversions round-trip both ways (the derivation, not a table)", () => {
  // MEASURED worst round-trip error over these samples: 7.11e-15 for L*
  // (at L* = 43) and 1.11e-16 for sRGB (at c = 0.75).
  let worstL = 0;
  for (let i = 0; i <= 100; i++) {
    worstL = Math.max(worstL, Math.abs(luminanceToLstar(lstarToLuminance(i)) - i));
  }
  assert.ok(worstL < 1e-13, `worst L* round-trip ${worstL.toExponential(3)} — expected ~7.1e-15`);
  let worstC = 0;
  for (let i = 0; i <= 100; i++) {
    const c = i / 100;
    worstC = Math.max(worstC, Math.abs(luminanceToSrgb(srgbToLuminance(c)) - c));
  }
  assert.ok(worstC < 1e-15, `worst sRGB round-trip ${worstC.toExponential(3)} — expected ~1.1e-16`);
});

test("the two transfer functions' branches join at their knees, to the measured residue", () => {
  // CIE: the linear and cube branches meet EXACTLY at L* = 8 (that is what
  // κ = 24389/27 is chosen for) — measured gap 0.
  assert.equal(8 / (24389 / 27), Math.pow((8 + 16) / 116, 3), "the CIE knee joins exactly");
  // sRGB: the standard's ROUNDED constants (0.0031308 / 12.92 / 1.055) leave a
  // real discontinuity. MEASURED: 2.8517e-8 in the encoded value, i.e.
  // 7.3e-6 of one 8-bit level — an artifact of the specification, not of this
  // code, and far below anything a pixel can show. Pinned so a future edit
  // that made it LARGE (a mistyped constant) would trip.
  const gap = Math.abs(luminanceToSrgb(0.0031308) - (1.055 * Math.pow(0.0031308, 1 / 2.4) - 0.055));
  assert.ok(gap < 3e-8, `sRGB knee gap ${gap.toExponential(4)} — expected 2.8517e-8`);
  assert.ok(gap * 255 < 1e-5, "under 1e-5 of an 8-bit level");
});

// -- the OFF-DOMAIN rule (the belt beyond mapScalar's lens) ------------------

test("off-domain: bluewhitered and gray SATURATE to their endpoint colors", () => {
  // The meaningful domain is [0,1] and mapScalar is the sole lens; the belt
  // says a finite off-domain t must come out in-gamut. Without the clamp
  // bluewhitered would EXTRAPOLATE: t=1.25 → (1, −0.5, −0.5) — pinned here
  // so removing the belt fails a test, not a screenshot.
  for (const t of [-1e9, -1.5, -0.001]) {
    assert.deepEqual(BLUEWHITERED_PALETTE.colormap(t), BLUEWHITERED_PALETTE.colormap(0), `bwr t=${t}`);
    assert.deepEqual(GRAY_PALETTE.colormap(t), GRAY_PALETTE.colormap(0), `gray t=${t}`);
  }
  for (const t of [1.001, 1.25, 2, 1e9]) {
    assert.deepEqual(BLUEWHITERED_PALETTE.colormap(t), BLUEWHITERED_PALETTE.colormap(1), `bwr t=${t}`);
    assert.deepEqual(GRAY_PALETTE.colormap(t), GRAY_PALETTE.colormap(1), `gray t=${t}`);
  }
  // the non-finite ends ride the same clamp (min/max order): ±Infinity lands
  // on the endpoints rather than emitting non-finite components
  assert.deepEqual(BLUEWHITERED_PALETTE.colormap(Infinity), [1, 0, 0]);
  assert.deepEqual(BLUEWHITERED_PALETTE.colormap(-Infinity), [0, 0, 1]);
});

test("off-domain: rainbow WRAPS its hue (the recorded exception), staying in gamut", () => {
  // rainbow's colormap is THE recipe's shared function — the byte-identity
  // anchor — so it cannot grow a clamp without editing the recipe. Its
  // historical behavior off-domain is a modulo hue wrap: in-gamut for any
  // finite t, but NOT saturating. Pinned so the difference is a recorded
  // fact, never a discovery.
  assert.deepEqual(RAINBOW_PALETTE.colormap(1.25), hsvToRgb(375, 1, 1), "wraps: 375° ≡ 15°");
  assert.deepEqual(RAINBOW_PALETTE.colormap(-0.25), hsvToRgb(-75, 1, 1), "wraps below zero too");
  for (const t of [-2, -0.25, 1.25, 3, 1e6]) {
    for (const c of RAINBOW_PALETTE.colormap(t)) {
      assert.ok(Number.isFinite(c) && c >= 0 && c <= 1, `rainbow t=${t}: ${c} out of gamut`);
    }
  }
});

// -- the assert-unreachable instrument --------------------------------------

test("colormapFor COUNTS ITS OWN CALLS — the hot-loop instrument cannot drift from the resolve", () => {
  // The once-per-binding guarantee is measured via this counter (S65), so
  // the counter must be tied to the RESOLVE by construction: it increments
  // inside colormapFor itself, never as a statement adjacent to a call site.
  // A colormapFor call moved into an element loop is therefore COUNTED — an
  // adjacent counter would keep reporting the old number while the
  // guarantee silently died (the inert-assertion defect class).
  const r0 = paletteResolutionCount();
  colormapFor(undefined);
  assert.equal(paletteResolutionCount(), r0 + 1, "the default fast path counts");
  colormapFor("gray");
  colormapFor("bluewhitered");
  assert.equal(paletteResolutionCount(), r0 + 3, "named resolves count");
  // simulate the bug the instrument exists to catch: a per-element resolve
  // over 100 elements is 100 counts — visible, not silent
  for (let i = 0; i < 100; i++) colormapFor("gray");
  assert.equal(paletteResolutionCount(), r0 + 103);
});

test("colormapFor: an unknown name COUNTS on the assert-unreachable instrument", () => {
  // The grammar refuses an unknown palette before a Binding exists, so this
  // branch is unreachable in production; the applier cannot throw mid-flip,
  // so it resolves to the default AND counts. A non-zero count in the running
  // viewer (debug.unknownPaletteHits) means an unvalidated name got through.
  const before = unknownPaletteHitCount();
  const cmap = colormapFor("no-such-palette");
  assert.equal(cmap, rainbow.colormap, "cannot throw in the hot path");
  assert.equal(unknownPaletteHitCount(), before + 1, "the branch is instrumented, not silent");
  colormapFor(undefined);
  colormapFor("rainbow");
  assert.equal(unknownPaletteHitCount(), before + 1, "a legitimate resolve never counts");
});
