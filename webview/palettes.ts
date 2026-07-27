/**
 * Palettes — the scalar→color ramps a BOUND color axis maps through. A
 * palette is DATA + one pure function: a name and a `colormap(t)` over
 * t ∈ [0,1] returning RGB in [0,1]. No palette carries a shader fragment, a
 * per-element table, or anything the renderer has to special-case — exactly
 * the closed-primitive discipline the style registry (styles.ts) and the
 * shape registry follow.
 *
 * WHY THIS EXISTS: a channel bound to a color axis re-derives per frame (the
 * mechanism for any live coloring), but the color it produced was hardcoded
 * to the one built-in hue sweep. Every animated coloring therefore looked
 * like that sweep, even when the same quantity written once used a
 * deliberately chosen ramp. A binding now carries WHICH palette it maps
 * through; naming none keeps the sweep.
 *
 * THE ANCHOR: `rainbow` is the FIRST registered palette (index 0 = the
 * default, styles.ts's `standard` discipline), so an unnamed colour binding
 * resolves to it and nothing else. Its sweep USED TO live on the `rainbow`
 * REPRESENTATION RECIPE, and the identity `RAINBOW_PALETTE.colormap ===
 * rainbow.colormap` was the byte-identity proof for every existing scene.
 * The recipe is gone; the sweep MOVED HERE VERBATIM (a palette is what it
 * always was — a name and a pure `colormap`), so this module now owns it and
 * imports nothing. What replaces the old anchor:
 *   - function identity, still asserted: `colormapFor(undefined) ===
 *     colormapFor("rainbow") === RAINBOW_PALETTE.colormap`, so naming the
 *     default costs nothing and cannot fork into a second implementation;
 *   - a CAPTURED-VALUE table (tests/palettes.test.ts) taken by RUNNING the
 *     pre-move recipe sweep, compared with exact `Object.is` equality — not
 *     a re-derivation of the formula, which is the one comparison that could
 *     agree with a wrong move.
 *
 * NO CAPACITY CAP, deliberately — unlike styles.ts, which fails closed at
 * MAX_STYLES because styles pack into a fixed `uniform vec4[]`. A palette is
 * a CPU-side function evaluated at write/flip cadence and never uploaded, so
 * there is no array to overflow and a cap would be invented ceremony.
 *
 * Pure module: no DOM, no Three, NO IMPORTS — unit-tested in Node.
 */

export interface Palette {
  name: string;
  /** t ∈ [0,1] → RGB in [0,1]. The MEANINGFUL domain is the closed [0,1]:
   * mapScalar is the ONE normalization/saturation lens and every production
   * caller passes through it.
   *
   * OFF-DOMAIN RULE (the belt, enforced by test): a finite t outside [0,1]
   * must still come out finite and in-gamut. `bluewhitered` and `gray`
   * SATURATE to their endpoint colors; `rainbow` keeps its historical
   * hue-WRAP — it cannot grow a clamp without breaking the captured-value
   * table that pins it to the pre-move sweep — which is in-gamut for any
   * finite t (hsvToRgb reduces the hue mod 360) and is pinned by
   * test so the difference is recorded, never discovered. NaN propagates
   * through every ramp (they are arithmetic on t); the gate's finiteness
   * spot-check owns that boundary, as it does for every channel consumer. */
  colormap: (t: number) => [number, number, number];
  /** One line for the `palettes` listing — which end is which, and what KIND
   * of ramp it is. Display only. */
  description: string;
}

/** Pure HSV → RGB (h in degrees, s/v in [0,1]; returns RGB in [0,1]). Moved
 * here verbatim from the retired `rainbow` recipe — the hue sweep below is its
 * only caller, and the sweep is a palette. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [r + m, g + m, b + m];
}

/** The hue sweep's far end: 0 → red … RAINBOW_HUE_MAX → magenta. Stops short
 * of 360 so the ramp's two ends never wrap back to the same color. */
export const RAINBOW_HUE_MAX = 300;

/** The built-in hue sweep, as a palette. The `colormap` expression is the
 * retired recipe's own, moved verbatim (see the header: the byte-identity
 * proof for every existing scene is now identity + a captured-value table). */
