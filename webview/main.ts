/**
 * Webview renderer — Increment 4: the interaction backbone.
 *
 * Builds on Increment 2/3 streaming+playback. This increment adds a first-class
 * SELECTION substrate, a classification SIDEBAR to navigate/select from, and
 * selection-driven camera — while leaving REPRESENTATION a deliberately blank,
 * replaceable layer (defaults only, one bulk-visibility toggle). The three
 * concerns are kept orthogonal:
 *
 *  - representation.ts owns the per-point base look (color/size/visible). The
 *    base points are drawn with a shader that reads those three per-point
 *    buffers. A future agent-driven layer replaces how they are computed with
 *    nothing else changing.
 *  - selection.ts owns "what is pointed at". It is drawn as a highlight OVERLAY
 *    (two extra indexed Points objects sharing the same position buffer) on top
 *    of the base — it never mutates representation buffers.
 *  - camera is pure view navigation, plus zoom-to-selection.
 *
 * Positions still stream zero-copy: every displayed frame swaps a subarray view
 * into the one shared position attribute; the base points, the edges/polylines,
 * and both selection overlays all reference that same attribute.
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
import { edgeSegmentIndices, polylineSegmentIndices } from "./geometry.ts";
import { StreamingPlayer } from "./playback.ts";
import { Transport, rejectIfErrorPayload } from "./transport.ts";
import { RepresentationLayer } from "./representation.ts";
import { SelectionStore, type SelectionSnapshot } from "./selection.ts";
import { bulkCategories, buildTree } from "./classification.ts";
import { mountSidebar } from "./sidebar.ts";
import { neighborSubgroups, pickPoint, selectionBounds } from "./picking.ts";

// Playback + backpressure tuning (see playback.ts for the policy).
const PLAYBACK_FPS = 30;
const CHUNK_FRAMES = 8;
const LOOKAHEAD_CHUNKS = 2;
const MAX_IN_FLIGHT = 2;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

const EDGE_COLOR = 0x5a7a9a;
const POLYLINE_COLOR = 0x9a7a5a;
const BACKGROUND = 0x1e1e1e;
const SELECTION_COLOR = 0x33ffcc; // primary highlight overlay
const NEIGHBOR_COLOR = 0xffa63d; // neighbor highlight overlay

const PICK_PIXEL_THRESHOLD = 12;
// Cap on the non-bulk population we brute-force for neighbor queries; above it,
// skip (a spatial index would be the fix). Well above real non-bulk sizes.
const NEIGHBOR_CANDIDATE_CAP = 80_000;

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

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
  repAttrs: THREE.BufferAttribute[];
  selectionIndex: THREE.BufferAttribute;
  selectionGeo: THREE.BufferGeometry;
  neighborIndex: THREE.BufferAttribute;
  neighborGeo: THREE.BufferGeometry;
  /** Edges internal to bulk categories — shown only when bulk is revealed, so
   * hiding bulk points doesn't leave a hairball of bulk edges. Null if none. */
  bulkEdges: THREE.Object3D | null;
}

