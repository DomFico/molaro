/**
 * Increment 4.5 validation — drives the real webview over the real producer via
 * CDP, scripts each interaction/layout fix, captures screenshots into
 * reports/fixes_4_5/<fix>/, and asserts the behavior. Test infra, not product.
 *
 * Run from viewer/ (after `npm run build`):
 *   node tests/fixes_4_5.ts                 # all fixes
 *   node tests/fixes_4_5.ts A1 A3           # a subset
 *
 * Exit code is non-zero if any assertion fails; every assertion is printed.
 */
import { E2EDriver, meanLuminance, sleep } from "./e2e_driver.ts";

const REPORT = "reports/fixes_4_5";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
}

// -- shared page helpers (read state via the test seam window.__viewer) --------
const V = "window.__viewer";
const canvasRect = (d: E2EDriver) =>
  d.evaluate<{ x: number; y: number; w: number; h: number }>(
    "(()=>{const r=document.querySelector('#app canvas').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()",
  );
const selCount = (d: E2EDriver) => d.evaluate<number>(`${V}.sets.selection.pointCount`);
const frameNum = (d: E2EDriver) => d.evaluate<number>(`${V}.player.frame`);
const isPlaying = (d: E2EDriver) => d.evaluate<boolean>(`${V}.player.playing`);
const sliderVal = (d: E2EDriver) => d.evaluate<number>("Number(document.getElementById('scrubber').value)");
const camPos = (d: E2EDriver) =>
  d.evaluate<[number, number, number]>(`(()=>{const p=${V}.camera.position;return [p.x,p.y,p.z];})()`);
const rect = (d: E2EDriver, sel: string) =>
  d.evaluate<{ x: number; y: number; w: number; h: number } | null>(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`,
  );

function overlaps(a: any, b: any): boolean {
  if (!a || !b || a.w === 0 || b.w === 0) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function withDriver<T>(
  opts: { bridgePort: number; cdpPort: number; width: number; height: number; nPoints?: number },
  fn: (d: E2EDriver) => Promise<T>,
): Promise<T> {
  const d = new E2EDriver({
    bridgePort: opts.bridgePort,
    cdpPort: opts.cdpPort,
    width: opts.width,
    height: opts.height,
    // Default 6000 has no bulk category (dense center, good for picking); B needs
    // a larger N so a bulk category exists and the bulk toggle is shown.
    producerArgs: ["--n-points", String(opts.nPoints ?? 6000), "--n-frames", "150"],
  });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(2800); // warm up streaming + first frames
    return await fn(d);
  } finally {
    await d.dispose();
  }
}

const pause = (d: E2EDriver) =>
  d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p.textContent==='pause')p.click();})()`);

// -- A1: drag orbits without selecting; click still selects --------------------
async function A1(): Promise<void> {
  console.log("A1 — click-drag orbits without selecting");
  await withDriver({ bridgePort: 8961, cdpPort: 9261, width: 1000, height: 700 }, async (d) => {
    await pause(d);
    const r = await canvasRect(d);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await d.evaluate(`${V}.actions.clearSelection()`);
    const before = await selCount(d);
    const camBefore = await camPos(d);
    await d.drag(cx - 130, cy - 90, cx + 130, cy + 90, 12);
    await sleep(200);
    const afterDrag = await selCount(d);
    const camAfter = await camPos(d);
    const camMoved = Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]);
    await d.screenshot(`${REPORT}/A1_drag_vs_click/after_drag_no_selection.png`);
    check("drag leaves selection empty", before === 0 && afterDrag === 0, `before=${before} afterDrag=${afterDrag}`);
    check("drag moved the camera (orbit worked)", camMoved > 0.01, `moved=${camMoved.toFixed(3)}`);

    // A no-move click on a bright (on-point) pixel selects. Un-hide bulk first so
    // the scene fills the center (bulk solvent is hidden by default).
    await d.evaluate(`${V}.actions.clearSet('hidden')`);
    await sleep(200);
    const hit = await findBrightPixel(d, r);
    if (hit) {
      await d.click(hit.x, hit.y);
      await sleep(150);
      const afterClick = await selCount(d);
      await d.screenshot(`${REPORT}/A1_drag_vs_click/after_click_selects.png`);
      check("no-move click on a point selects", afterClick > 0, `count=${afterClick}`);
    } else {
      check("found a point pixel to click", false, "no bright pixel located");
    }

    // A no-move click on empty space clears.
    await d.click(r.x + 6, r.y + 6);
    await sleep(120);
    check("click on empty space clears", (await selCount(d)) === 0);
  });
}

