/**
 * Webview renderer — Increment 2: live streaming + playback.
 *
 * Data now arrives from the live producer through the host relay (no fixture
 * files): a Header request up front, then FrameChunk requests driven by the
 * StreamingPlayer's prefetch window. Each displayed frame is swapped into the
 * one existing position BufferAttribute as a zero-copy subarray view over the
 * received chunk bytes — no per-frame allocation or copy. Edge/polyline
 * geometries share that same attribute.
 *
 * Look stays flat; channel values are still never read.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import {
  decodeFrameChunk,
  parseHeader,
  validateFrameChunk,
  type FrameChunk,
  type Header,
} from "../contract/contract.ts";
import { computeBounds, edgeSegmentIndices, polylineSegmentIndices } from "./geometry.ts";
import { StreamingPlayer } from "./playback.ts";
import { Transport, rejectIfErrorPayload } from "./transport.ts";

// Playback + backpressure tuning (see playback.ts for the policy).
const PLAYBACK_FPS = 30;
const CHUNK_FRAMES = 8;
const LOOKAHEAD_CHUNKS = 2;
const MAX_IN_FLIGHT = 2;
const MAX_CACHE_BYTES = 256 * 1024 * 1024;

const POINT_COLOR = 0xd4d4d4;
const EDGE_COLOR = 0x5a7a9a;
const POLYLINE_COLOR = 0x9a7a5a;
const BACKGROUND = 0x1e1e1e;

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface ViewerConfig {
  autoplay?: boolean;
  statsLog?: boolean;
  /** Harness aid: keep the drawing buffer for end-of-run screenshots. */
  screenshotMode?: boolean;
}

function setStatus(text: string): void {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

interface SceneParts {
  scene: THREE.Scene;
  positionAttr: THREE.BufferAttribute;
  drawables: THREE.Object3D[];
}

function buildScene(header: Header): SceneParts {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);

  // Placeholder until the first chunk arrives; every displayed frame swaps a
  // zero-copy view into this same attribute.
  const positionAttr = new THREE.BufferAttribute(new Float32Array(header.n_points * 3), 3);
  positionAttr.setUsage(THREE.DynamicDrawUsage);

  const drawables: THREE.Object3D[] = [];
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", positionAttr);
  drawables.push(
    new THREE.Points(
      pointsGeo,
      new THREE.PointsMaterial({ color: POINT_COLOR, size: 3, sizeAttenuation: false }),
    ),
  );
  if (header.edges.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setIndex(new THREE.BufferAttribute(edgeSegmentIndices(header.edges), 1));
    drawables.push(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: EDGE_COLOR })));
  }
  if (header.polylines.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", positionAttr);
    geo.setIndex(new THREE.BufferAttribute(polylineSegmentIndices(header.polylines), 1));
    drawables.push(
      new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: POLYLINE_COLOR })),
    );
  }
  for (const obj of drawables) {
    // Positions change every frame; skip per-frame bounds work.
    obj.frustumCulled = false;
    obj.visible = false; // until the first frame is displayed
    scene.add(obj);
  }
  return { scene, positionAttr, drawables };
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
  return { camera, target: center };
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
  container.appendChild(renderer.domElement);

  const { scene, positionAttr, drawables } = buildScene(header);
  const { camera, target } = frameCamera(header, container.clientWidth / container.clientHeight);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.update();
  window.addEventListener("resize", () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });

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

  // --- controls ---------------------------------------------------------------
  const playBtn = document.getElementById("playpause") as HTMLButtonElement;
  const scrubber = document.getElementById("scrubber") as HTMLInputElement;
  const readout = document.getElementById("readout") as HTMLSpanElement;
  scrubber.max = String(nFrames - 1);
  playBtn.disabled = false;
  scrubber.disabled = false;
  const setPlaying = (on: boolean) => {
    if (on) player.play();
    else player.pause();
    playBtn.textContent = on ? "pause" : "play";
  };
  playBtn.addEventListener("click", () => setPlaying(!player.playing));
  scrubber.addEventListener("input", () => player.seek(Number(scrubber.value)));

  // --- display loop -------------------------------------------------------------
  let displayedFrame = -1;
  let shownSinceMark = 0;
  let fpsMarkMs = performance.now();
  let displayFps = 0;

  const displayFrame = (f: number): boolean => {
    const chunk = player.getFrame(f);
    if (!chunk) return false;
    const offset = (f - chunk.start) * header.n_points * 3;
    // Zero-copy swap: point the shared attribute at this frame's slice of the
    // received chunk buffer and re-upload. No allocation, no copy.
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
      if (displayFrame(player.frame) && !scrubberActive()) {
        scrubber.value = String(player.frame);
      }
    }
    if (now - fpsMarkMs >= 1000) {
      displayFps = (shownSinceMark * 1000) / (now - fpsMarkMs);
      shownSinceMark = 0;
      fpsMarkMs = now;
      const s = player.stats();
      readout.textContent =
        `frame ${player.frame}/${nFrames - 1} · ${displayFps.toFixed(0)} fps · ` +
        `cache ${(s.cacheBytes / 1e6).toFixed(0)}MB/${s.cachedChunks}ch · ` +
        `inflight ${s.inFlight} · stalls ${s.stalls}`;
    }
    controls.update();
    renderer.render(scene, camera);
  });

  const scrubberActive = () => document.activeElement === scrubber;

  setStatus(
    `${header.name} — N=${header.n_points}, T=${nFrames} · ` +
      `${header.edges.length} edges, ${header.polylines.length} polylines · live producer stream`,
  );

  if (cfg.autoplay) setPlaying(true);
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

main().catch((err) => {
  console.error("[viewer]", err);
  setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
});