export const RAINBOW_PALETTE: Palette = {
  name: "rainbow",
  colormap: (t) => hsvToRgb(t * RAINBOW_HUE_MAX, 1, 1),
  // NOT described as "sequential": its perceived lightness is non-monotone
  // (measured: total L* descent 68.18 across 2048 steps, falling on 820 of
  // them, range 32.3..97.1 — derived by linearizing the emitted sRGB,
  // Rec. 709 luminance, then L*). A hue sweep encodes ORDER, not magnitude.
  description: "hue sweep — red (low) → magenta (high); hue-cyclic, lightness non-monotone; the default",
};

/**
 * The standard DIVERGING ramp: pure blue → white → pure red, piecewise
 * linear, with the HIGH end red. Named in RAMP ORDER (t=0 blue … t=1 red) so
 * the name itself says which end is which — the same construction as the
 * conventional blue-white-red diverging map.
 *
 * Exact by construction, no table: below the midpoint blue stays at 1 while
 * red and green rise to it; above it red stays at 1 while green and blue
 * fall. t=0 → (0,0,1) · t=0.5 → (1,1,1) · t=1 → (1,0,0). The entry clamp is
 * the OFF-DOMAIN belt (see Palette.colormap) — without it a finite t past
 * the ends would extrapolate out of gamut (t=1.25 → (1,−0.5,−0.5)).
 *
 * Known asymmetry, inherent to the conventional construction: the two ends
 * differ in perceived lightness — L* 32.3 (blue) vs 53.2 (red), a 20.9 gap
 * (same derivation as rainbow's numbers above) — so the low end reads
 * visually heavier. Recorded, not a defect.
 */
export const BLUEWHITERED_PALETTE: Palette = {
  name: "bluewhitered",
  colormap: (t) => {
    const s = Math.min(1, Math.max(0, t)); // the off-domain belt
    if (s <= 0.5) {
      const u = 2 * s; // 0 at the low end, 1 at white
      return [u, u, 1];
    }
    const u = 2 * (1 - s); // 1 at white, 0 at the high end
    return [1, u, u];
  },
  description: "diverging — blue (low) → white (mid) → red (high)",
};

// -- the L*-linear gray ramp ------------------------------------------------
//
// Constants below are the sRGB / CIE L* SPECIFICATION (not measurements):
// L* = 116·Y^(1/3) − 16 above the linear knee, L* = κ·Y below it with
// κ = 24389/27; sRGB encodes with the 12.92 / 1.055·c^(1/2.4) − 0.055
// transfer function. Both are inverted here, so the ramp is derived rather
// than transcribed from a color table.
const L_KAPPA = 24389 / 27; // the CIE linear-segment slope, exactly
const L_KNEE = 8; // L* at which the cube-root branch takes over

/** CIE L* (0..100) → relative luminance Y (0..1) — the standard inverse. */
export function lstarToLuminance(lstar: number): number {
  if (lstar <= L_KNEE) return lstar / L_KAPPA;
  const f = (lstar + 16) / 116;
  return f * f * f;
}

