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

/** Dash period per stored dash unit, in multiples of the scene's k
 * (uWorldPerSize — the ONE world-anchoring constant every radius already
 * rides, so a dash unit means the same thing on every dataset scale).
 * `edgeDash d` → period = d × DASH_SCALE × k world units: world-length,
 * zoom-STABLE (zooming magnifies dashes with the geometry — it never
 * changes how many fit along an edge). At d=1 the period is 6k — twice the
 * default sphere radius (3k), so default-look dashes read at sphere scale. */
export const DASH_SCALE = 6.0;
/** Lit fraction of each dash period (the rest is gap). */
export const DASH_DUTY = 0.6;

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

/**
 * Shared fragment shading: headlight Lambert + ONE restrained specular
 * highlight. The light is the headlight (along the view axis), so the
 * Blinn half-vector is ~the view axis and the term reduces to a power of
 * the surface normal's view-space z — the same `nz` every impostor already
 * computes. One highlight, no second light, no environment: just enough
 * for a sphere to read as ROUND instead of clay. Consumed by every
 * geometry fragment (spheres, edge tubes, trace tubes).
 *
 * The four shading numbers are UNIFORMS — a STYLE (webview/styles.ts) is a
 * set of values for them, data never code. The uniform OBJECTS are shared
 * across all consuming materials (main.ts), one instance each, so the
 * values cannot fork between passes; the default style's values are
 * byte-identical to the constants this chunk carried before styles
 * existed (pinned by unit test and the pixel scenarios).
 */
/** VERTEX-side style plumbing: the style registry packs into ONE vec4
 * array uniform (x=lambertFloor, y=lambertScale, z=specStrength,
 * w=specPower); each vertex looks its element's style up BY INDEX and
 * hands the params to the fragment as a varying. The lookup lives in the
 * VERTEX stage on purpose — GLSL ES 1.00 guarantees dynamic uniform-array
 * indexing there but not in fragments, and every pass's style id is
 * constant across a primitive (points are single-vertex; edge/trace quads
 * carry one id per instance), so the varying never actually blends. */
export const STYLE_VERTEX_CHUNK = `
uniform vec4 uStyles[8];
varying vec4 vStyleParams;
vec4 styleParams(float id) {
  return uStyles[int(id + 0.5)];
}
`;

/** FRAGMENT-side shade: the same formula the chunk always carried, with
 * the parameters arriving per element via the style varying instead of
 * four scalar uniforms. Style index 0 (`standard`, every buffer's default)
 * packs the EXACT former constants — byte-identical default look. */
export const IMPOSTOR_SHADE_CHUNK = `
varying vec4 vStyleParams;
vec3 impostorShade(vec3 color, float nz) {
  float lambert = vStyleParams.x + vStyleParams.y * nz;
  float spec = vStyleParams.z * pow(max(nz, 0.0), vStyleParams.w);
  return color * lambert + vec3(spec);
}
`;

/**
 * ALPHA-CLASS SPLIT — the chunk that ends view-dependent transparency.
 *
 * Every geometry pass now draws TWICE: once for its fully opaque instances
 * (depth write ON, so they occlude properly) and once for its translucent ones
 * (depth write OFF, so they cannot delete one another). `uAlphaPass` tells a
 * draw which half it is; instances belonging to the other half collapse out
 * exactly the way hidden ones already do, so this adds no new idiom.
 *
 * WHY. One pass that blends AND writes depth keeps a fragment only if it is
 * nearer than every fragment already drawn at that pixel — and instances are
 * drawn in HEADER order, never depth order. The layers that survive are
 * therefore the running minima of an arbitrary sequence. Rotate the camera 180°
 * and that sequence reverses: a 15-layer accumulation becomes one layer, and
 * the same atoms at the same alpha read as solid from one side and see-through
 * from the other. Measured on adk (3341 atoms, pointsize 20, alpha 0.15): the
 * front/back mean-brightness gap was 7.9 with the depth stamp and 0.2 without.
 *
 * It is also why a faded bond still hid the trace behind it: at alpha 0.1 the
 * bond's own pixels were 99.8% gone, but its depth stamp still rejected the
 * trace. One cause, both symptoms.
 *
 * WHY NOT JUST TURN DEPTH WRITING OFF. Then opaque geometry would stop
 * occluding anything, and the analytic per-fragment depth chosen for correct
 * interpenetration (variant 2) would have nothing to write into. The split
 * keeps depth exactly where it is meaningful and removes it only where it was
 * destroying information.
 */