function basePointsMaterial(pixelRatio: number): THREE.ShaderMaterial {
  // Reads the representation layer's per-point color/size/visible buffers.
  // Hidden points collapse (size 0) and discard, so bulk stays truly hidden.
  return new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: pixelRatio } },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aVisible;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vVisible;
      void main() {
        vColor = aColor;
        vVisible = aVisible;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aVisible > 0.5 ? aSize * uPixelRatio : 0.0;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vVisible;
      void main() {
        if (vVisible < 0.5) discard;
        gl_FragColor = vec4(vColor, 1.0);
      }
    `,
  });
}

function overlayMaterial(color: number, size: number): THREE.PointsMaterial {
  // Drawn on top of the base (depthTest off) as a distinct highlight. This is
  // the selection channel — independent of the representation layer.
  return new THREE.PointsMaterial({
    color,
    size,
    sizeAttenuation: false,
    depthTest: false,
    transparent: true,
  });
}

function buildScene(header: Header, rep: RepresentationLayer, pixelRatio: number): SceneParts {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const n = header.n_points;

  const positionAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);

  const colorAttr = new THREE.BufferAttribute(rep.state.color, 3);
  const sizeAttr = new THREE.BufferAttribute(rep.state.size, 1);
  const visibleAttr = new THREE.BufferAttribute(rep.state.visible, 1);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  visibleAttr.setUsage(THREE.DynamicDrawUsage);

  const drawables: THREE.Object3D[] = [];

  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", positionAttr);
  pointsGeo.setAttribute("aColor", colorAttr);
  pointsGeo.setAttribute("aSize", sizeAttr);
  pointsGeo.setAttribute("aVisible", visibleAttr);
  drawables.push(new THREE.Points(pointsGeo, basePointsMaterial(pixelRatio)));

  // Split edges into structural vs bulk-internal (both endpoints in a bulk
  // category). Bulk-internal edges are drawn as a separate object gated on the
  // bulk toggle, so hiding bulk points also hides their edge hairball (4.6 D).
  const bulk = bulkCategories(header);
  const isBulkPoint = (p: number): boolean => bulk.has(header.points.category[p]);
  const structuralEdges: [number, number][] = [];
  const bulkInternalEdges: [number, number][] = [];
  for (const e of header.edges) {
    (isBulkPoint(e[0]) && isBulkPoint(e[1]) ? bulkInternalEdges : structuralEdges).push(e);
  }
  if (structuralEdges.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setIndex(new THREE.BufferAttribute(edgeSegmentIndices(structuralEdges), 1));
    drawables.push(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: EDGE_COLOR })));
  }
  let bulkEdges: THREE.Object3D | null = null;
  if (bulkInternalEdges.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setIndex(new THREE.BufferAttribute(edgeSegmentIndices(bulkInternalEdges), 1));
    bulkEdges = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    bulkEdges.frustumCulled = false;
    bulkEdges.visible = false; // follows the bulk toggle (see the display loop)
    scene.add(bulkEdges);
  }
  if (header.polylines.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setIndex(new THREE.BufferAttribute(polylineSegmentIndices(header.polylines), 1));
    drawables.push(
      new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: POLYLINE_COLOR })),
    );
  }

  // Selection + neighbor overlays: indexed Points sharing the position buffer.
  const neighborGeo = new THREE.BufferGeometry();
  neighborGeo.setAttribute("position", positionAttr);
  const neighborIndex = new THREE.BufferAttribute(new Uint32Array(n), 1);
  neighborIndex.setUsage(THREE.DynamicDrawUsage);
  neighborGeo.setIndex(neighborIndex);
  neighborGeo.setDrawRange(0, 0);
  const neighborPoints = new THREE.Points(neighborGeo, overlayMaterial(NEIGHBOR_COLOR, 6));
  neighborPoints.renderOrder = 10;

  const selectionGeo = new THREE.BufferGeometry();
  selectionGeo.setAttribute("position", positionAttr);
  const selectionIndex = new THREE.BufferAttribute(new Uint32Array(n), 1);
  selectionIndex.setUsage(THREE.DynamicDrawUsage);
  selectionGeo.setIndex(selectionIndex);
  selectionGeo.setDrawRange(0, 0);
  const selectionPoints = new THREE.Points(selectionGeo, overlayMaterial(SELECTION_COLOR, 8));
  selectionPoints.renderOrder = 11;

  drawables.push(neighborPoints, selectionPoints);

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
    selectionIndex,
    selectionGeo,
    neighborIndex,
    neighborGeo,
    bulkEdges,
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
  const rep = new RepresentationLayer(header);
  const selection = new SelectionStore(header);

  const parts = buildScene(header, rep, renderer.getPixelRatio());
  const { scene, positionAttr, drawables, repAttrs } = parts;
  const { camera, target, size: sceneSize } = frameCamera(
    header,
    container.clientWidth / container.clientHeight,
  );
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.target.copy(target);
  // Inertia (4.6 B3): a flick keeps the view spinning and decays smoothly, so
  // turning the structure around needs less dragging. A low damping factor =
  // more coast; a slow, deliberate drag still positions precisely.
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.12;
  controls.rotateSpeed = 2.2;
  controls.zoomSpeed = 1.2;
  controls.panSpeed = 0.6;
  controls.handleResize();
  controls.update();

  // The "home" pose (whole-scene framing) captured before any interaction, so
  // double-click-empty can back all the way out to it (4.6 B1).
  const homePosition = camera.position.clone();
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
  const animateCameraTo = (toPos: THREE.Vector3, toTarget: THREE.Vector3): void => {
    camTween = {
      p0: camera.position.clone(),
      p1: toPos.clone(),
      t0: controls.target.clone(),
      t1: toTarget.clone(),
      start: performance.now(),
    };
    controls.enabled = false;
  };
  const resetCamera = (): void => animateCameraTo(homePosition, homeTarget);

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

  // Resizable sidebar (Increment 4.5, B3): drag the divider to change the split;
  // the canvas re-lays-out and re-renders through applyResize (no overlap).
  const divider = document.getElementById("divider");
  const sidebarEl = document.getElementById("sidebar");
  if (divider && sidebarEl) {
    let draggingDivider = false;
    divider.addEventListener("pointerdown", (e) => {
      draggingDivider = true;
      (e.target as Element).setPointerCapture((e as PointerEvent).pointerId);
      e.preventDefault();
    });
    divider.addEventListener("pointermove", (e) => {
      if (!draggingDivider) return;
      const left = sidebarEl.getBoundingClientRect().left;
      const w = Math.max(180, Math.min((e as PointerEvent).clientX - left, window.innerWidth * 0.6));
      sidebarEl.style.width = `${w}px`;
      scheduleResize();
    });
    const endDivider = (e: Event): void => {
      if (!draggingDivider) return;
      draggingDivider = false;
      try {
        (e.target as Element).releasePointerCapture((e as PointerEvent).pointerId);
      } catch {
        /* capture may already be gone */
      }
      applyResize();
    };
    divider.addEventListener("pointerup", endDivider);
    divider.addEventListener("pointercancel", endDivider);
  }

  // -- neighbor highlighting (nice-to-have): brute-force radius over non-bulk --
  const bulk = bulkCategories(header);
  const nonBulkPoints: number[] = [];
  for (let p = 0; p < header.n_points; p++) {
    if (!bulk.has(header.points.category[p])) nonBulkPoints.push(p);
  }
  const subgroupOfPoint = header.points.subgroup_id;
  const neighborRadius = 0.18 * sceneSize;
  let neighborEnabled = true;
  selection.setNeighborProvider((indices, selfSubs) => {
    if (!neighborEnabled || nonBulkPoints.length > NEIGHBOR_CANDIDATE_CAP) {
      return { subgroups: [], indices: [] };
    }
    const positions = positionAttr.array as Float32Array;
    const subs = neighborSubgroups(
      positions,
      indices,
      nonBulkPoints,
      subgroupOfPoint,
      selfSubs,
      neighborRadius,
    );
    const nIdx: number[] = [];
    for (const s of subs) for (const p of selection.subgroupIndices(s)) nIdx.push(p);
    return { subgroups: subs, indices: nIdx };
  });

  // -- classification sidebar (in-webview surface) -----------------------------
  const zoomTo = (indices: number[]): void => {
    const b = selectionBounds(positionAttr.array as Float32Array, indices);
    if (!b) return;
    const center = new THREE.Vector3(b.center[0], b.center[1], b.center[2]);
    const fov = (camera.fov * Math.PI) / 180;
    const dist = Math.max(b.radius, sceneSize * 0.02) / Math.sin(fov / 2) * 1.4;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    animateCameraTo(center.clone().addScaledVector(dir, dist), center);
  };
  const sidebar = document.getElementById("sidebar");
  if (sidebar) {
    mountSidebar(sidebar, buildTree(header), selection, {
      onZoom: (kind, id) => {
        const idx = kind === "subgroup"
          ? selection.subgroupIndices(id)
          : gatherGroupIndices(header, id);
        zoomTo(idx);
      },
    });
  }

  // -- selection overlay + bulk toggle -----------------------------------------
  // The selection readout is rendered once, by the sidebar (.sel-readout); this
  // subscription only drives the 3D highlight overlays (4.6 C: no duplicate).
  selection.subscribe((snap: SelectionSnapshot) => {
    updateOverlay(parts.selectionIndex, parts.selectionGeo, snap.indices);
    updateOverlay(parts.neighborIndex, parts.neighborGeo, snap.neighborIndices);
  });

  const bulkBtn = document.getElementById("bulk-toggle") as HTMLButtonElement | null;
  const refreshBulkBtn = () => {
    if (!bulkBtn) return;
    if (!rep.hasBulk) {
      bulkBtn.style.display = "none";
      return;
    }
    bulkBtn.textContent = rep.bulkShown ? "hide bulk" : "show bulk";
  };
  refreshBulkBtn();
  bulkBtn?.addEventListener("click", () => {
    rep.toggleBulk();
    refreshBulkBtn();
  });

  // -- picking + camera keys ---------------------------------------------------
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
  // Distinguish a click (select) from a click-drag (orbit) by a movement
  // threshold, so orbiting the camera never paints a selection (A1). Double-click
  // (within time + proximity) zooms to the picked subgroup.
  const CLICK_MOVE_THRESHOLD = 5; // px; more movement than this is a camera drag
  const DOUBLE_CLICK_MS = 300;
  let pointerDown: { x: number; y: number } | null = null;
  let lastClick = { t: 0, x: 0, y: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointerDown = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  // pointerup on window so it still fires if the control captured the pointer.
  window.addEventListener("pointerup", (e) => {
    const down = pointerDown;
    pointerDown = null;
    if (e.button !== 0 || !down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_MOVE_THRESHOLD) {
      return; // it was a drag (orbit/pan) — select nothing
    }
    const now = performance.now();
    const isDouble =
      now - lastClick.t < DOUBLE_CLICK_MS &&
      Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 8;
    lastClick = { t: now, x: e.clientX, y: e.clientY };
    const idx = pickAt(e.clientX, e.clientY);
    if (idx < 0) {
      // Double-click on empty space backs the camera out to whole-scene framing
      // (4.6 B1); a single click on empty space clears the selection.
      if (isDouble) resetCamera();
      else selection.clear();
      return;
    }
    selection.selectPoint(idx);
    if (isDouble) zoomTo(selection.current.indices);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "b" || e.key === "B") {
      rep.toggleBulk();
      refreshBulkBtn();
    } else if (e.key === "n" || e.key === "N") {
      neighborEnabled = !neighborEnabled;
      // Recompute the current selection so the overlay reflects the toggle.
      const d = selection.current.descriptor;
      if (d.kind === "subgroup") selection.selectSubgroup(d.id);
      else if (d.kind === "group") selection.selectGroup(d.id);
      else if (d.kind === "category") selection.selectCategory(d.id);
    } else if (e.key === "Escape") {
      selection.clear();
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
    // Bulk-internal edges track the bulk toggle (only once a frame is shown).
    if (parts.bulkEdges) parts.bulkEdges.visible = displayedFrame >= 0 && rep.bulkShown;
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
      selection,
      rep,
      applyResize,
      setPlaying,
      zoomToSelection: () => zoomTo(selection.current.indices),
      resetCamera,
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

/** Copy selected indices into an overlay's index buffer and set its draw range. */
function updateOverlay(
  indexAttr: THREE.BufferAttribute,
  geo: THREE.BufferGeometry,
  indices: number[],
): void {
  const arr = indexAttr.array as Uint32Array;
  const count = Math.min(indices.length, arr.length);
  for (let i = 0; i < count; i++) arr[i] = indices[i];
  indexAttr.needsUpdate = true;
  geo.setDrawRange(0, count);
}

function gatherGroupIndices(header: Header, groupId: number): number[] {
  const out: number[] = [];
  const g = header.points.group_id;
  for (let p = 0; p < g.length; p++) if (g[p] === groupId) out.push(p);
  return out;
}

main().catch((err) => {
  console.error("[viewer]", err);
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
