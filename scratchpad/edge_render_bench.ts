/**
 * Does the membrane at 173 964 edges cost anything to RENDER?
 *
 * Drives the REAL webview bundle against the REAL producer on the 222 227-atom
 * membrane, once per --infer-bonds mode, and measures GPU time per frame with
 * EXT_disjoint_timer_query_webgl2 on the viewer's own context. Runs on the REAL
 * GPU (E2EDriver `gpu: true`) — SwiftShader would measure the CPU rasterizer and
 * the number would say nothing about the edge pass.
 *
 * The GPU sampler is the one from tests/impostor_bench.ts: a TIME_ELAPSED query
 * bracketing each inter-rAF interval, i.e. the whole scene render submitted that
 * frame. It is vsync-independent, which wall frame time is not.
 *
 *   node scratchpad/edge_render_bench.ts [--seconds 6]
 */
import { E2EDriver, meanLuminance, sleep } from "../tests/e2e_driver.ts";

const MEMBRANE =
  "/home/dom/Desktop/claude_hackathon/benchmark_systems/systems/06_membrane_complex/files/membrane.dcd";
const PYTHON = "/home/dom/miniforge3/envs/mdbench/bin/python";
const SECONDS = Number(process.argv[process.argv.indexOf("--seconds") + 1]) || 6;
const MODES = ["off", "nonsolvent", "full"] as const;

const sampleGpu = (ms: number) => `(async () => {
  const canvas = document.querySelector('#app canvas');
  const gl = canvas ? canvas.getContext('webgl2') : null;
  if (!gl) return { unavailable: 'no webgl2 canvas' };
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { unavailable: 'EXT_disjoint_timer_query_webgl2 not exposed' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const samples = []; const walls = [];
  let dropped = 0, active = null; const pending = [];
  const poll = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) dropped++;
        else samples.push(Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6);
        gl.deleteQuery(q); pending.splice(i, 1);
      }
    }
  };
  const t0 = performance.now(); let last = t0;
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      if (active) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null; walls.push(now - last); }
      last = now; poll();
      if (now - t0 < ${ms}) {
        active = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
        requestAnimationFrame(tick);
      } else done();
    };
    requestAnimationFrame(tick);
  });
  const tEnd = performance.now();
  while (pending.length && performance.now() - tEnd < 800) {
    await new Promise((r) => requestAnimationFrame(r)); poll();
  }
  for (const q of pending) gl.deleteQuery(q);
  if (!samples.length) return { unavailable: 'no completed GPU samples (' + dropped + ' disjoint)' };
  samples.sort((a, b) => a - b); walls.sort((a, b) => a - b);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    renderer,
    gpuMeanMs: +mean(samples).toFixed(3),
    gpuP95Ms: +samples[Math.floor(samples.length * 0.95)].toFixed(3),
    gpuMaxMs: +samples[samples.length - 1].toFixed(3),
    wallMeanMs: +mean(walls).toFixed(2),
    fps: +(1000 / mean(walls)).toFixed(1),
    n: samples.length, disjoint: dropped,
  };
})()`;

const scene = `(() => {
  const V = window.__viewer;
  return {
    nPoints: V.positionAttr.count,
    nEdges: V.edges.length,
    attrBudgetOver: V.attrBudgetOver,
  };
})()`;

const rows: Record<string, unknown>[] = [];
for (const mode of MODES) {
  const driver = new E2EDriver({
    bridgePort: 8971, cdpPort: 9971, width: 1280, height: 800, gpu: true,
    producerArgs: ["--open", MEMBRANE, "--infer-bonds", mode],
    python: PYTHON,
  });
  try {
    await driver.start();
    await driver.navigate();
    await driver.waitFor(`window.__viewer && window.__viewer.edges && document.querySelector("#app canvas")`, 120000);
    // The scene must be DRAWING before the first sample. Waiting a fixed few
    // seconds is not enough — the 174k-edge header takes longer to upload, and a
    // sample taken during upload reads an almost-empty frame (measured: 2.3 ms
    // where the settled scene reads 14.3). So gate on rendered PIXELS.
    let lum = 0;
    for (let i = 0; i < 40 && lum < 4; i++) {
      await sleep(1000);
      lum = await meanLuminance(driver, await driver.captureB64("/tmp/edge_bench_ready.png"));
    }
    console.log(`  ${mode}: scene drawing, mean luminance ${lum.toFixed(1)}`);
    const info = await driver.evaluate<Record<string, unknown>>(scene);
    // Three loads. The default scene is dominated by 222 227 point impostors, so
    // it cannot see the edge pass at all; hiding the points isolates it, and
    // fattening the tubes puts the edge pass under real overdraw — which is where
    // 3.45x the instances would have to show up if it costs anything.
    for (const [load, cmds] of [
      ["default", []],
      ["edges only", ["pointsize all 0"]],
      ["edges only, fat", ["pointsize all 0", "bondsize all 4"]],
    ] as [string, string[]][]) {
      for (const c of cmds) {
        await driver.evaluate(`window.__viewer.command(${JSON.stringify(c)})`);
      }
      // A command's effect reaches the GPU on a later frame, so VERIFY the point
      // pass is actually gone before sampling — the first attempt at this sampled
      // "edges only" while the impostors were still up and read the default
      // scene's number back.
      const wantPointsHidden = cmds.length > 0;
      if (wantPointsHidden) {
        await driver.waitFor(`(() => {
          const s = window.__viewer.rep.state.size;
          for (let i = 0; i < s.length; i++) if (s[i] !== 0) return false;
          return s.length > 0;
        })()`, 30000);
      }
      await sleep(4000);
      const gpu = await driver.evaluate<Record<string, unknown>>(sampleGpu(SECONDS * 1000));
      rows.push({ mode, load, ...info, ...gpu });
      console.log(mode, load, JSON.stringify(gpu));
    }
  } catch (err) {
    console.log(`${mode} FAILED: ${(err as Error).message}`);
    console.log(driver.log.split("\n").slice(-12).join("\n"));
    rows.push({ mode, error: String(err) });
  } finally {
    await driver.dispose();
    await sleep(1500);
  }
}

console.log("\n=== membrane (222 227 atoms, 1 frame) edge-pass render cost, REAL GPU ===");
console.log("mode        load              edges  gpu mean  gpu p95  gpu max   wall mean   fps");
for (const r of rows) {
  if (r.error) { console.log(`${String(r.mode).padEnd(11)} ERROR ${r.error}`); continue; }
  console.log(
    `${String(r.mode).padEnd(11)} ${String(r.load).padEnd(17)} ${String(r.nEdges).padStart(6)}` +
    ` ${String(r.gpuMeanMs).padStart(9)} ${String(r.gpuP95Ms).padStart(8)} ${String(r.gpuMaxMs).padStart(8)}` +
    ` ${String(r.wallMeanMs).padStart(10)} ${String(r.fps).padStart(6)}   (${r.n} samples, ${r.disjoint} disjoint)`,
  );
}
console.log(`renderer: ${rows.find((r) => r.renderer)?.renderer ?? "unknown"}`);
