/**
 * Increment 4.7 validation — panel docking polish (Part A) + persistent
 * selection/hidden sets (Part B). Drives the real webview over the real producer
 * via CDP, exercises gestures through dispatched DOM events, asserts set + render
 * state, and screenshots into reports/fixes_4_7/. Run from viewer/ (after build):
 *   node tests/fixes_4_7.ts            # all; or a subset: node tests/fixes_4_7.ts B
 */
import { E2EDriver, meanLuminance, sleep } from "./e2e_driver.ts";

const REPORT = "reports/fixes_4_7";
const V = "window.__viewer";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

const rect = (d: E2EDriver, sel: string) =>
  d.evaluate<{ x: number; y: number; w: number; h: number } | null>(
    `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height};})()`,
  );
const dock = (d: E2EDriver) => d.evaluate<string>("document.getElementById('root').dataset.dock");
const selCount = (d: E2EDriver) => d.evaluate<number>(`${V}.sets.selection.entryCount`);
const selPts = (d: E2EDriver) => d.evaluate<number>(`${V}.sets.selection.pointCount`);
const hidCount = (d: E2EDriver) => d.evaluate<number>(`${V}.sets.hidden.entryCount`);
const hidPts = (d: E2EDriver) => d.evaluate<number>(`${V}.sets.hidden.pointCount`);
const camPos = (d: E2EDriver) =>
  d.evaluate<[number, number, number]>(`(()=>{const p=${V}.camera.position;return [p.x,p.y,p.z];})()`);
const distv = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Dispatch a mouse event on the Nth visible selectable tree row (tests the
 * real gesture handlers, which read ctrlKey/shiftKey/button). */
function fireRow(d: E2EDriver, n: number, type: string, mods: { ctrl?: boolean; shift?: boolean; right?: boolean } = {}) {
  return d.evaluate<boolean>(`(()=>{
    const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')].filter(r=>r.offsetParent);
    const el=rows[${n}]; if(!el) return false; const r=el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,
      clientX:r.left+20,clientY:r.top+3,button:${mods.right ? 2 : 0},ctrlKey:${!!mods.ctrl},shiftKey:${!!mods.shift}}));
    return true; })()`);
}
const expandRow = (d: E2EDriver, n: number) =>
  d.evaluate(`(()=>{const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')].filter(r=>r.offsetParent); const c=rows[${n}]&&rows[${n}].querySelector('.caret'); if(c)c.click();})()`);
const selectedRows = (d: E2EDriver) => d.evaluate<number>("document.querySelectorAll('.tree-row.selected').length");
const hiddenRows = (d: E2EDriver) => d.evaluate<number>("document.querySelectorAll('.tree-row.hidden-entry').length");

