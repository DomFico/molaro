/**
 * Webview renderer — the interaction-redesign model:
 *
 *   bottom section = BUILD · top section = OPERATE · 3D = NAVIGATE + BUILD
 *
 *  - ONE pending selection (the target, sets.ts SelectionModel) is built from
 *    the bottom tree AND the 3D view; its footprint pulses GREEN in both. The
 *    corner button commits it as a named committed selection (top section);
 *    committed selections are neutral — no persistent viewport color.
 *  - HIDDEN is a flag on committed selections; the invisible points are the
 *    union of hidden ones. The base-points shader discards `aVisible < 0.5`,
 *    lines drop segments with a hidden endpoint, and hidden wins over any
 *    highlight (the overlays are gated on `aVisible`).
 *  - camera-focus actions (3D left-click, bottom right-click, top left-click)
 *    play a brief YELLOW pulse over the focused region and orient the camera.
 *    Camera moves are never on the undo stack; Ctrl+Z undoes state changes.
 *  - 3D selection granularity is EXPLICIT: Ctrl+left = subgroup entries,
 *    Ctrl+right = point entries (drag = paint). Plain left-click just focuses.
 *
 * Set changes flip only the affected points' bits (incremental; smooth at
 * N≈250k). Positions still stream zero-copy into the one shared attribute.
 */
import * as THREE from "three";
// Trackball (not Orbit) controls: free rotation with no up-vector / no polar
// clamp, so the camera can roll a full 360° over the poles (Increment 4.5, A2).
import { TrackballControls } from "three/addons/controls/TrackballControls.js";

import {
  channelComponents,
  decodeFrameChunk,
  parseHeader,
  validateFrameChunk,
  type FrameChunk,
  type Header,
} from "../contract/contract.ts";
import { StreamingPlayer } from "./playback.ts";
import { Transport, rejectIfErrorPayload } from "./transport.ts";
import {
  RepresentationLayer,
  type RepresentationState,
} from "./representation.ts";
import { bulkCategories, buildTree } from "./classification.ts";
import { flashRow, mountTree, type TreeHandle } from "./tree.ts";
import { mountCommitted, type CommittedActions } from "./committed.ts";
import { mountBrackets, BRACKET_GUTTER_PX } from "./brackets.ts";
import { applyScalarsToAxis, createCommandRegistry, makeRunComplete, runCommandMacro, type CommandResult } from "./commands.ts";
import { BindingRegistry, type Binding } from "./bindings.ts";
import { AXIS_DOMAIN, BIND_SIZE_MAX, mapScalar, ORIENTATION_AXIS, SCALAR_AXES, type BindAxis } from "./channelmap.ts";
import { bindTypedResult } from "./claudebind.ts";
import { parseTypedResult } from "./claudemodel.ts";
import { listRecipes, rainbow, registerRecipe, unregisterRecipe, validateModValues, type AnalysisMod } from "./recipes.ts";
import {
  installModList,
  isFileAlreadyGone,
  makeAnalysisModHandler,
  modInstallReport,
  type ModInstallOutcome,
} from "./commands.ts";
import { parseTarget, resolveTarget, type Completion } from "./address.ts";
import { Hierarchy, SelectionModel, type Entry } from "./sets.ts";
import { pickPoint, selectionBounds } from "./picking.ts";
import {
  CAMERA_FOV_DEG,
  FRAME_DISTANCE_FACTOR,
  NO_BBOX_WARNING,
  sceneExtent,
  traceSegments,
  worldPerSizeUnit,
  type Box3Like,
} from "./geometry.ts";
import {
  IMPOSTOR_DEPTH_DEFINE,
  edgeTubeShaders,
  focusFlashShaders,
  highlightShaders,
  pointShaders,
  ribbonShaders,
  traceTubeShaders,
} from "./shaders.ts";
import { listStyles, styleIndex, stylesAsUniformArray } from "./styles.ts";

// Playback + backpressure tuning (see playback.ts for the policy).
const PLAYBACK_FPS = 30;
const CHUNK_FRAMES = 8;
const LOOKAHEAD_CHUNKS = 2;
const MAX_IN_FLIGHT = 2;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

// (the edges' and polylines' base looks moved to representation.ts
// DEFAULT_EDGE_COLOR / DEFAULT_TRACE_COLOR — both passes read per-element
// representation state now)
const BACKGROUND = 0x1e1e1e;
const SELECTION_COLOR = 0xbfffe4; // pending-target tint (light green)
const FOCUS_COLOR = 0xffe9a8; // camera-focus tint (light yellow)

const PICK_PIXEL_THRESHOLD = 12;
const GREEN_PULSE_PERIOD_MS = 1600;
const FOCUS_FLASH_MS = 900;

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState?(): unknown;
  setState?(s: unknown): void;
};

type DockPos = "left" | "right" | "top" | "bottom";
interface PanelState {
  dock: DockPos;
  collapsed: boolean;
  width: number;
  height: number;
}
export interface PanelControl {
  setDock(pos: DockPos): void;
  setCollapsed(collapsed: boolean): void;
  readonly state: PanelState;
}

interface ViewerConfig {
  autoplay?: boolean;
  statsLog?: boolean;
  screenshotMode?: boolean;
  /** Test harness only: expose camera/controls/player/selection on window.__viewer. */
  test?: boolean;
  /** Development/measurement switch (NOT a user surface): 1 = flat sprite
   * depth (early-Z kept), 2 = analytic gl_FragDepth (correct
   * interpenetration). Global across all geometry passes. The default is 2
   * — an ARCHITECTURAL call (real oriented geometry composes only with
   * analytic sprite depth; S44 is the record), made without hardware
   * measurement; variant 1 remains selectable if real hardware shows a
   * frame-rate cost. */
  depthVariant?: number;
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

// ---------------------------------------------------------------------------
// The shape-generator registry: the pattern the scene build always followed,
// made explicit — each draw pass is a geometry, a material off the shared
// machinery, and a set of fill hooks keyed by update cadence. A ShapeGenerator
// BUILDS one pass; the registry owns cadence dispatch. This is a
// formalization only: the five built-in generators below draw exactly what
// the former inline passes drew, and nothing outside this module registers
// one (a shape is data plus declared channel reads, never code shipped in).
//
// The cadence contract, structural rather than conventional:
//   onFrameFlip        every displayed-frame flip. LINEAR COPY ONLY — the
//                      hook receives no ids and no channel, so representation-
//                      derived work physically cannot ride the flip loop.
//   onRepWrite         representation writes, keyed by CHANNEL, scoped to the
//                      written ids. Dispatch is by channel — never by owning
//                      pass — which makes cross-pass subscriptions
//                      first-class: the edge pass subscribes to the POINT
//                      `size` channel for the junction trim.
//   onVisibilityChange hide/show recomputation (index trims, instance masks).
//   onRenderTick       per rendered frame — overlay pulse envelopes only.
//
// The host keeps owning: the per-point attribute OBJECTS and the ONE repAttrs
// re-upload list, refreshPoints, selection/flash bookkeeping, and the flash
// envelope (host state) — those reach a pass only through the typed fields a
// concrete builder returns beyond BuiltPass (materials, version counters).
// ---------------------------------------------------------------------------

/** A representation buffer name — the key space onRepWrite dispatches on. */
type RepChannel = keyof RepresentationState;

/** Everything a generator may draw on — handed in, never reached for. */
interface PassEnv {
  header: Header;
  rep: RepresentationLayer;
  /** THE shared position attribute (repointed at a chunk subarray per flip). */
  positionAttr: THREE.BufferAttribute;
  /** Host-owned per-point attribute OBJECTS wrapping the rep buffers and the
   * overlay flag arrays. Shared as OBJECTS across passes on purpose: the
   * overlays bind the same aSize/aVisible the base pass uploads, so
   * silhouette-matching and hidden-wins are identities, not conventions. */
  pointAttrs: {
    color: THREE.BufferAttribute;
    size: THREE.BufferAttribute;
    visible: THREE.BufferAttribute;
    opacity: THREE.BufferAttribute;
    /** per-point style INDEX (0 = standard) — categorical, command-cadence. */
    style: THREE.BufferAttribute;
    /** pending-target flag (0/1) drawn by the green overlay. */
    sel: THREE.BufferAttribute;
    /** focus-flash flag (0/1) drawn by the yellow pulse pass. */
    flash: THREE.BufferAttribute;
  };
  /** Polyline vertex → point index, header order (computed once in main). */
  traceVertices: readonly number[];
  /** The shared sizing uniform OBJECTS (one instance each — values can't fork). */
  sizing: SizingUniforms;
  /** The packed style array — ONE object, shared by every pass that shades. */
  styleUniforms: StyleUniforms;
  depthVariant: 1 | 2;
  /** The three GEOMETRY materials from the ONE factory — the only consumer of
   * the depth-variant switch; depthWrite pinned explicitly there (C2). */
  materials: {
    points: THREE.ShaderMaterial;
    edges: THREE.ShaderMaterial;
    traces: THREE.ShaderMaterial;
  };
}

/** One built draw pass: its scene objects plus its cadence hooks. */
interface BuiltPass {
  /** Added to the scene in registration order (draw order IS scene order —
   * the naive-transparency compositing depends on it). */
  objects: THREE.Object3D[];
  onFrameFlip?: () => void;
  onRepWrite?: Partial<Record<RepChannel, (ids: readonly number[]) => void>>;
  onVisibilityChange?: () => void;
  onRenderTick?: (nowMs: number) => void;
  /** Called when the pass becomes the domain's ACTIVE shape after being
   * disabled: the dispatch skips disabled passes, so its GPU arrays are
   * stale — this hook re-fills EVERY cadence from the rep buffers. */
  onEnable?: () => void;
}

interface ShapeGenerator<B extends BuiltPass = BuiltPass> {
  name: string;
  /** Verb-facing shape name (`shape <domain> <label>`); defaults to `name`.
   * Overlays never set one — they are not selectable. */
  shapeLabel?: string;
  /** A bindable axis this shape READS to have a defined geometry at all
   * (the ribbon: orientation — unbound means every quad collapses). The
   * shape verb warns when enabling a shape whose required axis has no
   * binding, so the honest empty picture never reads as a silent failure. */
  requiresAxis?: BindAxis;
  /** The element kind the pass draws over; "overlay" marks the two built-in
   * decorations (never pluggable — they exist to shadow the point pass). */
  elementKind: "point" | "edge" | "vertex" | "overlay";
  /** Build the pass, or null when the dataset has no such elements. */
  build(env: PassEnv): B | null;
}

/** Construction + cadence dispatch. Nothing else — state stays with the host
 * or inside the built passes' closures. */
class ShapeRegistry {
  private readonly built: {
    pass: BuiltPass;
    domain: ShapeGenerator["elementKind"];
    /** the verb-facing shape name ("sphere", "tube", "ribbon"); overlays
     * carry their generator name and are never selectable. */
    label: string;
    enabled: boolean;
    requiresAxis?: BindAxis;
  }[] = [];
  private readonly sceneObjects: THREE.Object3D[] = [];

  /** Build and adopt a generator's pass. Returns the CONCRETE pass (typed
   * wider than BuiltPass) so the host keeps handles a builder exports.
   * `enabled` (default true) — a domain's alternates register disabled;
   * exactly one pass per selectable domain draws at a time. */
  add<B extends BuiltPass>(gen: ShapeGenerator<B>, env: PassEnv, enabled = true): B | null {
    const pass = gen.build(env);
    if (!pass) return null;
    this.built.push({
      pass, domain: gen.elementKind, label: gen.shapeLabel ?? gen.name, enabled,
      ...(gen.requiresAxis ? { requiresAxis: gen.requiresAxis } : {}),
    });
    this.sceneObjects.push(...pass.objects);
    for (const o of pass.objects) o.visible = false; // revealed on first frame, enabled-only
    return pass;
  }

  /** Every pass's scene objects, in registration order. */
  objects(): readonly THREE.Object3D[] {
    return this.sceneObjects;
  }

  /** First-frame reveal — and the ONE place enable-state reaches
   * THREE.Object3D.visible. */
  reveal(): void {
    for (const b of this.built) for (const o of b.pass.objects) o.visible = b.enabled;
  }

  /** The selectable shape names of a domain (registration order). */
  available(domain: ShapeGenerator["elementKind"]): string[] {
    return this.built.filter((b) => b.domain === domain).map((b) => b.label);
  }

  activeOf(domain: ShapeGenerator["elementKind"]): string | null {
    return this.built.find((b) => b.domain === domain && b.enabled)?.label ?? null;
  }

  /** Draw a domain as the named shape: enable it, disable the domain's
   * others, sync visibility. Returns the previous active label, or null if
   * the name isn't registered for the domain. */
  setActive(
    domain: ShapeGenerator["elementKind"],
    label: string,
  ): { prev: string | null; requiresAxis?: BindAxis } | null {
    const target = this.built.find((b) => b.domain === domain && b.label === label);
    if (!target) return null;
    const prev = this.activeOf(domain);
    const wasEnabled = target.enabled;
    for (const b of this.built) if (b.domain === domain) b.enabled = b === target;
    if (!wasEnabled) target.pass.onEnable?.(); // re-fill after the skip gap
    this.reveal();
    return { prev, ...(target.requiresAxis ? { requiresAxis: target.requiresAxis } : {}) };
  }

  frameFlip(): void {
    for (const b of this.built) if (b.enabled) b.pass.onFrameFlip?.();
  }

  repWrite(channel: RepChannel, ids: readonly number[]): void {
    for (const b of this.built) if (b.enabled) b.pass.onRepWrite?.[channel]?.(ids);
  }

  visibilityChange(): void {
    for (const b of this.built) if (b.enabled) b.pass.onVisibilityChange?.();
  }

  renderTick(nowMs: number): void {
    for (const b of this.built) if (b.enabled) b.pass.onRenderTick?.(nowMs);
  }
}

/** The two sizing uniforms every sprite pass shares (ONE object each — the
 * base pass and both overlays reference the same instances, so the values
 * cannot fork) plus the projection z-row the depth-variant-2 fragment needs. */
interface SizingUniforms {
  /** `k` — world units per size-buffer unit (from the single-source S). */
  uWorldPerSize: { value: number };
  /** drawingBufferHeight / (2·tan(fov/2)) — updated on resize. */
  uPxPerWorld: { value: number };
  /** (P[2][2], P[3][2]) of the projection matrix (aspect-independent). */
  uProjZ: { value: THREE.Vector2 };
}

/** The four shading uniforms the shared shade chunk reads — a STYLE
 * (webview/styles.ts) is a set of values for them. ONE object each, shared
 * by every geometry material, so a style's values can never fork between
 * passes (the sizing-uniform discipline, applied to shading). */
interface StyleUniforms {
  /** ONE vec4 per registered style (floor/scale/strength/power), flat,
   * zero-padded to MAX_STYLES — shared as ONE object across all three
   * geometry materials so the registry cannot fork between passes. Every
   * style buffer defaults to index 0 = `standard` (the byte-identical
   * anchor). */
  uStyles: { value: Float32Array };
}

/** The style registry packed for the shader — built once at boot
 * (registration is boot-time; the per-element style AXIS is what changes
 * at runtime, through the style buffers, not this array). */
function makeStyleUniforms(): StyleUniforms {
  return { uStyles: { value: stylesAsUniformArray() } };
}

/**
 * THE geometry-material factory — the one place the depth-variant switch is
 * consumed and the one place depthWrite is set on the geometry passes.
 *
 * Base points render as ray-traced sphere impostors reading the
 * representation buffers (color/size/visible/opacity). Sizes are WORLD
 * radii now (k × stored value): they scale with zoom instead of pinning to
 * screen pixels. Hidden points collapse and discard; exactly-zero alpha AND
 * exactly-zero radius discard, so invisible-but-present elements never
 * punch depth holes (both stay pickable — picking is CPU-side). Opacity
 * still blends NAIVELY (no depth sorting — the recorded follow-up).
 *
 * depthWrite is EXPLICIT on all three geometry materials (C2): if the
 * override ever lapsed, occlusion would silently revert to per-object
 * draw-order — under variant 2 the shader would compute gl_FragDepth per
 * fragment and throw it away. An E2E assertion pins all three.
 *
 * All three geometry passes are impostor/instanced ShaderMaterials now
 * (spheres, edge tubes, trace tubes), consuming the same depthVariant — a
 * mixed scene clips wrongly exactly at the junctions, so the switch is
 * global and consumed only here.
 */
function makeGeometryMaterials(
  sizing: SizingUniforms,
  style: StyleUniforms,
  depthVariant: 1 | 2,
): { points: THREE.ShaderMaterial; edges: THREE.ShaderMaterial; traces: THREE.ShaderMaterial } {
  const defines = depthVariant === 2 ? { [IMPOSTOR_DEPTH_DEFINE]: "" } : {};
  const s = pointShaders();
  const points = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true, // C2: explicit, never inherited
    depthTest: true,
    defines,
    uniforms: {
      uWorldPerSize: sizing.uWorldPerSize,
      uPxPerWorld: sizing.uPxPerWorld,
      uProjZ: sizing.uProjZ,
      ...style,
    },
    vertexShader: s.vertex,
    fragmentShader: s.fragment,
  });
  // Edge tubes: instanced quads, radius = the SAME k uniform object × the
  // stored edgeSize — one scene-scale constant across all primitives. The
  // same depthVariant define as the point pass (A5: a mixed scene clips
  // wrongly exactly at the junctions). DoubleSide: the billboard's winding
  // depends on the side vector's orientation.
  const et = edgeTubeShaders();
  const edges = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true, // C2: explicit, never inherited
    depthTest: true,
    side: THREE.DoubleSide,
    defines,
    uniforms: { uWorldPerSize: sizing.uWorldPerSize, uProjZ: sizing.uProjZ, ...style },
    vertexShader: et.vertex,
    fragmentShader: et.fragment,
  });
  // Trace tubes: instanced trapezoids with PER-END radius/RGBA — radius =
  // the SAME k uniform object × the stored traceSize (one scene-scale
  // constant across all primitives), the same depthVariant define as every
  // pass. DoubleSide for the same billboard-winding reason as edges.
  const tt = traceTubeShaders();
  const traces = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true, // C2: explicit, never inherited
    depthTest: true,
    side: THREE.DoubleSide,
    defines,
    uniforms: { uWorldPerSize: sizing.uWorldPerSize, uProjZ: sizing.uProjZ, ...style },
    vertexShader: tt.vertex,
    fragmentShader: tt.fragment,
  });
  return { points, edges, traces };
}

