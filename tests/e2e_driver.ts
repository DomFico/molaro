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
export function sleep(ms: number): Promise<void> {
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
    this.chrome = spawn(
      "google-chrome",
      [
        "--headless=new",
        "--no-sandbox",
        `--remote-debugging-port=${o.cdpPort}`,
        `--user-data-dir=/tmp/cdp-${o.cdpPort}`,
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
    if (!up) throw new Error("chrome CDP did not come up");
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
    return this.raw({ sessionId: this.sessionId, method, params });
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

  async screenshot(path: string): Promise<Buffer> {
    return Buffer.from(await this.captureB64(path), "base64");
  }

  /** Capture a PNG, write it to `path`, and return its base64 (for pixel checks). */
  async captureB64(path: string): Promise<string> {
    const r = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, "base64"));
    return r.data;
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
