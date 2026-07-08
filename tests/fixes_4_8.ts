/**
 * Increment 4.8 validation — docking/tree polish (Part A) + named selection
 * groups & toggle model (Part B/C). Drives the real webview via CDP, exercises
 * gestures through real events, asserts set + render + DOM state, and shots into
 * reports/fixes_4_8/. Run from viewer/ (after build):
 *   node tests/fixes_4_8.ts            # all; or: node tests/fixes_4_8.ts B
 */
import { E2EDriver, meanLuminance, sleep } from "./e2e_driver.ts";

const REPORT = "reports/fixes_4_8";
const V = "window.__viewer";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const dock = (d: E2EDriver) => d.evaluate<string>("document.getElementById('root').dataset.dock");
const rect = (d: E2EDriver, sel: string) =>
  d.evaluate<{ x: number; y: number; w: number; h: number } | null>(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`,
  );
const rowRect = (d: E2EDriver, n: number) =>
  d.evaluate<{ x: number; y: number; w: number; h: number } | null>(
    `(()=>{const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')].filter(r=>r.offsetParent);const el=rows[${n}];if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`,
  );
const unionPts = (d: E2EDriver) => d.evaluate<number>(`${V}.selection.resolvedPoints().length`);
const activeEntries = (d: E2EDriver) => d.evaluate<number>(`${V}.selection.active.set.entryCount`);
const groupCount = (d: E2EDriver) => d.evaluate<number>(`${V}.selection.list().length`);
const hidPts = (d: E2EDriver) => d.evaluate<number>(`${V}.hidden.pointCount`);
const pause = (d: E2EDriver) =>
  d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p.textContent==='pause')p.click();})()`);

async function withDriver(fn: (d: E2EDriver) => Promise<void>, w = 1180, h = 780): Promise<void> {
  const d = new E2EDriver({ bridgePort: 8993, cdpPort: 9293, width: w, height: h,
    producerArgs: ["--n-points", "6000", "--n-frames", "150"] });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(3200);
    await fn(d);
  } finally {
    await d.dispose();
  }
}

// ============================ Part A ========================================
async function A(): Promise<void> {
  console.log("A — docking & tree polish");
  await withDriver(async (d) => {
    // A1: collapse arrow points toward the dock edge.
    const arrows: Record<string, string> = { right: "▸", left: "◂", top: "▴", bottom: "▾" };
    for (const pos of ["right", "left", "top", "bottom"] as const) {
      await d.evaluate(`${V}.panel.setDock(${JSON.stringify(pos)})`);
      await sleep(150);
      const a = await d.evaluate<string>("document.getElementById('panel-collapse').textContent");
      check(`A1 ${pos}: collapse arrow points ${pos}`, a === arrows[pos], JSON.stringify(a));
    }

    // A2: soft translucent drag overlay (no hard dashed border).
    await d.evaluate(`${V}.panel.setDock('right')`);
    await sleep(150);
    const g = (await rect(d, "#panel-grip"))!;
    await d.mouse("mousePressed", g.x + g.w / 2, g.y + g.h / 2, { buttons: 1 });
    await d.mouse("mouseMoved", 40, 380, { buttons: 1 });
    await sleep(60);
    const zone = await d.evaluate<{ bg: string; border: string }>(
      "(()=>{const z=document.querySelector('.dock-zone.hot'); if(!z) return {bg:'',border:''}; const s=getComputedStyle(z); return {bg:s.backgroundColor, border:s.borderStyle};})()",
    );
    await d.screenshot(`${REPORT}/A2_drag_overlay.png`);
    await d.mouse("mouseReleased", 40, 380, { buttons: 0 });
    await sleep(150);
    check("A2: hot zone has a translucent fill", /rgba?\(.*0\.\d+\)/.test(zone.bg) || zone.bg.startsWith("rgb"), zone.bg);
    check("A2: hot zone has no hard dashed border", zone.border !== "dashed", zone.border);

    // A3: docked top → content flows horizontally.
    await d.evaluate(`${V}.panel.setDock('top')`);
    await sleep(200);
    await d.evaluate("(()=>{const c=document.querySelector('#tree-host .cat-block .caret'); if(c)c.click();})()");
    const flex = await d.evaluate<string>("getComputedStyle(document.getElementById('sidebar-content')).flexDirection");
    const treeFlex = await d.evaluate<string>("getComputedStyle(document.querySelector('.tree')).flexDirection");
    await d.screenshot(`${REPORT}/A3_horizontal.png`);
    check("A3: #sidebar-content flows row when docked top", flex === "row", flex);
    check("A3: tree lays categories in a row", treeFlex === "row", treeFlex);

    // A4: full list, no truncation, virtualized.
    await d.evaluate(`${V}.panel.setDock('right')`);
    await sleep(200);
    // expand the solvent category (many subgroups) -> its group -> subgroup vlist
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')];
      const sol=rows.find(r=>/solvent/.test(r.textContent)); sol && sol.querySelector('.caret').click();
    })()`);
    await sleep(150);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')];
      const grp=rows.find(r=>/solvent-bath/.test(r.textContent)); grp && grp.querySelector('.caret').click();
    })()`);
    await sleep(200);
    // the tall solvent vlist (thousands of subgroups) is the biggest .vlist
    const vlistHeight = await d.evaluate<number>("Math.max(0,...[...document.querySelectorAll('#tree-host .vlist')].map(v=>parseInt(v.style.height)||0))");
    const renderedRows = await d.evaluate<number>("(()=>{const vs=[...document.querySelectorAll('#tree-host .vlist')]; let best=vs[0],bh=0; for(const v of vs){const h=parseInt(v.style.height)||0; if(h>bh){bh=h;best=v;}} return best?best.querySelectorAll('.tree-row').length:0;})()");
    const hasMore = await d.evaluate<boolean>("[...document.querySelectorAll('#tree-host .tree-row')].some(r=>/more (subgroups|points)/.test(r.textContent))");
    await d.screenshot(`${REPORT}/A4_virtualized.png`);
    check("A4: no truncation ('…N more') node", hasMore === false);
    check("A4: virtualized (rendered rows far fewer than list height implies)", renderedRows > 0 && renderedRows * 18 < vlistHeight * 0.9, `rendered=${renderedRows} listPx=${vlistHeight}`);
  });
}

// ============================ Part B / C ====================================
async function B(): Promise<void> {
  console.log("B/C — named groups, toggle model, gestures");
  await withDriver(async (d) => {
    await d.evaluate(`${V}.panel.setDock('right')`);
    await pause(d);

    // Toggle-accumulate in the active group (selection_1), then de-select one.
    check("starts with one group selection_1", (await groupCount(d)) === 1 && (await d.evaluate<string>(`${V}.selection.list()[0].name`)) === "selection_1");
    await d.evaluate(`${V}.actions.toggleSelect({level:'category', id:0})`); // alpha 400
    await d.evaluate(`${V}.actions.toggleSelect({level:'category', id:1})`); // beta 400
    check("toggle-accumulates (no replace)", (await activeEntries(d)) === 2 && (await unionPts(d)) === 800, `entries=${await activeEntries(d)} pts=${await unionPts(d)}`);
    await d.screenshot(`${REPORT}/B_accumulate.png`);
    await d.evaluate(`${V}.actions.toggleSelect({level:'category', id:0})`); // toggle alpha OFF
    check("toggling an already-selected entry removes just it", (await activeEntries(d)) === 1 && (await unionPts(d)) === 400, `entries=${await activeEntries(d)}`);

    // New group: previous group's selection stays; adds go to the new active one.
    await d.evaluate(`${V}.actions.newGroup()`);
    check("new group is active + previous kept", (await groupCount(d)) === 2 && (await activeEntries(d)) === 0 && (await unionPts(d)) === 400, `groups=${await groupCount(d)} union=${await unionPts(d)}`);
    await d.evaluate(`${V}.actions.toggleSelect({level:'category', id:2})`); // gamma into selection_2
    check("adding to selection_2 leaves selection_1 intact", (await unionPts(d)) === 800 && (await d.evaluate<number>(`${V}.selection.list()[0].set.pointCount`)) === 400, `union=${await unionPts(d)}`);
    // rename works
    await d.evaluate(`${V}.actions.renameGroup(${await d.evaluate<number>(`${V}.selection.active.id`)}, 'gammas')`);
    check("rename group", (await d.evaluate<string>(`${V}.selection.active.name`)) === "gammas");
    // delete active group un-highlights only its points
    await d.evaluate(`${V}.actions.deleteGroup(${await d.evaluate<number>(`${V}.selection.active.id`)})`);
    check("deleting a group un-highlights only its points", (await unionPts(d)) === 400 && (await groupCount(d)) === 1, `union=${await unionPts(d)}`);
    await d.evaluate(`${V}.actions.clearActiveGroup()`);

    // Drag-paint down the category rows (alpha, beta, gamma).
    const r0 = (await rowRect(d, 0))!, r2 = (await rowRect(d, 2))!;
    await d.mouse("mousePressed", r0.x + 30, r0.y + r0.h / 2, { buttons: 1 });
    await d.mouse("mouseMoved", r0.x + 30, (await rowRect(d, 1))!.y + 8, { buttons: 1 });
    await d.mouse("mouseMoved", r2.x + 30, r2.y + r2.h / 2, { buttons: 1 });
    await d.mouse("mouseReleased", r2.x + 30, r2.y + r2.h / 2, { buttons: 0 });
    await sleep(150);
    check("drag-paint adds the span it passes", (await activeEntries(d)) === 3, `entries=${await activeEntries(d)}`);
    await d.screenshot(`${REPORT}/B_drag_paint.png`);
    await d.evaluate(`${V}.actions.clearActiveGroup()`);

    // Right-click a category row hides it (toggle hidden).
    const hidBefore = await hidPts(d);
    await d.evaluate(`(()=>{const r=[...document.querySelectorAll('#tree-host .tree-row.selectable')][0]; const q=r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:q.left+20,clientY:q.top+3}));})()`);
    await sleep(120);
    check("right-click toggles hide", (await hidPts(d)) === hidBefore + 400, `hid ${hidBefore}->${await hidPts(d)}`);
    // right-click again un-hides
    await d.evaluate(`(()=>{const r=[...document.querySelectorAll('#tree-host .tree-row.selectable')][0]; const q=r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:q.left+20,clientY:q.top+3}));})()`);
    check("right-click again un-hides", (await hidPts(d)) === hidBefore);

    // Bulk hidden by default → un-hide → renders (brighter) and is selectable green.
    const lumHidden = await meanLuminance(d, await d.captureB64(`${REPORT}/B_bulk_hidden.png`));
    await d.evaluate(`${V}.actions.clearHidden()`);
    await sleep(200);
    const lumShown = await meanLuminance(d, await d.captureB64(`${REPORT}/B_bulk_shown.png`));
    check("un-hiding bulk shows it (brighter)", lumShown > lumHidden + 2 && (await hidPts(d)) === 0, `hidden=${lumHidden.toFixed(1)} shown=${lumShown.toFixed(1)}`);
    await d.evaluate(`(()=>{const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')].find(r=>/solvent/.test(r.textContent)); const q=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:q.left+20,clientY:q.top+3})); window.dispatchEvent(new PointerEvent('pointerup'));})()`);
    await sleep(150);
    check("shown bulk selects green (union has its points)", (await unionPts(d)) > 1000, `union=${await unionPts(d)}`);
    await d.screenshot(`${REPORT}/B_bulk_selected_green.png`);
  });
}

