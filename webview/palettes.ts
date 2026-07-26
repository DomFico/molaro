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
 * default, styles.ts's `standard` discipline) and its `colormap` is THE SAME
 * FUNCTION OBJECT the recipe carries — not a copy of the formula. So "the
 * default path is unchanged" is a function-identity fact a unit test asserts
 * (`RAINBOW_PALETTE.colormap === rainbow.colormap`), not a numeric
 * comparison that could drift.
 *
 * NO CAPACITY CAP, deliberately — unlike styles.ts, which fails closed at
 * MAX_STYLES because styles pack into a fixed `uniform vec4[]`. A palette is
 * a CPU-side function evaluated at write/flip cadence and never uploaded, so
 * there is no array to overflow and a cap would be invented ceremony.
 *
 * Pure module: no DOM, no Three — unit-tested in Node.
 */
import { rainbow } from "./recipes.ts";

export interface Palette {
  name: string;
  /** t ∈ [0,1] → RGB in [0,1]. Total: callers pass mapScalar's saturated
   * output, and every registered ramp is defined on the closed interval. */
  colormap: (t: number) => [number, number, number];
  /** One line for the `palettes` listing — which end is which, and what KIND
   * of ramp it is. Display only. */
  description: string;
}

/** The built-in hue sweep, as a palette: THE recipe's own colormap function,
 * shared by reference (see the header — this identity is the byte-identity
 * proof for every existing scene). */
export const RAINBOW_PALETTE: Palette = {
  name: "rainbow",
  colormap: rainbow.colormap,
  description: "sequential hue sweep — red (low) → magenta (high); the default",
};

/**
 * The standard DIVERGING ramp: pure blue → white → pure red, piecewise
 * linear, with the HIGH end red. Named in RAMP ORDER (t=0 blue … t=1 red) so
 * the name itself says which end is which — the same construction as the
 * conventional blue-white-red diverging map.
 *
 * Exact by construction, no table: below the midpoint blue stays at 1 while
 * red and green rise to it; above it red stays at 1 while green and blue
 * fall. t=0 → (0,0,1) · t=0.5 → (1,1,1) · t=1 → (1,0,0).
 */
export const BLUEWHITERED_PALETTE: Palette = {
  name: "bluewhitered",
  colormap: (t) => {
    if (t <= 0.5) {
      const u = 2 * t; // 0 at the low end, 1 at white
      return [u, u, 1];
    }
    const u = 2 * (1 - t); // 1 at white, 0 at the high end
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
    const c = luminanceToSrgb(lstarToLuminance(100 * Math.min(1, Math.max(0, t))));
    return [c, c, c];
  },
  description: "sequential, perceptually uniform — black (low) → white (high), CIE L* linear in t",
};

// -- the registry (styles.ts's shape: registration order, name → index) -----

const palettes = new Map<string, Palette>();

export function registerPalette(palette: Palette): void {
  palettes.set(palette.name, palette);
}

export function getPalette(name: string): Palette | undefined {
  return palettes.get(name);
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
 * Binding.palette) returns the default's colormap, which IS
 * `rainbow.colormap` by reference, so an unnamed palette costs nothing and
 * changes nothing.
 *
 * Callers resolve ONCE per binding (never per element): the per-flip applier
 * hoists this above its element loops, and applyScalarsToAxis calls it once
 * at entry.
 *
 * An UNKNOWN name is unreachable by construction — every entry point
 * (resolvePaletteOption) refuses an unregistered name before a Binding is
 * built, and palettes are registered at module load and never unregistered.
 * It resolves to the default here only so the applier cannot throw mid-flip,
 * and that branch INCREMENTS unknownPaletteHits — the assert-unreachable
 * instrument (missingBoundBlockHits' discipline: a test pins it at 0; a
 * non-zero value means an unvalidated name reached the applier and the
 * silent-fallback rule was broken).
 */
export function colormapFor(name: string | undefined): (t: number) => [number, number, number] {
  if (name === undefined) return RAINBOW_PALETTE.colormap;
  const p = palettes.get(name);
  if (p === undefined) {
    unknownPaletteHits++;
    return RAINBOW_PALETTE.colormap;
  }
  return p.colormap;
}

let unknownPaletteHits = 0;

/** Times colormapFor was handed a name no registered palette carries —
 * asserted unreachable (see colormapFor). Exposed on the viewer's debug
 * surface next to missingBoundBlockHits. */
export function unknownPaletteHitCount(): number {
  return unknownPaletteHits;
}