/**
 * Focus-flash overlay: like the highlight overlay, but points that are ALSO
 * in the pending selection render the flash BLENDED toward the selection
 * tint — a focus pulse passing over green points shifts smoothly within the
 * same color family instead of hard-swapping to yellow (no splotches).
 * Silhouette-matched to the base sphere (same aSize, same sizing chunk, same
 * radius) so highlighting never detaches from the thing it highlights.
 * depthTest stays OFF deliberately: a tint, not geometry — silhouette-
 * coplanar depth testing would z-fight (recorded trade-off: an overlaid
 * element behind opaque geometry shows its tint through).
 */
function focusFlashMaterial(
  sizing: SizingUniforms,
  color: number,
  selColor: number,
): THREE.ShaderMaterial {
  const s = focusFlashShaders();
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uWorldPerSize: sizing.uWorldPerSize,
      uPxPerWorld: sizing.uPxPerWorld,
      uColor: { value: new THREE.Color(color) },
      uSelColor: { value: new THREE.Color(selColor) },
      uStrength: { value: 0 },
    },
    vertexShader: s.vertex,
    fragmentShader: s.fragment,
  });
}

/**
 * Highlight overlay: a Points pass tinting points whose `aFlag` is set AND
 * that are visible (hidden wins) toward a light highlight color. No glow, no
 * halo — the tint covers exactly the base sphere's silhouette (same aSize,
 * same chunk, same radius; a size-0 point shows no overlay, ever).
 * `uStrength` (0..1) animates the tint per frame on the CPU; `uFloor` is the
 * tint floor — the pending overlay breathes but never disappears
 * (floor ≈ 0.45), the focus flash fades fully out (floor 0).
 */
function highlightMaterial(
  sizing: SizingUniforms,
  color: number,
  floor: number,
): THREE.ShaderMaterial {
  const s = highlightShaders();
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uWorldPerSize: sizing.uWorldPerSize,
      uPxPerWorld: sizing.uPxPerWorld,
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: 0 },
      uFloor: { value: floor },
    },
    vertexShader: s.vertex,
    fragmentShader: s.fragment,
  });
}

// ---------------------------------------------------------------------------
// The five built-in generators behind the ShapeGenerator interface.
// ---------------------------------------------------------------------------

/** Base points: ray-traced sphere impostors reading the per-point buffers.
 * Rep-write uploads are attribute-TARGETED: each channel flags ITS
 * attribute only, never the other three — a bound axis re-deriving on
 * every flip (the live channel link) must not re-upload untouched buffers,
 * and the cadence assertions read these attributes' version counters.
 * Visibility still rides the host's rep.dirty batch (refreshPoints). */
const spherePointsGenerator: ShapeGenerator = {
  name: "sphere-points",
  shapeLabel: "sphere",
  elementKind: "point",
  build(env): BuiltPass {
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute("position", env.positionAttr);
    pointsGeo.setAttribute("aColor", env.pointAttrs.color);
    pointsGeo.setAttribute("aSize", env.pointAttrs.size);
    pointsGeo.setAttribute("aVisible", env.pointAttrs.visible);
    pointsGeo.setAttribute("aOpacity", env.pointAttrs.opacity);
    pointsGeo.setAttribute("aStyle", env.pointAttrs.style);
    return {
      objects: [new THREE.Points(pointsGeo, env.materials.points)],
      onRepWrite: {
        color: () => { env.pointAttrs.color.needsUpdate = true; },
        size: () => { env.pointAttrs.size.needsUpdate = true; },
        opacity: () => { env.pointAttrs.opacity.needsUpdate = true; },
        style: () => { env.pointAttrs.style.needsUpdate = true; },
      },
    };
  },
};

/** The EDGE pass is INSTANCED tube geometry: one static camera-facing quad
 * (4 corner vertices, 6 indices) instanced per edge, expanded in the
 * vertex shader to a world-radius billboard. Per-instance attributes are
 * split by UPDATE CADENCE — endpoints (iStart/iEnd) re-copy on every
 * displayed-frame flip (6 floats/edge, unconditional, branch-free);
 * visibility (iVisible) only on hide/show; radius (iRadius) only on
 * bondsize writes; RGBA (iColor) only on colorbonds/bondopacity writes.
 * Instance slot ≡ HEADER EDGE INDEX, never compacted: the GPU arrays
 * share the rep buffers' element order with no remap anywhere (hidden or
 * zero-radius edges collapse in the vertex shader instead). Blending
 * stays NAIVE (transparent: true, no depth sorting) — the recorded
 * follow-up covers overlap compositing. Edges drop when EITHER endpoint
 * hides (so a hidden category also hides its edge hairball). */
interface EdgeTubePass extends BuiltPass {
  /** attribute upload versions (test seam): proves the cadence split — a
   * frame flip bumps `start` and must never bump `sizeA`/`sizeB`. */
  attrVersions(): { start: number; sizeA: number; sizeB: number };
}
const edgeTubesGenerator: ShapeGenerator<EdgeTubePass> = {
  name: "edge-tubes",
  shapeLabel: "tube",
  elementKind: "edge",
  build(env): EdgeTubePass | null {
    const header = env.header;
    const rep = env.rep;
    const positionAttr = env.positionAttr;
    const visible = rep.state.visible;
    const nEdges = header.edges.length;
    if (nEdges === 0) return null;
    const edgeGeo = new THREE.InstancedBufferGeometry();
    edgeGeo.instanceCount = nEdges;
    // static base quad: aCorner = (side ∈ {-1,+1}, end ∈ {0,1}); position is
    // unused by the shader but present so three's internals never look for it
    edgeGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(4 * 3), 3));
    edgeGeo.setAttribute("aCorner", new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
    edgeGeo.setIndex([0, 2, 1, 1, 2, 3]);
    const iStart = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 3), 3);
    const iEnd = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 3), 3);
    const iVisible = new THREE.InstancedBufferAttribute(new Float32Array(nEdges).fill(1), 1);
    const iRadius = new THREE.InstancedBufferAttribute(new Float32Array(nEdges), 1);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 4), 4);
    // endpoint sphere sizes for the analytic junction trim — REP-WRITE
    // cadence (pointsize writes only), exactly like iRadius; never per flip
    const iSizeA = new THREE.InstancedBufferAttribute(new Float32Array(nEdges), 1);
    const iSizeB = new THREE.InstancedBufferAttribute(new Float32Array(nEdges), 1);
    const iStyle = new THREE.InstancedBufferAttribute(new Float32Array(nEdges), 1);
    for (const a of [iStart, iEnd, iVisible, iRadius, iColor, iSizeA, iSizeB, iStyle]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    edgeGeo.setAttribute("iStart", iStart);
    edgeGeo.setAttribute("iEnd", iEnd);
    edgeGeo.setAttribute("iVisible", iVisible);
    edgeGeo.setAttribute("iRadius", iRadius);
    edgeGeo.setAttribute("iColor", iColor);
    edgeGeo.setAttribute("iSizeA", iSizeA);
    edgeGeo.setAttribute("iSizeB", iSizeB);
    edgeGeo.setAttribute("iStyle", iStyle);
    // point → incident edge ids, built once (header order both sides), so a
    // pointsize write touches exactly its edges' end-size slots
    const edgesOfPoint: number[][] = Array.from({ length: header.n_points }, () => []);
    for (let e = 0; e < nEdges; e++) {
      edgesOfPoint[header.edges[e][0]].push(e);
      edgesOfPoint[header.edges[e][1]].push(e);
    }
    /** re-copy the per-instance endpoints from the current frame — every
     * displayed-frame flip needs it (6 floats per edge, unconditional). */
    const fillEdges = (): void => {
      const pos = positionAttr.array as Float32Array;
      const s = iStart.array as Float32Array;
      const t = iEnd.array as Float32Array;
      for (let e = 0; e < nEdges; e++) {
        const a3 = header.edges[e][0] * 3;
        const b3 = header.edges[e][1] * 3;
        const e3 = e * 3;
        s[e3] = pos[a3]; s[e3 + 1] = pos[a3 + 1]; s[e3 + 2] = pos[a3 + 2];
        t[e3] = pos[b3]; t[e3 + 1] = pos[b3 + 1]; t[e3 + 2] = pos[b3 + 2];
      }
      iStart.needsUpdate = true;
      iEnd.needsUpdate = true;
    };
    /** write iColor (RGBA) for these edge ids from rep.state.edgeColor +
     * edgeOpacity — representation-write cadence only (undefined = all). */
    const fillEdgeColors = (ids?: readonly number[]): void => {
      const ec = rep.state.edgeColor;
      const eo = rep.state.edgeOpacity;
      const c = iColor.array as Float32Array;
      const write = (e: number): void => {
        c[e * 4] = ec[e * 3];
        c[e * 4 + 1] = ec[e * 3 + 1];
        c[e * 4 + 2] = ec[e * 3 + 2];
        c[e * 4 + 3] = eo[e];
      };
      if (ids) for (const e of ids) write(e);
      else for (let e = 0; e < nEdges; e++) write(e);
      iColor.needsUpdate = true;
    };
    /** write iRadius for these edge ids from rep.state.edgeSize — the hook
     * that makes stored widths DRAW (undefined = all). */
    const fillEdgeSizes = (ids?: readonly number[]): void => {
      const es = rep.state.edgeSize;
      const r = iRadius.array as Float32Array;
      if (ids) for (const e of ids) r[e] = es[e];
      else for (let e = 0; e < nEdges; e++) r[e] = es[e];
      iRadius.needsUpdate = true;
    };
    const fillEdgeVisibility = (): void => {
      const v = iVisible.array as Float32Array;
      for (let e = 0; e < nEdges; e++) {
        v[e] = visible[header.edges[e][0]] > 0.5 && visible[header.edges[e][1]] > 0.5 ? 1 : 0;
      }
      iVisible.needsUpdate = true;
    };
    /** write the endpoint-sphere sizes (iSizeA/iSizeB) for every edge incident
     * to these POINTS from rep.state.size — the junction-trim inputs, at
     * rep-write cadence like iRadius (undefined = all points). */
    const fillEdgeEndSizes = (pointIds?: readonly number[]): void => {
      const size = rep.state.size;
      const a = iSizeA.array as Float32Array;
      const b = iSizeB.array as Float32Array;
      const write = (e: number): void => {
        a[e] = size[header.edges[e][0]];
        b[e] = size[header.edges[e][1]];
      };
      if (pointIds) for (const p of pointIds) for (const e of edgesOfPoint[p]) write(e);
      else for (let e = 0; e < nEdges; e++) write(e);
      iSizeA.needsUpdate = true;
      iSizeB.needsUpdate = true;
    };
    fillEdgeColors(); // seed the GPU arrays with the base look
    fillEdgeSizes();
    fillEdgeEndSizes();
    return {
      objects: [new THREE.Mesh(edgeGeo, env.materials.edges)],
      onFrameFlip: fillEdges,
      onRepWrite: {
        edgeColor: fillEdgeColors,
        edgeOpacity: fillEdgeColors, // one RGBA interleave serves both axes
        edgeSize: fillEdgeSizes,
        edgeStyle: (ids) => {
          const buf = iStyle.array as Float32Array;
          for (const e of ids) buf[e] = rep.state.edgeStyle[e];
          iStyle.needsUpdate = true;
        },
        // the junction trim reads POINT sizes — a cross-pass subscription,
        // at rep-write cadence (never the flip loop)
        size: fillEdgeEndSizes,
      },
      onVisibilityChange: fillEdgeVisibility,
      attrVersions: () => ({
        start: iStart.version,
        sizeA: iSizeA.version,
        sizeB: iSizeB.version,
      }),
    };
  },
};

/** Trace tubes + joint spheres — the path-tube generator (replaces the 1-px
 * line pass). Each path SEGMENT draws as a tapered camera-facing tube wall —
 * radius and RGBA at each END vertex, varying interpolation giving the
 * along-segment gradient (the trace buffers' pinned per-vertex semantics) —
 * and each path VERTEX draws as a joint sphere of exactly the tube's end
 * radius (both are traceSize at that vertex), so every bend, cap, and end is
 * covered by construction: no trim machinery, the sphere owns the end zone.
 * Joints are an INDEXED Points pass over the shared position attribute
 * reusing the base pass's impostor MATERIAL — both depth variants,
 * zero-radius/zero-alpha discards, and the sizing chunk for free, and ZERO
 * per-flip work (positions are zero-copy). Tube endpoints re-copy per flip
 * exactly like the edge pass (6 floats/segment, linear, branch-free).
 * Instance slot ≡ segment order from the ONE traceSegments traversal —
 * never compacted. (If two polyline vertices ever shared one point index,
 * the drawn JOINT would be the later write-through, exactly the old
 * per-point-slot caveat; segment state stays per-vertex regardless. The
 * producer's vertices are distinct.) This generator's traceSize
 * subscription replaces the channel's former no-subscriber silence:
 * writing traceSize finally draws. */