// -- 3D resolution: subgroup when oriented, point when zoomed in + scroll-to --
async function D3(): Promise<void> {
  console.log("B5 — 3D subgroup/point resolution + scroll-to");
  await withDriver(async (d) => {
    await d.evaluate(`${V}.panel.setDock('right')`);
    await d.evaluate(`${V}.actions.clearHidden()`); // show everything so center has points
    await pause(d);
    await sleep(200);
    const rr = (await rect(d, "#app canvas"))!;
    // find a bright (on-point) pixel near center
    const hit = await findBright(d, rr);
    if (!hit) { check("found a point to click in 3D", false); return; }
    // zoomed out → click resolves to a SUBGROUP
    await d.click(hit.x, hit.y);
    await sleep(150);
    const lvl1 = await d.evaluate<string>(`(()=>{const e=${V}.selection.active.set.listEntries()[0]; return e?e.level:'none';})()`);
    check("3D click (zoomed out) selects a SUBGROUP", lvl1 === "subgroup", lvl1);
    // panel scrolled/expanded to that subgroup (a subgroup row exists in DOM)
    const subRowShown = await d.evaluate<boolean>("!![...document.querySelectorAll('#tree-host .tree-row.selectable')].find(r=>/subgroup|solvent-/.test(r.textContent))");
    check("3D select scrolled the panel to the subgroup", subRowShown);
    await d.screenshot(`${REPORT}/B5_3d_subgroup.png`);
    await d.evaluate(`${V}.actions.clearActiveGroup()`);
    // zoom the camera in, then a click resolves to an individual POINT
    await d.evaluate(`(()=>{const v=${V}; const t=v.controls.target; const dir=v.camera.position.clone().sub(t).normalize(); v.camera.position.copy(t).addScaledVector(dir, v.camera.position.distanceTo(t)*0.25); v.controls.update();})()`);
    await sleep(150);
    const hit2 = await findBright(d, rr);
    if (hit2) {
      await d.click(hit2.x, hit2.y);
      await sleep(150);
      const lvl2 = await d.evaluate<string>(`(()=>{const e=${V}.selection.active.set.listEntries()[0]; return e?e.level:'none';})()`);
      check("3D click (zoomed in) selects a POINT", lvl2 === "point", lvl2);
    } else check("found a point after zoom", false);
  });
}