/** Scan a screenshot for a bright (point) pixel; return client coords or null. */
async function findBrightPixel(
  d: E2EDriver,
  r: { x: number; y: number; w: number; h: number },
): Promise<{ x: number; y: number } | null> {
  const b64 = await d.captureB64(`${REPORT}/A1_drag_vs_click/_scan.png`);
  return d.evaluate(`(async () => {
    const img = new Image();
    await new Promise((res, rej)=>{img.onload=res;img.onerror=rej;img.src="data:image/png;base64,${b64}";});
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const g=c.getContext('2d');g.drawImage(img,0,0);
    const R=${JSON.stringify(r)};
    // search a central window of the canvas for a bright pixel (a rendered point)
    const x0=Math.floor(R.x+R.w*0.3), x1=Math.floor(R.x+R.w*0.7);
    const y0=Math.floor(R.y+R.h*0.3), y1=Math.floor(R.y+R.h*0.7);
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){
      const p=g.getImageData(x,y,1,1).data;
      if((p[0]+p[1]+p[2])/3 > 160) return {x, y};
    }
    return null;
  })()`);
}

// -- A2: full 360 rotation, no pole lock; pan/zoom/zoom-to-selection intact -----
async function A2(): Promise<void> {
  console.log("A2 — trackball rotation (no pole lock), pan/zoom/zoom-to-selection");
  await withDriver({ bridgePort: 8962, cdpPort: 9262, width: 1000, height: 700 }, async (d) => {
    await pause(d);
    const r = await canvasRect(d);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await d.screenshot(`${REPORT}/A2_rotation/after_0_start.png`);
    const lum: number[] = [];
    let prevCam = await camPos(d);
    let allMoved = true;
    // Roll straight over the top repeatedly; trackball must keep turning.
    for (let k = 1; k <= 6; k++) {
      await d.drag(cx, cy + 150, cx, cy - 150, 14);
      await sleep(150);
      const b64 = await d.captureB64(`${REPORT}/A2_rotation/after_${k}_vdrag.png`);
      lum.push(await meanLuminance(d, b64));
      const cam = await camPos(d);
      const moved = Math.hypot(cam[0] - prevCam[0], cam[1] - prevCam[1], cam[2] - prevCam[2]);
      if (moved < 0.01) allMoved = false;
      prevCam = cam;
    }
    check("camera kept rotating over the pole (never clamped)", allMoved);
    check("every over-the-pole frame renders the scene (not blank)", lum.every((l) => l > 4), `lum=[${lum.map((l) => l.toFixed(1))}]`);

    // Pan (right-drag) changes the view.
    const camBeforePan = await camPos(d);
    const tgtBefore = await d.evaluate<[number, number, number]>(`(()=>{const t=${V}.controls.target;return [t.x,t.y,t.z];})()`);
    await d.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "right", buttons: 2, clickCount: 1 });
    for (let i = 1; i <= 8; i++) await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + i * 12, y: cy, button: "right", buttons: 2 });
    await d.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + 96, y: cy, button: "right", buttons: 0, clickCount: 1 });
    await sleep(150);
    const tgtAfter = await d.evaluate<[number, number, number]>(`(()=>{const t=${V}.controls.target;return [t.x,t.y,t.z];})()`);
    const panMoved = Math.hypot(tgtAfter[0] - tgtBefore[0], tgtAfter[1] - tgtBefore[1], tgtAfter[2] - tgtBefore[2]);
    check("pan (right-drag) moved the target", panMoved > 0.01, `moved=${panMoved.toFixed(3)}`);
    await d.screenshot(`${REPORT}/A2_rotation/after_pan.png`);

    // Zoom (wheel) changes camera distance to target.
    const distBefore = await d.evaluate<number>(`${V}.camera.position.distanceTo(${V}.controls.target)`);
    await d.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY: -600 });
    await sleep(200);
    const distAfter = await d.evaluate<number>(`${V}.camera.position.distanceTo(${V}.controls.target)`);
    check("wheel zoom changed camera distance", Math.abs(distAfter - distBefore) > 0.01, `d0=${distBefore.toFixed(2)} d1=${distAfter.toFixed(2)}`);

    // Zoom-to-selection: select a subgroup, invoke the real zoom path, confirm
    // the camera reframed closer to the selection centroid.
    await d.evaluate(`${V}.actions.selectOnly({level:'subgroup', id:1})`);
    await sleep(100);
    const distToSelBefore = await selectionCamDist(d);
    await d.evaluate(`${V}.zoomToSelection()`);
    await sleep(200);
    const distToSelAfter = await selectionCamDist(d);
    await d.screenshot(`${REPORT}/A2_rotation/after_zoom_to_selection.png`);
    check("zoom-to-selection framed the selection (camera closer)", distToSelAfter < distToSelBefore, `before=${distToSelBefore.toFixed(2)} after=${distToSelAfter.toFixed(2)}`);
  });
}

