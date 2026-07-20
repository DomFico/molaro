/**
 * E2E driver — test infrastructure, not product code.
 *
 * Drives the REAL webview bundle over the REAL producer through Chrome's
 * DevTools Protocol so interaction/rendering bugs (which unit tests can't see)
 * can be scripted and screenshotted. One process owns the whole stack:
 *
 *   this driver ─spawns→ bridge.ts (ProducerBroker + serve.py)
 *              ─spawns→ headless Chrome (SwiftShader WebGL)
 *              ─CDP───→ real mouse events, resize, JS eval, PNG capture
 *
 * Uses Node's built-in WebSocket to speak CDP (flatten mode: one browser socket,
 * every command tagged with the page sessionId). No puppeteer dependency.
 *
 * SwiftShader (`--enable-unsafe-swiftshader --use-angle=swiftshader`) is what
 * makes the 3D canvas actually composite in headless; without it only the HTML
 * HUD renders.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function poll(fn: () => Promise<boolean>, tries = 100, gapMs = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(gapMs);
  }
  return false;
}
// -- E2E_PROFILE=1: dynamic wall-clock accounting (harness-speed work) --------
// Tallies every sleep by CALL SITE (the textual sleep total wildly understates
// helper-multiplied sleeps) and every CDP send by method with its await time.
// Prints a summary on process exit, to stderr. Inert without the env flag.
const PROFILE = process.env.E2E_PROFILE === "1";
const profSleeps = new Map<string, { n: number; ms: number }>();
const profSends = new Map<string, { n: number; ms: number }>();
function profBump(map: Map<string, { n: number; ms: number }>, key: string, ms: number): void {
  const e = map.get(key) ?? { n: 0, ms: 0 };
  e.n++;
  e.ms += ms;
  map.set(key, e);
}
if (PROFILE) {
  process.on("exit", () => {
    const dump = (title: string, map: Map<string, { n: number; ms: number }>): void => {
      let total = 0;
      for (const e of map.values()) total += e.ms;
      console.error(`\n== E2E_PROFILE: ${title} — total ${Math.round(total)}ms ==`);
      const rows = [...map.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25);
      for (const [k, e] of rows) console.error(`  ${Math.round(e.ms)}ms  (${e.n}x)  ${k}`);
    };
    dump("sleep by call site", profSleeps);
    dump("CDP send by method", profSends);
  });
}

export function sleep(ms: number): Promise<void> {
  if (PROFILE) {
    // frame 0 = Error, 1 = this fn, 2 = the caller — the site we attribute to
    const site = (new Error().stack ?? "").split("\n")[2]?.trim().replace(/^at\s+/, "") ?? "?";
    profBump(profSleeps, site, ms);
  }
  return new Promise((r) => setTimeout(r, ms));
}

export interface DriverOptions {
  bridgePort: number;
  cdpPort: number;
  width: number;
  height: number;
  producerArgs: string[]; // e.g. ["--n-points","8000","--n-frames","200"] or ["--system", id]
  python?: string;
  corpusRoot?: string;
  route?: string; // default "/"
}

export class E2EDriver {
  private bridge: ChildProcess | null = null;
  private chrome: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private sessionId = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private readonly events = new Map<string, ((params: any) => void)[]>();
  private bridgeLog = "";
  readonly opts: DriverOptions;

  constructor(opts: DriverOptions) {
    this.opts = opts;
  }

  /** Accumulated bridge+producer stderr (for asserting clear error messages). */
  get log(): string {
    return this.bridgeLog;
  }

  async start(): Promise<void> {
    await this.startBridge();
    await this.startChrome();
    await this.connectCdp();
  }

  private async startBridge(): Promise<void> {
    const o = this.opts;
    const args = [
      join(root, "tests", "bridge.ts"),
      "--port", String(o.bridgePort),
      ...o.producerArgs,
    ];
    if (o.python) args.push("--python", o.python);
    this.bridge = spawn("node", args, {
      cwd: root,
      env: { ...process.env, ...(o.corpusRoot ? { VIEWER_CORPUS_ROOT: o.corpusRoot } : {}) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.bridge.stderr?.on("data", (d: Buffer) => {
      this.bridgeLog += d.toString();
    });
    const up = await poll(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${o.bridgePort}/`);
        return r.ok;
      } catch {
        return false;
      }
    });
    if (!up) throw new Error("bridge did not come up");
  }

  private async startChrome(): Promise<void> {
    const o = this.opts;
    // Under peak parallel load chrome's cold start + SwiftShader init can
    // exceed one CDP-poll window (a recurring 0/0 scenario failure, twice
    // seen across the harness-chapter lanes). This is process-startup
    // jitter, not a test assertion — so recover from it: one respawn with
    // a FRESH user-data-dir (a stale lock is the other cause). Touches no
    // check; a genuinely-broken chrome still fails after the retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      const dataDir = `/tmp/cdp-${o.cdpPort}-${attempt}`;
      this.chrome = spawn(
        "google-chrome",
        [
          "--headless=new",
          "--no-sandbox",
          `--remote-debugging-port=${o.cdpPort}`,
          `--user-data-dir=${dataDir}`,
          "--enable-unsafe-swiftshader",
          "--use-angle=swiftshader",
          "--hide-scrollbars",
          `--window-size=${o.width},${o.height}`,
          "about:blank",
        ],
        { env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" }, stdio: "ignore" },
      );
      const up = await poll(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${o.cdpPort}/json/version`);
          return r.ok;
        } catch {
          return false;
        }
      });
      if (up) return;
      this.chrome?.kill("SIGKILL"); // free the port before the next attempt
      await sleep(500);
    }
    throw new Error("chrome CDP did not come up (after one respawn)");
  }

  private async connectCdp(): Promise<void> {
    const o = this.opts;
    const ver = await (await fetch(`http://127.0.0.1:${o.cdpPort}/json/version`)).json();
    const browserWs: string = ver.webSocketDebuggerUrl;
    this.ws = new WebSocket(browserWs);
    await new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => resolve(), { once: true });
      this.ws!.addEventListener("error", (e) => reject(e), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));

    const target = await this.sendBrowser("Target.createTarget", { url: "about:blank" });
    const attach = await this.sendBrowser("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    this.sessionId = attach.sessionId;

    await this.send("Page.enable", {});
    await this.send("Runtime.enable", {});
    await this.send("DOM.enable", {});
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: o.width,
      height: o.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  private onMessage(data: string): void {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      for (const fn of this.events.get(msg.method) ?? []) fn(msg.params);
    }
  }

  private raw(payload: object): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, ...payload }));
    });
  }

  private sendBrowser(method: string, params: object): Promise<any> {
    return this.raw({ method, params });
  }

  send(method: string, params: object): Promise<any> {
    if (!PROFILE) return this.raw({ sessionId: this.sessionId, method, params });
    const t0 = performance.now();
    return this.raw({ sessionId: this.sessionId, method, params }).finally(() => {
      profBump(profSends, method, performance.now() - t0);
    });
  }

  on(method: string, fn: (params: any) => void): void {
    const arr = this.events.get(method) ?? [];
    arr.push(fn);
    this.events.set(method, arr);
  }

  // -- high-level helpers -----------------------------------------------------

  async navigate(route = this.opts.route ?? "/"): Promise<void> {
    const url = `http://127.0.0.1:${this.opts.bridgePort}${route}`;
    const loaded = new Promise<void>((resolve) => this.on("Page.loadEventFired", () => resolve()));
    await this.send("Page.navigate", { url });
    await Promise.race([loaded, sleep(4000)]);
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("eval error: " + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value as T;
  }

  async mouse(
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    x: number,
    y: number,
    opts: { buttons?: number; clickCount?: number; button?: "left" | "right" | "none"; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? (type === "mouseMoved" && !opts.buttons ? "none" : "left");
    const defaultButtons = button === "right" ? 2 : 1;
    await this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button,
      buttons: opts.buttons ?? (type === "mouseReleased" ? 0 : defaultButtons),
      clickCount: opts.clickCount ?? (type === "mouseMoved" ? 0 : 1),
      modifiers: opts.modifiers ?? 0,
    });
  }

  /** A click: down then up at the same spot (no movement). CTRL = modifiers: 2. */
  async click(x: number, y: number, clickCount = 1, modifiers = 0): Promise<void> {
    await this.mouse("mousePressed", x, y, { clickCount, modifiers });
    await this.mouse("mouseReleased", x, y, { clickCount, modifiers });
  }

  /** A right-click: right-button down/up (fires contextmenu). */
  async rightClick(x: number, y: number, modifiers = 0): Promise<void> {
    await this.mouse("mousePressed", x, y, { button: "right", modifiers });
    await this.mouse("mouseReleased", x, y, { button: "right", modifiers });
  }

  /** A double-click: two down/up pairs back-to-back (well under the recognizer's
   * 300ms window since there are no sleeps between events). */
  async doubleClick(x: number, y: number): Promise<void> {
    await this.mouse("mousePressed", x, y, { clickCount: 1 });
    await this.mouse("mouseReleased", x, y, { clickCount: 1 });
    await this.mouse("mousePressed", x, y, { clickCount: 2 });
    await this.mouse("mouseReleased", x, y, { clickCount: 2 });
  }

  /** A drag: down, several moves, up. `modifiers: 2` = Ctrl (paint gestures);
   * `button: "right"` drags with the right button. */
  async drag(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    steps = 8,
    opts: { button?: "left" | "right"; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? "left";
    const buttons = button === "right" ? 2 : 1;
    const modifiers = opts.modifiers ?? 0;
    await this.mouse("mousePressed", x0, y0, { clickCount: 1, button, buttons, modifiers });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.mouse("mouseMoved", x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, {
        buttons,
        modifiers,
      });
    }
    await this.mouse("mouseReleased", x1, y1, { clickCount: 1, button, modifiers });
  }

  /** A mouse-wheel tick at (x,y); `buttons: 1` = while left button held. */
  async wheel(x: number, y: number, deltaY: number, buttons = 0): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY,
      buttons,
      modifiers: 0,
    });
  }

  /** A key tap (keydown+keyup). `modifiers: 2` = Ctrl. */
  async key(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  async escape(): Promise<void> {
    await this.key("Escape", "Escape", 27);
  }

  async ctrlZ(): Promise<void> {
    await this.key("z", "KeyZ", 90, 2);
  }

  /** Type text into the focused element (for inline rename inputs). */
  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async resize(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.evaluate("window.dispatchEvent(new Event('resize'))");
  }

  /** Poll an in-page expression until truthy — a CONDITION wait, not a sleep:
   * returns the moment the condition holds; throws after timeoutMs (generous
   * caps only — the timeout is a failure detector, never a disguised sleep). */
  async waitFor(expr: string, timeoutMs = 15000): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      if (await this.evaluate<boolean>(`!!(${expr})`)) return;
      if (performance.now() - t0 > timeoutMs) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms: ${expr}`);
      }
      await sleep(100);
    }
  }

  async screenshot(path: string): Promise<Buffer> {
    // EVIDENCE GATE: every d.screenshot() call in the suite is a bare await —
    // its Buffer is never consumed by an assertion (grep-proven; the assertion
    // path is captureB64, which this gate never touches). E2E_EVIDENCE=0 skips
    // the capture entirely (a capture can cost 6–172s queued behind a starved
    // render loop). UNSET means capture: full evidence is the DEFAULT and the
    // fast lane opts out explicitly — never make "less evidence" the thing you
    // get by forgetting a variable. Assertion outcomes are identical either
    // way, by construction.
    if (process.env.E2E_EVIDENCE === "0") return Buffer.alloc(0);
    return Buffer.from(await this.captureB64(path), "base64");
  }

  /** Capture a PNG, write it to `path`, and return its base64 (for pixel checks). */
  async captureB64(path: string): Promise<string> {
    const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return r.data;
  }

  /**
   * THE PROBE PRIMITIVE (harness chapter, item 1) — in-page capture.
   *
   * The family defect it removes: A BOUNDED ENVELOPE SAMPLED THROUGH
   * UNBOUNDED HOPS. A pulse/flash/pose exists for a fixed window (e.g. the
   * 900ms focus flash); sampling it via captureB64 puts a CDP round-trip +
   * compositor + PNG encode INSIDE that window, and that latency grows
   * with bundle size (measured: S32 HEAD 5/5 vs figure-tree 2/5, same
   * window — FLAKE_LEDGER.md bisect #3). Here the whole confirm-envelope →
   * locate → read-pixels → classify sequence runs inside ONE Runtime.evaluate,
   * so the unbounded hop sits AROUND the envelope, never inside it. The
   * logged fallback for probes whose envelope this cannot reach is
   * envelope-hold (re-arm until sampled) — rejected as the primitive
   * because re-arming changes product behavior under test.
   *
   * Requires the harness boot flag `screenshotMode: true` (bridge.ts
   * injects it on every page) → preserveDrawingBuffer on the WebGL
   * context, so the canvas holds the last rendered frame and is
   * drawImage-readable at any instant. Zero product change: the flag and
   * the debug seams predate this primitive.
   *
   * Two modes:
   * - SINGLE (no `sweep`): read the patch NOW — one atomic locate+read+
   *   classify for steady states (the caller settles frames first).
   * - SWEEP (`sweep` given): tick with requestAnimationFrame for
   *   `windowMs`, evaluate `strengthExpr` at each tick, and read the
   *   patch AT the max-strength tick — synchronously in that tick's
   *   task. Correctness rests on a consistency invariant, not on tick
   *   timing: the pulse uniform and the drawing buffer are both written
   *   in the SAME render task and both persist unchanged between
   *   renders, so every (strength, patch) pair this reads is mutually
   *   consistent — the strength describes exactly the frame the pixels
   *   came from. (In the harness, rAF is bridge.ts's 16ms setTimeout
   *   shim and the render loop runs on the same shim, so ticks and
   *   renders share cadence and starve together; in a real webview rAF
   *   ticks once per presented frame. Either way the invariant holds.)
   *   A bounded pulse (900ms flash, 1600ms breathing tint) whose frames
   *   rendered cannot be missed: the old probes sampled a handful of
   *   uncontrolled instants through CDP hops and hoped; this tracks the
   *   supremum of what was actually drawn and visible. `strength` (peak
   *   observed) and `frames` (ticks seen) return with the count — put
   *   them in the check detail so every run logs its tally. frames === 0
   *   means the page loop starved the whole window (a 1s no-tick bail
   *   prevents a hang).
   *
   * - `centerExpr`: in-page JS yielding { x, y } in CSS px (client
   *   coords, e.g. debug.projectPoint) — evaluated in the SAME task as
   *   each read, so a moving projection cannot drift between locate and
   *   sample.
   * - `classify`: a boolean expression over pixel bytes r, g, b, a.
   * - The drawing buffer may differ from CSS px (DPR / renderer pixel
   *   ratio); the patch is mapped through canvas.width / boundingRect,
   *   so counts stay in CSS-px units (the historical thresholds hold).
   */
  async samplePatch(opts: {
    centerExpr: string;
    half: number;
    classify: string;
    sweep?: { strengthExpr: string; windowMs: number; minStrength?: number };
    canvasSelector?: string;
  }): Promise<{ count: number; strength: number; frames: number; seen: number }> {
    const sel = JSON.stringify(opts.canvasSelector ?? "#app canvas");
    const body = opts.sweep
      ? `let best = -1, count = -1, frames = 0, seen = -1;
         const t0 = performance.now();
         while (performance.now() - t0 < ${opts.sweep.windowMs}) {
           // the 1s timeout only keeps a dead page from hanging the evaluate;
           // a single starvation gap must NOT end the sweep — the window
           // clock is the sole bound
           const drew = await new Promise(res => {
             const t = setTimeout(() => res(false), 1000);
             requestAnimationFrame(() => { clearTimeout(t); res(true); });
           });
           if (!drew) continue;
           frames++;
           const s = (${opts.sweep.strengthExpr});
           if (s > seen) seen = s;
           // readPatch forces a GL readback — under SwiftShader that flush
           // can stall the page >1s and eat the whole window. Pay it ONLY
           // for frames that could satisfy the caller's strength gate
           // (minStrength), so the sweep rides the pulse's rise at full
           // tick rate instead of stalling on every ascent.
           if (s > best && s >= ${opts.sweep.minStrength ?? 0}) {
             best = s; count = readPatch();
           }
         }
         return { count, strength: best, frames, seen };`
      : `return { count: readPatch(), strength: -1, frames: 0, seen: -1 };`;
    return this.evaluate<{ count: number; strength: number; frames: number; seen: number }>(`(async () => {
      const src = document.querySelector(${sel});
      if (!src) throw new Error("samplePatch: no canvas at " + ${sel});
      const half = ${opts.half}, side = half * 2;
      const readPatch = () => {
        const rect = src.getBoundingClientRect();
        const kx = src.width / rect.width, ky = src.height / rect.height;
        const ctr = (${opts.centerExpr});
        const c = document.createElement('canvas');
        c.width = side; c.height = side;
        const ctx = c.getContext('2d');
        ctx.drawImage(src,
          (ctr.x - rect.left - half) * kx, (ctr.y - rect.top - half) * ky,
          side * kx, side * ky, 0, 0, side, side);
        const px = ctx.getImageData(0, 0, side, side).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
          if (${opts.classify}) n++;
        }
        return n;
      };
      ${body}
    })()`);
  }

  async dispose(): Promise<void> {
    try {
      this.ws?.close();
    } catch {}
    this.chrome?.kill("SIGKILL");
    this.bridge?.kill("SIGTERM");
    await sleep(200);
    this.bridge?.kill("SIGKILL");
  }
}

/** Mean luminance (0..255) of a PNG's pixels — a cheap "is this frame white?"
 * check. Decodes via an offscreen canvas in the page to avoid a PNG lib. */
export async function meanLuminance(driver: E2EDriver, pngBase64: string): Promise<number> {
  return driver.evaluate(`(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${pngBase64}"; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i+1] + d[i+2]) / 3;
    return sum / n;
  })()`);
}
