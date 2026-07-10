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
  decodeFrameChunk,
  parseHeader,
  validateFrameChunk,
  type FrameChunk,
  type Header,
} from "../contract/contract.ts";
import { StreamingPlayer } from "./playback.ts";
import { Transport, rejectIfErrorPayload } from "./transport.ts";
import { DEFAULT_TRACE_COLOR, RepresentationLayer } from "./representation.ts";
import { bulkCategories, buildTree } from "./classification.ts";
import { flashRow, mountTree, type TreeHandle } from "./tree.ts";
import { mountCommitted, type CommittedActions } from "./committed.ts";
import { mountBrackets, BRACKET_GUTTER_PX } from "./brackets.ts";
import { createCommandRegistry, makeRunComplete, type CommandResult } from "./commands.ts";
import { parseTarget, resolveTarget, type Completion } from "./address.ts";
import { Hierarchy, SelectionModel, type Entry } from "./sets.ts";
import { pickPoint, selectionBounds } from "./picking.ts";

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
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

interface SceneParts {
  scene: THREE.Scene;
  positionAttr: THREE.BufferAttribute;
  drawables: THREE.Object3D[];
  /** color/size/visible attributes to re-upload when the representation changes. */
  repAttrs: THREE.BufferAttribute[];
  /** per-point pending-target flag (0/1) drawn by the green overlay. */
  selAttr: THREE.BufferAttribute;
  /** per-point focus-flash flag (0/1) drawn by the yellow pulse pass. */
  flashAttr: THREE.BufferAttribute;
  /** shared visibility attribute (also the overlays'), re-uploaded on hide/show. */
  visibleAttr: THREE.BufferAttribute;
  /** the overlays' materials (uStrength driven per-frame by the render loop). */
  selMat: THREE.ShaderMaterial;
  flashMat: THREE.ShaderMaterial;
  /** rebuild edge + polyline draw ranges from current visibility. */
  rebuildLines: () => void;
  /** re-copy the de-indexed edge pass (positions from the current frame,
   * colors from rep.state.edgeColor) — every displayed-frame flip needs it. */
  fillEdges: () => void;
  /** the polyline pass's per-POINT color attribute (null without polylines);
   * colorTrace writes rep.state.traceColor through to the vertex slots. */
  traceColAttr: THREE.BufferAttribute | null;
}

function basePointsMaterial(pixelRatio: number): THREE.ShaderMaterial {
  // Reads the representation layer's per-point color/size/visible buffers.
  // Hidden points collapse (size 0) and discard.
  return new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize; attribute float aVisible;
      uniform float uPixelRatio; varying vec3 vColor; varying float vVisible;
      void main() {
        vColor = aColor; vVisible = aVisible;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aVisible > 0.5 ? aSize * uPixelRatio : 0.0;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vVisible;
      void main() { if (vVisible < 0.5) discard; gl_FragColor = vec4(vColor, 1.0); }`,
  });
}

/**
 * Focus-flash overlay: like the highlight overlay, but points that are ALSO
 * in the pending selection render the flash BLENDED toward the selection
 * tint — a focus pulse passing over green points shifts smoothly within the
 * same color family instead of hard-swapping to yellow (no splotches).
 */
function focusFlashMaterial(
  pixelRatio: number,
  size: number,
  color: number,
  selColor: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uSize: { value: size },
      uColor: { value: new THREE.Color(color) },
      uSelColor: { value: new THREE.Color(selColor) },
      uStrength: { value: 0 },
    },
    vertexShader: `
      attribute float aVisible; attribute float aFlag; attribute float aSel;
      uniform float uPixelRatio; uniform float uSize; uniform float uStrength;
      varying float vShow; varying float vK; varying float vSel;
      void main() {
        vK = uStrength;
        vSel = aSel;
        vShow = (aFlag > 0.5 && aVisible > 0.5 && vK > 0.01) ? 1.0 : 0.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = vShow > 0.5 ? uSize * uPixelRatio : 0.0;
      }`,
    fragmentShader: `
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
  });
}

/**
 * Highlight overlay: a Points pass tinting points whose `aFlag` is set AND
 * that are visible (hidden wins) toward a light highlight color. No glow, no
 * halo, no size change — the point simply pulses to the new color and back.
 * `uStrength` (0..1) animates the tint per frame on the CPU; `uFloor` is the
 * tint floor — the pending overlay breathes but never disappears
 * (floor ≈ 0.45), the focus flash fades fully out (floor 0).
 */
