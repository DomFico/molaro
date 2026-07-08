/**
 * Increment 4.6 validation — drives the real webview over the real producer via
 * CDP, scripts each fix, screenshots into reports/fixes_4_6/<fix>/, and asserts
 * behavior. Test infra, not product. Run from viewer/ (after `npm run build`):
 *   node tests/fixes_4_6.ts                 # all (A B1 B2 B3 C D)
 *   node tests/fixes_4_6.ts A D             # a subset
 *
 * A needs mdtraj (fixtures are generated with VIEWER_PYTHON / the mdbench env).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2EDriver, meanLuminance, sleep } from "./e2e_driver.ts";

const REPORT = "reports/fixes_4_6";
const PY = process.env.VIEWER_PYTHON ?? "/home/dom/miniforge3/envs/mdbench/bin/python";
const V = "window.__viewer";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const camPos = (d: E2EDriver) =>
  d.evaluate<[number, number, number]>(`(()=>{const p=${V}.camera.position;return [p.x,p.y,p.z];})()`);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const frameNum = (d: E2EDriver) => d.evaluate<number>(`${V}.player.frame`);
const canvasRect = (d: E2EDriver) =>
  d.evaluate<{ x: number; y: number; w: number; h: number }>(
    "(()=>{const r=document.querySelector('#app canvas').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()",
  );
const pause = (d: E2EDriver) =>
  d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p.textContent==='pause')p.click();})()`);

interface DriverArgs { bridgePort: number; cdpPort: number; producerArgs: string[]; width?: number; height?: number; }
async function withDriver<T>(a: DriverArgs, warmMs: number, fn: (d: E2EDriver) => Promise<T>): Promise<T> {
  const d = new E2EDriver({
    bridgePort: a.bridgePort, cdpPort: a.cdpPort,
    width: a.width ?? 1000, height: a.height ?? 700,
    producerArgs: a.producerArgs, python: PY,
  });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(warmMs);
    return await fn(d);
  } finally {
    await d.dispose();
  }
}

// -- A: open from a file -------------------------------------------------------
async function A(fixtures: string): Promise<void> {
  console.log("A — open from a file (static / trajectory / orphan)");

  // A1: standalone structure -> static, no active playback.
  await withDriver({ bridgePort: 8971, cdpPort: 9271, producerArgs: ["--open", join(fixtures, "structure.pdb")] }, 3000, async (d) => {
    const playing = await d.evaluate<boolean>(`${V}.player.playing`);
    const playDisabled = await d.evaluate<boolean>("document.getElementById('playpause').disabled");
    const scrubDisabled = await d.evaluate<boolean>("document.getElementById('scrubber').disabled");
    const readout = await d.evaluate<string>("document.getElementById('readout').textContent");
    const f0 = await frameNum(d); await sleep(700); const f1 = await frameNum(d);
    const b64 = await d.captureB64(`${REPORT}/A_open_file/static_structure.png`);
    const lum = await meanLuminance(d, b64);
    check("static: not playing", playing === false);
    check("static: play + scrubber disabled", playDisabled && scrubDisabled);
    check("static: readout says static", /static/i.test(readout), JSON.stringify(readout));
    check("static: frame does not advance", f0 === 0 && f1 === 0, `f0=${f0} f1=${f1}`);
    check("static: structure actually rendered (not blank)", lum > 4, `lum=${lum.toFixed(1)}`);
  });

  // A2: trajectory with a resolvable companion -> resolves and plays.
  await withDriver({ bridgePort: 8972, cdpPort: 9272, producerArgs: ["--open", join(fixtures, "pair.xtc")] }, 3000, async (d) => {
    const playDisabled = await d.evaluate<boolean>("document.getElementById('playpause').disabled");
    const f0 = await frameNum(d); await sleep(900); const f1 = await frameNum(d);
    await d.screenshot(`${REPORT}/A_open_file/trajectory_pair.png`);
    check("trajectory: companion resolved + play enabled", playDisabled === false);
    check("trajectory: frames advance (streaming)", f1 !== f0, `f0=${f0} f1=${f1}`);
  });

  // A3: trajectory with no companion -> clear error, no crash.
  await withDriver({ bridgePort: 8973, cdpPort: 9273, producerArgs: ["--open", join(fixtures, "orphan", "orphan.dcd")] }, 3000, async (d) => {
    const status = await d.evaluate<string>("document.getElementById('status').textContent");
    await d.screenshot(`${REPORT}/A_open_file/orphan_error.png`);
    const alive = await d.evaluate<number>("1+1"); // page still responsive (no crash)
    check("orphan: webview shows an error state (no garbage render)", /error/i.test(status), JSON.stringify(status));
    check("orphan: producer reported a clear 'companion topology' message", /companion topology/i.test(d.log));
    check("orphan: page did not crash", alive === 2);
  });
}

// -- B1: double-click empty space -> zoom out to whole scene -------------------
async function B1(): Promise<void> {
  console.log("B1 — double-click empty space resets to whole-scene framing");
  await withDriver({ bridgePort: 8974, cdpPort: 9274, producerArgs: ["--n-points", "5000", "--n-frames", "120"] }, 2800, async (d) => {
    await pause(d);
    const home = await camPos(d);
    // Zoom into a subgroup so the camera is far from home, settle the tween.
    await d.evaluate(`${V}.actions.selectOnly({level:'subgroup', id:0})`);
    await d.evaluate(`${V}.zoomToSelection()`);
    await sleep(600);
    const zoomed = await camPos(d);
    await d.screenshot(`${REPORT}/B1_zoom_out/before_zoomed_in.png`);
    check("zoomed in moved camera off home", dist(zoomed, home) > 1, `d=${dist(zoomed, home).toFixed(2)}`);
    // Double-click empty space (a corner) -> back out to home.
    const r = await canvasRect(d);
    await d.doubleClick(r.x + 8, r.y + 8);
    await sleep(600);
    const back = await camPos(d);
    await d.screenshot(`${REPORT}/B1_zoom_out/after_zoom_out.png`);
    check("double-click empty returns camera to home framing", dist(back, home) < 0.5, `d=${dist(back, home).toFixed(3)}`);
  });
}

// -- B2: smooth (animated) camera transitions ---------------------------------
async function B2(): Promise<void> {
  console.log("B2 — camera transitions animate (intermediate frames), not snap");
  await withDriver({ bridgePort: 8975, cdpPort: 9275, producerArgs: ["--n-points", "5000", "--n-frames", "120"] }, 2800, async (d) => {
    await pause(d);
    await d.evaluate(`${V}.actions.selectOnly({level:'subgroup', id:0})`);
    const start = await camPos(d);
    await d.evaluate(`${V}.zoomToSelection()`);
    // Sample during the ~360ms tween: an early sample must be strictly between
    // start and end (proves interpolation, not a snap).
    await sleep(90);
    const mid = await camPos(d);
    await d.screenshot(`${REPORT}/B2_smooth/mid_frame.png`);
    await sleep(700);
    const end = await camPos(d);
    await d.screenshot(`${REPORT}/B2_smooth/settled.png`);
    const fromStart = dist(mid, start), fromEnd = dist(mid, end);
    check("mid-transition camera is between start and end (animated)", fromStart > 0.05 && fromEnd > 0.05, `mid-from-start=${fromStart.toFixed(2)} mid-from-end=${fromEnd.toFixed(2)}`);
    check("transition settles closer to the selection than the start", dist(end, start) > 0.1);
  });
}

// -- B3: rotation inertia (flick keeps spinning, decays) ----------------------
async function B3(): Promise<void> {
  console.log("B3 — rotation inertia: a flick keeps spinning and decays");
  await withDriver({ bridgePort: 8976, cdpPort: 9276, producerArgs: ["--n-points", "5000", "--n-frames", "120"] }, 2800, async (d) => {
    await pause(d);
    const r = await canvasRect(d);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    // A gentle flick, then release, and watch the motion settle. Distance is a
    // fair proxy here because the arc is small; the key signal is that early
    // post-release motion exists (inertia) and late motion has died (decay).
    await d.drag(cx - 45, cy, cx + 45, cy, 5);
    const p0 = await camPos(d);
    await sleep(100);
    const early = dist(await camPos(d), p0); // coasting right after release
    await d.screenshot(`${REPORT}/B3_inertia/coasting.png`);
    await sleep(1500);
    const pLate0 = await camPos(d);
    await sleep(400);
    const late = dist(await camPos(d), pLate0); // motion remaining after settling
    check("view keeps rotating after release (inertia)", early > 0.02, `early=${early.toFixed(3)}`);
    check("motion decays to rest", late < 0.2 * Math.max(early, 0.05), `early=${early.toFixed(3)} late=${late.toFixed(3)}`);

    // A slow, deliberate drag should position precisely (little residual drift).
    await sleep(200);
    await d.drag(cx, cy - 50, cx, cy + 50, 18);
    const s0 = await camPos(d);
    await sleep(250);
    const residual = dist(await camPos(d), s0);
    check("slow drag positions precisely (small residual)", residual < early, `residual=${residual.toFixed(3)} vs flick early=${early.toFixed(3)}`);
  });
}

// -- C: selection readout renders in exactly one place (the active-sets box) --
async function C(): Promise<void> {
  console.log("C — selection readout renders in exactly one place");
  await withDriver({ bridgePort: 8977, cdpPort: 9277, producerArgs: ["--n-points", "5000", "--n-frames", "120"] }, 2800, async (d) => {
    const topRight = await d.evaluate<number>("document.querySelectorAll('#selreadout').length");
    const boxes = await d.evaluate<number>("document.querySelectorAll('.set-title.sel').length");
    await d.evaluate(`${V}.actions.selectOnly({level:'subgroup', id:0})`);
    await sleep(150);
    const text = await d.evaluate<string>("document.querySelector('.set-title.sel').textContent");
    await d.screenshot(`${REPORT}/C_dedup_readout/single_readout.png`);
    check("no old top-right readout node", topRight === 0, `#selreadout=${topRight}`);
    check("exactly one selection readout (active-sets box)", boxes === 1, `.set-title.sel=${boxes}`);
    check("readout updates on selection", /1 entry/.test(text), JSON.stringify(text));
  });
}

// -- D: bulk hidden by default on small AND large datasets; un-hide works ------
async function D(): Promise<void> {
  console.log("D — bulk hidden by default (both scales) + un-hide");
  const scales: Array<{ n: number; label: string }> = [
    { n: 5600, label: "small" }, // ~4,480-pt solvent — the 'cage solvent' scale
    { n: 20000, label: "large" },
  ];
  for (const s of scales) {
    await withDriver({ bridgePort: 8978, cdpPort: 9278, producerArgs: ["--n-points", String(s.n), "--n-frames", "120"] }, 2800, async (d) => {
      await pause(d);
      // Bulk is a pre-populated hidden-set entry (no special toggle).
      const hidPts = await d.evaluate<number>(`${V}.sets.hidden.pointCount`);
      const hidEntries = await d.evaluate<number>(`${V}.sets.hidden.entryCount`);
      const hiddenB64 = await d.captureB64(`${REPORT}/D_bulk/${s.label}_hidden_default.png`);
      const lumHidden = await meanLuminance(d, hiddenB64);
      check(`${s.label}: has a bulk category (in hidden set)`, hidEntries >= 1 && hidPts > 1000, `entries=${hidEntries} pts=${hidPts}`);
      // Un-hide by clearing the hidden set (removes the bulk entry).
      await d.evaluate(`${V}.actions.clearSet('hidden')`);
      await sleep(300);
      const shownB64 = await d.captureB64(`${REPORT}/D_bulk/${s.label}_shown_after_toggle.png`);
      const lumShown = await meanLuminance(d, shownB64);
      check(`${s.label}: un-hiding reveals bulk (brighter)`, lumShown > lumHidden + 1 && (await d.evaluate<number>(`${V}.sets.hidden.pointCount`)) === 0, `hidden=${lumHidden.toFixed(1)} shown=${lumShown.toFixed(1)}`);
    });
  }
}

async function run(): Promise<void> {
  const all: Record<string, (fx: string) => Promise<void>> = {
    A: (fx) => A(fx), B1: () => B1(), B2: () => B2(), B3: () => B3(), C: () => C(), D: () => D(),
  };
  const picked = process.argv.slice(2).filter((a) => a in all);
  const names = picked.length ? picked : Object.keys(all);

  let fixtures = "";
  if (names.includes("A")) {
    fixtures = mkdtempSync(join(tmpdir(), "molaro-openfix-"));
    execFileSync(PY, ["tests/make_openfile_fixtures.py", fixtures], { stdio: "inherit" });
  }
  for (const n of names) {
    try {
      await all[n](fixtures);
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${n} threw: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
run();
