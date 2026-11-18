/**
 * OUTLINES — comic-book ink lines from depth discontinuities (`outline on`).
 *
 * SILO. Off by default; with it off the viewer draws exactly as before. When on,
 * the SOLID scene is drawn into an offscreen target that keeps its depth, and a
 * full-screen pass copies it to the real target while:
 *   - inking any pixel whose neighbourhood (a ring at the line's half-width)
 *     crosses the background — the silhouette, drawn OUTSIDE the shape, so a
 *     transparent screenshot keeps its outline;
 *   - inking depth jumps larger than the crease threshold — helix in front of
 *     sheet, a side chain over the ribbon, each sphere's rim;
 *   - writing depth back, so translucent layers drawn afterwards (ghosts) still
 *     sort against the solid copy. Translucent geometry writes no depth, so it
 *     is never outlined (ghosts stay soft).
 *
 * The impostor passes write true per-fragment depth (gl_FragDepth), so spheres,
 * tubes, ribbons and produced edges all outline from one depth image.
 */

import * as THREE from "three";

export interface OutlineOptions {
  /** Line half-width in CSS pixels at the on-screen size (scaled for screenshots). */
  width: number;
  /** Ink colour, sRGB 0-1. */
  color: [number, number, number];
  /** Crease threshold in world units: a depth jump larger than this is inked. */
  crease: number;
}

export const OUTLINE_DETAIL: Record<string, number> = { low: 12, medium: 6, high: 3 };
export const OUTLINE_DEFAULT_WIDTH = 1.5;

export const OUTLINE_USAGE =
  "outline on|off ?width=1.5 ?color=#1a1a1a ?detail=low|medium|high — e.g. outline on ?width=3, outline off";

