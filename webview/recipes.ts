/**
 * Recipes — stored, named functions over a resolved target that write a
 * representation buffer. A recipe is the generalization of the twelve fixed
 * representation verbs (which write one CONSTANT value) into ones that
 * COMPUTE a value that varies per element as a function of the resolved set.
 *
 * The contract: a recipe produces, for a resolved point set, a per-element
 * scalar in [0, 1] (`compute`), and its axis renders those scalars through a
 * `colormap` (scalar → RGB) before the write. The scalar-then-colormap split
 * is deliberate: the mapping-and-write step (applyColorScalars in
 * commands.ts) takes an array of scalars and does not know where they came
 * from, so a future scalar source reuses the identical step. Do not collapse
 * a recipe into a direct RGB function.
 *
 * The registry below is STORAGE ONLY — a name → recipe map a future
 * read-face can list. No listing command, no serialization, no files.
 *
 * Pure module: no DOM, no Three — unit-tested directly under `node --test`.
 */

export interface Recipe {
  name: string;
  /** The buffer family the recipe writes. Only the point-color axis exists
   * today; the field is here so later axes extend the shape, not fork it. */
  axis: "point-color";
  /** Per-element scalar in [0, 1], one per point, in the GIVEN order (the
   * resolved set's existing order — resolution order is the recipe's axis). */
  compute(points: readonly number[]): number[];
  /** scalar in [0,1] → RGB, each component in [0,1]. */
  colormap(t: number): [number, number, number];
}

/** Pure HSV → RGB (h in degrees, s/v in [0,1]; returns RGB in [0,1]). */
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

/** The rainbow hue sweep: 0 → red … RAINBOW_HUE_MAX → magenta. Stops short
 * of 360 so the ramp's two ends never wrap back to the same color. */
export const RAINBOW_HUE_MAX = 300;

/** `rainbow` — the first recipe: an even ramp from 0 to 1 across the
 * resolved set in its existing order, rendered through one built-in hue
 * sweep. A single-point set yields [0] (no divide-by-zero). */
export const rainbow: Recipe = {
  name: "rainbow",
  axis: "point-color",
  compute: (points) => points.map((_, i) => i / Math.max(points.length - 1, 1)),
  colormap: (t) => hsvToRgb(t * RAINBOW_HUE_MAX, 1, 1),
};

// -- the in-memory recipe registry (storage only) -------------------------------

const recipes = new Map<string, Recipe>();

export function registerRecipe(recipe: Recipe): void {
  recipes.set(recipe.name, recipe);
}

export function getRecipe(name: string): Recipe | undefined {
  return recipes.get(name);
}

registerRecipe(rainbow);