interface TraceTubePass extends BuiltPass {
  /** upload versions (test seam): a flip bumps `start` and must never bump
   * `radius`/`color` — the cadence-split proof, as the edge pass has. */
  attrVersions(): { start: number; radius: number; color: number };
}
const traceTubesGenerator: ShapeGenerator<TraceTubePass> = {
  name: "trace-tubes",
  shapeLabel: "tube",
  elementKind: "vertex",
  build(env): TraceTubePass | null {
    const header = env.header;
    const rep = env.rep;
    const positionAttr = env.positionAttr;
    const visible = rep.state.visible;
    const seg = traceSegments(header.polylines);
    if (seg.count === 0) return null;

    // -- the tube pass: one instanced trapezoid per segment ------------------
    const tubeGeo = new THREE.InstancedBufferGeometry();
    tubeGeo.instanceCount = seg.count;
    tubeGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(4 * 3), 3));
    tubeGeo.setAttribute("aCorner", new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
    tubeGeo.setIndex([0, 2, 1, 1, 2, 3]);
    const iStart = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iEnd = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iVisible = new THREE.InstancedBufferAttribute(new Float32Array(seg.count).fill(1), 1);
    const iRadiusA = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    const iRadiusB = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    const iColorA = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 4), 4);
    const iColorB = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 4), 4);
    const iStyle = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    for (const a of [iStart, iEnd, iVisible, iRadiusA, iRadiusB, iColorA, iColorB, iStyle]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    tubeGeo.setAttribute("iStart", iStart);
    tubeGeo.setAttribute("iEnd", iEnd);
    tubeGeo.setAttribute("iVisible", iVisible);
    tubeGeo.setAttribute("iRadiusA", iRadiusA);
    tubeGeo.setAttribute("iRadiusB", iRadiusB);
    tubeGeo.setAttribute("iColorA", iColorA);
    tubeGeo.setAttribute("iColorB", iColorB);
    tubeGeo.setAttribute("iStyle", iStyle);

    // vertex → incident (segment, end) slots, built once from the SAME
    // traversal's arrays, so a trace write touches exactly its segments' end
    // slots (the edge pass's edgesOfPoint discipline).
    const endsOfVertex: { k: number; b: boolean }[][] =
      Array.from({ length: env.traceVertices.length }, () => []);
    for (let k = 0; k < seg.count; k++) {
      endsOfVertex[seg.vertexA[k]].push({ k, b: false });
      endsOfVertex[seg.vertexB[k]].push({ k, b: true });
    }

    // -- the joint pass: indexed impostor points over the shared positions ---
    // Per-point write-through attributes (the old per-point-slot pattern):
    // only path-vertex slots are ever indexed/drawn. aSize here is the
    // VERTEX's traceSize, not the point-pass size — a joint is trace
    // geometry, silhouette-matched to the tube it caps.
    const n = header.n_points;
    const jColor = new Float32Array(n * 3);
    const jSize = new Float32Array(n);
    const jOpacity = new Float32Array(n);
    const jVisible = new Float32Array(n);
    const jColorAttr = new THREE.BufferAttribute(jColor, 3);
    const jSizeAttr = new THREE.BufferAttribute(jSize, 1);
    const jOpacityAttr = new THREE.BufferAttribute(jOpacity, 1);
    const jVisibleAttr = new THREE.BufferAttribute(jVisible, 1);
    // joint style rides the POINT material's aStyle slot — write-through
    // from the joint's OWN vertex's traceStyle (categorical, never blended)
    const jStyle = new Float32Array(n);
    const jStyleAttr = new THREE.BufferAttribute(jStyle, 1);
    for (const a of [jColorAttr, jSizeAttr, jOpacityAttr, jVisibleAttr, jStyleAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    // joints exist only where segments do (a single-vertex path draws
    // nothing, exactly like the line pass it replaces); deduped point ids
    const jointPoints = [...new Set<number>([...seg.pointA, ...seg.pointB])];
    const jointGeo = new THREE.BufferGeometry();
    jointGeo.setAttribute("position", positionAttr);
    jointGeo.setAttribute("aColor", jColorAttr);
    jointGeo.setAttribute("aSize", jSizeAttr);
    jointGeo.setAttribute("aVisible", jVisibleAttr);
    jointGeo.setAttribute("aOpacity", jOpacityAttr);
    jointGeo.setAttribute("aStyle", jStyleAttr);
    jointGeo.setIndex(jointPoints);

    /** re-copy the per-instance segment endpoints from the current frame —
     * frame-flip cadence, a linear copy and nothing else. */
    const fillTubeEnds = (): void => {
      const pos = positionAttr.array as Float32Array;
      const s = iStart.array as Float32Array;
      const t = iEnd.array as Float32Array;
      for (let k = 0; k < seg.count; k++) {
        const a3 = seg.pointA[k] * 3;
        const b3 = seg.pointB[k] * 3;
        const k3 = k * 3;
        s[k3] = pos[a3]; s[k3 + 1] = pos[a3 + 1]; s[k3 + 2] = pos[a3 + 2];
        t[k3] = pos[b3]; t[k3 + 1] = pos[b3 + 1]; t[k3 + 2] = pos[b3 + 2];
      }
      iStart.needsUpdate = true;
      iEnd.needsUpdate = true;
    };
    /** write tube end RGBA + joint RGBA for these VERTEX ids from
     * rep.state.traceColor/traceOpacity — write cadence only, called after
     * every write AND every undo restore (the state is already correct;
     * this just syncs the GPU). */
    const fillTraceColors = (ids?: readonly number[]): void => {
      const tc = rep.state.traceColor;
      const to = rep.state.traceOpacity;
      const cA = iColorA.array as Float32Array;
      const cB = iColorB.array as Float32Array;
      const write = (v: number): void => {
        const r = tc[v * 3], g = tc[v * 3 + 1], b = tc[v * 3 + 2], a = to[v];
        for (const e of endsOfVertex[v]) {
          const at = e.k * 4;
          const arr = e.b ? cB : cA;
          arr[at] = r; arr[at + 1] = g; arr[at + 2] = b; arr[at + 3] = a;
        }
        const p = env.traceVertices[v];
        jColor[p * 3] = r; jColor[p * 3 + 1] = g; jColor[p * 3 + 2] = b;
        jOpacity[p] = a;
      };
      if (ids) for (const v of ids) write(v);
      else for (let v = 0; v < env.traceVertices.length; v++) write(v);
      iColorA.needsUpdate = true;
      iColorB.needsUpdate = true;
      jColorAttr.needsUpdate = true;
      jOpacityAttr.needsUpdate = true;
    };
    /** write tube end radii + joint radii for these VERTEX ids from
     * rep.state.traceSize — THE hook that makes the stored widths draw. */
    const fillTraceSizes = (ids?: readonly number[]): void => {
      const tsz = rep.state.traceSize;
      const rA = iRadiusA.array as Float32Array;
      const rB = iRadiusB.array as Float32Array;
      const write = (v: number): void => {
        for (const e of endsOfVertex[v]) (e.b ? rB : rA)[e.k] = tsz[v];
        jSize[env.traceVertices[v]] = tsz[v];
      };
      if (ids) for (const v of ids) write(v);
      else for (let v = 0; v < env.traceVertices.length; v++) write(v);
      iRadiusA.needsUpdate = true;
      iRadiusB.needsUpdate = true;
      jSizeAttr.needsUpdate = true;
    };
    /** segment: both endpoint POINTS visible (parity with the line pass's
     * index rebuild). Joint: its point visible AND ≥1 incident segment
     * visible — a fully-hidden path leaves no floating joint balls. */
    const fillTraceVisibility = (): void => {
      const vis = iVisible.array as Float32Array;
      for (let k = 0; k < seg.count; k++) {
        vis[k] = visible[seg.pointA[k]] > 0.5 && visible[seg.pointB[k]] > 0.5 ? 1 : 0;
      }
      for (let v = 0; v < env.traceVertices.length; v++) {
        let any = 0;
        for (const e of endsOfVertex[v]) if (vis[e.k] > 0.5) { any = 1; break; }
        jVisible[env.traceVertices[v]] =
          visible[env.traceVertices[v]] > 0.5 && any ? 1 : 0;
      }
      iVisible.needsUpdate = true;
      jVisibleAttr.needsUpdate = true;
    };
    fillTraceColors(); // seed the GPU arrays with the base look
    fillTraceSizes();
    fillTraceVisibility();

    const tubes = new THREE.Mesh(tubeGeo, env.materials.traces);
    // joints REUSE the base impostor material — same variant, same shading
    const joints = new THREE.Points(jointGeo, env.materials.points);
    return {
      objects: [tubes, joints],
      onFrameFlip: fillTubeEnds,
      onRepWrite: {
        traceColor: fillTraceColors,
        traceOpacity: fillTraceColors, // one RGBA interleave serves both axes
        traceSize: fillTraceSizes,     // the formerly-silent channel DRAWS
        traceStyle: (ids) => {
          // a SEGMENT draws with its A-end vertex's style (flat — style
          // params are categorical and must not blend along the wall);
          // the joint takes its own vertex's style
          const ts = rep.state.traceStyle;
          const buf = iStyle.array as Float32Array;
          for (const v of ids) {
            for (let k = 0; k < seg.count; k++) if (seg.vertexA[k] === v) buf[k] = ts[v];
            jStyle[env.traceVertices[v]] = ts[v];
          }
          iStyle.needsUpdate = true;
          jStyleAttr.needsUpdate = true;
        },
      },
      onVisibilityChange: fillTraceVisibility,
      attrVersions: () => ({
        start: iStart.version,
        radius: iRadiusA.version,
        color: iColorA.version,
      }),
    };
  },
};

/** Trace RIBBONS — the first ORIENTED shape: real (non-impostor) quads
 * whose plane comes from the orientation buffer (a bound vector channel),
 * conditioned in the shader (view-space, ⊥ along, unit — the O-1 raw-store
 * recommendation executed at draw). Registers DISABLED behind the shape
 * verb; with orientation unbound the buffer is zero and every quad
 * collapses (the ruled degeneracy: no data, no plane, no pixels). No joint
 * pass: ribbon ends are naive (logged) — the tube's joint-sphere identity
 * is rotational symmetry's trick and dies with it. */
interface RibbonPass extends BuiltPass {
  attrVersions(): { start: number; across: number; width: number; color: number };
}
const traceRibbonsGenerator: ShapeGenerator<RibbonPass> = {
  name: "trace-ribbons",
  shapeLabel: "ribbon",
  requiresAxis: ORIENTATION_AXIS,
  elementKind: "vertex",
  build(env): RibbonPass | null {
    const header = env.header;
    const rep = env.rep;
    const seg = traceSegments(header.polylines);
    if (seg.count === 0) return null;
    const geo = new THREE.InstancedBufferGeometry();
    geo.instanceCount = seg.count;
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(4 * 3), 3));
    geo.setAttribute("aCorner", new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    const iStart = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iEnd = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iVisible = new THREE.InstancedBufferAttribute(new Float32Array(seg.count).fill(1), 1);
    const iWidthA = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    const iWidthB = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    const iColorA = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 4), 4);
    const iColorB = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 4), 4);
    const iAcrossA = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iAcrossB = new THREE.InstancedBufferAttribute(new Float32Array(seg.count * 3), 3);
    const iStyle = new THREE.InstancedBufferAttribute(new Float32Array(seg.count), 1);
    for (const a of [iStart, iEnd, iVisible, iWidthA, iWidthB, iColorA, iColorB, iAcrossA, iAcrossB, iStyle]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute("iStart", iStart);
    geo.setAttribute("iEnd", iEnd);
    geo.setAttribute("iVisible", iVisible);
    geo.setAttribute("iWidthA", iWidthA);
    geo.setAttribute("iWidthB", iWidthB);
    geo.setAttribute("iColorA", iColorA);
    geo.setAttribute("iColorB", iColorB);
    geo.setAttribute("iAcrossA", iAcrossA);
    geo.setAttribute("iAcrossB", iAcrossB);
    geo.setAttribute("iStyle", iStyle);
    const endsOfVertex: { k: number; b: boolean }[][] =
      Array.from({ length: env.traceVertices.length }, () => []);
    for (let k = 0; k < seg.count; k++) {
      endsOfVertex[seg.vertexA[k]].push({ k, b: false });
      endsOfVertex[seg.vertexB[k]].push({ k, b: true });
    }
    const visible = rep.state.visible;
    const fillEnds = (): void => {
      const pos = env.positionAttr.array as Float32Array;
      const s = iStart.array as Float32Array;
      const t = iEnd.array as Float32Array;
      for (let k = 0; k < seg.count; k++) {
        const a3 = seg.pointA[k] * 3;
        const b3 = seg.pointB[k] * 3;
        const k3 = k * 3;
        s[k3] = pos[a3]; s[k3 + 1] = pos[a3 + 1]; s[k3 + 2] = pos[a3 + 2];
        t[k3] = pos[b3]; t[k3 + 1] = pos[b3 + 1]; t[k3 + 2] = pos[b3 + 2];
      }
      iStart.needsUpdate = true;
      iEnd.needsUpdate = true;
    };
    const fillColors = (ids?: readonly number[]): void => {
      const tc = rep.state.traceColor;
      const to = rep.state.traceOpacity;
      const cA = iColorA.array as Float32Array;
      const cB = iColorB.array as Float32Array;
      const write = (v: number): void => {
        const r = tc[v * 3], g = tc[v * 3 + 1], b = tc[v * 3 + 2], a = to[v];
        for (const e of endsOfVertex[v]) {
          const at = e.k * 4;
          const arr = e.b ? cB : cA;
          arr[at] = r; arr[at + 1] = g; arr[at + 2] = b; arr[at + 3] = a;
        }
      };
      if (ids) for (const v of ids) write(v);
      else for (let v = 0; v < env.traceVertices.length; v++) write(v);
      iColorA.needsUpdate = true;
      iColorB.needsUpdate = true;
    };
    const fillWidths = (ids?: readonly number[]): void => {
      const ts = rep.state.traceSize;
      const wA = iWidthA.array as Float32Array;
      const wB = iWidthB.array as Float32Array;
      const write = (v: number): void => {
        for (const e of endsOfVertex[v]) (e.b ? wB : wA)[e.k] = ts[v];
      };
      if (ids) for (const v of ids) write(v);
      else for (let v = 0; v < env.traceVertices.length; v++) write(v);
      iWidthA.needsUpdate = true;
      iWidthB.needsUpdate = true;
    };
    const fillAcross = (ids?: readonly number[]): void => {
      const ori = rep.state.orientation;
      const aA = iAcrossA.array as Float32Array;
      const aB = iAcrossB.array as Float32Array;
      const write = (v: number): void => {
        const x = ori[v * 3], y = ori[v * 3 + 1], z = ori[v * 3 + 2];
        for (const e of endsOfVertex[v]) {
          const at = e.k * 3;
          const arr = e.b ? aB : aA;
          arr[at] = x; arr[at + 1] = y; arr[at + 2] = z;
        }
      };
      if (ids) for (const v of ids) write(v);
      else for (let v = 0; v < env.traceVertices.length; v++) write(v);
      iAcrossA.needsUpdate = true;
      iAcrossB.needsUpdate = true;
    };
    const fillStyles = (ids?: readonly number[]): void => {
      const st = rep.state.traceStyle;
      const buf = iStyle.array as Float32Array;
      if (ids) {
        for (const v of ids) {
          for (let k = 0; k < seg.count; k++) if (seg.vertexA[k] === v) buf[k] = st[v];
        }
      } else {
        for (let k = 0; k < seg.count; k++) buf[k] = st[seg.vertexA[k]];
      }
      iStyle.needsUpdate = true;
    };
    const fillVisibility = (): void => {
      const vis = iVisible.array as Float32Array;
      for (let k = 0; k < seg.count; k++) {
        vis[k] = visible[seg.pointA[k]] > 0.5 && visible[seg.pointB[k]] > 0.5 ? 1 : 0;
      }
      iVisible.needsUpdate = true;
    };
    const sh = ribbonShaders();
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true, // C2 discipline: explicit, never inherited
      depthTest: true,
      side: THREE.DoubleSide, // a ribbon HAS a back face (two-sided shade)
      uniforms: {
        uWorldPerSize: env.sizing.uWorldPerSize,
        uStyles: env.styleUniforms.uStyles,
      },
      vertexShader: sh.vertex,
      fragmentShader: sh.fragment,
    });
    const fillAll = (): void => {
      fillEnds();
      fillColors();
      fillWidths();
      fillAcross();
      fillStyles();
      fillVisibility();
    };
    fillAll(); // seed (harmless while disabled; exact when enabled at boot)
    return {
      objects: [new THREE.Mesh(geo, material)],
      onFrameFlip: fillEnds,
      onRepWrite: {
        traceColor: fillColors,
        traceOpacity: fillColors,
        traceSize: fillWidths,
        traceStyle: fillStyles,
        // THE oriented consumer: the orientation buffer (bind-time writes
        // AND per-flip re-derives both dispatch this channel) reaches the
        // instance attrs here — O-2 closing the loop O-1 opened.
        orientation: fillAcross,
      },
      onVisibilityChange: fillVisibility,
      onEnable: fillAll,
      attrVersions: () => ({
        start: iStart.version,
        across: iAcrossA.version,
        width: iWidthA.version,
        color: iColorA.version,
      }),
    };
  },
};

/** The two overlays export their material so host features (the flash
 * envelope, the debug seam) can drive/read uStrength. */
interface OverlayPass extends BuiltPass {
  material: THREE.ShaderMaterial;
}

/** Pending-target overlay: a second Points pass over all N, gently pulsing
 * targeted & visible points to a light green. Both overlays bind aSize/
 * aVisible as the SAME BufferAttribute objects the base pass uses (already
 * in the host's repAttrs — one upload path, no second list to keep in
 * sync), so the tint always covers exactly the base sphere's silhouette at
 * any stored size. The breathing pulse is stateless uniform math, so it
 * rides the pass's own render tick. */
const pendingOverlayGenerator: ShapeGenerator<OverlayPass> = {
  name: "pending-overlay",
  elementKind: "overlay",
  build(env): OverlayPass {
    const selMat = highlightMaterial(env.sizing, SELECTION_COLOR, 0.45);
    const overlayGeo = new THREE.BufferGeometry();
    overlayGeo.setAttribute("position", env.positionAttr);
    overlayGeo.setAttribute("aVisible", env.pointAttrs.visible);
    overlayGeo.setAttribute("aSize", env.pointAttrs.size);
    overlayGeo.setAttribute("aFlag", env.pointAttrs.sel);
    const overlay = new THREE.Points(overlayGeo, selMat);
    overlay.renderOrder = 11;
    return {
      objects: [overlay],
      onRenderTick: (now) => {
        selMat.uniforms.uStrength.value =
          0.5 + 0.5 * Math.sin((now / GREEN_PULSE_PERIOD_MS) * Math.PI * 2);
      },
      material: selMat,
    };
  },
};

/** Focus flash: a brief light-yellow tint over the last-focused region. The
 * swell-and-fade envelope stays HOST-side (it owns the flashStart/flashPts/
 * flashArray bookkeeping) and drives this pass through the material handle. */
const focusFlashGenerator: ShapeGenerator<OverlayPass> = {
  name: "focus-flash",
  elementKind: "overlay",
  build(env): OverlayPass {
    const flashMat = focusFlashMaterial(env.sizing, FOCUS_COLOR, SELECTION_COLOR);
    const flashGeo = new THREE.BufferGeometry();
    flashGeo.setAttribute("position", env.positionAttr);
    flashGeo.setAttribute("aVisible", env.pointAttrs.visible);
    flashGeo.setAttribute("aSize", env.pointAttrs.size);
    flashGeo.setAttribute("aFlag", env.pointAttrs.flash);
    flashGeo.setAttribute("aSel", env.pointAttrs.sel); // blend the flash on selected points
    const flash = new THREE.Points(flashGeo, flashMat);
    flash.renderOrder = 12;
    return { objects: [flash], material: flashMat };
  },
};