export function parseOutlineArgs(args: string): (
  | { kind: "off" } | { kind: "show" }
  | { kind: "on"; width: number; color: string; detail: string }
  | { kind: "error"; message: string }
) {
  const t = args.trim().split(/\s+/).filter((x) => x !== "");
  if (t.length === 0) return { kind: "show" };
  const head = t[0].toLowerCase();
  if (head === "off") return t.length === 1 ? { kind: "off" } : { kind: "error", message: `outline off takes no options — ${OUTLINE_USAGE}` };
  let width = OUTLINE_DEFAULT_WIDTH, color = "#1a1a1a", detail = "medium";
  const opts = head === "on" ? t.slice(1) : t;
  for (const o of opts) {
    const m = /^\?([a-z]+)=(.+)$/i.exec(o);
    if (!m) return { kind: "error", message: `outline: "${o}" is not ?key=value — ${OUTLINE_USAGE}` };
    const [, k, v] = m;
    if (k === "width") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 20) return { kind: "error", message: `outline: ?width must be in (0, 20], got "${v}"` };
      width = n;
    } else if (k === "color") color = v;
    else if (k === "detail") {
      if (!(v.toLowerCase() in OUTLINE_DETAIL)) return { kind: "error", message: `outline: ?detail must be low, medium or high, got "${v}"` };
      detail = v.toLowerCase();
    } else return { kind: "error", message: `outline: unknown option ?${k} — ${OUTLINE_USAGE}` };
  }
  return { kind: "on", width, color, detail };
}

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uRadius;   // device px
uniform vec3 uInk;
uniform float uNear;
uniform float uFar;
uniform float uCrease;   // world units
uniform vec4 uBg;        // rgb = background (raw sRGB), a = 1 to composite over it, 0 = keep transparency
varying vec2 vUv;
float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
void main() {
  vec4 c = texture2D(tColor, vUv);
  float d0 = texture2D(tDepth, vUv).r;
  bool bg0 = d0 >= 1.0;
  float z0 = bg0 ? 0.0 : lin(d0);
  float nearest = d0;
  bool ink = false;
  for (int ring = 0; ring < 2; ring++) {
    float r = ring == 0 ? uRadius : max(1.0, uRadius * 0.5);
    // four opposite PAIRS: a tilted flat surface changes depth linearly, so
    // (zA + zB - 2 z0) ~ 0 across it and it is never inked; a real step (one
    // shape in front of another) breaks that and the far side gets the ink
    for (int i = 0; i < 4; i++) {
      float a = float(i) * 0.78539816;
      vec2 o = vec2(cos(a), sin(a)) * r * uTexel;
      float dA = texture2D(tDepth, vUv + o).r;
      float dB = texture2D(tDepth, vUv - o).r;
      bool bgA = dA >= 1.0;
      bool bgB = dB >= 1.0;
      if (bg0) {
        // silhouette: ink only the BACKGROUND side, so thin sticks and small
        // spheres keep their colour and get a ring outside them
        if (!bgA) { ink = true; nearest = min(nearest, dA); }
        if (!bgB) { ink = true; nearest = min(nearest, dB); }
        continue;
      }
      if (bgA || bgB) continue;
      float zA = lin(dA);
      float zB = lin(dB);
      float zn = min(zA, zB);
      if (z0 - zn > uCrease && abs(zA + zB - 2.0 * z0) > uCrease) {
        ink = true;
        nearest = min(nearest, zA < zB ? dA : dB);
      }
    }
  }
  if (ink) {
    gl_FragColor = vec4(uInk, 1.0);
    gl_FragDepth = nearest;
  } else {
    // the solid pass was cleared TRANSPARENT (premultiplied); lay it over the
    // background here, in the same raw sRGB the canvas clear would have used
    gl_FragColor = uBg.a > 0.5 ? vec4(c.rgb + uBg.rgb * (1.0 - c.a), 1.0) : c;
    gl_FragDepth = d0;
  }
}
`;

export class OutlinePass {
  enabled = false;
  opts: OutlineOptions = { width: OUTLINE_DEFAULT_WIDTH, color: [0.1, 0.1, 0.1], crease: 1 };
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
        // uInk is raw sRGB, like every colour in this viewer's shaders
        uRadius: { value: 2 }, uInk: { value: new THREE.Vector3() }, uNear: { value: 0.1 }, uFar: { value: 100 },
        uCrease: { value: 1 }, uBg: { value: new THREE.Vector4() },
      },
      depthTest: false,
      depthWrite: true,
      blending: THREE.NoBlending,
      transparent: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  private target(w: number, h: number, samples: number): THREE.WebGLRenderTarget {
    if (this.rt && this.rt.width === w && this.rt.height === h) return this.rt;
    this.rt?.dispose();
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.rt = new THREE.WebGLRenderTarget(w, h, { samples, depthTexture, depthBuffer: true });
    return this.rt;
  }

  /**
   * Draw the solid scene with ink into the CURRENT render target (null = the
   * canvas). `pxScale` multiplies the line width (device px per CSS px, times
   * the screenshot's resolution factor).
   */
  render(
    renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, pxScale: number,
    /** raw sRGB 0-1 background to composite over, or null to keep transparency (screenshots) */
    background: [number, number, number] | null,
  ): void {
    const final = renderer.getRenderTarget();
    const size = final ? new THREE.Vector2(final.width, final.height) : renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = this.target(size.x, size.y, Math.min(4, renderer.capabilities.maxSamples));
    // Clear TRANSPARENT: a Color background would be cleared through colour
    // management into this linear target and come back too dark.
    const sceneBg = scene.background;
    const clear = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(final);
    scene.background = sceneBg;
    renderer.setClearColor(clear, clearAlpha);
    const u = this.mat.uniforms;
    u.tColor.value = rt.texture;
    u.tDepth.value = rt.depthTexture;
    (u.uTexel.value as THREE.Vector2).set(1 / size.x, 1 / size.y);
    u.uRadius.value = Math.max(1, this.opts.width * pxScale);
    (u.uInk.value as THREE.Vector3).set(this.opts.color[0], this.opts.color[1], this.opts.color[2]);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uCrease.value = this.opts.crease;
    if (background) (u.uBg.value as THREE.Vector4).set(background[0], background[1], background[2], 1);
    else (u.uBg.value as THREE.Vector4).set(0, 0, 0, 0);
    const autoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.render(this.quadScene, this.quadCam);
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
  }
}