export const ALPHA_PASS_CHUNK = `
uniform float uAlphaPass;  // 0 = the opaque half, 1 = the translucent half
bool inAlphaPass(float alpha) { return uAlphaPass < 0.5 ? alpha >= 1.0 : alpha < 1.0; }
`;

/** Base points pass: ray-traced sphere impostors reading aColor/aSize/
 * aVisible/aOpacity. Shading is the shared impostorShade chunk (headlight
 * Lambert + one restrained specular highlight). */
export function pointShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      attribute vec3 aColor; attribute float aSize; attribute float aVisible;
      attribute float aOpacity; attribute float aStyle;
      ${IMPOSTOR_SIZING_CHUNK}
      ${STYLE_VERTEX_CHUNK}
      ${ALPHA_PASS_CHUNK}
      varying vec3 vColor; varying float vVisible; varying float vOpacity;
      varying float vRadius; varying float vViewDepth;
      void main() {
        vColor = aColor; vVisible = aVisible; vOpacity = aOpacity;
        vStyleParams = styleParams(aStyle);
        vRadius = uWorldPerSize * aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
        // a zero-diameter sprite rasterizes nothing — the same collapse hidden
        // points already used, now also carrying the alpha-class split
        gl_PointSize = (aVisible > 0.5 && inAlphaPass(aOpacity))
          ? impostorDiameterPx(vRadius, vViewDepth) : 0.0;
      }`,
    fragment: `
      uniform vec2 uProjZ;
      ${IMPOSTOR_SHADE_CHUNK}
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
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic sphere-surface depth: this fragment is nearer than the
        // sprite's centre by nz*radius; re-project view z through the
        // projection's z row (uProjZ = [P22, P32], aspect-independent).
        float zView = -(vViewDepth - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(impostorShade(vColor, nz), vOpacity);
      }`,
  };
}

/**
 * Edge tube pass: instanced camera-facing quads with real world thickness.
 * One quad (4 static corner vertices, 6 indices) instanced per edge; the
 * per-instance attributes split by update cadence (iStart/iEnd every
 * displayed-frame flip; iVisible on visibility change; iRadius/iColorA/
 * iColorB on representation writes only). Instance slot ≡ header edge index — never
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
      // EDGE TUBE static per-corner: x = side (-1 | +1 across width), y = end (0 | 1)
      attribute vec2 aCorner;
      attribute vec3 iStart; attribute vec3 iEnd;
      attribute float iVisible; attribute float iRadius;
      // per-END RGBA (the bicolor pair): both are flat per instance — every
      // corner carries both values and the FRAGMENT picks its half by the
      // along-axis coordinate, so the split is a world-space plane through
      // the tube's midpoint, not a corner interpolation
      attribute vec4 iColorA; attribute vec4 iColorB;
      // per-EDGE dash scale (0 = solid); rep-write cadence, like iRadius
      attribute float iDash;
      attribute float iStyle;
      // endpoint SPHERE sizes (rep-write cadence, like iRadius): the tube is
      // trimmed analytically to the sphere it meets — see the fragment shader
      attribute float iSizeA; attribute float iSizeB;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
      ${ALPHA_PASS_CHUNK}
      varying vec4 vColorA; varying vec4 vColorB; varying float vU;
      varying float vRadius;
      varying float vT; varying float vLen;
      varying float vDA; varying float vDB;
      varying float vDepthA; varying float vDepthB;
      varying float vRsA; varying float vRsB;
      varying float vDash;
      void main() {
        vStyleParams = styleParams(iStyle);
        float radius = uWorldPerSize * iRadius;
        vec3 mvA = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
        vec3 mvB = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
        vec3 seg = mvB - mvA;
        float len = length(seg);
        float rsA = uWorldPerSize * iSizeA;
        float rsB = uWorldPerSize * iSizeB;
        // trim distance: stopping the tube at d = sqrt(rs² − rt²) puts its
        // end ring EXACTLY on the endpoint's sphere surface, from every
        // viewing angle. rs ≤ rt clamps to 0 (exposed end → capped).
        float dA = sqrt(max(0.0, rsA * rsA - radius * radius));
        float dB = sqrt(max(0.0, rsB * rsB - radius * radius));
        // collapsed instances (hidden edge, zero radius, degenerate segment,
        // a tube swallowed whole by its endpoint spheres, or an instance
        // belonging to the OTHER alpha half) leave the clip volume entirely —
        // no fragments, no depth writes
        if (iVisible < 0.5 || radius <= 0.0 || len * len < 1e-16 || dA + dB >= len
            || !inAlphaPass(min(iColorA.a, iColorB.a))) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColorA = vec4(0.0); vColorB = vec4(0.0); vU = 0.0; vRadius = 0.0;
          vT = 0.0; vLen = 1.0; vDA = 0.0; vDB = 0.0;
          vDepthA = 1.0; vDepthB = 1.0; vRsA = 0.0; vRsB = 0.0;
          vDash = 0.0;
          return;
        }
        vec3 axis = seg / len;
        vec3 toCam = -normalize(mvA + mvB); // midpoint view direction
        vec3 s = cross(axis, toCam);
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(0.0, 1.0, 0.0));
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(1.0, 0.0, 0.0));
        vec3 side = normalize(s);
        // the quad EXTENDS one radius past each trimmed end so the fragment
        // shader — not the quad boundary — decides where the tube ends (the
        // cylinder's end seen at an angle reaches beyond the axis endpoint;
        // covered ends discard there, exposed ends grow a cap there)
        float t = aCorner.y < 0.5 ? (dA - radius) : (len - dB + radius);
        vec3 pos = mvA + axis * t + side * (aCorner.x * radius);
        vColorA = iColorA; vColorB = iColorB;
        vU = aCorner.x;
        vRadius = radius;
        vT = t; vLen = len; vDA = dA; vDB = dB;
        vDepthA = -mvA.z; vDepthB = -mvB.z;
        vRsA = rsA; vRsB = rsB;
        // the dash unit is ANCHORED to k here (world units per stored dash
        // unit), so the fragment's period is a plain world length
        vDash = iDash * uWorldPerSize;
        gl_Position = projectionMatrix * vec4(pos, 1.0);
      }`,
    fragment: `
      uniform vec2 uProjZ;
      ${IMPOSTOR_SHADE_CHUNK}
      varying vec4 vColorA; varying vec4 vColorB; varying float vU;
      varying float vRadius;
      varying float vT; varying float vLen;
      varying float vDA; varying float vDB;
      varying float vDepthA; varying float vDepthB;
      varying float vRsA; varying float vRsB;
      varying float vDash;
      void main() {
        // BICOLOR: the fragment's half is decided by the SAME along-axis
        // world coordinate the depth mix already rides — s=0 at end A, 1 at
        // B, clamped so trim zones and caps take their end's color whole.
        // Equal halves collapse exactly (mix(a,a,s)==a): the solid-color
        // edge renders byte-identically to the former single-buffer pass.
        float s = clamp(vT / vLen, 0.0, 1.0);
        vec4 col = mix(vColorA, vColorB, s);
        // zero alpha is a literal zero: no fragment, no depth hole
        if (col.a <= 0.0) discard;
        float u2 = vU * vU;
        float nz; float depthBase;
        if (vT < vDA || vT > vLen - vDB) {
          // END ZONE. Covered (sphere > tube): the ring lies on the sphere
          // and the sphere owns everything past it — no fragment. Exposed
          // (sphere ≤ tube, incl. size 0): a hemispherical cap, so a bare
          // tube end reads as SOLID, never as a cut pipe.
          bool startEnd = vT < vDA;
          // >=: a sphere of EQUAL radius already caps the end exactly — a
          // cap there would be coincident geometry and z-fight it
          if ((startEnd ? vRsA : vRsB) >= vRadius) discard;
          float tc = startEnd ? vT : vT - vLen; // axial offset from the point centre (d = 0 here)
          float q2 = (tc * tc) / (vRadius * vRadius) + u2;
          if (q2 > 1.0) discard;
          nz = sqrt(1.0 - q2);
          depthBase = startEnd ? vDepthA : vDepthB;
        } else {
          // cylinder wall — the SAME s the color mix rides
          nz = sqrt(max(1.0 - u2, 0.0));
          depthBase = mix(vDepthA, vDepthB, s);
        }
        // DASH: a world-length on/off pattern over the SAME along-axis
        // coordinate (vT is in view units = world lengths; vDash is already
        // k-anchored by the vertex stage). Applied uniformly over vT — caps
        // and trim zones included — AFTER the surface discards, so a solid
        // edge (vDash == 0) skips the block entirely: byte-identical.
        if (vDash > 0.0) {
          float period = vDash * ${DASH_SCALE.toFixed(1)};
          if (fract(vT / period) > ${DASH_DUTY.toFixed(2)}) discard;
        }
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic surface depth: nearer than the axis/centre by nz*radius
        float zView = -(depthBase - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(impostorShade(col.rgb, nz), col.a);
      }`,
  };
}