function highlightMaterial(
  pixelRatio: number,
  size: number,
  color: number,
  floor: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uSize: { value: size },
      uColor: { value: new THREE.Color(color) },
      uStrength: { value: 0 },
      uFloor: { value: floor },
    },
    vertexShader: `
      attribute float aVisible; attribute float aFlag;
      uniform float uPixelRatio; uniform float uSize; uniform float uStrength; uniform float uFloor;
      varying float vShow; varying float vK;
      void main() {
        vK = uFloor + (1.0 - uFloor) * uStrength;
        vShow = (aFlag > 0.5 && aVisible > 0.5 && vK > 0.01) ? 1.0 : 0.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = vShow > 0.5 ? uSize * uPixelRatio : 0.0;
      }`,
    fragmentShader: `
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
  });
}

/** Flatten polylines into segment endpoint pairs once (for the rebuild filter). */
function polylineSegmentPairs(polylines: number[][]): [number, number][] {
  const out: [number, number][] = [];
  for (const poly of polylines) for (let i = 0; i + 1 < poly.length; i++) out.push([poly[i], poly[i + 1]]);
  return out;
}

function buildScene(
  header: Header,
  rep: RepresentationLayer,
  selArray: Float32Array,
  flashArray: Float32Array,
  pixelRatio: number,
): SceneParts {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const n = header.n_points;

  const positionAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.BufferAttribute(rep.state.color, 3);
  const sizeAttr = new THREE.BufferAttribute(rep.state.size, 1);
  const visibleAttr = new THREE.BufferAttribute(rep.state.visible, 1);
  const selAttr = new THREE.BufferAttribute(selArray, 1);
  const flashAttr = new THREE.BufferAttribute(flashArray, 1);
  for (const a of [colorAttr, sizeAttr, visibleAttr, selAttr, flashAttr]) a.setUsage(THREE.DynamicDrawUsage);

  const drawables: THREE.Object3D[] = [];

  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", positionAttr);
  pointsGeo.setAttribute("aColor", colorAttr);
  pointsGeo.setAttribute("aSize", sizeAttr);
  pointsGeo.setAttribute("aVisible", visibleAttr);
  drawables.push(new THREE.Points(pointsGeo, basePointsMaterial(pixelRatio)));

  // Edges + polylines, trimmed to segments whose BOTH endpoints are visible
  // (so a hidden category also hides its edge hairball).
  //
  // The EDGE pass is DE-INDEXED: per-EDGE flat color (rep.state.edgeColor)
  // cannot ride an indexed geometry sharing the points' position attribute —
  // shared vertices would bleed one edge's color onto every adjacent edge as
  // a gradient. So each visible edge gets two OWNED vertices: positions are
  // copied from the current frame (fillEdges runs on every displayed-frame
  // flip, visibility change, and edge-color write — a linear copy, cheap at
  // these scales), and both vertices carry the edge's color. The polyline
  // pass keeps the zero-copy indexed form: it has no per-segment color yet
  // (colortrace is deferred — see docs/COMMAND_LAYER.md open threads).
  const visible = rep.state.visible;
  const nEdges = header.edges.length;
  const edgePosAttr = new THREE.BufferAttribute(new Float32Array(nEdges * 2 * 3), 3);
  const edgeColAttr = new THREE.BufferAttribute(new Float32Array(nEdges * 2 * 3), 3);
  edgePosAttr.setUsage(THREE.DynamicDrawUsage);
  edgeColAttr.setUsage(THREE.DynamicDrawUsage);
  let fillEdges: () => void = () => {};
  if (nEdges > 0) {
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", edgePosAttr);
    edgeGeo.setAttribute("color", edgeColAttr);
    edgeGeo.setDrawRange(0, 0);
    drawables.push(new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ vertexColors: true })));
    fillEdges = (): void => {
      const pos = positionAttr.array as Float32Array;
      const ec = rep.state.edgeColor;
      const pArr = edgePosAttr.array as Float32Array;
      const cArr = edgeColAttr.array as Float32Array;
      let k = 0; // vertex write cursor (2 per visible edge)
      for (let e = 0; e < nEdges; e++) {
        const a = header.edges[e][0];
        const b = header.edges[e][1];
        if (visible[a] > 0.5 && visible[b] > 0.5) {
          for (let c = 0; c < 3; c++) {
            pArr[k * 3 + c] = pos[a * 3 + c];
            pArr[k * 3 + 3 + c] = pos[b * 3 + c];
            cArr[k * 3 + c] = ec[e * 3 + c];
            cArr[k * 3 + 3 + c] = ec[e * 3 + c];
          }
          k += 2;
        }
      }
      edgePosAttr.needsUpdate = true;
      edgeColAttr.needsUpdate = true;
      edgeGeo.setDrawRange(0, k);
    };
  }
  // The polyline pass keeps the ZERO-COPY indexed form (positions ride the
  // shared attribute; nothing re-copies on frame flip). Per-VERTEX color
  // arrives as a per-POINT attribute — indexed draws fetch attributes by
  // point index — sized 3N with only the polyline-vertex slots ever drawn;
  // colorTrace writes it through from rep.state.traceColor on color-write
  // only. The GPU interpolates between vertex colors along a segment, so a
  // colored↔uncolored boundary renders as a gradient — intended, inherent
  // to per-vertex color. (If two polyline vertices ever shared one point
  // index, the drawn color of that point would be the later write; state
  // stays per-vertex regardless. The producer's vertices are distinct.)
  const polySegs = polylineSegmentPairs(header.polylines);
  let traceColAttr: THREE.BufferAttribute | null = null;
  let rebuildPoly: () => void = () => {};
  if (polySegs.length > 0) {
    const traceArr = new Float32Array(header.n_points * 3);
    for (let p = 0; p < header.n_points; p++) {
      traceArr[p * 3] = DEFAULT_TRACE_COLOR[0];
      traceArr[p * 3 + 1] = DEFAULT_TRACE_COLOR[1];
      traceArr[p * 3 + 2] = DEFAULT_TRACE_COLOR[2];
    }
    traceColAttr = new THREE.BufferAttribute(traceArr, 3);
    traceColAttr.setUsage(THREE.DynamicDrawUsage);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setAttribute("color", traceColAttr);
    const index = new THREE.BufferAttribute(new Uint32Array(polySegs.length * 2), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    drawables.push(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true })));
    rebuildPoly = () => {
      const arr = index.array as Uint32Array;
      let k = 0;
      for (const [a, b] of polySegs) {
        if (visible[a] > 0.5 && visible[b] > 0.5) {
          arr[k++] = a;
          arr[k++] = b;
        }
      }
      index.needsUpdate = true;
      geo.setDrawRange(0, k);
    };
  }
  const rebuildLines = (): void => {
    fillEdges();
    rebuildPoly();
  };

  // Pending-target overlay: a second Points pass over all N, gently pulsing
  // targeted & visible points to a light green.
  const selMat = highlightMaterial(pixelRatio, 6, SELECTION_COLOR, 0.45);
  const overlayGeo = new THREE.BufferGeometry();
  overlayGeo.setAttribute("position", positionAttr);
  overlayGeo.setAttribute("aVisible", visibleAttr);
  overlayGeo.setAttribute("aFlag", selAttr);
  const overlay = new THREE.Points(overlayGeo, selMat);
  overlay.renderOrder = 11;
  drawables.push(overlay);

  // Focus flash: a brief light-yellow tint over the last-focused region.
  const flashMat = focusFlashMaterial(pixelRatio, 7, FOCUS_COLOR, SELECTION_COLOR);
  const flashGeo = new THREE.BufferGeometry();
  flashGeo.setAttribute("position", positionAttr);
  flashGeo.setAttribute("aVisible", visibleAttr);
  flashGeo.setAttribute("aFlag", flashAttr);
  flashGeo.setAttribute("aSel", selAttr); // blend the flash on selected points
  const flash = new THREE.Points(flashGeo, flashMat);
  flash.renderOrder = 12;
  drawables.push(flash);

  for (const obj of drawables) {
    obj.frustumCulled = false;
    obj.visible = false; // until the first frame is displayed
    scene.add(obj);
  }
  return {
    scene,
    positionAttr,
    drawables,
    repAttrs: [colorAttr, sizeAttr, visibleAttr],
    selAttr,
    flashAttr,
    visibleAttr,
    selMat,
    flashMat,
    rebuildLines,
    fillEdges,
    traceColAttr,
  };
}

function frameCamera(header: Header, aspect: number) {
  const box = header.bbox ?? { min: [-10, -10, -10], max: [10, 10, 10] };
  const center = new THREE.Vector3(
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  );
  const size = Math.max(
    box.max[0] - box.min[0],
    box.max[1] - box.min[1],
    box.max[2] - box.min[2],
    1e-3,
  );
  const camera = new THREE.PerspectiveCamera(50, aspect, size / 1000, size * 100);
  camera.position
    .copy(center)
    .add(new THREE.Vector3(0.9, 0.7, 1.1).normalize().multiplyScalar(size * 1.6));
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
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as { type?: string; id?: number; text?: string; cursor?: number };
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
    transport.handleMessage(e.data);
  });

  setStatus("requesting header…");
  const headerBytes = await transport.request({ type: "header" });
  rejectIfErrorPayload(headerBytes);
  const header = parseHeader(new TextDecoder().decode(headerBytes));
  const nFrames = header.n_frames;

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

  const parts = buildScene(header, rep, selArray, flashArray, renderer.getPixelRatio());
  const { scene, positionAttr, drawables, repAttrs } = parts;
  const { camera, target, size: sceneSize } = frameCamera(
    header,
    container.clientWidth / container.clientHeight,
  );
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
    animateCameraTo(homeTarget.clone().addScaledVector(dir, sceneSize * 1.6), homeTarget.clone());
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
      parts.rebuildLines();
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
    parts.flashAttr.needsUpdate = true;
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
  /** color <target> <c>: THE FIRST REPRESENTATION MUTATION — a constant
   * per-point RGB written straight into the representation layer's color
   * buffer (the renderer already reads it as the aColor attribute; the
   * uniform base look is just this buffer's initial value, so uncolored
   * points keep it). Last-write-wins per point — no precedence system.
   * Recorded via model.recordOp on the SAME undo stack the gestures use:
   * one stroke per invocation, and its undo restores the exact previous RGB
   * values, which may themselves be an earlier color's (LIFO composes). */
  const colorPoints = (points: readonly number[], rgb: [number, number, number]): number => {
    if (points.length === 0) return 0;
    const color = rep.state.color;
    const pts = [...points];
    const prev = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] * 3;
      prev[i * 3] = color[p];
      prev[i * 3 + 1] = color[p + 1];
      prev[i * 3 + 2] = color[p + 2];
      color[p] = rgb[0];
      color[p + 1] = rgb[1];
      color[p + 2] = rgb[2];
    }
    rep.dirty = true; // the render loop re-uploads every rep attribute
    model.recordOp(() => {
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i] * 3;
        color[p] = prev[i * 3];
        color[p + 1] = prev[i * 3 + 1];
        color[p + 2] = prev[i * 3 + 2];
      }
      rep.dirty = true;
      return pts;
    });
    return pts.length;
  };

  /** colorbonds / colorbondsof: colorPoints' EDGE twin — a constant per-edge
   * RGB written into rep.state.edgeColor (indexed by the header's edge
   * order; the base look is the buffer's initial value). Both verbs write
   * THIS one buffer, so they compose by last-write-wins per edge. The
   * de-indexed edge pass re-copies colors via fillEdges — no rep.dirty
   * (that re-uploads the per-POINT attributes; edges own their buffers).
   * Same recordOp discipline as colorPoints: one stroke, exact-prior-RGB
   * restore; the undo returns no point indices (no point state changed). */
  const colorEdges = (edgeIds: readonly number[], rgb: [number, number, number]): number => {
    if (edgeIds.length === 0) return 0;
    const ec = rep.state.edgeColor;
    const ids = [...edgeIds];
    const prev = new Float32Array(ids.length * 3);
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] * 3;
      prev[i * 3] = ec[e];
      prev[i * 3 + 1] = ec[e + 1];
      prev[i * 3 + 2] = ec[e + 2];
      ec[e] = rgb[0];
      ec[e + 1] = rgb[1];
      ec[e + 2] = rgb[2];
    }
    parts.fillEdges();
    model.recordOp(() => {
      for (let i = 0; i < ids.length; i++) {
        const e = ids[i] * 3;
        ec[e] = prev[i * 3];
        ec[e + 1] = prev[i * 3 + 1];
        ec[e + 2] = prev[i * 3 + 2];
      }
      parts.fillEdges();
      return [];
    });
    return ids.length;
  };

  /** colortrace: the POLYLINE member of the family — a constant per-VERTEX
   * RGB in rep.state.traceColor (header vertex order), written through to
   * the polyline pass's per-point attribute slots (indexed draws fetch by
   * point index; write-time only — positions stay zero-copy on frame flip).
   * Same recordOp discipline: one stroke, exact-prior-RGB restore on both
   * the state buffer and the GPU slots, no point indices returned. */
  const colorTrace = (vertexIds: readonly number[], rgb: [number, number, number]): number => {
    const attr = parts.traceColAttr;
    if (!attr || vertexIds.length === 0) return 0;
    const tc = rep.state.traceColor;
    const gpu = attr.array as Float32Array;
    const ids = [...vertexIds];
    const prev = new Float32Array(ids.length * 3);
    const put = (v: number, r: number, g: number, b: number): void => {
      tc[v * 3] = r;
      tc[v * 3 + 1] = g;
      tc[v * 3 + 2] = b;
      const p = traceVertices[v] * 3;
      gpu[p] = r;
      gpu[p + 1] = g;
      gpu[p + 2] = b;
    };
    for (let i = 0; i < ids.length; i++) {
      const v = ids[i] * 3;
      prev[i * 3] = tc[v];
      prev[i * 3 + 1] = tc[v + 1];
      prev[i * 3 + 2] = tc[v + 2];
      put(ids[i], rgb[0], rgb[1], rgb[2]);
    }
    attr.needsUpdate = true;
    model.recordOp(() => {
      for (let i = 0; i < ids.length; i++) {
        put(ids[i], prev[i * 3], prev[i * 3 + 1], prev[i * 3 + 2]);
      }
      attr.needsUpdate = true;
      return [];
    });
    return ids.length;
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
    edges: header.edges,
    colorEdges,
    traceVertices,
    colorTrace,
  };
  const commands = createCommandRegistry(commandContext);
  runCommand = (text: string) => commands.runCommand(text);
  runComplete = makeRunComplete(commandContext, commands);
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
  parts.rebuildLines();

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
    parts.fillEdges(); // the de-indexed edge pass owns copies of these positions
    if (displayedFrame === -1) for (const obj of drawables) obj.visible = true;
    displayedFrame = f;
    shownSinceMark++;
    return true;
  };

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
      parts.selAttr.needsUpdate = true;
      selDirty = false;
    }
    // Pulse strengths are CPU-computed each frame (shaders stay time-free):
    // the pending green breathes; the yellow focus flash swells and fades once.
    parts.selMat.uniforms.uStrength.value =
      0.5 + 0.5 * Math.sin((now / GREEN_PULSE_PERIOD_MS) * Math.PI * 2);
    if (flashStart >= 0) {
      const k = (now - flashStart) / FOCUS_FLASH_MS;
      if (k >= 1) {
        flashStart = -1;
        parts.flashMat.uniforms.uStrength.value = 0;
        for (const p of flashPts) flashArray[p] = 0;
        flashPts = [];
        parts.flashAttr.needsUpdate = true;
      } else {
        parts.flashMat.uniforms.uStrength.value = Math.pow(Math.sin(Math.PI * k), 1.35);
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

  setStatus(
    `${header.name} — N=${header.n_points}, T=${nFrames} · ` +
      `${header.edges.length} edges, ${header.polylines.length} polylines · ` +
      `${header.categories.length} categories · live producer stream`,
  );

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
          sel: parts.selMat.uniforms.uStrength.value as number,
          flash: parts.flashMat.uniforms.uStrength.value as number,
        }),
        /** project point `idx` (current frame) to client px — for E2E clicks. */
        projectPoint: (idx: number): { x: number; y: number; front: boolean } => {
          const arr = positionAttr.array as Float32Array;
          const v = new THREE.Vector3(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]).project(
            camera,
          );
          const rect = renderer.domElement.getBoundingClientRect();
          return {
            x: rect.left + ((v.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - v.y) / 2) * rect.height,
            front: v.z < 1 && v.z > -1,
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
