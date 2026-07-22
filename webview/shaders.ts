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
      varying vec3 vColor; varying float vVisible; varying float vOpacity;
      varying float vRadius; varying float vViewDepth;
      void main() {
        vColor = aColor; vVisible = aVisible; vOpacity = aOpacity;
        vStyleParams = styleParams(aStyle);
        vRadius = uWorldPerSize * aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aVisible > 0.5 ? impostorDiameterPx(vRadius, vViewDepth) : 0.0;
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
      attribute float iStyle;
      // endpoint SPHERE sizes (rep-write cadence, like iRadius): the tube is
      // trimmed analytically to the sphere it meets — see the fragment shader
      attribute float iSizeA; attribute float iSizeB;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
      varying vec4 vColor; varying float vU;
      varying float vRadius;
      varying float vT; varying float vLen;
      varying float vDA; varying float vDB;
      varying float vDepthA; varying float vDepthB;
      varying float vRsA; varying float vRsB;
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
        // or a tube swallowed whole by its endpoint spheres) leave the clip
        // volume entirely — no fragments, no depth writes
        if (iVisible < 0.5 || radius <= 0.0 || len * len < 1e-16 || dA + dB >= len) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColor = vec4(0.0); vU = 0.0; vRadius = 0.0;
          vT = 0.0; vLen = 1.0; vDA = 0.0; vDB = 0.0;
          vDepthA = 1.0; vDepthB = 1.0; vRsA = 0.0; vRsB = 0.0;
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
        vColor = iColor;
        vU = aCorner.x;
        vRadius = radius;
        vT = t; vLen = len; vDA = dA; vDB = dB;
        vDepthA = -mvA.z; vDepthB = -mvB.z;
        vRsA = rsA; vRsB = rsB;
        gl_Position = projectionMatrix * vec4(pos, 1.0);
      }`,
    fragment: `
      uniform vec2 uProjZ;
      ${IMPOSTOR_SHADE_CHUNK}
      varying vec4 vColor; varying float vU;
      varying float vRadius;
      varying float vT; varying float vLen;
      varying float vDA; varying float vDB;
      varying float vDepthA; varying float vDepthB;
      varying float vRsA; varying float vRsB;
      void main() {
        // zero alpha is a literal zero: no fragment, no depth hole
        if (vColor.a <= 0.0) discard;
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
          // cylinder wall
          nz = sqrt(max(1.0 - u2, 0.0));
          depthBase = mix(vDepthA, vDepthB, clamp(vT / vLen, 0.0, 1.0));
        }
      #ifdef ${IMPOSTOR_DEPTH_DEFINE}
        // analytic surface depth: nearer than the axis/centre by nz*radius
        float zView = -(depthBase - vRadius * nz);
        gl_FragDepth = 0.5 * ((uProjZ.x * zView + uProjZ.y) / -zView) + 0.5;
      #endif
        gl_FragColor = vec4(impostorShade(vColor.rgb, nz), vColor.a);
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
      // static per-corner: x = side (-1 | +1 across width), y = end (0 | 1)
      attribute vec2 aCorner;
      attribute vec3 iStart; attribute vec3 iEnd;
      attribute float iVisible;
      attribute float iRadiusA; attribute float iRadiusB;
      attribute vec4 iColorA; attribute vec4 iColorB;
      attribute float iStyle;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
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
        // radii zero) leave the clip volume — no fragments, no depth writes
        if (iVisible < 0.5 || len * len < 1e-16 || max(rA, rB) <= 0.0) {
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

export function ribbonShaders(): { vertex: string; fragment: string } {
  return {
    vertex: `
      // static per-corner: x = side (-1 | +1 across width), y = end (0 | 1)
      // static per-corner: x = side (-1 | +1 across width), y = end (0 | 1),
      // z = offset through the thickness (-1 | +1)
      attribute vec3 aCorner;
      attribute vec3 iStart; attribute vec3 iEnd;
      attribute float iVisible;
      attribute float iWidthA; attribute float iWidthB;
      attribute vec4 iColorA; attribute vec4 iColorB;
      attribute vec3 iAcrossA; attribute vec3 iAcrossB;
      attribute vec3 iPrevPoint; attribute vec3 iNextPoint;
      attribute float iStyle;
      uniform float uWorldPerSize;
      ${STYLE_VERTEX_CHUNK}
      varying vec4 vColor;
      varying vec3 vNormal;
      void main() {
        vStyleParams = styleParams(iStyle);
        float wA = uWorldPerSize * iWidthA;
        float wB = uWorldPerSize * iWidthB;
        vec3 mvA = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
        vec3 mvB = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
        vec3 seg = mvB - mvA;
        float len = length(seg);
        if (iVisible < 0.5 || len * len < 1e-16 || max(wA, wB) <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vColor = vec4(0.0); vNormal = vec3(0.0, 0.0, 1.0);
          return;
        }
        vec3 along = seg / len;
        // the supplied across, per end: world → view (rotation only), then
        // ⊥ along, then unit — the O-1 recommendation executed here
        bool atB = aCorner.y > 0.5;
        vec3 acrossWorld = atB ? iAcrossB : iAcrossA;
        vec3 acrossView = mat3(modelViewMatrix) * acrossWorld;
        vec3 aperp = acrossView - along * dot(acrossView, along);
        float alen = length(aperp);
        // DEGENERACY: no defined plane at this end → zero width (collapse)
        float w = (atB ? wB : wA) * (alen < 1e-6 ? 0.0 : 1.0);
        vec3 across = alen < 1e-6 ? vec3(0.0) : aperp / alen;
        // BEND MITER: slide the junction corner along the segment onto the
        // bend's bisector plane, so adjacent segments' end edges become COPLANAR
        // and the wedge gap closes. across (hence the plane normal cross(along,
        // across)) is UNCHANGED — only the position moves along the segment, so
        // drawn-equals-supplied survives. A chain end / straight run gives a zero
        // neighbour direction, so m = along, across is perpendicular to along,
        // dot(across,m)=0, the shift is zero (the naive, clean end). A degenerate
        // end has w=0, so no shift.
        vec3 endpoint = atB ? mvB : mvA;
        vec3 mvPrev = (modelViewMatrix * vec4(iPrevPoint, 1.0)).xyz;
        vec3 mvNext = (modelViewMatrix * vec4(iNextPoint, 1.0)).xyz;
        vec3 nbr = atB ? (mvNext - mvB) : (mvA - mvPrev); // neighbour flow through the junction
        float nlen = length(nbr);
        vec3 alongNbr = nlen < 1e-6 ? along : nbr / nlen;
        vec3 m = normalize(along + alongNbr);             // bisector tangent
        float denom = max(dot(along, m), 0.25);           // cos(θ/2), clamped = miter limit 4
        float shift = (-aCorner.x * w) * dot(across, m) / denom;
        // THIN BOX CROSS-SECTION. The band gets thickness through its own plane
        // normal, so it reads as a solid strip with edges rather than as paper.
        //
        // Proportional to width, not absolute: a coil and a helix keep the same
        // slenderness instead of a fixed thickness looking chunky on one and
        // invisible on the other. RIBBON_THICKNESS is a fraction of the HALF
        // width (w), so the box is 2w wide and 2*RIBBON_THICKNESS*w thick.
        //
        // DRAWN ≡ SUPPLIED survives: the offset is along cross(along, across),
        // which is perpendicular to both, so the plane's orientation is untouched
        // — only its extrusion is new. DEGENERACY survives too: a zero across
        // gives a zero normal AND w = 0, so every corner still lands on the
        // endpoint and nothing is drawn. And the MITER survives: the shift does not
        // depend on aCorner.z, so both faces slide together onto the bisector.
        vec3 nrm = cross(along, across);
        vec3 pos = endpoint + across * (aCorner.x * w) + along * shift
                 + nrm * (aCorner.z * ${RIBBON_THICKNESS.toFixed(3)} * w);
        vColor = atB ? iColorB : iColorA;
        // Per-face normal: the two broad faces look along ±nrm, the two edges
        // along ±across. Averaging one normal across all of them would light the
        // edges as if they were the face and lose the thickness cue entirely.
        // One normal for the whole box rather than per face. Correct on the two
        // broad faces, which are what you see; the edges shade as if they were
        // face, which at 15% of the width is a sliver. A per-face normal needs a
        // 15th vertex attribute and this shader is already at 14.
        vNormal = nrm;
        gl_Position = projectionMatrix * vec4(pos, 1.0);
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