/**
 * Trace (path) tube pass: instanced camera-facing quads, ONE PER PATH
 * SEGMENT, with PER-END radius and RGBA — varying interpolation gives the
 * along-segment gradient, the trace buffers' pinned per-vertex semantics
 * (a tapered wall when the two end radii differ). Unlike the edge tube
 * there is NO trim/extension/cap machinery: the joint SPHERE drawn at each
 * path vertex has exactly the tube's end radius (both are traceSize at
 * that vertex, world-scaled by the same k), so the sphere caps every end
 * and owns every bend — the wall spans exactly [0, len], and the
 * equal-radius coincident-cap z-fight the edge shader documents cannot
 * arise (the sphere renders the end zone; the wall simply stops).
 * Instance slot ≡ segment order from the ONE traceSegments traversal
 * (geometry.ts) — never compacted; hidden/degenerate/zero instances
 * collapse out of the clip volume here. Depth follows the ONE global
 * variant through the same define as every geometry pass.
 */
export function traceTubeShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      // TRACE TUBE static per-corner: x = side (-1 | +1 across width), y = end (0 | 1)
      attribute vec2 aCorner;
      attribute vec3 iStart; attribute vec3 iEnd;
      attribute float iVisible;
      attribute float iRadiusA; attribute float iRadiusB;
      attribute vec4 iColorA; attribute vec4 iColorB;
      attribute float iStyle;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
      ${ALPHA_PASS_CHUNK}
      varying vec4 vColor; varying float vU;
      varying float vRadius; varying float vDepth;
      void main() {
        vStyleParams = styleParams(iStyle);
        float rA = uWorldPerSize * iRadiusA;
        float rB = uWorldPerSize * iRadiusB;
        vec3 mvA = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
        vec3 mvB = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
        vec3 seg = mvB - mvA;
        float len = length(seg);
        // collapsed instances (hidden segment, degenerate length, both end
        // radii zero, or the other alpha half) leave the clip volume — no
        // fragments, no depth writes. A segment counts as opaque only if BOTH
        // ends are: a gradient from 1.0 to 0.4 is translucent material and must
        // not stamp depth for its opaque end.
        if (iVisible < 0.5 || len * len < 1e-16 || max(rA, rB) <= 0.0
            || !inAlphaPass(min(iColorA.a, iColorB.a))) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColor = vec4(0.0); vU = 0.0; vRadius = 0.0; vDepth = 1.0;
          return;
        }
        vec3 axis = seg / len;
        vec3 toCam = -normalize(mvA + mvB); // midpoint view direction
        vec3 s = cross(axis, toCam);
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(0.0, 1.0, 0.0));
        if (dot(s, s) < 1e-12) s = cross(axis, vec3(1.0, 0.0, 0.0));
        vec3 side = normalize(s);
        // a trapezoid: each end's corners sit at that end's own radius, so
        // the wall tapers linearly between the two vertex sizes
        bool atB = aCorner.y > 0.5;
        float r = atB ? rB : rA;
        vec3 pos = (atB ? mvB : mvA) + side * (aCorner.x * r);
        vColor = atB ? iColorB : iColorA;
        vU = aCorner.x;
        vRadius = r;
        vDepth = -(atB ? mvB.z : mvA.z);
        gl_Position = projectionMatrix * vec4(pos, 1.0);
      }`,
    fragment: `
      uniform vec2 uProjZ;
      ${IMPOSTOR_SHADE_CHUNK}
      varying vec4 vColor; varying float vU;
      varying float vRadius; varying float vDepth;
      void main() {
        // zero alpha and a zero LOCAL radius (a tapered cone's tip) are
        // literal zeros: no fragment survives, no depth is written
        if (vColor.a <= 0.0 || vRadius <= 0.0) discard;
        float nz = sqrt(max(1.0 - vU * vU, 0.0));
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic surface depth: nearer than the axis by nz*radius
        float zView = -(vDepth - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(impostorShade(vColor.rgb, nz), vColor.a);
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

/**
 * Trace RIBBON pass (the first ORIENTED, non-camera-facing shape): one
 * instanced quad per path segment whose plane is spanned by the segment's
 * ALONG and the supplied per-vertex ACROSS (the orientation buffer — a
 * bound vector channel). NOT an impostor: real oriented geometry, real
 * depth, no analytic raytrace, no IMPOSTOR_DEPTH variant (that switch is
 * a sprite concern; real fragments carry true depth natively).
 *
 * The across is consumed RAW (O-1 stores it unnormalized, by design) and
 * conditioned HERE, where the geometry lives: transformed to view space,
 * projected ⊥ along, then normalized. The DEGENERACY RULE (the ruled
 * collapse-to-zero): a zero across, or one parallel to along, has no
 * defined plane — that end's half-width collapses to zero. An UNBOUND
 * orientation buffer is all zeros, so a ribbon without orientation data
 * draws NOTHING — honest, and the reason the tube stays the default shape.
 *
 * Width = uWorldPerSize × traceSize per END (the tube's radius scale, so
 * tube↔ribbon swaps keep footprint); RGBA per end interpolates along the
 * segment exactly like the tube wall; style is flat per segment (A-end).
 * Shading: the shared style chunk on the quad's REAL normal, TWO-SIDED
 * (|nz| — a ribbon has a back face; the highlight follows the plane, which
 * is exactly what breaking symmetry means).
 */
/** Ribbon thickness as a fraction of the band's HALF width, so the box is
 * 2·w wide and 2·RIBBON_THICKNESS·w thick — i.e. thickness is 15% of width.
 * Chosen by eye against the miter shots: thin enough to still read as a ribbon
 * rather than a bar, thick enough that the edge catches light at a glancing
 * angle, which is the whole point of having one. Proportional rather than
 * absolute so a thin coil and a wide helix keep the same slenderness. */
export const RIBBON_THICKNESS = 0.15;

/** Renderer-side spline sampling: how many sub-quads each ORIGINAL polyline
 * segment is diced into before the centripetal Catmull-Rom is evaluated across
 * them. One flat quad per segment FACETS every turn into a sharp corner (the
 * trace is genuinely angular — median turn ~83°/step); linear subdivision is a
 * no-op on that (the sub-points stay collinear), only a spline rounds it. At
 * S=8 the measured max turn over the drawn sub-vertices drops from ~97° toward
 * ~35°. An internal constant like RIBBON_THICKNESS — this is a ribbon-private
 * geometry knob, not a contract or a wire value. The base geometry carries S
 * sub-boxes (16·S corners) so instanceCount stays the per-segment control hull
 * and every per-instance fill is byte-untouched. */
export const RIBBON_SEGMENTS = 8;

export function ribbonShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      // RIBBON static per-corner: x = side (-1 | +1 across width), y = t (the
      // parametric position ALONG the original segment, in [0,1]; sub-quad j
      // spans [j/S, (j+1)/S], anchors land exactly on t=0 and t=1), z = offset
      // through the thickness (-1 | +1)
      attribute vec3 aCorner;
      // which of the box's four faces this corner belongs to, so each shades with
      // its own normal: 0 = +normal, 1 = -normal, 2 = +across edge, 3 = -across
      attribute float aFace;
      attribute vec3 iStart; attribute vec3 iEnd;
      // width AND visibility: |x| is end A's width, |y| is end B's, and a NEGATIVE
      // component means the instance is hidden (packRibbonWidth owns the encoding).
      attribute vec2 iWidth;
      attribute vec4 iColorA; attribute vec4 iColorB;
      attribute vec3 iAcrossA; attribute vec3 iAcrossB;
      // the CATMULL-ROM CONTROL HULL: the point BEFORE iStart and AFTER iEnd.
      // A chain end points at its OWN endpoint (fill sets prev/next to self), so
      // P0==P1 / P3==P2 there → the tangent falls back to the chord (a clean,
      // straight end, exactly as the old flat quad had). Formerly the miter
      // neighbours; the spline SUBSUMES the miter (matching tangents at every
      // sub-joint AND — because adjacent segments share this hull — at the
      // original joints too), so there is no wedge left to close.
      attribute vec3 iPrevPoint; attribute vec3 iNextPoint;
      attribute float iStyle;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
      ${ALPHA_PASS_CHUNK}
      varying vec4 vColor;
      varying vec3 vNormal;

      // centripetal (α = 0.5) knot spacing: |Δ|^0.5, floored so coincident
      // control points (chain ends, P0==P1) never divide by zero.
      float ribbonKnot(vec3 a, vec3 b) { return sqrt(max(length(a - b), 1e-5)); }

      // slerp two SIGN-COHERENT facings (the producer already walked the sign, so
      // the pair is unambiguous within a segment); returns a unit direction.
      vec3 ribbonSlerp(vec3 a, vec3 b, float t) {
        vec3 na = normalize(a), nb = normalize(b);
        float c = clamp(dot(na, nb), -1.0, 1.0);
        float ang = acos(c);
        if (ang < 1e-4) return na;          // (near-)parallel: nothing to rotate
        float s = sin(ang);
        return (sin((1.0 - t) * ang) / s) * na + (sin(t * ang) / s) * nb;
      }

      void main() {
        vStyleParams = styleParams(iStyle);
        float t = aCorner.y;
        bool shown = iWidth.x >= 0.0 && iWidth.y >= 0.0
          && inAlphaPass(min(iColorA.a, iColorB.a));
        float wA = uWorldPerSize * abs(iWidth.x);
        float wB = uWorldPerSize * abs(iWidth.y);
        // the control hull in VIEW space (Catmull-Rom is affine-invariant, so
        // evaluating here equals transforming the world-space curve)
        vec3 P0 = (modelViewMatrix * vec4(iPrevPoint, 1.0)).xyz;
        vec3 P1 = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
        vec3 P2 = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
        vec3 P3 = (modelViewMatrix * vec4(iNextPoint, 1.0)).xyz;
        vec3 chord = P2 - P1;
        float segLen = length(chord);
        if (!shown || segLen * segLen < 1e-16 || max(wA, wB) <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColor = vec4(0.0); vNormal = vec3(0.0, 0.0, 1.0);
          return;
        }
        // CENTRIPETAL CATMULL-ROM (α = 0.5, no cusps/overshoot on sharp turns):
        // non-uniform Hermite tangents at P1 and P2, scaled to the segment's
        // local [0,1] parameter (× d12). Chain ends fall back to the chord.
        float d01 = ribbonKnot(P0, P1), d12 = ribbonKnot(P1, P2), d23 = ribbonKnot(P2, P3);
        vec3 m1 = length(P1 - P0) < 1e-6
          ? chord
          : ((P1 - P0) / d01 - (P2 - P0) / (d01 + d12) + chord / d12) * d12;
        vec3 m2 = length(P3 - P2) < 1e-6
          ? chord
          : (chord / d12 - (P3 - P1) / (d12 + d23) + (P3 - P2) / d23) * d12;
        // Hermite basis: pos(0)=P1=iStart, pos(1)=P2=iEnd — the INTERPOLATING
        // spline HONOURS every supplied anchor exactly (drawn ≡ supplied for
        // position at the anchors); only the path BETWEEN anchors is rounded.
        float tt = t * t, ttt = tt * t;
        float h00 = 2.0 * ttt - 3.0 * tt + 1.0;
        float h10 = ttt - 2.0 * tt + t;
        float h01 = -2.0 * ttt + 3.0 * tt;
        float h11 = ttt - tt;
        vec3 pos = h00 * P1 + h10 * m1 + h01 * P2 + h11 * m2;
        // the TRUE tangent (basis derivative) → along(t)
        float g00 = 6.0 * tt - 6.0 * t;
        float g10 = 3.0 * tt - 4.0 * t + 1.0;
        float g01 = -6.0 * tt + 6.0 * t;
        float g11 = 3.0 * tt - 2.0 * t;
        vec3 tangent = g00 * P1 + g10 * m1 + g01 * P2 + g11 * m2;
        float tlen = length(tangent);
        vec3 along = tlen < 1e-9 ? chord / segLen : tangent / tlen;
        // WIDTH + COLOUR: linear resample across the segment — the SAME two-end
        // interpolation the flat quad had, now sampled at S+1 points not 2.
        float w = mix(wA, wB, t);
        vColor = mix(iColorA, iColorB, t);
        // across(t): slerp the supplied facings, then condition where the
        // geometry lives — world → view (rotation only), ⊥ along, unit (the O-1
        // raw-store recommendation, evaluated at t). A zero facing at an end
        // drops out; both zero (unbound orientation) → zero across → collapse.
        float lenA = length(iAcrossA), lenB = length(iAcrossB);
        vec3 acrossWorld =
          (lenA < 1e-9 && lenB < 1e-9) ? vec3(0.0)
          : lenA < 1e-9 ? normalize(iAcrossB)
          : lenB < 1e-9 ? normalize(iAcrossA)
          : ribbonSlerp(iAcrossA, iAcrossB, t);
        vec3 acrossView = mat3(modelViewMatrix) * acrossWorld;
        vec3 aperp = acrossView - along * dot(acrossView, along);
        float alen = length(aperp);
        // DEGENERACY: no defined plane (zero/parallel across) → zero width
        w = w * (alen < 1e-6 ? 0.0 : 1.0);
        vec3 across = alen < 1e-6 ? vec3(0.0) : aperp / alen;
        // THIN BOX CROSS-SECTION. The band gets thickness through its own plane
        // normal, so it reads as a solid strip with edges rather than as paper.
        //
        // Proportional to width, not absolute: a coil and a helix keep the same
        // slenderness instead of a fixed thickness looking chunky on one and
        // invisible on the other. RIBBON_THICKNESS is a fraction of the HALF
        // width (w), so the box is 2w wide and 2*RIBBON_THICKNESS*w thick.
        //
        // NO MITER SHIFT: the C1 spline shares its control hull with each
        // neighbour, so tangents (hence end faces) already match at every
        // sub-joint AND at the original joints — the wedge the miter closed
        // never forms. DRAWN ≡ SUPPLIED survives: the thickness offset is along
        // cross(along, across), ⊥ both, so the facing is untouched; and a zero
        // across gives a zero normal AND w = 0, so every corner lands on the
        // curve point and nothing is drawn.
        vec3 nrm = cross(along, across);
        vec3 vpos = pos + across * (aCorner.x * w)
                 + nrm * (aCorner.z * ${RIBBON_THICKNESS.toFixed(3)} * w);
        // Per-face normal: the two broad faces look along ±nrm, the two edges
        // along ±across. Averaging one normal across all of them would light the
        // edges as if they were the face and lose the thickness cue entirely.
        // PER-FACE NORMAL. The two broad faces look along ±nrm; the two edges look
        // along ±across, so a glancing view catches the edge as an edge instead of
        // lighting it like the face it is not. This is what the packed width bought.
        vNormal = aFace < 0.5 ? nrm
                : aFace < 1.5 ? -nrm
                : aFace < 2.5 ? across
                : -across;
        gl_Position = projectionMatrix * vec4(vpos, 1.0);
      }`,
    fragment: `
      ${IMPOSTOR_SHADE_CHUNK}
      varying vec4 vColor;
      varying vec3 vNormal;
      void main() {
        if (vColor.a <= 0.0) discard;
        // TWO-SIDED: the plane's headlight response is |view-space z|
        float nz = abs(normalize(vNormal).z);
        gl_FragColor = vec4(impostorShade(vColor.rgb, nz), vColor.a);
      }`,
  };
}