/** Initial framing. `box`/`size` come from the ONE sceneExtent call in
 * main() — the same S the impostor scale `k` derives from. Pixel parity is a
 * relationship between `k` and the CAMERA, so the two must never compute S
 * independently (even on the fallback box, both misframe together and a
 * default element still lands at its target pixel extent). */
function frameCamera(box: Box3Like, size: number, aspect: number) {
  const center = new THREE.Vector3(
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  );
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, aspect, size / 1000, size * 100);
  camera.position
    .copy(center)
    .add(new THREE.Vector3(0.9, 0.7, 1.1).normalize().multiplyScalar(size * FRAME_DISTANCE_FACTOR));
  camera.lookAt(center);
  return { camera, target: center, size };
}

async function main(): Promise<void> {
  const cfg: ViewerConfig = (window as unknown as { __VIEWER__?: ViewerConfig }).__VIEWER__ ?? {};
  const host = acquireVsCodeApi();
  const transport = new Transport((msg) => host.postMessage(msg));
  // Commands/completions from the terminal panel (routed through the host)
  // run through the SAME dispatcher/completer the test seam uses; rebound once
  // the registry exists below.
  let runCommand: (text: string) => CommandResult = () => ({
    status: "error",
    message: "viewer is still loading",
  });
  let runComplete: (text: string, cursor: number) => Completion = () => ({
    start: 0,
    candidates: [],
    applied: "",
  });
  // Typed tool-results forwarded from the conversation panel (claude-bind);
  // rebound onto the real binding once the command context exists below.
  let bindResult: (raw: unknown) => { ok: boolean; message: string } = () => ({
    ok: false,
    message: "viewer is still loading",
  });
  // Workspace analysis mods arrive from the host once it sees viewerInfo, and
  // again after every write_mod save; rebound onto the real installer once the
  // command registry exists below. Returns WHAT IT DID — the host awaits this
  // outcome before letting write_mod claim a registration.
  let installMods: (raw: unknown) => ModInstallOutcome =
    () => ({ installed: [], skipped: [] });
  // `produces: commands` mods run their emitted strings through the command
  // path; late-bound once the command registry + validation registry exist.
  let runCommandMod: (mod: AnalysisMod, cmds: string[]) => void = () => {};
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as {
      type?: string; id?: number; text?: string; cursor?: number;
      callId?: string; result?: unknown;
    };
    if (msg?.type === "command") {
      const result = runCommand(String(msg.text ?? ""));
      host.postMessage({ type: "commandResult", id: msg.id, ...result });
      return;
    }
    if (msg?.type === "complete") {
      const result = runComplete(String(msg.text ?? ""), Number(msg.cursor ?? 0));
      host.postMessage({ type: "completeResult", id: msg.id, ...result });
      return;
    }
    if (msg?.type === "claude-bind") {
      // per-frame-series and scatter are the PLOT's kinds — the host routes
      // them there and answers on the outcome channel itself; the viewer
      // stays silent. Checked on the RAW kind, so even a malformed plot
      // payload never reaches this binding (the plot route errors it).
      const rawKind = (msg.result as { kind?: unknown } | null | undefined)?.kind;
      if (rawKind === "per-frame-series" || rawKind === "scatter") return;
      const outcome = bindResult(msg.result);
      host.postMessage({ type: "claude-bind-result", callId: msg.callId, ...outcome });
      return;
    }
    if (msg?.type === "seekFrame") {
      // the plot's click-to-seek — the EXACT setter the scrubber drives;
      // the display loop picks it up and re-syncs the scrubber itself
      seekFrame(Number((msg as { frame?: number }).frame ?? 0));
      return;
    }
    if (msg?.type === "modsLoaded") {
      const push = msg as unknown as { mods?: unknown; id?: number; confirm?: string };
      const outcome = installMods(push.mods);
      // A push that carries an id is a write_mod save AWAITING confirmation: the
      // host holds the tool's promise open until the viewer — the layer that
      // actually registers — says what happened. Answered on the SAME
      // id-correlated commandResult channel every assistant command already uses;
      // the boot push carries no id and is not answered.
      if (typeof push.id === "number" && typeof push.confirm === "string") {
        const report = modInstallReport(outcome, push.confirm);
        host.postMessage({ type: "commandResult", id: push.id, ...report });
      }
      return;
    }
    if (msg?.type === "confirm-answer") {
      // the terminal's answer to the LATEST confirmation prompt: y acts,
      // anything else cancels — and clears the stash either way, so the
      // viewer-side slot can never go stale against the terminal's
      if ((msg as { yes?: boolean }).yes === true) confirmRmDeletion();
      else cancelRmDeletion();
      return;
    }
    if (msg?.type === "rm-mods-result") {
      finishRmDeletion(msg as unknown as {
        deleted?: string[]; failed?: { name: string; error: string }[];
      });
      return;
    }
    transport.handleMessage(e.data);
  });
  // rm wiring — late-bound below (needs the registry). NOT undoable and
  // never on the undo stack: the filesystem is outside the undo model.
  let confirmRmDeletion: () => void = () => {};
  let cancelRmDeletion: () => void = () => {};
  let finishRmDeletion: (r: { deleted?: string[]; failed?: { name: string; error: string }[] }) => void =
    () => {};
  // late-bound once the player exists (the listener is live before boot ends)
  let seekFrame: (frame: number) => void = () => {};

  setStatus("requesting header…");
  const headerBytes = await transport.request({ type: "header" });
  rejectIfErrorPayload(headerBytes);
  const header = parseHeader(new TextDecoder().decode(headerBytes));
  const nFrames = header.n_frames;
  // one-shot: the host (plot orchestration, stub) learns the frame count —
  // T is authoritative here in the header, nowhere host-side
  host.postMessage({ type: "viewerInfo", nFrames });

  const container = document.getElementById("app");
  if (!container) throw new Error("missing #app container");
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: cfg.screenshotMode === true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(container.clientWidth, container.clientHeight);
  // Clear to the scene background, never the GL default — otherwise a resize (or
  // the first frame before data arrives) flashes the default clear color (A4).
  renderer.setClearColor(new THREE.Color(BACKGROUND), 1);
  container.appendChild(renderer.domElement);

  // -- interaction state layers ------------------------------------------------
  // Polyline vertices in HEADER ORDER (flattened polylines) — the axis
  // rep.state.traceColor is indexed by; traceVertices[v] = the point index.
  const traceVertices = header.polylines.flat();
  const rep = new RepresentationLayer(header.n_points, header.edges.length, traceVertices.length);
  const hierarchy = new Hierarchy(header);
  const model = new SelectionModel(hierarchy); // pending target + committed selections
  const selArray = new Float32Array(header.n_points); // per-point target flag (green)
  const flashArray = new Float32Array(header.n_points); // per-point focus-flash flag

  // -- scene scale: ONE sceneExtent call feeds BOTH the camera framing and
  // the impostor world-radius constant `k` (A4 — never fork S; parity is
  // between `k` and the camera). The null-bbox fallback is LOUD (C1): the
  // status line carries the warning for the whole session.
  const scale = sceneExtent(header.bbox);
  if (scale.fallback) console.warn(`[viewer] ${NO_BBOX_WARNING}`);
  // DEFAULT = VARIANT 2 (true per-fragment depth): decided on architectural
  // merits, NOT hardware-measured (bench unrunnable in-environment) — real
  // geometry (the ribbon) composes with sprite depth correctly only when
  // sprites write analytic depth; S44 records variant 1 mis-sorting the
  // same crossings variant 2 gets right. Revert = this default + the
  // setting default (package.json) + src/extension.ts, one log entry.
  const depthVariant: 1 | 2 = cfg.depthVariant === 1 ? 1 : 2;
  const TAN_HALF_FOV = Math.tan(((CAMERA_FOV_DEG / 2) * Math.PI) / 180);
  const sizing: SizingUniforms = {
    uWorldPerSize: { value: worldPerSizeUnit(scale.S) },
    uPxPerWorld: { value: 1 }, // set for real by updateSizingUniforms below
    uProjZ: { value: new THREE.Vector2() },
  };

  // -- scene assembly through the shape-generator registry ----------------------
  // Host-owned attribute OBJECTS: the shared position attribute plus the
  // per-point attributes wrapping the rep buffers and the overlay flags.
  // Shared as objects so the overlays silhouette-match the base pass by
  // identity, and so the ONE repAttrs list below covers every consumer.
  const positionAttr = new THREE.BufferAttribute(new Float32Array(header.n_points * 3), 3);
  const pointAttrs: PassEnv["pointAttrs"] = {
    color: new THREE.BufferAttribute(rep.state.color, 3),
    size: new THREE.BufferAttribute(rep.state.size, 1),
    visible: new THREE.BufferAttribute(rep.state.visible, 1),
    opacity: new THREE.BufferAttribute(rep.state.opacity, 1),
    style: new THREE.BufferAttribute(rep.state.style, 1),
    sel: new THREE.BufferAttribute(selArray, 1),
    flash: new THREE.BufferAttribute(flashArray, 1),
  };
  for (const a of [
    positionAttr, pointAttrs.color, pointAttrs.size, pointAttrs.visible,
    pointAttrs.opacity, pointAttrs.style, pointAttrs.sel, pointAttrs.flash,
  ]) {
    a.setUsage(THREE.DynamicDrawUsage);
  }
  /** THE re-upload list: color/size/visible/opacity/style re-upload when the
   * render loop sees rep.dirty. Any new per-point attribute joins it in the
   * same edit that binds it, or it silently stops reaching the GPU. */
  const repAttrs = [pointAttrs.color, pointAttrs.size, pointAttrs.visible, pointAttrs.opacity, pointAttrs.style];
  // shading uniforms from the DEFAULT style — byte-identical to the former
  // hardcoded constants (webview/styles.ts pins this); shared objects, one
  // instance each, across all three geometry materials
  const styleUniforms = makeStyleUniforms();
  const materials = makeGeometryMaterials(sizing, styleUniforms, depthVariant);
  const passEnv: PassEnv = {
    header, rep, positionAttr, pointAttrs, traceVertices, sizing, styleUniforms, depthVariant, materials,
  };
  const registry = new ShapeRegistry();
  // Registration order IS draw order (scene order — the naive-transparency
  // compositing depends on it): points, edges, polylines, then the overlays.
  registry.add(spherePointsGenerator, passEnv);
  const edgePass = registry.add(edgeTubesGenerator, passEnv);
  const tracePass = registry.add(traceTubesGenerator, passEnv);
  // The RIBBON registers DISABLED: the tube stays the default; `shape
  // traces ribbon` swaps (A-3's machinery — onEnable re-fills the gap).
  const ribbonPass = registry.add(traceRibbonsGenerator, passEnv, false);
  const pendingPass = registry.add(pendingOverlayGenerator, passEnv)!;
  const flashPass = registry.add(focusFlashGenerator, passEnv)!;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  for (const obj of registry.objects()) {
    obj.frustumCulled = false;
    obj.visible = false; // until the first frame is displayed
    scene.add(obj);
  }
  const { camera, target, size: sceneSize } = frameCamera(
    scale.box,
    scale.S,
    container.clientWidth / container.clientHeight,
  );
  /** Re-derive the resize-dependent sizing uniforms: uPxPerWorld tracks the
   * drawing-buffer height (device px, so devicePixelRatio is implicit);
   * uProjZ re-reads the projection z-row (near/far-only, so effectively
   * constant — re-read is free hygiene). `k` itself never changes. */
  const updateSizingUniforms = (): void => {
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    sizing.uPxPerWorld.value = buf.y / (2 * TAN_HALF_FOV);
    sizing.uProjZ.value.set(
      camera.projectionMatrix.elements[10],
      camera.projectionMatrix.elements[14],
    );
  };
  updateSizingUniforms();
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.target.copy(target);
  // Gentle inertia (4.7 A5): a flick gives a short nudge that decays quickly, not
  // a long spin. Higher damping = faster decay; a slow drag still positions
  // precisely.
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.32;
  controls.rotateSpeed = 1.5;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.3;
  controls.handleResize();
  controls.update();

  // Scene center (bbox center) — the pivot double-click-empty frames the whole
  // scene around, keeping the current viewing direction.
  const homeTarget = controls.target.clone();

  // Camera transitions are animated, not snapped (4.6 B2): a short ease-in-out
  // tween of position + target. While a tween runs, trackball control is
  // disabled so it can't fight the interpolation.
  const CAMERA_TWEEN_MS = 360;
  const easeInOut = (k: number): number =>
    k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  let camTween:
    | { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number }
    | null = null;
  // Zero TrackballControls' residual rotate/zoom/pan velocity so leftover
  // inertia doesn't resume after a camera tween finishes (which would drift the
  // orientation). The motion state is internal (underscore) fields.
  const stopControlsMotion = (): void => {
    const c = controls as unknown as {
      _movePrev: THREE.Vector2; _moveCurr: THREE.Vector2;
      _zoomStart: THREE.Vector2; _zoomEnd: THREE.Vector2;
      _panStart: THREE.Vector2; _panEnd: THREE.Vector2;
    };
    c._movePrev.copy(c._moveCurr);
    c._zoomStart.copy(c._zoomEnd);
    c._panStart.copy(c._panEnd);
  };
  const animateCameraTo = (toPos: THREE.Vector3, toTarget: THREE.Vector3): void => {
    camTween = {
      p0: camera.position.clone(),
      p1: toPos.clone(),
      t0: controls.target.clone(),
      t1: toTarget.clone(),
      start: performance.now(),
    };
    stopControlsMotion();
    controls.enabled = false;
  };
  // Double-click empty space "scales back" to frame the whole scene from the
  // CURRENT orientation — it recenters on the scene and backs the distance out
  // to the home framing, but keeps the current viewing direction (no flip to the
  // initial pose).
  const resetCamera = (): void => {
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(0.9, 0.7, 1.1);
    dir.normalize();
    animateCameraTo(
      homeTarget.clone().addScaledVector(dir, sceneSize * FRAME_DISTANCE_FACTOR),
      homeTarget.clone(),
    );
  };

  // Resize atomically: size + camera aspect + trackball screen + an immediate
  // redraw, so there is never a stretched or blank (white) intermediate frame.
  // Coalesced to one call per animation frame (a debounce) since a drag-resize
  // fires many events.
  const applyResize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateSizingUniforms(); // impostor sizing tracks the drawing buffer
    controls.handleResize();
    renderer.render(scene, camera);
    window.dispatchEvent(new Event("panelrelayout")); // virtual lists re-window
  };
  let resizePending = 0;
  const scheduleResize = (): void => {
    if (resizePending) return;
    resizePending = requestAnimationFrame(() => {
      resizePending = 0;
      applyResize();
    });
  };
  window.addEventListener("resize", scheduleResize);

  // Dockable + collapsible classification panel (4.6.1). The panel can sit on any
  // edge (left/right/top/bottom) and collapse away; the divider resizes it (its
  // width when side-docked, its height when top/bottom-docked). Preference is
  // persisted via the webview state API when available (absent in the harness).
  const persist =
    host.getState && host.setState
      ? {
          get: () => (host.getState!() as { panel?: PanelState } | undefined)?.panel,
          set: (s: PanelState) =>
            host.setState!({ ...((host.getState!() as object) ?? {}), panel: s }),
        }
      : undefined;
  const panel = setupPanelDocking(scheduleResize, applyResize, persist);

  // -- state → render bit flips (incremental) -----------------------------------
  const visible = rep.state.visible;
  let selDirty = false;
  /** Recompute the green (target) + visible (hidden-union) bits for exactly
   * these points — the ONE place model state becomes pixels. */
  const refreshPoints = (points: number[] | null): void => {
    if (!points || points.length === 0) return;
    let visChanged = false;
    for (const p of points) {
      const s = model.targetContains(p) ? 1 : 0;
      if (selArray[p] !== s) {
        selArray[p] = s;
        selDirty = true;
      }
      const v = model.isPointHidden(p) ? 0 : 1;
      if (visible[p] !== v) {
        visible[p] = v;
        visChanged = true;
      }
    }
    if (visChanged) {
      rep.dirty = true; // re-upload visible; the overlays share it
      registry.visibilityChange();
    }
  };

  // -- camera focus (yellow pulse + orient; never on the undo stack) -----------
  const zoomToPoints = (indices: number[]): void => {
    const b = selectionBounds(positionAttr.array as Float32Array, indices);
    if (!b) return;
    const center = new THREE.Vector3(b.center[0], b.center[1], b.center[2]);
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(b.radius, sceneSize * 0.02) / Math.sin(fov / 2) * 1.4;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    animateCameraTo(center.clone().addScaledVector(dir, dist), center);
  };
  /** Frame what is actually VISIBLE: with parts hidden, an empty click zooms
   * and centers on the remaining points, not the whole-scene bbox. */
  const frameVisible = (): void => {
    const idx: number[] = [];
    for (let p = 0; p < visible.length; p++) if (visible[p] > 0.5) idx.push(p);
    if (idx.length === 0 || idx.length === visible.length) resetCamera();
    else zoomToPoints(idx);
  };
  let flashStart = -1;
  let flashPts: number[] = [];
  const focusPoints = (indices: number[]): void => {
    if (indices.length === 0) return;
    // While EDITING a selection the camera stays parked — focus actions still
    // pulse the region, but never move the view; Done restores focus moves.
    if (!model.editing) zoomToPoints(indices);
    for (const p of flashPts) flashArray[p] = 0;
    for (const p of indices) flashArray[p] = 1;
    flashPts = indices;
    flashStart = performance.now();
    pointAttrs.flash.needsUpdate = true;
  };
  const focusEntry = (e: Entry): void => focusPoints(hierarchy.pointsOf(e));

  // -- viewer-corner actions: Clear (two-step confirm) + Create/Done -----------
  const commitBtn = document.getElementById("commit-btn") as HTMLButtonElement | null;
  const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement | null;
  let clearArmedTimer = 0;
  const disarmClear = (): void => {
    if (!clearBtn) return;
    clearTimeout(clearArmedTimer);
    clearArmedTimer = 0;
    clearBtn.classList.remove("confirm");
    clearBtn.textContent = "Clear";
  };
  const updateCommitBtn = (): void => {
    if (!commitBtn) return;
    const editing = model.editing !== null;
    commitBtn.textContent = editing ? "Done" : "Create selection";
    commitBtn.classList.toggle("editing", editing);
    commitBtn.disabled = !editing && model.pending.entryCount === 0;
    if (clearBtn) {
      const canClear = model.target.entryCount > 0;
      clearBtn.disabled = !canClear;
      if (!canClear) disarmClear();
    }
  };
  commitBtn?.addEventListener("click", () => {
    if (model.editing) {
      refreshPoints(model.endEdit());
    } else {
      const sel = model.commit();
      if (sel) refreshPoints(sel.set.resolvedPoints()); // green clears
    }
  });
  // Clear asks "are you sure" inline: first click arms it for a few seconds,
  // the second click actually clears the current selection (undoable).
  clearBtn?.addEventListener("click", () => {
    if (!clearBtn.classList.contains("confirm")) {
      clearBtn.classList.add("confirm");
      clearBtn.textContent = "sure?";
      clearArmedTimer = window.setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    refreshPoints(model.clearTarget());
  });

  // -- the two panel sections, both through the ONE tree component --------------
  const fullTree = buildTree(header);
  let targetTouch = model.touchKeys(model.target);
  const decorateBottom = (e: Entry, row: HTMLElement): void => {
    const covered = model.targetCoversEntry(e);
    row.classList.toggle("sel-covered", covered);
    row.classList.toggle("sel-partial", !covered && targetTouch.has(`${e.level}:${e.id}`));
  };

  let bottomTree: TreeHandle | null = null;
  let brackets: { schedule(): void } | null = null;
  // entries changed by the current paint stroke, and the stroke's direction:
  // a stroke STARTING on an already-selected row removes; otherwise it adds.
  const strokeTouched = new Set<string>();
  let strokeRemoves = false;
  const treeHost = document.getElementById("tree-host");
  if (treeHost) {
    bottomTree = mountTree(
      treeHost,
      fullTree,
      hierarchy,
      {
        // bottom = BUILD: left click/drag edits the pending target — drag
        // paints, and a drag STARTING on a selected row un-paints the same
        // way. Right click/drag FOCUSES a row or a region (light pulse);
        // camera otherwise untouched. Backtracking reverts only what THIS
        // stroke changed.
        primaryClick: (e) => refreshPoints(model.toggleInTarget(e)),
        trailStart: (start) => {
          strokeTouched.clear();
          // a stroke starting on any SELECTED row (entry or covered by a
          // coarser entry) removes/carves; otherwise it adds
          strokeRemoves = model.targetCoversEntry(start);
          model.beginStroke();
        },
        trailAdd: (e) => {
          const pts = strokeRemoves ? model.removeFromTarget(e) : model.addToTarget(e);
          if (pts.length > 0) {
            strokeTouched.add(`${e.level}:${e.id}`);
            refreshPoints(pts);
          }
        },
        trailRemove: (e) => {
          const key = `${e.level}:${e.id}`;
          if (!strokeTouched.delete(key)) return;
          refreshPoints(strokeRemoves ? model.addToTarget(e) : model.removeFromTarget(e));
        },
        trailEnd: () => model.endStroke(),
        secondaryClick: (e) => focusEntry(e),
        secondaryTrailEnd: (entries) => {
          const pts: number[] = [];
          for (const e of entries) pts.push(...hierarchy.pointsOf(e));
          focusPoints(pts); // right-drag = view the dragged region
        },
      },
      {
        gutter: BRACKET_GUTTER_PX,
        decorate: decorateBottom,
        onLayout: () => brackets?.schedule(),
        flashOnSecondary: true,
      },
    );
    brackets = mountBrackets(treeHost, bottomTree, model);
  }

  const committedActions: CommittedActions = {
    focusEntry,
    focusPoints,
    toggleHidden: (id) => refreshPoints(model.toggleHidden(id)),
    toggleEntryHidden: (id, e) => refreshPoints(model.toggleEntryHidden(id, e)),
    setEntryHidden: (id, e, hidden) => refreshPoints(model.setEntryHidden(id, e, hidden)),
    beginStroke: () => model.beginStroke(),
    endStroke: () => model.endStroke(),
    beginEdit: (id) => refreshPoints(model.beginEdit(id)),
    endEdit: () => refreshPoints(model.endEdit()),
    rename: (id, name) => model.rename(id, name),
    deleteSelection: (id) => refreshPoints(model.deleteSelection(id)),
    removeEntry: (e) => refreshPoints(model.removeFromTarget(e)),
  };
  const selectionsHost = document.getElementById("selections");
  const committedSection = selectionsHost
    ? mountCommitted(selectionsHost, model, hierarchy, committedActions)
    : null;

  // -- command layer: typed verbs drive the SAME action paths as the gestures --
  // FLASH-PARITY INVARIANT: for any command-driven focus, every currently-
  // mounted row whose covered points intersect the resolved set flashes — in
  // the bottom tree AND the committed member lists — and no other row does,
  // independent of how many terms the expression had, which term contributed
  // a point, or what level each term resolved at. Matching is POINT-SET
  // based, never entry-identity based (a subgroup-derived and a leaf-derived
  // term over the same points light the same rows). Unmounted rows
  // (collapsed branch, scrolled out of a virtual list) don't flash — the
  // no-force-expand rule stands. Flashing rides the same flashRow the
  // gesture feedback uses.
  const flashPointRows = (points: readonly number[], cls = "row-flash"): void => {
    const set = new Set(points);
    for (const row of document.querySelectorAll<HTMLElement>(
      "#tree-host .tree-row.selectable, #selections .tree-row.selectable",
    )) {
      if (row.getBoundingClientRect().height === 0) continue; // not mounted
      if (row.classList.contains(cls)) continue; // already carrying the state/flash
      const entry: Entry = {
        level: row.dataset.level as Entry["level"],
        id: Number(row.dataset.id),
      };
      if (hierarchy.entryIntersects(entry, set)) flashRow(row, cls);
    }
  };

  // THE MUTATION TEMPLATE (create_sele; every future mutating verb inherits
  // this shape): route through the EXACT SelectionModel mutators the gestures
  // call — never a parallel commit path — wrapped in ONE stroke so a single
  // Ctrl+Z reverts the whole command with no residue (the stroke coalesces
  // the target adds, the commit's own undo op, and the rename). Edit mode is
  // parked and restored around it (mode flips are deliberately not undoable),
  // so create_sele always builds a NEW selection and never touches the one
  // being edited. Any in-progress pending target is stashed out and restored
  // inside the same stroke, so the command commits exactly its own entries.
  const commitTargetEntries = (
    entries: Entry[],
    name: string | null,
    hide = false, // hide <target>: commit-then-hide, ONE stroke = one undo
  ): { name: string; points: number } | { error: string } => {
    if (name === "all") {
      return { error: `"all" is reserved — @all means the union of every committed selection` };
    }
    if (name !== null && model.committed().some((c) => c.name === name)) {
      return { error: `a selection named "${name}" already exists` };
    }
    const editId = model.editing?.id ?? null;
    if (editId !== null) refreshPoints(model.endEdit());
    const stashed = model.pending.listEntries();
    model.beginStroke();
    for (const e of stashed) refreshPoints(model.removeFromTarget(e));
    for (const e of entries) refreshPoints(model.addToTarget(e));
    const sel = model.commit(); // pushes its usual single undo op INTO the stroke
    if (sel && name !== null) model.rename(sel.id, name);
    if (sel && hide) refreshPoints(model.setHidden(sel.id, true)); // same stroke
    for (const e of stashed) refreshPoints(model.addToTarget(e));
    model.endStroke();
    if (editId !== null) refreshPoints(model.beginEdit(editId));
    if (!sel) return { error: "nothing to commit" };
    refreshPoints(sel.set.resolvedPoints());
    // the build→commit green beat in one shot: the committed rows pulse with
    // the EXISTING pending-green look through the EXISTING flash mechanism,
    // then settle into the committed block (purple, when committed hidden)
    flashPointRows(sel.set.resolvedPoints(), "sel-covered");
    return { name: sel.name, points: sel.set.pointCount };
  };

  // hide/show closures — every mutation routes through the EXISTING model
  // mutators (setHidden / setEntryHidden / setEntriesHidden), each action one
  // undo op, the panel cascade playing through model.onChange as always.
  const selByName = (name: string) => model.committed().find((c) => c.name === name);

  /** Hide/show a BATCH of committed references in place — whole selections
   * and/or member subsets — inside ONE stroke (one undo op, principle 3's
   * all-reference arm). Uses setHidden / setEntryHidden directly (never the
   * self-stroking setEntriesHidden — strokes don't nest). */
  const setRefsHidden = (
    ops: { name: string; entries: Entry[] | null }[],
    hidden: boolean,
  ): { affected: number; changed: number } | null => {
    const resolved = ops.map((op) => ({ sel: selByName(op.name), entries: op.entries }));
    if (resolved.some((r) => !r.sel)) return null;
    const affected: number[] = [];
    let changed = 0;
    model.beginStroke();
    for (const { sel, entries } of resolved) {
      let a: number[];
      if (entries === null) {
        a = model.setHidden(sel!.id, hidden);
      } else {
        a = [];
        for (const e of entries) a.push(...model.setEntryHidden(sel!.id, e, hidden));
      }
      if (a.length > 0) changed++;
      affected.push(...a);
    }
    model.endStroke();
    refreshPoints(affected);
    return { affected: affected.length, changed };
  };

  /** The committed selections, in panel order (ls; @all expansion). */
  const selectionsInfo = (): { name: string; points: number; hidden: boolean }[] =>
    model.committed().map((c) => ({ name: c.name, points: c.set.pointCount, hidden: c.hidden }));

  /** Rename via the model's unique-name mutator (one undo op; the panel's
   * inline rename uses the same path). "all" is reserved for @all. */
  const renameSelection = (
    oldName: string,
    newName: string,
  ): { ok: true } | { error: string } => {
    const sel = selByName(oldName);
    if (!sel) return { error: `no selection named "${oldName}"` };
    const next = newName.trim();
    if (next === "all") {
      return { error: `"all" is reserved — @all means the union of every committed selection` };
    }
    if (model.committed().some((c) => c.id !== sel.id && c.name === next)) {
      return { error: `a selection named "${next}" already exists` };
    }
    if (!model.rename(sel.id, next)) {
      return { error: `cannot rename to "${newName}"` };
    }
    return { ok: true };
  };

  /** add/remove verbs: membership mutation through the SAME gesture
   * mutators edit mode drives (addToTarget/removeFromTarget on the edited
   * set). Edit mode is parked onto the named selection and the prior mode
   * restored after (mode flips are deliberately not undoable), with every
   * mutation inside ONE stroke = one undo op. remove only ever receives
   * exact stored members from the @name.<pred> matcher, and the has() guard
   * here skips anything else — removeFromTarget's carve branch is
   * structurally unreachable from the terminal (principle 4). An emptied
   * selection stays in place (the UI never auto-deletes; only the ✕ button
   * deletes). */
  const mutateMembers = (
    name: string,
    mode: "add" | "remove",
    entries: Entry[],
  ): { points: number; remaining: number } | null => {
    const sel = selByName(name);
    if (!sel) return null;
    const prevEditId = model.editing?.id ?? null;
    if (prevEditId !== sel.id) {
      if (prevEditId !== null) refreshPoints(model.endEdit());
      refreshPoints(model.beginEdit(sel.id));
    }
    model.beginStroke();
    const affected: number[] = [];
    for (const e of entries) {
      if (mode === "add") affected.push(...model.addToTarget(e));
      else if (sel.set.has(e)) affected.push(...model.removeFromTarget(e));
    }
    model.endStroke();
    if (prevEditId !== sel.id) {
      refreshPoints(model.endEdit());
      if (prevEditId !== null) refreshPoints(model.beginEdit(prevEditId));
    }
    refreshPoints(affected);
    return { points: affected.length, remaining: sel.set.entryCount };
  };

  /** Bare remove @name / remove @all: delete selections through the SAME
   * model.deleteSelection the panel's ✕ uses — one stroke, so remove @all
   * restores EVERY deleted selection with a single Ctrl+Z. */
  const deleteSelections = (
    names: string[],
  ): { deleted: number; points: number } | null => {
    const sels = names.map(selByName);
    if (sels.some((s) => !s)) return null;
    model.beginStroke();
    const affected: number[] = [];
    for (const s of sels) affected.push(...model.deleteSelection(s!.id));
    model.endStroke();
    refreshPoints(affected);
    return { deleted: sels.length, points: new Set(affected).size };
  };

  /** WHOLE-MEMBER hide/show for @name.<pred> — the filter resolves stored
   * members, and this hides/shows exactly those member entries through the
   * same setEntriesHidden the member-row drag uses (one stroke = one undo).
   * No sub-member state can exist (consistency principle 2), so every
   * command hide is displayable and reversible by the panel's own gestures.
   * `affected` = points whose part-hidden state changed (0 = idempotent);
   * `wholeHidden` lets the handler explain a whole-flag hide honestly. */
  const setMembersHiddenIn = (
    name: string,
    entries: Entry[],
    hidden: boolean,
  ): { affected: number; wholeHidden: boolean } | null => {
    const sel = selByName(name);
    if (!sel) return null;
    const affected = model.setEntriesHidden(sel.id, entries, hidden);
    refreshPoints(affected);
    return { affected: affected.length, wholeHidden: sel.hidden };
  };

  /** show @name: clear ALL hidden state on the selection (whole flag AND
   * member hides) — the reliable inverse of any hiding on it. One undo op. */
  const clearSelectionHidden = (name: string): { affected: number } | null => {
    const sel = selByName(name);
    if (!sel) return null;
    const affected = model.clearAllHidden(sel.id);
    refreshPoints(affected);
    return { affected: new Set(affected).size };
  };

  /** show <path>: clear hidden state wherever these points are hidden —
   * whole-selection flags and hiddenPart entries covering them. Never
   * commits; one stroke = one undo op. Returns distinct affected points. */
  const showPointsCovering = (points: readonly number[]): number => {
    const named = new Set(points);
    const affected = new Set<number>();
    model.beginStroke();
    for (const sel of model.committed()) {
      if (sel.hidden && sel.set.resolvedPoints().some((p) => named.has(p))) {
        for (const p of model.setHidden(sel.id, false)) affected.add(p);
      }
      const toClear = sel.hiddenPart
        .listEntries()
        .filter((e) => hierarchy.pointsOf(e).some((p) => named.has(p)));
      for (const e of toClear) {
        for (const p of model.setEntryHidden(sel.id, e, false)) affected.add(p);
      }
    }
    model.endStroke();
    const arr = [...affected];
    refreshPoints(arr);
    return arr.length;
  };

  /** Bare show: clear ALL hidden state (non-destructive, one undo op). */
  const showAllHidden = (): number => {
    const affected = new Set<number>();
    model.beginStroke();
    for (const sel of model.committed()) {
      for (const p of model.setHidden(sel.id, false)) affected.add(p);
      for (const e of sel.hiddenPart.listEntries()) {
        for (const p of model.setEntryHidden(sel.id, e, false)) affected.add(p);
      }
    }
    model.endStroke();
    const arr = [...affected];
    refreshPoints(arr);
    return arr.length;
  };
  /** THE ONE WRITER FACTORY for the whole representation grid — all nine
   * primitive×axis closures (color stride 3; size/opacity stride 1) flow
   * through it: capture the prior values of exactly the written elements,
   * write (LWW per element), sync the renderer via onWrite(ids), and record
   * the restoration through recordOp — one stroke per invocation, undo
   * returning no point indices (representation state is not selection
   * state, so nothing model-derived needs recomputing). Axis ⊥ hide and
   * axis ⊥ axis: a writer touches ONLY its own buffer. The render hook is
   * the registry's write cadence: registry.repWrite(channel, ids) reaches
   * every pass subscribed to that channel — the point pass flags rep.dirty,
   * the edge pass fills its ids-scoped instance slots (including the
   * junction end-sizes on the POINT size channel), the polyline pass writes
   * its RGBA slots through; trace SIZE has no subscriber anywhere —
   * state-only pending the vertex tube pass. */
  const writeRepValues = (
    buf: Float32Array,
    stride: number,
    onWrite: (ids: readonly number[]) => void,
    ids: readonly number[],
    valueAt: (i: number, c: number) => number,
  ): number => {
    if (ids.length === 0) return 0;
    const list = [...ids];
    const prev = new Float32Array(list.length * stride);
    for (let i = 0; i < list.length; i++) {
      const at = list[i] * stride;
      for (let c = 0; c < stride; c++) {
        prev[i * stride + c] = buf[at + c];
        buf[at + c] = valueAt(i, c);
      }
    }
    onWrite(list);
    model.recordOp(() => {
      for (let i = 0; i < list.length; i++) {
        const at = list[i] * stride;
        for (let c = 0; c < stride; c++) buf[at + c] = prev[i * stride + c];
      }
      onWrite(list);
      return [];
    });
    return list.length;
  };
  const makeRepWriter = (
    buf: Float32Array,
    stride: number,
    onWrite: (ids: readonly number[]) => void,
  ) =>
    (ids: readonly number[], value: number | readonly number[]): number => {
      const vals = typeof value === "number" ? [value] : value;
      return writeRepValues(buf, stride, onWrite, ids, (_i, c) => vals[c]);
    };
  /** makeRepWriter's PER-ELEMENT sibling for the recipe write path: `values`
   * is flat stride×ids.length, each element carrying its OWN value — the one
   * place a computed-per-element value function meets the buffers. Same
   * core, so capture/LWW/recordOp/GPU-sync cannot diverge from the
   * broadcast writers. */
  const makeRepEachWriter = (
    buf: Float32Array,
    stride: number,
    onWrite: (ids: readonly number[]) => void,
  ) =>
    (ids: readonly number[], values: readonly number[]): number =>
      writeRepValues(buf, stride, onWrite, ids, (i, c) => values[i * stride + c]);
  /** onWrite for the writer factory: dispatch to every pass subscribed to
   * this channel (the registry's write cadence). The undo closure calls the
   * same hook, so GPU sync on undo is automatic. */
  const repWrite = (channel: RepChannel) =>
    (ids: readonly number[]): void => registry.repWrite(channel, ids);
  // The channel-binding registry (live: the applier below re-derives on
  // every flip) and its status badge. The badge seam is assigned
  // where the steady-state status line is composed (after boot); everything
  // here only ever runs at command time, well after that.
  const bindingRegistry = new BindingRegistry();
  let refreshBindingBadge = (): void => {};
  /** The ruled LWW rule, wired where every direct write flows: a point-axis
   * write CLEARS overlapping SAME-AXIS binding coverage in the SAME stroke —
   * the write lands AND those elements stop being channel-driven, and one
   * Ctrl+Z restores the values and the coverage together. Wraps ONLY the
   * three point axes (bindings cover nothing else); a write that changed
   * nothing (n=0) or overlapped no coverage records no extra op. Strokes
   * are reentrant, so a caller composing a larger stroke (bind's initial
   * apply, a command macro) folds this in rather than splitting undo. */
  const withBindingClear = <A extends unknown[]>(
    axis: BindAxis,
    writer: (ids: readonly number[], ...rest: A) => number,
  ) =>
    (ids: readonly number[], ...rest: A): number => {
      model.beginStroke();
      const n = writer(ids, ...rest);
      if (n > 0) {
        const snap = bindingRegistry.snapshot();
        const stats = bindingRegistry.release(ids, axis);
        if (stats.touched > 0) {
          refreshBindingBadge();
          model.recordOp(() => {
            bindingRegistry.restore(snap);
            refreshBindingBadge();
            return [];
          });
        }
      }
      model.endStroke();
      return n;
    };
  /** THE LIVE LINK (C-3): on every displayed-frame flip, each binding
   * re-derives its axis buffer from that frame's channel block — the SAME
   * mapping the bake/bind verbs use (mapScalar + the built-in colormap +
   * BIND_SIZE_MAX; one mapping, two cadences), written RAW into the rep
   * buffers: DERIVED STATE, NEVER RECORDED (the fillEdges/visibility
   * precedent — one Ctrl+Z after a thousand flips restores pre-bind state
   * in one step, because the bind stroke's writer op still holds the
   * captured priors). GPU sync + the junction carve-out ride the ordinary
   * write-cadence dispatch: repWrite(axis) reaches the point pass's
   * attribute-targeted upload and, for size, the edge pass's iSizeA/iSizeB
   * fill. An UNBOUND scene returns before touching anything — zero
   * per-flip cost off the bound path. Static (per_point) channels are
   * skipped: their bind-time apply is already exact at every frame. */
  const channelScopeByName = new Map(header.channels.map((c) => [c.name, c.scope]));
  const applyBindings = (chunk: FrameChunk, f: number): void => {
    if (bindingRegistry.count() === 0) return;
    for (const b of bindingRegistry.all()) {
      if (channelScopeByName.get(b.channel) !== "per_point_per_frame") continue;
      const block = chunk.channels.get(b.channel);
      if (!block) continue; // validated chunks always carry declared channels
      if (b.axis === ORIENTATION_AXIS) {
        // The vector arm: b.points holds polyline-VERTEX ids; each vertex
        // stores ITS point's raw 3-vector at this frame. No normalization
        // (parked), no range, no colormap — a straight strided copy. The
        // repWrite dispatch is a no-op today (nothing subscribes — O-2's
        // generator will) but keeps the cadence contract uniform.
        const off3 = (f - chunk.start) * header.n_points * 3;
        const buf = rep.state.orientation;
        for (const v of b.points) {
          const at = off3 + traceVertices[v] * 3;
          buf[v * 3] = block[at];
          buf[v * 3 + 1] = block[at + 1];
          buf[v * 3 + 2] = block[at + 2];
        }
        registry.repWrite("orientation", b.points);
        continue;
      }
      const off = (f - chunk.start) * header.n_points; // scalar block: components = 1, gate-enforced
      const [lo, hi] = b.range!;
      // Each scalar axis re-derives in ITS OWN domain: point axes read the
      // element's value; trace axes the vertex's OWN point; edge axes the
      // ENDPOINT MEAN (the ruled rule — mean of raws, then the lens). The
      // repWrite key is the REP-CHANNEL name (the write-cadence dispatch's
      // key space), mapped per axis below.
      const raw = (id: number): number => {
        const d = AXIS_DOMAIN[b.axis];
        if (d === "point") return block[off + id];
        if (d === "vertex") return block[off + traceVertices[id]];
        const [ea, eb] = header.edges[id];
        return (block[off + ea] + block[off + eb]) / 2;
      };
      const t = (id: number): number => mapScalar(raw(id), lo, hi);
      switch (b.axis) {
        case "color": case "bondcolor": case "tracecolor": {
          const buf = b.axis === "color" ? rep.state.color
            : b.axis === "bondcolor" ? rep.state.edgeColor : rep.state.traceColor;
          for (const id of b.points) {
            const [r, g, bl] = rainbow.colormap(t(id));
            buf[id * 3] = r;
            buf[id * 3 + 1] = g;
            buf[id * 3 + 2] = bl;
          }
          break;
        }
        case "size": case "bondsize": case "tracesize": {
          const buf = b.axis === "size" ? rep.state.size
            : b.axis === "bondsize" ? rep.state.edgeSize : rep.state.traceSize;
          for (const id of b.points) buf[id] = t(id) * BIND_SIZE_MAX;
          break;
        }
        default: {
          const buf = b.axis === "opacity" ? rep.state.opacity
            : b.axis === "bondopacity" ? rep.state.edgeOpacity : rep.state.traceOpacity;
          for (const id of b.points) buf[id] = t(id);
        }
      }
      const repChannel = (
        { color: "color", size: "size", opacity: "opacity",
          bondcolor: "edgeColor", bondsize: "edgeSize", bondopacity: "edgeOpacity",
          tracecolor: "traceColor", tracesize: "traceSize", traceopacity: "traceOpacity",
        } as const
      )[b.axis];
      registry.repWrite(repChannel, b.points);
    }
  };
  // The orientation writer: per-vertex RAW 3-vectors through the SAME
  // stride-parameterized writer core color rides — capture, one stroke,
  // LWW-clear of same-axis coverage (vertex-id space), write-cadence
  // dispatch (no subscriber yet: state-only until the oriented generator).
  const orientationVerticesEach = withBindingClear(
    ORIENTATION_AXIS,
    makeRepEachWriter(rep.state.orientation, 3, repWrite("orientation")),
  );
  const colorPoints = withBindingClear("color", makeRepWriter(rep.state.color, 3, repWrite("color")));
  const colorPointsEach = withBindingClear("color", makeRepEachWriter(rep.state.color, 3, repWrite("color")));
  const sizePointsEach = withBindingClear("size", makeRepEachWriter(rep.state.size, 1, repWrite("size")));
  const opacityPointsEach = withBindingClear("opacity", makeRepEachWriter(rep.state.opacity, 1, repWrite("opacity")));
  const sizePoints = withBindingClear("size", makeRepWriter(rep.state.size, 1, repWrite("size")));
  const opacityPoints = withBindingClear("opacity", makeRepWriter(rep.state.opacity, 1, repWrite("opacity")));
  // Edge/trace writers carry the SAME LWW-clear discipline as points: a
  // direct write (broadcast verb or per-element consumer) releases
  // overlapping same-axis binding coverage in its own id space (edge ids /
  // vertex ids — the axis names key the spaces via AXIS_DOMAIN).
  const colorEdges = withBindingClear("bondcolor", makeRepWriter(rep.state.edgeColor, 3, repWrite("edgeColor")));
  const sizeEdges = withBindingClear("bondsize", makeRepWriter(rep.state.edgeSize, 1, repWrite("edgeSize")));
  const opacityEdges = withBindingClear("bondopacity", makeRepWriter(rep.state.edgeOpacity, 1, repWrite("edgeOpacity")));
  const colorTrace = withBindingClear("tracecolor", makeRepWriter(rep.state.traceColor, 3, repWrite("traceColor")));
  const sizeTrace = withBindingClear("tracesize", makeRepWriter(rep.state.traceSize, 1, repWrite("traceSize")));
  const opacityTrace = withBindingClear("traceopacity", makeRepWriter(rep.state.traceOpacity, 1, repWrite("traceOpacity")));
  // Style writers: plain broadcast (style is NOT a bindable axis — no
  // channel drives it, so no coverage to LWW-clear); value = the style's
  // REGISTRY INDEX, resolved from its name by the verb.
  const stylePoints = makeRepWriter(rep.state.style, 1, repWrite("style"));
  const styleEdges = makeRepWriter(rep.state.edgeStyle, 1, repWrite("edgeStyle"));
  const styleTrace = makeRepWriter(rep.state.traceStyle, 1, repWrite("traceStyle"));
  const colorEdgesEach = withBindingClear("bondcolor", makeRepEachWriter(rep.state.edgeColor, 3, repWrite("edgeColor")));
  const sizeEdgesEach = withBindingClear("bondsize", makeRepEachWriter(rep.state.edgeSize, 1, repWrite("edgeSize")));
  const opacityEdgesEach = withBindingClear("bondopacity", makeRepEachWriter(rep.state.edgeOpacity, 1, repWrite("edgeOpacity")));
  const colorTraceEach = withBindingClear("tracecolor", makeRepEachWriter(rep.state.traceColor, 3, repWrite("traceColor")));
  const sizeTraceEach = withBindingClear("tracesize", makeRepEachWriter(rep.state.traceSize, 1, repWrite("traceSize")));
  const opacityTraceEach = withBindingClear("traceopacity", makeRepEachWriter(rep.state.traceOpacity, 1, repWrite("traceOpacity")));

  // -- Type A (analysis) mods: the async producer round-trip ---------------------
  // Follow-up terminal lines ride the commandResult channel — the terminal
  // prints every commandResult (ids are not used for printing), so an async
  // outcome is just a second line after the verb's sync "running…" one.
  const asyncLine = (status: "ok" | "nomatch" | "error", message: string): void => {
    host.postMessage({ type: "commandResult", id: -1, status, message });
  };
  // rm: the names awaiting the terminal's y answer (armed by the verb).
  let pendingRm: string[] | null = null;
  cancelRmDeletion = (): void => {
    pendingRm = null;
  };
  confirmRmDeletion = (): void => {
    const names = pendingRm;
    pendingRm = null;
    if (!names || names.length === 0) {
      asyncLine("error", "rm: nothing pending to confirm");
      return;
    }
    // files delete HOST-side FIRST; unregistration follows what SUCCEEDED
    // (rm-mods-result below), so the registry re-derives from disk truth
    host.postMessage({ type: "rm-mods", names });
  };
  finishRmDeletion = (r): void => {
    const deleted = Array.isArray(r.deleted) ? r.deleted : [];
    const failed = Array.isArray(r.failed) ? r.failed : [];
    for (const name of deleted) {
      unregisterRecipe(name);
      commands.unregister(name); // its own-verb goes with it
    }
    const lines: string[] = [];
    if (deleted.length > 0) {
      lines.push(`deleted ${deleted.length} mod${deleted.length === 1 ? "" : "s"}: ${deleted.join(", ")}`);
    }
    let hardFail = false;
    for (const f of failed) {
      // A file that's already gone (removed outside the app) is not a persistent
      // failure — reconcile: unregister so the registry matches disk, and say so.
      // Any OTHER unlink failure leaves it registered and is a real error.
      if (isFileAlreadyGone(f.error)) {
        unregisterRecipe(f.name);
        commands.unregister(f.name);
        lines.push(`${f.name} — its file was already gone; unregistered`);
      } else {
        hardFail = true;
        lines.push(`failed: ${f.name} — ${f.error} (still registered)`);
      }
    }
    if (lines.length === 0) lines.push("rm: nothing was deleted");
    asyncLine(hardFail ? "error" : "ok", lines.join("\n"));
  };
  let modRunSeq = 0;
  const runAnalysisMod = (mod: AnalysisMod, points: number[], expr: string): void => {
    void (async () => {
      try {
        const bytes = await transport.request({
          type: "run_mod",
          code: mod.code,
          target_indices: points,
        });
        const reply = JSON.parse(new TextDecoder().decode(bytes)) as {
          values?: unknown;
          error?: string;
          traceback?: string;
        };
        if (typeof reply.error === "string") {
          const tb = reply.traceback ? `\n${reply.traceback.trimEnd()}` : "";
          asyncLine("error", `${mod.name} failed: ${reply.error}${tb}`);
          return;
        }
        // THE fail-closed gate: exact length for the declared kind, finite,
        // in [0,1] for per-point scalars. Any violation binds NOTHING.
        const checked = validateModValues(reply.values, {
          produces: mod.produces,
          targetCount: points.length,
          frameCount: nFrames,
        });
        if (!checked.ok) {
          asyncLine("error", `${mod.name} failed: ${checked.error} — nothing bound`);
          return;
        }
        if (mod.produces === "per-point-scalar" && "values" in checked) {
          // the EXISTING binding entry, verbatim — resolution, mapping,
          // one-stroke undo, and the double length-guard all come with it
          const outcome = bindResult({
            kind: "per-point-scalar",
            target: expr,
            axis: mod.axis ?? "color",
            scalars: checked.values,
          });
          asyncLine(outcome.ok ? "ok" : "error", `${mod.name} → ${outcome.message}`);
        } else if (mod.produces === "per-frame-series" && "values" in checked) {
          // the EXISTING plot route: the host consumes plot-kind claude-binds
          // (plothost) exactly as it does for tool results
          host.postMessage({
            type: "claude-bind",
            callId: `mod-${++modRunSeq}`,
            result: { kind: "per-frame-series", label: mod.name, values: checked.values },
          });
          asyncLine("ok",
            `${mod.name} → series "${mod.name}" (${checked.values.length} frames) → the plot tab`);
        } else if ("scatter" in checked) {
          host.postMessage({
            type: "claude-bind",
            callId: `mod-${++modRunSeq}`,
            result: { kind: "scatter", label: mod.name, ...checked.scatter },
          });
          asyncLine("ok",
            `${mod.name} → scatter "${mod.name}" (${checked.scatter.x.length} points) → the plot tab`);
        } else if ("commands" in checked) {
          // a `produces: commands` macro — validated (list of non-empty strings)
          // here; the emitted strings are refused/pre-validated/executed as ONE
          // undo stroke at the command-mod boundary below.
          runCommandMod(mod, checked.commands);
        }
      } catch (err) {
        asyncLine("error",
          `${mod.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  const commandContext = {
    hierarchy,
    tree: fullTree, // the SAME model the bottom tree renders — click parity
    pointTypes: header.points.type,
    committedEntries: () => {
      const byName = new Map<string, readonly Entry[]>();
      for (const c of model.committed()) byName.set(c.name, c.set.listEntries());
      return byName;
    },
    focusPoints,
    frameVisible: () => {
      if (!model.editing) frameVisible(); // parked while editing, like the gesture
    },
    flashPointRows,
    commitEntries: commitTargetEntries,
    setRefsHidden,
    setMembersHiddenIn,
    clearSelectionHidden,
    showPointsCovering,
    showAll: showAllHidden,
    selectionsInfo,
    renameSelection,
    mutateMembers,
    deleteSelections,
    colorPoints,
    colorPointsEach,
    sizePointsEach,
    opacityPointsEach,
    // Channel bindings (LIVE — applyBindings re-derives them per flip).
    // createBinding is ONE compound stroke: the wrapped writer's recorded
    // capture (which ALSO clears overlapping same-axis coverage — the
    // last-bind-wins pre-step, via withBindingClear) plus a registry
    // snapshot op — a single Ctrl+Z removes the binding and restores the
    // buffers AND any taken-over coverage together. The takeover report
    // comes from overlapStats BEFORE the stroke, because the actual
    // clearing happens inside the composite.
    createBinding: (b: Binding, values: readonly number[]) => {
      const takeover = bindingRegistry.overlapStats(b.points, b.axis);
      model.beginStroke();
      if (b.axis === ORIENTATION_AXIS) orientationVerticesEach(b.points, values);
      else applyScalarsToAxis(commandContext, b.axis, b.points, values);
      const snap = bindingRegistry.snapshot();
      bindingRegistry.add(b);
      refreshBindingBadge();
      model.recordOp(() => {
        bindingRegistry.restore(snap);
        refreshBindingBadge();
        return [];
      });
      model.endStroke();
      return takeover;
    },
    // Release runs PER AXIS with that axis's own id space — scalar coverage
    // by point ids, orientation coverage by vertex ids. The two spaces
    // overlap numerically; one unscoped release() over both would shrink
    // the wrong coverage, so the composite never calls it that way.
    releaseBindings: (
      sel: {
        points: readonly number[] | null;
        vertices: readonly number[] | null;
        edges: readonly number[] | null;
      },
      axis: BindAxis | null,
    ) => {
      const snap = bindingRegistry.snapshot();
      const total = { touched: 0, removed: 0, points: 0 };
      const acc = (s: { touched: number; removed: number; points: number }): void => {
        total.touched += s.touched;
        total.removed += s.removed;
        total.points += s.points;
      };
      // Each axis releases with ITS domain's id set — the three spaces
      // overlap numerically and must never cross (AXIS_DOMAIN is the key).
      const idsFor = (a: BindAxis): readonly number[] | null =>
        AXIS_DOMAIN[a] === "point" ? sel.points : AXIS_DOMAIN[a] === "edge" ? sel.edges : sel.vertices;
      for (const a of SCALAR_AXES) {
        if (axis === null || axis === a) acc(bindingRegistry.release(idsFor(a), a));
      }
      if (axis === null || axis === ORIENTATION_AXIS) {
        acc(bindingRegistry.release(sel.vertices, ORIENTATION_AXIS));
      }
      if (total.touched === 0) return total; // nothing changed — record no op
      refreshBindingBadge();
      model.recordOp(() => {
        bindingRegistry.restore(snap);
        refreshBindingBadge();
        return [];
      });
      return total;
    },
    listBindings: () => bindingRegistry.all(),
    orientationVerticesEach,
    colorEdgesEach,
    sizeEdgesEach,
    opacityEdgesEach,
    colorTraceEach,
    sizeTraceEach,
    opacityTraceEach,
    stylePoints,
    styleEdges,
    styleTrace,
    styleNames: () => listStyles().map((st) => st.name),
    styleIndexOf: styleIndex,
    // Per-DOMAIN shape selection (the ruled fallback: per-target shape
    // assignment is parked — it needs mixed-shape passes). One undo op:
    // the swap-back rides recordOp like every scene mutation.
    setShape: (domain: "point" | "edge" | "vertex", label: string) => {
      const r = registry.setActive(domain, label);
      if (r === null) return null;
      if (r.prev !== null && r.prev !== label) {
        const prev = r.prev;
        model.recordOp(() => {
          registry.setActive(domain, prev);
          return [];
        });
      }
      return r;
    },
    shapesInfo: () => (
      (["point", "edge", "vertex"] as const).map((domain) => ({
        domain,
        names: registry.available(domain),
        active: registry.activeOf(domain),
      }))
    ),
    // The bake/bind gate's READ surface. Declarations come from the header;
    // values come from whatever is IN HAND at the displayed frame — the
    // header block for per_point, the displayed chunk's zero-copy view for
    // per_point_per_frame (protected in the LRU while displayed). These are
    // reads, so the validation context inherits them un-stubbed.
    channels: () =>
      header.channels.map((c) => ({
        name: c.name,
        scope: c.scope,
        components: channelComponents(c),
        ...(c.min !== undefined ? { min: c.min } : {}),
        ...(c.max !== undefined ? { max: c.max } : {}),
      })),
    channelValues: (name: string) => {
      const decl = header.channels.find((c) => c.name === name);
      if (!decl) return null;
      if (decl.scope === "per_point") {
        return decl.data ? { values: decl.data, frame: null } : null;
      }
      if (decl.scope !== "per_point_per_frame") return null;
      const f = displayedFrame === -1 ? 0 : displayedFrame;
      const chunk = player.getFrame(f);
      const block = chunk?.channels.get(name);
      if (!chunk || !block) return null;
      const w = channelComponents(decl);
      const off = (f - chunk.start) * header.n_points * w;
      return { values: block.subarray(off, off + header.n_points * w), frame: f };
    },
    edges: header.edges,
    colorEdges,
    traceVertices,
    colorTrace,
    sizePoints,
    sizeEdges,
    sizeTrace,
    opacityPoints,
    opacityEdges,
    opacityTrace,
    runAnalysisMod,
    armRmDeletion: (names: string[]) => {
      pendingRm = names; // single slot — a newer rm replaces it
    },
  };
  const commands = createCommandRegistry(commandContext);
  runCommand = (text: string) => commands.runCommand(text);
  runComplete = makeRunComplete(commandContext, commands);
  bindResult = (raw: unknown) => bindTypedResult(commandContext, runCommand, raw);

  // --- produces: commands (macro mods) ------------------------------------
  // A no-op-WRITE clone of the command context: reads (resolution, @name
  // existence, name collisions) stay REAL, writes do nothing. Running a command
  // through a registry built on it PARSES + RESOLVES it without side effects, so
  // every string in a macro can be validated BEFORE any of them runs.
  const validationContext: typeof commandContext = {
    ...commandContext,
    focusPoints: () => {},
    frameVisible: () => {},
    flashPointRows: () => {},
    commitEntries: (_entries, name) =>
      name !== null && commandContext.committedEntries().has(name)
        ? { error: `a selection named "${name}" already exists` }
        : { name: name ?? "selection", points: 0 },
    setRefsHidden: (ops) =>
      ops.every((o) => commandContext.committedEntries().has(o.name)) ? { affected: 0, changed: 0 } : null,
    setMembersHiddenIn: (name) =>
      commandContext.committedEntries().has(name) ? { affected: 0, wholeHidden: false } : null,
    clearSelectionHidden: (name) =>
      commandContext.committedEntries().has(name) ? { affected: 0 } : null,
    showPointsCovering: () => 0,
    showAll: () => 0,
    renameSelection: (oldName, newName) => {
      const names = commandContext.committedEntries();
      if (!names.has(oldName)) return { error: `no selection named "${oldName}"` };
      if (newName !== oldName && names.has(newName)) return { error: `a selection named "${newName}" already exists` };
      return { ok: true };
    },
    mutateMembers: (name) => (commandContext.committedEntries().has(name) ? { points: 0, remaining: 0 } : null),
    deleteSelections: (names) =>
      names.every((n) => commandContext.committedEntries().has(n)) ? { deleted: 0, points: 0 } : null,
    colorPoints: () => 0, colorPointsEach: () => 0, sizePointsEach: () => 0, opacityPointsEach: () => 0,
    createBinding: () => ({ touched: 0, removed: 0, points: 0 }),
    releaseBindings: () => ({ touched: 0, removed: 0, points: 0 }),
    orientationVerticesEach: () => 0,
    colorEdgesEach: () => 0, sizeEdgesEach: () => 0, opacityEdgesEach: () => 0,
    colorTraceEach: () => 0, sizeTraceEach: () => 0, opacityTraceEach: () => 0,
    stylePoints: () => 0, styleEdges: () => 0, styleTrace: () => 0,
    setShape: (domain, label) =>
      commandContext.shapesInfo().some((s) => s.domain === domain && s.names.includes(label))
        ? { prev: label }
        : null,
    colorEdges: () => 0, colorTrace: () => 0,
    sizePoints: () => 0, sizeEdges: () => 0, sizeTrace: () => 0,
    opacityPoints: () => 0, opacityEdges: () => 0, opacityTrace: () => 0,
    runAnalysisMod: () => {}, // never reached — mod-invocation verbs refused first
    armRmDeletion: () => {}, // never reached — rm refused first
  };
  const validationCommands = createCommandRegistry(validationContext);

  runCommandMod = (mod: AnalysisMod, cmds: string[]): void => {
    const outcome = runCommandMacro(mod.name, cmds, {
      modNames: new Set(listRecipes().map((r) => r.name)),
      validate: (c) => validationCommands.runCommand(c), // no-op-write ctx → no side effects
      run: (c) => commands.runCommand(c),
      beginStroke: () => model.beginStroke(),
      endStroke: () => model.endStroke(),
    });
    asyncLine(outcome.status, outcome.message);
  };
  // Workspace mod files (parsed host-side): register each in the mod registry
  // AND as its own verb — at boot, and again after every write_mod save. A
  // re-push REPLACES both, so a rewritten mod runs its new code; only a BUILT-IN
  // name is refused, so a mod file can still never shadow one. The decision and
  // the outcome are pure (installModList); this wires it to the two registries.
  installMods = (raw: unknown): ModInstallOutcome => {
    const outcome = installModList(raw, {
      isBuiltin: (name) => commands.isBuiltin(name),
      install: (mod) => {
        registerRecipe(mod); // replaces the entry holding mod.code
        commands.register(   // replaces the handler CLOSING OVER the mod object
          mod.name,
          makeAnalysisModHandler(commandContext, mod),
          `analysis mod (${mod.produces}${mod.axis ? ` → ${mod.axis}` : ""})` +
            `${mod.description ? `: ${mod.description}` : ""} — ${mod.name} <target>`,
        );
      },
    });
    for (const s of outcome.skipped) {
      asyncLine("error", `mod "${s.name}" skipped — ${s.reason}`);
    }
    return outcome;
  };
  document.getElementById("terminal-btn")?.addEventListener("click", () => {
    host.postMessage({ type: "openTerminal" });
  });

  model.onChange(() => {
    targetTouch = model.touchKeys(model.target);
    bottomTree?.refresh();
    committedSection?.render();
    updateCommitBtn();
  });
  updateCommitBtn();

  // -- convenience default: one PRE-MADE committed selection per bulk category
  // (neutral name = the category's label) so the environment can be hidden
  // with one right-click. NOTHING is hidden initially — the user decides.
  for (const c of bulkCategories(header)) {
    model.seed(header.categories[c] ?? `category ${c}`, [{ level: "category", id: c }]);
  }
  registry.visibilityChange();

  // -- picking + 3D gestures + keys --------------------------------------------
  const vp = new THREE.Matrix4();
  const pickAt = (clientX: number, clientY: number): number => {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const r = pickPoint(
      positionAttr.array as Float32Array,
      header.n_points,
      rep.state.visible,
      vp.elements,
      ndcX,
      ndcY,
      rect.width,
      rect.height,
      PICK_PIXEL_THRESHOLD,
    );
    return r.index;
  };
  // 3D gestures — navigate by default, build only with Ctrl:
  //   left-drag = orbit, right-drag = pan (TrackballControls, unchanged)
  //   left-click = FOCUS the clicked point's subgroup (yellow pulse; no selection)
  //   Ctrl+left  = select at SUBGROUP level → pending target (click toggles,
  //   Ctrl+right = select at POINT level      drag paints/adds)
  // Granularity is EXPLICIT via the button — the old invisible zoom-dependent
  // switch is gone. The movement threshold keeps click and drag apart.
  const CLICK_MOVE_THRESHOLD = 5;
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

  interface CtrlPaint {
    level: "subgroup" | "point";
    button: number;
    x: number;
    y: number;
    moved: boolean;
    painted: Set<string>;
  }
  let ctrlPaint: CtrlPaint | null = null;
  let navDown: { x: number; y: number; button: number } | null = null;

  const resolveAt = (idx: number, level: "subgroup" | "point"): Entry =>
    level === "point"
      ? { level: "point", id: idx }
      : { level: "subgroup", id: hierarchy.subgroupOfPoint(idx) };
  const paintAt = (clientX: number, clientY: number): void => {
    if (!ctrlPaint) return;
    const idx = pickAt(clientX, clientY);
    if (idx < 0) return;
    const entry = resolveAt(idx, ctrlPaint.level);
    const key = `${entry.level}:${entry.id}`;
    if (ctrlPaint.painted.has(key)) return;
    ctrlPaint.painted.add(key);
    refreshPoints(model.addToTarget(entry));
  };

  // Capture-phase on the canvas CONTAINER so a Ctrl-press disables
  // TrackballControls BEFORE the controls' own pointerdown handler runs.
  container.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target !== renderer.domElement) return;
      if ((e.button === 0 || e.button === 2) && e.ctrlKey) {
        controls.enabled = false;
        ctrlPaint = {
          level: e.button === 0 ? "subgroup" : "point",
          button: e.button,
          x: e.clientX,
          y: e.clientY,
          moved: false,
          painted: new Set(),
        };
        model.beginStroke();
        e.preventDefault();
      } else if (e.button === 0 || e.button === 2) {
        navDown = { x: e.clientX, y: e.clientY, button: e.button };
      }
    },
    true,
  );
  window.addEventListener("pointermove", (e) => {
    if (!ctrlPaint) return;
    if (!ctrlPaint.moved) {
      if (Math.hypot(e.clientX - ctrlPaint.x, e.clientY - ctrlPaint.y) <= CLICK_MOVE_THRESHOLD) {
        return;
      }
      ctrlPaint.moved = true;
      paintAt(ctrlPaint.x, ctrlPaint.y); // the press point joins the paint
    }
    paintAt(e.clientX, e.clientY);
  });
  window.addEventListener("pointerup", (e) => {
    if (ctrlPaint && e.button === ctrlPaint.button) {
      const cp = ctrlPaint;
      ctrlPaint = null;
      if (!cp.moved) {
        const idx = pickAt(e.clientX, e.clientY);
        if (idx >= 0) refreshPoints(model.toggleInTarget(resolveAt(idx, cp.level)));
      }
      model.endStroke();
      if (!camTween) controls.enabled = true;
      return;
    }
    const down = navDown;
    navDown = null;
    if (!down || e.button !== down.button) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MOVE_THRESHOLD) return; // drag = camera
    if (down.button !== 0) return; // plain right-click: nothing (pan is the drag)
    const idx = pickAt(e.clientX, e.clientY);
    if (idx < 0) {
      // empty space: zoom back out to frame what is VISIBLE (parked while editing)
      if (!model.editing) frameVisible();
      return;
    }
    // focus the clicked point's subgroup — orient + yellow pulse, no selection
    focusPoints(hierarchy.subgroupPoints(hierarchy.subgroupOfPoint(idx)));
  });

  // -- keys: Escape cancels; Ctrl+Z = system-wide undo (state, never camera) ----
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      // exit edit mode without committing, else discard the pending target
      refreshPoints(model.editing ? model.endEdit() : model.clearPending());
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      refreshPoints(model.undo());
    }
  });

  // -- streaming player --------------------------------------------------------
  let zeroCopyLogged = false;
  const player = new StreamingPlayer<FrameChunk>(
    {
      nFrames,
      chunkFrames: CHUNK_FRAMES,
      lookaheadChunks: LOOKAHEAD_CHUNKS,
      maxInFlight: MAX_IN_FLIGHT,
      maxCacheBytes: MAX_CACHE_BYTES,
      fps: PLAYBACK_FPS,
    },
    (start, count) => {
      transport
        .request({ type: "frames", start, count })
        .then((bytes) => {
          rejectIfErrorPayload(bytes);
          const chunk = decodeFrameChunk(bytes);
          validateFrameChunk(chunk, header);
          if (!zeroCopyLogged) {
            zeroCopyLogged = true;
            console.log(
              `[viewer] zero-copy chunk positions: ${chunk.positions.buffer === bytes.buffer}`,
            );
          }
          player.onChunk(chunk.start, chunk, bytes.byteLength);
        })
        .catch((err) => {
          player.onChunkFailed(start);
          console.error("[viewer] chunk request failed:", err);
          setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
  );
  player.start();

  // --- playback controls ------------------------------------------------------
  const playBtn = document.getElementById("playpause") as HTMLButtonElement;
  const scrubber = document.getElementById("scrubber") as HTMLInputElement;
  const readout = document.getElementById("readout") as HTMLSpanElement;
  // Static (single-frame) vs trajectory is decided by frame count (4.6 A): a
  // structure opened on its own is one frame, so the play controls are disabled
  // — frame 0 still displays through the loop below.
  const isStatic = nFrames <= 1;
  scrubber.max = String(Math.max(0, nFrames - 1));
  playBtn.disabled = isStatic;
  scrubber.disabled = isStatic;
  if (isStatic) readout.textContent = "static · 1 frame";
  const setPlaying = (on: boolean) => {
    if (on) player.play();
    else player.pause();
    playBtn.textContent = on ? "pause" : "play";
  };
  playBtn.addEventListener("click", () => setPlaying(!player.playing));
  // Two-way binding: the user drives the slider (seek), and the playhead drives
  // the slider back every frame (see the display loop). The feedback is guarded
  // by `userScrubbing` — true only while the user is actively dragging — instead
  // of by focus, so the slider keeps tracking playback after a scrub (A3).
  // Programmatic `scrubber.value = …` does not fire input/change, so no loop.
  let userScrubbing = false;
  scrubber.addEventListener("pointerdown", () => (userScrubbing = true));
  scrubber.addEventListener("input", () => {
    userScrubbing = true;
    player.seek(Number(scrubber.value));
  });
  const endScrub = () => (userScrubbing = false);
  scrubber.addEventListener("change", endScrub);
  window.addEventListener("pointerup", endScrub);

  // --- display loop -----------------------------------------------------------
  let displayedFrame = -1;
  let shownSinceMark = 0;
  let fpsMarkMs = performance.now();
  let displayFps = 0;

  const displayFrame = (f: number): boolean => {
    const chunk = player.getFrame(f);
    if (!chunk) return false;
    const offset = (f - chunk.start) * header.n_points * 3;
    positionAttr.array = chunk.positions.subarray(offset, offset + header.n_points * 3);
    positionAttr.needsUpdate = true;
    registry.frameFlip(); // the instanced edge pass owns copies of these endpoints
    applyBindings(chunk, f); // live channel bindings re-derive (no-op when unbound)
    if (displayedFrame === -1) registry.reveal(); // enabled passes only
    displayedFrame = f;
    shownSinceMark++;
    // the ONE displayed-frame flip point — playback and scrub both land here,
    // so this single emission drives the plot's playhead (never polling)
    host.postMessage({ type: "frameChanged", frame: f });
    return true;
  };
  seekFrame = (frame: number) => player.seek(frame);

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    player.tick(now);
    if (player.frame !== displayedFrame) {
      if (displayFrame(player.frame) && !userScrubbing) {
        scrubber.value = String(player.frame);
      }
    }
    if (rep.dirty) {
      for (const a of repAttrs) a.needsUpdate = true;
      rep.dirty = false;
    }
    if (selDirty) {
      pointAttrs.sel.needsUpdate = true;
      selDirty = false;
    }
    // Pulse strengths are CPU-computed each frame (shaders stay time-free):
    // the pending green breathes via its pass's render tick; the yellow focus
    // flash swells and fades once, driven here (host state) via the handle.
    registry.renderTick(now);
    if (flashStart >= 0) {
      const k = (now - flashStart) / FOCUS_FLASH_MS;
      if (k >= 1) {
        flashStart = -1;
        flashPass.material.uniforms.uStrength.value = 0;
        for (const p of flashPts) flashArray[p] = 0;
        flashPts = [];
        pointAttrs.flash.needsUpdate = true;
      } else {
        flashPass.material.uniforms.uStrength.value = Math.pow(Math.sin(Math.PI * k), 1.35);
      }
    }
    if (!isStatic && now - fpsMarkMs >= 1000) {
      displayFps = (shownSinceMark * 1000) / (now - fpsMarkMs);
      shownSinceMark = 0;
      fpsMarkMs = now;
      const s = player.stats();
      readout.textContent =
        `frame ${player.frame}/${nFrames - 1} · ${displayFps.toFixed(0)} fps · ` +
        `cache ${(s.cacheBytes / 1e6).toFixed(0)}MB/${s.cachedChunks}ch · ` +
        `inflight ${s.inFlight} · stalls ${s.stalls}`;
    }
    if (camTween) {
      const k = Math.min(1, (now - camTween.start) / CAMERA_TWEEN_MS);
      const e = easeInOut(k);
      camera.position.lerpVectors(camTween.p0, camTween.p1, e);
      controls.target.lerpVectors(camTween.t0, camTween.t1, e);
      camera.lookAt(controls.target);
      if (k >= 1) {
        camTween = null;
        stopControlsMotion(); // clear any stale velocity before resuming control
        controls.enabled = true;
        controls.update();
      }
    } else {
      controls.update(); // applies rotation inertia decay when idle
    }
    renderer.render(scene, camera);
  });

  const baseStatus =
    `${header.name} — N=${header.n_points}, T=${nFrames} · ` +
    `${header.edges.length} edges, ${header.polylines.length} polylines · ` +
    `${header.categories.length} categories · live producer stream` +
    (scale.fallback ? ` · ${NO_BBOX_WARNING}` : "");
  // The binding badge composes onto the steady-state line (principle 2: a
  // binding must be visible without asking).
  refreshBindingBadge = () => {
    const n = bindingRegistry.count();
    setStatus(baseStatus + (n > 0 ? ` · ${n} binding${n === 1 ? "" : "s"} live` : ""));
  };
  refreshBindingBadge();

  if (cfg.test) {
    // Test seam (harness only; production sets no `test` flag): lets the E2E
    // driver read model/camera/player state and drive actions directly.
    (window as unknown as { __viewer?: unknown }).__viewer = {
      camera,
      controls,
      player,
      rep,
      hierarchy,
      model,
      edges: header.edges, // parity audits test edge endpoints vs resolvePoints
      traceVertices, // parity audits map vertices to subgroups vs resolvePoints
      // impostor seam: the C2 depthWrite assertion reads the geometry
      // materials; sizing lets pixel tests predict projected extents;
      // edgeAttrVersions proves the cadence split (flips never re-upload
      // the junction end-sizes).
      edgeAttrVersions: edgePass
        ? edgePass.attrVersions
        : (): { start: number; sizeA: number; sizeB: number } =>
            ({ start: 0, sizeA: 0, sizeB: 0 }),
      // binding cadence seam: the point attributes' upload versions —
      // unbound flips bump NONE of these; a bound axis bumps ITS OWN only
      repAttrVersions: () => ({
        color: pointAttrs.color.version,
        size: pointAttrs.size.version,
        opacity: pointAttrs.opacity.version,
      }),
      // ribbon cadence seam: flips bump start; ACROSS bumps on orientation
      // writes/re-derives; width/color on their own axes — never on flips
      ribbonAttrVersions: ribbonPass
        ? ribbonPass.attrVersions
        : (): { start: number; across: number; width: number; color: number } =>
            ({ start: 0, across: 0, width: 0, color: 0 }),
      // trace-tube cadence seam: a flip bumps start, never radius/color
      traceAttrVersions: tracePass
        ? tracePass.attrVersions
        : (): { start: number; radius: number; color: number } =>
            ({ start: 0, radius: 0, color: 0 }),
      geometryMaterials: materials,
      depthVariant,
      sizing: {
        worldPerSize: sizing.uWorldPerSize.value,
        pxPerWorld: () => sizing.uPxPerWorld.value,
        sceneS: scale.S,
        bboxFallback: scale.fallback,
      },
      actions: committedActions,
      command: runCommand,
      complete: runComplete,
      refreshPoints,
      focusPoints,
      focusEntry,
      zoomToPoints,
      resetCamera,
      applyResize,
      setPlaying,
      panel,
      debug: {
        /** number of points currently green (pending-target footprint). */
        selCount: (): number => {
          let s = 0;
          for (let i = 0; i < selArray.length; i++) if (selArray[i] > 0.5) s++;
          return s;
        },
        /** number of points currently visible. */
        visibleCount: (): number => {
          let s = 0;
          for (let i = 0; i < visible.length; i++) if (visible[i] > 0.5) s++;
          return s;
        },
        /** resolved point union for a target expression — lets flash-parity
         * audits compare flashed rows against the set a command resolves. */
        resolvePoints: (expr: string): number[] => {
          const ast = parseTarget(expr);
          if (ast.kind === "error") return [];
          const entries = resolveTarget(
            ast, fullTree, hierarchy, header.points.type, commandContext.committedEntries(),
          );
          const seen = new Set<number>();
          const out: number[] = [];
          for (const e of entries) {
            for (const p of hierarchy.pointsOf(e)) {
              if (!seen.has(p)) {
                seen.add(p);
                out.push(p);
              }
            }
          }
          return out;
        },
        /** number of points VISIBLY pulsing in the active focus flash —
         * hidden points carry the flag but the overlay gates them out, so
         * they don't count (matches what is actually on screen). */
        flashCount: (): number => {
          let s = 0;
          for (const p of flashPts) if (visible[p] > 0.5) s++;
          return s;
        },
        /** what a click at client (x,y) would pick (-1 = empty space). */
        pick: (x: number, y: number): number => pickAt(x, y),
        /** centroid+radius of the currently visible points (current frame). */
        visibleBounds: (): { center: [number, number, number]; radius: number } | null => {
          const idx: number[] = [];
          for (let p = 0; p < visible.length; p++) if (visible[p] > 0.5) idx.push(p);
          return selectionBounds(positionAttr.array as Float32Array, idx);
        },
        /** current overlay pulse strengths (green target, yellow flash). */
        pulse: (): { sel: number; flash: number } => ({
          sel: pendingPass.material.uniforms.uStrength.value as number,
          flash: flashPass.material.uniforms.uStrength.value as number,
        }),
        /** project point `idx` (current frame) to client px — for E2E clicks.
         * `depth` = camera-space view depth (positive in front), so pixel
         * tests can reason about impostor sizes and occlusion order. */
        projectPoint: (idx: number): { x: number; y: number; front: boolean; depth: number } => {
          const arr = positionAttr.array as Float32Array;
          const p = new THREE.Vector3(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]);
          camera.updateMatrixWorld();
          const depth = -p.clone().applyMatrix4(camera.matrixWorldInverse).z;
          const v = p.project(camera);
          const rect = renderer.domElement.getBoundingClientRect();
          return {
            x: rect.left + ((v.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - v.y) / 2) * rect.height,
            front: v.z < 1 && v.z > -1,
            depth,
          };
        },
      },
    };
  }

  if (cfg.autoplay && !isStatic) setPlaying(true);
  if (cfg.statsLog) {
    setInterval(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      console.log(
        "[viewer-stats] " +
          JSON.stringify({
            t: Math.round(performance.now()),
            frame: player.frame,
            displayFps: Math.round(displayFps),
            ...player.stats(),
            heapBytes: mem?.usedJSHeapSize ?? null,
          }),
      );
    }, 2000);
  }
}

/**
 * Dockable + collapsible classification panel (4.7 A). Docking is by DRAGGING the
 * grip onto an edge drop-zone (the overlay highlights the nearest edge). Collapse
 * animates the panel size to 0 and leaves a reopen tab at the last dock edge;
 * reopen animates it back. The divider resizes the panel (width side-docked,
 * height top/bottom-docked). Returns a small control API for the test seam.
 */
function setupPanelDocking(
  scheduleResize: () => void,
  applyResize: () => void,
  persist?: { get: () => PanelState | undefined; set: (s: PanelState) => void },
): PanelControl | null {
  const root = document.getElementById("root");
  const sidebar = document.getElementById("sidebar");
  const divider = document.getElementById("divider");
  const middle = document.getElementById("middle");
  const overlay = document.getElementById("dock-overlay");
  const grip = document.getElementById("panel-grip");
  if (!root || !sidebar || !divider || !middle || !overlay || !grip) return null;

  const saved = persist?.get();
  const state: PanelState = {
    dock: saved?.dock ?? "right",
    collapsed: saved?.collapsed ?? false,
    width: saved?.width ?? 300,
    height: saved?.height ?? 220,
  };
  const isSide = (): boolean => state.dock === "left" || state.dock === "right";
  const clampW = (w: number): number => Math.max(160, Math.min(w, window.innerWidth * 0.6));
  const clampH = (h: number): number => Math.max(120, Math.min(h, window.innerHeight * 0.7));
  const targetSize = (): number => (isSide() ? clampW(state.width) : clampH(state.height));

  // Set the panel's active dimension (width side-docked, height top/bottom).
  const setSize = (px: number): void => {
    if (isSide()) {
      sidebar.style.width = `${px}px`;
      sidebar.style.height = "";
    } else {
      sidebar.style.height = `${px}px`;
      sidebar.style.width = "";
    }
  };

  // A1: the collapse arrow points toward the edge the panel collapses to.
  const collapseBtn = document.getElementById("panel-collapse");
  const arrowFor = (d: DockPos): string =>
    d === "left" ? "◂" : d === "right" ? "▸" : d === "top" ? "▴" : "▾";
  const updateArrow = (): void => {
    if (collapseBtn) collapseBtn.textContent = arrowFor(state.dock);
  };

  const layout = (): void => {
    root.dataset.dock = state.dock;
    updateArrow();
    if (!state.collapsed) setSize(targetSize());
    persist?.set(state);
    scheduleResize();
  };

  // Short eased size animation for collapse/open (4.7 A4).
  let animRAF = 0;
  const animateSize = (from: number, to: number, then: () => void): void => {
    if (animRAF) cancelAnimationFrame(animRAF);
    const start = performance.now();
    const dur = 190;
    const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    const step = (now: number): void => {
      const k = Math.min(1, (now - start) / dur);
      setSize(from + (to - from) * ease(k));
      applyResize();
      if (k < 1) animRAF = requestAnimationFrame(step);
      else {
        animRAF = 0;
        then();
      }
    };
    animRAF = requestAnimationFrame(step);
  };

  const collapse = (): void => {
    if (state.collapsed) return;
    state.collapsed = true;
    persist?.set(state);
    animateSize(targetSize(), 0, () => {
      root.classList.add("panel-collapsed");
      applyResize();
    });
  };
  const open = (): void => {
    if (!state.collapsed) return;
    state.collapsed = false;
    persist?.set(state);
    root.classList.remove("panel-collapsed");
    animateSize(0, targetSize(), () => applyResize());
  };
  const setCollapsed = (c: boolean): void => (c ? collapse() : open());

  const setDock = (pos: DockPos): void => {
    state.dock = pos;
    if (state.collapsed) {
      state.collapsed = false;
      root.classList.remove("panel-collapsed");
    }
    layout();
  };

  document.getElementById("panel-collapse")?.addEventListener("click", collapse);
  document.getElementById("panel-reopen")?.addEventListener("click", open);

  // -- drag-to-dock ------------------------------------------------------------
  const zones = [...overlay.querySelectorAll<HTMLElement>(".dock-zone")];
  const nearestZone = (x: number, y: number): DockPos => {
    const dl = x / window.innerWidth, dr = 1 - x / window.innerWidth;
    const dt = y / window.innerHeight, db = 1 - y / window.innerHeight;
    const m = Math.min(dl, dr, dt, db);
    return m === dl ? "left" : m === dr ? "right" : m === dt ? "top" : "bottom";
  };
  let docking = false;
  let hotZone: DockPos = state.dock;
  grip.addEventListener("pointerdown", (e) => {
    docking = true;
    hotZone = state.dock;
    grip.setPointerCapture(e.pointerId);
    overlay.classList.add("active");
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!docking) return;
    hotZone = nearestZone(e.clientX, e.clientY);
    for (const z of zones) z.classList.toggle("hot", z.dataset.zone === hotZone);
  });
  const endDock = (e: PointerEvent): void => {
    if (!docking) return;
    docking = false;
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {
      /* gone */
    }
    overlay.classList.remove("active");
    for (const z of zones) z.classList.remove("hot");
    setDock(hotZone);
  };
  grip.addEventListener("pointerup", endDock);
  grip.addEventListener("pointercancel", endDock);

  // -- divider resize ----------------------------------------------------------
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    (e.target as Element).setPointerCapture((e as PointerEvent).pointerId);
    e.preventDefault();
  });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const m = middle.getBoundingClientRect();
    const pe = e as PointerEvent;
    if (state.dock === "left") state.width = clampW(pe.clientX - m.left);
    else if (state.dock === "right") state.width = clampW(m.right - pe.clientX);
    else if (state.dock === "top") state.height = clampH(pe.clientY - m.top);
    else state.height = clampH(m.bottom - pe.clientY);
    setSize(targetSize());
    scheduleResize();
  });
  const endResize = (e: Event): void => {
    if (!dragging) return;
    dragging = false;
    try {
      (e.target as Element).releasePointerCapture((e as PointerEvent).pointerId);
    } catch {
      /* gone */
    }
    persist?.set(state);
    applyResize();
  };
  divider.addEventListener("pointerup", endResize);
  divider.addEventListener("pointercancel", endResize);

  root.classList.toggle("panel-collapsed", state.collapsed);
  layout();
  return { state, setDock, setCollapsed };
}

main().catch((err) => {
  console.error("[viewer]", err);
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
