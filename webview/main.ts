/**
 * Webview renderer — Increment 4.7: persistent selection & hidden sets.
 *
 * Builds on the streaming+playback stack. Interaction is now driven by two
 * persistent, first-class sets (see sets.ts) that a future agent-driven layer
 * will point at:
 *
 *  - representation.ts owns the per-point base look (color/size/visible). The
 *    base points are drawn with a shader reading those buffers. VISIBILITY is
 *    driven by the HIDDEN set (its resolved points → visible=0); there is no
 *    dimmed middle state.
 *  - the SELECTION set is drawn as a green highlight OVERLAY on VISIBLE points
 *    only — a second Points pass reading per-point `aSel` + shared `aVisible`.
 *  - edges/polylines are drawn only between two visible endpoints (so hiding a
 *    category also removes its edge hairball).
 *  - camera is pure view navigation, plus zoom-to-selection / zoom-out.
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
import { RepresentationLayer } from "./representation.ts";
import { bulkCategories, buildTree } from "./classification.ts";
import { mountSidebar, type SidebarActions, type SidebarHandle } from "./sidebar.ts";
import { mountActiveSets } from "./activesets.ts";
import { Hierarchy, NodeSet, SelectionModel, type Entry } from "./sets.ts";
import { pickPoint, selectionBounds } from "./picking.ts";

// Playback + backpressure tuning (see playback.ts for the policy).
const PLAYBACK_FPS = 30;
const CHUNK_FRAMES = 8;
const LOOKAHEAD_CHUNKS = 2;
const MAX_IN_FLIGHT = 2;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

const EDGE_COLOR = 0x5a7a9a;
const POLYLINE_COLOR = 0x9a7a5a;
const BACKGROUND = 0x1e1e1e;
const SELECTION_COLOR = 0x33ffcc; // selection highlight overlay

const PICK_PIXEL_THRESHOLD = 12;

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
  /** per-point selection flag (0/1) drawn by the highlight overlay. */
  selAttr: THREE.BufferAttribute;
  /** shared visibility attribute (also the overlay's), re-uploaded on hide/show. */
  visibleAttr: THREE.BufferAttribute;
  /** rebuild edge + polyline draw ranges from current visibility. */
  rebuildLines: () => void;
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

/** Selection highlight overlay: green dots on points that are BOTH selected and
 * visible, drawn on top (depthTest off). Reads per-point aSel + shared aVisible. */
