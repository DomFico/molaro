/**
 * Impostor depth-variant measurement — test infrastructure, not product code.
 *
 * Drives the PACKAGED extension in a REAL VS Code workbench (isolated
 * profile) over CDP and reports frame-time statistics for BOTH impostor
 * depth variants (1 = flat sprite depth / early-Z preserved, 2 = analytic
 * gl_FragDepth / early-Z lost), at each requested scale, at the default
 * point size and at two enlarged sizes where fill rate dominates.
 *
 * It reports numbers; it makes NO decision — the variant choice is made
 * outside this lane, on real-hardware runs of this script. Run it on the
 * hardware that matters; a SwiftShader/llvmpipe machine measures the CPU
 * rasterizer, not the GPU (see ADDENDUM_01 §A1).
 *
 *   npm run package                # or: npm run build && npx vsce package …
 *   node tests/impostor_bench.ts --vsix viewer-0.1.0.vsix
 *   node tests/impostor_bench.ts --scales 6000,20000,60000 --seconds 5
 *
 * Mechanics: per variant it writes the profile's settings.json
 * (molaro.viewer.depthVariant), launches VS Code with remote debugging,
 * opens the viewer at each scale through a keybinding bound to viewer.open
 * with args, finds the viewer webview CDP target, starts playback, and
 * samples requestAnimationFrame deltas in-page. Commands reach the
 * production webview by dispatching the same {type:"command"} MessageEvent
 * the host relay delivers — no test seam is needed or used.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const platformTag =
  process.platform === "darwin"
    ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : process.platform === "win32" ? "win32-x64" : "linux-x64";
const { values: args } = parseArgs({
  options: {
    vsix: { type: "string", default: join(root, `viewer-0.1.0-${platformTag}.vsix`) },
    code: { type: "string", default: "code" },
    scales: { type: "string", default: "6000,20000,60000" },
    seconds: { type: "string", default: "4" },
    port: { type: "string", default: "9333" },
    // home-dir default: a snap-confined `code` gets a PRIVATE /tmp, so a
    // /tmp profile written by node would be invisible to it.
    profile: { type: "string", default: join(homedir(), ".molaro-bench-profile") },
  },
});
const SCALES = args.scales!.split(",").map((s) => Number(s.trim()));
const SAMPLE_MS = Number(args.seconds) * 1000;
const PORT = Number(args.port);
const USER_DIR = join(args.profile!, "user");
const EXT_DIR = join(args.profile!, "ext");

// keybindings: ctrl+alt+1..N open the viewer at each scale (viewer.open args)
const KEY_CHORDS = SCALES.map((n, i) => ({
  key: `ctrl+alt+${i + 1}`,
  code: `Digit${i + 1}`,
  keyCode: 49 + i,
  nPoints: n,
}));

interface FrameStats {
  fps: number;
  meanMs: number;
  p95Ms: number;
  frames: number;
}

// ---------------------------------------------------------------- CDP client
class Cdp {
  private ws!: WebSocket;
  private id = 1;
  private pending = new Map<number, (v: any) => void>();
  sessionId = "";

  async connect(): Promise<void> {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res(), { once: true });
      this.ws.addEventListener("error", (e) => rej(e), { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        // resolve with the RESULT payload (or null on a protocol error) so
        // callers read fields at one level, not the envelope's
        this.pending.get(m.id)?.(m.error ? null : m.result);
        this.pending.delete(m.id);
      }
    });
  }
  send(method: string, params: object, sessionId?: string): Promise<any> {
    const id = this.id++;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close(): void {
    try { this.ws.close(); } catch { /* gone */ }
  }
}

async function targets(): Promise<{ id: string; url: string; title: string; type: string; webSocketDebuggerUrl?: string }[]> {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as any[];
}

/** VS Code webviews are an OUTER index.html wrapper hosting the actual page
 * in a nested same-process iframe — so every in-page expression runs through
 * a frame walk that finds the window owning the viewer DOM. `fn` must be the
 * source of a function taking that window (async allowed). */
const inViewerFrame = (fn: string) => `(() => {
  const find = (w) => {
    try { if (w.__VIEWER__ && w.document.getElementById('app')) return w; } catch (e) {}
    for (let i = 0; i < w.frames.length; i++) {
      try { const r = find(w.frames[i]); if (r) return r; } catch (e) {}
    }
    return null;
  };
  const W = find(window);
  if (!W) throw new Error('no viewer frame');
  return (${fn})(W);
})()`;