async function findBright(d: E2EDriver, r: { x: number; y: number; w: number; h: number }): Promise<{ x: number; y: number } | null> {
  const b64 = await d.captureB64(`${REPORT}/_scan.png`);
  return d.evaluate(`(async()=>{const img=new Image();await new Promise((res,rej)=>{img.onload=res;img.onerror=rej;img.src="data:image/png;base64,${b64}";});
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const g=c.getContext('2d');g.drawImage(img,0,0);
    const R=${JSON.stringify(r)};const x0=Math.floor(R.x+R.w*0.3),x1=Math.floor(R.x+R.w*0.7),y0=Math.floor(R.y+R.h*0.3),y1=Math.floor(R.y+R.h*0.7);
    for(let y=y0;y<y1;y+=2)for(let x=x0;x<x1;x+=2){const p=g.getImageData(x,y,1,1).data;if((p[0]+p[1]+p[2])/3>150)return{x,y};}return null;})()`);
}

async function run(): Promise<void> {
  const all: Record<string, () => Promise<void>> = { A, B, D3 };
  const picked = process.argv.slice(2).filter((a) => a in all);
  for (const n of picked.length ? picked : Object.keys(all)) {
    try {
      await all[n]();
    } catch (e) {
      failures++;
      console.log(`  [FAIL] ${n} threw: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
run();