function selectionOverlayMaterial(pixelRatio: number, size: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    uniforms: {
      uPixelRatio: { value: pixelRatio },
      uSize: { value: size },
      uColor: { value: new THREE.Color(SELECTION_COLOR) },
    },
    vertexShader: `
      attribute float aVisible; attribute float aSel;
      uniform float uPixelRatio; uniform float uSize; varying float vShow;
      void main() {
        vShow = (aSel > 0.5 && aVisible > 0.5) ? 1.0 : 0.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = vShow > 0.5 ? uSize * uPixelRatio : 0.0;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vShow;
      void main() { if (vShow < 0.5) discard; gl_FragColor = vec4(uColor, 1.0); }`,
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
  for (const a of [colorAttr, sizeAttr, visibleAttr, selAttr]) a.setUsage(THREE.DynamicDrawUsage);

  const drawables: THREE.Object3D[] = [];

  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", positionAttr);
  pointsGeo.setAttribute("aColor", colorAttr);
  pointsGeo.setAttribute("aSize", sizeAttr);
  pointsGeo.setAttribute("aVisible", visibleAttr);
  drawables.push(new THREE.Points(pointsGeo, basePointsMaterial(pixelRatio)));

  // Edges + polylines: an index big enough for every segment, with a draw range
  // that rebuildLines() trims to segments whose BOTH endpoints are visible (so a
  // hidden category also hides its edge hairball).
  const visible = rep.state.visible;
  const mkLines = (pairs: [number, number][], color: number) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    const index = new THREE.BufferAttribute(new Uint32Array(pairs.length * 2), 1);
    index.setUsage(THREE.DynamicDrawUsage);
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    drawables.push(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color })));
    return () => {
      const arr = index.array as Uint32Array;
      let k = 0;
      for (const [a, b] of pairs) {
        if (visible[a] > 0.5 && visible[b] > 0.5) {
          arr[k++] = a;
          arr[k++] = b;
        }
      }
      index.needsUpdate = true;
      geo.setDrawRange(0, k);
    };
  };
  const rebuildEdges = header.edges.length ? mkLines(header.edges, EDGE_COLOR) : () => {};
  const polySegs = polylineSegmentPairs(header.polylines);
  const rebuildPoly = polySegs.length ? mkLines(polySegs, POLYLINE_COLOR) : () => {};
  const rebuildLines = (): void => {
    rebuildEdges();
    rebuildPoly();
  };

  // Selection highlight overlay: a second Points pass over all N, green where
  // selected & visible.
  const overlayGeo = new THREE.BufferGeometry();
  overlayGeo.setAttribute("position", positionAttr);
  overlayGeo.setAttribute("aVisible", visibleAttr);
  overlayGeo.setAttribute("aSel", selAttr);
  const overlay = new THREE.Points(overlayGeo, selectionOverlayMaterial(pixelRatio, 9));
  overlay.renderOrder = 11;
  drawables.push(overlay);

  for (const obj of drawables) {
    obj.frustumCulled = false;
    obj.visible = false; // until the first frame is displayed
    scene.add(obj);
  }
  return { scene, positionAttr, drawables, repAttrs: [colorAttr, sizeAttr, visibleAttr], selAttr, visibleAttr, rebuildLines };
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
  window.addEventListener("message", (e: MessageEvent) => transport.handleMessage(e.data));

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
  const rep = new RepresentationLayer(header.n_points);
  const hierarchy = new Hierarchy(header);
  const selectionModel = new SelectionModel(hierarchy); // multiple named groups
  const hiddenSet = new NodeSet(hierarchy, "hidden"); // one global hidden set
  const selArray = new Float32Array(header.n_points); // per-point selection flag (union of all groups)

  const parts = buildScene(header, rep, selArray, renderer.getPixelRatio());
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

  // -- selection/hidden → render bit flips (incremental) -----------------------
  const visible = rep.state.visible;
  let selDirty = false;
  // Selection is the UNION of all named groups; flip only the touched points.
  const flipSelectionBits = (points: number[]): void => {
    for (const p of points) selArray[p] = selectionModel.containsPoint(p) ? 1 : 0;
    selDirty = true;
  };
  const flipHiddenBits = (points: number[]): void => {
    for (const p of points) visible[p] = hiddenSet.contains(p) ? 0 : 1;
    rep.dirty = true; // re-upload visible; overlay shares it. Edges rebuilt below.
    parts.rebuildLines();
  };

  // -- zoom-to helpers ---------------------------------------------------------
  const zoomToPoints = (indices: number[]): void => {
    const b = selectionBounds(positionAttr.array as Float32Array, indices);
    if (!b) return;
    const center = new THREE.Vector3(b.center[0], b.center[1], b.center[2]);
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(b.radius, sceneSize * 0.02) / Math.sin(fov / 2) * 1.4;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    animateCameraTo(center.clone().addScaledVector(dir, dist), center);
  };
  const zoomToSelection = (): void => zoomToPoints(selectionModel.resolvedPoints());

  // -- gesture actions (toggle-only; select acts on the ACTIVE group) ----------
  const toggleSelect = (e: Entry): void => flipSelectionBits(selectionModel.toggle(e));
  const addSelect = (e: Entry): void => flipSelectionBits(selectionModel.addToActive(e)); // drag-paint
  const toggleHide = (e: Entry): void => flipHiddenBits(hiddenSet.toggle(e));
  const clearActiveGroup = (): void => flipSelectionBits(selectionModel.clearGroup(selectionModel.active.id));

  // -- named-group + hidden actions (active-sets surface) ----------------------
  const activeSetsActions = {
    newGroup: () => selectionModel.newGroup(),
    renameGroup: (id: number, name: string) => selectionModel.rename(id, name),
    deleteGroup: (id: number) => flipSelectionBits(selectionModel.delete(id)),
    setActiveGroup: (id: number) => selectionModel.setActive(id),
    removeSelectionEntry: (gid: number, e: Entry) => flipSelectionBits(selectionModel.removeEntryFrom(gid, e)),
    removeHiddenEntry: (e: Entry) => {
      const pts = hiddenSet.remove(e);
      if (pts) flipHiddenBits(pts);
    },
    clearHidden: () => flipHiddenBits(hiddenSet.clear()),
  };

  // -- classification tree + active-sets surface -------------------------------
  const sidebarActions: SidebarActions = { toggleSelect, addSelect, toggleHide };
  let sidebar: SidebarHandle | null = null;
  const treeHost = document.getElementById("tree-host");
  if (treeHost) {
    sidebar = mountSidebar(treeHost, buildTree(header), hierarchy, selectionModel, hiddenSet, sidebarActions);
  }
  const activeSetsHost = document.getElementById("active-sets");
  if (activeSetsHost) {
    mountActiveSets(activeSetsHost, selectionModel, hiddenSet, hierarchy, activeSetsActions);
  }

  // -- bulk pre-hidden by default (one hidden entry per bulk category) ---------
  const bulkPre = bulkCategories(header);
  if (bulkPre.size > 0) {
    flipHiddenBits(hiddenSet.addMany([...bulkPre].map((c) => ({ level: "category", id: c }) as Entry)));
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
  // 3D gestures (toggle-only, no modifiers). Left = toggle-select, right =
  // toggle-hide; a drag (past the threshold) stays camera orbit and never
  // selects. Resolution is COARSE when oriented and FINE when zoomed in (B5): a
  // click resolves to the point's SUBGROUP by default, or to the individual POINT
  // once the camera is closer than ZOOM_POINT_FACTOR·sceneSize. Selecting scrolls
  // the panel to that subgroup. Double-click a point zooms to it (net-zero
  // selection); double-click empty backs the camera out.
  const CLICK_MOVE_THRESHOLD = 5;
  const DOUBLE_CLICK_MS = 300;
  const ZOOM_POINT_FACTOR = 0.7;
  const resolve3D = (idx: number): Entry => {
    const dist = camera.position.distanceTo(controls.target);
    return dist < sceneSize * ZOOM_POINT_FACTOR
      ? { level: "point", id: idx }
      : { level: "subgroup", id: hierarchy.subgroupOfPoint(idx) };
  };
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
  let pointerDown: { x: number; y: number; button: number } | null = null;
  let lastClick = { t: 0, x: 0, y: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointerDown =
      e.button === 0 || e.button === 2 ? { x: e.clientX, y: e.clientY, button: e.button } : null;
  });
  window.addEventListener("pointerup", (e) => {
    const down = pointerDown;
    pointerDown = null;
    if (!down || e.button !== down.button) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MOVE_THRESHOLD) return; // drag = camera
    const idx = pickAt(e.clientX, e.clientY);
    if (down.button === 2) {
      if (idx >= 0) toggleHide(resolve3D(idx)); // right-click toggles hide
      return;
    }
    const now = performance.now();
    const isDouble =
      now - lastClick.t < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
    lastClick = { t: now, x: e.clientX, y: e.clientY };
    if (idx < 0) {
      if (isDouble) resetCamera(); // double-click empty → whole-scene framing
      return; // a single click on empty space does nothing (toggle model)
    }
    const entry = resolve3D(idx);
    if (isDouble) {
      toggleSelect(entry); // undo the single-click toggle from the first click
      zoomToPoints(hierarchy.pointsOf(entry));
    } else {
      toggleSelect(entry);
      sidebar?.revealSubgroup(entry.level === "subgroup" ? entry.id : hierarchy.subgroupOfPoint(idx));
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clearActiveGroup();
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
    // driver read camera/selection/player state and drive controls directly.
    (window as unknown as { __viewer?: unknown }).__viewer = {
      camera,
      controls,
      player,
      rep,
      hierarchy,
      selection: selectionModel,
      hidden: hiddenSet,
      sidebar,
      actions: {
        toggleSelect,
        addSelect,
        toggleHide,
        clearActiveGroup,
        ...activeSetsActions,
      },
      applyResize,
      setPlaying,
      zoomToSelection,
      resetCamera,
      panel,
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