/** Distance from camera to the current selection centroid at the current frame. */
function selectionCamDist(d: E2EDriver): Promise<number> {
  return d.evaluate<number>(`(()=>{
    const v=${V}; const idx=v.sets.selection.resolvedPoints(); if(!idx.length) return Infinity;
    const f=v.player.frame; const chunk=v.player.getFrame(f); if(!chunk) return Infinity;
    const nP=v.rep.state.visible.length; const off=(f-chunk.start)*nP*3; const pos=chunk.positions;
    let cx=0,cy=0,cz=0; for(const p of idx){cx+=pos[off+p*3];cy+=pos[off+p*3+1];cz+=pos[off+p*3+2];}
    cx/=idx.length; cy/=idx.length; cz/=idx.length;
    const dx=v.camera.position.x-cx, dy=v.camera.position.y-cy, dz=v.camera.position.z-cz;
    return Math.sqrt(dx*dx+dy*dy+dz*dz);
  })()`);
}

// -- A3: scrubber tracks the playhead during playback, even after a scrub ------
async function A3(): Promise<void> {
  console.log("A3 — scrubber tracks the playhead");
  await withDriver({ bridgePort: 8963, cdpPort: 9263, width: 1000, height: 700 }, async (d) => {
    // ensure playing
    if (!(await isPlaying(d))) await d.evaluate(`${V}.setPlaying(true)`);
    const s1: Array<{ slider: number; frame: number }> = [];
    for (let i = 0; i < 5; i++) { await sleep(350); s1.push({ slider: await sliderVal(d), frame: await frameNum(d) }); }
    const tracks = s1.every((s) => Math.abs(s.slider - s.frame) <= 2);
    const advanced = s1[s1.length - 1].slider > s1[0].slider;
    check("slider tracks frame during playback", tracks, JSON.stringify(s1));
    check("slider advances during playback", advanced);

    // Simulate a user scrub (focus + drag the slider), then release; must resume.
    await d.evaluate("document.getElementById('scrubber').focus()");
    await d.evaluate(`(()=>{const s=document.getElementById('scrubber'); s.dispatchEvent(new Event('pointerdown',{bubbles:true})); s.value='10'; s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await sleep(150);
    const duringScrub = await sliderVal(d);
    await d.evaluate("window.dispatchEvent(new Event('pointerup'))");
    await sleep(250);
    const s2: Array<{ slider: number; frame: number }> = [];
    for (let i = 0; i < 4; i++) { await sleep(350); s2.push({ slider: await sliderVal(d), frame: await frameNum(d) }); }
    const resumed = s2[s2.length - 1].slider > s2[0].slider && s2.every((s) => Math.abs(s.slider - s.frame) <= 2);
    check("slider resumes tracking after a scrub (not frozen)", resumed, `duringScrub=${duringScrub} then ${JSON.stringify(s2)}`);
    await d.screenshot(`${REPORT}/A3_scrubber/after_tracking.png`);
  });
}

// -- A4: clear color set to background; no white flash on resize ---------------
async function A4(): Promise<void> {
  console.log("A4 — no white flash on resize");
  await withDriver({ bridgePort: 8964, cdpPort: 9264, width: 1000, height: 700 }, async (d) => {
    await pause(d);
    // Read the GL clear color straight from the live context.
    const clear = await d.evaluate<number[]>(`(()=>{const c=document.querySelector('#app canvas');
      const gl=c.getContext('webgl2')||c.getContext('webgl'); return Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE));})()`);
    const bg = 0x1e / 255; // 0x1e1e1e -> ~0.118
    const clearIsBg = clear.slice(0, 3).every((v) => Math.abs(v - bg) < 0.02);
    check("GL clear color set to background (not white)", clearIsBg, `clear=[${clear.map((v) => v.toFixed(3))}]`);

    // Resize across several sizes; capture and assert no frame is white.
    const sizes: Array<[number, number]> = [[700, 500], [1200, 800], [500, 900], [1000, 700]];
    const lums: number[] = [];
    for (let i = 0; i < sizes.length; i++) {
      await d.resize(sizes[i][0], sizes[i][1]);
      await sleep(120);
      const b64 = await d.captureB64(`${REPORT}/A4_resize_flash/resize_${sizes[i][0]}x${sizes[i][1]}.png`);
      lums.push(await meanLuminance(d, b64));
    }
    check("no captured resize frame is predominantly white", lums.every((l) => l < 90), `lums=[${lums.map((l) => l.toFixed(1))}]`);
  });
}

// -- B: layout — reserved, non-overlapping regions at multiple sizes/widths ----
async function B(): Promise<void> {
  console.log("B — non-overlapping reserved layout, resizable sidebar");
  const regions = ["#topbar", "#status", "#sidebar", "#app", "#controls"];
  const configs: Array<{ w: number; h: number; sidebar: number; label: string }> = [
    { w: 1000, h: 700, sidebar: 300, label: "1000x700_sb300" },
    { w: 1400, h: 900, sidebar: 420, label: "1400x900_sb420" },
    { w: 760, h: 560, sidebar: 200, label: "760x560_sb200" },
  ];
  for (const cfg of configs) {
    await withDriver({ bridgePort: 8965, cdpPort: 9265, width: cfg.w, height: cfg.h, nPoints: 9000 }, async (d) => {
      // make a selection so both header and selection readout have text
      await d.evaluate(`${V}.actions.selectOnly({level:'subgroup', id:0})`);
      await d.evaluate(`(()=>{const s=document.getElementById('sidebar'); s.style.width='${cfg.sidebar}px';})()`);
      await d.evaluate(`${V}.applyResize()`);
      await sleep(250);
      const rects: Record<string, any> = {};
      for (const sel of regions) rects[sel] = await rect(d, sel);

      // header occupies the top bar cleanly (B1: no on-canvas overlay to collide)
      check(`${cfg.label}: header present in top bar`, !!rects["#status"] && rects["#status"].w > 0);
      // core regions do not overlap each other (B3)
      const core = ["#topbar", "#sidebar", "#app", "#controls"];
      let anyOverlap = false, which = "";
      for (let i = 0; i < core.length; i++)
        for (let j = i + 1; j < core.length; j++)
          if (overlaps(rects[core[i]], rects[core[j]])) { anyOverlap = true; which = `${core[i]}∩${core[j]}`; }
      check(`${cfg.label}: topbar/sidebar/canvas/controls all disjoint`, !anyOverlap, which);
      // selection readout appears exactly once — the active-sets "Selected" title
      const selNodes = await d.evaluate<number>("document.querySelectorAll('.set-title.sel').length");
      check(`${cfg.label}: single selection-readout node (no duplicate)`, selNodes === 1, `nodes=${selNodes}`);
      // sidebar honored the requested width (resizable)
      check(`${cfg.label}: sidebar width applied (${cfg.sidebar}px)`, Math.abs((rects["#sidebar"]?.w ?? 0) - cfg.sidebar) < 2, `w=${rects["#sidebar"]?.w}`);

      await d.screenshot(`${REPORT}/B_layout/${cfg.label}.png`);
    });
  }
}

const ALL: Record<string, () => Promise<void>> = { A1, A2, A3, A4, B };

async function run(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a in ALL);
  const names = args.length ? args : Object.keys(ALL);
  for (const n of names) {
    try {
      await ALL[n]();
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${n} threw: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
run();
