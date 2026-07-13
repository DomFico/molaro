/**
 * GLSL sources for the impostor point pass and the two overlay passes —
 * pure string builders, no Three.js, no DOM (unit-testable in Node).
 *
 * Single-sourcing is the point of this module. Every material that sizes a
 * point sprite embeds THE SAME sizing chunk (`IMPOSTOR_SIZING_CHUNK`), so the
 * base pass and the overlays cannot disagree about how a stored size value
 * becomes pixels: world radius = uWorldPerSize (`k`, one scene-scale constant)
 * × the per-point size value, projected by uPxPerWorld at the vertex's view
 * depth. The uniform OBJECTS behind those two names are shared across all
 * consuming materials in main.ts, so the values cannot fork either.
 *
 * The depth-variant switch (a development/measurement switch — NOT a user
 * surface): the point fragment shader carries both behaviors in one source,
 * selected by the IMPOSTOR_DEPTH define. Undefined (variant 1) the sprite
 * keeps its flat point-centre depth — early-Z preserved, interpenetration
 * approximate. Defined (variant 2) the fragment writes analytic
 * sphere-surface depth via gl_FragDepth — correct interpenetration, early-Z
 * lost. The choice between them is made outside this lane, on real-hardware
 * measurements; all geometry passes must follow ONE variant (a mixed scene
 * clips wrongly exactly at the primitive junctions).
 */

/** The define name selecting depth variant 2 (analytic gl_FragDepth). */
export const IMPOSTOR_DEPTH_DEFINE = "IMPOSTOR_DEPTH";

/**
 * Shared vertex-shader chunk: the two sizing uniforms + the one projection
 * function. `uWorldPerSize` is `k` (world units per size-buffer unit);
 * `uPxPerWorld` is drawingBufferHeight / (2·tan(fov/2)), updated on resize.
 */
export const IMPOSTOR_SIZING_CHUNK = `
uniform float uWorldPerSize;
uniform float uPxPerWorld;
float impostorDiameterPx(float worldRadius, float viewDepth) {
  return 2.0 * worldRadius * uPxPerWorld / max(viewDepth, 1e-6);
}
`;

/** Base points pass: ray-traced sphere impostors reading aColor/aSize/
 * aVisible/aOpacity. Shading is a fixed headlight Lambert (0.55 + 0.45·n·v) —
 * depth and volume, no new art direction, hue-preserving. */
export function pointShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      attribute vec3 aColor; attribute float aSize; attribute float aVisible;
      attribute float aOpacity;
      ${IMPOSTOR_SIZING_CHUNK}
      varying vec3 vColor; varying float vVisible; varying float vOpacity;
      varying float vRadius; varying float vViewDepth;
      void main() {
        vColor = aColor; vVisible = aVisible; vOpacity = aOpacity;
        vRadius = uWorldPerSize * aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aVisible > 0.5 ? impostorDiameterPx(vRadius, vViewDepth) : 0.0;
      }`,
    fragment: `
      uniform vec2 uProjZ;
      varying vec3 vColor; varying float vVisible; varying float vOpacity;
      varying float vRadius; varying float vViewDepth;
      void main() {
        // zero alpha AND zero radius are literal zeros: no fragment survives,
        // no depth is written (invisible-but-present stays hole-free).
        if (vVisible < 0.5 || vOpacity <= 0.0 || vRadius <= 0.0) discard;
        vec2 pc = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(pc, pc);
        if (r2 > 1.0) discard;
        float nz = sqrt(1.0 - r2);
        float shade = 0.55 + 0.45 * nz;
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic sphere-surface depth: this fragment is nearer than the
        // sprite's centre by nz*radius; re-project view z through the
        // projection's z row (uProjZ = [P22, P32], aspect-independent).
        float zView = -(vViewDepth - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(vColor * shade, vOpacity);
      }`,
  };
}

/**
 * Edge tube pass: instanced camera-facing quads with real world thickness.
 * One quad (4 static corner vertices, 6 indices) instanced per edge; the
 * per-instance attributes split by update cadence (iStart/iEnd every
 * displayed-frame flip; iVisible on visibility change; iRadius/iColor on
 * representation writes only). Instance slot ≡ header edge index — never
 * compacted, so the GPU arrays share the rep buffers' element order with no
 * remap anywhere.
 *
 * World radius = uWorldPerSize × iRadius — the SAME `k` uniform object the
 * point pass reads, so the default point:edge ratio (3:1) is geometric.
 * Shading is the cylinder profile of the sphere pass's headlight Lambert.
 * Depth follows the ONE global variant: undefined, fragments keep the
 * quad's interpolated AXIS depth (the billboard plane contains the axis,
 * so at a shared endpoint tube and sphere agree exactly — no junction
 * hole); defined, fragments write analytic cylinder-surface depth through
 * the same uProjZ row the sphere pass uses.
 */
export function edgeTubeShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      // static per-corner: x = side (-1 | +1 across width), y = end (0 | 1)
      attribute vec2 aCorner;
      attribute vec3 iStart; attribute vec3 iEnd;
      attribute float iVisible; attribute float iRadius; attribute vec4 iColor;
      uniform float uWorldPerSize;
      varying vec4 vColor; varying float vU;
      varying float vRadius; varying float vViewDepth;
      void main() {
        float radius = uWorldPerSize * iRadius;
        vec3 mvA = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
        vec3 mvB = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
        vec3 seg = mvB - mvA;
        // collapsed instances (hidden edge, zero radius, degenerate segment)
        // leave the clip volume entirely — no fragments, no depth writes
        if (iVisible < 0.5 || radius <= 0.0 || dot(seg, seg) < 1e-16) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColor = vec4(0.0); vU = 0.0; vRadius = 0.0; vViewDepth = 1.0;
          return;
        }
        vec3 axis = normalize(seg);
        vec3 toCam = -normalize(mvA + mvB); // midpoint view direction
        vec3 s = cross(axis, toCam);
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(0.0, 1.0, 0.0));
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(1.0, 0.0, 0.0));
        vec3 side = normalize(s);
        vec3 self = aCorner.y < 0.5 ? mvA : mvB;
        vec3 pos = self + side * (aCorner.x * radius);
        vColor = iColor;
        vU = aCorner.x;
        vRadius = radius;
        vViewDepth = -self.z;
        gl_Position = projectionMatrix * vec4(pos, 1.0);
      }`,
    fragment: `
      uniform vec2 uProjZ;
      varying vec4 vColor; varying float vU;
      varying float vRadius; varying float vViewDepth;
      void main() {
        // zero alpha is a literal zero: no fragment, no depth hole
        if (vColor.a <= 0.0) discard;
        float nz = sqrt(max(1.0 - vU * vU, 0.0));
        float shade = 0.55 + 0.45 * nz;
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic cylinder-surface depth: nearer than the axis by nz*radius
        float zView = -(vViewDepth - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(vColor.rgb * shade, vColor.a);
      }`,
  };
}