/** Attach to the webview target that (transitively) hosts the viewer page. */
async function findViewer(cdp: Cdp): Promise<string | null> {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const t of await targets()) {
      if (!/^(vscode-webview|https?):/.test(t.url) && t.type !== "iframe" && t.type !== "page") continue;
      try {
        const at = await cdp.send("Target.attachToTarget", { targetId: t.id, flatten: true });
        const sid = at?.sessionId as string | undefined;
        if (!sid) continue;
        const r = await cdp.send("Runtime.evaluate", {
          expression: inViewerFrame(`(W) => !!W.document.getElementById('status')`),
          returnByValue: true,
        }, sid);
        if (r?.result?.value === true) return sid;
        await cdp.send("Target.detachFromTarget", { sessionId: sid }, undefined);
      } catch { /* not attachable */ }
    }
    await sleep(500);
  }
  return null;
}

async function evalIn(cdp: Cdp, sid: string, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r?.result?.value;
}

/** Dispatch a viewer command exactly as the host relay would deliver it. */
const viewerCommand = (text: string) =>
  inViewerFrame(`(W) => W.dispatchEvent(new W.MessageEvent('message', { data: { type: 'command', id: 990000, text: ${JSON.stringify(text)} } }))`);

const sampleFrames = inViewerFrame(`async (W) => {
  const deltas = [];
  let last = W.performance.now();
  const t0 = last;
  await new Promise((done) => {
    const tick = () => {
      const now = W.performance.now();
      deltas.push(now - last);
      last = now;
      if (now - t0 < ${SAMPLE_MS}) W.requestAnimationFrame(tick); else done();
    };
    W.requestAnimationFrame(tick);
  });
  deltas.sort((a, b) => a - b);
  const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  return {
    frames: deltas.length,
    meanMs: Number(mean.toFixed(2)),
    p95Ms: Number(deltas[Math.floor(deltas.length * 0.95)].toFixed(2)),
    fps: Number((1000 / mean).toFixed(1)),
  };
}`)

async function keyChord(cdp: Cdp, workbenchSid: string, chord: { code: string; keyCode: number }): Promise<void> {
  const mods = 2 | 1; // ctrl+alt
  for (const type of ["keyDown", "keyUp"] as const) {
    await cdp.send("Input.dispatchKeyEvent", {
      type, modifiers: mods, code: chord.code,
      windowsVirtualKeyCode: chord.keyCode, nativeVirtualKeyCode: chord.keyCode,
      key: String.fromCharCode(chord.keyCode),
    }, workbenchSid);
  }
}

async function workbenchSession(cdp: Cdp): Promise<string> {
  for (let i = 0; i < 60; i++) {
    for (const t of await targets()) {
      if (t.type === "page" && /vscode-file|workbench/.test(t.url)) {
        const at = await cdp.send("Target.attachToTarget", { targetId: t.id, flatten: true });
        if (at?.sessionId) return at.sessionId;
      }
    }
    await sleep(500);
  }
  throw new Error("no workbench target");
}

