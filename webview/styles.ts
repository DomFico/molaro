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

/** A second style AS DATA — registered and unit-tested, but not selectable
 * from any surface tonight (the style-assignment verb is a later, attended
 * increment). Differs from standard only in the specular term: proof the
 * axis composes without touching shape or channels. */
export const MATTE_STYLE: Style = {
  name: "matte",
  lambertFloor: 0.55,
  lambertScale: 0.45,
  specStrength: 0,
  specPower: 48,
};

const styles = new Map<string, Style>();

export function registerStyle(style: Style): void {
  styles.set(style.name, style);
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