async function withDriver(fn: (d: E2EDriver) => Promise<void>, w = 1150, h = 760): Promise<void> {
  const d = new E2EDriver({ bridgePort: 8997, cdpPort: 9297, width: w, height: h,
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
const pause = (d: E2EDriver) =>
  d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p.textContent==='pause')p.click();})()`);

// ============================ Part A ========================================
async function A(): Promise<void> {
  console.log("A — panel docking polish");
  await withDriver(async (d) => {
    check("default dock is right", (await dock(d)) === "right", await dock(d));

    // Drag-to-dock: drag the grip toward each edge; nearest-edge zone docks.
    // (Re-query the grip each time — it moves with the panel to the new edge.)
    const targets: Array<{ pos: string; x: number; y: number }> = [
      { pos: "left", x: 30, y: 380 },
      { pos: "top", x: 560, y: 20 },
      { pos: "bottom", x: 560, y: 740 },
      { pos: "right", x: 1120, y: 380 },
    ];
    for (const t of targets) {
      const g = (await rect(d, "#panel-grip"))!;
      const gx = g.x + g.w / 2, gy = g.y + g.h / 2;
      await d.mouse("mousePressed", gx, gy, { buttons: 1 });
      for (let i = 1; i <= 6; i++) await d.mouse("mouseMoved", gx + (t.x - gx) * (i / 6), gy + (t.y - gy) * (i / 6), { buttons: 1 });
      const overlayActive = await d.evaluate<boolean>("document.getElementById('dock-overlay').classList.contains('active')");
      await d.mouse("mouseReleased", t.x, t.y, { buttons: 0 });
      await sleep(250);
      check(`drag-to-dock ${t.pos}: overlay shown while dragging`, overlayActive);
      check(`drag-to-dock ${t.pos}: docked ${t.pos}`, (await dock(d)) === t.pos, await dock(d));
      // horizontal reflow: when top/bottom, tree lays out as a row (no wrong-axis overflow)
      if (t.pos === "top" || t.pos === "bottom") {
        await expandRow(d, 0);
        const flexDir = await d.evaluate<string>("getComputedStyle(document.querySelector('.tree')).flexDirection");
        const ovY = await d.evaluate<string>("getComputedStyle(document.getElementById('sidebar-content')).overflowY");
        check(`${t.pos}: tree reflows horizontally`, flexDir === "row", flexDir);
        check(`${t.pos}: no wrong-axis (vertical) scroll`, ovY === "hidden", ovY);
      }
      await d.screenshot(`${REPORT}/A_dock_${t.pos}.png`);
    }

    // Collapse (animated) → reopen tab at the last dock edge (right).
    await d.evaluate(`${V}.panel.setDock('right')`);
    await sleep(250);
    await d.evaluate("document.getElementById('panel-collapse').click()");
    await sleep(60);
    const midW = (await rect(d, "#sidebar"))?.w ?? 0; // mid-animation width (shrinking)
    await d.screenshot(`${REPORT}/A_collapse_mid.png`);
    await sleep(300);
    const collapsed = await d.evaluate<boolean>("document.getElementById('root').classList.contains('panel-collapsed')");
    const reopen = (await rect(d, "#panel-reopen"))!;
    const appR = (await rect(d, "#app"))!;
    check("collapse animates (mid-frame partially open)", midW > 5, `midW=${midW.toFixed(0)}`);
    check("collapsed hides the panel", collapsed);
    check("reopen tab at the right edge (last dock)", reopen.x + reopen.w >= appR.x + appR.w - 4, JSON.stringify(reopen));
    await d.screenshot(`${REPORT}/A_collapsed.png`);
    await d.evaluate("document.getElementById('panel-reopen').click()");
    await sleep(300);
    check("reopen restores the panel", ((await rect(d, "#sidebar"))?.w ?? 0) > 50);

    // Reduced inertia: a flick settles quickly.
    await d.evaluate(`${V}.panel.setDock('right')`);
    await pause(d);
    const r = (await rect(d, "#app"))!;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await d.drag(cx - 45, cy, cx + 45, cy, 5);
    const p0 = await camPos(d);
    await sleep(120);
    const early = distv(await camPos(d), p0);
    await sleep(700);
    const pL = await camPos(d);
    await sleep(300);
    const late = distv(await camPos(d), pL);
    check("flick decays quickly (gentle nudge)", early > 0.01 && late < 0.15 * Math.max(early, 0.05), `early=${early.toFixed(3)} late=${late.toFixed(3)}`);
  });
}

// ============================ Part B ========================================
async function B(): Promise<void> {
  console.log("B — persistent selection & hidden sets");
  await withDriver(async (d) => {
    await d.evaluate(`${V}.panel.setDock('right')`);
    await pause(d);

    // Bulk hidden by default (no hairball).
    check("bulk hidden by default (1 entry)", (await hidCount(d)) >= 1 && (await hidPts(d)) > 1000, `entries=${await hidCount(d)} pts=${await hidPts(d)}`);
    const lumHidden = await meanLuminance(d, await d.captureB64(`${REPORT}/B_bulk_hidden_default.png`));

    // Left-click selects only this (replace).
    await fireRow(d, 0, "click");
    check("left-click selects only this", (await selCount(d)) === 1 && (await selectedRows(d)) === 1, `entries=${await selCount(d)}`);
    // Ctrl+left accumulates.
    await fireRow(d, 1, "click", { ctrl: true });
    check("Ctrl+left accumulates selection", (await selCount(d)) === 2 && (await selectedRows(d)) === 2, `entries=${await selCount(d)}`);
    await d.screenshot(`${REPORT}/B_ctrl_accumulate.png`);
    // Plain left replaces (back to 1).
    await fireRow(d, 2, "click");
    check("plain left-click replaces", (await selCount(d)) === 1, `entries=${await selCount(d)}`);

    // Shift+left range over visible category rows (anchor at row 0).
    await fireRow(d, 0, "click"); // anchor
    await fireRow(d, 2, "click", { shift: true }); // range rows 0..2
    check("Shift+left range-selects the span", (await selCount(d)) === 3, `entries=${await selCount(d)}`);
    await d.screenshot(`${REPORT}/B_shift_range.png`);
    await d.evaluate(`${V}.actions.clearSelection()`);

    // Right-click hides a category (it disappears); un-hide by right-clicking again.
    const hidBefore = await hidPts(d);
    await fireRow(d, 0, "contextmenu", { right: true }); // hide alpha
    check("right-click hides (points added to hidden set)", (await hidPts(d)) > hidBefore, `hidPts ${hidBefore} -> ${await hidPts(d)}`);
    check("hidden entry is struck-through in the tree", (await hiddenRows(d)) >= 1);
    await fireRow(d, 0, "contextmenu", { right: true }); // un-hide alpha
    check("right-click again un-hides that entry", (await hidPts(d)) === hidBefore, `back to ${await hidPts(d)}`);

    // Shift+right range-hide across the visible category rows.
    await fireRow(d, 0, "click"); // anchor via left click
    await fireRow(d, 2, "contextmenu", { right: true, shift: true });
    check("Shift+right range-hides the span", (await hidCount(d)) >= 3, `hidden entries=${await hidCount(d)}`);
    // clear hidden back to just bulk
    await d.evaluate(`${V}.actions.clearSet('hidden')`);

    // Drill a subgroup to points; select and hide an individual point.
    await expandRow(d, 0); // expand alpha -> groups
    await expandRow(d, 1); // expand first group -> subgroups
    await expandRow(d, 2); // expand first subgroup -> points
    const pointRows = await d.evaluate<number>("[...document.querySelectorAll('#tree-host .tree-row.selectable')].filter(r=>r.offsetParent && /#\\d+/.test(r.textContent)).length");
    check("drill-to-points reveals individual point rows", pointRows > 0, `pointRows=${pointRows}`);
    await d.evaluate(`${V}.actions.selectOnly({level:'point', id:0})`);
    check("select an individual point (1 pt)", (await selPts(d)) === 1, `pts=${await selPts(d)}`);
    await d.evaluate(`${V}.actions.hideToggle({level:'point', id:0})`);
    check("hide an individual point", (await d.evaluate<boolean>(`${V}.sets.hidden.contains(0)`)));
    // point 0 is in BOTH sets now: hidden wins -> not drawn (visible[0]===0)
    check("hidden wins over selection (point in both not drawn)", (await d.evaluate<number>(`${V}.rep.state.visible[0]`)) === 0);
    await d.evaluate(`${V}.actions.hideToggle({level:'point', id:0})`); // un-hide -> shows selected
    check("un-hiding reveals it (visible again, still selected)", (await d.evaluate<number>(`${V}.rep.state.visible[0]`)) === 1 && (await d.evaluate<boolean>(`${V}.sets.selection.contains(0)`)));
    await d.evaluate(`${V}.actions.clearSelection()`);

    // Un-hide bulk (remove the pre-populated hidden entry) → solvent renders white,
    // then selects green.
    await d.evaluate(`${V}.actions.clearSet('hidden')`);
    await sleep(200);
    const lumShown = await meanLuminance(d, await d.captureB64(`${REPORT}/B_bulk_unhidden_white.png`));
    check("un-hiding bulk shows it (brighter, no longer hidden)", lumShown > lumHidden + 2 && (await hidPts(d)) === 0, `hidden=${lumHidden.toFixed(1)} shown=${lumShown.toFixed(1)}`);
    // select the solvent (bulk) category by label → green like any node
    await d.evaluate(`(()=>{const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')].find(r=>/solvent/.test(r.textContent)); if(el){const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+3}));}})()`);
    check("shown bulk selects green like any node", (await selPts(d)) > 1000, `selPts=${await selPts(d)}`);
    await d.screenshot(`${REPORT}/B_bulk_selected_green.png`);

    // Active-sets surface: entry counts + remove + clear.
    await d.evaluate(`${V}.actions.selectOnly({level:'group', id:0})`);
    await d.evaluate(`${V}.actions.selectToggle({level:'subgroup', id:0})`);
    const selText = await d.evaluate<string>("document.querySelector('.set-title.sel').textContent");
    check("active-sets shows selection entries + count", /2 entries/.test(selText), JSON.stringify(selText));
    await d.evaluate(`${V}.actions.clearSelection()`);
    check("clear empties the selection set", (await selCount(d)) === 0 && (await selPts(d)) === 0);
  });
}

async function run(): Promise<void> {
  const all: Record<string, () => Promise<void>> = { A, B };
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