/** Pending-target overlay: flat tint (depthTest off — a highlight, not
 * geometry) silhouette-matched to the base sphere: same aSize, same chunk,
 * same radius. uFloor keeps the breathing pulse from fading out fully. */
export function highlightShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      attribute float aVisible; attribute float aFlag; attribute float aSize;
      ${IMPOSTOR_SIZING_CHUNK}
      uniform float uStrength; uniform float uFloor;
      varying float vShow; varying float vK;
      void main() {
        vK = uFloor + (1.0 - uFloor) * uStrength;
        float radius = uWorldPerSize * aSize;
        vShow = (aFlag > 0.5 && aVisible > 0.5 && vK > 0.01 && radius > 0.0) ? 1.0 : 0.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = vShow > 0.5 ? impostorDiameterPx(radius, -mv.z) : 0.0;
      }`,
    fragment: `
      uniform vec3 uColor; varying float vShow; varying float vK;
      void main() {
        if (vShow < 0.5) discard;
        vec2 pc = gl_PointCoord * 2.0 - 1.0;
        float d = length(pc);
        if (d > 1.0) discard;
        float a = 0.88 * vK * smoothstep(1.0, 0.82, d);
        if (a < 0.02) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  };
}

/** Focus-flash overlay: like the highlight, blending 50% toward the
 * selection tint on selected points; same silhouette adoption. */
export function focusFlashShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      attribute float aVisible; attribute float aFlag; attribute float aSel;
      attribute float aSize;
      ${IMPOSTOR_SIZING_CHUNK}
      uniform float uStrength;
      varying float vShow; varying float vK; varying float vSel;
      void main() {
        vK = uStrength;
        vSel = aSel;
        float radius = uWorldPerSize * aSize;
        vShow = (aFlag > 0.5 && aVisible > 0.5 && vK > 0.01 && radius > 0.0) ? 1.0 : 0.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = vShow > 0.5 ? impostorDiameterPx(radius, -mv.z) : 0.0;
      }`,
    fragment: `
      uniform vec3 uColor; uniform vec3 uSelColor;
      varying float vShow; varying float vK; varying float vSel;
      void main() {
        if (vShow < 0.5) discard;
        vec2 pc = gl_PointCoord * 2.0 - 1.0;
        float d = length(pc);
        if (d > 1.0) discard;
        float a = 0.88 * vK * smoothstep(1.0, 0.82, d);
        if (a < 0.02) discard;
        vec3 c = vSel > 0.5 ? mix(uColor, uSelColor, 0.5) : uColor;
        gl_FragColor = vec4(c, a);
      }`,
  };
}