/** Relative luminance Y (0..1) → sRGB-encoded channel value (0..1). */
export function luminanceToSrgb(y: number): number {
  const c = Math.min(1, Math.max(0, y));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB-encoded channel value (0..1) → relative luminance Y — the inverse of
 * luminanceToSrgb, exported so a test can measure the ramp's uniformity by
 * recovering L* from the emitted RGB rather than trusting the construction. */
export function srgbToLuminance(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance Y → CIE L* — the inverse of lstarToLuminance. */
export function luminanceToLstar(y: number): number {
  return y <= lstarToLuminance(L_KNEE) ? y * L_KAPPA : 116 * Math.cbrt(y) - 16;
}

/**
 * A PERCEPTUALLY-UNIFORM SEQUENTIAL ramp: black → white with CIE lightness
 * LINEAR in t (L* = 100·t), i.e. equal steps in t are equal perceived
 * lightness steps. A naive `[t,t,t]` is NOT this — sRGB is gamma-encoded, so
 * its perceived lightness rises steeply near black. Distinct in KIND from
 * the other two: no hue at all, which is the honest ramp when hue already
 * carries a different meaning in the scene.
 *
 * Uniformity is a MEASURED property here, not an assertion: the unit test
 * recovers L* from the emitted RGB (srgbToLuminance → luminanceToLstar) and
 * pins the maximum deviation from 100·t.
 */
export const GRAY_PALETTE: Palette = {
  name: "gray",
  colormap: (t) => {
    // the entry clamp is the OFF-DOMAIN belt (see Palette.colormap):
    // off-domain t saturates to the black/white endpoints
    const c = luminanceToSrgb(lstarToLuminance(100 * Math.min(1, Math.max(0, t))));
    return [c, c, c];
  },
  description: "sequential, perceptually uniform — black (low) → white (high), CIE L* linear in t",
};

// -- the registry (styles.ts's shape: registration order, name → index) -----

const palettes = new Map<string, Palette>();

/** The mod-name character rule (recipes.ts NAME_RE), reused verbatim: a
 * palette name rides `save_rep`'s emitted `?palette=<name>` line, so a name
 * carrying whitespace, `?`, or a quote would write a mod file the command
 * parser later refuses. Fail LOUDLY at registration, not at replay. */
const PALETTE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export function registerPalette(palette: Palette): void {
  if (!PALETTE_NAME_RE.test(palette.name)) {
    throw new Error(
      `invalid palette name "${palette.name}" — lowercase letters, digits, "_", "-" (must start with a letter); the name is embedded in save_rep's replay line`,
    );
  }
  palettes.set(palette.name, palette);
}

/** A palette's index in REGISTRATION ORDER — the order `listPalettes`
 * enumerates and the `palettes` verb prints. -1 = unknown, styleIndex's
 * contract, and the ONE membership test the fail-closed argument resolver
 * uses (`>= 0` = registered). Index 0 is the default. */
export function paletteIndex(name: string): number {
  let i = 0;
  for (const p of palettes.values()) {
    if (p.name === name) return i;
    i++;
  }
  return -1;
}

/** Every registered palette, in registration order. */
export function listPalettes(): Palette[] {
  return [...palettes.values()];
}

/** Registered names, registration order — the completion pool and the
 * refusal message's list, single-sourced from the registry itself. */
export function paletteNames(): string[] {
  return listPalettes().map((p) => p.name);
}

registerPalette(RAINBOW_PALETTE);
registerPalette(BLUEWHITERED_PALETTE);
registerPalette(GRAY_PALETTE);

/** The default palette's NAME — index 0, by construction (asserted in the
 * unit suite so a reordered registration cannot silently move the default). */
export const DEFAULT_PALETTE_NAME = RAINBOW_PALETTE.name;

/**
 * THE hot-path resolver: a binding's stored palette name → the colormap
 * function. `undefined` (the canonical "on the default" state — see
 * Binding.palette) returns the default's colormap, which IS the ONE
 * `RAINBOW_PALETTE.colormap` object `?palette=rainbow` also resolves to, so
 * an unnamed palette costs nothing and changes nothing.
 *
 * Callers resolve ONCE per binding (never per element): the per-flip applier
 * hoists this above its element loops, and applyScalarsToAxis calls it once
 * at entry. That guarantee is INSTRUMENTED HERE, not at the call sites: the
 * resolution counter increments inside this function (unknownPaletteHits'
 * pattern), so it is tied to the resolve by construction — a call moved into
 * an element loop is COUNTED, where a counter merely adjacent to the call
 * would keep reporting the old number while the guarantee silently died.
 * S65 reads the counter's delta across pure seeks (no commands between), so
 * the command-cadence resolutions (bake / a bind's initial write) that also
 * land here never pollute the measurement.
 *
 * An UNKNOWN name is unreachable by construction — every entry point
 * (splitPaletteOption) refuses an unregistered name before a Binding is
 * built, and palettes are registered at module load and never unregistered.
 * It resolves to the default here only so the applier cannot throw mid-flip,
 * and that branch INCREMENTS unknownPaletteHits — the assert-unreachable
 * instrument (missingBoundBlockHits' discipline: a test pins it at 0; a
 * non-zero value means an unvalidated name reached the applier and the
 * silent-fallback rule was broken).
 */
export function colormapFor(name: string | undefined): (t: number) => [number, number, number] {
  resolutions++;
  if (name === undefined) return RAINBOW_PALETTE.colormap;
  const p = palettes.get(name);
  if (p === undefined) {
    unknownPaletteHits++;
    return RAINBOW_PALETTE.colormap;
  }
  return p.colormap;
}

let resolutions = 0;
let unknownPaletteHits = 0;

/** Total colormapFor calls — the once-per-BINDING hot-loop instrument (see
 * colormapFor's header). Exposed as debug.paletteResolutions. */
export function paletteResolutionCount(): number {
  return resolutions;
}

/** Times colormapFor was handed a name no registered palette carries —
 * asserted unreachable (see colormapFor). Exposed on the viewer's debug
 * surface next to missingBoundBlockHits. */
export function unknownPaletteHitCount(): number {
  return unknownPaletteHits;
}