async function runVariant(variant: 1 | 2): Promise<Record<string, Record<string, FrameStats>>> {
  writeFileSync(join(USER_DIR, "User", "settings.json"), JSON.stringify({
    "molaro.viewer.depthVariant": variant,
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "telemetry.telemetryLevel": "off",
  }, null, 2));
  writeFileSync(join(USER_DIR, "User", "keybindings.json"), JSON.stringify(
    KEY_CHORDS.map((c) => ({
      key: c.key, command: "viewer.open", args: { nPoints: c.nPoints, nFrames: 150 },
    })), null, 2));

  const vscode: ChildProcess = spawn(args.code!, [
    "--new-window", "--user-data-dir", USER_DIR, "--extensions-dir", EXT_DIR,
    `--remote-debugging-port=${PORT}`, "--disable-workspace-trust", "--skip-welcome",
  ], { stdio: "ignore", detached: false });

  const out: Record<string, Record<string, FrameStats>> = {};
  try {
    await sleep(6000);
    const cdp = new Cdp();
    await cdp.connect();
    const wb = await workbenchSession(cdp);

    for (const chord of KEY_CHORDS) {
      await keyChord(cdp, wb, chord);
      const sid = await findViewer(cdp);
      if (!sid) throw new Error(`viewer webview target not found (N=${chord.nPoints})`);
      // wait for streaming to actually display
      await evalIn(cdp, sid, inViewerFrame(`async (W) => {
        for (let i = 0; i < 100; i++) {
          if (/frame |static/.test(W.document.getElementById('readout')?.textContent ?? '')) return;
          await new Promise(r => setTimeout(r, 200));
        }
      }`));
      await evalIn(cdp, sid, inViewerFrame(
        `(W) => { const b = W.document.getElementById('playpause'); if (b && b.textContent === 'play') b.click(); }`));
      await sleep(1500);

      // trust checks: the command relay actually executes (a `view all`
      // flashes panel rows — same dispatch path the pointsize commands take),
      // and playback actually advances (the measurement is of live frames).
      await evalIn(cdp, sid, viewerCommand("view all"));
      await sleep(250);
      const flashed = await evalIn(cdp, sid, inViewerFrame(
        `(W) => W.document.querySelectorAll('#tree-host .row-flash').length`));
      const scrub0 = await evalIn(cdp, sid, inViewerFrame(
        `(W) => W.document.getElementById('scrubber').value`));
      await sleep(700);
      const scrub1 = await evalIn(cdp, sid, inViewerFrame(
        `(W) => W.document.getElementById('scrubber').value`));
      if (!(flashed > 0)) throw new Error("command relay verification failed — `view all` flashed no rows");
      if (scrub0 === scrub1) throw new Error("playback verification failed — the playhead is not advancing");

      const scaleKey = `N=${chord.nPoints}`;
      out[scaleKey] = {};
      for (const [label, cmd] of [
        ["default size", null],
        ["pointsize all 12", "pointsize all 12"],
        ["pointsize all 30", "pointsize all 30"],
      ] as const) {
        if (cmd) {
          await evalIn(cdp, sid, viewerCommand(cmd));
          await sleep(400);
        }
        out[scaleKey][label] = (await evalIn(cdp, sid, sampleFrames)) as FrameStats;
        console.log(`  variant ${variant} · ${scaleKey} · ${label}: ` +
          `${out[scaleKey][label].fps} fps (mean ${out[scaleKey][label].meanMs}ms, p95 ${out[scaleKey][label].p95Ms}ms)`);
      }
      // close the viewer tab before the next scale
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown", modifiers: 2, code: "KeyW", key: "w",
        windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
      }, wb);
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", modifiers: 2, code: "KeyW", key: "w",
        windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
      }, wb);
      await sleep(800);
    }
    cdp.close();
  } finally {
    vscode.kill("SIGTERM");
    await sleep(1500);
    vscode.kill("SIGKILL");
  }
  return out;
}

async function main(): Promise<void> {
  // a leftover instance holding the CDP port would make this script attach
  // to the WRONG workbench and report nonsense — refuse to start over it
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`port ${PORT} already serves CDP — close the leftover VS Code instance ` +
      `(or pass a different --port) before measuring`);
  } catch (e) {
    if (e instanceof Error && /already serves/.test(e.message)) throw e;
    /* connection refused = port free, good */
  }
  rmSync(args.profile!, { recursive: true, force: true });
  mkdirSync(join(USER_DIR, "User"), { recursive: true });
  mkdirSync(EXT_DIR, { recursive: true });
  console.log(`installing ${args.vsix} into the isolated profile…`);
  execFileSync(args.code!, [
    "--user-data-dir", USER_DIR, "--extensions-dir", EXT_DIR,
    "--install-extension", resolve(args.vsix!), "--force",
  ], { stdio: "inherit" });

  const results: Record<string, unknown> = {};
  for (const variant of [1, 2] as const) {
    console.log(`\n=== depth variant ${variant} (${variant === 1 ? "flat sprite depth, early-Z kept" : "analytic gl_FragDepth, early-Z lost"}) ===`);
    results[`variant${variant}`] = await runVariant(variant);
  }

  console.log("\nJSON:");
  console.log(JSON.stringify(results, null, 2));
  console.log("\nThis script reports; it does not decide. The variant choice is made outside this lane.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
