/**
 * Styles — surface-shading parameter sets. A style is DATA, NEVER CODE: a
 * fixed struct of numbers consumed as shader uniforms by the ONE shared
 * shading chunk (shaders.ts IMPOSTOR_SHADE_CHUNK). No style carries a shader
 * fragment, a tessellator, or anything executable — that boundary is the
 * whole point of the axis (the closed-primitive discipline the typed-result
 * union and the mod `produces` keys already follow).
 *
 * Scope is deliberately exactly the parameters the shared shading path used
 * as hardcoded constants before this module existed — nothing invented:
 *
 *   shade(color, nz) = color * (lambertFloor + lambertScale * nz)
 *                      + specStrength * max(nz, 0)^specPower
 *
 * THE ANCHOR: `standard` reproduces the former constants EXACTLY — with it
 * selected (the default, and tonight the only selectable state) the picture
 * is byte-identical to before styles existed. The E2E fast lane pins that.
 *
 * NOT style, by decision: transparency, blending, depth behavior — those are
 * scene-level correctness switches (the depth variant is global because a
 * mixed scene clips wrongly at junctions; translucency ordering is the
 * recorded OIT follow-up). A style struct must never grow toward them.
 *
 * Pure module: no DOM, no Three — unit-tested in Node.
 */

export interface Style {
  name: string;
  /** Lambert term floor: the shade at nz = 0 (grazing). */
  lambertFloor: number;
  /** Lambert term scale: floor + scale = the shade at nz = 1 (facing). */
  lambertScale: number;
  /** Specular highlight strength (0 = matte). */
  specStrength: number;
  /** Specular exponent — higher = tighter highlight. */
  specPower: number;
}

/** The default — BYTE-IDENTICAL to the constants the shading chunk carried
 * before styles existed (0.55/0.45 Lambert, 0.35·nz^48 specular). Pinned by
 * unit test AND by the fast lane's pixel scenarios. Do not retune casually:
 * changing these is a deliberate look change, not a refactor. */
export const STANDARD_STYLE: Style = {
  name: "standard",
  lambertFloor: 0.55,
  lambertScale: 0.45,
  specStrength: 0.35,
  specPower: 48,
};

/** A second style AS DATA. Differs from standard only in the specular
 * term: proof the axis composes without touching shape or channels. */
export const MATTE_STYLE: Style = {
  name: "matte",
  lambertFloor: 0.55,
  lambertScale: 0.45,
  specStrength: 0,
  specPower: 48,
};

const styles = new Map<string, Style>();

/** Shader-side capacity: styles pack into `uniform vec4 uStyles[MAX_STYLES]`
 * (one vec4 per style — floor/scale/strength/power packs exactly). The
 * registry fails CLOSED at capacity rather than silently truncating the
 * uniform array. */
export const MAX_STYLES = 8;

export function registerStyle(style: Style): void {
  if (!styles.has(style.name) && styles.size >= MAX_STYLES) {
    throw new Error(`style registry is full (${MAX_STYLES}) — cannot register "${style.name}"`);
  }
  styles.set(style.name, style);
}

/** A style's shader index — REGISTRATION ORDER, the same order
 * stylesAsUniformArray packs. -1 = unknown. Index 0 is `standard` (the
 * default: every style buffer initializes to 0). */
export function styleIndex(name: string): number {
  let i = 0;
  for (const s of styles.values()) {
    if (s.name === name) return i;
    i++;
  }
  return -1;
}

/** The registry packed for `uniform vec4 uStyles[MAX_STYLES]` — flat
 * [floor, scale, strength, power] × MAX_STYLES, zero-padded past the
 * registered count (unreachable: element style ids only ever come from
 * styleIndex lookups of registered names). */
export function stylesAsUniformArray(): Float32Array {
  const out = new Float32Array(MAX_STYLES * 4);
  let i = 0;
  for (const s of styles.values()) {
    out[i * 4] = s.lambertFloor;
    out[i * 4 + 1] = s.lambertScale;
    out[i * 4 + 2] = s.specStrength;
    out[i * 4 + 3] = s.specPower;
    i++;
  }
  return out;
}

export function getStyle(name: string): Style | undefined {
  return styles.get(name);
}

/** Every registered style, in registration order. */
export function listStyles(): Style[] {
  return [...styles.values()];
}

registerStyle(STANDARD_STYLE);
registerStyle(MATTE_STYLE);
