import { HOLD_MS } from "../webview/tree.ts";
import { DEFAULT_HOLD_COMMAND } from "../webview/commands.ts";
/**
 * Interaction-redesign validation — drives the REAL webview over the REAL
 * synthetic producer via CDP and asserts the new model end-to-end:
 *
 *   S0  startup: no auto-committed selections + mirrored top section (shared tree)
 *   S1  bottom section: build pending (click/paint/backtrack), right-click focus
 *   S2  commit + top section operate: focus, hide (purple), edit mode, rename
 *   S3  3D: plain-click focus; Ctrl+left subgroup / Ctrl+right point select;
 *       both surfaces build the SAME pending set; Create/Done button
 *   S4  undo (Ctrl+Z) & Escape chains
 *   S5  visuals: green pulse, yellow flash, hidden-wins, brackets (+ drag)
 *   S6  layout sanity: docking preserved, no auto-scroll from 3D actions
 *   S9  command layer: `view <expr>` is INDISTINGUISHABLE from the equivalent
 *       focus gesture (same camera tween, same flash, same row feedback)
 *   S10 flash-parity matrix: for every command shape (term count/kind/level,
 *       both panel surfaces) the flashed rows == mounted rows intersecting
 *       the resolved point set — exactly, no missing term, no extra rows
 *   S11 create_sele — the mutation template: commits are structurally
 *       IDENTICAL to the equivalent build+Create-selection gesture (entries,
 *       levels, members, brackets), one undo removes them cleanly, edit mode
 *       is irrelevant, collisions error without mutating
 *   S12 hide/show — commit-then-hide as ONE undo unit ≡ the build+commit+
 *       header-hide gestures; whole/member/coarse-subset hides; show inverts
 *       each and never commits; the show-wins masked hide reports honestly
 *
 * Screenshots + [PASS]/[FAIL] lines; evidence in reports/redesign/.
 * Run from viewer/ (after npm run build):  node tests/redesign.ts [S0 S1 ...]
 */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { figureAxesYSpan, figureContentRect, figureFrameToPx } from "../webview/plotmodel.ts";
import { E2EDriver, sleep } from "./e2e_driver.ts";

const REPORT = "reports/redesign";
const V = "window.__viewer";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

// -- state probes --------------------------------------------------------------
const pendingEntries = (d: E2EDriver) => d.evaluate<number>(`${V}.model.pending.entryCount`);
const targetEntries = (d: E2EDriver) => d.evaluate<number>(`${V}.model.target.entryCount`);
const selCount = (d: E2EDriver) => d.evaluate<number>(`${V}.debug.selCount()`);
const visibleCount = (d: E2EDriver) => d.evaluate<number>(`${V}.debug.visibleCount()`);
const flashCount = (d: E2EDriver) => d.evaluate<number>(`${V}.debug.flashCount()`);
/** THE flash-pulse read (harness chapter): the focus flash is a bounded
 * ~900ms envelope. A fixed sleep + one flashCount() hop misses it when the
 * gesture's CDP events arrive late under load (S1/S2/S9's ledgered family).
 * Poll IN-PAGE until the flash count satisfies `pred` (a boolean expression
 * over `f`, the live count) — the pulse jumps STRAIGHT to its value and
 * holds, so it never transits an intermediate count; polling catches it
 * anywhere in the window instead of at one uncontrolled instant. Returns
 * `ok` (same claim as the inline comparison) plus the observed `peak` for
 * the detail. Negatives (asserting NO pulse, f === 0) must NOT use this —
 * a stable zero is read once after a settle, not polled-until-true. */
const flashPoll = (d: E2EDriver, pred: string, timeoutMs = 2500) =>
  d.evaluate<{ ok: boolean; peak: number }>(`(async () => {
    let peak = 0; const t0 = performance.now();
    while (performance.now() - t0 < ${timeoutMs}) {
      const f = ${V}.debug.flashCount();
      if (f > peak) peak = f;
      if (${pred}) return { ok: true, peak };
      await new Promise(r => setTimeout(r, 40));
    }
    return { ok: false, peak };
  })()`);
const committed = (d: E2EDriver) =>
  d.evaluate<{ name: string; hidden: boolean; pts: number; entries: number; lane: number }[]>(
    `${V}.model.committed().map(c=>({name:c.name,hidden:c.hidden,pts:c.set.pointCount,entries:c.set.entryCount,lane:c.lane}))`,
  );
const editingName = (d: E2EDriver) => d.evaluate<string | null>(`${V}.model.editing?.name ?? null`);
const camPos = (d: E2EDriver) => d.evaluate<number[]>(`${V}.camera.position.toArray()`);
const camMoved = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-3;
/** Poll until the camera has MOVED away from pose `from` (harness chapter):
 * a focus click starts a tween that finishes on rendered frames, so under
 * CPU saturation a fixed sleep can sample mid-flight (or before the click
 * even lands). This waits for the effect — the same claim the camMoved
 * check makes, caught whenever the tween actually gets there. Returns the
 * settled pose; times out to the last pose (the check then goes red). */
const camMovedFrom = async (d: E2EDriver, from: number[], timeoutMs = 6000): Promise<number[]> => {
  const t0 = Date.now();
  let last = from;
  while (Date.now() - t0 < timeoutMs) {
    last = await camPos(d);
    if (camMoved(from, last)) return last;
    await sleep(80);
  }
  return last;
};
const btnText = (d: E2EDriver) =>
  d.evaluate<string>(`document.getElementById('commit-btn').textContent`);
const scrollTop = (d: E2EDriver) =>
  d.evaluate<number>(`document.getElementById('sidebar-content').scrollTop`);

/** Center of the first visible bottom-tree row whose text matches `re`. */
const bottomRow = (d: E2EDriver, re: string) =>
  d.evaluate<{ x: number; y: number; cls: string } | null>(`(()=>{
    const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
      .filter(r=>r.getBoundingClientRect().height>0);
    const el=rows.find(r=>${re}.test(r.textContent));
    if(!el) return null; const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, cls:el.className};
  })()`);
/** Center of the first visible top-section member row matching `re`. */
const topRow = (d: E2EDriver, re: string) =>
  d.evaluate<{ x: number; y: number } | null>(`(()=>{
    const rows=[...document.querySelectorAll('#selections .tree-row.selectable')]
      .filter(r=>r.getBoundingClientRect().height>0);
    const el=rows.find(r=>${re}.test(r.textContent));
    if(!el) return null; const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};
  })()`);
const selHead = (d: E2EDriver, re: string) =>
  d.evaluate<{ x: number; y: number; cls: string } | null>(`(()=>{
    const blocks=[...document.querySelectorAll('#selections .sel-block')];
    const el=blocks.find(b=>${re}.test(b.querySelector('.sel-name')?.textContent ?? ''));
    if(!el) return null; const r=el.querySelector('.sel-head').getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, cls:el.className};
  })()`);
const clickSelCtl = (d: E2EDriver, nameRe: string, ctlText: string) =>
  d.evaluate<boolean>(`(()=>{
    const blocks=[...document.querySelectorAll('#selections .sel-block')];
    const el=blocks.find(b=>${nameRe}.test(b.querySelector('.sel-name')?.textContent ?? ''));
    if(!el) return false;
    const btn=[...el.querySelectorAll('.sel-ctl')].find(b=>b.textContent===${JSON.stringify(ctlText)});
    if(!btn) return false; btn.click(); return true;
  })()`);
const expandBottomCategory = (d: E2EDriver, re: string) =>
  d.evaluate<boolean>(`(()=>{
    const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')];
    const el=rows.find(r=>${re}.test(r.textContent));
    if(!el) return false; el.querySelector('.caret').click(); return true;
  })()`);
const pause = (d: E2EDriver) =>
  d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p && p.textContent==='pause')p.click();})()`);
/** Boot no longer auto-commits ANY selection (the auto-seeded bulk-category
 * prefabs are gone) — a scenario that exercises a committed "solvent"
 * selection creates it EXPLICITLY here, reproducing the old prefab shape
 * exactly: a visible committed selection named after the bulk category,
 * holding ONE category-level entry, NOT on the undo stack (model.seed is the
 * retained prefab API). The category id is read off the rendered tree row by
 * label, never hardcoded. */
const seedSolvent = async (d: E2EDriver): Promise<void> => {
  const ok = await d.evaluate<boolean>(`(()=>{
    const row=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
      .find(r=>r.dataset.level==='category' && /solvent/.test(r.textContent));
    if(!row) return false;
    ${V}.model.seed('solvent', [{level:'category', id:Number(row.dataset.id)}]);
    return true;
  })()`);
  if (!ok) throw new Error("seedSolvent: no solvent category row in the tree");
  await sleep(120); // the committed section re-renders on the model's emit
};
/** Count decidedly-green pixels within the 3D CANVAS region of a base64 PNG
 * (green-overlay evidence; excludes the panel's green row highlights). */
const greenCount = (d: E2EDriver, b64: string) =>
  d.evaluate<number>(`(async () => {
    const app = document.getElementById('app').getBoundingClientRect();
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    // crop below the commit button (top strip) so the green BUTTON never counts
    const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
      Math.round(app.width), Math.round(app.height) - 60).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i+1] > px[i] + 25 && px[i+1] >= px[i+2]) n++;
    }
    return n;
  })()`);

// E2E_PORT_BASE: the parallel runner gives each scenario CHILD PROCESS its own
// disjoint port range (bridge [base, base+8], CDP [base+300, base+308] per the
// +300 relation below). A plain serial run keeps the historical 9000 base.
let portBase = Number(process.env.E2E_PORT_BASE ?? 9000);
async function withDriver(
  fn: (d: E2EDriver) => Promise<void>,
  w = 1180,
  h = 780,
  route = "/", // "/terminal" serves the REAL terminal bundle over the viewer (S23)
): Promise<void> {
  portBase += 2;
  const d = new E2EDriver({
    bridgePort: portBase, cdpPort: portBase + 300, width: w, height: h,
    producerArgs: ["--n-points", "6000", "--n-frames", "150"],
  });
  try {
    await d.start();
    await d.navigate(route);
    // Settle = the CONDITION the old fixed 3200ms approximated: the seam
    // mounted and the stream live (first chunk cached), then two rendered
    // frames. Poll-until-condition — the common case returns in under a
    // second (measured ~0.84s to stream-live); the generous cap is a failure
    // detector, and under a starved render loop this is MORE correct than
    // any fixed duration, not just faster.
    await d.waitFor(`window.__viewer && window.__viewer.player.stats().cachedChunks > 0`, 20000);
    await d.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    await pause(d);
    await fn(d);
  } finally {
    await d.dispose();
  }
}

// ============================ S0: startup & mirror ===========================
async function S0(): Promise<void> {
  console.log("S0 — startup: all visible, NO auto-committed selections, flat top section");
  await withDriver(async (d) => {
    const list = await committed(d);
    check("S0: NO committed selections at startup (nothing auto-seeded)",
      list.length === 0, JSON.stringify(list));
    const vis = await visibleCount(d);
    check("S0: nothing is hidden by default — the user decides", vis === 6000, `visible=${vis}`);
    check("S0: pending target starts empty", (await pendingEntries(d)) === 0);
    check("S0: commit button disabled while pending is empty",
      await d.evaluate<boolean>(`document.getElementById('commit-btn').disabled`));

    // create the bulk selection EXPLICITLY (boot no longer seeds it) —
    // then one right-click on it hides the environment
    await seedSolvent(d);
    const seeded = await committed(d);
    check("S0: the explicitly created bulk selection commits, VISIBLE, category name",
      seeded.length === 1 && seeded[0]?.name === "solvent" && seeded[0]?.hidden === false,
      JSON.stringify(seeded));
    const head0 = (await selHead(d, "/solvent/"))!;
    await d.rightClick(head0.x, head0.y);
    await sleep(150);
    check("S0: one action hides the bulk environment",
      (await visibleCount(d)) === 6000 - seeded[0].pts, `visible=${await visibleCount(d)}`);
    const head = await selHead(d, "/solvent/");
    check("S0: hidden selection turns purple",
      head !== null && /hidden-sel/.test(head.cls), head?.cls ?? "missing");
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')][0];
      b.querySelector('.caret').click();
    })()`);
    await sleep(150);
    const topRows = await d.evaluate<{ level: string; caret: string; label: string }[]>(`
      [...document.querySelectorAll('#selections .tree-row.selectable')].map(r=>({
        level: r.dataset.level, caret: r.querySelector('.caret').textContent,
        label: r.querySelector('.tree-label').textContent }))`);
    check("S0: members listed FLAT at their own level (one category entry)",
      topRows.length === 1 && topRows[0].level === "category" && /solvent/.test(topRows[0].label),
      JSON.stringify(topRows));
    check("S0: member rows have no expansion", topRows[0]?.caret === "", JSON.stringify(topRows[0]));
    await d.screenshot(`${REPORT}/S0_startup.png`);
  });
}

// ============================ S1: bottom build ================================
async function S1(): Promise<void> {
  console.log("S1 — bottom section: build pending (click / paint / backtrack / focus)");
  await withDriver(async (d) => {
    // left-click a category row → toggle into pending, green
    const alpha = (await bottomRow(d, "/^▸?\\s*alpha/"))!;
    await d.click(alpha.x, alpha.y);
    await sleep(120);
    check("S1: click adds the entry to the pending target", (await pendingEntries(d)) === 1);
    const sc = await selCount(d);
    check("S1: green footprint = the entry's points", sc > 0, `selCount=${sc}`);
    const alphaAfter = (await bottomRow(d, "/^▸?\\s*alpha/"))!;
    check("S1: row is marked covered (static green class)", /sel-covered/.test(alphaAfter.cls), alphaAfter.cls);
    // ONE standard motion: state colors are static (no keyframe animation to
    // replay on scroll-in/expand) and move through the shared bg transition
    const motion = await d.evaluate<{ anim: string; trans: string }>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.sel-covered')];
      const s=getComputedStyle(rows[0]);
      return {anim:s.animationName, trans:s.transitionProperty+" "+s.transitionDuration};
    })()`);
    check("S1: selected rows are STATIC (no animation to replay on remount)",
      motion.anim === "none", motion.anim);
    check("S1: ...and enter/leave via the standard transition",
      /background-color|all/.test(motion.trans), motion.trans);
    const pendingBracket = await d.evaluate<boolean>(`!!document.querySelector('.bracket.pending')`);
    check("S1: pending bracket appears in the tree gutter", pendingBracket);
    await d.screenshot(`${REPORT}/S1_pending_green.png`);

    // click again → toggle off
    await d.click(alpha.x, alpha.y);
    await sleep(120);
    check("S1: click again removes it (toggle)", (await pendingEntries(d)) === 0);

    // paint alpha→beta→gamma, then drag BACK to beta: gamma un-paints
    const beta = (await bottomRow(d, "/beta/"))!;
    const gamma = (await bottomRow(d, "/gamma/"))!;
    const solvent = (await bottomRow(d, "/solvent/"))!;
    await d.mouse("mousePressed", alpha.x, alpha.y, { clickCount: 1 });
    await d.mouse("mouseMoved", beta.x, beta.y, { buttons: 1 });
    await d.mouse("mouseMoved", gamma.x, gamma.y, { buttons: 1 });
    await d.mouse("mouseMoved", beta.x, beta.y, { buttons: 1 });
    await d.mouse("mouseReleased", beta.x, beta.y, { clickCount: 1 });
    await sleep(120);
    check("S1: paint forward adds, dragging back un-paints the tail",
      (await pendingEntries(d)) === 2, `entries=${await pendingEntries(d)}`);

    // painting OVER an already-selected row never destroys it on backtrack
    await d.mouse("mousePressed", gamma.x, gamma.y, { clickCount: 1 });
    await d.mouse("mouseMoved", beta.x, beta.y, { buttons: 1 });
    await d.mouse("mouseMoved", gamma.x, gamma.y, { buttons: 1 });
    await d.mouse("mouseReleased", gamma.x, gamma.y, { clickCount: 1 });
    await sleep(120);
    check("S1: backtrack only un-paints what THIS stroke added",
      (await pendingEntries(d)) === 3, `entries=${await pendingEntries(d)}`);

    // REMOVE by painting: a drag STARTING on a selected row un-paints what it
    // crosses — and a FAST drag (one jump straight to the last row) must not
    // skip the rows in between (path interpolation).
    await d.mouse("mousePressed", alpha.x, alpha.y, { clickCount: 1 });
    await d.mouse("mouseMoved", solvent.x, solvent.y, { buttons: 1 }); // one fast jump
    await d.mouse("mouseReleased", solvent.x, solvent.y, { clickCount: 1 });
    await sleep(120);
    check("S1: drag from a selected row REMOVES along the path (fast drag skips nothing)",
      (await pendingEntries(d)) === 0, `entries=${await pendingEntries(d)}`);

    // one Ctrl+Z per stroke (the remove-stroke restores all three at once)
    await d.ctrlZ();
    await sleep(100);
    check("S1: the remove stroke undoes as one unit", (await pendingEntries(d)) === 3,
      `entries=${await pendingEntries(d)}`);
    await d.ctrlZ();
    await sleep(100);
    await d.ctrlZ();
    await sleep(100);
    check("S1: each add stroke undoes as one unit", (await pendingEntries(d)) === 0,
      `entries=${await pendingEntries(d)}`);

    // CARVE: select coarse (alpha), drill deeper, unselect a covered subgroup
    // — the green and the bracket must visibly break around the hole
    await d.click(alpha.x, alpha.y); // pending = category alpha (400 pts)
    await sleep(100);
    await expandBottomCategory(d, "/alpha/");
    await sleep(120);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const grp=rows.find(r=>r.dataset.level==='group');
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    const covSub = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const el=rows.find(r=>r.dataset.level==='subgroup' && r.classList.contains('sel-covered'));
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    check("S1: drilled to a covered subgroup row", covSub !== null);
    await d.click(covSub!.x, covSub!.y); // unselect INSIDE the coarse selection
    await sleep(200);
    check("S1: carving removes exactly the clicked subgroup's points",
      (await selCount(d)) === 300, `selCount=${await selCount(d)}`);
    const hole = await d.evaluate<{ covered: boolean; bracketOverlaps: boolean }>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const el=rows.find(r=>Math.abs(r.getBoundingClientRect().top+9-(${covSub!.y}))<3);
      const cy=${covSub!.y};
      const bracketOverlaps=[...document.querySelectorAll('.bracket.pending')]
        .some(b=>{const br=b.getBoundingClientRect(); return br.top<cy && br.bottom>cy;});
      return {covered: el ? el.classList.contains('sel-covered') : true, bracketOverlaps};
    })()`);
    check("S1: the carved row loses its green highlight", !hole.covered);
    check("S1: the bracket breaks around the carved hole", !hole.bracketOverlaps);
    await d.screenshot(`${REPORT}/S1_carved_hole.png`);
    await d.ctrlZ(); // one undo restores the coarse entry exactly
    await sleep(150);
    check("S1: carve undoes as one unit", (await selCount(d)) === 400 &&
      (await pendingEntries(d)) === 1, `selCount=${await selCount(d)}`);
    await d.escape();
    await sleep(100);
    await expandBottomCategory(d, "/alpha/"); // collapse back for stable row rects
    await sleep(150);

    // right-click = focus (camera moves, light pulse, NO selection change)
    const before = await camPos(d);
    await d.rightClick(gamma.x, gamma.y);
    await sleep(600);
    check("S1: right-click focuses the camera on the entry", camMoved(before, await camMovedFrom(d, before)));
    check("S1: right-click never changes the selection", (await pendingEntries(d)) === 0);
    // family retrofit: poll the bounded pulse (keeps the sleep above for the
    // camera tween; flashPoll keeps watching past it if the gesture lagged)
    const p1 = await flashPoll(d, "f > 0");
    check("S1: focus plays a pulse over the region", p1.ok, `flash peak=${p1.peak}`);
    await d.screenshot(`${REPORT}/S1_focus_flash.png`);

    // right-DRAG = view a region: focuses the union of the dragged rows
    const before2 = await camPos(d);
    // retry the drag-pick until its pulse registers (gesture may not land
    // under CPU saturation); re-dragging the same region is idempotent
    let p2 = { ok: false, peak: 0 };
    for (let attempt = 0; attempt < 4 && !p2.ok; attempt++) {
      await d.drag(beta.x, beta.y, gamma.x, gamma.y, 4, { button: "right" });
      p2 = await flashPoll(d, "f >= 800");
    }
    check("S1: right-drag focuses the dragged region", camMoved(before2, await camMovedFrom(d, before2)));
    check("S1: region focus pulses BOTH rows' points", p2.ok, `flash peak=${p2.peak}`);
    check("S1: right-drag changes no selection", (await pendingEntries(d)) === 0);

    // ...and dragging BACK shortens the region (same as the left trail)
    await d.mouse("mousePressed", beta.x, beta.y, { button: "right", buttons: 2 });
    await d.mouse("mouseMoved", gamma.x, gamma.y, { buttons: 2 });
    await d.mouse("mouseMoved", beta.x, beta.y, { buttons: 2 });
    await d.mouse("mouseReleased", beta.x, beta.y, { button: "right" });
    // (review fix) no sleep here — it burned 600ms of the 900ms pulse
    // before the poll even started watching
    const p3 = await flashPoll(d, "f === 400");
    check("S1: right-drag back SHORTENS the region (only the surviving row focuses)",
      p3.ok, `flash peak=${p3.peak}`);
  });
}

// ============================ S2: commit & operate ============================
async function S2(): Promise<void> {
  console.log("S2 — commit; top section: focus / hide / edit / rename");
  await withDriver(async (d) => {
    await seedSolvent(d); // the bulk selection the scenario's indices assume
    // build + commit
    const alpha = (await bottomRow(d, "/alpha/"))!;
    await d.click(alpha.x, alpha.y);
    await sleep(100);
    check("S2: commit button enabled with a pending selection",
      !(await d.evaluate<boolean>(`document.getElementById('commit-btn').disabled`)));
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(150);
    let list = await committed(d);
    check("S2: Create selection commits the pending set", list.length === 2 && list[1].name === "selection_1",
      JSON.stringify(list.map((c) => c.name)));
    check("S2: green clears after commit", (await selCount(d)) === 0);
    check("S2: pending empty after commit", (await pendingEntries(d)) === 0);
    await d.screenshot(`${REPORT}/S2_committed.png`);

    // top section: expand the committed selection; left-click a member row = focus
    await d.evaluate(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const b=blocks.find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      b.querySelector('.caret').click();
    })()`);
    await sleep(150);
    const member = await topRow(d, "/alpha/");
    check("S2: committed selection expands through the shared tree", member !== null);
    const before = await camPos(d);
    await d.click(member!.x, member!.y);
    await sleep(600);
    check("S2: top left-click focuses the camera (yellow pulse)", camMoved(before, await camMovedFrom(d, before)));
    check("S2: top left-click changes no selection state", (await committed(d))[1].entries === 1);

    // right-click the block = hide (purple, invisible); camera does NOT move
    const visBefore = await visibleCount(d);
    const camBefore = await camPos(d);
    const head = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(head.x, head.y);
    await sleep(150);
    list = await committed(d);
    check("S2: right-click hides the selection", list[1].hidden === true);
    const visAfter = await visibleCount(d);
    check("S2: its points become invisible", visAfter === visBefore - list[1].pts,
      `${visBefore}→${visAfter} (pts=${list[1].pts})`);
    check("S2: hide does not move the camera", !camMoved(camBefore, await camPos(d)));
    const headHidden = (await selHead(d, "/selection_1/"))!;
    check("S2: hidden label turns purple (class)", /hidden-sel/.test(headHidden.cls), headHidden.cls);
    await d.screenshot(`${REPORT}/S2_hidden_purple.png`);
    await d.rightClick(headHidden.x, headHidden.y);
    await sleep(150);
    check("S2: right-click again un-hides", (await visibleCount(d)) === visBefore);

    // edit mode: manipulations target the committed selection; button = Done
    check("S2: edit control enters edit mode", await clickSelCtl(d, "/selection_1/", "edit"));
    await sleep(150);
    check("S2: editing redirects the target", (await editingName(d)) === "selection_1");
    check("S2: commit button reads Done", (await btnText(d)) === "Done");
    check("S2: edited selection's footprint shows green", (await selCount(d)) > 0);
    // while editing, the member list has a FIXED height so adds/removes never
    // shift the tree below (no more mid-drag row jumping)
    const editBody = await d.evaluate<{ h: number; of: string }>(`(()=>{
      const b=document.querySelector('.sel-block.editing .sel-body');
      const s=getComputedStyle(b);
      return {h: b.getBoundingClientRect().height, of: s.overflowY};
    })()`);
    check("S2: editing member list is fixed-height and scrollable",
      Math.abs(editBody.h - 160) < 2 && editBody.of === "auto", JSON.stringify(editBody));
    const beta = (await bottomRow(d, "/beta/"))!;
    const gammaYBefore = (await bottomRow(d, "/gamma/"))!.y;
    await d.click(beta.x, beta.y);
    await sleep(150);
    check("S2: bottom clicks now add to the edited selection",
      (await committed(d))[1].entries === 2);
    const gammaYAfter = (await bottomRow(d, "/gamma/"))!.y;
    check("S2: adding a member does NOT shift the tree rows below",
      gammaYAfter === gammaYBefore, `y ${gammaYBefore}→${gammaYAfter}`);
    // camera is PARKED while editing: focus actions pulse but never move it
    const camEdit = await camPos(d);
    const memberEdit = (await topRow(d, "/beta/"))!;
    await d.click(memberEdit.x, memberEdit.y);
    await sleep(600);
    check("S2: focus does not move the camera while editing",
      !camMoved(camEdit, await camPos(d)));
    const p2pulse = await flashPoll(d, "f > 0");
    check("S2: ...but still pulses the region", p2pulse.ok, `flash peak=${p2pulse.peak}`);
    // member rows grow a remove control in edit mode
    const removed = await d.evaluate<boolean>(`(()=>{
      const rm=document.querySelector('#selections .entry-remove');
      if(!rm) return false; rm.click(); return true;
    })()`);
    await sleep(120);
    check("S2: members removable in edit mode (✕)", removed && (await committed(d))[1].entries === 1);
    const btn2 = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn2.x, btn2.y); // Done
    await sleep(120);
    check("S2: Done exits edit mode", (await editingName(d)) === null);
    check("S2: button reads Create selection again", (await btnText(d)) === "Create selection");
    // focus moves the camera again once editing is done
    const camDone = await camPos(d);
    const memberDone = (await topRow(d, "/beta|alpha/"))!;
    await d.click(memberDone.x, memberDone.y);
    await sleep(600);
    check("S2: focus moves the camera again after Done", camMoved(camDone, await camMovedFrom(d, camDone)));

    // rename inline (unique names); bracket label follows
    await d.evaluate(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const b=blocks.find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      const name=b.querySelector('.sel-name');
      name.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    })()`);
    await sleep(100);
    await d.evaluate(`(()=>{const i=document.querySelector('.rename-input'); i.value='core';})()`);
    await d.evaluate(`(()=>{
      const i=document.querySelector('.rename-input');
      i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    })()`);
    await sleep(150);
    list = await committed(d);
    check("S2: inline rename applies", list[1].name === "core", JSON.stringify(list.map((c) => c.name)));
    const bracketTitles = await d.evaluate<string>(
      `[...document.querySelectorAll('.bracket')].map(b=>b.title).join(',')`);
    check("S2: bracket keeps the new name in its tooltip (no clunky label)",
      /core/.test(bracketTitles), bracketTitles);
    check("S2: no name labels rendered on brackets",
      await d.evaluate<number>(`document.querySelectorAll('.bracket-name').length`) === 0);
    await d.screenshot(`${REPORT}/S2_renamed.png`);
  });
}

// ============================ S3: 3D gestures =================================
async function S3(): Promise<void> {
  console.log("S3 — 3D: click-focus; Ctrl+left subgroup / Ctrl+right point; commit button");
  await withDriver(async (d) => {
    await seedSolvent(d); // the bulk selection the framing detour hides
    const pIdx = await d.evaluate<number>(`${V}.hierarchy.pointsOf({level:'category',id:0})[0]`);
    const proj = await d.evaluate<{ x: number; y: number; front: boolean }>(
      `${V}.debug.projectPoint(${pIdx})`);
    check("S3: probe point projects on-screen", proj.front, JSON.stringify(proj));

    // plain left-click = focus only (yellow pulse), never a selection
    const dist = () =>
      d.evaluate<number>(`${V}.camera.position.distanceTo(${V}.controls.target)`);
    const d0 = await dist(); // home framing distance
    const scrollBefore = await scrollTop(d);
    const camBefore = await camPos(d);
    await d.click(proj.x, proj.y);
    // The flash FLAGS are set synchronously by the click — sample them FIRST.
    // The 900ms one-shot envelope can legally expire during the tween wait
    // below (each CDP round-trip can cost hundreds of ms on a busy page); the
    // old fixed boot settle merely dodged the post-boot busy window that
    // exposes the race. Same assertion, sampled while the asserted state
    // exists — the one-shot-probe family's standard retrofit.
    const pulseCovered = (await flashCount(d)) > 1;
    check("S3: plain click focuses the subgroup (camera orients)", camMoved(camBefore, await camMovedFrom(d, camBefore)));
    // REVIEW FIX (governing rule): the two NEGATIVE checks below claim
    // "nothing happened" — they need the original >=600ms post-click window,
    // not a sample at first camera motion (camMovedFrom returns in ~30ms; a
    // late selection change or auto-scroll between then and 600ms was
    // previously caught deterministically). Sampling LATER only widens what
    // a negative can catch.
    await sleep(600);
    check("S3: plain click selects nothing", (await pendingEntries(d)) === 0);
    check("S3: focus pulse covers the subgroup", pulseCovered);
    check("S3: no auto-scroll of the panel from 3D actions", (await scrollTop(d)) === scrollBefore);
    // poll for the zoom-in tween to REACH the target distance (camMovedFrom
    // returns on first movement; the zoom continues past it) — under load a
    // fixed sleep samples mid-flight
    await d.waitFor(`${V}.camera.position.distanceTo(${V}.controls.target) < ${d0 * 0.8}`, 6000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const d1 = await dist();
    check("S3: focus zoomed in", d1 < d0 * 0.8, `${d1.toFixed(1)} vs home ${d0.toFixed(1)}`);
    await d.screenshot(`${REPORT}/S3_click_focus.png`);

    // plain click on EMPTY space zooms back out to the whole scene
    const empty = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const r=document.getElementById('app').getBoundingClientRect();
      const spots=[[r.left+20,r.bottom-20],[r.left+20,r.top+80],[r.right-20,r.bottom-20]];
      for (const [x,y] of spots) if (${V}.debug.pick(x,y) < 0) return {x,y};
      return null;
    })()`);
    check("S3: found an empty pixel to click", empty !== null);
    if (empty) {
      await d.click(empty.x, empty.y);
      // poll for the zoom-OUT tween to reach home framing, not a fixed 700ms
      await d.waitFor(`${V}.camera.position.distanceTo(${V}.controls.target) > ${d0 * 0.85}`, 6000)
        .catch(() => { /* timeout falls through — the check below goes red */ });
      const d2 = await dist();
      check("S3: empty click zooms back out (whole-scene framing)",
        d2 > d0 * 0.85, `${d2.toFixed(1)} vs home ${d0.toFixed(1)}`);
      check("S3: empty click selects nothing", (await pendingEntries(d)) === 0);
    }

    // with parts hidden, an empty click frames just what is VISIBLE: hide the
    // bulk AND beta+gamma so only alpha remains, then check the camera centers
    // on the visible centroid at a tighter distance
    const solHead = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solHead.x, solHead.y); // hide the bulk
    await sleep(200);
    const betaRow = (await bottomRow(d, "/beta/"))!;
    const gammaRow = (await bottomRow(d, "/gamma/"))!;
    await d.click(betaRow.x, betaRow.y);
    await d.click(gammaRow.x, gammaRow.y);
    await sleep(100);
    const btn2 = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn2.x, btn2.y);
    await sleep(150);
    const bgHead = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(bgHead.x, bgHead.y); // hide beta+gamma
    await sleep(200);
    const empty2 = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const r=document.getElementById('app').getBoundingClientRect();
      const spots=[[r.left+20,r.bottom-20],[r.left+20,r.top+80],[r.right-20,r.bottom-20]];
      for (const [x,y] of spots) if (${V}.debug.pick(x,y) < 0) return {x,y};
      return null;
    })()`);
    if (empty2) {
      await d.click(empty2.x, empty2.y);
      // poll for the frame-to-visible tween to center on the visible centroid
      // (review fix) the poll mirrors BOTH checks below: centroid AND the
      // fit-to-visible distance — the dolly can still be converging after
      // the target centers
      await d.waitFor(`(()=>{ const b=${V}.debug.visibleBounds(); const t=${V}.controls.target;
        const off=Math.hypot(t.x-b.center[0], t.y-b.center[1], t.z-b.center[2]);
        const fov=(${V}.camera.fov*Math.PI)/180;
        const dist=${V}.camera.position.distanceTo(t);
        const want=b.radius/Math.sin(fov/2)*1.4;
        return off < ${d0 * 0.1} && Math.abs(dist-want) < want*0.15; })()`, 6000)
        .catch(() => { /* timeout falls through — the check below goes red */ });
      const framed = await d.evaluate<{ off: number; dist: number; want: number }>(`(()=>{
        const b=${V}.debug.visibleBounds();
        const t=${V}.controls.target;
        const off=Math.hypot(t.x-b.center[0], t.y-b.center[1], t.z-b.center[2]);
        const fov=(${V}.camera.fov*Math.PI)/180;
        return {off, dist:${V}.camera.position.distanceTo(t),
                want: b.radius/Math.sin(fov/2)*1.4};
      })()`);
      check("S3: empty click centers on the VISIBLE centroid",
        framed.off < d0 * 0.1, `off=${framed.off.toFixed(2)} (home dist ${d0.toFixed(1)})`);
      check("S3: ...at the fit-to-visible distance (frames only what is shown)",
        Math.abs(framed.dist - framed.want) < framed.want * 0.15,
        `dist=${framed.dist.toFixed(1)} vs fit ${framed.want.toFixed(1)}`);
    } else {
      check("S3: (skipped visible-framing — no empty pixel found)", true);
    }
    // unwind the five state changes (hide, 2 clicks, commit, hide) so the
    // rest of the scenario starts from the untouched startup state
    for (let i = 0; i < 5; i++) {
      await d.ctrlZ();
      await sleep(80);
    }
    check("S3: framing detour fully undone",
      (await committed(d)).length === 1 && (await visibleCount(d)) === 6000 &&
        (await pendingEntries(d)) === 0,
      `committed=${(await committed(d)).length} visible=${await visibleCount(d)}`);

    // Ctrl+left-click = subgroup-level select into the pending target
    const proj2 = await d.evaluate<{ x: number; y: number }>(`${V}.debug.projectPoint(${pIdx})`);
    await d.click(proj2.x, proj2.y, 1, 2 /* Ctrl */);
    await sleep(150);
    let entries = await d.evaluate<{ level: string; id: number }[]>(
      `${V}.model.pending.listEntries()`);
    check("S3: Ctrl+left selects at SUBGROUP level", entries.length === 1 && entries[0].level === "subgroup",
      JSON.stringify(entries));
    const subPts = await selCount(d);
    check("S3: whole subgroup turns green", subPts > 1, `selCount=${subPts}`);

    // Ctrl+right-click = POINT-level select into the SAME pending set — on an
    // UNCOVERED point (a covered one would correctly carve instead); the probe
    // verifies the pick lands exactly on the intended point
    const q = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const pts=${V}.hierarchy.pointsOf({level:'category',id:1});
      for (const p of pts) {
        const pr=${V}.debug.projectPoint(p);
        if (!pr.front) continue;
        if (${V}.debug.pick(pr.x, pr.y) === p) return {x:pr.x, y:pr.y};
      }
      return null;
    })()`);
    check("S3: found a pickable uncovered point", q !== null);
    await d.rightClick(q!.x, q!.y, 2 /* Ctrl */);
    await sleep(150);
    entries = await d.evaluate<{ level: string; id: number }[]>(`${V}.model.pending.listEntries()`);
    check("S3: Ctrl+right adds a POINT-level entry to the SAME pending set",
      entries.length === 2 && entries.some((e) => e.level === "point"), JSON.stringify(entries));

    // bottom section adds to the SAME pending selection
    const gamma = (await bottomRow(d, "/gamma/"))!;
    await d.click(gamma.x, gamma.y);
    await sleep(120);
    const n3 = await pendingEntries(d);
    check("S3: 3D and bottom section build ONE pending selection", n3 >= 2, `entries=${n3}`);
    await d.screenshot(`${REPORT}/S3_ctrl_select.png`);

    // camera drag with Ctrl must NOT orbit (paint instead); without Ctrl it orbits
    const camA = await camPos(d);
    await d.drag(proj2.x - 30, proj2.y - 30, proj2.x + 30, proj2.y + 30, 8, { modifiers: 2 });
    await sleep(150);
    check("S3: Ctrl+drag paints, does not orbit", !camMoved(camA, await camPos(d)));
    await d.drag(proj2.x - 40, proj2.y, proj2.x + 60, proj2.y + 40, 8);
    await sleep(200);
    check("S3: plain drag still orbits", camMoved(camA, await camPos(d)));

    // Create selection commits everything built from both surfaces
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(150);
    const list = await committed(d);
    check("S3: commit creates the top entry and clears green",
      list.length === 2 && (await selCount(d)) === 0, JSON.stringify(list.map((c) => c.name)));
  });
}

// ============================ S4: undo & escape ===============================
async function S4(): Promise<void> {
  console.log("S4 — system-wide undo (Ctrl+Z) and Escape");
  await withDriver(async (d) => {
    await seedSolvent(d); // the bulk selection the scenario's indices assume
    const alpha = (await bottomRow(d, "/alpha/"))!;
    const beta = (await bottomRow(d, "/beta/"))!;

    // chain: add → commit → hide → rename, then unwind with 4× Ctrl+Z
    await d.click(alpha.x, alpha.y);
    await sleep(100);
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(120);
    const head = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(head.x, head.y); // hide
    await sleep(120);
    await d.evaluate(`${V}.model.rename(${await d.evaluate<number>(
      `${V}.model.committed()[1].id`)}, 'renamed')`);
    await sleep(80);

    let list = await committed(d);
    check("S4: setup state (committed, hidden, renamed)",
      list.length === 2 && list[1].hidden && list[1].name === "renamed", JSON.stringify(list));

    await d.ctrlZ(); await sleep(100); // undo rename
    list = await committed(d);
    check("S4: undo 1 reverts the rename", list[1]?.name === "selection_1", JSON.stringify(list));
    await d.ctrlZ(); await sleep(100); // undo hide
    list = await committed(d);
    check("S4: undo 2 reverts the hide (points visible again)",
      list[1]?.hidden === false && (await visibleCount(d)) > 0, JSON.stringify(list));
    await d.ctrlZ(); await sleep(100); // undo commit
    check("S4: undo 3 reverts the commit (pending restored green)",
      (await committed(d)).length === 1 && (await pendingEntries(d)) === 1 && (await selCount(d)) > 0);
    await d.ctrlZ(); await sleep(100); // undo the original add
    check("S4: undo 4 reverts the build edit", (await pendingEntries(d)) === 0 && (await selCount(d)) === 0);

    // Escape discards pending (undoable)
    await d.click(beta.x, beta.y);
    await sleep(100);
    await d.escape();
    await sleep(100);
    check("S4: Escape clears the pending target", (await pendingEntries(d)) === 0);
    await d.ctrlZ(); await sleep(100);
    check("S4: the Escape-clear is itself undoable", (await pendingEntries(d)) === 1);
    await d.escape(); await sleep(80);

    // Escape exits edit mode without committing
    await d.click(alpha.x, alpha.y); await sleep(80);
    await d.click(btn.x, btn.y); await sleep(120);
    await clickSelCtl(d, "/selection_1/", "edit");
    await sleep(100);
    check("S4: in edit mode", (await editingName(d)) !== null);
    await d.escape();
    await sleep(100);
    check("S4: Escape exits edit mode", (await editingName(d)) === null);
    check("S4: the selection survives (Escape ≠ delete)", (await committed(d)).length === 2);
    await d.screenshot(`${REPORT}/S4_undo_escape.png`);
  });
}

// ============================ S5: visuals =====================================
async function S5(): Promise<void> {
  console.log("S5 — pulses, hidden-wins, brackets");
  await withDriver(async (d) => {
    await seedSolvent(d); // the bulk selection hidden-wins right-clicks
    // green pulse breathes: uStrength swings over half a period
    const alpha = (await bottomRow(d, "/alpha/"))!;
    await d.click(alpha.x, alpha.y);
    await sleep(150);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push((await d.evaluate<{ sel: number }>(`${V}.debug.pulse()`)).sel);
      await sleep(200);
    }
    const spread = Math.max(...samples) - Math.min(...samples);
    check("S5: the green overlay pulses (strength animates)", spread > 0.15,
      `samples ${samples.map((s) => s.toFixed(2)).join(",")}`);
    const shotA = await d.captureB64(`${REPORT}/S5_pulse_a.png`);
    await sleep(400);
    const shotB = await d.captureB64(`${REPORT}/S5_pulse_b.png`);
    const gA = await greenCount(d, shotA);
    const gB = await greenCount(d, shotB);
    check("S5: green glow visible in the viewport", Math.max(gA, gB) > 200, `green px ${gA}/${gB}`);

    // yellow focus flash: swells then fades fully. Family retrofit (harness
    // chapter item 1): the swell is a bounded envelope — watch it IN-PAGE
    // instead of gambling a fixed sleep + CDP hop against the 900ms pulse;
    // the fade is then polled to zero (the old sleep(900) asserted "zero at
    // an uncontrolled instant after hops" — same eventual claim, reliable).
    const beta = (await bottomRow(d, "/beta/"))!;
    await d.rightClick(beta.x, beta.y);
    const swell = await d.evaluate<number>(`(async () => {
      let peak = 0; const t0 = performance.now();
      while (performance.now() - t0 < 2500) {
        peak = Math.max(peak, ${V}.debug.pulse().flash);
        if (peak > 0.2) break;
        await new Promise(r => setTimeout(r, 30));
      }
      return peak;
    })()`);
    check("S5: focus flash active mid-pulse", swell > 0.2, `flash=${swell.toFixed(2)}`);
    await d.screenshot(`${REPORT}/S5_flash_mid.png`);
    await d.waitFor(`${V}.debug.pulse().flash === 0 && ${V}.debug.flashCount() === 0`, 6000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const f2 = await d.evaluate<{ flash: number }>(`${V}.debug.pulse()`);
    check("S5: focus flash fades out fully", f2.flash === 0 && (await flashCount(d)) === 0,
      `flash=${f2.flash}`);

    // hidden wins: hide the bulk selection first, then selecting it shows NO
    // green in 3D (the tint is gated on visibility)
    await d.escape();
    await sleep(100);
    const solventHead = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solventHead.x, solventHead.y);
    await sleep(200);
    const clean = await greenCount(d, await d.captureB64(`${REPORT}/S5_clean.png`));
    const solvent = (await bottomRow(d, "/solvent/"))!;
    await d.click(solvent.x, solvent.y);
    await sleep(200);
    const hiddenSel = await greenCount(d, await d.captureB64(`${REPORT}/S5_hidden_wins.png`));
    const selN = await selCount(d);
    check("S5: hidden selection is in the target (state)", selN > 1000, `selCount=${selN}`);
    check("S5: but hidden wins — no green tint for hidden points",
      hiddenSel < clean + 500, `green px ${hiddenSel} (clean ${clean})`);
    await d.escape();
    await sleep(100);
    const solventHead2 = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solventHead2.x, solventHead2.y); // un-hide again
    await sleep(150);

    // brackets: committed bracket present, movable by dragging its name
    await d.click(alpha.x, alpha.y);
    await sleep(80);
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(200);
    const brackets = await d.evaluate<{ titles: string; lanes: number[] }>(`(()=>{
      const bs=[...document.querySelectorAll('.bracket')];
      return { titles: bs.map(b=>b.title).join(','),
               lanes: ${V}.model.committed().map(c=>c.lane) };
    })()`);
    check("S5: committed bracket rendered in the gutter (name on hover)",
      /selection_1/.test(brackets.titles), brackets.titles);
    check("S5: overlapping selections auto-take distinct lanes",
      new Set(brackets.lanes).size === brackets.lanes.length, JSON.stringify(brackets.lanes));
    await d.screenshot(`${REPORT}/S5_brackets.png`);

    // a bracket shows only once the view is EXPANDED to its entries' level:
    // a subgroup-level pending selection has no bracket while collapsed
    await d.evaluate(`${V}.refreshPoints(${V}.model.addToTarget({level:'subgroup', id:0}))`);
    await sleep(200);
    check("S5: subgroup entry in the pending target",
      (await d.evaluate<string>(`${V}.model.pending.listEntries()[0]?.level ?? ''`)) === "subgroup");
    const collapsed = await d.evaluate<boolean>(`!!document.querySelector('.bracket.pending')`);
    check("S5: NO bracket while the tree is collapsed above the entry level", !collapsed);
    await expandBottomCategory(d, "/alpha/");
    await sleep(150);
    const midLevel = await d.evaluate<boolean>(`!!document.querySelector('.bracket.pending')`);
    check("S5: still no bracket at group level (subgroups not yet visible)", !midLevel);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const grp=rows.find(r=>r.dataset.level==='group');
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    const expanded = await d.evaluate<boolean>(`!!document.querySelector('.bracket.pending')`);
    check("S5: bracket appears once expanded down to the subgroup level", expanded);
    await d.screenshot(`${REPORT}/S5_bracket_on_expand.png`);
  });
}

// ============================ S7: sticky ancestors ============================
async function S7(): Promise<void> {
  console.log("S7 — ancestor rows pin while scrolling (collapse always reachable)");
  await withDriver(async (d) => {
    // expand the bulk category → its group → the 1,600-subgroup list
    await expandBottomCategory(d, "/solvent/");
    await sleep(150);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const grp=rows.find(r=>r.dataset.level==='group');
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    await d.evaluate(`document.getElementById('sidebar-content').scrollTop = 900`);
    await sleep(300);
    const pin = await d.evaluate<{ scroll: number; catTop: number; grpTop: number } | null>(`(()=>{
      const sc=document.getElementById('sidebar-content');
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const cat=rows.find(r=>r.dataset.level==='category' && /solvent/.test(r.textContent));
      const grp=rows.find(r=>r.dataset.level==='group');
      if(!cat||!grp) return null;
      const scTop=sc.getBoundingClientRect().top;
      return { scroll: sc.scrollTop,
        catTop: cat.getBoundingClientRect().top - scTop,
        grpTop: grp.getBoundingClientRect().top - scTop };
    })()`);
    check("S7: scrolled deep into the expanded subtree", pin !== null && pin.scroll > 700,
      JSON.stringify(pin));
    check("S7: category row stays pinned at the top", pin !== null && pin.catTop >= -1 && pin.catTop < 14,
      `catTop=${pin?.catTop}`);
    check("S7: group row pinned right below it", pin !== null && pin.grpTop >= 14 && pin.grpTop < 34,
      `grpTop=${pin?.grpTop}`);
    await d.screenshot(`${REPORT}/S7_sticky_scrolled.png`);
    // the pinned caret still collapses the whole category
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const cat=rows.find(r=>r.dataset.level==='category' && /solvent/.test(r.textContent));
      cat.querySelector('.caret').click();
    })()`);
    await sleep(200);
    const rowsAfter = await d.evaluate<number>(`
      [...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0).length`);
    check("S7: pinned caret collapses the subtree", rowsAfter <= 6, `${rowsAfter} rows visible`);

    // hold + WHEEL: scrolling while holding extends the paint smoothly — the
    // rows sliding under the stationary pointer join the trail, none skipped
    await expandBottomCategory(d, "/solvent/");
    await sleep(150);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      if (rows.some(r=>r.dataset.level==='subgroup')) return; // already open
      const grp=rows.find(r=>r.dataset.level==='group');
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    const subRow = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const sc=document.getElementById('sidebar-content').getBoundingClientRect();
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>{const b=r.getBoundingClientRect();
          return b.height>0 && b.top>=sc.top+40 && b.bottom<=sc.bottom-40;});
      const el=rows.find(r=>r.dataset.level==='subgroup');
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    check("S7: found an on-screen subgroup row to scroll-paint from", subRow !== null);
    // The engine's contract is "scrollTop moved + a scroll event" (tree.ts
    // onScrollCapture/processScroll); the wheel is only a vehicle. Headless
    // Chrome delivers both wheel-scrolls and programmatic scroll EVENTS on
    // lazy rendering steps, and the impostor passes' heavier first frames
    // shifted that timing enough to swallow ticks nondeterministically —
    // Chromium's delivery layer, not the engine under test. So the scroll
    // tick is delivered exactly per contract, synchronously (a late
    // duplicate browser event computes delta 0 and no-ops). The tested
    // semantics — rows sliding under the held pointer join the trail, a
    // second tick extends the same stroke, one undo — are unchanged.
    const scrollTick = () =>
      d.evaluate<number>(`(()=>{
        const s = document.getElementById('sidebar-content');
        s.scrollTop = s.scrollTop + 54; // ≈3 rows slide under the pointer
        s.dispatchEvent(new Event('scroll'));
        return s.scrollTop;
      })()`);
    await d.mouse("mousePressed", subRow!.x, subRow!.y, { clickCount: 1 });
    await sleep(200); // Input and Runtime pipelines are unordered — let the press land
    await scrollTick();
    await sleep(250);
    const midScroll = await pendingEntries(d);
    check("S7: rows joining under the pointer paint WHILE scrolling",
      midScroll >= 3, `entries=${midScroll}`);
    await scrollTick();
    await sleep(250);
    await d.mouse("mouseReleased", subRow!.x, subRow!.y, { clickCount: 1 });
    await sleep(150);
    const afterScroll = await pendingEntries(d);
    check("S7: a second scroll tick keeps extending the same stroke",
      afterScroll > midScroll, `entries=${afterScroll}`);
    await d.ctrlZ();
    await sleep(120);
    check("S7: the whole scroll-paint undoes as one stroke",
      (await pendingEntries(d)) === 0, `entries=${await pendingEntries(d)}`);
  });
}

// ============================ S6: layout sanity ===============================
async function S6(): Promise<void> {
  console.log("S6 — docking preserved with the new sections");
  await withDriver(async (d) => {
    const arrows: Record<string, string> = { right: "▸", left: "◂", top: "▴", bottom: "▾" };
    for (const pos of ["right", "top"] as const) {
      await d.evaluate(`${V}.panel.setDock(${JSON.stringify(pos)})`);
      await sleep(200);
      const a = await d.evaluate<string>(`document.getElementById('panel-collapse').textContent`);
      check(`S6: collapse arrow tracks dock=${pos}`, a === arrows[pos], JSON.stringify(a));
    }
    const flex = await d.evaluate<string>(
      `getComputedStyle(document.getElementById('sidebar-content')).flexDirection`);
    check("S6: top dock flows horizontally (selections column + tree row)", flex === "row", flex);
    const selVisible = await d.evaluate<boolean>(
      `document.getElementById('selections').getBoundingClientRect().width > 0`);
    check("S6: selections section visible when docked top", selVisible);
    await d.screenshot(`${REPORT}/S6_dock_top.png`);
    await d.evaluate(`${V}.panel.setDock('right')`);
    await sleep(200);
  });
}

// ============================ S8: refinements =================================
async function S8(): Promise<void> {
  console.log("S8 — split brackets, per-member hide, clear button, relayout");
  await withDriver(async (d) => {
    await seedSolvent(d); // the bulk selection the scenario's indices assume
    const alpha = (await bottomRow(d, "/alpha/"))!;
    const beta = (await bottomRow(d, "/beta/"))!;
    const gamma = (await bottomRow(d, "/gamma/"))!;

    // expandable carets have a forgiving hit box
    const caretW = await d.evaluate<number>(
      `document.querySelector('#tree-host .caret.exp').getBoundingClientRect().width`);
    check("S8: expandable carets have a generous hit box", caretW >= 18, `${caretW}px`);

    // non-contiguous coverage → the bracket SPLITS into segments
    // (clicked DELIBERATELY out of hierarchy order: gamma first, then alpha —
    // the committed member list must still sort into tree order)
    await d.click(gamma.x, gamma.y);
    await sleep(80);
    await d.click(alpha.x, alpha.y); // beta (unselected) sits between
    await sleep(200);
    const pendingSegs = await d.evaluate<number>(
      `document.querySelectorAll('.bracket.pending').length`);
    check("S8: bracket splits into one segment per contiguous run", pendingSegs === 2,
      `${pendingSegs} segments`);
    await d.screenshot(`${REPORT}/S8_split_brackets.png`);

    // Clear button: two-step confirm, undoable
    const clearBtn = await d.evaluate<{ x: number; y: number; disabled: boolean }>(`(()=>{
      const b=document.getElementById('clear-btn'); const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, disabled:b.disabled};
    })()`);
    check("S8: Clear enabled while a target exists", !clearBtn.disabled);
    await d.click(clearBtn.x, clearBtn.y);
    await sleep(80);
    const armed = await d.evaluate<string>(`document.getElementById('clear-btn').textContent`);
    check("S8: first click asks 'are you sure'", armed === "sure?", JSON.stringify(armed));
    check("S8: nothing cleared yet", (await pendingEntries(d)) === 2);
    await d.click(clearBtn.x, clearBtn.y);
    await sleep(100);
    check("S8: second click clears the current selection", (await pendingEntries(d)) === 0);
    await d.ctrlZ();
    await sleep(100);
    check("S8: the clear is undoable", (await pendingEntries(d)) === 2);

    // commit alpha+gamma → selection_1 with two members
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(200);
    await d.evaluate(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const b=blocks.find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      b.querySelector('.caret').click();
    })()`);
    await sleep(150);

    // members list in HIERARCHY order (alpha before gamma), not click order
    const memberLabels = await d.evaluate<string[]>(`
      [...document.querySelectorAll('#selections .tree-row.selectable')]
        .map(r=>r.querySelector('.tree-label').textContent)`);
    check("S8: members ordered by the hierarchy, not by selection order",
      memberLabels.length === 2 && /alpha/.test(memberLabels[0]) && /gamma/.test(memberLabels[1]),
      JSON.stringify(memberLabels));

    // top-section left-click: temporary YELLOW flash + focus, no state change
    const memberA = (await topRow(d, "/alpha/"))!;
    await d.click(memberA.x, memberA.y);
    await sleep(120);
    const flashed = await d.evaluate<boolean>(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      return rows.some(r=>r.classList.contains('row-flash'));
    })()`);
    check("S8: top left-click flashes the row yellow (temporary)", flashed);
    check("S8: ...and changes no state", (await committed(d))[1].entries === 2);

    // right-click a MEMBER row hides just that member (purple state)
    const visAll = await visibleCount(d);
    await d.rightClick(memberA.x, memberA.y);
    await sleep(150);
    check("S8: member right-click hides only that member",
      (await visibleCount(d)) === visAll - 400, `${visAll}→${await visibleCount(d)}`);
    const purple = await d.evaluate<{ state: boolean; strike: string } | null>(`(()=>{
      const row=[...document.querySelectorAll('#selections .tree-row.selectable')]
        .find(r=>r.classList.contains('hidden-entry-row'));
      if(!row) return null;
      return { state: true,
        strike: getComputedStyle(row.querySelector('.tree-label')).textDecorationLine };
    })()`);
    check("S8: hidden member is marked purple immediately", purple !== null);
    check("S8: purple highlight only — no strikethrough", purple?.strike === "none",
      purple?.strike ?? "missing");
    const countLabel = await d.evaluate<string>(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const b=blocks.find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      return b.querySelector('.sel-count').textContent;
    })()`);
    check("S8: header counts the part-hidden members", /1 hidden/.test(countLabel), countLabel);
    await d.screenshot(`${REPORT}/S8_member_hidden.png`);
    await d.rightClick(memberA.x, memberA.y);
    await sleep(150);
    check("S8: member right-click again un-hides", (await visibleCount(d)) === visAll);

    // right-DRAG hides ROW BY ROW as the pointer crosses — the purple state
    // sticks mid-drag (before release), and the whole drag is one undo unit
    const memberA2 = (await topRow(d, "/alpha/"))!;
    const memberG = (await topRow(d, "/gamma/"))!;
    await d.mouse("mousePressed", memberA2.x, memberA2.y, { button: "right", buttons: 2 });
    await d.mouse("mouseMoved", memberG.x, memberG.y, { buttons: 2 });
    await sleep(200);
    const midDrag = await d.evaluate<{ purple: number }>(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      return { purple: rows.filter(r=>r.classList.contains('hidden-entry-row')).length };
    })()`);
    check("S8: colors stick one by one WHILE dragging (before release)",
      (await visibleCount(d)) === visAll - 800 && midDrag.purple === 2,
      `visible=${await visibleCount(d)} purple=${midDrag.purple}`);
    await d.mouse("mouseReleased", memberG.x, memberG.y, { button: "right" });
    await sleep(150);
    check("S8: right-drag hides the dragged members",
      (await visibleCount(d)) === visAll - 800, `visible=${await visibleCount(d)}`);
    await d.ctrlZ();
    await sleep(150);
    check("S8: the drag-hide undoes as one unit", (await visibleCount(d)) === visAll);

    // dragging BACK mid-gesture shortens the hide: the reverted row un-hides
    // before release (same shorten semantics as every other trail)
    await d.mouse("mousePressed", memberA2.x, memberA2.y, { button: "right", buttons: 2 });
    await d.mouse("mouseMoved", memberG.x, memberG.y, { buttons: 2 });
    await sleep(120);
    check("S8: mid-drag both members hidden", (await visibleCount(d)) === visAll - 800,
      `visible=${await visibleCount(d)}`);
    await d.mouse("mouseMoved", memberA2.x, memberA2.y, { buttons: 2 });
    await sleep(120);
    check("S8: dragging back un-hides the popped row BEFORE release",
      (await visibleCount(d)) === visAll - 400, `visible=${await visibleCount(d)}`);
    await d.mouse("mouseReleased", memberA2.x, memberA2.y, { button: "right" });
    await sleep(150);
    check("S8: release keeps only the surviving hide",
      (await visibleCount(d)) === visAll - 400, `visible=${await visibleCount(d)}`);
    await d.ctrlZ();
    await sleep(150);
    check("S8: the shortened stroke still undoes as one unit",
      (await visibleCount(d)) === visAll, `visible=${await visibleCount(d)}`);

    // UN-hide by dragging: starting on a hidden row, the purple DISAPPEARS
    // row by row as the pointer crosses — never brighter, no hold overlay
    // (mirrors how the green paint-remove reads in the bottom section)
    await d.drag(memberA2.x, memberA2.y, memberG.x, memberG.y, 4, { button: "right" });
    await sleep(150); // both hidden again
    await d.mouse("mousePressed", memberA2.x, memberA2.y, { button: "right", buttons: 2 });
    await d.mouse("mouseMoved", memberG.x, memberG.y, { buttons: 2 });
    await sleep(200);
    const unhide = await d.evaluate<{ purple: number; holds: number }>(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      return { purple: rows.filter(r=>r.classList.contains('hidden-entry-row')).length,
               holds: rows.filter(r=>r.classList.contains('row-flash-purple-hold')).length };
    })()`);
    check("S8: un-hide drag clears the purple row by row MID-drag, no overlay",
      (await visibleCount(d)) === visAll && unhide.purple === 0 && unhide.holds === 0,
      `visible=${await visibleCount(d)} purple=${unhide.purple} holds=${unhide.holds}`);
    await d.mouse("mouseReleased", memberG.x, memberG.y, { button: "right" });
    await sleep(150);
    await d.ctrlZ(); // undo the un-hide stroke
    await sleep(120);
    check("S8: un-hide stroke undoes as one unit", (await visibleCount(d)) === visAll - 800,
      `visible=${await visibleCount(d)}`);
    await d.ctrlZ(); // undo the hide stroke
    await sleep(120);
    check("S8: back to fully visible", (await visibleCount(d)) === visAll);

    // whole-selection hide via the header still works (with the same sweep)
    const head = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(head.x, head.y);
    // family retrofit (this site's first-ever red, post-chapter lane): the
    // purple sweep is a bounded ~900ms row flash — watch for it IN-PAGE
    // from the click and capture the sighting ONCE (the immediate-once
    // rule; a re-read after a wait could race the same envelope again).
    // NOT retryable: re-right-clicking the header would TOGGLE the hide.
    const purpleSwept = await d.evaluate<boolean>(`(async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) {
        if ([...document.querySelectorAll('#selections .sel-head')]
          .some(h => h.classList.contains('row-flash-purple'))) return true;
        await new Promise(r => setTimeout(r, 40));
      }
      return false;
    })()`);
    check("S8: header right-click still hides the whole selection",
      (await committed(d))[1].hidden === true);
    check("S8: header hide sweeps purple too", purpleSwept);

    // overlap precedence: while selection_1 (alpha+gamma) is hidden, COMMIT a
    // new selection of alpha inside it — the newer selection SHOWS its points
    check("S8: hidden selection hides its points", (await visibleCount(d)) === visAll - 800,
      `visible=${await visibleCount(d)}`);
    const alphaNow = (await bottomRow(d, "/alpha/"))!; // fresh rect (layout shifted)
    await d.click(alphaNow.x, alphaNow.y); // alpha is inside the hidden selection
    await sleep(100);
    const btnC = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btnC.x, btnC.y);
    await sleep(200);
    check("S8: a NEW selection inside a hidden one is shown like normal",
      (await visibleCount(d)) === visAll - 400, `visible=${await visibleCount(d)}`);
    await d.ctrlZ(); // undo the commit
    await sleep(120);
    await d.ctrlZ(); // undo the pending add
    await sleep(120);
    check("S8: undo re-hides the overlap", (await visibleCount(d)) === visAll - 800,
      `visible=${await visibleCount(d)}`);

    await d.rightClick(head.x, head.y); // un-hide selection_1 again
    await sleep(150);

    // ...and the OTHER way: selection_1 (alpha+gamma, OLDER, visible) must
    // survive hiding a NEWER broad selection that covers it entirely
    const rows2 = {
      alpha: (await bottomRow(d, "/alpha/"))!,
      beta: (await bottomRow(d, "/beta/"))!,
      gamma: (await bottomRow(d, "/gamma/"))!,
    };
    await d.click(rows2.alpha.x, rows2.alpha.y);
    await d.click(rows2.beta.x, rows2.beta.y);
    await d.click(rows2.gamma.x, rows2.gamma.y);
    await sleep(100);
    const btnB = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btnB.x, btnB.y); // broad selection (alpha+beta+gamma)
    await sleep(200);
    const broadHead = (await selHead(d, "/selection_2/"))!;
    await d.rightClick(broadHead.x, broadHead.y); // hide the broad one
    await sleep(200);
    check("S8: hiding a broad selection leaves the earlier selection visible",
      (await visibleCount(d)) === visAll - 400,
      `visible=${await visibleCount(d)} (only beta should hide)`);
    for (let i = 0; i < 5; i++) {
      await d.ctrlZ(); // hide, commit, 3 adds
      await sleep(80);
    }
    check("S8: broad-hide detour fully undone",
      (await visibleCount(d)) === visAll && (await committed(d)).length === 2,
      `visible=${await visibleCount(d)} committed=${(await committed(d)).length}`);

    // deleting a selection must not strand the panel on blank space
    await expandBottomCategory(d, "/solvent/");
    await sleep(150);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const grp=rows.find(r=>r.dataset.level==='group' && /solvent/.test(r.textContent));
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    await d.evaluate(`document.getElementById('sidebar-content').scrollTop = 900`);
    await sleep(250);
    await d.evaluate(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const b=blocks.find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      [...b.querySelectorAll('.sel-ctl')].find(x=>x.textContent==='✕').click();
    })()`);
    await sleep(400);
    const inView = await d.evaluate<number>(`(()=>{
      const sc=document.getElementById('sidebar-content').getBoundingClientRect();
      return [...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>{const rr=r.getBoundingClientRect();
          return rr.height>0 && rr.bottom>sc.top && rr.top<sc.bottom;}).length;
    })()`);
    check("S8: after deleting a selection the panel is not blank", inView > 5, `${inView} rows in view`);
    await d.screenshot(`${REPORT}/S8_delete_relayout.png`);

    // collapsing from a deep scroll clamps the scroll into range
    await d.evaluate(`document.getElementById('sidebar-content').scrollTop = 900`);
    await sleep(200);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const cat=rows.find(r=>r.dataset.level==='category' && /solvent/.test(r.textContent));
      cat.querySelector('.caret').click();
    })()`);
    await sleep(400);
    const clamp = await d.evaluate<{ top: number; max: number; inView: number }>(`(()=>{
      const sc=document.getElementById('sidebar-content');
      const r=sc.getBoundingClientRect();
      const inView=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(x=>{const rr=x.getBoundingClientRect();
          return rr.height>0 && rr.bottom>r.top && rr.top<r.bottom;}).length;
      return {top:sc.scrollTop, max:Math.max(0,sc.scrollHeight-sc.clientHeight), inView};
    })()`);
    check("S8: collapsing from deep scroll clamps back into range",
      clamp.top <= clamp.max + 1, JSON.stringify(clamp));
    check("S8: content fills the viewport after the collapse", clamp.inView > 0, `${clamp.inView} rows`);
    await d.screenshot(`${REPORT}/S8_collapse_clamped.png`);
  });
}

// ============================ S9: command parity ==============================
async function S9(): Promise<void> {
  console.log("S9 — command layer: view <expr> ≡ the equivalent focus gesture");
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent the parity checks address
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    // camera pose = position + target (6 numbers); parity compares both
    const camState = () =>
      d.evaluate<number[]>(
        `[...${V}.camera.position.toArray(), ...${V}.controls.target.toArray()]`,
      );
    const closeCam = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
    /** Pose read that waits for the tween to have RENDERED to completion:
     * the tween advances only on rendered frames, so under a starved render
     * loop a fixed sleep can photograph the camera mid-flight. Settled =
     * pose identical across two consecutive rendered frames. */
    const camSettled = async (): Promise<number[]> => {
      for (let i = 0; i < 40; i++) {
        const a = await camState();
        await d.evaluate(`(async () => {
          for (let j = 0; j < 2; j++) await new Promise(r => requestAnimationFrame(r));
        })()`);
        const b = await camState();
        if (closeCam(a, b)) return b;
      }
      return camState();
    };
    const dist = () => d.evaluate<number>(`${V}.camera.position.distanceTo(${V}.controls.target)`);
    const reset = async () => {
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
    };
    const rowFlashed = (re: string) =>
      d.evaluate<boolean>(`(()=>{
        const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
          .filter(r=>r.getBoundingClientRect().height>0);
        const el=rows.find(r=>${re}.test(r.textContent));
        return !!el && el.classList.contains('row-flash');
      })()`);
    // the flash-pulse poll, specialized to an EXACT count (the module-level
    // flashPoll is the single source; see its doc for the envelope rationale)
    const flashReached = (n: number) => flashPoll(d, `f === ${n}`);
    const d0 = await dist(); // home framing distance

    // -- single-entry parity: `view <subgroup path>` vs right-click on its row --
    await expandBottomCategory(d, "/alpha/");
    await sleep(150);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const grp=rows.find(r=>r.dataset.level==='group');
      grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    const home = await camSettled();
    const rA = await cmd("view alpha.group-0.subgroup-0");
    // Sample the ENVELOPED states IMMEDIATELY and ONCE (the S3 rule): the
    // flash flags and the row-flash class live ~900ms, and every CDP hop
    // eats into the window — this check's own detail string once re-sampled
    // 0 right after its condition sampled 100 (the envelope expired BETWEEN
    // two adjacent samples).
    const pulsed = await flashCount(d);
    const rowLit = await rowFlashed("/subgroup-0\\b/");
    check("S9: view <path> resolves and reports the point count",
      rA.status === "ok" && rA.message === "focused 100 points", JSON.stringify(rA));
    check("S9: command pulses exactly the entry's points", pulsed === 100, `flash=${pulsed}`);
    check("S9: command flashes the mounted matching row (same row feedback)", rowLit);
    await sleep(500);
    const camCmd = await camSettled();
    check("S9: command moved the camera off home", !closeCam(home, camCmd));

    await reset();
    const subRow = (await bottomRow(d, "/subgroup-0\\b/"))!;
    check("S9: subgroup row still mounted for the gesture half", subRow !== null);
    await d.rightClick(subRow.x, subRow.y);
    const _fr1 = await flashReached(100);
    check("S9: gesture pulses the same points", _fr1.ok, `flash peak=${_fr1.peak} want=100`);
    check("S9: gesture flashes the same row class", await rowFlashed("/subgroup-0\\b/"));
    await sleep(500);
    const camGesture = await camSettled();
    check("S9: command and gesture land the camera on the SAME pose",
      closeCam(camCmd, camGesture),
      `cmd=${camCmd.map((v) => v.toFixed(3))} gesture=${camGesture.map((v) => v.toFixed(3))}`);

    // a range addressing the same subgroup frames the same 100 points
    const rRange = await cmd("view alpha.group-0.0-0");
    check("S9: trailing-int range addresses the same subgroup",
      rRange.status === "ok" && rRange.message === "focused 100 points", JSON.stringify(rRange));

    // -- spanning-group parity: group-0's points span alpha/beta/gamma; the
    // tree renders it under EACH, listing only that category's subgroups.
    // A path ENDING at the group resolves to the bare group entry — exactly
    // the entry a real click on that row creates (the whole group).
    await reset();
    const rSpan = await cmd("view alpha.group-0");
    check("S9: bare group path = the row's whole-group entry (like its click)",
      rSpan.status === "ok" && rSpan.message === "focused 400 points", JSON.stringify(rSpan));
    const _fr2 = await flashReached(400);
    check("S9: ...pulsing the whole spanning group", _fr2.ok, `flash peak=${_fr2.peak} want=400`);
    await sleep(500);
    const camGroupCmd = await camSettled();
    await reset();
    const grpRow = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const el=rows.find(r=>r.dataset.level==='group');
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.rightClick(grpRow.x, grpRow.y);
    const _fr3 = await flashReached(400);
    check("S9: a real click on that category-scoped group row pulses the same 400", _fr3.ok, `flash peak=${_fr3.peak} want=400`);
    await sleep(500);
    const camGroupClick = await camSettled();
    check("S9: bare-group command ≡ clicking the category-scoped group row",
      closeCam(camGroupCmd, camGroupClick),
      `cmd=${camGroupCmd.map((v) => v.toFixed(3))} click=${camGroupClick.map((v) => v.toFixed(3))}`);

    // ...but descent PAST the group is category-scoped: alpha's branch shows
    // only subgroup-0 and subgroup-3, and the resolver mirrors those rows
    await reset();
    const rScope = await cmd("view alpha.group-0.*");
    check("S9: descent through the spanning group stays inside alpha's branch",
      rScope.status === "ok" && rScope.message === "focused 200 points", JSON.stringify(rScope));
    await sleep(650);
    const camScopeCmd = await camSettled();
    await reset();
    const s0 = (await bottomRow(d, "/subgroup-0\\b/"))!;
    const s3 = (await bottomRow(d, "/subgroup-3\\b/"))!;
    let _fr4 = { ok: false, peak: 0 };
    for (let attempt = 0; attempt < 4 && !_fr4.ok; attempt++) {
      await d.drag(s0.x, s0.y, s3.x, s3.y, 4, { button: "right" });
      _fr4 = await flashReached(200);
    }
    check("S9: right-drag over the SAME rendered rows pulses the same 200", _fr4.ok, `flash peak=${_fr4.peak} want=200`);
    await sleep(500);
    const camScopeDrag = await camSettled();
    check("S9: category-scoped descent ≡ dragging the rows the tree shows",
      closeCam(camScopeCmd, camScopeDrag),
      `cmd=${camScopeCmd.map((v) => v.toFixed(3))} drag=${camScopeDrag.map((v) => v.toFixed(3))}`);
    const rBeta = await cmd("view beta.group-0.*");
    const rAllBranches = await cmd("view *.group-0.*");
    check("S9: each category branch scopes to its own subgroups",
      rBeta.status === "ok" && rBeta.message === "focused 100 points" &&
        rAllBranches.message === "focused 400 points",
      JSON.stringify([rBeta.message, rAllBranches.message]));

    // -- #index parity: view #N ≡ a real right-click on that point's row -------
    await reset();
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const sub=rows.find(r=>r.dataset.level==='subgroup');
      sub?.querySelector('.caret')?.click(); // drill subgroup-0 to its points
    })()`);
    await sleep(300);
    const ptRow = (await d.evaluate<{ x: number; y: number; id: number } | null>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const el=rows.find(r=>r.dataset.level==='point');
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2, id:Number(el.dataset.id)};
    })()`))!;
    check("S9: drilled to a point row", ptRow !== null);
    const rIdx = await cmd(`view #${ptRow.id}`);
    check("S9: standalone #index resolves exactly that point",
      rIdx.status === "ok" && rIdx.message === "focused 1 points", JSON.stringify(rIdx));
    const _fr5 = await flashReached(1);
    check("S9: #index pulses one point", _fr5.ok, `flash peak=${_fr5.peak} want=1`);
    await sleep(500);
    const camIdxCmd = await camSettled();
    await reset();
    await d.rightClick(ptRow.x, ptRow.y);
    const _fr6 = await flashReached(1);
    check("S9: the real point-row click pulses the same single point", _fr6.ok, `flash peak=${_fr6.peak} want=1`);
    await sleep(500);
    const camIdxClick = await camSettled();
    check("S9: view #N ≡ clicking that point's row (same camera pose)",
      closeCam(camIdxCmd, camIdxClick),
      `cmd=${camIdxCmd.map((v) => v.toFixed(3))} click=${camIdxClick.map((v) => v.toFixed(3))}`);
    // the scoped-leaf form is a containment check: hit inside, nomatch outside
    const rScopedIdx = await cmd(`view alpha.group-0.subgroup-0.#${ptRow.id}`);
    const rWrongScope = await cmd(`view beta.*.*.#${ptRow.id}`);
    const rOutOfRange = await cmd("view #987654");
    check("S9: scoped #N hits inside its branch, nomatch outside, nomatch out-of-range",
      rScopedIdx.message === "focused 1 points" && rWrongScope.status === "nomatch" &&
        rOutOfRange.status === "nomatch",
      JSON.stringify([rScopedIdx, rWrongScope, rOutOfRange]));
    // quoted spaced label straight from the producer (real-data property)
    const rQuoted = await cmd(`view gamma.group-2."subgroup 11"`);
    check("S9: a quoted spaced label resolves against producer data",
      rQuoted.status === "ok" && rQuoted.message === "focused 100 points",
      JSON.stringify(rQuoted));

    // -- @name.<leaf-pred>: filter a committed selection ------------------------
    // build a KNOWN mixed selection through the real path: click the first
    // three point rows (anchor + two t-types), commit
    const firstPointRows = await d.evaluate<{ x: number; y: number; id: number }[]>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0 && r.dataset.level==='point');
      return rows.slice(0,3).map(r=>{const b=r.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2, id:Number(r.dataset.id)};});
    })()`);
    check("S9: three point rows available to build from", firstPointRows.length === 3);
    for (const r of firstPointRows) {
      await d.click(r.x, r.y);
      await sleep(80);
    }
    const btnAt = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btnAt.x, btnAt.y);
    await sleep(250);
    check("S9: committed a mixed 3-point selection",
      (await committed(d)).some((c) => c.name === "selection_1" && c.pts === 3),
      JSON.stringify(await committed(d)));
    const rWhole = await cmd("view @selection_1");
    check("S9: unfiltered @name unchanged", rWhole.message === "focused 3 points",
      JSON.stringify(rWhole));

    // #N filter parity: identical pose to a real click on that point's row
    // (row rects re-queried — committing shifted the layout)
    const p1 = firstPointRows[1];
    await reset();
    const rSelIdx = await cmd(`view @selection_1.#${p1.id}`);
    check("S9: @sel.#N contains-and-frames one point",
      rSelIdx.status === "ok" && rSelIdx.message === "focused 1 points", JSON.stringify(rSelIdx));
    await sleep(650);
    const camSelIdx = await camSettled();
    await reset();
    const p1Row = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .find(r=>r.dataset.level==='point' && Number(r.dataset.id)===${p1.id}
          && r.getBoundingClientRect().height>0);
      if(!el) return null; const b=el.getBoundingClientRect();
      return {x:b.left+b.width/2, y:b.top+b.height/2};
    })()`))!;
    await d.rightClick(p1Row.x, p1Row.y);
    await sleep(650);
    check("S9: @sel.#N ≡ clicking that point's row (same camera pose)",
      closeCam(camSelIdx, await camSettled()),
      `cmd=${camSelIdx.map((v) => v.toFixed(3))}`);

    // glob filter parity: the same subset a manual pick of those rows frames
    await reset();
    const rSelGlob = await cmd("view @selection_1.t*");
    check("S9: @sel.<glob> filters by type within the selection",
      rSelGlob.status === "ok" && rSelGlob.message === "focused 2 points",
      JSON.stringify(rSelGlob));
    await sleep(650);
    const camSelGlob = await camSettled();
    await reset();
    const rows12 = await d.evaluate<{ x: number; y: number }[]>(`(()=>{
      const ids=[${firstPointRows[1].id},${firstPointRows[2].id}];
      return ids.map(id=>{
        const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
          .find(r=>r.dataset.level==='point' && Number(r.dataset.id)===id
            && r.getBoundingClientRect().height>0);
        const b=el.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};});
    })()`);
    // the right-drag pick is a GESTURE whose effect (a 2-point pulse) must
    // actually register — under CPU saturation a single synthetic drag can
    // land on nothing and fire NO pulse (peak=0, not a sampling miss). Retry
    // the drag until the pulse appears (the S32 re-trigger discipline);
    // re-picking the same rows is idempotent for focus.
    let _fr7 = { ok: false, peak: 0 };
    for (let attempt = 0; attempt < 4 && !_fr7.ok; attempt++) {
      await d.drag(rows12[0].x, rows12[0].y, rows12[1].x, rows12[1].y, 4, { button: "right" });
      _fr7 = await flashReached(2);
    }
    check("S9: the manual pick pulses the same 2 points", _fr7.ok, `flash peak=${_fr7.peak} want=2`);
    await sleep(500);
    check("S9: @sel.<glob> ≡ a manual pick of those rows (same camera pose)",
      closeCam(camSelGlob, await camSettled()),
      `cmd=${camSelGlob.map((v) => v.toFixed(3))}`);

    // remaining filter forms: literal, list, containment miss
    const rSelLit = await cmd("view @selection_1.anchor");
    const rSelList = await cmd("view @selection_1.t1,anchor");
    const rSelMiss = await cmd("view @selection_1.#5000");
    check("S9: literal/list filters count; out-of-selection index is a nomatch",
      rSelLit.message === "focused 1 points" && rSelList.message === "focused 2 points" &&
        rSelMiss.status === "nomatch",
      JSON.stringify([rSelLit.message, rSelList.message, rSelMiss.status]));

    // REVERSED (membership-only): descendant/ancestor tokens no longer reach
    // past the stored members — selection_1 stores POINT members, so a
    // subgroup/group label matches nothing; the seed's descendant subgroup
    // labels match nothing either
    const rSelSub = await cmd(`view @selection_1."subgroup-0"`);
    const rSelGrp = await cmd("view @selection_1.group-0");
    const rSelWrongCat = await cmd("view @selection_1.beta");
    const rSeedSub = await cmd("view @solvent.solvent-0");
    check("S9: ancestry tokens nomatch — the filter sees stored members only",
      rSelSub.status === "nomatch" && rSelGrp.status === "nomatch" &&
        rSelWrongCat.status === "nomatch" && rSeedSub.status === "nomatch",
      JSON.stringify([rSelSub.status, rSelGrp.status, rSelWrongCat.status, rSeedSub.status]));
    // the route to that granularity: a selection whose MEMBER is the subgroup
    // — then the member's own label matches, and framing it ≡ a real click on
    // the subgroup row (the same 100 points)
    await cmd("create_sele alpha.group-0.subgroup-0 [cover]");
    await reset();
    const rCover = await cmd("view @cover.subgroup-0");
    check("S9: the member's OWN label matches — whole-member result",
      rCover.status === "ok" && rCover.message === "focused 100 points",
      JSON.stringify(rCover));
    await sleep(650);
    const camCover = await camSettled();
    await reset();
    const subRowAgain = (await bottomRow(d, "/subgroup-0\\b/"))!;
    await d.rightClick(subRowAgain.x, subRowAgain.y);
    await sleep(650);
    check("S9: @cover.<member-label> ≡ clicking that subgroup row",
      closeCam(camCover, await camSettled()),
      `cmd=${camCover.map((v) => v.toFixed(3))}`);
    await d.ctrlZ(); // undo the [cover] commit
    await sleep(120);

    // unwind the detour (3 build clicks + 1 commit) so the state-purity
    // checks below still see the untouched startup state
    for (let i = 0; i < 4; i++) {
      await d.ctrlZ();
      await sleep(80);
    }
    check("S9: @filter detour fully undone",
      (await committed(d)).length === 1 && (await pendingEntries(d)) === 0 &&
        !(await d.evaluate<boolean>(`${V}.model.canUndo`)),
      `committed=${(await committed(d)).length} pending=${await pendingEntries(d)}`);

    // -- multi-match parity: `view <glob>` vs a right-drag over the same rows --
    await expandBottomCategory(d, "/alpha/"); // collapse back → category rows adjacent
    await sleep(200);
    await reset();
    const rG = await cmd("view *a*"); // alpha + beta + gamma (solvent has no 'a')
    check("S9: glob resolves the union across subtrees",
      rG.status === "ok" && rG.message === "focused 1200 points", JSON.stringify(rG));
    const _fr8 = await flashReached(1200);
    check("S9: glob command pulses the whole union", _fr8.ok, `flash peak=${_fr8.peak} want=1200`);
    check("S9: glob command flashes every mounted matching row",
      (await rowFlashed("/alpha/")) && (await rowFlashed("/beta/")) && (await rowFlashed("/gamma/")));
    await sleep(500);
    const camGlob = await camSettled();

    await reset();
    const alpha = (await bottomRow(d, "/alpha/"))!;
    const gamma = (await bottomRow(d, "/gamma/"))!;
    let _fr9 = { ok: false, peak: 0 };
    for (let attempt = 0; attempt < 4 && !_fr9.ok; attempt++) {
      await d.drag(alpha.x, alpha.y, gamma.x, gamma.y, 4, { button: "right" });
      _fr9 = await flashReached(1200);
    }
    check("S9: right-drag over the same rows pulses the same union", _fr9.ok, `flash peak=${_fr9.peak} want=1200`);
    await sleep(500);
    const camDrag = await camSettled();
    check("S9: glob command frames the SAME union a right-drag frames",
      closeCam(camGlob, camDrag),
      `cmd=${camGlob.map((v) => v.toFixed(3))} drag=${camDrag.map((v) => v.toFixed(3))}`);

    // -- @name parity: `view @solvent` vs clicking the committed selection name --
    await reset();
    const rAt = await cmd("view @solvent");
    check("S9: @name resolves the committed selection",
      rAt.status === "ok" && rAt.message === "focused 4800 points", JSON.stringify(rAt));
    await sleep(650);
    const camAt = await camSettled();
    await reset();
    const nm = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const el=blocks.find(b=>/solvent/.test(b.querySelector('.sel-name')?.textContent ?? ''));
      if(!el) return null; const r=el.querySelector('.sel-name').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.click(nm.x, nm.y); // name click = focus the whole selection
    await sleep(650);
    const camName = await camSettled();
    check("S9: @name frames the selection exactly like the name-click gesture",
      closeCam(camAt, camName),
      `cmd=${camAt.map((v) => v.toFixed(3))} click=${camName.map((v) => v.toFixed(3))}`);

    // -- commands are camera-only: no state, no undo entries -------------------
    check("S9: commands change no selection state",
      (await pendingEntries(d)) === 0 && (await committed(d)).length === 1);
    check("S9: commands push nothing onto the undo stack",
      !(await d.evaluate<boolean>(`${V}.model.canUndo`)));

    // -- leaf-level (type) matching --------------------------------------------
    const rLeaf = await cmd("view alpha.group-0.subgroup-0.t*");
    check("S9: leaf glob matches point types (anchor excluded)",
      rLeaf.status === "ok" && rLeaf.message === "focused 99 points", JSON.stringify(rLeaf));
    const rLeafRange = await cmd("view alpha.group-0.subgroup-0.1-2");
    check("S9: leaf range matches trailing ints of point types",
      rLeafRange.status === "ok" && rLeafRange.message === "focused 50 points",
      JSON.stringify(rLeafRange));

    // -- nomatch: no camera move, one-line message ------------------------------
    await sleep(1000); // let the last flash fade fully
    const camBeforeMiss = await camSettled();
    const rMiss = await cmd("view alpha.group-0.subgroup-99");
    await sleep(400);
    check("S9: empty match is nomatch, not an error", rMiss.status === "nomatch",
      JSON.stringify(rMiss));
    check("S9: nomatch moves nothing", closeCam(camBeforeMiss, await camSettled()) &&
      (await flashCount(d)) === 0);

    // -- hidden targets: view frames them like a real click on the hidden row —
    // the camera goes there, the pulse stays dark (overlay gates on
    // visibility), nothing is unhidden, nothing lands on the undo stack
    const solHead = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solHead.x, solHead.y); // hide the bulk selection
    await sleep(200);
    const visHidden = await visibleCount(d);
    const undoBefore = await d.evaluate<number>(`${V}.model.undoDepth`);
    const rHidden = await cmd("view @solvent");
    check("S9: a fully hidden target still resolves and frames",
      rHidden.status === "ok" && rHidden.message === "focused 4800 points",
      JSON.stringify(rHidden));
    await sleep(150);
    check("S9: ...with ZERO visible pulse (hidden points don't glow)",
      (await flashCount(d)) === 0, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camHiddenCmd = await camSettled();
    check("S9: ...and the camera moved to it", !closeCam(camBeforeMiss, camHiddenCmd));
    // parity: a REAL click on the hidden selection's name frames the same pose
    await reset();
    const nmHidden = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const el=blocks.find(b=>/solvent/.test(b.querySelector('.sel-name')?.textContent ?? ''));
      if(!el) return null; const r=el.querySelector('.sel-name').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.click(nmHidden.x, nmHidden.y);
    await sleep(150);
    check("S9: the real hidden-row click pulses nothing visible either",
      (await flashCount(d)) === 0, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camHiddenClick = await camSettled();
    check("S9: hidden view ≡ clicking the hidden row (same camera pose)",
      closeCam(camHiddenCmd, camHiddenClick),
      `cmd=${camHiddenCmd.map((v) => v.toFixed(3))} click=${camHiddenClick.map((v) => v.toFixed(3))}`);
    const rHiddenPath = await cmd("view solvent");
    check("S9: the path form frames the hidden target too",
      rHiddenPath.status === "ok" && rHiddenPath.message === "focused 4800 points",
      JSON.stringify(rHiddenPath));
    check("S9: view unhides NOTHING",
      (await visibleCount(d)) === visHidden &&
        (await d.evaluate<boolean>(`${V}.model.committed()[0].hidden`)),
      `visible=${await visibleCount(d)}`);
    check("S9: hidden views push nothing onto the undo stack",
      (await d.evaluate<number>(`${V}.model.undoDepth`)) === undoBefore);
    const solHead2 = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solHead2.x, solHead2.y); // un-hide again
    await sleep(200);

    // -- malformed syntax & unknown verbs ---------------------------------------
    const rE1 = await cmd("view alpha..x");
    const rE2 = await cmd("view a[0]");
    const rE3 = await cmd('view "unclosed');
    check("S9: malformed syntax returns the parse message",
      rE1.status === "error" && /empty segment/.test(rE1.message) &&
        rE2.status === "error" && /reserved character/.test(rE2.message) &&
        rE3.status === "error" && /unbalanced quote/.test(rE3.message),
      JSON.stringify([rE1.message, rE2.message, rE3.message]));
    const rV = await cmd("frobnicate alpha");
    check("S9: unknown verb", rV.status === "error" && rV.message === "unknown command: frobnicate",
      JSON.stringify(rV));
    const rEmpty = await cmd("   ");
    check("S9: blank input is an error", rEmpty.status === "error", JSON.stringify(rEmpty));

    // -- `view` with no argument = the empty-space-click framing ---------------
    await cmd("view alpha.group-0.subgroup-0"); // zoom in first
    // poll for the zoom-in tween to REACH the target (the S3 camera-settle
    // pattern; a fixed 700ms samples mid-flight under peak load — this
    // setup check's first-ever red, in the Half-2 lane)
    await d.waitFor(`${V}.camera.position.distanceTo(${V}.controls.target) < ${d0 * 0.8}`, 6000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S9: (setup) zoomed in", (await dist()) < d0 * 0.8, `${(await dist()).toFixed(1)}`);
    const rHome = await cmd("view");
    // pose-settle poll, not a fixed sleep: the tween advances only on
    // rendered frames (the camSettled rule — a starved loop outlives 700ms)
    await camSettled();
    const dHome = await dist();
    check("S9: bare view frames the visible scene", rHome.status === "ok" &&
      Math.abs(dHome - d0) < d0 * 0.1, `dist=${dHome.toFixed(1)} vs ${d0.toFixed(1)}`);
    await d.screenshot(`${REPORT}/S9_command_parity.png`);
  });
}

// ============================ S10: flash-parity matrix ========================
async function S10(): Promise<void> {
  console.log("S10 — flash-parity: flashed rows == mounted rows ∩ resolved set, all shapes");
  await withDriver(async (d) => {
    await seedSolvent(d); // the second committed selection the final count assumes
    // -- setup: a committed selection with MIXED-LEVEL members (a subgroup
    // entry + two point entries of different types), its member list open,
    // and the bottom tree expanded alpha → group-0 → subgroup-0 drilled —
    // so both surfaces carry mounted rows at several levels
    await d.evaluate(`(()=>{
      const v = ${V};
      v.refreshPoints(v.model.addToTarget({level:'subgroup', id:0}));
      v.refreshPoints(v.model.addToTarget({level:'point', id:301}));
      v.refreshPoints(v.model.addToTarget({level:'point', id:302}));
      const sel = v.model.commit();
      v.refreshPoints(sel.set.resolvedPoints());
    })()`);
    await sleep(250);
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>/selection_1/.test(x.querySelector('.sel-name').textContent));
      b.querySelector('.caret').click();
    })()`);
    await sleep(200);
    await expandBottomCategory(d, "/alpha/");
    await sleep(200);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='group')?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='subgroup')?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    const undoBase = await d.evaluate<number>(`${V}.model.undoDepth`);

    // -- the invariant audit, evaluated in ONE tick right after the command:
    // for every mounted row, does (row's points ∩ resolved set ≠ ∅) equal
    // (row flashed)? Reports exact misses both ways.
    const audit = (expr: string) =>
      d.evaluate<{ status: string; expected: number; flashed: number; missing: number; extra: number }>(
        `(()=>{
          const v = ${V};
          const res = v.command(${JSON.stringify("view ")} + ${JSON.stringify(expr)});
          const pts = new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
          let expected=0, flashed=0, missing=0, extra=0;
          for (const r of document.querySelectorAll('#tree-host .tree-row.selectable, #selections .tree-row.selectable')) {
            if (r.getBoundingClientRect().height === 0) continue; // unmounted: must not flash
            const level=r.dataset.level, id=Number(r.dataset.id);
            const hit = level==='point' ? pts.has(id)
              : v.hierarchy.pointsOf({level, id}).some((p)=>pts.has(p));
            const fl = r.classList.contains('row-flash');
            if (hit) expected++;
            if (fl) flashed++;
            if (hit && !fl) missing++;
            if (!hit && fl) extra++;
          }
          return { status: res.status, expected, flashed, missing, extra };
        })()`,
      );

    const matrix: [string, string][] = [
      // single term, one per level
      ["path→category", "alpha"],
      ["path→group", "alpha.group-0"],
      ["path→subgroup", "alpha.group-0.subgroup-0"],
      ["path→point (#)", "alpha.group-0.subgroup-0.#5"],
      // leaf shapes
      ["leaf glob", "alpha.group-0.*.t*"],
      ["leaf list", "alpha.group-0.subgroup-0.t1,t2"],
      ["numeric label range", "alpha.group-0.0-0"],
      ["#index", "#5"],
      ["#index range", "#5-25"],
      // @name whole + filtered at every identity level
      ["@name whole", "@selection_1"],
      ["@name.point-member-type", "@selection_1.t1"],
      ["@name.member-label", `@selection_1."subgroup-0"`],
      ["@name.member-glob", "@selection_1.subgroup-*"],
      ["@name.member-#range", "@selection_1.#301-302"],
      // cross-level unions — the two REPORTED regressions first
      ["REPORTED @label + @type", `@selection_1."subgroup-0" + @selection_1.t1`],
      ["REPORTED path + path.type", "alpha.group-0.subgroup-0 + alpha.group-0.subgroup-0.t1"],
      ["path + #index", "alpha.group-0.subgroup-3 + #5"],
      ["3-term cross-level", "beta + @selection_1.t2 + #5-10"],
      // collapsed surfaces: only the mounted intersecting rows may flash
      ["collapsed branch", "gamma"],
      ["collapsed bulk", "solvent"],
    ];
    for (const [label, expr] of matrix) {
      const r = await audit(expr);
      check(`S10 [${label}]: flashed == mounted ∩ resolved (${r.expected} rows)`,
        r.status === "ok" && r.expected > 0 && r.missing === 0 && r.extra === 0 &&
          r.flashed === r.expected,
        JSON.stringify(r));
      await sleep(650); // let this case's flashes expire before the next
    }

    // camera frames the FULL union: command pose == focusPoints(resolved set).
    // Pose reads are SETTLE-POLLED, not bare fixed-sleep reads (the S8/S9
    // camSettled rule): the tween advances only on rendered frames, and under
    // desktop load this machine's headless render loop freezes for 10–21s at
    // a stretch (measured with an in-page rAF-gap sampler; the freezes hit
    // the `view` leg and the focusPoints leg alike) — a fixed 650ms then
    // photographs the camera mid-flight and the two identical framing paths
    // "disagree". The assertion itself is unchanged: both legs must land on
    // the same pose within 0.01.
    const camPose = () => d.evaluate<number[]>(
      `[...${V}.camera.position.toArray(), ...${V}.controls.target.toArray()]`);
    const camSettled = async (): Promise<number[]> => {
      for (let i = 0; i < 40; i++) {
        const a = await camPose();
        await d.evaluate(`(async () => {
          for (let j = 0; j < 2; j++) await new Promise(r => requestAnimationFrame(r));
        })()`);
        const b = await camPose();
        if (a.every((v, k) => Math.abs(v - b[k]) < 0.01)) return b;
      }
      return camPose();
    };
    for (const expr of [`@selection_1."subgroup-0" + @selection_1.t1`,
                        "alpha.group-0.subgroup-3 + #5"]) {
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
      await d.evaluate(`${V}.focusPoints(${V}.debug.resolvePoints(${JSON.stringify(expr)}))`);
      await sleep(650);
      const direct = await camSettled();
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
      await d.evaluate(`${V}.command(${JSON.stringify("view " + expr)})`);
      await sleep(650);
      const viaCmd = await camSettled();
      check(`S10: camera frames the full union — ${expr}`,
        direct.every((v, i) => Math.abs(v - viaCmd[i]) < 0.01),
        `direct=${direct.map((v) => v.toFixed(2))} cmd=${viaCmd.map((v) => v.toFixed(2))}`);
    }

    // read-only: the whole matrix mutated nothing
    check("S10: the matrix changed no state and pushed no undo entries",
      (await pendingEntries(d)) === 0 && (await committed(d)).length === 2 &&
        (await d.evaluate<number>(`${V}.model.undoDepth`)) === undoBase &&
        (await editingName(d)) === null,
      `undo=${await d.evaluate<number>(`${V}.model.undoDepth`)} vs base=${undoBase}`);
    await d.screenshot(`${REPORT}/S10_flash_parity.png`);
  });
}

// ============================ S11: create_sele ================================
async function S11(): Promise<void> {
  console.log("S11 — create_sele: the mutation template (parity with the gesture commit)");
  await withDriver(async (d) => {
    await seedSolvent(d); // the "solvent" name the collision check clashes with
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const committedCount = async () => (await committed(d)).length;

    // structure of the LAST committed selection: entries at their levels, the
    // rendered member rows, and its bracket segments (block expanded to look)
    const lastSelSnapshot = () =>
      d.evaluate<{ name: string; pts: number; entries: string[]; members: string[]; brackets: number }>(
        `(async ()=>{
          const v=${V};
          const list=v.model.committed();
          const c=list[list.length-1];
          const block=[...document.querySelectorAll('#selections .sel-block')]
            .find(b=>b.querySelector('.sel-name')?.textContent===c.name);
          const body=block.querySelector('.sel-body');
          if (body.style.display==='none' || !body.hasChildNodes()) {
            block.querySelector('.caret').click();
          }
          await new Promise(r=>setTimeout(r, 150));
          const members=[...block.querySelectorAll('.tree-row.selectable')]
            .map(r=>r.dataset.level+':'+r.dataset.id+':'+r.querySelector('.tree-label').textContent);
          const brackets=document.querySelectorAll('.bracket[title="'+c.name+'"]').length;
          return { name:c.name, pts:c.set.pointCount,
            entries:c.set.listEntries().map(e=>e.level+':'+e.id).sort(),
            members, brackets };
        })()`);

    // -- setup: expand alpha → group-0 → drill subgroup-0 (gesture surface) --
    await expandBottomCategory(d, "/alpha/");
    await sleep(200);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='group')?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='subgroup')?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);
    const rowByEntry = (level: string, id: number) =>
      d.evaluate<{ x: number; y: number } | null>(`(()=>{
        const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
          .find(r=>r.dataset.level===${JSON.stringify(level)} && Number(r.dataset.id)===${id}
            && r.getBoundingClientRect().height>0);
        if(!el) return null; const b=el.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
    const commitBtn = async () => {
      const b = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const r=document.getElementById('commit-btn').getBoundingClientRect();
        return {x:r.left+r.width/2, y:r.top+r.height/2};
      })()`);
      await d.click(b.x, b.y);
      await sleep(200);
    };

    // -- gesture↔command structural parity across representative targets ------
    const cases: { label: string; clicks: [string, number][]; expr: string }[] = [
      { label: "coarse path", clicks: [["subgroup", 0]], expr: "alpha.group-0.subgroup-0" },
      // point first, then the coarse entry — the reverse would carve; the
      // committed membership is genuinely mixed-level (a subgroup + a point)
      { label: "mixed-level union", clicks: [["point", 2], ["subgroup", 0]],
        expr: "alpha.group-0.subgroup-0 + #2" },
      { label: "#index", clicks: [["point", 5]], expr: "#5" },
    ];
    for (const c of cases) {
      const baseCommitted = await committedCount();
      const baseUndo = await undoDepth();
      // GESTURE half: click the rows, press Create selection
      for (const [level, id] of c.clicks) {
        const r = (await rowByEntry(level, id))!;
        await d.click(r.x, r.y);
        await sleep(100);
      }
      await commitBtn();
      const gSnap = await lastSelSnapshot();
      for (let i = 0; i < c.clicks.length + 1; i++) {
        await d.ctrlZ();
        await sleep(80);
      }
      check(`S11 [${c.label}]: gesture detour fully undone`,
        (await committedCount()) === baseCommitted && (await undoDepth()) === baseUndo);
      // COMMAND half — with the commit green pulse sampled in the same tick
      const run = await d.evaluate<{ status: string; message: string; pulse: number }>(`(()=>{
        const res=${V}.command(${JSON.stringify("create_sele " + c.expr)});
        const pulse=document.querySelectorAll('#tree-host .tree-row.sel-covered').length;
        return { status: res.status, message: res.message, pulse };
      })()`);
      check(`S11 [${c.label}]: create_sele commits ok`,
        run.status === "ok" && /^created "selection_1" — \d+ points$/.test(run.message),
        JSON.stringify(run));
      check(`S11 [${c.label}]: the green build→commit pulse plays`, run.pulse > 0,
        `pulse=${run.pulse}`);
      const cSnap = await lastSelSnapshot();
      check(`S11 [${c.label}]: command ≡ gesture (entries/levels/members/brackets)`,
        JSON.stringify(cSnap) === JSON.stringify(gSnap),
        `cmd=${JSON.stringify(cSnap)} gesture=${JSON.stringify(gSnap)}`);
      await sleep(700); // pulse fades
      check(`S11 [${c.label}]: the pulse settles (no lingering green)`,
        (await d.evaluate<number>(
          `document.querySelectorAll('#tree-host .tree-row.sel-covered').length`)) === 0);
      await d.ctrlZ(); // ONE undo removes a create_sele selection cleanly
      await sleep(120);
      check(`S11 [${c.label}]: one Ctrl+Z removes it with no residue`,
        (await committedCount()) === baseCommitted && (await undoDepth()) === baseUndo &&
          (await pendingEntries(d)) === 0 && (await selCount(d)) === 0);
    }

    // -- @name filter target: point-level entries, exactly the filter's set --
    // membership-only: @base.t1 needs base's MEMBERS to be points — commit fine
    await cmd("create_sele alpha.group-0.subgroup-0.* [base]");
    const rFine = await cmd("create_sele @base.t1 [fine]");
    check("S11: @name-filter target commits point entries",
      rFine.status === "ok" && /^created "fine" — \d+ points$/.test(rFine.message),
      JSON.stringify(rFine));
    const fine = await d.evaluate<{ levels: string[]; pts: number[]; expect: number[] }>(`(()=>{
      const v=${V};
      const c=v.model.committed().find(x=>x.name==='fine');
      return { levels: [...new Set(c.set.listEntries().map(e=>e.level))],
               pts: c.set.resolvedPoints().sort((a,b)=>a-b),
               expect: v.debug.resolvePoints('@base.t1').sort((a,b)=>a-b) };
    })()`);
    check("S11: ...at point level, matching the filter's resolved set exactly",
      fine.levels.length === 1 && fine.levels[0] === "point" &&
        JSON.stringify(fine.pts) === JSON.stringify(fine.expect),
      JSON.stringify(fine.levels));

    // -- edit-mode independence: a NEW selection, the edited one untouched ----
    check("S11: (setup) entered edit mode", await clickSelCtl(d, "/^base$/", "edit"));
    await sleep(150);
    const baseEntriesBefore = await d.evaluate<string>(
      `${V}.model.committed().find(c=>c.name==='base').set.listEntries().map(e=>e.level+':'+e.id).join(',')`);
    const rDuringEdit = await cmd("create_sele alpha.group-0.subgroup-3 [extra]");
    check("S11: create_sele during edit creates a NEW selection",
      rDuringEdit.status === "ok" && /created "extra"/.test(rDuringEdit.message),
      JSON.stringify(rDuringEdit));
    check("S11: ...edit mode and the edited selection are untouched",
      (await editingName(d)) === "base" &&
        (await d.evaluate<string>(
          `${V}.model.committed().find(c=>c.name==='base').set.listEntries().map(e=>e.level+':'+e.id).join(',')`)) === baseEntriesBefore &&
        (await btnText(d)) === "Done");
    await d.escape(); // leave edit mode
    await sleep(120);

    // -- explicit-name collision errors and mutates nothing -------------------
    const preCount = await committedCount();
    const preUndo = await undoDepth();
    const clash = await cmd("create_sele alpha [solvent]"); // the seed's name
    check("S11: explicit-name collision is a specific error",
      clash.status === "error" && clash.message === `a selection named "solvent" already exists`,
      JSON.stringify(clash));
    const miss = await cmd("create_sele zzz [ghost]");
    check("S11: empty target is a nomatch and commits nothing",
      miss.status === "nomatch" && (await committedCount()) === preCount &&
        (await undoDepth()) === preUndo,
      JSON.stringify(miss));
    await d.screenshot(`${REPORT}/S11_create_sele.png`);
  });
}

// ============================ S12: hide / show ================================
async function S12(): Promise<void> {
  console.log("S12 — hide/show: the mutating pair over per-selection hidden state");
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent the hide/show pair drives
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    // setup: expand alpha → group-0 → drill subgroup-0
    await expandBottomCategory(d, "/alpha/");
    await sleep(200);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='group')?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='subgroup')?.querySelector('.caret')?.click();
    })()`);
    await sleep(300);

    // -- hide <path> ≡ build + commit + header-right-click-hide, ONE undo -----
    const baseUndo = await undoDepth();
    const sub0 = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .find(r=>r.dataset.level==='subgroup' && Number(r.dataset.id)===0
          && r.getBoundingClientRect().height>0);
      if(!el) return null; const b=el.getBoundingClientRect();
      return {x:b.left+b.width/2, y:b.top+b.height/2};
    })()`))!;
    await d.click(sub0.x, sub0.y);
    await sleep(100);
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(200);
    const gHead = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(gHead.x, gHead.y); // gesture hide
    await sleep(200);
    const gSnap = {
      hidden: (await committed(d))[1].hidden,
      visible: await visibleCount(d),
      purple: /hidden-sel/.test((await selHead(d, "/selection_1/"))!.cls),
    };
    for (let i = 0; i < 3; i++) {
      await d.ctrlZ();
      await sleep(80);
    }
    check("S12: gesture detour fully undone",
      (await committed(d)).length === 1 && (await visibleCount(d)) === 6000 &&
        (await undoDepth()) === baseUndo);
    const run = await d.evaluate<{ status: string; message: string; pulse: number }>(`(()=>{
      const res=${V}.command("hide alpha.group-0.subgroup-0");
      const pulse=document.querySelectorAll('#tree-host .tree-row.sel-covered').length;
      return { status: res.status, message: res.message, pulse };
    })()`);
    check("S12: hide <path> commits-then-hides with the created-and-hid line",
      run.status === "ok" && run.message === `created and hid "selection_1" — 100 points`,
      JSON.stringify(run));
    check("S12: the green commit pulse still plays before the purple settles",
      run.pulse > 0, `pulse=${run.pulse}`);
    const cSnap = {
      hidden: (await committed(d))[1].hidden,
      visible: await visibleCount(d),
      purple: /hidden-sel/.test((await selHead(d, "/selection_1/"))!.cls),
    };
    check("S12: hide <path> state ≡ the gesture sequence (hidden, visible count, purple)",
      JSON.stringify(cSnap) === JSON.stringify(gSnap),
      `cmd=${JSON.stringify(cSnap)} gesture=${JSON.stringify(gSnap)}`);
    await sleep(300); // the bracket layer re-lays out on a scheduled rAF
    check("S12: the gutter bracket goes purple too",
      await d.evaluate<boolean>(`!!document.querySelector('.bracket.hidden')`));
    await d.ctrlZ(); // ONE undo reverses commit AND hide together
    await sleep(150);
    check("S12: one Ctrl+Z fully reverses commit-then-hide",
      (await committed(d)).length === 1 && (await visibleCount(d)) === 6000 &&
        (await undoDepth()) === baseUndo && (await selCount(d)) === 0);

    // -- hide @name: whole flag, idempotent, gesture-interoperable ------------
    const r1 = await cmd("hide @solvent");
    check("S12: hide @name hides the whole selection",
      r1.status === "ok" && r1.message === `hid "solvent" — 4800 points` &&
        (await visibleCount(d)) === 1200,
      JSON.stringify(r1));
    const depthAfterHide = await undoDepth();
    const r2 = await cmd("hide @solvent");
    check("S12: hide @name is idempotent, never a toggle",
      r2.status === "ok" && r2.message === `"solvent" is already hidden` &&
        (await visibleCount(d)) === 1200 && (await undoDepth()) === depthAfterHide,
      JSON.stringify(r2));
    // the header right-click gesture (a toggle) un-hides what the command hid
    const solHead = (await selHead(d, "/solvent/"))!;
    await d.rightClick(solHead.x, solHead.y);
    await sleep(150);
    check("S12: the gesture toggle interoperates with the command's state",
      (await visibleCount(d)) === 6000);
    const r3 = await cmd("show @solvent");
    check("S12: show @name on a visible selection is an honest no-op",
      r3.message === `"solvent" is already visible` && (await undoDepth()) === depthAfterHide + 1);
    await d.ctrlZ(); // gesture toggle
    await sleep(80);
    await d.ctrlZ(); // command hide
    await sleep(80);
    check("S12: hide/show detour undone", (await visibleCount(d)) === 6000 &&
      (await undoDepth()) === baseUndo);

    // -- member subsets: exact member, coarse-entry subset, type filter --------
    await cmd("create_sele alpha.group-0.subgroup-0 + #200 [mix]");
    const rM = await cmd("hide @mix.#200"); // an exact point MEMBER
    check("S12: hide @name.#member hides that member",
      rM.message === `hid 1 points in "mix"` && (await visibleCount(d)) === 5999,
      JSON.stringify(rM));
    // its member row carries the persistent purple, like the right-click
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
      const body=b.querySelector('.sel-body');
      if (body.style.display==='none' || !body.hasChildNodes()) b.querySelector('.caret').click();
    })()`);
    await sleep(200);
    check("S12: the hidden member row is purple (the gesture's feedback)",
      await d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        const row=[...b.querySelectorAll('.tree-row.selectable')]
          .find(r=>r.dataset.level==='point' && Number(r.dataset.id)===200);
        return !!row && row.classList.contains('hidden-entry-row');
      })()`));
    // the member right-click gesture (a toggle) un-hides it — interop
    const row200 = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
      const el=[...b.querySelectorAll('.tree-row.selectable')]
        .find(r=>r.dataset.level==='point' && Number(r.dataset.id)===200);
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.rightClick(row200.x, row200.y);
    await sleep(150);
    check("S12: the member-row gesture inverts the command's member hide",
      (await visibleCount(d)) === 6000);
    // REVERSED: a point INSIDE the coarse member is NOT a member — nomatch,
    // no state; the route to that granularity is committing it fine
    const preC = await visibleCount(d);
    const rC = await cmd("hide @mix.#5");
    check("S12: an index inside a coarse member is a nomatch — no reach inside",
      rC.status === "nomatch" && (await visibleCount(d)) === preC, JSON.stringify(rC));
    const rFineRoute = await cmd("hide alpha.group-0.subgroup-0.#5 [p5]");
    check("S12: the sanctioned route — commit the fine target, then it hides",
      rFineRoute.message === `created and hid "p5" — 1 points` &&
        (await d.evaluate<boolean>(
          `${V}.model.committed().find(c=>c.name==='p5')?.hidden === true`)) &&
        (await visibleCount(d)) === 6000, // masked by the visible "mix" (show-wins)
      JSON.stringify(rFineRoute));
    await d.ctrlZ(); // one undo removes the fine selection + its hide
    await sleep(120);
    // a member LABEL names the whole member — the exact member-row analog
    const rT = await cmd("hide @mix.subgroup-0");
    check("S12: hide @name.<member-label> hides that whole member",
      rT.message === `hid 100 points in "mix"` && (await visibleCount(d)) === 5900,
      JSON.stringify(rT));
    const rAll = await cmd("show @mix.subgroup-0");
    check("S12: show @name.<member-label> is its exact inverse",
      rAll.message === `showed 100 points in "mix"` && (await visibleCount(d)) === 6000,
      JSON.stringify(rAll));
    // descendant types nomatch on both verbs (t1 lives under the member)
    const rDesc = await cmd("hide @mix.t1");
    check("S12: descendant types nomatch for hide too", rDesc.status === "nomatch");

    // -- the show-wins masked hide: state changes, pixels don't ---------------
    await cmd("create_sele alpha.group-0.subgroup-0 [inner]"); // covered by mix (visible)
    const visBefore = await visibleCount(d);
    const rMasked = await cmd("hide @inner");
    check("S12: a masked hide reports the hide it performed (not a failure)",
      rMasked.status === "ok" && rMasked.message === `hid "inner" — 100 points`,
      JSON.stringify(rMasked));
    check("S12: ...the block goes purple while the 3D count is unchanged (show-wins)",
      (await visibleCount(d)) === visBefore &&
        /hidden-sel/.test((await selHead(d, "/inner/"))!.cls));

    // -- bare show: reveal everything, one undo op ------------------------------
    await cmd("hide @solvent");
    check("S12: (setup) two selections hidden", (await visibleCount(d)) === 1200);
    const depthBeforeShow = await undoDepth();
    const rShowAll = await cmd("show");
    check("S12: bare show clears ALL hidden state",
      /^showed everything — \d+ points$/.test(rShowAll.message) &&
        (await visibleCount(d)) === 6000 &&
        (await d.evaluate<boolean>(`${V}.model.committed().every(c=>!c.hidden)`)),
      JSON.stringify(rShowAll));
    check("S12: ...as ONE undo op", (await undoDepth()) === depthBeforeShow + 1);
    await d.ctrlZ();
    await sleep(150);
    check("S12: undoing bare show restores both hides at once",
      (await visibleCount(d)) === 1200);
    await cmd("show");

    // -- member-state SYMMETRY: the reported repros ----------------------------
    // drop "inner" first — a visible coverer would mask (show-wins) exactly
    // the state changes this block asserts
    await d.evaluate(`(()=>{const v=${V};
      const inner=v.model.committed().find(c=>c.name==='inner');
      if (inner) v.refreshPoints(v.model.deleteSelection(inner.id));
    })()`);
    await sleep(120);
    // hide every member (@mix.* = both stored members: subgroup-0 + point 200)
    await cmd("hide @mix.*");
    check("S12: (repro setup) hide @name.* hides all members",
      (await visibleCount(d)) === 5899, `visible=${await visibleCount(d)}`);
    const rShowWhole = await cmd("show @mix");
    check("S12: show @name clears member hides too (the reported trap)",
      rShowWhole.message === `showed "mix" — 101 points` && (await visibleCount(d)) === 6000,
      JSON.stringify(rShowWhole));
    // a NARROWER member predicate clears exactly the matched MEMBERS
    await cmd("hide @mix.*");
    const rNarrow = await cmd("show @mix.subgroup-0");
    check("S12: a narrower show clears exactly the matched members",
      rNarrow.message === `showed 100 points in "mix"` && (await visibleCount(d)) === 5999,
      JSON.stringify(rNarrow) + ` visible=${await visibleCount(d)}`);
    check("S12: ...the unmatched point member stays hidden",
      await d.evaluate<boolean>(`${V}.model.isPointHidden(200)`));
    await cmd("show @mix");
    // ROUND-TRIP REGRESSION (the motivating bug): every command hide is
    // member state the UI displays and reverses — no stranded hidden points
    await cmd("hide @mix.*");
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
      const body=b.querySelector('.sel-body');
      if (body.style.display==='none' || !body.hasChildNodes()) b.querySelector('.caret').click();
    })()`);
    await sleep(200);
    check("S12: command hides render as purple MEMBER rows (UI-representable)",
      await d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        const rows=[...b.querySelectorAll('.tree-row.selectable')];
        return rows.length === 2 && rows.every(r=>r.classList.contains('hidden-entry-row'));
      })()`));
    // clear BOTH via real member right-clicks — the UI reverses everything
    for (const level of ["subgroup", "point"]) {
      const rRow = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        const el=[...b.querySelectorAll('.tree-row.selectable')]
          .find(r=>r.dataset.level===${JSON.stringify(level)});
        if(!el) return null; const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2, y:r.top+r.height/2};
      })()`))!;
      await d.rightClick(rRow.x, rRow.y);
      await sleep(150);
    }
    check("S12: UI gestures fully reverse the command's hides — nothing stranded",
      (await visibleCount(d)) === 6000 &&
        (await d.evaluate<number>(
          `${V}.model.committed().find(c=>c.name==='mix').hiddenPart.entryCount`)) === 0);
    // narrower round-trip returns to baseline with clean undo depth
    const depthRT = await undoDepth();
    await cmd("hide @mix.#200");
    await cmd("show @mix.#200");
    check("S12: a member hide/show round-trip → baseline, exactly two undo ops",
      (await visibleCount(d)) === 6000 && (await undoDepth()) === depthRT + 2);
    // whole flag + member hide clear together, as ONE op, and undo restores both
    await cmd("hide @mix.#200");
    await cmd("hide @mix");
    const depthBoth = await undoDepth();
    const rBoth = await cmd("show @mix");
    check("S12: show @name clears whole flag AND member hide as one undo op",
      (await visibleCount(d)) === 6000 && (await undoDepth()) === depthBoth + 1,
      JSON.stringify(rBoth));
    await d.ctrlZ();
    await sleep(120);
    check("S12: undoing that show restores both states together",
      (await visibleCount(d)) === 5899);
    await cmd("show @mix");
    // a MEMBER show against a WHOLE-hidden selection explains itself
    await cmd("hide @mix");
    const rHint = await cmd("show @mix.#200");
    check("S12: member show on a whole-hidden selection points at show @name",
      /hidden whole — show @mix to reveal it/.test(rHint.message), JSON.stringify(rHint));
    await cmd("show @mix");
    // the flat-bag principle is ENFORCED, not just documented
    const rFB1 = await cmd("view @mix.a.b");
    const rFB2 = await cmd("create_sele @mix.x.y");
    check("S12: @name.a.b errors identically for every verb (flat bag, no levels)",
      rFB1.status === "error" && /at most one leaf predicate/.test(rFB1.message) &&
        rFB2.status === "error" && /at most one leaf predicate/.test(rFB2.message),
      JSON.stringify([rFB1.message, rFB2.message]));

    // -- errors and empty matches ----------------------------------------------
    const rNoTarget = await cmd("hide");
    const rBadName = await cmd("hide @mix [x]");
    const rMiss = await cmd("hide zzz");
    check("S12: bare hide errors; @name+[name] errors; empty target nomatches",
      rNoTarget.status === "error" && /needs a target/.test(rNoTarget.message) &&
        rBadName.status === "error" && /applies only when hide commits/.test(rBadName.message) &&
        rMiss.status === "nomatch",
      JSON.stringify([rNoTarget.message, rBadName.message, rMiss.status]));
    await d.screenshot(`${REPORT}/S12_hide_show.png`);
  });
}

async function S13(): Promise<void> {
  console.log("S13 — all/@all, hide's commit rule (principle 3), ls, rename");
  await withDriver(async (d) => {
    await seedSolvent(d); // the visible bulk selection the setup builds on
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    // setup: a second selection alongside the visible bulk seed
    await cmd("create_sele alpha.group-0.subgroup-3 [mix]");
    check("S13: (setup) two committed selections", (await committed(d)).length === 2);
    const baseUndo = await undoDepth();

    // -- hide @all: every committed selection, IN PLACE, one undo op ----------
    let r = await cmd("hide @all");
    let sels = await committed(d);
    check("S13: hide @all hides every selection in place — nothing new committed",
      r.status === "ok" && r.message === "hid 4900 points across 2 selections" &&
        sels.length === 2 && sels.every((c) => c.hidden),
      JSON.stringify({ r, sels }));
    check("S13: ...their points leave the render", (await visibleCount(d)) === 1100);
    check("S13: ...as ONE undo op", (await undoDepth()) === baseUndo + 1);
    r = await cmd("hide @all");
    check("S13: hide @all is idempotent across the batch — never a toggle",
      r.message === "already hidden" && (await undoDepth()) === baseUndo + 1,
      JSON.stringify(r));
    await d.ctrlZ();
    await sleep(150);
    check("S13: one Ctrl+Z restores the whole batch",
      (await visibleCount(d)) === 6000 && (await undoDepth()) === baseUndo);

    // -- hide @a + @b ≡ hide @all here: all-reference target, same rule -------
    r = await cmd("hide @solvent + @mix");
    check("S13: hide @a + @b hides both in place (no commit)",
      r.message === "hid 4900 points across 2 selections" &&
        (await committed(d)).length === 2 && (await visibleCount(d)) === 1100,
      JSON.stringify(r));
    r = await cmd("hide @solvent + @mix [x]");
    check("S13: [name] on an already-committed target is a usage error",
      r.status === "error" && /applies only when hide commits/.test(r.message),
      JSON.stringify(r));
    await cmd("show");
    check("S13: (reset) everything visible again", (await visibleCount(d)) === 6000);

    // -- any non-reference term: the WHOLE target commits, ONCE ----------------
    const depthBeforeMix = await undoDepth();
    r = await cmd("hide @mix + alpha.group-0.subgroup-0 [combo]");
    sels = await committed(d);
    const combo = sels.find((c) => c.name === "combo");
    check("S13: a non-reference term makes the whole target commit as ONE selection",
      r.message === `created and hid "combo" — 200 points` &&
        sels.length === 3 && !!combo && combo.hidden,
      JSON.stringify({ r, names: sels.map((s) => s.name) }));
    check("S13: ...the referenced @mix stays untouched",
      sels.find((c) => c.name === "mix")!.hidden === false);
    check("S13: ...show-wins keeps @mix's covered points visible",
      (await visibleCount(d)) === 5900);
    check("S13: ...commit + hide = ONE undo op", (await undoDepth()) === depthBeforeMix + 1);
    await d.ctrlZ();
    await sleep(150);
    check("S13: one Ctrl+Z removes combo and restores visibility",
      (await committed(d)).length === 2 && (await visibleCount(d)) === 6000);

    // -- hide all: the everything KEYWORD is not a reference -------------------
    r = await cmd("hide all");
    check("S13: hide all commits ONE selection holding the whole system, honestly sized",
      /^created and hid "selection_\d+" — 6000 points$/.test(r.message) &&
        (await committed(d)).length === 3,
      JSON.stringify(r));
    check("S13: ...show-wins: points covered by visible selections stay",
      (await visibleCount(d)) === 4900);
    await d.ctrlZ();
    await sleep(150);
    check("S13: hide all fully reversed by one Ctrl+Z",
      (await committed(d)).length === 2 && (await visibleCount(d)) === 6000);

    // -- rename: command ≡ the panel's inline rename ---------------------------
    const depthBeforeRen = await undoDepth();
    r = await cmd("rename @mix [alpha-picks]");
    check("S13: rename routes through the model — one undo op",
      r.status === "ok" && r.message === `renamed "mix" → "alpha-picks"` &&
        (await committed(d)).some((c) => c.name === "alpha-picks") &&
        (await undoDepth()) === depthBeforeRen + 1,
      JSON.stringify(r));
    check("S13: the panel header shows the new name",
      !!(await selHead(d, "/alpha-picks/")) && !(await selHead(d, "/^mix$/")));
    r = await cmd("rename @alpha-picks [solvent]");
    check("S13: rename collision = the inline-rename error, exactly",
      r.status === "error" && r.message === `a selection named "solvent" already exists`,
      JSON.stringify(r));
    r = await cmd(`rename @alpha-picks [all]`);
    check(`S13: "all" is reserved as a selection name`,
      r.status === "error" && /reserved/.test(r.message), JSON.stringify(r));
    r = await cmd("create_sele beta [all]");
    check("S13: ...create_sele can't take it either",
      r.status === "error" && /reserved/.test(r.message), JSON.stringify(r));
    await d.ctrlZ();
    await sleep(150);
    check("S13: Ctrl+Z undoes the rename (parity with inline rename)",
      (await committed(d)).some((c) => c.name === "mix") &&
        (await undoDepth()) === depthBeforeRen);

    // -- ls: the panel's truth as read-only text --------------------------------
    const depthBeforeLs = await undoDepth();
    r = await cmd("ls");
    check("S13: ls lists the committed selections with sizes",
      r.status === "ok" && /solvent — 4800 points/.test(r.message) &&
        /mix — 100 points/.test(r.message),
      JSON.stringify(r));
    r = await cmd("ls @mix");
    check("S13: ls @name = the STORED members, at their stored levels",
      r.status === "ok" && r.message === "subgroup-3 — 100 points", JSON.stringify(r));
    // parity with the panel: mix's member list holds exactly that subgroup entry
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
      const body=b.querySelector('.sel-body');
      if (body.style.display==='none' || !body.hasChildNodes()) b.querySelector('.caret').click();
    })()`);
    await sleep(200);
    const panelMembers = await d.evaluate<string[]>(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')]
        .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
      return [...b.querySelectorAll('.tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0 && r.dataset.level==='subgroup')
        .map(r=>r.textContent.trim());
    })()`);
    check("S13: ...exactly what the panel's member list shows",
      panelMembers.length === 1 && /subgroup-3/.test(panelMembers[0]),
      JSON.stringify(panelMembers));
    r = await cmd("ls @all");
    check("S13: ls @all pools every selection's members",
      r.status === "ok" && r.message === "solvent — 4800 points\nsubgroup-3 — 100 points",
      JSON.stringify(r));
    r = await cmd("ls alpha.group-0");
    check("S13: ls <path> lists the contents ONE level below",
      r.status === "ok" && /subgroup-0 — 100 points/.test(r.message) &&
        /subgroup-3 — 100 points/.test(r.message),
      JSON.stringify(r));
    r = await cmd("ls solvent.solvent-bath");
    check("S13: long listings cap with a count-and-hint (completion's rule)",
      r.status === "ok" && r.message === "1600 items — narrow the target",
      JSON.stringify(r));
    r = await cmd("ls @nope");
    check("S13: ls honest nomatch", r.status === "nomatch", JSON.stringify(r));
    check("S13: ls created NO state — undo depth untouched",
      (await undoDepth()) === depthBeforeLs);
    await d.screenshot(`${REPORT}/S13_batch.png`);
  });
}

async function S14(): Promise<void> {
  console.log("S14 — add/remove: membership mutation at whole-member granularity");
  await withDriver(async (d) => {
    await seedSolvent(d); // the untargeted "solvent" selection the edit checks use
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const entriesOf = (name: string) =>
      d.evaluate<{ level: string; id: number }[] | null>(
        `${V}.model.committed().find(c=>c.name===${JSON.stringify(name)})?.set.listEntries() ?? null`,
      );
    const openBlock = (name: string) =>
      d.evaluate(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent===${JSON.stringify(name)});
        if(!b) return;
        const body=b.querySelector('.sel-body');
        if (!body || body.style.display==='none' || !body.hasChildNodes())
          b.querySelector('.caret').click();
      })()`);
    // setup: one selection + the visible tree expanded to subgroup rows
    await cmd("create_sele alpha.group-0.subgroup-0 [mix]");
    await expandBottomCategory(d, "/alpha/");
    await sleep(200);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      rows.find(r=>r.dataset.level==='group')?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    const baseline = JSON.stringify(await entriesOf("mix"));
    const baseUndo = await undoDepth();

    // -- ADD: the edit-mode gesture arm ----------------------------------------
    await clickSelCtl(d, "/^mix$/", "edit");
    await sleep(200);
    const sub3 = (await bottomRow(d, "/subgroup-3/"))!;
    await d.click(sub3.x, sub3.y); // edit-mode row click = addToTarget
    await sleep(150);
    await clickSelCtl(d, "/^mix$/", "done");
    await sleep(200);
    const gEntries = JSON.stringify(await entriesOf("mix"));
    check("S14: (gesture) edit-click adds the subgroup as ONE member",
      (await entriesOf("mix"))!.length === 2 && (await undoDepth()) === baseUndo + 1,
      gEntries);
    await d.ctrlZ();
    await sleep(120);
    check("S14: (gesture) one Ctrl+Z reverts the member add",
      JSON.stringify(await entriesOf("mix")) === baseline && (await undoDepth()) === baseUndo);

    // -- ADD: the command arm — identical membership, panel update, one undo ---
    let r = await cmd("add @mix alpha.group-0.subgroup-3");
    check("S14: add @name <path> reports member + points",
      r.status === "ok" && r.message === `added 1 members to "mix" — 100 points`,
      JSON.stringify(r));
    check("S14: command membership ≡ the edit-mode gesture's, byte-identical",
      JSON.stringify(await entriesOf("mix")) === gEntries);
    check("S14: ...one undo op", (await undoDepth()) === baseUndo + 1);
    await openBlock("mix");
    await sleep(200);
    check("S14: ...the member row appears in the panel without edit mode",
      await d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        return !!b && [...b.querySelectorAll('.tree-row.selectable')]
          .some(r=>r.dataset.level==='subgroup' && Number(r.dataset.id)===3);
      })()`));

    // -- ADD: natural level + idempotence + tree-only right side ----------------
    r = await cmd("add @mix alpha.group-0");
    check("S14: a group-level address adds ONE group entry (natural level)",
      r.status === "ok" && (await entriesOf("mix"))!.some((e) => e.level === "group") &&
        (await entriesOf("mix"))!.length === 3,
      JSON.stringify(r));
    const depthG = await undoDepth();
    r = await cmd("add @mix alpha.group-0");
    check("S14: re-adding an exact member is an honest no-op (no undo entry)",
      r.message === `already members — nothing to add to "mix"` &&
        (await undoDepth()) === depthG,
      JSON.stringify(r));
    r = await cmd("add @mix @solvent");
    check("S14: add rejects @ terms on the right (no member transfer)",
      r.status === "error" && /no @ terms on the right/.test(r.message), JSON.stringify(r));
    await d.ctrlZ(); // revert the group add → mix = subgroup-0 + subgroup-3
    await sleep(120);

    // -- REMOVE: the member-✕ gesture arm vs the command ------------------------
    const with3 = JSON.stringify(await entriesOf("mix"));
    const depthWith3 = await undoDepth();
    await clickSelCtl(d, "/^mix$/", "edit");
    await sleep(200);
    await openBlock("mix");
    await sleep(150);
    check("S14: (gesture) the member ✕ removes exactly that member",
      await d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        const row=[...b.querySelectorAll('.tree-row.selectable')]
          .find(r=>r.dataset.level==='subgroup' && Number(r.dataset.id)===3);
        const rm=row?.querySelector('.entry-remove');
        if(!rm) return false; rm.click(); return true;
      })()`));
    await sleep(150);
    await clickSelCtl(d, "/^mix$/", "done");
    await sleep(150);
    check("S14: (gesture) membership back to baseline, one undo op",
      JSON.stringify(await entriesOf("mix")) === baseline &&
        (await undoDepth()) === depthWith3 + 1);
    await d.ctrlZ(); // back to with3
    await sleep(120);
    r = await cmd("remove @mix subgroup-3");
    check("S14: remove @name <label> ≡ the member-✕ gesture (state + one undo)",
      r.message === `removed 1 members from "mix" — 100 points` &&
        JSON.stringify(await entriesOf("mix")) === baseline &&
        (await undoDepth()) === depthWith3 + 1,
      JSON.stringify(r));

    // -- REMOVE: no carve — sub-member predicates nomatch -----------------------
    const depthNC = await undoDepth();
    const rT = await cmd("remove @mix t0"); // a type INSIDE the coarse member
    const rI = await cmd("remove @mix #5"); // an index inside it
    check("S14: predicates below a coarse member NOMATCH — no carve, no mutation",
      rT.status === "nomatch" && rI.status === "nomatch" &&
        JSON.stringify(await entriesOf("mix")) === baseline &&
        (await undoDepth()) === depthNC,
      JSON.stringify([rT.message, rI.message]));

    // -- REMOVE @name all / last-member predicate: empty STANDS -----------------
    r = await cmd("remove @mix all");
    check("S14: remove @name all empties the membership",
      r.message === `removed 1 members from "mix" — 100 points (now empty — the selection remains)`,
      JSON.stringify(r));
    check("S14: the empty selection STANDS as a panel block",
      !!(await selHead(d, "/^mix$/")) &&
        (await committed(d)).find((c) => c.name === "mix")!.pts === 0);
    await d.ctrlZ();
    await sleep(120);
    r = await cmd("remove @mix subgroup-*"); // incidental last-member predicate
    check("S14: an incidental empty behaves identically — it stays",
      /now empty — the selection remains/.test(r.message) &&
        !!(await selHead(d, "/^mix$/")),
      JSON.stringify(r));
    await d.ctrlZ();
    await sleep(120);

    // -- bare remove @name: DELETE (the ✕ analog), one-undo restore -------------
    // (subgroup-3: alpha's branch of the spanning group-0 holds only 0 and 3)
    await cmd("create_sele alpha.group-0.subgroup-3 [tmp]");
    const countBefore = (await committed(d)).length;
    const depthDel = await undoDepth();
    r = await cmd("remove @tmp");
    check("S14: bare remove @name deletes the selection",
      r.message === `deleted "tmp" — 100 points` &&
        (await committed(d)).length === countBefore - 1 &&
        !(await selHead(d, "/^tmp$/")),
      JSON.stringify(r));
    check("S14: ...one undo op", (await undoDepth()) === depthDel + 1);
    await d.ctrlZ();
    await sleep(150);
    check("S14: Ctrl+Z restores the deleted selection intact",
      (await committed(d)).some((c) => c.name === "tmp" && c.pts === 100));
    await cmd("remove @tmp"); // drop it again for the blocks below

    // -- remove @all: everything gone, ONE undo restores everything -------------
    const namesBefore = (await committed(d)).map((c) => c.name).sort();
    const depthAll = await undoDepth();
    r = await cmd("remove @all");
    check("S14: remove @all deletes EVERY selection",
      /^deleted \d+ selections — \d+ points$/.test(r.message) &&
        (await committed(d)).length === 0,
      JSON.stringify(r));
    check("S14: ...as one undo op", (await undoDepth()) === depthAll + 1);
    await d.ctrlZ();
    await sleep(200);
    check("S14: one Ctrl+Z restores them ALL",
      JSON.stringify((await committed(d)).map((c) => c.name).sort()) ===
        JSON.stringify(namesBefore));
    r = await cmd("remove @all s0");
    check("S14: remove @all takes no second argument",
      r.status === "error" && /takes no second argument/.test(r.message), JSON.stringify(r));

    // -- edit-mode independence + round-trip + others untouched -----------------
    const solventBefore = JSON.stringify(
      (await committed(d)).find((c) => c.name === "solvent"));
    await clickSelCtl(d, "/solvent/", "edit");
    await sleep(150);
    r = await cmd("add @mix alpha.group-0.subgroup-3");
    check("S14: add is edit-mode independent — lands on @mix mid-edit of another",
      r.status === "ok" &&
        (await entriesOf("mix"))!.some((e) => e.level === "subgroup" && e.id === 3) &&
        (await editingName(d)) === "solvent",
      JSON.stringify(r));
    await clickSelCtl(d, "/solvent/", "done");
    await sleep(120);
    r = await cmd("remove @mix subgroup-3");
    check("S14: add-then-remove round-trips to baseline membership",
      r.status === "ok" && JSON.stringify(await entriesOf("mix")) === baseline,
      JSON.stringify(r));
    check("S14: the untargeted selection was never touched",
      JSON.stringify((await committed(d)).find((c) => c.name === "solvent")) ===
        solventBefore);
    await d.screenshot(`${REPORT}/S14_membership.png`);
  });
}

async function S15(): Promise<void> {
  console.log("S15 — colorpoints: the first representation verb (constant per-point color)");
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent in the parity matrix
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    /** Snapshot the color buffer in-page (comparisons stay in-page too). */
    const snap = (slot: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.color))`);
    const buffersEqual = (slot: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.color, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    /** Run `colorpoints <expr> <tok>` and audit RESOLUTION PARITY in-page: the set
     * of points whose buffer values changed must equal debug.resolvePoints
     * (the exact union view frames). Callers use a fresh color per audit so
     * "changed" can't undercount on already-that-color points. */
    const paint = async (expr: string, tok: string) => {
      await snap("__preColor");
      const r = await cmd(`colorpoints ${expr} ${tok}`);
      const parity = await d.evaluate<{ changed: number; match: boolean }>(`(()=>{
        const v=${V}; const c=v.rep.state.color; const s=window.__preColor;
        const changed=[];
        for (let p=0;p<c.length/3;p++) {
          if (c[3*p]!==s[3*p]||c[3*p+1]!==s[3*p+1]||c[3*p+2]!==s[3*p+2]) changed.push(p);
        }
        const want=[...new Set(v.debug.resolvePoints(${JSON.stringify(expr)}))].sort((a,b)=>a-b);
        return { changed: changed.length,
                 match: changed.length===want.length && changed.every((p,i)=>p===want[i]) };
      })()`);
      return { r, parity };
    };
    /** Every point of `expr` carries exactly this RGB (0..255 ints). */
    const allColored = (expr: string, rgb: [number, number, number]) =>
      d.evaluate<boolean>(`(()=>{
        const v=${V}; const c=v.rep.state.color;
        const want=[${rgb.join(",")}].map(x=>Math.fround(x/255));
        return v.debug.resolvePoints(${JSON.stringify(expr)})
          .every(p=>c[3*p]===want[0]&&c[3*p+1]===want[1]&&c[3*p+2]===want[2]);
      })()`);

    await snap("__pristine");
    const baseDepth = await undoDepth();

    // -- (a) resolution parity: color <t> writes the set view <t> resolves ------
    // fresh hex per audit; targets cover category, deep glob+leaf, #index
    // range, quoted spaced label, and a committed @name reference
    for (const [expr, tok] of [
      ["alpha", "#123456"],
      ["beta.group-*.*.t1", "#234567"],
      ["#100-140", "#345678"],
      ['gamma.group-2."subgroup 11"', "#456789"],
      ["@solvent", "#567890"],
    ] as const) {
      const { r, parity } = await paint(expr, tok);
      check(`S15: colorpoints ${expr} — writes EXACTLY the set view resolves`,
        r.status === "ok" && parity.match && parity.changed > 0,
        `${JSON.stringify(r)} changed=${parity.changed}`);
      check(`S15: ...message reports the action and count`,
        r.message === `colored ${parity.changed} points ${tok}`, r.message);
    }

    // -- (b) a hidden point set colors too, one stroke ---------------------------
    await cmd("hide alpha [tmphide]");
    const visAfterHide = await visibleCount(d);
    const depthHidden = await undoDepth();
    const hid = await paint("alpha", "#654321");
    check("S15: coloring a HIDDEN set writes the buffer (report the action, not pixels)",
      hid.r.status === "ok" && hid.parity.match && hid.parity.changed > 0,
      JSON.stringify(hid));
    check("S15: ...as exactly ONE undo stroke",
      (await undoDepth()) === depthHidden + 1);
    check("S15: ...and unhides nothing", (await visibleCount(d)) === visAfterHide);

    // -- (c) Ctrl+Z reverts a color in exactly one step --------------------------
    await d.ctrlZ();
    await sleep(120);
    check("S15: one Ctrl+Z restores the exact previous buffer",
      (await buffersEqual("__preColor")) && (await undoDepth()) === depthHidden);
    check("S15: ...and pops ONLY the color stroke — the hide beneath it stands",
      (await visibleCount(d)) === visAfterHide);
    await d.ctrlZ(); // pop the hide too; back to an all-visible scene
    await sleep(120);

    // unwind the (a) paints too — and prove color strokes compose LIFO all
    // the way back to the untouched buffer
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    check("S15: unwinding every stroke restores the pristine buffer",
      await buffersEqual("__pristine"));

    // -- (d) last-write-wins on overlapping targets ------------------------------
    // (subgroup-0 sits fully inside alpha — no spanning-group surprises here)
    await cmd("colorpoints alpha red");
    await cmd("colorpoints alpha.group-0.subgroup-0 blue");
    check("S15: re-coloring an overlap overwrites those points",
      await allColored("alpha.group-0.subgroup-0", [0, 0, 255]));
    check("S15: ...points outside the overlap keep the first color",
      await d.evaluate<boolean>(`(()=>{
        const v=${V}; const c=v.rep.state.color;
        const inner=new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"));
        return v.debug.resolvePoints("alpha").filter(p=>!inner.has(p))
          .every(p=>c[3*p]===1&&c[3*p+1]===0&&c[3*p+2]===0);
      })()`));
    await d.ctrlZ();
    await sleep(120);
    check("S15: undo restores the PREVIOUS color (red), not the base look",
      await allColored("alpha.group-0.subgroup-0", [255, 0, 0]));
    await d.ctrlZ();
    await sleep(120);
    check("S15: a second undo restores the uniform base look",
      await d.evaluate<boolean>(`(()=>{
        const v=${V}; const c=v.rep.state.color; const base=Math.fround(0.9);
        return v.debug.resolvePoints("alpha")
          .every(p=>c[3*p]===base&&c[3*p+1]===base&&c[3*p+2]===base);
      })()`));

    // -- (e) nomatch / error / bare color write nothing, push no stroke ----------
    await snap("__noWrite");
    const depthQuiet = await undoDepth();
    const quiet: [string, string][] = [
      ["colorpoints nothere red", "nomatch"],
      ["colorpoints alpha notacolor", "error"],
      ["colorpoints", "error"],
      ["colorpoints alpha", "error"], // one chunk: a color but no target
      ["colorpoints alpha.[x] red", "error"], // [ reserved inside expressions
      ["color alpha red", "error"], // the RENAME is total: no alias survives
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S15: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S15: ...none of them wrote a single component",
      await buffersEqual("__noWrite"));
    check("S15: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);

    await d.screenshot(`${REPORT}/S15_color.png`);
  });
}

async function S16(): Promise<void> {
  console.log("S16 — colorbonds/colorbondsof: the edge verbs (contained vs incident)");
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent in the parity matrix
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: "color" | "edgeColorA") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: "color" | "edgeColorA") =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    /** Run an edge verb and audit EDGE PARITY in-page: the set of edge ids
     * whose buffer values changed must equal the endpoint predicate over
     * resolvePoints — both-in for colorbonds, either-in for colorbondsof.
     * `reach` counts changed edges with an endpoint OUTSIDE the resolved set
     * (must be 0 for colorbonds; >0 proves colorbondsof's incident reach).
     * Fresh color per audit so "changed" can't undercount. */
    const paintE = async (verb: "colorbonds" | "colorbondsof", expr: string, tok: string) => {
      await snap("__preEdge", "edgeColorA");
      const r = await cmd(`${verb} ${expr} ${tok}`);
      const parity = await d.evaluate<{ changed: number; match: boolean; reach: number }>(`(()=>{
        const v=${V}; const ec=v.rep.state.edgeColorA; const s=window.__preEdge;
        const changed=[];
        for (let e=0;e<v.edges.length;e++) {
          if (ec[3*e]!==s[3*e]||ec[3*e+1]!==s[3*e+1]||ec[3*e+2]!==s[3*e+2]) changed.push(e);
        }
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        const both=${verb === "colorbonds"};
        const want=[];
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (both ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b))) want.push(e);
        }
        let reach=0;
        for (const e of changed) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (!pts.has(a)||!pts.has(b)) reach++;
        }
        return { changed: changed.length, reach,
                 match: changed.length===want.length && changed.every((e,i)=>e===want[i]) };
      })()`);
      return { r, parity };
    };
    /** Every edge matching (expr, mode) carries exactly this RGB (0..255). */
    const edgesColored = (expr: string, both: boolean, rgb: [number, number, number]) =>
      d.evaluate<boolean>(`(()=>{
        const v=${V}; const ec=v.rep.state.edgeColorA;
        const w=[${rgb.join(",")}].map(x=>Math.fround(x/255));
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          const hit=${both} ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b));
          if (hit && (ec[3*e]!==w[0]||ec[3*e+1]!==w[1]||ec[3*e+2]!==w[2])) return false;
        }
        return true;
      })()`);

    await snap("__pristineE", "edgeColorA");
    const baseDepth = await undoDepth();

    // -- (a) colorbonds parity: contained edges only, across target kinds --------
    for (const [expr, tok] of [
      ["alpha", "#123456"],
      ["beta.group-0.subgroup-1", "#234567"], // beta's subgroups sit under group-0
      ["#100-140", "#345678"],
      ['gamma.group-2."subgroup 11"', "#456789"],
      ["@solvent", "#567890"],
    ] as const) {
      const { r, parity } = await paintE("colorbonds", expr, tok);
      check(`S16: colorbonds ${expr} — colors EXACTLY the both-endpoints-in edges`,
        r.status === "ok" && parity.match && parity.changed > 0 && parity.reach === 0,
        `${JSON.stringify(r)} changed=${parity.changed} reach=${parity.reach}`);
      check(`S16: ...message reports the action and count`,
        r.message === `colored ${parity.changed} edges ${tok}`, r.message);
    }

    // -- (b) colorbondsof parity: incident edges, including the deliberate reach -
    // beta.group-*.*.t1 resolves scattered non-adjacent points (t1 = every 4th
    // point of a chain), so EVERY incident edge leans on an out-of-set endpoint
    for (const [expr, tok, wantReach] of [
      ["alpha", "#615243", false],
      ["beta.group-*.*.t1", "#726354", true],
    ] as const) {
      const { r, parity } = await paintE("colorbondsof", expr, tok);
      check(`S16: colorbondsof ${expr} — colors EXACTLY the either-endpoint-in edges`,
        r.status === "ok" && parity.match && parity.changed > 0,
        `${JSON.stringify(r)} changed=${parity.changed}`);
      if (wantReach) {
        check("S16: ...edges whose OTHER endpoint is outside the target color anyway",
          parity.reach > 0 && parity.reach === parity.changed,
          `reach=${parity.reach} of ${parity.changed}`);
      }
    }

    // -- (c) the single-point pin: contained nomatches, incident reaches ---------
    await snap("__quietE", "edgeColorA");
    const depthQuiet1 = await undoDepth();
    const single = await cmd("colorbonds #124 red");
    check("S16: colorbonds on a one-point set is a nomatch (no contained edge exists)",
      single.status === "nomatch" &&
        single.message === `no edges with both endpoints in "#124"`,
      JSON.stringify(single));
    check("S16: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietE", "edgeColorA")) && (await undoDepth()) === depthQuiet1);
    const incident = await paintE("colorbondsof", "#124", "#818283");
    check("S16: colorbondsof #124 colors exactly the edges incident to that point",
      incident.r.status === "ok" && incident.parity.match && incident.parity.changed > 0 &&
        incident.parity.reach === incident.parity.changed,
      JSON.stringify(incident));
    check("S16: ...one stroke", (await undoDepth()) === depthQuiet1 + 1);

    // -- (d) independence: each verb writes ITS primitive's buffer only ----------
    await snap("__indepE", "edgeColorA");
    await cmd("colorpoints beta #0a0b0c");
    check("S16: colorpoints leaves the edge buffer untouched",
      await equalsSnap("__indepE", "edgeColorA"));
    await snap("__indepP", "color");
    await cmd("colorbonds beta #0d0e0f");
    check("S16: colorbonds leaves the point buffer untouched",
      await equalsSnap("__indepP", "color"));

    // -- (e) undo/LWW on the edge buffer -----------------------------------------
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    check("S16: unwinding every stroke restores the pristine edge buffer",
      await equalsSnap("__pristineE", "edgeColorA"));
    await cmd("colorbonds alpha red");
    await cmd("colorbonds alpha.group-0.subgroup-0 blue");
    check("S16: re-coloring an edge overlap overwrites those edges (LWW)",
      await edgesColored("alpha.group-0.subgroup-0", true, [0, 0, 255]));
    await d.ctrlZ();
    await sleep(120);
    check("S16: undo restores the PREVIOUS edge color (red), not the base look",
      await edgesColored("alpha.group-0.subgroup-0", true, [255, 0, 0]));
    await d.ctrlZ();
    await sleep(120);
    check("S16: a second undo restores the uniform edge base look",
      await edgesColored("alpha", true, [0x5a, 0x7a, 0x9a]));

    // -- (f) a hidden point set's edges color too, one stroke --------------------
    await cmd("hide alpha [tmphide]");
    const visHidden = await visibleCount(d);
    const depthHidden = await undoDepth();
    const hid = await paintE("colorbonds", "alpha", "#654321");
    check("S16: coloring a HIDDEN set's edges writes the buffer",
      hid.r.status === "ok" && hid.parity.match && hid.parity.changed > 0,
      JSON.stringify(hid));
    check("S16: ...as exactly ONE undo stroke", (await undoDepth()) === depthHidden + 1);
    check("S16: ...and unhides nothing", (await visibleCount(d)) === visHidden);
    await d.ctrlZ();
    await sleep(120);
    check("S16: one Ctrl+Z pops ONLY the edge-color stroke — the hide stands",
      (await equalsSnap("__preEdge", "edgeColorA")) &&
        (await undoDepth()) === depthHidden && (await visibleCount(d)) === visHidden);

    // -- (g) the remaining quiet paths for the edge verbs -------------------------
    await snap("__quiet2E", "edgeColorA");
    const depthQuiet2 = await undoDepth();
    const quiet: [string, string][] = [
      ["colorbonds nothere red", "nomatch"],
      ["colorbondsof nothere red", "nomatch"],
      ["colorbonds alpha notacolor", "error"],
      ["colorbondsof", "error"],
      ["colorbonds red", "error"], // one chunk: a color but no target
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S16: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S16: ...none of them wrote a single component",
      await equalsSnap("__quiet2E", "edgeColorA"));
    check("S16: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet2);

    await d.screenshot(`${REPORT}/S16_colorbonds.png`);
  });
}

async function S17(): Promise<void> {
  console.log("S17 — colortrace: per-vertex polyline color, mapped up to subgroup grain");
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent the nomatch case targets
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: "color" | "edgeColorA" | "traceColor") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: "color" | "edgeColorA" | "traceColor") =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    /** Run colortrace and audit VERTEX PARITY in-page: the vertex ids whose
     * buffer values changed must equal {V | subgroup(V) has ≥1 point in
     * resolvePoints} — the map-up rule. Ships the changed ids back (≤12
     * vertices in the harness) so scatter assertions can pin exact sets. */
    const paintT = async (expr: string, tok: string) => {
      await snap("__preTrace", "traceColor");
      const r = await cmd(`colortrace ${expr} ${tok}`);
      const parity = await d.evaluate<{ ids: number[]; match: boolean }>(`(()=>{
        const v=${V}; const tc=v.rep.state.traceColor; const s=window.__preTrace;
        const changed=[];
        for (let i=0;i<v.traceVertices.length;i++) {
          if (tc[3*i]!==s[3*i]||tc[3*i+1]!==s[3*i+1]||tc[3*i+2]!==s[3*i+2]) changed.push(i);
        }
        const active=new Set(v.debug.resolvePoints(${JSON.stringify(expr)})
          .map(p=>v.hierarchy.subgroupOfPoint(p)));
        const want=[];
        for (let i=0;i<v.traceVertices.length;i++) {
          if (active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]))) want.push(i);
        }
        return { ids: changed,
                 match: changed.length===want.length && changed.every((x,i)=>x===want[i]) };
      })()`);
      return { r, parity };
    };
    /** Every listed vertex carries exactly this RGB (0..255 ints). */
    const verticesColored = (ids: number[], rgb: [number, number, number]) =>
      d.evaluate<boolean>(`(()=>{
        const tc=${V}.rep.state.traceColor;
        const w=[${rgb.join(",")}].map(x=>Math.fround(x/255));
        return ${JSON.stringify(ids)}
          .every(i=>tc[3*i]===w[0]&&tc[3*i+1]===w[1]&&tc[3*i+2]===w[2]);
      })()`);

    await snap("__pristineT", "traceColor");
    const baseDepth = await undoDepth();

    // -- (a) vertex parity, incl. the SCATTERED single-category pin --------------
    // the polyline threads subgroups whose category cycles, so alpha's vertex
    // set is non-adjacent BY DESIGN — pinned exactly, not smoothed over
    const alpha = await paintT("alpha", "#123456");
    check("S17: colortrace alpha — colors EXACTLY the active-subgroup vertices",
      alpha.r.status === "ok" && alpha.parity.match,
      `${JSON.stringify(alpha.r)} ids=${JSON.stringify(alpha.parity.ids)}`);
    check("S17: ...and that set is the SCATTERED [0,3,6,9] (category cycling pinned)",
      JSON.stringify(alpha.parity.ids) === "[0,3,6,9]",
      JSON.stringify(alpha.parity.ids));
    check("S17: ...message reports the action and count",
      alpha.r.message === "colored 4 trace vertices #123456", alpha.r.message);
    for (const [expr, tok, wantIds] of [
      ["beta.group-0.subgroup-1", "#234567", "[1]"],
      ["#100-140", "#345678", "[1]"], // those points all sit in subgroup 1
      ['gamma.group-2."subgroup 11"', "#456789", "[11]"],
    ] as const) {
      const { r, parity } = await paintT(expr, tok);
      check(`S17: colortrace ${expr} — parity + exact ids ${wantIds}`,
        r.status === "ok" && parity.match && JSON.stringify(parity.ids) === wantIds,
        `${JSON.stringify(r)} ids=${JSON.stringify(parity.ids)}`);
    }
    await cmd("create_sele gamma [gsel]");
    const ref = await paintT("@gsel", "#565758");
    check("S17: colortrace @gsel — an @-reference maps up like any target",
      ref.r.status === "ok" && ref.parity.match &&
        JSON.stringify(ref.parity.ids) === "[2,5,8,11]",
      JSON.stringify(ref.parity.ids));

    // -- (b) the map-up granularity: one point activates its subgroup's vertex ---
    const one = await paintT("#124", "#616263");
    check("S17: colortrace #124 colors exactly its subgroup's ONE vertex (map-up)",
      one.r.status === "ok" && one.parity.match &&
        JSON.stringify(one.parity.ids) === "[1]" &&
        one.r.message === "colored 1 trace vertices #616263",
      `${JSON.stringify(one.r)} ids=${JSON.stringify(one.parity.ids)}`);

    // -- (c) active subgroups owning no vertices = nomatch ------------------------
    await snap("__quietT", "traceColor");
    const depthQuiet1 = await undoDepth();
    const bulk = await cmd("colortrace @solvent red");
    check("S17: colortrace @solvent — bulk subgroups own no vertices → nomatch",
      bulk.status === "nomatch" && bulk.message === `no trace vertices in "@solvent"`,
      JSON.stringify(bulk));
    check("S17: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietT", "traceColor")) && (await undoDepth()) === depthQuiet1);

    // -- (d) independence: four verbs, three buffers, no cross-talk ---------------
    await snap("__indepP", "color");
    await snap("__indepE", "edgeColorA");
    await cmd("colortrace beta #0a0b0c");
    check("S17: colortrace leaves the point AND edge buffers untouched",
      (await equalsSnap("__indepP", "color")) && (await equalsSnap("__indepE", "edgeColorA")));
    await snap("__indepT", "traceColor");
    await cmd("colorpoints beta #0d0e0f");
    await cmd("colorbonds beta #101112");
    await cmd("colorbondsof beta #131415");
    check("S17: colorpoints/colorbonds/colorbondsof leave traceColor untouched",
      await equalsSnap("__indepT", "traceColor"));

    // -- (e) undo/LWW on the trace buffer -----------------------------------------
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    check("S17: unwinding every stroke restores the pristine trace buffer",
      await equalsSnap("__pristineT", "traceColor"));
    await cmd("colortrace all red");
    check("S17: colortrace all colors every vertex",
      await verticesColored([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [255, 0, 0]));
    await cmd("colortrace alpha blue");
    check("S17: re-coloring an overlap overwrites those vertices (LWW)",
      (await verticesColored([0, 3, 6, 9], [0, 0, 255])) &&
        (await verticesColored([1, 2, 4, 5], [255, 0, 0])));
    await d.ctrlZ();
    await sleep(120);
    check("S17: undo restores the PREVIOUS vertex color (red), not the base look",
      await verticesColored([0, 3, 6, 9], [255, 0, 0]));
    await d.ctrlZ();
    await sleep(120);
    check("S17: a second undo restores the uniform trace base look",
      await verticesColored([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [0x9a, 0x7a, 0x5a]));

    // -- (f) a hidden target's vertices color too, one stroke ---------------------
    await cmd("hide alpha [tmphide]");
    const visHidden = await visibleCount(d);
    const depthHidden = await undoDepth();
    const hid = await paintT("alpha", "#654321");
    check("S17: coloring a HIDDEN target's vertices writes the buffer",
      hid.r.status === "ok" && hid.parity.match &&
        JSON.stringify(hid.parity.ids) === "[0,3,6,9]",
      JSON.stringify(hid));
    check("S17: ...as exactly ONE undo stroke", (await undoDepth()) === depthHidden + 1);
    check("S17: ...and unhides nothing", (await visibleCount(d)) === visHidden);
    await d.ctrlZ();
    await sleep(120);
    check("S17: one Ctrl+Z pops ONLY the trace stroke — the hide stands",
      (await equalsSnap("__preTrace", "traceColor")) &&
        (await undoDepth()) === depthHidden && (await visibleCount(d)) === visHidden);

    // -- (g) the remaining quiet paths --------------------------------------------
    await snap("__quiet2T", "traceColor");
    const depthQuiet2 = await undoDepth();
    const quiet: [string, string][] = [
      ["colortrace nothere red", "nomatch"],
      ["colortrace alpha notacolor", "error"],
      ["colortrace", "error"],
      ["colortrace red", "error"], // one chunk: a color but no target
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S17: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S17: ...none of them wrote a single component",
      await equalsSnap("__quiet2T", "traceColor"));
    check("S17: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet2);

    await d.screenshot(`${REPORT}/S17_colortrace.png`);
  });
}

async function S18(): Promise<void> {
  console.log("S18 — the size family: pointsize/bondsize/bondsizeof/tracesize (size ⊥ hide)");
  const BUFS = ["color", "edgeColorA", "edgeColorB", "traceColor", "size", "edgeSize", "traceSize"] as const;
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent in the verb matrix
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    const snapAll = async () => {
      for (const b of BUFS) await snap(`__all_${b}`, b);
    };
    /** Which of the six buffers changed since snapAll — the independence
     * audit runs over the WHOLE eight-verb grid with this one helper. */
    const changedBuffers = async (): Promise<string> => {
      const out: string[] = [];
      for (const b of BUFS) if (!(await equalsSnap(`__all_${b}`, b))) out.push(b);
      return JSON.stringify(out);
    };
    /** Size parity per primitive: the set of buffer slots whose value
     * changed must equal the verb's map-up over resolvePoints. */
    const paintSize = async (
      verb: "pointsize" | "bondsize" | "bondsizeof" | "tracesize",
      expr: string,
      size: string,
    ) => {
      const buf = verb === "pointsize" ? "size" : verb === "tracesize" ? "traceSize" : "edgeSize";
      await snap("__preSize", buf);
      const r = await cmd(`${verb} ${expr} ${size}`);
      const parity = await d.evaluate<{ ids: number[]; match: boolean; reach: number }>(`(()=>{
        const v=${V}; const c=v.rep.state.${buf}; const s=window.__preSize;
        const changed=[];
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) changed.push(i);
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        let want=[]; let reach=0;
        if (${JSON.stringify(verb)} === "pointsize") {
          want=[...pts].sort((a,b)=>a-b);
        } else if (${JSON.stringify(verb)} === "tracesize") {
          const active=new Set([...pts].map(p=>v.hierarchy.subgroupOfPoint(p)));
          for (let i=0;i<v.traceVertices.length;i++) {
            if (active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]))) want.push(i);
          }
        } else {
          const both=${JSON.stringify(verb)} === "bondsize";
          for (let e=0;e<v.edges.length;e++) {
            const a=v.edges[e][0], b=v.edges[e][1];
            if (both ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b))) want.push(e);
          }
          for (const e of changed) {
            const a=v.edges[e][0], b=v.edges[e][1];
            if (!pts.has(a)||!pts.has(b)) reach++;
          }
        }
        return { ids: changed.length<=16?changed:[], reach,
                 match: changed.length===want.length && changed.every((x,i)=>x===want[i]) };
      })()`);
      return { r, parity };
    };
    /** Every resolved point of `expr` carries exactly this point size. */
    const pointsSized = (expr: string, val: number) =>
      d.evaluate<boolean>(`(()=>{
        const v=${V}; const s=v.rep.state.size; const w=Math.fround(${val});
        return v.debug.resolvePoints(${JSON.stringify(expr)}).every(p=>s[p]===w);
      })()`);

    await snapAll(); // the pristine full-grid snapshot
    for (const b of BUFS) await snap(`__pristine_${b}`, b);
    const baseDepth = await undoDepth();

    // -- (a) pointsize parity (identity grain; avoid the base size 3) ------------
    for (const [expr, size] of [
      ["alpha", "1.5"],
      ["#100-140", "2.5"],
      ['gamma.group-2."subgroup 11"', "4"],
      ["@solvent", "5"],
    ] as const) {
      const { r, parity } = await paintSize("pointsize", expr, size);
      check(`S18: pointsize ${expr} — sizes EXACTLY the resolved points`,
        r.status === "ok" && parity.match, JSON.stringify(r));
      check(`S18: ...message reports the action`,
        /^set \d+ points to size [\d.]+$/.test(r.message), r.message);
    }

    // -- (b) the edge pair: contained vs incident, on the size buffer ------------
    const bonds = await paintSize("bondsize", "alpha", "1.5");
    check("S18: bondsize alpha — sizes EXACTLY the both-endpoints edges (reach 0)",
      bonds.r.status === "ok" && bonds.parity.match && bonds.parity.reach === 0,
      JSON.stringify(bonds.r));
    const bondsof = await paintSize("bondsizeof", "beta.group-*.*.t1", "2.5");
    check("S18: bondsizeof beta.group-*.*.t1 — the either-endpoint set, ALL reaching out",
      bondsof.r.status === "ok" && bondsof.parity.match && bondsof.parity.reach > 0,
      `${JSON.stringify(bondsof.r)} reach=${bondsof.parity.reach}`);

    // -- (c) the single-point pin, mirrored from S16 onto the size buffer ---------
    await snap("__quietES", "edgeSize");
    const depthPin = await undoDepth();
    const pin = await cmd("bondsize #124 2");
    check("S18: bondsize #124 → nomatch (no contained edge in a one-point set)",
      pin.status === "nomatch" && pin.message === `no edges with both endpoints in "#124"`,
      JSON.stringify(pin));
    check("S18: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietES", "edgeSize")) && (await undoDepth()) === depthPin);
    const pinOf = await paintSize("bondsizeof", "#124", "2.25");
    check("S18: bondsizeof #124 sizes exactly the incident edges",
      pinOf.r.status === "ok" && pinOf.parity.match &&
        pinOf.parity.reach > 0 && pinOf.r.message === `set 2 edges to size 2.25`,
      JSON.stringify(pinOf));

    // -- (d) tracesize: the subgroup map-up, scattered set pinned -----------------
    const trace = await paintSize("tracesize", "alpha", "1.5");
    check("S18: tracesize alpha — the SCATTERED [0,3,6,9] (colortrace's exact map-up)",
      trace.r.status === "ok" && trace.parity.match &&
        JSON.stringify(trace.parity.ids) === "[0,3,6,9]",
      JSON.stringify(trace.parity.ids));
    const traceUp = await paintSize("tracesize", "#124", "2.5");
    check("S18: tracesize #124 — one point maps up to its subgroup's ONE vertex",
      traceUp.r.status === "ok" && JSON.stringify(traceUp.parity.ids) === "[1]" &&
        traceUp.r.message === "set 1 trace vertices to size 2.5",
      JSON.stringify(traceUp));
    const traceNone = await cmd("tracesize @solvent 2");
    check("S18: tracesize @solvent — bulk subgroups own no vertices → nomatch",
      traceNone.status === "nomatch" && traceNone.message === `no trace vertices in "@solvent"`,
      JSON.stringify(traceNone));

    // -- (e) ZERO ⊥ HIDE: the load-bearing new assertion --------------------------
    await snap("__preZeroVis", "visible");
    const visBefore = await visibleCount(d);
    const zero = await cmd("pointsize alpha 0");
    check("S18: pointsize alpha 0 — a literal write, reported as size 0 (never 'hidden')",
      zero.status === "ok" && zero.message === "set 400 points to size 0",
      JSON.stringify(zero));
    check("S18: ...the size buffer really is 0 there", await pointsSized("alpha", 0));
    check("S18: ...hide-state is BYTE-IDENTICAL and the scene count unchanged",
      (await equalsSnap("__preZeroVis", "visible")) && (await visibleCount(d)) === visBefore);
    check("S18: ...zero-size points still resolve (present, not hidden)",
      (await d.evaluate<number>(`${V}.debug.resolvePoints("alpha").length`)) === 400);

    // -- (f) the negative clamp ----------------------------------------------------
    const neg = await cmd("pointsize beta -2");
    check("S18: a negative size clamps to 0 and the message says so",
      neg.status === "ok" && neg.message === "set 400 points to size 0 (clamped to 0)",
      JSON.stringify(neg));
    check("S18: ...and the buffer holds 0", await pointsSized("beta", 0));

    // -- (g) independence across the EIGHT-verb grid, six buffers -----------------
    const grid: [string, string][] = [
      ["pointsize gamma 2.75", `["size"]`],
      ["bondsize gamma 1.75", `["edgeSize"]`],
      ["bondsizeof gamma 1.25", `["edgeSize"]`], // the SHARED edge-size buffer
      ["tracesize gamma 2.25", `["traceSize"]`],
      ["colorpoints gamma #111213", `["color"]`],
      ["colorbonds gamma #141516", `["edgeColorA","edgeColorB"]`],
      ["colortrace gamma #171819", `["traceColor"]`],
    ];
    for (const [text, want] of grid) {
      await snapAll();
      await cmd(text);
      check(`S18: ${text} touches ONLY ${want}`, (await changedBuffers()) === want,
        await changedBuffers());
    }

    // -- (h) undo/LWW/hidden on the size axis -------------------------------------
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    let allPristine = true;
    for (const b of BUFS) allPristine = allPristine && (await equalsSnap(`__pristine_${b}`, b));
    check("S18: unwinding every stroke restores ALL SIX buffers to pristine", allPristine);
    await cmd("pointsize alpha 5");
    await cmd("pointsize alpha.group-0.subgroup-0 7");
    check("S18: re-sizing an overlap overwrites those points (LWW)",
      (await pointsSized("alpha.group-0.subgroup-0", 7)));
    await d.ctrlZ();
    await sleep(120);
    check("S18: undo restores the PREVIOUS size (5), not the base look",
      await pointsSized("alpha.group-0.subgroup-0", 5));
    await d.ctrlZ();
    await sleep(120);
    check("S18: a second undo restores the base point size (3)",
      await pointsSized("alpha", 3));
    await cmd("hide alpha [tmphide]");
    const visHidden = await visibleCount(d);
    const depthHidden = await undoDepth();
    const hid = await paintSize("pointsize", "alpha", "4");
    check("S18: sizing a HIDDEN target writes the buffer as ONE stroke, unhiding nothing",
      hid.r.status === "ok" && hid.parity.match &&
        (await undoDepth()) === depthHidden + 1 && (await visibleCount(d)) === visHidden,
      JSON.stringify(hid.r));
    await d.ctrlZ();
    await sleep(120);
    check("S18: one Ctrl+Z pops ONLY the size stroke — the hide stands",
      (await equalsSnap("__preSize", "size")) &&
        (await undoDepth()) === depthHidden && (await visibleCount(d)) === visHidden);

    // -- (i) the remaining quiet paths, byte-identical across every buffer --------
    await snapAll();
    const depthQuiet = await undoDepth();
    const quiet: [string, string][] = [
      ["pointsize nothere 2", "nomatch"],
      ["pointsize alpha abc", "error"],
      ["pointsize", "error"],
      ["bondsizeof 2", "error"], // one chunk: a size but no target
      ["tracesize alpha.[x] 2", "error"], // [ reserved
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S18: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S18: ...none of them wrote a single component anywhere",
      (await changedBuffers()) === "[]");
    check("S18: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);

    await d.screenshot(`${REPORT}/S18_size.png`);
  });
}

async function S19(): Promise<void> {
  console.log("S19 — the opacity family: the third axis (opacity ⊥ hide, naive blending)");
  const BUFS = [
    "color", "edgeColorA", "edgeColorB", "traceColor",
    "size", "edgeSize", "traceSize",
    "opacity", "edgeOpacity", "traceOpacity",
  ] as const;
  await withDriver(async (d) => {
    await seedSolvent(d); // the committed @solvent in the verb matrix
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    const snapAll = async () => {
      for (const b of BUFS) await snap(`__all_${b}`, b);
    };
    const changedBuffers = async (): Promise<string> => {
      const out: string[] = [];
      for (const b of BUFS) if (!(await equalsSnap(`__all_${b}`, b))) out.push(b);
      return JSON.stringify(out);
    };
    /** Opacity parity per shape (S18's paintSize, third axis). */
    const paintOp = async (
      verb: "pointopacity" | "bondopacity" | "bondopacityof" | "traceopacity",
      expr: string,
      value: string,
    ) => {
      const buf =
        verb === "pointopacity" ? "opacity" :
        verb === "traceopacity" ? "traceOpacity" : "edgeOpacity";
      await snap("__preOp", buf);
      const r = await cmd(`${verb} ${expr} ${value}`);
      const parity = await d.evaluate<{ ids: number[]; match: boolean; reach: number }>(`(()=>{
        const v=${V}; const c=v.rep.state.${buf}; const s=window.__preOp;
        const changed=[];
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) changed.push(i);
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        let want=[]; let reach=0;
        if (${JSON.stringify(verb)} === "pointopacity") {
          want=[...pts].sort((a,b)=>a-b);
        } else if (${JSON.stringify(verb)} === "traceopacity") {
          const active=new Set([...pts].map(p=>v.hierarchy.subgroupOfPoint(p)));
          for (let i=0;i<v.traceVertices.length;i++) {
            if (active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]))) want.push(i);
          }
        } else {
          const both=${JSON.stringify(verb)} === "bondopacity";
          for (let e=0;e<v.edges.length;e++) {
            const a=v.edges[e][0], b=v.edges[e][1];
            if (both ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b))) want.push(e);
          }
          for (const e of changed) {
            const a=v.edges[e][0], b=v.edges[e][1];
            if (!pts.has(a)||!pts.has(b)) reach++;
          }
        }
        return { ids: changed.length<=16?changed:[], reach,
                 match: changed.length===want.length && changed.every((x,i)=>x===want[i]) };
      })()`);
      return { r, parity };
    };
    const pointsAlpha = (expr: string, val: number) =>
      d.evaluate<boolean>(`(()=>{
        const v=${V}; const o=v.rep.state.opacity; const w=Math.fround(${val});
        return v.debug.resolvePoints(${JSON.stringify(expr)}).every(p=>o[p]===w);
      })()`);
    /** Decidedly-RED canvas pixels (strict classifier — the brownish base
     * polyline never counts) — the visible-transparency evidence. */
    const redCount = (b64: string) =>
      d.evaluate<number>(`(async () => {
        const app = document.getElementById('app').getBoundingClientRect();
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
          Math.round(app.width), Math.round(app.height) - 60).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) n++;
        }
        return n;
      })()`);

    await snapAll();
    for (const b of BUFS) await snap(`__pristine_${b}`, b);
    const baseDepth = await undoDepth();

    // -- (a) opacity parity per shape ---------------------------------------------
    for (const [expr, value] of [
      ["alpha", "0.25"],
      ["#100-140", "0.5"],
      ['gamma.group-2."subgroup 11"', "0.75"],
      ["@solvent", "0.8"],
    ] as const) {
      const { r, parity } = await paintOp("pointopacity", expr, value);
      check(`S19: pointopacity ${expr} — fades EXACTLY the resolved points`,
        r.status === "ok" && parity.match, JSON.stringify(r));
      check(`S19: ...message reports the action`,
        /^set \d+ points to opacity [\d.]+$/.test(r.message), r.message);
    }
    const bonds = await paintOp("bondopacity", "alpha", "0.25");
    check("S19: bondopacity alpha — EXACTLY the both-endpoints edges (reach 0)",
      bonds.r.status === "ok" && bonds.parity.match && bonds.parity.reach === 0,
      JSON.stringify(bonds.r));
    const bondsof = await paintOp("bondopacityof", "beta.group-*.*.t1", "0.5");
    check("S19: bondopacityof beta.group-*.*.t1 — the either-endpoint set, ALL reaching out",
      bondsof.r.status === "ok" && bondsof.parity.match && bondsof.parity.reach > 0,
      `${JSON.stringify(bondsof.r)} reach=${bondsof.parity.reach}`);
    const trace = await paintOp("traceopacity", "alpha", "0.25");
    check("S19: traceopacity alpha — the SCATTERED [0,3,6,9] (the shared map-up)",
      trace.r.status === "ok" && trace.parity.match &&
        JSON.stringify(trace.parity.ids) === "[0,3,6,9]",
      JSON.stringify(trace.parity.ids));
    const traceUp = await paintOp("traceopacity", "#124", "0.5");
    check("S19: traceopacity #124 — one point maps up to its subgroup's ONE vertex",
      traceUp.r.status === "ok" && JSON.stringify(traceUp.parity.ids) === "[1]" &&
        traceUp.r.message === "set 1 trace vertices to opacity 0.5",
      JSON.stringify(traceUp));
    const traceNone = await cmd("traceopacity @solvent 0.5");
    check("S19: traceopacity @solvent — no vertices → nomatch",
      traceNone.status === "nomatch" && traceNone.message === `no trace vertices in "@solvent"`,
      JSON.stringify(traceNone));

    // -- (b) the single-point pin on the opacity axis ------------------------------
    await snap("__quietEO", "edgeOpacity");
    const depthPin = await undoDepth();
    const pin = await cmd("bondopacity #124 0.5");
    check("S19: bondopacity #124 → nomatch (no contained edge in a one-point set)",
      pin.status === "nomatch" && pin.message === `no edges with both endpoints in "#124"`,
      JSON.stringify(pin));
    check("S19: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietEO", "edgeOpacity")) && (await undoDepth()) === depthPin);
    const pinOf = await paintOp("bondopacityof", "#124", "0.3");
    check("S19: bondopacityof #124 fades exactly the incident edges",
      pinOf.r.status === "ok" && pinOf.parity.match &&
        pinOf.parity.reach > 0 && pinOf.r.message === "set 2 edges to opacity 0.3",
      JSON.stringify(pinOf));

    // -- (c) OPACITY-ZERO ⊥ HIDE: invisible-but-present ----------------------------
    await snap("__preZeroVis", "visible");
    const visBefore = await visibleCount(d);
    const zero = await cmd("pointopacity alpha 0");
    check("S19: pointopacity alpha 0 — a literal write, reported as opacity 0 (never 'hidden')",
      zero.status === "ok" && zero.message === "set 400 points to opacity 0",
      JSON.stringify(zero));
    check("S19: ...alpha really is 0 there", await pointsAlpha("alpha", 0));
    check("S19: ...hide-state is BYTE-IDENTICAL and the scene count unchanged",
      (await equalsSnap("__preZeroVis", "visible")) && (await visibleCount(d)) === visBefore);
    check("S19: ...zero-opacity points still resolve (present, not hidden)",
      (await d.evaluate<number>(`${V}.debug.resolvePoints("alpha").length`)) === 400);

    // -- (d) the two-sided clamp ----------------------------------------------------
    const high = await cmd("pointopacity alpha 1.5");
    check("S19: >1 clamps to 1 and the message says so",
      high.status === "ok" && high.message === "set 400 points to opacity 1 (clamped to 1)",
      JSON.stringify(high));
    check("S19: ...and the buffer holds 1", await pointsAlpha("alpha", 1));
    const low = await cmd("pointopacity beta -0.5");
    check("S19: <0 clamps to 0 and the message says so",
      low.status === "ok" && low.message === "set 400 points to opacity 0 (clamped to 0)",
      JSON.stringify(low));
    check("S19: ...and the buffer holds 0", await pointsAlpha("beta", 0));

    // -- (e) the pixels: transparency actually RENDERS ------------------------------
    await cmd("colorpoints alpha.group-0.subgroup-0 red");
    const redBefore = await redCount(await d.captureB64(`${REPORT}/S19_red_opaque.png`));
    check("S19: (setup) an opaque red subgroup shows red pixels", redBefore > 50,
      `red=${redBefore}`);
    await cmd("pointopacity alpha.group-0.subgroup-0 0");
    const redAfter = await redCount(await d.captureB64(`${REPORT}/S19_red_faded.png`));
    check("S19: fading it to opacity 0 removes the red pixels (invisible-but-present)",
      redAfter < Math.max(5, redBefore / 10), `before=${redBefore} after=${redAfter}`);
    check("S19: ...while the points still resolve",
      (await d.evaluate<number>(`${V}.debug.resolvePoints("alpha.group-0.subgroup-0").length`)) === 100);

    // -- (f) independence across the TWELVE-verb grid, NINE buffers -----------------
    const grid: [string, string][] = [
      ["pointopacity gamma 0.6", `["opacity"]`],
      ["bondopacity gamma 0.6", `["edgeOpacity"]`],
      ["bondopacityof gamma 0.4", `["edgeOpacity"]`], // the SHARED edge-opacity buffer
      ["traceopacity gamma 0.6", `["traceOpacity"]`],
      ["colorpoints gamma #212223", `["color"]`],
      ["pointsize gamma 2.6", `["size"]`],
      ["colorbonds gamma #242526", `["edgeColorA","edgeColorB"]`],
      ["bondsize gamma 1.6", `["edgeSize"]`],
      ["colortrace gamma #272829", `["traceColor"]`],
      ["tracesize gamma 2.4", `["traceSize"]`],
    ];
    for (const [text, want] of grid) {
      await snapAll();
      await cmd(text);
      check(`S19: ${text} touches ONLY ${want}`, (await changedBuffers()) === want,
        await changedBuffers());
    }

    // -- (g) undo/LWW/hidden on the opacity axis ------------------------------------
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    let allPristine = true;
    for (const b of BUFS) allPristine = allPristine && (await equalsSnap(`__pristine_${b}`, b));
    check("S19: unwinding every stroke restores ALL NINE buffers to pristine", allPristine);
    await cmd("pointopacity alpha 0.5");
    await cmd("pointopacity alpha.group-0.subgroup-0 0.25");
    check("S19: re-fading an overlap overwrites those points (LWW)",
      await pointsAlpha("alpha.group-0.subgroup-0", 0.25));
    await d.ctrlZ();
    await sleep(120);
    check("S19: undo restores the PREVIOUS alpha (0.5), not the base look",
      await pointsAlpha("alpha.group-0.subgroup-0", 0.5));
    await d.ctrlZ();
    await sleep(120);
    check("S19: a second undo restores the fully-opaque base (1)",
      await pointsAlpha("alpha", 1));
    await cmd("hide alpha [tmphide]");
    const visHidden = await visibleCount(d);
    const depthHidden = await undoDepth();
    const hid = await paintOp("pointopacity", "alpha", "0.75");
    check("S19: fading a HIDDEN target writes the buffer as ONE stroke, unhiding nothing",
      hid.r.status === "ok" && hid.parity.match &&
        (await undoDepth()) === depthHidden + 1 && (await visibleCount(d)) === visHidden,
      JSON.stringify(hid.r));
    await d.ctrlZ();
    await sleep(120);
    check("S19: one Ctrl+Z pops ONLY the opacity stroke — the hide stands",
      (await equalsSnap("__preOp", "opacity")) &&
        (await undoDepth()) === depthHidden && (await visibleCount(d)) === visHidden);

    // -- (h) the remaining quiet paths, byte-identical across every buffer ----------
    await snapAll();
    const depthQuiet = await undoDepth();
    const quiet: [string, string][] = [
      ["pointopacity nothere 0.5", "nomatch"],
      ["pointopacity alpha abc", "error"],
      ["pointopacity", "error"],
      ["bondopacityof 0.5", "error"], // one chunk: a value but no target
      ["traceopacity alpha.[x] 0.5", "error"], // [ reserved
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S19: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S19: ...none of them wrote a single component anywhere",
      (await changedBuffers()) === "[]");
    check("S19: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);

    await d.screenshot(`${REPORT}/S19_opacity.png`);
  });
}

async function S20(): Promise<void> {
  console.log("S20 — representation state survives hidden→visible (and restore touches no undo)");
  // The tab-away loss was CAUSE #1: without retainContextWhenHidden VS Code
  // destroyed the webview on hide and reloaded it on re-show (confirmed by
  // CDP probe against the real workbench — the webview target vanishes, a
  // fresh one appears, window state is gone). The fix retains the context,
  // so a RETAINED webview experiences only visibility/resize events on the
  // round-trip. This scenario pins the webview-side invariants that make
  // retention sufficient: nothing on the visibility/resize path re-seeds or
  // re-allocates rep state, nothing touches the undo stack, and the pixels
  // still render afterward. (The retention itself is validated against the
  // packaged VSIX by the real-VS-Code probe — the harness has no panel
  // lifecycle to drive.)
  const BUFS = [
    "color", "edgeColorA", "edgeColorB", "traceColor",
    "size", "edgeSize", "traceSize",
    "opacity", "edgeOpacity", "traceOpacity",
  ] as const;
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    const cameraPose = () =>
      d.evaluate<number[]>(`(()=>{
        const v=${V};
        return [...v.camera.position.toArray(), ...v.controls.target.toArray()];
      })()`);
    const redCount = (b64: string) =>
      d.evaluate<number>(`(async () => {
        const app = document.getElementById('app').getBoundingClientRect();
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
          Math.round(app.width), Math.round(app.height) - 60).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) n++;
        }
        return n;
      })()`);

    // -- user strokes across five buffers (point/edge/trace, all three axes) -----
    await cmd("hide gamma [ghide]"); // hide-state must survive too
    await cmd("colorpoints alpha.group-0.subgroup-0 red");
    await cmd("pointsize beta 2");
    await cmd("pointopacity beta 0.4");
    await cmd("colorbonds alpha #ff8800");
    await cmd("colortrace alpha steelblue");
    for (const b of BUFS) await snap(`__pre_${b}`, b);
    await snap("__preVis", "visible");
    const depthBefore = await undoDepth();
    const poseBefore = JSON.stringify(await cameraPose());
    const redBefore = await redCount(await d.captureB64(`${REPORT}/S20_before.png`));
    check("S20: (setup) the colored subgroup renders red pixels", redBefore > 50,
      `red=${redBefore}`);

    // -- the retained-webview round-trip: visibility + resize events --------------
    await d.evaluate(`(()=>{
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("panelrelayout"));
      ${V}.applyResize();
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("resize"));
      ${V}.applyResize();
    })()`);
    await sleep(600);

    // -- the invariants -------------------------------------------------------------
    let allSame = true;
    for (const b of BUFS) allSame = allSame && (await equalsSnap(`__pre_${b}`, b));
    check("S20: all NINE rep-state buffers byte-identical across the round-trip", allSame);
    check("S20: hide-state byte-identical across the round-trip",
      await equalsSnap("__preVis", "visible"));
    check("S20: the undo stack is UNTOUCHED (no restore stroke, no depth change)",
      (await undoDepth()) === depthBefore,
      `depth=${await undoDepth()} vs ${depthBefore}`);
    check("S20: camera pose survives",
      JSON.stringify(await cameraPose()) === poseBefore);
    const redAfter = await redCount(await d.captureB64(`${REPORT}/S20_after.png`));
    check("S20: the colored pixels still render after the round-trip (re-upload intact)",
      redAfter > 50 && Math.abs(redAfter - redBefore) < redBefore * 0.5,
      `before=${redBefore} after=${redAfter}`);

    // -- undo still pops EXACTLY the user's strokes, in order ----------------------
    await d.ctrlZ(); // pops the colortrace stroke, nothing else
    await sleep(120);
    check("S20: Ctrl+Z after the round-trip pops the LAST user stroke (colortrace)",
      (await d.evaluate<boolean>(`(()=>{
        const tc=${V}.rep.state.traceColor; const base=[0x9a,0x7a,0x5a].map(x=>Math.fround(x/255));
        for (let i=0;i<tc.length/3;i++) {
          if (tc[3*i]!==base[0]||tc[3*i+1]!==base[1]||tc[3*i+2]!==base[2]) return false;
        }
        return true;
      })()`)) && (await equalsSnap("__pre_edgeColorA", "edgeColorA")) &&
        (await equalsSnap("__pre_edgeColorB", "edgeColorB")),
      "traceColor back to base; the edge-color pair still written");
    await d.ctrlZ(); // pops the colorbonds stroke
    await sleep(120);
    check("S20: a second Ctrl+Z pops the NEXT stroke (colorbonds), in order",
      await d.evaluate<boolean>(`(()=>{
        const base=[0x5a,0x7a,0x9a].map(x=>Math.fround(x/255));
        for (const ec of [${V}.rep.state.edgeColorA, ${V}.rep.state.edgeColorB]) {
          for (let e=0;e<ec.length/3;e++) {
            if (ec[3*e]!==base[0]||ec[3*e+1]!==base[1]||ec[3*e+2]!==base[2]) return false;
          }
        }
        return true;
      })()`));
    check("S20: ...and the earlier strokes are still in place beneath",
      (await equalsSnap("__pre_color", "color")) && (await equalsSnap("__pre_size", "size")) &&
        (await equalsSnap("__pre_opacity", "opacity")));

    await d.screenshot(`${REPORT}/S20_survival.png`);
  });
}

async function S21(): Promise<void> {
  console.log("S21 — rainbow: the first recipe (per-element values through the recipe registry)");
  await withDriver(async (d) => {
    await seedSolvent(d); // the @solvent the pixel proof hides to clear the bulk
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.color))`);
    const buffersEqual = (slot: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.color, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);

    await snap("__pristine");
    const baseDepth = await undoDepth();

    // -- (a) resolution parity + the recipe distinction: values VARY per element
    const r1 = await cmd("rainbow alpha");
    const audit = await d.evaluate<{
      changed: number; match: boolean; first: number[]; last: number[]; mid: number[];
    }>(`(()=>{
      const v=${V}; const c=v.rep.state.color; const s=window.__pristine;
      const changed=[];
      for (let p=0;p<c.length/3;p++) {
        if (c[3*p]!==s[3*p]||c[3*p+1]!==s[3*p+1]||c[3*p+2]!==s[3*p+2]) changed.push(p);
      }
      // resolvePoints runs the handler's exact union loop — same ORDER, so the
      // ramp's ends are its first/last elements
      const pts=v.debug.resolvePoints("alpha");
      const sorted=[...new Set(pts)].sort((a,b)=>a-b);
      const rgb=(p)=>[c[3*p],c[3*p+1],c[3*p+2]];
      return { changed: changed.length,
               match: changed.length===sorted.length && changed.every((p,i)=>p===sorted[i]),
               first: rgb(pts[0]), last: rgb(pts[pts.length-1]),
               mid: rgb(pts[Math.floor(pts.length/2)]) };
    })()`);
    check("S21: rainbow alpha — writes EXACTLY the set view resolves",
      r1.status === "ok" && audit.match && audit.changed === 400,
      `${JSON.stringify(r1)} changed=${audit.changed}`);
    check("S21: ...message reports the action and count, colorpoints' shape",
      r1.message === `colored ${audit.changed} points rainbow`, r1.message);
    check("S21: ...as exactly ONE undo stroke", (await undoDepth()) === baseDepth + 1);
    check("S21: the ramp's t=0 end is hue 0 (red)",
      audit.first[0] === 1 && audit.first[1] === 0 && audit.first[2] === 0,
      JSON.stringify(audit.first));
    check("S21: the ramp's t=1 end is hue 300 (magenta) — the sweep never wraps",
      audit.last[0] === 1 && audit.last[1] === 0 && audit.last[2] === 1,
      JSON.stringify(audit.last));
    check("S21: the written value VARIES per element — the recipe/constant distinction",
      JSON.stringify(audit.mid) !== JSON.stringify(audit.first) &&
        JSON.stringify(audit.mid) !== JSON.stringify(audit.last),
      JSON.stringify(audit.mid));

    // -- (b) LWW + undo: recipe strokes compose with the fixed verbs' ---------
    await snap("__postRainbow");
    await cmd("colorpoints alpha.group-0.subgroup-0 white");
    check("S21: a later constant write overwrites ramp colors (LWW per element)",
      !(await buffersEqual("__postRainbow")));
    await d.ctrlZ();
    await sleep(120);
    check("S21: undo restores the RAMP values, not the base look",
      await buffersEqual("__postRainbow"));
    await d.ctrlZ();
    await sleep(120);
    check("S21: a second undo pops the whole rainbow stroke — pristine buffer",
      (await buffersEqual("__pristine")) && (await undoDepth()) === baseDepth);

    // -- (c) pixel proof: the VARYING colors reach the GPU ---------------------
    // (buffer-level checks cannot see an attribute-upload miss — the repAttrs
    // trap — so sample two rendered points and demand they differ.)
    await cmd("hide @solvent"); // clear the bulk so the samples can't be occluded
    await cmd("rainbow alpha.group-0.subgroup-0");
    // fade the subgroup's own edge chain and the polyline: a 1px line crossing
    // a sprite's center pixel would pollute the sample with the line's color
    await cmd("bondopacity alpha.group-0.subgroup-0 0");
    await cmd("traceopacity alpha 0");
    await cmd("view alpha.group-0.subgroup-0"); // frame the ramp
    await sleep(1400); // camera tween settles
    const pts = await d.evaluate<number[]>(
      `${V}.debug.resolvePoints("alpha.group-0.subgroup-0")`);
    const pA = pts[0]; // t=0 → red
    const pB = pts[Math.floor(pts.length * 0.4)]; // t≈0.4 → pure green
    await cmd(`pointsize #${pA} 12`); // fat sprites so the center sample is robust
    await cmd(`pointsize #${pB} 12`);
    const proj = await d.evaluate<{ a: { x: number; y: number; front: boolean }; b: { x: number; y: number; front: boolean } }>(
      `({ a: ${V}.debug.projectPoint(${pA}), b: ${V}.debug.projectPoint(${pB}) })`);
    check("S21: both sample points project on-screen, apart from each other",
      proj.a.front && proj.b.front &&
        Math.hypot(proj.a.x - proj.b.x, proj.a.y - proj.b.y) > 12,
      JSON.stringify(proj));
    await sleep(200); // one more rAF: the size/color attrs upload
    const shot = await d.captureB64(`${REPORT}/S21_pixels.png`);
    const px = await d.evaluate<{ a: number[]; b: number[] }>(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${shot}"; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const at = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
      return { a: at(${proj.a.x}, ${proj.a.y}), b: at(${proj.b.x}, ${proj.b.y}) };
    })()`);
    check("S21: the ramp's start RENDERS red-dominant",
      px.a[0] > px.a[1] + 60 && px.a[0] > px.a[2] + 60, JSON.stringify(px));
    check("S21: the mid-ramp point RENDERS green-dominant — a DIFFERENT color",
      px.b[1] > px.b[0] + 60 && px.b[1] > px.b[2] + 40, JSON.stringify(px));

    // -- (d) nomatch / usage / parse errors write nothing, push no stroke ------
    await snap("__noWrite");
    const depthQuiet = await undoDepth();
    for (const [text, status] of [
      ["rainbow alpha.nonexistent", "nomatch"],
      ["rainbow @nosuch", "nomatch"],
      ["rainbow", "error"],
      ["rainbow alpha.[x]", "error"], // [ reserved in expressions
    ] as const) {
      const r = await cmd(text);
      check(`S21: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S21: ...none of them wrote a single component",
      await buffersEqual("__noWrite"));
    check("S21: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);

    await d.screenshot(`${REPORT}/S21_rainbow.png`);
  });
}

async function S22(): Promise<void> {
  console.log("S22 — mods: the recipe registry read-face (attribution, grouped by origin)");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);

    const baseDepth = await undoDepth();
    const r = await cmd("mods");
    check("S22: mods lists the registry", r.status === "ok", JSON.stringify(r));
    const lines = (r.message ?? "").split("\n");
    check("S22: recipes are grouped under their origin header",
      lines[0] === "built-in:", JSON.stringify(lines));
    check("S22: rainbow's line carries name, kind, axis, and the FULL credit",
      lines[1] === "  rainbow — representation · point-color · by Dominic Fico · https://github.com/DomFico/molaro",
      JSON.stringify(lines));
    check("S22: recipes ONLY — no command verbs in the listing",
      !r.message.includes("colorpoints") && !r.message.includes("create_sele"),
      r.message);

    const stray = await cmd("mods rainbow");
    check("S22: stray arguments are the usage error, nothing listed",
      stray.status === "error" &&
        stray.message === "mods takes no arguments — it lists the recipe registry",
      JSON.stringify(stray));
    check("S22: read-only — neither call touched the undo stack",
      (await undoDepth()) === baseDepth);

    const helped = await cmd("help mods");
    check("S22: help mods describes the verb through the registry",
      helped.status === "ok" && /recipe registry/.test(helped.message),
      JSON.stringify(helped));
  });
}

async function S23(): Promise<void> {
  console.log("S23 — /claude: the conversation panel shell (split, stream, approval gate, stub backend)");
  // the "/terminal" route serves the REAL terminal bundle (panel included)
  // over the real viewer, with the host relay + stub emulated by the shim
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const panelOpen = () =>
      d.evaluate<boolean>(`!${el("claude-root")}.classList.contains('collapsed')`);
    const inputDisabled = () => d.evaluate<boolean>(`${el("claude-input")}.disabled`);
    const cancelVisible = () => d.evaluate<boolean>(`!${el("claude-cancel")}.hidden`);
    const transcript = () =>
      d.evaluate<{ cls: string; text: string }[]>(`[...${el("claude-transcript")}.children]
        .map(n=>({cls:n.className, text:n.textContent}))`);
    const toolBlocks = () =>
      d.evaluate<{ head: string; approval: boolean; buttons: number; result: string | null; resultCls: string | null }[]>(
        `[...document.querySelectorAll('#claude-transcript .cl-tool')].map(b=>({
          head: b.querySelector('.cl-tool-head')?.textContent ?? '',
          approval: !!b.querySelector('.cl-approval'),
          buttons: [...b.querySelectorAll('button')].filter(x=>!x.disabled).length,
          result: b.querySelector('.cl-result')?.textContent ?? null,
          resultCls: b.querySelector('.cl-result')?.className ?? null,
        }))`);
    const clickBtn = (sel: string) =>
      d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll(${JSON.stringify(sel)})].at(-1);
        if(!b || b.disabled) return false; b.click(); return true;
      })()`);
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };

    // -- open: /claude in the TERMINAL input splits the view -------------------
    check("S23: the panel starts collapsed (full terminal)", !(await panelOpen()));
    await typeInto("term-input", "/claude");
    await sleep(150);
    check("S23: /claude splits the view — the panel mounts above the terminal",
      (await panelOpen()) &&
        (await d.evaluate<boolean>(`${el("term-root")}.getBoundingClientRect().height > 100`)),
      "panel open + terminal still visible");
    check("S23: …and focuses the panel's own input",
      await d.evaluate<boolean>(`document.activeElement === ${el("claude-input")}`));
    check("S23: the stub's auth-status renders on the status line (connected)",
      await d.evaluate<boolean>(`${el("claude-dot")}.className === 'connected' &&
        ${el("claude-status-text")}.textContent === 'connected — stub backend (scripted)'`),
      await d.evaluate<string>(`${el("claude-status-text")}.textContent`));

    // -- a message: streamed text, the auto-approved tool, the WAITING gate ----
    await typeInto("claude-input", "look at group-0");
    await d.waitFor(`${el("claude-input")}.disabled && !${el("claude-cancel")}.hidden`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S23: the input locks for the in-flight turn (cancel affordance live)",
      (await inputDisabled()) && (await cancelVisible()));
    // family retrofit: poll for the approval GATE to render (a live approve
    // button) instead of a fixed 600ms — the gate is a transient element
    // the stub reaches on its own cadence, later under parallel load
    await d.waitFor(`[...document.querySelectorAll('.cl-approve')].some(b => !b.disabled)`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    let items = await transcript();
    check("S23: the user turn renders", items[0]?.cls === "cl-user" && items[0]?.text === "look at group-0",
      JSON.stringify(items[0]));
    check("S23: streamed deltas concatenated into ONE assistant turn",
      await d.evaluate<boolean>(`[...document.querySelectorAll('.cl-assistant')]
        .some(n=>n.textContent==='Looking at the target now.')`),
      JSON.stringify(items));
    let blocks = await toolBlocks();
    check("S23: the auto-approved tool: proposed→ok result, NO approval row",
      blocks[0]?.head === "example_tool_a" && !blocks[0]?.approval &&
        blocks[0]?.result === "example_tool_a produced 100 color scalars" &&
        /\bok\b/.test(blocks[0]?.resultCls ?? ""),
      JSON.stringify(blocks[0]));
    check("S23: the gated tool renders live approve/deny and NO result yet",
      blocks[1]?.head === "example_tool_b" && blocks[1]?.approval === true &&
        blocks[1]?.buttons === 2 && blocks[1]?.result === null,
      JSON.stringify(blocks[1]));
    check("S23: …the turn is still in flight while the gate waits", await inputDisabled());

    // -- approve: ok result, turn completes, input re-enables ------------------
    check("S23: (action) clicking approve", await clickBtn(".cl-approve"));
    // the tool result is a relay envelope — poll for it, not a fixed 250ms
    await d.waitFor(`[...document.querySelectorAll('.cl-tool')][1]?.textContent
      ?.includes('example_tool_b ran create_sele alpha.group-0') && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    blocks = await toolBlocks();
    check("S23: approve → ok-styled result on the gated block",
      blocks[1]?.result === "example_tool_b ran create_sele alpha.group-0" &&
        /\bok\b/.test(blocks[1]?.resultCls ?? "") && blocks[1]?.buttons === 0,
      JSON.stringify(blocks[1]));
    check("S23: turn-complete re-enables the input, hides cancel",
      !(await inputDisabled()) && !(await cancelVisible()));

    // -- deny path (a fresh turn) ----------------------------------------------
    await typeInto("claude-input", "again");
    // poll for the NEW gate's deny button to render before clicking (the
    // fixed 700ms lost this race under parallel load — the failing member)
    await d.waitFor(`[...document.querySelectorAll('.cl-deny')].some(b => !b.disabled)`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S23: (action) clicking deny", await clickBtn(".cl-deny"));
    await d.waitFor(`[...document.querySelectorAll('.cl-tool')][3]?.textContent
      ?.includes('denied — example_tool_b did not run') && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    blocks = await toolBlocks();
    check("S23: deny → error-styled result on the new gated block",
      blocks[3]?.result === "denied — example_tool_b did not run" &&
        /\berr\b/.test(blocks[3]?.resultCls ?? ""),
      JSON.stringify(blocks[3]));
    check("S23: …and the denied turn completes", !(await inputDisabled()));
    await d.screenshot(`${REPORT}/S23_claude_open.png`); // the split, mid-conversation

    // -- the sentinel error path ------------------------------------------------
    await typeInto("claude-input", "please trigger-error now");
    // the stub streams on its own cadence and the error block PERSISTS once
    // rendered — poll for it instead of gambling a fixed 250ms under load
    // (the ledgered in-lane red); the check then re-asserts the full claim
    await d.waitFor(
      `[...document.getElementById('claude-transcript').children]
         .some(n => n.className === 'cl-error') && !document.getElementById('claude-input').disabled`,
      8000).catch(() => { /* timeout falls through — the check below goes red */ });
    items = await transcript();
    check("S23: the sentinel renders an error block and the turn ends",
      items.some((i) => i.cls === "cl-error" && i.text === "stub error — triggered by sentinel") &&
        !(await inputDisabled()),
      JSON.stringify(items.at(-1)));

    // -- cancel interrupts the in-flight turn -----------------------------------
    await typeInto("claude-input", "one more");
    // wait until the turn is actually in flight (cancel affordance live)
    // before clicking stop — a fixed 60ms can fire before the turn starts
    await d.waitFor(`${el("claude-input")}.disabled && !${el("claude-cancel")}.hidden`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S23: (action) clicking stop", await clickBtn("#claude-cancel"));
    // cancel ends the turn — poll for the input to return before asserting
    await d.waitFor(`!${el("claude-input")}.disabled && ${el("claude-cancel")}.hidden`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S23: cancel ends the turn — input back, no gate left hanging",
      !(await inputDisabled()) && !(await cancelVisible()) &&
        (await d.evaluate<number>(`[...document.querySelectorAll('.cl-approve,.cl-deny')]
          .filter(b=>!b.disabled).length`)) === 0);

    // -- auth-status: the disconnected state renders too -------------------------
    // (same message path production events take — the panel renders whatever
    // auth-status last arrived; the stub's constructor covers the unit side)
    await d.evaluate(`window.dispatchEvent(new MessageEvent('message', { data:
      { type: 'auth-status', state: 'disconnected', hint: 'no backend' } }))`);
    await sleep(80);
    check("S23: a disconnected auth-status flips the dot and the hint text",
      await d.evaluate<boolean>(`${el("claude-dot")}.className === 'disconnected' &&
        ${el("claude-status-text")}.textContent === 'disconnected — no backend'`));

    // -- collapse: both affordances restore the full terminal --------------------
    check("S23: (action) the panel's ✕ closes it", await clickBtn("#claude-close"));
    check("S23: ✕ collapses the panel", !(await panelOpen()));
    check("S23: …and focus returns to the terminal input",
      await d.evaluate<boolean>(`document.activeElement === ${el("term-input")}`));
    await typeInto("term-input", "/claude");
    await sleep(100);
    check("S23: /claude re-opens with the TRANSCRIPT PRESERVED",
      (await panelOpen()) && (await transcript()).length > 0);
    await typeInto("term-input", "/claude");
    await sleep(100);
    check("S23: /claude toggles back closed — the terminal has the full height",
      !(await panelOpen()) &&
        (await d.evaluate<boolean>(`${el("term-root")}.getBoundingClientRect().height >
          window.innerHeight * 0.9`)));

    await d.screenshot(`${REPORT}/S23_claude.png`);
  }, 1180, 780, "/terminal");
}

async function S24(): Promise<void> {
  console.log("S24 — typed results drive the viewer (per-point scalars + command through claude-bind)");

  // ---- part 1, the "/" route: the viewer-side binding itself — writes, undo,
  // mapping, error paths, and the MANDATORY pixel proof. claude-bind messages
  // are injected through the same message path the relay delivers them on.
  await withDriver(async (d) => {
    await seedSolvent(d); // the @solvent the pixel proof hides to clear the bulk
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf = "color") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const buffersEqual = (slot: string, buf = "color") =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    // capture the viewer's claude-bind-result replies (the shim loops them back)
    await d.evaluate(`void (window.__binds = [],
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'claude-bind-result') window.__binds.push(e.data);
      }))`);
    const bind = async (result: string): Promise<{ ok: boolean; message: string }> => {
      const n = await d.evaluate<number>(`window.__binds.length`);
      await d.evaluate(`window.dispatchEvent(new MessageEvent('message', { data:
        { type: 'claude-bind', callId: 'probe', result: ${result} } }))`);
      await sleep(120);
      return d.evaluate(`window.__binds[${n}]`);
    };

    await snap("__pristine");
    const baseDepth = await undoDepth();

    // -- per-point-scalar color: header-ordered write through the built-in colormap
    let out = await bind(`{ kind: 'per-point-scalar', target: '#0-99', axis: 'color',
      scalars: Array.from({length:100},(_,i)=>i/99) }`);
    check("S24: color scalars bind ok with the action message",
      out.ok === true && out.message === `colored 100 points of "#0-99" from scalars`,
      JSON.stringify(out));
    const audit = await d.evaluate<{ changed: number; exact: boolean; first: number[]; last: number[] }>(`(()=>{
      const v=${V}; const c=v.rep.state.color; const s=window.__pristine;
      const changed=[];
      for (let p=0;p<c.length/3;p++) {
        if (c[3*p]!==s[3*p]||c[3*p+1]!==s[3*p+1]||c[3*p+2]!==s[3*p+2]) changed.push(p);
      }
      const rgb=(p)=>[c[3*p],c[3*p+1],c[3*p+2]];
      return { changed: changed.length,
               exact: changed.every((p,i)=>p===i) && changed.length===100,
               first: rgb(0), last: rgb(99) };
    })()`);
    check("S24: EXACTLY the 100 resolved points changed, scalar[i] → point i (header order)",
      audit.exact, JSON.stringify(audit));
    check("S24: scalar 0 → red, scalar 1 → magenta (the built-in colormap's ends)",
      audit.first[0] === 1 && audit.first[1] === 0 && audit.first[2] === 0 &&
        audit.last[0] === 1 && audit.last[1] === 0 && audit.last[2] === 1,
      JSON.stringify(audit));
    check("S24: the bind is exactly ONE undo stroke", (await undoDepth()) === baseDepth + 1);
    await d.ctrlZ();
    await sleep(120);
    check("S24: one Ctrl+Z reverses the typed-result change completely",
      (await buffersEqual("__pristine")) && (await undoDepth()) === baseDepth);

    // -- size and opacity: [0,1] → axis range, per element ----------------------
    await snap("__preSize", "size");
    out = await bind(`{ kind: 'per-point-scalar', target: '#100-149', axis: 'size',
      scalars: Array.from({length:50},(_,i)=>i/49) }`);
    check("S24: size scalars bind ok", out.ok === true, JSON.stringify(out));
    check("S24: size maps t → t*6 per element (0..2× base)",
      await d.evaluate<boolean>(`(()=>{
        const s=${V}.rep.state.size;
        for (let i=0;i<50;i++) {
          if (s[100+i] !== Math.fround((i/49)*6)) return false;
        }
        return s[99]===Math.fround(3) && s[150]===Math.fround(3); // neighbors untouched
      })()`));
    out = await bind(`{ kind: 'per-point-scalar', target: '#150-199', axis: 'opacity',
      scalars: Array.from({length:50},(_,i)=>i/49) }`);
    check("S24: opacity scalars bind ok and map IDENTITY ([0,1] is the range)",
      out.ok === true && await d.evaluate<boolean>(`(()=>{
        const o=${V}.rep.state.opacity;
        for (let i=0;i<50;i++) if (o[150+i] !== Math.fround(i/49)) return false;
        return o[149]===Math.fround(1) && o[200]===Math.fround(1);
      })()`), JSON.stringify(out));
    await d.ctrlZ(); // pop opacity
    await d.ctrlZ(); // pop size
    await sleep(120);
    check("S24: the scalar strokes unwind cleanly", await buffersEqual("__preSize", "size"));

    // -- command: the exact typed-command path, undo from the verb --------------
    const committedBefore = await d.evaluate<number>(`${V}.model.committed().length`);
    out = await bind(`{ kind: 'command', command: 'create_sele alpha.group-0' }`);
    check("S24: a command result runs through the command layer and changes the scene",
      out.ok === true && /^create_sele alpha\.group-0 → created "selection_\d+"/.test(out.message) &&
        (await d.evaluate<number>(`${V}.model.committed().length`)) === committedBefore + 1,
      JSON.stringify(out));
    await d.ctrlZ();
    await sleep(120);
    check("S24: …and the verb's own undo reverses it",
      (await d.evaluate<number>(`${V}.model.committed().length`)) === committedBefore);

    // -- series are the PLOT's kind: the viewer stays SILENT + the error paths --
    await snap("__quiet");
    const depthQuiet = await undoDepth();
    const bindsBefore = await d.evaluate<number>(`window.__binds.length`);
    await d.evaluate(`window.dispatchEvent(new MessageEvent('message', { data:
      { type: 'claude-bind', callId: 'probe', result: { kind: 'per-frame-series',
        label: 'example_series', values: [1, 2, 3] } } }))`);
    await sleep(200);
    check("S24: the viewer IGNORES per-frame-series binds (the plot route owns them)",
      (await d.evaluate<number>(`window.__binds.length`)) === bindsBefore,
      "no claude-bind-result from the viewer");
    out = await bind(`{ kind: 'per-point-scalar', target: '#0-9', axis: 'color',
      scalars: [0, 0.25, 0.5, 0.75, 1] }`);
    check("S24: a scalar-count mismatch errors and writes NOTHING",
      out.ok === false &&
        out.message === `scalar count mismatch: 5 values for 10 points of "#0-9" — nothing written`,
      JSON.stringify(out));
    out = await bind(`{ kind: 'per-point-vector', target: '#0-9', scalars: [1] }`);
    check("S24: an unknown kind is an error, never a guess",
      out.ok === false && /unrecognized result payload \(kind "per-point-vector"\)/.test(out.message),
      JSON.stringify(out));
    out = await bind(`{ kind: 'per-point-scalar', target: 'nothere', axis: 'color', scalars: [] }`);
    check("S24: a nomatch target is the resolver's own message",
      out.ok === false && /nothing matches "nothere"/.test(out.message), JSON.stringify(out));
    check("S24: …none of them wrote or pushed anything",
      (await buffersEqual("__quiet")) && (await undoDepth()) === depthQuiet);

    // -- the MANDATORY pixel proof: bound colors reach the GPU ------------------
    await bind(`{ kind: 'per-point-scalar', target: '#0-99', axis: 'color',
      scalars: Array.from({length:100},(_,i)=>i/99) }`);
    await cmd("hide @solvent");
    await cmd("bondopacity #0-99 0"); // edge lines pollute sprite-center samples
    await cmd("traceopacity alpha 0");
    await cmd("view #0-99");
    await sleep(1400); // camera tween settles
    const pts = await d.evaluate<number[]>(`${V}.debug.resolvePoints("#0-99")`);
    const pA = pts[0]; // scalar 0 → red
    const pB = pts[40]; // scalar ≈0.4 → green
    // depth-correct spheres OCCLUDE: a nearer chain neighbour can cover a
    // sample point's centre pixel (flat squares never did). Isolate the two
    // probes — size ⊥ color, so the bound ramp itself is untouched.
    await cmd("pointsize all 0");
    await cmd(`pointsize #${pA} 12`);
    await cmd(`pointsize #${pB} 12`);
    const proj = await d.evaluate<{ a: { x: number; y: number; front: boolean }; b: { x: number; y: number; front: boolean } }>(
      `({ a: ${V}.debug.projectPoint(${pA}), b: ${V}.debug.projectPoint(${pB}) })`);
    check("S24: both sample points project on-screen, apart",
      proj.a.front && proj.b.front &&
        Math.hypot(proj.a.x - proj.b.x, proj.a.y - proj.b.y) > 12, JSON.stringify(proj));
    await sleep(200);
    await d.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
    })()`); // load-immunity: capture only after fresh frames
    const shot = await d.captureB64(`${REPORT}/S24_pixels.png`);
    const px = await d.evaluate<{ a: number[]; b: number[] }>(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${shot}"; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const at = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
      return { a: at(${proj.a.x}, ${proj.a.y}), b: at(${proj.b.x}, ${proj.b.y}) };
    })()`);
    check("S24: the bound ramp RENDERS — start red-dominant",
      px.a[0] > px.a[1] + 60 && px.a[0] > px.a[2] + 60, JSON.stringify(px));
    check("S24: …and the mid point renders a DIFFERENT, green-dominant color",
      px.b[1] > px.b[0] + 60 && px.b[1] > px.b[2] + 40, JSON.stringify(px));
  });

  // ---- part 2, the "/terminal" route: the full pipe — stub result → panel
  // transcript → forwarded bind → viewer state → outcome line in the block.
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    const bindLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#claude-transcript .cl-bind')]
          .map(n=>({cls:n.className, text:n.textContent}))`);

    await typeInto("term-input", "/claude");
    await sleep(150);
    await typeInto("claude-input", "look at the target");
    // the stub streams on its own cadence; the ⤷ bind lines PERSIST once
    // rendered — poll for them instead of gambling fixed sleeps under load
    // (the S25 pattern, ledgered; S24 was its noted sibling)
    // NO turn-complete conjunct here (review fix): this turn HOLDS at the
    // approval gate by design (the stub waits for the decision), so the
    // input stays disabled until the approve below — waiting on it burned
    // the full timeout every run. The bind line alone is this wait's state.
    await d.waitFor(`document.querySelectorAll('#claude-transcript .cl-bind').length >= 1`, 8000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    let lines = await bindLines();
    check("S24: the auto tool's color result binds THROUGH THE PIPE (outcome line in its block)",
      lines[0]?.text === `⤷ colored 100 points of "#0-99" from scalars` &&
        /\bok\b/.test(lines[0]?.cls ?? ""), JSON.stringify(lines));
    check("S24: …and the viewer's buffer really changed (varying per element)",
      await d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.color;
        return (c[0]!==c[3*99]||c[1]!==c[3*99+1]||c[2]!==c[3*99+2]);
      })()`));
    const committedBefore = await d.evaluate<number>(`${V}.model.committed().length`);
    // the first ⤷ line (the auto tool's) renders BEFORE the gated block's
    // buttons — the click's own precondition is the approve button, so poll
    // for it; a missing button falls through to a red check, not a throw
    await d.waitFor(`document.querySelectorAll('.cl-approve').length >= 1`, 8000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    await d.evaluate(`[...document.querySelectorAll('.cl-approve')].at(-1)?.click()`);
    await d.waitFor(`document.querySelectorAll('#claude-transcript .cl-bind').length >= 2 && !document.getElementById('claude-input').disabled`, 8000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    lines = await bindLines();
    check("S24: the APPROVED command result creates a selection in the viewer",
      (await d.evaluate<number>(`${V}.model.committed().length`)) === committedBefore + 1 &&
        /^⤷ create_sele alpha\.group-0 → created "selection_\d+"/.test(lines[1]?.text ?? ""),
      JSON.stringify(lines));

    await typeInto("claude-input", "please series-demo now");
    await d.waitFor(`document.querySelectorAll('#claude-transcript .cl-bind').length >= 3 && !document.getElementById('claude-input').disabled`, 8000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    lines = await bindLines();
    check("S24: the series result routes to the PLOT and reports drawn (deep checks in S25)",
      lines[2]?.text === `⤷ series "example_series" drawn (150 frames) — click the plot to seek` &&
        /\bok\b/.test(lines[2]?.cls ?? ""), JSON.stringify(lines[2]));

    const sizeSnap = await d.evaluate<string>(`JSON.stringify([...${V}.rep.state.size.slice(0, 220)])`);
    await d.evaluate(`void (window.__preMismatch = Float32Array.from(${V}.rep.state.color))`);
    await typeInto("claude-input", "please mismatch-demo now");
    await d.waitFor(`document.querySelectorAll('#claude-transcript .cl-bind').length >= 4 && !document.getElementById('claude-input').disabled`, 8000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    lines = await bindLines();
    check("S24: the mismatch result renders an ERROR outcome and writes nothing",
      lines[3]?.text === `⤷ scalar count mismatch: 5 values for 10 points of "#0-9" — nothing written` &&
        /\berr\b/.test(lines[3]?.cls ?? "") &&
        (await d.evaluate<boolean>(`(()=>{
          const c=${V}.rep.state.color, s=window.__preMismatch;
          for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
          return true;
        })()`)), JSON.stringify(lines[3]));

    await typeInto("claude-input", "please scalar-size now");
    // (review fix) the one wait in this scenario the sweep missed: poll the
    // size buffer for the sentinel's write, mirroring the check
    await d.waitFor(`(()=>{ const s=${V}.rep.state.size;
      for (let i=0;i<50;i++) if (s[100+i] !== Math.fround((i/49)*6)) return false;
      return true; })()`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S24: the size sentinel binds through the pipe (t*6 at #100-149)",
      await d.evaluate<boolean>(`(()=>{
        const s=${V}.rep.state.size;
        for (let i=0;i<50;i++) if (s[100+i] !== Math.fround((i/49)*6)) return false;
        return true;
      })()`) && sizeSnap !== await d.evaluate<string>(`JSON.stringify([...${V}.rep.state.size.slice(0, 220)])`));

    await d.screenshot(`${REPORT}/S24_pipe.png`);
  }, 1180, 780, "/terminal");
}

async function S25(): Promise<void> {
  console.log("S25 — the plot tab: per-frame series drawn, playhead-synced, click-to-seek");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    const bindLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#claude-transcript .cl-bind')]
          .map(n=>({cls:n.className, text:n.textContent}))`);
    const markerX = () => d.evaluate<number>(`Number(${el("plot-marker")}.getAttribute('x1'))`);
    const linePoints = () =>
      d.evaluate<string>(`${el("plot-line")}.getAttribute('points') ?? ''`);
    const viewerFrame = () => d.evaluate<number>(`${V}.player.frame`);
    // the plot's fixed-viewBox geometry (mirrors plotmodel.ts)
    const N = 150;
    const AREA_X = 44, AREA_W = 800 - 44 - 10;
    const frameToX = (f: number) => AREA_X + (f / (N - 1)) * AREA_W;

    // -- a valid series arrives through the pipe and DRAWS ----------------------
    await typeInto("term-input", "/claude");
    await sleep(150);
    check("S25: the plot starts empty (empty-state note, no line)",
      await d.evaluate<boolean>(`!${el("plot-empty")}.hidden &&
        ${el("plot-svg")}.hasAttribute('hidden')`));
    await typeInto("claude-input", "please series-demo now");
    // POLL, never a fixed sleep: the stub streams through relay hops whose
    // latency scales with machine load — the one-shot-probe family's
    // standing fix (sample when the state exists; the timeout is the bound)
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')]
        .some(n => /series "example_series" drawn \\(150 frames\\)/.test(n.textContent))`, 15000)
      .catch(() => { /* timeout falls through — the checks below go red */ });
    check("S25: the ⤷ line reports the draw",
      (await bindLines()).some((l) => /series "example_series" drawn \(150 frames\)/.test(l.text)));
    check("S25: the SVG line has one vertex per frame",
      (await linePoints()).split(" ").length === N, `${(await linePoints()).split(" ").length}`);
    check("S25: the label and the raw min/max readout render",
      await d.evaluate<boolean>(`${el("plot-label")}.textContent === 'example_series' &&
        /min 6\\.5 · max 13\\.5 · 150 frames/.test(${el("plot-range")}.textContent)`),
      await d.evaluate<string>(`${el("plot-range")}.textContent`));
    check("S25: the empty state cleared, the plot shows",
      await d.evaluate<boolean>(`${el("plot-empty")}.hidden &&
        getComputedStyle(${el("plot-empty")}).display === 'none' &&
        !${el("plot-svg")}.hasAttribute('hidden')`),
      "hidden must actually mean display:none (explicit display beats UA [hidden])");

    // -- the playhead marker tracks the current frame ---------------------------
    const f0 = await viewerFrame();
    check("S25: the marker sits at the CURRENT frame",
      Math.abs((await markerX()) - frameToX(f0)) < 0.01,
      `marker=${await markerX()} expected=${frameToX(f0)} (frame ${f0})`);
    await d.evaluate(`${V}.player.seek(120)`); // drive a frame change
    // family retrofit (harness chapter): seek → frameChanged → plotFrame
    // relay → marker reposition is a bounded envelope (plus a possible
    // chunk fetch); poll for the marker to REACH frame 120 instead of
    // gambling a fixed 800ms against it under load (where this went red in
    // the chapter's lane, marker still at frame ~1). The check re-asserts.
    await d.waitFor(
      `Math.abs(Number(${el("plot-marker")}.getAttribute('x1') ?? -1) - ${frameToX(120)}) < 0.01`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S25: the marker MOVES when the frame changes",
      Math.abs((await markerX()) - frameToX(120)) < 0.01,
      `marker=${await markerX()} expected=${frameToX(120)}`);

    // -- click-to-seek: the plot drives the trajectory ---------------------------
    // (the plot surface sits under the terminal stack in the harness, so the
    // click is dispatched synthetically at the exact geometry a real click has)
    const target = 30;
    await d.evaluate(`(()=>{
      const svg=${el("plot-svg")};
      const r=svg.getBoundingClientRect();
      const clientX = r.left + (${frameToX(target)} / 800) * r.width;
      svg.dispatchEvent(new MouseEvent('click', { clientX, clientY: r.top + r.height/2, bubbles: true }));
    })()`);
    // same relay envelope as the seek above — poll for the viewer to reach
    // the clicked frame, then the check re-asserts both frame and marker
    await d.waitFor(`${V}.player.frame === ${target}`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S25: clicking the plot SEEKS the viewer to that frame",
      (await viewerFrame()) === target, `frame=${await viewerFrame()}`);
    await d.waitFor(
      `Math.abs(Number(${el("plot-marker")}.getAttribute('x1') ?? -1) - ${frameToX(target)}) < 0.01`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S25: …and the marker follows the seek",
      Math.abs((await markerX()) - frameToX(target)) < 0.01,
      `marker=${await markerX()} expected=${frameToX(target)}`);

    // -- the mismatched series: no draw, ⤷ error, previous plot intact ----------
    const pointsBefore = await linePoints();
    await typeInto("claude-input", "please series-mismatch now");
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')]
        .some(n => /series length mismatch/.test(n.textContent))`, 15000)
      .catch(() => { /* timeout falls through — the checks below go red */ });
    check("S25: a length-mismatched series produces the ⤷ error line",
      (await bindLines()).some((l) =>
        l.text === "⤷ series length mismatch: 7 values for 150 frames — not drawn" &&
        /\berr\b/.test(l.cls)));
    check("S25: …and draws NOTHING — the previous series is untouched",
      (await linePoints()) === pointsBefore);

    // -- close→reopen: the HOST re-pushes the held series on plot-ready ----------
    await d.evaluate(`(()=>{
      ${el("plot-line")}.setAttribute('points', '');
      ${el("plot-label")}.textContent = 'wiped';
    })()`); // simulate a fresh, empty plot page…
    await d.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'plot-ready' } }))`);
    await sleep(200); // …announcing itself, exactly as a reopened tab does
    check("S25: plot-ready re-pushes the held series (close→reopen restores)",
      (await linePoints()) === pointsBefore &&
        (await d.evaluate<string>(`${el("plot-label")}.textContent`)) === "example_series");
    check("S25: …and the re-pushed playhead is the current frame",
      Math.abs((await markerX()) - frameToX(target)) < 0.01);

    // evidence only: lift the (harness-occluded) plot surface above the
    // terminal stack for the screenshot — no assertion depends on this
    await d.evaluate(`document.getElementById('plot-harness').style.zIndex = '200'`);
    await d.screenshot(`${REPORT}/S25_plot.png`);
  }, 1180, 780, "/terminal");
}

async function S26(): Promise<void> {
  console.log("S26 — the Claude/terminal split: resize, flip, swap, persist");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const rect = (id: string) =>
      d.evaluate<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>(
        `(()=>{ const r=${el(id)}.getBoundingClientRect();
          return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; })()`);
    const stackDir = () =>
      d.evaluate<string>(`getComputedStyle(${el("term-stack")}).flexDirection`);
    const claudeDisplay = () =>
      d.evaluate<string>(`getComputedStyle(${el("claude-root")}).display`);
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    /** claude's share of the split axis (excludes the 6px divider). */
    const claudeShare = async (axis: "height" | "width"): Promise<number> => {
      const c = await rect("claude-root");
      const t = await rect("term-root");
      return c[axis] / (c[axis] + t[axis]);
    };
    const near = (a: number, b: number, tol = 0.02): boolean => Math.abs(a - b) < tol;

    // -- default layout ----------------------------------------------------------
    await typeInto("term-input", "/claude");
    await sleep(150);
    const stack = await rect("term-stack");
    let c = await rect("claude-root");
    let t = await rect("term-root");
    check("S26: default layout — stacked (column), claude above the terminal",
      (await stackDir()) === "column" && c.bottom <= t.top + 1,
      `dir=${await stackDir()} claude.bottom=${c.bottom} term.top=${t.top}`);
    check("S26: …at the default 60/40 ratio", near(await claudeShare("height"), 0.6),
      `share=${await claudeShare("height")}`);
    await d.screenshot(`${REPORT}/S26_default.png`);

    // -- divider drag: resize + clamping ------------------------------------------
    let div = await rect("claude-divider");
    await d.drag(div.left + stack.width / 2, div.top + 3,
      stack.left + stack.width / 2, stack.top + stack.height * 0.25);
    await sleep(150);
    check("S26: dragging the divider resizes the split (≈0.25)",
      near(await claudeShare("height"), 0.25, 0.03), `share=${await claudeShare("height")}`);
    div = await rect("claude-divider");
    await d.drag(div.left + stack.width / 2, div.top + 3,
      stack.left + stack.width / 2, stack.top + 2); // way past the minimum
    await sleep(150);
    check("S26: …and clamps at the minimum — neither pane can vanish",
      near(await claudeShare("height"), 0.15, 0.03), `share=${await claudeShare("height")}`);
    check("S26: both panes stay USABLE at the extreme (inputs visible, logs scroll inside)",
      await d.evaluate<boolean>(`(()=>{
        const ci=${el("claude-input")}.getBoundingClientRect();
        const ti=${el("term-input")}.getBoundingClientRect();
        const log=${el("term-log")};
        const tr=${el("claude-transcript")};
        return ci.height > 10 && ti.height > 10 &&
          getComputedStyle(${el("claude-inputrow")}).display !== 'none' &&
          log.clientHeight > 0 && tr.clientHeight >= 0 &&
          log.scrollHeight >= log.clientHeight; // scrolls WITHIN its pane
      })()`));
    await d.screenshot(`${REPORT}/S26_extreme.png`);
    div = await rect("claude-divider");
    await d.drag(div.left + stack.width / 2, div.top + 3,
      stack.left + stack.width / 2, stack.top + stack.height * 0.35);
    await sleep(150);

    // -- flip: stacked ↔ side-by-side, ratio preserved -----------------------------
    const shareBeforeFlip = await claudeShare("height");
    await d.evaluate(`${el("claude-flip")}.click()`);
    await sleep(150);
    c = await rect("claude-root");
    t = await rect("term-root");
    check("S26: flip → side-by-side (row), claude on the left, same top",
      (await stackDir()) === "row" && c.right <= t.left + 1 && Math.abs(c.top - t.top) < 1,
      `dir=${await stackDir()}`);
    check("S26: …the ratio survives the flip",
      near(await claudeShare("width"), shareBeforeFlip, 0.03),
      `w-share=${await claudeShare("width")} vs h-share=${shareBeforeFlip}`);

    // -- swap: order exchanges, EACH PANE KEEPS ITS SIZE ----------------------------
    const widthBeforeSwap = (await rect("claude-root")).width;
    await d.evaluate(`${el("claude-swap")}.click()`);
    await sleep(150);
    c = await rect("claude-root");
    t = await rect("term-root");
    check("S26: swap → terminal first, claude on the RIGHT",
      t.right <= c.left + 1, `term.right=${t.right} claude.left=${c.left}`);
    check("S26: …and each pane keeps its size (ratio complemented)",
      Math.abs(c.width - widthBeforeSwap) < 4,
      `before=${widthBeforeSwap} after=${c.width}`);
    await d.screenshot(`${REPORT}/S26_side_swapped.png`);

    // -- persistence: the layout survives a reload ---------------------------------
    const persistedShare = await claudeShare("width");
    await d.navigate("/terminal");
    // full page boot: producer stream + all three surfaces. POLL for the
    // claude panel instead of a fixed sleep — the impostor/tube shader
    // programs lengthen SwiftShader's first-render compile, and a fixed
    // 3500ms raced it (the assertions below are unchanged).
    await d.evaluate(`(async () => {
      for (let i = 0; i < 60; i++) {
        if (document.getElementById('claude-root')) return;
        await new Promise(r => setTimeout(r, 250));
      }
    })()`);
    await sleep(300);
    await pause(d);
    check("S26: after reload the panel is OPEN with the layout RESTORED",
      (await claudeDisplay()) !== "none" && (await stackDir()) === "row",
      `display=${await claudeDisplay()} dir=${await stackDir()}`);
    c = await rect("claude-root");
    t = await rect("term-root");
    check("S26: …same order (terminal first) and same ratio",
      t.right <= c.left + 1 && near(await claudeShare("width"), persistedShare, 0.03),
      `share=${await claudeShare("width")} want=${persistedShare}`);
    check("S26: …and the transcript did NOT persist (layout only)",
      await d.evaluate<boolean>(`${el("claude-transcript")}.children.length === 0`));

    // -- collapse still restores the full terminal ---------------------------------
    await d.evaluate(`${el("claude-close")}.click()`);
    await sleep(150);
    check("S26: ✕ collapses to the full terminal (computed display none + full area)",
      (await claudeDisplay()) === "none" &&
        (await rect("term-root")).width > stack.width * 0.98 &&
        (await rect("term-root")).height > stack.height * 0.98);
    await typeInto("term-input", "/claude");
    await sleep(150);
    check("S26: reopening keeps the stored layout (side, terminal-first, same ratio)",
      (await stackDir()) === "row" &&
        (await rect("term-root")).right <= (await rect("claude-root")).left + 1 &&
        near(await claudeShare("width"), persistedShare, 0.03));
  }, 1180, 780, "/terminal");
}

async function S27(): Promise<void> {
  console.log("S27 — authorable mods: Python compute in the producer, routed by declared kind");

  // ---- part 1, the "/" route: the per-point mod end-to-end — index
  // alignment, the fail-closed no-write, one-stroke undo, and the pixel proof.
  await withDriver(async (d) => {
    await seedSolvent(d); // the @solvent the pixel proof hides to clear the bulk
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.color))`);
    const buffersEqual = (slot: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.color, s=window.${slot};
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    // async mod outcomes ride the commandResult channel — capture them
    await d.evaluate(`void (window.__lines = [],
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'commandResult' && e.data.id === -1) window.__lines.push(e.data);
      }))`);
    const lastAsync = () =>
      d.evaluate<{ status: string; message: string } | null>(`window.__lines.at(-1) ?? null`);

    // -- the loaded workspace mods appear in `mods` with kind + attribution ------
    const listing = await cmd("mods");
    check("S27: workspace mod files load and list with kind · produces · credit",
      listing.message.includes("workspace:") &&
        listing.message.includes("  index_ramp — analysis · per-point-scalar → color · by Example Author · https://github.com/DomFico/molaro") &&
        listing.message.includes("  frame_metric — analysis · per-frame-series · by Example Author"),
      listing.message);

    // -- invoke: sync acknowledgement, async outcome, INDEX ALIGNMENT ------------
    await snap("__pristine");
    const baseDepth = await undoDepth();
    const run = await cmd("index_ramp alpha.group-0.subgroup-0");
    check("S27: the verb acknowledges and hands off (100 resolved points)",
      run.status === "ok" && run.message === "running index_ramp on 100 points…",
      JSON.stringify(run));
    await sleep(1500); // producer round-trip + bind
    const outcome = await lastAsync();
    check("S27: the async outcome line reports the bind",
      outcome?.status === "ok" &&
        outcome?.message === `index_ramp → colored 100 points of "alpha.group-0.subgroup-0" from scalars`,
      JSON.stringify(outcome));
    const audit = await d.evaluate<{ match: boolean; changed: number; first: number[]; last: number[] }>(`(()=>{
      const v=${V}; const c=v.rep.state.color; const s=window.__pristine;
      const changed=[];
      for (let p=0;p<c.length/3;p++) {
        if (c[3*p]!==s[3*p]||c[3*p+1]!==s[3*p+1]||c[3*p+2]!==s[3*p+2]) changed.push(p);
      }
      const want=[...new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"))].sort((a,b)=>a-b);
      const pts=v.debug.resolvePoints("alpha.group-0.subgroup-0");
      const rgb=(p)=>[c[3*p],c[3*p+1],c[3*p+2]];
      return { changed: changed.length,
               match: changed.length===want.length && changed.every((p,i)=>p===want[i]),
               first: rgb(pts[0]), last: rgb(pts[pts.length-1]) };
    })()`);
    check("S27: INDEX ALIGNMENT — the values land on EXACTLY the resolved elements",
      audit.match && audit.changed === 100, JSON.stringify(audit));
    check("S27: the Python ramp maps through the colormap (first red, last magenta)",
      audit.first[0] === 1 && audit.first[1] === 0 && audit.first[2] === 0 &&
        audit.last[0] === 1 && audit.last[1] === 0 && audit.last[2] === 1,
      JSON.stringify(audit));
    check("S27: one producer-computed bind = ONE undo stroke",
      (await undoDepth()) === baseDepth + 1);
    await d.ctrlZ();
    await sleep(120);
    check("S27: …and one Ctrl+Z reverses it completely",
      (await buffersEqual("__pristine")) && (await undoDepth()) === baseDepth);

    // -- the broken mod: fail-closed, nothing written, no stroke -----------------
    await snap("__quiet");
    const broken = await cmd("broken_ramp alpha.group-0.subgroup-0");
    check("S27: a broken mod still acknowledges (the failure is downstream)",
      broken.status === "ok", JSON.stringify(broken));
    await sleep(1500);
    const failed = await lastAsync();
    check("S27: …then fails CLOSED with the validation error",
      failed?.status === "error" &&
        /broken_ramp failed: per-point-scalar values must be in \[0,1\] — got 2\.5/.test(failed?.message ?? ""),
      JSON.stringify(failed));
    check("S27: …and wrote NOTHING, pushed NOTHING",
      (await buffersEqual("__quiet")) && (await undoDepth()) === baseDepth);
    const unknown = await cmd("no_such_mod alpha");
    check("S27: an unregistered mod name is an unknown command",
      unknown.status === "error" && unknown.message === "unknown command: no_such_mod");

    // -- the pixel proof: producer-computed colors reach the GPU ------------------
    await cmd("index_ramp alpha.group-0.subgroup-0");
    await sleep(1500);
    await cmd("hide @solvent");
    await cmd("bondopacity alpha.group-0.subgroup-0 0");
    await cmd("traceopacity alpha 0");
    await cmd("view alpha.group-0.subgroup-0");
    await sleep(1400);
    const pts = await d.evaluate<number[]>(`${V}.debug.resolvePoints("alpha.group-0.subgroup-0")`);
    const pA = pts[0];
    const pB = pts[Math.floor(pts.length * 0.4)];
    await cmd(`pointsize #${pA} 12`);
    await cmd(`pointsize #${pB} 12`);
    const proj = await d.evaluate<{ a: { x: number; y: number; front: boolean }; b: { x: number; y: number; front: boolean } }>(
      `({ a: ${V}.debug.projectPoint(${pA}), b: ${V}.debug.projectPoint(${pB}) })`);
    check("S27: pixel probes project on-screen, apart",
      proj.a.front && proj.b.front &&
        Math.hypot(proj.a.x - proj.b.x, proj.a.y - proj.b.y) > 12, JSON.stringify(proj));
    // THE PROBE PRIMITIVE, single mode (harness chapter item 1): the scene
    // is PLAYING, so a projection computed over CDP was stale by screenshot
    // time — the moving-pose flavor of the family defect (S27's recorded
    // flake). Locate and read now share ONE in-page task, each read
    // re-projecting its own point; and all 4 pixels of a 2×2 patch at the
    // center of a size-12 sphere must classify — a stronger pin than the
    // old single center pixel. The settle guarantees the size-12 writes
    // DREW before sampling (the load-immunity rule, poll not sleep).
    await d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const redAt = await d.samplePatch({
      centerExpr: `${V}.debug.projectPoint(${pA})`, half: 1,
      classify: "r > g + 60 && r > b + 60",
    });
    check("S27: the Python-computed ramp RENDERS (red-dominant start)",
      redAt.count === 4, `red@pA=${redAt.count}/4`);
    const greenMid = await d.samplePatch({
      centerExpr: `${V}.debug.projectPoint(${pB})`, half: 1,
      classify: "g > r + 60 && g > b + 40",
    });
    check("S27: …with a different, green-dominant mid point",
      greenMid.count === 4, `green@pB=${greenMid.count}/4`);
    await d.screenshot(`${REPORT}/S27_pixels.png`); // evidence only
  });

  // ---- part 2, the "/terminal" route: the per-frame-series mod → the plot.
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    const logLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`);

    await typeInto("term-input", "frame_metric all");
    // family retrofit (harness chapter): a REAL producer round-trip (6000
    // pts + 150 frames) whose latency scales with load — poll for the
    // persistent hand-off log line, never a fixed 2500ms (the S30 rg rule)
    await d.waitFor(
      `[...document.querySelectorAll('#term-log .term-line')]
        .some(l => /frame_metric → series "frame_metric" \\(150 frames\\)/.test(l.textContent))`, 30000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const lines = await logLines();
    check("S27: the series mod acknowledges, then reports the plot hand-off",
      lines.some((l) => l.text === "running frame_metric on 6000 points…") &&
        lines.some((l) => l.text === `frame_metric → series "frame_metric" (150 frames) → the plot tab`),
      JSON.stringify(lines.slice(-3)));
    await d.waitFor(
      `(${el("plot-line")}.getAttribute('points') ?? '').split(' ').length === 150 &&
        ${el("plot-label")}.textContent === 'frame_metric'`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S27: …and the plot DRAWS it — one vertex per frame, labeled by the mod",
      await d.evaluate<boolean>(`(${el("plot-line")}.getAttribute('points') ?? '').split(' ').length === 150 &&
        ${el("plot-label")}.textContent === 'frame_metric'`),
      await d.evaluate<string>(`${el("plot-label")}.textContent`));
    check("S27: the playhead marker is live on the mod's series",
      await d.evaluate<boolean>(`!${el("plot-marker")}.hasAttribute('hidden')`));

    await d.screenshot(`${REPORT}/S27_series.png`);
  }, 1180, 780, "/terminal");
}

async function S28(): Promise<void> {
  console.log("S28 — scatter: X-vs-Y as the fourth result kind, playhead-synced, nearest-point seek");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    const bindLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#claude-transcript .cl-bind')]
          .map(n=>({cls:n.className, text:n.textContent}))`);
    const dotCount = () =>
      d.evaluate<number>(`document.querySelectorAll('#plot-dots .plot-dot').length`);
    const currentDots = () =>
      d.evaluate<number[]>(`[...document.querySelectorAll('#plot-dots .plot-dot')]
        .map((c, i) => c.classList.contains('current') ? i : -1).filter((i) => i >= 0)`);
    const viewerFrame = () => d.evaluate<number>(`${V}.player.frame`);
    const clickDot = (i: number) =>
      d.evaluate(`(()=>{
        const svg=${el("plot-svg")};
        const dot=document.querySelectorAll('#plot-dots .plot-dot')[${i}];
        const r=svg.getBoundingClientRect();
        const clientX = r.left + (Number(dot.getAttribute('cx')) / 800) * r.width;
        const clientY = r.top + (Number(dot.getAttribute('cy')) / 300) * r.height;
        svg.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
      })()`);

    // -- the synced scatter: draw, readout, highlight, moving highlight ----------
    await typeInto("term-input", "/claude");
    await sleep(150);
    await typeInto("claude-input", "please scatter-demo now");
    // family retrofit (harness chapter): the ⤷ bind line PERSISTS once
    // rendered — poll for it (the S24 discipline) instead of gambling a
    // fixed 600ms against the stub's cadence under peak parallel load,
    // which is where this member went red in the chapter's own full lane
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')]
        .some(n => /scatter "example_scatter" drawn \\(40 points/.test(n.textContent))`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: the ⤷ line reports the scatter draw with the seek hint",
      (await bindLines()).some((l) =>
        l.text === `⤷ scatter "example_scatter" drawn (40 points — click a point to seek)` &&
        /\bok\b/.test(l.cls)), JSON.stringify(await bindLines()));
    check("S28: 40 dots render; the line and the series marker are cleared",
      (await dotCount()) === 40 &&
        (await d.evaluate<string>(`${el("plot-line")}.getAttribute('points')`)) === "" &&
        (await d.evaluate<boolean>(
          // computed display, not the attribute — SVG never gets the UA
          // [hidden] rule (the standing lesson, SVG flavor)
          `getComputedStyle(${el("plot-marker")}).display === 'none'`)));
    check("S28: the label and BOTH axis readouts render (raw min/max, axis names)",
      await d.evaluate<boolean>(`${el("plot-label")}.textContent === 'example_scatter' &&
        /quantity_a 3…7 · quantity_b 7…13 · 40 pts/.test(${el("plot-range")}.textContent)`),
      await d.evaluate<string>(`${el("plot-range")}.textContent`));
    await d.evaluate(`${V}.player.seek(5)`);
    await d.waitFor(`[...document.querySelectorAll('#plot-dots .plot-dot')].map((c,i)=>c.classList.contains('current')?i:-1).filter(i=>i>=0).join(',') === '5'`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: the current-frame point is highlighted (the scatter's playhead)",
      JSON.stringify(await currentDots()) === "[5]", JSON.stringify(await currentDots()));
    await d.evaluate(`${V}.player.seek(20)`);
    await d.waitFor(`[...document.querySelectorAll('#plot-dots .plot-dot')].map((c,i)=>c.classList.contains('current')?i:-1).filter(i=>i>=0).join(',') === '20'`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: …and the highlight MOVES with the frame",
      JSON.stringify(await currentDots()) === "[20]", JSON.stringify(await currentDots()));

    // -- nearest-point click-to-seek ----------------------------------------------
    await clickDot(10);
    await d.waitFor(`${V}.player.frame === 10`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: clicking a point seeks the viewer to THAT point's frame",
      (await viewerFrame()) === 10, `frame=${await viewerFrame()}`);
    await d.waitFor(`[...document.querySelectorAll('#plot-dots .plot-dot')].map((c,i)=>c.classList.contains('current')?i:-1).filter(i=>i>=0).join(',') === '10'`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: …and the highlight follows the seek",
      JSON.stringify(await currentDots()) === "[10]");

    // -- the static (frames-less) scatter: draws, no highlight, no seek ----------
    await typeInto("claude-input", "please scatter-static now");
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')].some(n => /scatter "example_scatter" drawn \\(30 points\\)/.test(n.textContent)) && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: a frames-less scatter draws (30 dots), ⤷ WITHOUT a seek hint",
      (await dotCount()) === 30 &&
        (await bindLines()).some((l) => l.text === `⤷ scatter "example_scatter" drawn (30 points)`));
    await d.evaluate(`${V}.player.seek(33)`);
    await d.waitFor(`${V}.player.frame === 33`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: …no highlight on a static scatter", (await currentDots()).length === 0);
    const frameBefore = await viewerFrame();
    await clickDot(3);
    await sleep(300);
    check("S28: …and clicking it does NOT seek", (await viewerFrame()) === frameBefore);

    // -- the malformed scatter: fail-closed on the plot route ---------------------
    await typeInto("claude-input", "please scatter-mismatch now");
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')].some(n => /malformed scatter payload — not drawn/.test(n.textContent)) && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: unequal x/y → the ⤷ error line, and the previous scatter STANDS",
      (await bindLines()).some((l) =>
        l.text === "⤷ malformed scatter payload — not drawn" && /\berr\b/.test(l.cls)) &&
        (await dotCount()) === 30, `dots=${await dotCount()}`);

    // -- replacement both ways: one active item ------------------------------------
    await typeInto("claude-input", "please series-demo now");
    await d.waitFor(`(${el("plot-line")}.getAttribute('points') ?? '') !== '' && document.querySelectorAll('#plot-dots .plot-dot').length === 0 && !${el("plot-marker")}.hasAttribute('hidden') && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: a series result REPLACES the scatter (line back, dots gone)",
      (await dotCount()) === 0 &&
        (await d.evaluate<string>(`${el("plot-line")}.getAttribute('points')`)) !== "" &&
        !(await d.evaluate<boolean>(`${el("plot-marker")}.hasAttribute('hidden')`)));
    await typeInto("claude-input", "please scatter-demo now");
    await d.waitFor(`document.querySelectorAll('#plot-dots .plot-dot').length === 40 && (${el("plot-line")}.getAttribute('points') ?? '') === '' && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: …and a scatter replaces the series right back",
      (await dotCount()) === 40 &&
        (await d.evaluate<string>(`${el("plot-line")}.getAttribute('points')`)) === "");

    // -- the Python scatter mod: dict return, frames sync, seek --------------------
    const listing = await cmd("mods");
    check("S28: the scatter mod lists with produces: scatter",
      listing.message.includes("  xy_metric — analysis · scatter · by Example Author"),
      listing.message);
    await typeInto("term-input", "xy_metric alpha");
    // family retrofit: producer round-trip → poll for the 150-dot draw
    await d.waitFor(`document.querySelectorAll('#plot-dots .plot-dot').length === 150 && ${el("plot-label")}.textContent === 'xy_metric'`, 30000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S28: the Python scatter mod computes and draws (150 dots, its labels)",
      (await dotCount()) === 150 &&
        (await d.evaluate<boolean>(`${el("plot-label")}.textContent === 'xy_metric' &&
          /dist_a .+ · dist_b .+ · 150 pts/.test(${el("plot-range")}.textContent)`)),
      await d.evaluate<string>(`${el("plot-range")}.textContent`));
    const preClick = await viewerFrame();
    await clickDot(120);
    // click → seek relay (+ a possible chunk fetch): poll for the seek to
    // land (frame moved off preClick) instead of a fixed 600ms
    await d.waitFor(`${V}.player.frame !== ${preClick}`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    // real-data scatters self-overlap, so the NEAREST dot to the click may
    // be a different frame at (nearly) the same (x, y) — the semantic
    // guarantee is that the seeked frame's point IS at the clicked spot
    // (xy_metric's frames are the identity, so dot index == frame)
    const seeked = await viewerFrame();
    const atClick = await d.evaluate<boolean>(`(()=>{
      const dots=document.querySelectorAll('#plot-dots .plot-dot');
      const a=dots[120], s=dots[${seeked}];
      if (!a || !s) return false;
      const dx=Number(a.getAttribute('cx'))-Number(s.getAttribute('cx'));
      const dy=Number(a.getAttribute('cy'))-Number(s.getAttribute('cy'));
      return Math.hypot(dx,dy) <= 14; // within the hit tolerance (viewBox units)
    })()`);
    check("S28: clicking the mod's scatter seeks to a frame whose point is AT the click",
      seeked !== preClick && atClick, `frame=${seeked} (clicked dot 120)`);

    // evidence: lift the harness-occluded plot for the screenshot
    await d.evaluate(`document.getElementById('plot-harness').style.zIndex = '200'`);
    await d.screenshot(`${REPORT}/S28_scatter.png`);
  }, 1180, 780, "/terminal");
}


async function S29(): Promise<void> {
  console.log("S29 — rm: deleting workspace mods, y/n confirmed, fail-safe, not undoable");
  // STRUCTURAL SAFETY (harness chapter, item 2): this scenario really deletes
  // mod files, so the real .molaro/mods must never be a deletion candidate.
  // The shipped files are COPIED into a temporary directory and the bridge is
  // pointed there via E2E_MODS_DIR — one const in bridge.ts covers both its
  // scan and its unlink surface, so no code path in the whole run resolves
  // the real directory. That is what makes the guarantee hold when the
  // scenario ABORTS mid-run (SIGKILL between `y` and the outcome line): the
  // old snapshot-and-finally-restore protected only a clean exit. The
  // manifest comparison at the end additionally proves non-interference on
  // every green run. Registry order = sorted filenames, then the fileless
  // `broken_ramp` the harness appends last.
  const realDir = ".molaro/mods";
  const realManifest = (): string =>
    readdirSync(realDir).filter((f) => f.endsWith(".py")).sort()
      .map((f) => `${f}:${createHash("sha256").update(readFileSync(join(realDir, f))).digest("hex")}`)
      .join("\n");
  const manifestBefore = realManifest();
  const modsDir = mkdtempSync(join(tmpdir(), "molaro-s29-mods-"));
  const fixtureFile = join(modsDir, "zz_fixture.py");
  try {
    // (review fix) setup lives INSIDE the try: a failure in the copies or
    // the fixture write still reaches the finally, so the temp dir can
    // never be orphaned
    for (const f of readdirSync(realDir).filter((x) => x.endsWith(".py"))) {
      copyFileSync(join(realDir, f), join(modsDir, f));
    }
    process.env.E2E_MODS_DIR = modsDir; // the bridge child inherits process.env
    const shippedFiles = readdirSync(modsDir).filter((f) => f.endsWith(".py")).sort();
    const examples = shippedFiles.map((f) => join(modsDir, f));
    const shippedNames = shippedFiles.map((f) => f.replace(/\.py$/, ""));
    const allWorkspace = [...shippedNames, "broken_ramp"];
    writeFileSync(fixtureFile, [
      "# molaro-mod",
      "# name: zz_fixture",
      "# kind: analysis",
      "# produces: per-frame-series",
      "",
      "def compute(data, target_indices):",
      "    return [0.0] * data.give_header().n_frames",
      "",
    ].join("\n"), "utf-8");
    await withDriver(async (d) => {
      const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      const logLines = () =>
        d.evaluate<{ cls: string; text: string }[]>(
          `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`);
      const lastLine = async () => (await logLines()).at(-1);
      const submit = async (text: string): Promise<void> => {
        const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
          const b=${el("term-input")}.getBoundingClientRect();
          return {x:b.left+b.width/2, y:b.top+b.height/2};
        })()`);
        await d.click(r.x, r.y);
        await d.insertText(text);
        await d.key("Enter", "Enter", 13);
        await sleep(350);
      };
      const listsMod = async (name: string): Promise<boolean> =>
        (await cmd("mods")).message.includes(` ${name} — `);

      // -- the fixture loads, lists, and is invocable ---------------------------
      check("S29: the fixture mod loads and lists", await listsMod("zz_fixture"));
      await submit("zz_fixture all");
      check("S29: …and its verb is invocable",
        (await logLines()).some((l) => l.text === "running zz_fixture on 6000 points…"));
      await sleep(600); // let its series land; not the subject here

      // -- rm prompts; an UNRECOGNIZED answer cancels and is NOT executed --------
      await submit("rm zz_fixture");
      let last = await lastLine();
      check("S29: rm prompts with exactly what will be deleted + the irreversibility note",
        last?.text === "will delete 1 workspace mod: zz_fixture\nfiles are removed from disk — this CANNOT be undone. y/n?" &&
          /term-ok/.test(last?.cls ?? ""),
        JSON.stringify(last));
      await submit("view alpha"); // looks like a command — it is an ANSWER
      check("S29: an unrecognized answer CANCELS and never runs as a command",
        (await lastLine())?.text === "cancelled — nothing deleted" &&
          !(await logLines()).some((l) => l.text === "focused 400 points"));
      check("S29: …the mod is fully intact (file, listing)",
        existsSync(fixtureFile) && (await listsMod("zz_fixture")));

      // -- n cancels; a command-looking answer that IS "clear" also cancels ------
      await submit("rm zz_fixture");
      await submit("n");
      check("S29: n cancels — nothing deleted",
        (await lastLine())?.text === "cancelled — nothing deleted" && existsSync(fixtureFile));
      await submit("rm zz_fixture");
      const linesBefore = (await logLines()).length;
      await submit("clear"); // while pending, even `clear` is just an answer
      check("S29: `clear` typed as an answer cancels (fail-safe) and does NOT wipe the log",
        (await lastLine())?.text === "cancelled — nothing deleted" &&
          (await logLines()).length > linesBefore && existsSync(fixtureFile));

      // -- y deletes: disk, listing, and the verb all agree -----------------------
      await submit("rm zz_fixture");
      await submit("y");
      await sleep(500); // host round-trip + async outcome line
      check("S29: y deletes — the outcome line reports it",
        (await logLines()).some((l) => l.text === "deleted 1 mod: zz_fixture"));
      check("S29: …file gone from disk", !existsSync(fixtureFile));
      check("S29: …gone from the listing", !(await listsMod("zz_fixture")));
      const dead = await cmd("zz_fixture all");
      check("S29: …and its verb no longer resolves",
        dead.status === "error" && dead.message === "unknown command: zz_fixture");

      // -- built-in refusal and nomatch never prompt -------------------------------
      await submit("rm rainbow");
      check("S29: a built-in is refused by name, nothing deleted",
        (await lastLine())?.text === '"rainbow" is built-in — code, not a file; it cannot be deleted\nnothing to delete');
      await submit("help rm"); // proves NO pending prompt swallowed this
      check("S29: …and no prompt was armed (the next input ran as a command)",
        /delete WORKSPACE mod files/.test((await lastLine())?.text ?? ""));
      await submit("rm nonexistent");
      check("S29: an unknown name nomatches without prompting",
        (await lastLine())?.text === 'no mod named "nonexistent"\nnothing to delete' &&
          /term-nomatch/.test((await lastLine())?.cls ?? ""));

      // -- rm all: exactly the workspace mods; built-ins survive; partial failure --
      await submit("rm all");
      last = await lastLine();
      check("S29: rm all lists EXACTLY the workspace mods in the prompt",
        last?.text === `will delete ${allWorkspace.length} workspace mods: ${allWorkspace.join(", ")}\n` +
          "files are removed from disk — this CANNOT be undone. y/n?",
        JSON.stringify(last));
      await submit("y");
      await sleep(600);
      const outcome = (await logLines()).find((l) => /^deleted \d+ mods:/.test(l.text));
      check("S29: …y deletes the file-backed mods and reports the fileless one as FAILED",
        outcome?.text === `deleted ${shippedNames.length} mods: ${shippedNames.join(", ")}\n` +
          "failed: broken_ramp — no file recorded for this mod (still registered)",
        JSON.stringify(outcome));
      check("S29: …the file-backed mods are gone from disk", examples.every((f) => !existsSync(f)));
      const listing = (await cmd("mods")).message;
      check("S29: …registry agrees with disk: broken_ramp stays, the file-backed mods are gone, rainbow survives",
        listing.includes(" broken_ramp — ") && listing.includes(" rainbow — ") &&
          shippedNames.every((n) => !listing.includes(` ${n} — `)),
        listing);
      check("S29: …the built-in still works",
        (await cmd("rainbow alpha.group-0.subgroup-0")).status === "ok");
    }, 1180, 780, "/terminal");
  } finally {
    // serial-mode hygiene: later scenarios in the same process must see the
    // real mods again; the temp copy is throwaway
    delete process.env.E2E_MODS_DIR;
    rmSync(modsDir, { recursive: true, force: true });
  }
  check("S29: the REAL .molaro/mods was never touched (manifest byte-identical)",
    realManifest() === manifestBefore);
}

// ====================== S30: reference mods on the REAL adk system ============
// The domain reference mods (rg / rmsf) end to end on the hero system — a real
// mdtraj producer under the mdbench interpreter, driven through the terminal.
// Numerical correctness vs the corpus is proved separately (and exhaustively) by
// tests/reference_mods_corpus.py; S30 proves the BINDING on real data: a
// per-frame-series drawing a real Rg curve with a live playhead, and a
// per-point-scalar RMSF coloring the structure then undoing in one stroke.
// Requires mdtraj (mdbench) + the corpus checkout — VIEWER_PYTHON overrides the
// interpreter; serve.py resolves the sibling benchmark_systems tree itself.
const MDBENCH_PY = process.env.VIEWER_PYTHON ?? "/home/dom/miniforge3/envs/mdbench/bin/python";

async function withRealDriver(fn: (d: E2EDriver) => Promise<void>, route = "/terminal"): Promise<void> {
  portBase += 2;
  const d = new E2EDriver({
    bridgePort: portBase, cdpPort: portBase + 300, width: 1180, height: 780,
    producerArgs: ["--system", "03_adk_psf_dcd"],
    python: MDBENCH_PY,
  });
  try {
    await d.start();
    await d.navigate(route);
    await sleep(6500); // real mdtraj load (PDB + DCD, 3341 atoms × 98 frames)
    await fn(d);
  } finally {
    await d.dispose();
  }
}

async function S30(): Promise<void> {
  console.log("S30 — reference mods on the REAL adk trajectory: rg curve + rmsf color/undo");
  await withRealDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const logLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`);
    const typeInto = async (text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el("term-input")}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };

    // the real system loaded: 3341 atoms (adk) — rep.state.color is per-point RGB
    const nPts = await d.evaluate<number>(`${V}.rep.state.color.length / 3`);
    check("S30: the real adk system is loaded (3341 atoms)", nPts === 3341, `pointCount=${nPts}`);

    // the reference mods are registered vocabulary, with kind + produces
    const listing = (await cmd("mods")).message;
    check("S30: rg / rmsd / rmsf appear in `mods` with their kind and produces",
      listing.includes(" rg — analysis · per-frame-series") &&
        listing.includes(" rmsd — analysis · per-frame-series") &&
        listing.includes(" rmsf — analysis · per-point-scalar → color"),
      listing);

    // -- rg: a per-frame-series → a real curve in the plot, one vertex per frame --
    await typeInto("rg all");
    // POLL for the async hand-off line, never a fixed sleep: this is a REAL
    // producer round-trip (python + the reference compute) whose latency
    // scales with machine load — the slowest single wait in the suite
    await d.waitFor(
      `[...document.querySelectorAll('#term-log .term-line')]
        .some(l => /rg → series "rg" \\(98 frames\\)/.test(l.textContent))`, 30000)
      .catch(() => { /* timeout falls through — the checks below go red */ });
    const rgLines = await logLines();
    check("S30: rg acknowledges over all atoms, then reports the plot hand-off",
      rgLines.some((l) => l.text === "running rg on 3341 points…") &&
        rgLines.some((l) => l.text === 'rg → series "rg" (98 frames) → the plot tab'),
      JSON.stringify(rgLines.slice(-3)));
    // the hand-off LINE arriving (waited above) and the plot PAGE drawing
    // the series are two envelopes: the host still has to push it and the
    // SVG page render it (plot-ready relay). Poll for the draw instead of
    // sampling once — this is the second envelope that went red under load.
    await d.waitFor(
      `(${el("plot-line")}.getAttribute('points') ?? '').trim().split(' ').length === 98 &&
        ${el("plot-label")}.textContent === 'rg'`, 30000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S30: …the plot draws the Rg curve — one vertex per frame, labeled `rg`",
      await d.evaluate<boolean>(`(${el("plot-line")}.getAttribute('points') ?? '').trim().split(' ').length === 98 &&
        ${el("plot-label")}.textContent === 'rg'`),
      await d.evaluate<string>(`${el("plot-label")}.textContent`));
    // the playhead is live and moving (the harness autoplays the 98 frames).
    // PROVE movement by polling for a second, distinct marker position
    // rather than sampling twice across a fixed 700ms and hoping the window
    // caught a step — a strictly stronger claim than the old form.
    const mx1 = await d.evaluate<number>(`Number(${el("plot-marker")}.getAttribute('x1') ?? -1)`);
    await d.waitFor(
      `!${el("plot-marker")}.hasAttribute('hidden') &&
        Number(${el("plot-marker")}.getAttribute('x1') ?? -1) >= 0 &&
        Number(${el("plot-marker")}.getAttribute('x1') ?? -1) !== ${mx1}`, 30000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const mx2 = await d.evaluate<number>(`Number(${el("plot-marker")}.getAttribute('x1') ?? -1)`);
    check("S30: …the playhead marker is live and tracks playback",
      !(await d.evaluate<boolean>(`${el("plot-marker")}.hasAttribute('hidden')`)) && mx1 >= 0 && mx2 !== mx1,
      `marker x1: ${mx1} → ${mx2}`);
    await d.screenshot(`${REPORT}/S30_rg_curve.png`);

    // -- rmsf: a per-point-scalar → color, one undo stroke -----------------------
    await d.evaluate(`void (window.__preRmsf = Float32Array.from(${V}.rep.state.color))`);
    await typeInto("rmsf all");
    // real producer round-trip (the S30 rg rule): poll the color hand-off
    // line rather than a fixed 2000ms that a loaded machine can outrun
    await d.waitFor(
      `[...document.querySelectorAll('#term-log .term-line')]
        .some(l => /^rmsf → colored 3341 points of .* from scalars$/.test(l.textContent))`, 30000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const rfLines = await logLines();
    check("S30: rmsf acknowledges, then reports the color hand-off",
      rfLines.some((l) => l.text === "running rmsf on 3341 points…") &&
        rfLines.some((l) => /^rmsf → colored 3341 points of .* from scalars$/.test(l.text)),
      JSON.stringify(rfLines.slice(-3)));
    const changed = await d.evaluate<number>(`(()=>{
      const c=${V}.rep.state.color, s=window.__preRmsf; let n=0;
      for(let i=0;i<c.length;i++) if(Math.abs(c[i]-s[i])>0.02) n++; return n;
    })()`);
    check("S30: …RMSF recolors the structure (many points change from pristine)",
      changed > 300, `changed color channels=${changed}`);
    await d.screenshot(`${REPORT}/S30_rmsf_color.png`);

    // undo: the viewer's Ctrl+Z ignores INPUT focus, so blur the terminal first
    await d.evaluate(`document.getElementById('term-input').blur()`);
    await d.ctrlZ();
    // the undo is a state write with an async settle — poll for pristine
    await d.waitFor(`(()=>{ const c=${V}.rep.state.color, s=window.__preRmsf;
      for(let i=0;i<c.length;i++) if(Math.abs(c[i]-s[i])>1e-4) return false;
      return true; })()`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    const residual = await d.evaluate<number>(`(()=>{
      const c=${V}.rep.state.color, s=window.__preRmsf; let n=0;
      for(let i=0;i<c.length;i++) if(Math.abs(c[i]-s[i])>1e-4) n++; return n;
    })()`);
    check("S30: …and undoes in ONE stroke — every color channel back to pristine",
      residual === 0, `residual differing channels=${residual}`);
  });
}

// ============ S31: produces: commands — the macro mod, one undo stroke =========
async function S31(): Promise<void> {
  console.log("S31 — produces: commands (macro mod): color_ab runs two colorbonds as ONE undo stroke");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const logLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`);
    const typeInto = async (text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el("term-input")}.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y); await d.insertText(text); await d.key("Enter", "Enter", 13);
    };
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const edgeChanged = (slot: string) => d.evaluate<number>(`(()=>{
      const c=${V}.rep.state.edgeColorA, s=window.${slot}; let n=0;
      for (let i=0;i<c.length;i++) if (Math.abs(c[i]-s[i])>1e-6) n++; return n;
    })()`);

    // listed with produces: commands
    const listing = (await cmd("mods")).message;
    check("S31: color_ab appears in `mods` with produces: commands",
      listing.includes(" color_ab — analysis · commands"), listing);

    await d.evaluate(`void (window.__preE = Float32Array.from(${V}.rep.state.edgeColorA))`);
    const depth0 = await undoDepth();

    // run the macro BARE (a commands mod may ignore target_indices)
    await typeInto("color_ab");
    await sleep(2000);
    const lines = await logLines();
    check("S31: the macro reports one-stroke + per-command outcomes",
      lines.some((l) => /^color_ab → ran 2 commands \(one undo stroke\)/.test(l.text)),
      JSON.stringify(lines.slice(-3)));

    const changed = await edgeChanged("__preE");
    check("S31: both colorbonds took effect (edges recolored)", changed > 100, `changed edge channels=${changed}`);
    check("S31: the whole macro is exactly ONE undo stroke",
      (await undoDepth()) === depth0 + 1, `undo depth ${depth0} → ${await undoDepth()}`);

    // one Ctrl+Z reverses the ENTIRE macro (both colorbonds together)
    await d.evaluate(`document.getElementById('term-input').blur()`);
    await d.ctrlZ();
    await sleep(400);
    check("S31: one Ctrl+Z reverses the entire macro — edges back to pristine",
      (await edgeChanged("__preE")) === 0 && (await undoDepth()) === depth0,
      `residual=${await edgeChanged("__preE")} depth=${await undoDepth()}`);
  }, 1180, 780, "/terminal");
}

// ==================== S32: impostor geometry (increment A) ===================
// Spheres draw the stored size buffer — pixel assertions, run under BOTH depth
// variants (2 = analytic gl_FragDepth, 1 = flat sprite depth; one global dev
// switch). Only the interpenetration check separates them, with opposite
// expected colors; everything else must hold identically on both.
async function S32(): Promise<void> {
  for (const variant of [2, 1] as const) {
    console.log(`S32 — impostor geometry, depth variant ${variant}`);
    await withDriver(async (d) => {
      // pin the displayed frame: autoplay races the boot sleep, so each boot
      // pauses at a DIFFERENT frame — different positions, different probe
      // depths, different projected sphere sizes. Frame 0 makes every pixel
      // expectation deterministic.
      await d.evaluate(`${V}.player.seek(0)`);
      await sleep(400);
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      const redCount = (b64: string) =>
        d.evaluate<number>(`(async () => {
          const app = document.getElementById('app').getBoundingClientRect();
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
            Math.round(app.width), Math.round(app.height) - 60).data;
          let n = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) n++;
          }
          return n;
        })()`);
      /** strict red/blue pixel counts in a 5×5 patch at client (x,y) — the
       * occlusion checks assert PRESENCE/ABSENCE, never majority (a small
       * sphere in front of a big one is a few pixels inside many). */
      const patchCounts = (b64: string, x: number, y: number) =>
        d.evaluate<{ red: number; blue: number }>(`(async () => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(${Math.round(x) - 2}, ${Math.round(y) - 2}, 5, 5).data;
          let red = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) red++;
            if (px[i+2] > px[i] + 60 && px[i+2] > px[i+1] + 60) blue++;
          }
          return { red, blue };
        })()`);
      // EVERY capture first waits for the page to render fresh frames —
      // under desktop load the compositor presents stale frames and a
      // capture then photographs pre-command state (load-immunity rule).
      const snap = async (tag: string): Promise<string> => {
        await d.evaluate(`(async () => {
          for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
        })()`);
        return d.captureB64(`${REPORT}/S32_v${variant}_${tag}.png`);
      };

      // C2: depthWrite pinned EXPLICITLY on all three geometry materials, and
      // the boot config actually selected this variant. Since the alpha split,
      // C2 has TWO halves to pin: the opaque half must still write depth (or
      // solid geometry stops occluding), and the translucent twin must NOT (or
      // faded elements delete whatever is behind them — the view-dependent
      // opacity bug this split exists to kill).
      const mats = await d.evaluate<{
        p: boolean; e: boolean; t: boolean; dv: number;
        tp: boolean; te: boolean; tt: boolean; twins: number;
      }>(
        `(()=>{const m=${V}.geometryMaterials, w=${V}.alphaTwins; return {
          p:m.points.depthWrite, e:m.edges.depthWrite, t:m.traces.depthWrite,
          tp:w.points?.depthWrite, te:w.edges?.depthWrite, tt:w.traces?.depthWrite,
          twins:[w.points,w.edges,w.traces].filter(Boolean).length,
          dv:${V}.depthVariant};})()`);
      check("S32: depthWrite === true on ALL THREE geometry materials (C2)",
        mats.p && mats.e && mats.t, JSON.stringify(mats));
      check("S32: every geometry material HAS a translucent twin (the split is wired)",
        mats.twins === 3, `twins=${mats.twins}`);
      check("S32: depthWrite === false on ALL THREE translucent twins (C2, other half)",
        mats.tp === false && mats.te === false && mats.tt === false,
        JSON.stringify({ tp: mats.tp, te: mats.te, tt: mats.tt }));
      check("S32: the boot config selected this depth variant", mats.dv === variant,
        `dv=${mats.dv}`);
      check("S32: no bbox warning on a bbox-carrying header",
        !(await d.evaluate<string>(`document.getElementById('status').textContent`)).includes("no bbox"));

      // isolate one on-screen point: everything size 0, the probe red at default
      const probe = await d.evaluate<number>(`(()=>{
        const n = ${V}.rep.state.size.length;
        for (let p = 100; p < n; p += 137) {
          const pr = ${V}.debug.projectPoint(p);
          const app = document.getElementById('app').getBoundingClientRect();
          if (pr.front && pr.x > app.left + 40 && pr.x < app.right - 40 &&
              pr.y > app.top + 90 && pr.y < app.bottom - 40) return p;
        }
        return 100;
      })()`);
      await cmd(`colorpoints #${probe} red`);
      await cmd("pointsize all 0");
      await cmd(`pointsize #${probe} 3`);
      await sleep(250);
      const n3 = await redCount(await snap("probe_size3"));
      check("S32: default-size sphere lands near its pre-impostor pixel extent (parity pin)",
        n3 >= 3 && n3 <= 30, `default-size red pixels=${n3}`);

      await cmd(`pointsize #${probe} 9`);
      await sleep(250);
      const n9 = await redCount(await snap("probe_size9"));
      check("S32: a larger stored size covers materially more pixels",
        n9 >= 3 * n3, `size3=${n3} size9=${n9}`);

      // ZERO ⊥ HIDE, now at the pixel level: size 0 draws NOTHING (the old
      // pass left a ~1px min-point-size residue), the point still resolves,
      // and it is still pickable through the real picking path.
      await cmd(`pointsize #${probe} 0`);
      await sleep(250);
      const n0 = await redCount(await snap("probe_size0"));
      check("S32: size 0 covers ZERO pixels", n0 === 0, `red pixels=${n0}`);
      check("S32: the size-0 point still resolves",
        await d.evaluate<number>(`${V}.debug.resolvePoints('#${probe}').length`) === 1);
      const picked = await d.evaluate<{ hit: number; front: boolean }>(`(()=>{
        const pr = ${V}.debug.projectPoint(${probe});
        return { hit: ${V}.debug.pick(pr.x, pr.y), front: pr.front };
      })()`);
      check("S32: the size-0 point is still pickable at its projection",
        picked.front && picked.hit === probe, JSON.stringify(picked));
      const vis = await visibleCount(d);
      check("S32: zero writes never touched visibility", vis === 6000, `visible=${vis}`);

      // occlusion pair: two points projecting within ~3px at different view
      // depths (bucketed search over the current frame).
      const pair = await d.evaluate<{ front: number; back: number; x: number; y: number; dz: number } | null>(`(()=>{
        const n = ${V}.rep.state.size.length;
        const app = document.getElementById('app').getBoundingClientRect();
        const cells = new Map();
        for (let p = 0; p < n; p++) {
          const pr = ${V}.debug.projectPoint(p);
          if (!pr.front) continue;
          if (pr.x < app.left + 60 || pr.x > app.right - 60 ||
              pr.y < app.top + 100 || pr.y > app.bottom - 60) continue;
          const key = Math.round(pr.x / 3) + ':' + Math.round(pr.y / 3);
          const list = cells.get(key) ?? [];
          list.push({ p, ...pr });
          cells.set(key, list);
        }
        for (const list of cells.values()) {
          for (let i = 0; i < list.length; i++) for (let j = 0; j < list.length; j++) {
            const dz = list[j].depth - list[i].depth;
            if (dz > 0.2 && dz < 0.9 && Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < 3) {
              return { front: list[i].p, back: list[j].p, x: list[i].x, y: list[i].y, dz };
            }
          }
        }
        return null;
      })()`);
      check("S32: found an overlapping pair for the occlusion checks", pair !== null,
        JSON.stringify(pair));
      if (pair) {
        // (a) BOTH variants: at equal size, the nearer sphere occludes the
        // farther one where they overlap (C2's behavioral tripwire — if this
        // fails on either variant, depth state broke, not the variant).
        await cmd(`colorpoints #${pair.front} red`);
        await cmd(`colorpoints #${pair.back} blue`);
        await cmd(`pointsize #${pair.front} 15`);
        await cmd(`pointsize #${pair.back} 15`);
        await sleep(250);
        const eq = await patchCounts(await snap("occlusion_equal"), pair.x, pair.y);
        check("S32: nearer sphere occludes the farther at their overlap",
          eq.red > 0 && eq.blue === 0, `${JSON.stringify(eq)} dz=${pair.dz.toFixed(3)}`);

        // (b) the variant-SEPARATING check — interpenetration: a big sphere
        // behind, a small nearer point inside its front bulge. Variant 2
        // (analytic surface depth): the bulge is nearer — the small point is
        // eliminated (red absent). Variant 1 (flat centre depth): the nearer
        // centre wins — the small point punches through (red present).
        // Opposite expectations, same setup — the ONLY assertion the two
        // variants are allowed to differ on.
        await cmd(`pointsize #${pair.back} 40`);
        await cmd(`pointsize #${pair.front} 4`);
        await sleep(250);
        const fp = await d.evaluate<{ x: number; y: number }>(`${V}.debug.projectPoint(${pair.front})`);
        const bulge = await patchCounts(await snap("occlusion_bulge"), fp.x, fp.y);
        if (variant === 2) {
          check("S32(v2): the big sphere's front bulge ELIMINATES the nearer small point",
            bulge.red === 0 && bulge.blue > 0, `${JSON.stringify(bulge)} dz=${pair.dz.toFixed(3)}`);
        } else {
          check("S32(v1): flat centre depth — the nearer small point punches through the bulge",
            bulge.red > 0 && bulge.blue > 0, `${JSON.stringify(bulge)} dz=${pair.dz.toFixed(3)}`);
        }
      }

      // overlays register on the sphere's own pixels and scale with it.
      // The tint BREATHES (1600ms period) and CDP capture latency can
      // outlive the peak window, so single peak-chasing captures are
      // phase-racy — sample across a full period and keep the MAX (which
      // also asserts the pulse actually reaches strength at some phase).
      await cmd("pointsize all 0");
      await cmd(`pointsize #${probe} 12`);
      // the probe is RED from the sizing section — green-tint-over-red only
      // clears the greenish classifier within a sliver of the pulse peak
      // (g−r = a·64 − (1−a)·255·shade). Measure the tint over the base gray,
      // where the margin is a·64 at every shade.
      await cmd(`colorpoints #${probe} #e6e6e6`);
      await d.evaluate(`${V}.refreshPoints(${V}.model.toggleInTarget({level:'point', id:${probe}}))`);
      /** Wait until the page's render loop has DRAWN n more frames — under
       * desktop load the compositor can present frames that are minutes old,
       * and a capture taken then photographs pre-command state. Sampling
       * only after fresh frames makes the pixel checks load-immune (they
       * wait instead of reading stale pixels). */
      const settleFrames = (n = 3) => d.evaluate(`(async () => {
        for (let i = 0; i < ${n}; i++) await new Promise(r => requestAnimationFrame(r));
      })()`);
      await settleFrames();
      // THE PROBE PRIMITIVE (samplePatch, e2e_driver.ts): the breathing tint
      // is a bounded envelope — sampling it through captureB64 put unbounded
      // CDP/compositor/encode hops INSIDE the 1600ms period (the measured
      // bundle-size race, FLAKE_LEDGER.md). The sweep enumerates every
      // RENDERED frame across a full period in-page and reads the patch AT
      // the max-strength frame, so the peak that drew cannot be missed.
      // strength/frames go into every detail string — the tally logs on
      // green runs too.
      const overlayPeak = async (tag: string) => {
        await settleFrames(); // the write must be DRAWN before sampling starts
        const s = await d.samplePatch({
          centerExpr: `${V}.debug.projectPoint(${probe})`,
          half: 15,
          classify: "g > r + 25 && g >= b",
          // >1.5 pulse periods: the peak phase recurs identically every
          // 1600ms, so a longer sweep raises the odds of WITNESSING a peak
          // under starvation without changing what is asserted about it
          sweep: { strengthExpr: `${V}.debug.pulse().sel`, windowMs: 2600, minStrength: 0.6 },
        });
        await d.screenshot(`${REPORT}/S32_v${variant}_${tag}.png`); // evidence only — the in-page count above is the assertion
        return s;
      };
      const probeState = () => d.evaluate<string>(`JSON.stringify({
        sel: ${V}.debug.selCount(),
        inTarget: ${V}.model.targetContains(${probe}),
        size: ${V}.rep.state.size[${probe}],
        vis: ${V}.rep.state.visible[${probe}],
        pulse: Number(${V}.debug.pulse().sel.toFixed(2)),
      })`);
      const big = await overlayPeak("overlay12");
      check("S32: pending overlay registers on the sphere's own pixels",
        big.count > 20 && big.strength > 0.6,
        `green@sphere=${big.count} peak=${big.strength.toFixed(2)} seen=${big.seen.toFixed(2)} frames=${big.frames} state=${await probeState()}`);
      await cmd(`pointsize #${probe} 4`);
      const small = await overlayPeak("overlay4");
      check("S32: the overlay SCALES with the stored size (silhouette-matched)",
        small.count > 0 && small.strength > 0.6 && big.count > 2 * small.count,
        `size12=${big.count} size4=${small.count} peak=${small.strength.toFixed(2)} seen=${small.seen.toFixed(2)} frames=${small.frames} state=${await probeState()}`);
      await cmd(`pointsize #${probe} 0`);
      await sleep(150);
      // alpha is monotone in strength, so zero at the OBSERVED PEAK frame
      // dominates the old max-over-6-phases form — but only if a peak was
      // actually witnessed, hence the strength gate on a ZERO assertion too.
      const gone = await overlayPeak("overlay0");
      check("S32: a size-0 point shows NO overlay, ever",
        gone.count === 0 && gone.strength > 0.6,
        `green=${gone.count} peak=${gone.strength.toFixed(2)} seen=${gone.seen.toFixed(2)} frames=${gone.frames}`);

      // focus flash rides the same silhouette. It is a ONE-SHOT 900ms pulse —
      // the family's founding member (the chronic yellow@sphere=0, ~9%
      // rolling and bundle-size-coupled). THE PROBE PRIMITIVE replaces the
      // confirm-then-capture race entirely: the sweep watches every rendered
      // frame for 1100ms and reads the patch AT the max-flash frame, in the
      // same task that observed its uniform. Each attempt still re-triggers
      // the pulse (the camera is at the target after the first tween, so
      // re-focusing only restarts it) purely for starved-window retries.
      await cmd(`pointsize #${probe} 12`);
      // deselect the probe first: the flash BLENDS 50% toward the selection
      // mint on selected points, and mint-blend over the gray base fails the
      // yellow classifier by construction — this check asserts silhouette
      // registration, not the blend.
      await d.evaluate(`${V}.refreshPoints(${V}.model.toggleInTarget({level:'point', id:${probe}}))`);
      // DIFFERENTIAL, not absolute: the deliberate-break proof exposed a
      // pre-existing specificity gap — under variant 1's flat depth, a warm
      // trace tube crossing the probe's face contributes ~149 classifier
      // hits of its own (deterministic; see S32_v1_flash.png), so "yellow
      // pixels present at crest" was satisfiable WITHOUT the flash. Baseline
      // the patch at the SAME pose with the flash fully faded, then assert
      // the crest ADDS yellow over it — the tube subtracts out exactly.
      const flashClassify = "r > 150 && g > 130 && r > b + 30 && g > b + 20";
      await d.evaluate(`${V}.focusPoints([${probe}])`);
      await sleep(420); // the one real camera tween
      await d.waitFor(`${V}.debug.pulse().flash === 0`, 6000)
        .catch(() => { /* fade never observed — the baseline read still bounds it */ });
      const flashBase = await d.samplePatch({
        centerExpr: `${V}.debug.projectPoint(${probe})`, half: 15, classify: flashClassify,
      });
      let flash = { count: -1, strength: -1, frames: 0, seen: -1 };
      let flashAttempts = 0;
      for (let attempt = 0; attempt < 6 && flash.count <= flashBase.count + 10; attempt++) {
        flashAttempts = attempt + 1;
        await d.evaluate(`${V}.focusPoints([${probe}])`); // camera already at target — re-triggers the pulse only
        const s = await d.samplePatch({
          centerExpr: `${V}.debug.projectPoint(${probe})`,
          half: 15,
          classify: flashClassify,
          sweep: { strengthExpr: `${V}.debug.pulse().flash`, windowMs: 1100, minStrength: 0.5 },
        });
        if (s.count > flash.count) flash = s;
      }
      await d.screenshot(`${REPORT}/S32_v${variant}_flash.png`); // evidence only
      // strength > 0.5 additionally proves the counted frame was a true
      // flash frame (the uniform only rises when one rendered) — a gate the
      // old probe implied but never asserted on the counted frame itself.
      check("S32: focus flash ADDS yellow on the sphere's pixels (over the same-pose baseline)",
        flash.count > flashBase.count + 10 && flash.strength > 0.5,
        `yellow@sphere=${flash.count} base=${flashBase.count} peakFlash=${flash.strength.toFixed(2)} ` +
          `seen=${flash.seen.toFixed(2)} frames=${flash.frames} attempts=${flashAttempts}`);

      // undo: byte-exact buffers AND pixel-exact scene (red pixels return to 0)
      const depth = await d.evaluate<number>(`${V}.model.undoDepth`);
      for (let i = 0; i < depth; i++) await d.ctrlZ(); // the real undo path
      await sleep(300);
      const pristineSize = await d.evaluate<boolean>(
        `${V}.rep.state.size.every(v => v === 3)`);
      const pristineColor = await d.evaluate<boolean>(
        `(()=>{const c=${V}.rep.state.color; const f=Math.fround(0.9); return c.every(v => v === f);})()`);
      const redFinal = await redCount(await snap("unwound"));
      check("S32: full unwind restores pristine buffers AND pristine pixels",
        pristineSize && pristineColor && redFinal === 0,
        `size=${pristineSize} color=${pristineColor} red=${redFinal}`);
    }, 1180, 780, `/?depthVariant=${variant}`);
  }
}

// ==================== S33: null-bbox fallback is LOUD (C1) ====================
async function S33(): Promise<void> {
  console.log("S33 — null-bbox scene scale: loud warning, parity still self-corrects");
  portBase += 2;
  const d = new E2EDriver({
    bridgePort: portBase, cdpPort: portBase + 300, width: 1180, height: 780,
    producerArgs: ["--n-points", "6000", "--n-frames", "150", "--strip-bbox"],
  });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(3200);
    await pause(d);
    await d.evaluate(`${V}.player.seek(0)`); // deterministic frame-0 positions
    await sleep(400);
    const status = await d.evaluate<string>(`document.getElementById('status').textContent`);
    check("S33: the status line carries the no-bbox warning for the whole session",
      status.includes("no bbox") && /misscal/i.test(status), status);
    check("S33: the seam confirms the fallback branch",
      await d.evaluate<boolean>(`${V}.sizing.bboxFallback === true`));

    // parity self-corrects on the fallback: k and the camera share the
    // default box, so a default-size point still lands in the same pixel
    // band even though S (20) is wrong for this data (~32.7).
    const cmd = (text: string) =>
      d.evaluate<{ status: string }>(`${V}.command(${JSON.stringify(text)})`);
    const probe = await d.evaluate<number>(`(()=>{
      const d0 = ${V}.sizing.sceneS * 1.6;
      const n = ${V}.rep.state.size.length;
      const app = document.getElementById('app').getBoundingClientRect();
      let best = 100, err = Infinity;
      for (let p = 0; p < n; p += 7) {
        const pr = ${V}.debug.projectPoint(p);
        if (!pr.front) continue;
        if (pr.x < app.left + 40 || pr.x > app.right - 40 ||
            pr.y < app.top + 90 || pr.y > app.bottom - 40) continue;
        const e = Math.abs(pr.depth - d0);
        if (e < err) { err = e; best = p; }
      }
      return best;
    })()`);
    await cmd(`colorpoints #${probe} red`);
    await cmd("pointsize all 0");
    await cmd(`pointsize #${probe} 3`);
    await sleep(250);
    await d.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
    })()`); // load-immunity: capture only after fresh frames
    const b64 = await d.captureB64(`${REPORT}/S33_fallback_parity.png`);
    const red = await d.evaluate<number>(`(async () => {
      const app = document.getElementById('app').getBoundingClientRect();
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
        Math.round(app.width), Math.round(app.height) - 60).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) n++;
      }
      return n;
    })()`);
    check("S33: a default-size point at the framed distance still lands in the parity band",
      red >= 3 && red <= 30, `red pixels=${red}`);
  } finally {
    await d.dispose();
  }
}

// ==================== S34: edge tubes (increment B) ==========================
// The headline of the impostor brief: `bondsize` moves PIXELS. Instanced tube
// quads read the existing edgeSize/edgeColorA+B/edgeOpacity buffers; run under
// both depth variants — only the junction-interpenetration check separates
// them, with expectations derived from measured depths.
async function S34(): Promise<void> {
  for (const variant of [2, 1] as const) {
    console.log(`S34 — edge tubes, depth variant ${variant}`);
    await withDriver(async (d) => {
      // deterministic frame-0 positions (see S32's note); S34's own seek
      // checks below re-seek and return here
      await d.evaluate(`${V}.player.seek(0)`);
      await sleep(400);
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      // same load-immunity rule as S32: never capture before fresh frames
      const snap = async (tag: string): Promise<string> => {
        await d.evaluate(`(async () => {
          for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
        })()`);
        return d.captureB64(`${REPORT}/S34_v${variant}_${tag}.png`);
      };
      /** strict per-color pixel counts over the canvas (red / green / deep-blue;
       * the +80 blue threshold keeps the base edge look 0x5a7a9a out). */
      const counts = (b64: string) =>
        d.evaluate<{ red: number; green: number; blue: number }>(`(async () => {
          const app = document.getElementById('app').getBoundingClientRect();
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
            Math.round(app.width), Math.round(app.height) - 60).data;
          let red = 0, green = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) red++;
            if (px[i+1] > px[i] + 50 && px[i+1] > px[i+2] + 50) green++;
            if (px[i+2] > px[i] + 80 && px[i+2] > px[i+1] + 80) blue++;
          }
          return { red, green, blue };
        })()`);

      // fade the points so edge pixels dominate the classifiers
      await cmd("pointopacity all 0");
      await cmd("colorbonds alpha.group-0.subgroup-0 red");
      await cmd("colorbonds beta.group-0.subgroup-1 blue");
      await sleep(250);
      const thin = await counts(await snap("thin"));
      check("S34: default-width tubes draw (colored edges visible at width 1)",
        thin.red > 20 && thin.blue > 20, JSON.stringify(thin));

      // THE HEADLINE: bondsize moves pixels — on the addressed edges only.
      // (The growth saturates well below width×: the subgroup's edge tangle
      // fills its own screen area and the fat tubes overlap — so the check
      // is a decisive increase, not a linear one.)
      await cmd("bondsize alpha.group-0.subgroup-0 6");
      await sleep(250);
      const fat = await counts(await snap("fat"));
      check("S34: bondsize <target> 6 — a measurable pixel increase on the addressed edges",
        fat.red >= 1.5 * thin.red && fat.red - thin.red > 500, `red ${thin.red} → ${fat.red}`);
      check("S34: …and none elsewhere (the other subgroup's edges did not grow)",
        fat.blue <= thin.blue * 1.15 + 5, `blue ${thin.blue} → ${fat.blue}`);

      // width 0 renders nothing; the buffer state is intact and undoable
      await cmd("bondsize alpha.group-0.subgroup-0 0");
      await sleep(250);
      const zero = await counts(await snap("zero"));
      check("S34: bondsize 0 renders NOTHING on the addressed edges",
        zero.red === 0, `red=${zero.red}`);
      await d.ctrlZ(); // back to width 6
      await sleep(250);
      const unzero = await counts(await snap("undo_width"));
      check("S34: one Ctrl+Z returns the tubes to their prior width",
        unzero.red >= 0.8 * fat.red, `red=${unzero.red} vs fat=${fat.red}`);

      // frame-flip integrity: fat tubes follow streamed positions
      await d.evaluate(`${V}.player.seek(75)`);
      await sleep(500);
      const flipped = await counts(await snap("frame75"));
      check("S34: tubes track the displayed frame (seek keeps them drawn)",
        flipped.red >= 0.5 * fat.red, `red@frame75=${flipped.red} vs fat=${fat.red}`);
      await d.evaluate(`${V}.player.seek(0)`);
      await sleep(500);

      // visibility: hidden endpoints collapse their edges, show restores
      await cmd("hide alpha");
      await sleep(250);
      const hidden = await counts(await snap("hidden"));
      check("S34: hiding the endpoints hides their tubes (hidden wins)",
        hidden.red === 0, `red=${hidden.red}`);
      await cmd("show alpha");
      await sleep(250);
      const shown = await counts(await snap("shown"));
      check("S34: show restores the tubes",
        shown.red >= 0.8 * fat.red, `red=${shown.red} vs fat=${fat.red}`);

      // ---- the junction (A5): a sphere with an incident tube ----
      // pick a probe point whose chain neighbor is NEARER the camera, so the
      // variant expectations are determined, not assumed.
      await cmd("pointopacity all 1");
      const jct = await d.evaluate<{ p: number; n: number; dz: number } | null>(`(()=>{
        const edges = ${V}.edges;
        const inc = new Map();
        for (const [a, b] of edges) {
          inc.set(a, (inc.get(a) ?? []).concat([b]));
          inc.set(b, (inc.get(b) ?? []).concat([a]));
        }
        for (let p = 120; p < 600; p += 1) {
          const nbrs = inc.get(p) ?? [];
          if (nbrs.length !== 2) continue;
          const pr = ${V}.debug.projectPoint(p);
          if (!pr.front) continue;
          for (const n of nbrs) {
            const nr = ${V}.debug.projectPoint(n);
            const dz = pr.depth - nr.depth; // >0: neighbor is NEARER
            if (nr.front && dz > 0.1) return { p, n, dz };
          }
        }
        return null;
      })()`);
      check("S34: found a junction probe with a nearer neighbor", jct !== null, JSON.stringify(jct));
      if (jct) {
        // isolate the junction: every OTHER point collapses to size 0 and
        // every other edge fades to alpha 0 (invisible-but-present — the S19
        // staging trick), because at this zoom EVERY world-anchored default
        // tube is ~24px wide and the scene is a forest that buries the probe
        await cmd("pointsize all 0");
        await cmd("bondopacity all 0");
        await cmd(`colorpoints #${jct.p} red`);
        await cmd(`pointsize #${jct.p} 6`);
        await cmd(`colorbondsof #${jct.p} green`);
        await cmd(`bondopacityof #${jct.p} 1`);
        await cmd(`bondsizeof #${jct.p} 2`);
        await d.evaluate(`${V}.focusPoints([${jct.p}])`);
        await sleep(900); // tween + flash mostly done
        await sleep(700); // flash fully out — pure geometry pixels
        const b64 = await snap("junction");
        const walk = await d.evaluate<{ seq: string[]; sphereR: number; probe: string }>(`(async () => {
          const pr = ${V}.debug.projectPoint(${jct.p});
          const nr = ${V}.debug.projectPoint(${jct.n});
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const classify = (x, y) => {
            const px = g.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
            let r = 0, gr = 0, bg = 0;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) r++;
              else if (px[i+1] > px[i] + 50 && px[i+1] > px[i+2] + 50) gr++;
              else if (px[i] < 55 && px[i+1] < 55 && px[i+2] < 55) bg++;
            }
            if (r > 4) return 'red';
            if (gr > 4) return 'green';
            if (bg > 6) return 'bg';
            return 'other';
          };
          // sphere projected radius in px (world radius 6k at the point's depth)
          const k = ${V}.sizing.worldPerSize;
          const sphereR = (6 * k) * ${V}.sizing.pxPerWorld() / pr.depth;
          const dir = { x: nr.x - pr.x, y: nr.y - pr.y };
          const len = Math.hypot(dir.x, dir.y);
          dir.x /= len; dir.y /= len;
          // the variant probe: ON the sphere face, 15% of its radius out
          const probe = classify(pr.x + dir.x * sphereR * 0.15, pr.y + dir.y * sphereR * 0.15);
          // the gap walk: centre → 2.5 sphere radii out, every 3px
          const seq = [];
          for (let t = 0; t <= sphereR * 2.5; t += 3) {
            seq.push(classify(pr.x + dir.x * t, pr.y + dir.y * t));
          }
          return { seq, sphereR, probe };
        })()`);
        const seq = walk.seq;
        const firstGreen = seq.indexOf("green");
        const lastRed = seq.lastIndexOf("red", firstGreen < 0 ? seq.length : firstGreen);
        const gapBg = firstGreen > 0 && lastRed >= 0
          ? seq.slice(lastRed + 1, firstGreen).filter((s) => s === "bg").length
          : 999;
        check("S34: the junction has sphere then tube with NO background gap (both variants)",
          seq[0] === "red" && firstGreen > 0 && gapBg === 0,
          `seq=${seq.join(",")} sphereR=${walk.sphereR.toFixed(1)}`);
        // B′: the analytic trim ends the tube ON the sphere's surface BY
        // GEOMETRY, so no tube pixel reaches the sphere's near face under
        // EITHER variant (the pre-trim v1 "punches through" expectation is
        // retired — that behaviour no longer exists to assert).
        check("S34(B′): no tube pixel on the sphere's near face — geometry, both variants",
          walk.probe === "red", `probe=${walk.probe} dz=${jct.dz.toFixed(3)}`);

        // B′: EQUAL radii — d = 0, tube runs centre-to-centre, the sphere
        // caps it exactly: no background pixel anywhere along the seam.
        await cmd(`bondsizeof #${jct.p} 6`);
        await sleep(250);
        const eqb64 = await snap("junction_equal");
        const eqSeq = await d.evaluate<string[]>(`(async () => {
          const pr = ${V}.debug.projectPoint(${jct.p});
          const nr = ${V}.debug.projectPoint(${jct.n});
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${eqb64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const dir = { x: nr.x - pr.x, y: nr.y - pr.y };
          const len = Math.hypot(dir.x, dir.y);
          dir.x /= len; dir.y /= len;
          const k = ${V}.sizing.worldPerSize;
          const rPx = (6 * k) * ${V}.sizing.pxPerWorld() / pr.depth;
          const seq = [];
          for (let t = 0; t <= rPx * 2.2; t += 3) {
            const px = g.getImageData(Math.round(pr.x + dir.x * t) - 1, Math.round(pr.y + dir.y * t) - 1, 3, 3).data;
            let lit = 0;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i] > 55 || px[i+1] > 55 || px[i+2] > 55) lit++;
            }
            seq.push(lit > 6 ? "lit" : "bg");
          }
          return seq;
        })()`);
        check("S34(B′): equal radii — the seam is sealed (no background along the axis)",
          eqSeq.every((s) => s === "lit"), `seq=${eqSeq.join(",")}`);

        // B′: an EXPOSED end (size-0 endpoint) is capped — the tube end
        // reads as solid right through and past the endpoint's centre.
        await cmd(`bondsizeof #${jct.p} 2`);
        await cmd(`pointsize #${jct.p} 0`);
        await sleep(250);
        const capB64 = await snap("junction_cap");
        const cap = await d.evaluate<{ atCenter: string; pastCenter: string }>(`(async () => {
          const pr = ${V}.debug.projectPoint(${jct.p});
          const nr = ${V}.debug.projectPoint(${jct.n});
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${capB64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const classify = (x, y) => {
            const px = g.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
            let gr = 0;
            for (let i = 0; i < px.length; i += 4) {
              if (px[i+1] > px[i] + 50 && px[i+1] > px[i+2] + 50) gr++;
            }
            return gr > 4 ? "green" : "not-green";
          };
          // walk AWAY from the neighbour: past the naked endpoint's centre
          const dir = { x: pr.x - nr.x, y: pr.y - nr.y };
          const len = Math.hypot(dir.x, dir.y);
          dir.x /= len; dir.y /= len;
          const k = ${V}.sizing.worldPerSize;
          const rPx = (2 * k) * ${V}.sizing.pxPerWorld() / pr.depth;
          return {
            atCenter: classify(pr.x, pr.y),
            pastCenter: classify(pr.x + dir.x * rPx * 0.5, pr.y + dir.y * rPx * 0.5),
          };
        })()`);
        check("S34(B′): a size-0 endpoint leaves no hollow end — the cap reads solid",
          cap.atCenter === "green" && cap.pastCenter === "green", JSON.stringify(cap));

        // B′ cadence (invariant 2): a frame flip re-uploads endpoints but
        // NEVER the junction end-sizes; a pointsize write bumps them.
        const v0 = await d.evaluate<{ start: number; sizeA: number; sizeB: number }>(
          `${V}.edgeAttrVersions()`);
        await d.evaluate(`${V}.player.seek(40)`);
        await sleep(400);
        await d.evaluate(`${V}.player.seek(0)`);
        await sleep(400);
        const v1c = await d.evaluate<{ start: number; sizeA: number; sizeB: number }>(
          `${V}.edgeAttrVersions()`);
        await cmd(`pointsize #${jct.p} 3`);
        await sleep(100);
        const v2c = await d.evaluate<{ start: number; sizeA: number; sizeB: number }>(
          `${V}.edgeAttrVersions()`);
        check("S34(B′): frame flips re-upload endpoints, NEVER the end-sizes (cadence)",
          v1c.start > v0.start && v1c.sizeA === v0.sizeA && v1c.sizeB === v0.sizeB,
          JSON.stringify({ v0, v1c }));
        check("S34(B′): a pointsize write DOES bump the end-sizes",
          v2c.sizeA > v1c.sizeA && v2c.sizeB > v1c.sizeB, JSON.stringify({ v1c, v2c }));
      }

      // full unwind: pristine buffers AND pristine pixels
      const depth = await d.evaluate<number>(`${V}.model.undoDepth`);
      for (let i = 0; i < depth; i++) await d.ctrlZ();
      await sleep(300);
      const pristine = await d.evaluate<{ size: boolean; color: boolean }>(`(()=>{
        const es = ${V}.rep.state.edgeSize;
        const f = [Math.fround(0x5a/255), Math.fround(0x7a/255), Math.fround(0x9a/255)];
        let size = true, color = true;
        for (let e = 0; e < es.length; e++) if (es[e] !== 1) { size = false; break; }
        for (const ec of [${V}.rep.state.edgeColorA, ${V}.rep.state.edgeColorB]) {
          for (let i = 0; i < ec.length; i++) if (ec[i] !== f[i % 3]) { color = false; break; }
        }
        return { size, color };
      })()`);
      const final = await counts(await snap("unwound"));
      check("S34: full unwind restores pristine edge buffers AND pixels",
        pristine.size && pristine.color && final.red === 0 && final.blue === 0,
        `${JSON.stringify(pristine)} ${JSON.stringify(final)}`);
    }, 1180, 780, `/?depthVariant=${variant}`);
  }
}

// ============ S36: trace tubes — traceSize finally draws ======================
// The path-tube generator: each path segment a tapered tube (per-end radius/
// RGBA from the trace buffers), each path vertex a joint sphere of the tube's
// end radius. The HEADLINE is the assertion traceSize could never pass before:
// writing it moves pixels, scoped to the addressed vertices. Run once per
// depth variant (the switch is global). Cadence is asserted via the
// traceAttrVersions seam: a flip bumps endpoints only; a width write bumps
// radii only — the silent failure class this scenario exists to guard.
async function S36(): Promise<void> {
  for (const variant of [2, 1] as const) {
    console.log(`S36 — trace tubes, depth variant ${variant}`);
    await withDriver(async (d) => {
      // deterministic frame-0 positions (see S32's note)
      await d.evaluate(`${V}.player.seek(0)`);
      await sleep(400);
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      // same load-immunity rule as S32/S34: never capture before fresh frames
      const snap = async (tag: string): Promise<string> => {
        await d.evaluate(`(async () => {
          for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
        })()`);
        return d.captureB64(`${REPORT}/S36_v${variant}_${tag}.png`);
      };
      // strict per-color pixel counts over the canvas (S34's classifiers —
      // gradient midzones between red and blue vertices count as neither)
      const counts = (b64: string) =>
        d.evaluate<{ red: number; blue: number }>(`(async () => {
          const app = document.getElementById('app').getBoundingClientRect();
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
            Math.round(app.width), Math.round(app.height) - 60).data;
          let red = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) red++;
            if (px[i+2] > px[i] + 80 && px[i+2] > px[i+1] + 80) blue++;
          }
          return { red, blue };
        })()`);

      // occlusion isolation: fade points and edges to LITERAL zero (opacity ⊥
      // hide — everything still resolves), so trace pixels own the canvas
      await cmd("pointopacity all 0");
      await cmd("bondopacity all 0");
      // two DISJOINT vertex sets: the categories' subgroups interleave along
      // the path, so red and blue vertices alternate with gradient segments
      // between them — the classifiers count only the pure ends
      await cmd("colortrace alpha red");
      await cmd("colortrace beta blue");
      await sleep(250);
      const thin = await counts(await snap("thin"));
      check("S36: default-width tubes draw (colored trace visible at width 1)",
        thin.red > 20 && thin.blue > 20, JSON.stringify(thin));

      // THE HEADLINE — the assertion traceSize has never been able to pass:
      // writing it grows the addressed vertices' pixels...
      await d.evaluate(`void (window.__tsz = Float32Array.from(${V}.rep.state.traceSize))`);
      await cmd("tracesize alpha 5");
      await sleep(250);
      const fat = await counts(await snap("fat"));
      check("S36: tracesize <target> 5 — the stored width finally MOVES PIXELS",
        fat.red >= 1.5 * thin.red && fat.red - thin.red > 300, `red ${thin.red} → ${fat.red}`);
      // The write is SCOPED at the state level: exactly the target's active
      // vertices changed, every other slot byte-flat (the honest scoping
      // claim). Pixels near the OTHER category's vertices legitimately grow a
      // little: a segment shared between a widened and a thin vertex TAPERS
      // (per-end radius interpolation — the width twin of the pinned color
      // gradient), so the thin end widens partway along. Bound it, and demand
      // it stays far below the addressed growth.
      const scope = await d.evaluate<{ match: boolean; changed: number }>(`(()=>{
        const v = ${V}; const ts = v.rep.state.traceSize; const s = window.__tsz;
        const active = new Set(v.debug.resolvePoints("alpha").map((p) => v.hierarchy.subgroupOfPoint(p)));
        let changed = 0; let match = true;
        for (let i = 0; i < ts.length; i++) {
          const wrote = ts[i] !== s[i];
          if (wrote) changed++;
          if (wrote !== active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]))) match = false;
        }
        return { match, changed };
      })()`);
      check("S36: …the write is SCOPED — exactly the target's vertex slots changed, others byte-flat",
        scope.match && scope.changed === 4, JSON.stringify(scope));
      check("S36: …the neighbor category's pixels grow only by the shared segments' taper (bounded, ≪ the addressed growth)",
        fat.blue <= thin.blue * 1.6 + 5 && (fat.blue - thin.blue) * 4 < (fat.red - thin.red),
        `blue ${thin.blue} → ${fat.blue}; red ${thin.red} → ${fat.red}`);

      // width 0 renders NOTHING — tubes and joints both — while the points
      // still resolve (size ⊥ hide, exactly the buffer's existing semantics)
      await cmd("tracesize all 0");
      await sleep(250);
      const zero = await counts(await snap("zero"));
      const resolved = await d.evaluate<number>(`${V}.debug.resolvePoints("alpha").length`);
      check("S36: tracesize 0 renders NOTHING (tubes and joint spheres alike)",
        zero.red === 0 && zero.blue === 0, JSON.stringify(zero));
      check("S36: …while the vertices' points still resolve (size ⊥ hide)",
        resolved === 400, `resolved=${resolved}`);
      await d.ctrlZ(); // back to alpha 5 / beta 1
      await sleep(250);
      const undone = await counts(await snap("undo_width"));
      check("S36: one Ctrl+Z restores the prior widths (fat red AND thin blue)",
        undone.red >= 0.8 * fat.red && undone.blue >= 0.5 * thin.blue,
        `red=${undone.red} vs ${fat.red}; blue=${undone.blue} vs ${thin.blue}`);

      // frame-flip integrity: tubes follow streamed positions
      await d.evaluate(`${V}.player.seek(75)`);
      await sleep(500);
      const flipped = await counts(await snap("frame75"));
      check("S36: tubes track the displayed frame (seek keeps them drawn)",
        flipped.red >= 0.5 * fat.red, `red@frame75=${flipped.red} vs fat=${fat.red}`);
      await d.evaluate(`${V}.player.seek(0)`);
      await sleep(500);

      // visibility: hiding the vertices' points collapses their segments AND
      // their joints (no floating joint balls); show restores
      await cmd("hide alpha");
      await sleep(250);
      const hidden = await counts(await snap("hidden"));
      check("S36: hiding the vertices hides their tubes and joints (hidden wins)",
        hidden.red === 0, `red=${hidden.red}`);
      await cmd("show alpha");
      await sleep(250);
      const shown = await counts(await snap("shown"));
      check("S36: show restores the tubes",
        shown.red >= 0.8 * fat.red, `red=${shown.red} vs fat=${fat.red}`);

      // ---- THE CADENCE ASSERTION (the silent class this brief guards) ----
      // playback is paused; a seek causes exactly frame flips, a width write
      // causes exactly a radius upload — the two must never cross.
      const v0 = await d.evaluate<{ start: number; radius: number; color: number }>(
        `${V}.traceAttrVersions()`);
      await d.evaluate(`${V}.player.seek(30)`);
      await sleep(400);
      const v1 = await d.evaluate<{ start: number; radius: number; color: number }>(
        `${V}.traceAttrVersions()`);
      check("S36: a frame flip re-uploads ONLY the segment endpoints",
        v1.start > v0.start && v1.radius === v0.radius && v1.color === v0.color,
        JSON.stringify({ v0, v1 }));
      await cmd("tracesize gamma 2");
      await sleep(150);
      const v2 = await d.evaluate<{ start: number; radius: number; color: number }>(
        `${V}.traceAttrVersions()`);
      check("S36: a width write re-uploads ONLY the radii (never rides the flip loop)",
        v2.radius > v1.radius && v2.start === v1.start && v2.color === v1.color,
        JSON.stringify({ v1, v2 }));

      // full unwind: pristine buffers AND pristine pixels
      const depth = await d.evaluate<number>(`${V}.model.undoDepth`);
      for (let i = 0; i < depth; i++) await d.ctrlZ();
      await sleep(400);
      const pristine = await counts(await snap("pristine"));
      const buffersPristine = await d.evaluate<boolean>(`(()=>{
        const s = ${V}.rep.state;
        for (let v = 0; v < s.traceSize.length; v++) {
          if (s.traceSize[v] !== 1 || s.traceOpacity[v] !== 1) return false;
        }
        return true;
      })()`);
      check("S36: full unwind restores pristine trace buffers AND pixels",
        buffersPristine && pristine.red === 0 && pristine.blue === 0,
        `buffers=${buffersPristine} ${JSON.stringify(pristine)}`);
    }, 1180, 780, `/?depthVariant=${variant}`);
  }
}

// ====== S35: the code that RUNS is the code that was APPROVED ================
// The gated write_mod tool previews a mod's FULL source to the human, who
// approves it. A re-push under an existing name must therefore REPLACE the code
// the viewer runs — otherwise the human approves version B and version A
// executes, which is a lie told by the approval gate, not a caching annoyance.
//
// `modsLoaded` is dispatched here exactly as the host dispatches it after a
// write_mod save (bridge.ts mirrors the same push on viewerInfo), so this drives
// the real installation path — no test-only seam.
async function S35(): Promise<void> {
  console.log("S35 — a re-pushed mod runs its NEW code (the approval gate's one sentence)");
  const modFile = (code: string) => ({
    kind: "analysis", name: "zz_over", produces: "commands",
    origin: "workspace", description: "harness-only: the overwrite fixture", code,
  });
  // Two versions of ONE mod, distinguishable by what they paint. Neither needs a
  // trajectory (a commands mod may ignore target_indices), so both run on the
  // synthetic source.
  const versionA = modFile('def compute(data, target_indices):\n    return ["colorpoints all red"]\n');
  const versionB = modFile('def compute(data, target_indices):\n    return ["colorpoints all blue"]\n');

  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const logLines = () =>
      d.evaluate<{ cls: string; text: string }[]>(
        `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`);
    const typeInto = async (text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el("term-input")}.getBoundingClientRect(); return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y); await d.insertText(text); await d.key("Enter", "Enter", 13);
    };
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    // What the points are actually painted — the only evidence that separates
    // version A from version B. Base look is #e6e6e6, neither red nor blue.
    const painted = () => d.evaluate<{ red: number; blue: number }>(`(()=>{
      const c=${V}.rep.state.color; let red=0, blue=0;
      for (let i=0;i<c.length;i+=3) {
        if (c[i]>0.9 && c[i+1]<0.1 && c[i+2]<0.1) red++;
        else if (c[i]<0.1 && c[i+1]<0.1 && c[i+2]>0.9) blue++;
      }
      return {red, blue};
    })()`);
    // The host's push, verbatim: {type:"modsLoaded", mods:[…]} into the page.
    const push = async (mods: unknown[]): Promise<void> => {
      await d.evaluate(`window.dispatchEvent(new MessageEvent("message", { data: ${
        JSON.stringify({ type: "modsLoaded", mods })} }))`);
      await sleep(150);
    };

    // -- version A: written, registered, and it paints RED ---------------------
    await push([versionA]);
    check("S35: the freshly pushed mod registers and lists",
      (await cmd("mods")).message.includes(" zz_over — analysis · commands"));
    const depth0 = await undoDepth();
    await typeInto("zz_over");
    await sleep(2000);
    let px = await painted();
    check("S35: version A runs — every point RED", px.red === 6000 && px.blue === 0, JSON.stringify(px));

    // -- version B: re-pushed under the SAME name, WITHOUT deleting it ---------
    // This is the exact sequence the assistant performs on an overwrite:
    // write_mod(name, newCode) → the host saves + re-pushes. No delete_mod.
    await push([versionB]);
    await typeInto("zz_over");
    await sleep(2000);
    px = await painted();
    check("S35: THE HEADLINE — the re-pushed mod runs version B (BLUE), not the stale version A",
      px.blue === 6000 && px.red === 0, JSON.stringify(px));

    // §3.4 — the re-registered handler is still exactly one undo stroke.
    const depth1 = await undoDepth();
    check("S35: each macro run is still ONE undo stroke after re-registration",
      depth1 === depth0 + 2, `undo depth ${depth0} → ${depth1} over two runs`);
    await d.evaluate(`${el("term-input")}.blur()`);
    await d.ctrlZ();
    await sleep(400);
    px = await painted();
    check("S35: one Ctrl+Z reverses the whole version-B macro — back to version A's red",
      px.red === 6000 && px.blue === 0 && (await undoDepth()) === depth0 + 1, JSON.stringify(px));

    // -- §3.3 — the built-in protection the guard exists for SURVIVES ----------
    // A mod file named after a built-in must still be refused, loudly, and the
    // built-in must still work. This is what §2.1 is most likely to break.
    await push([{ ...modFile('def compute(data, target_indices):\n    return ["colorpoints all red"]\n'), name: "rainbow" }]);
    const lines = await logLines();
    check("S35: a mod named after a BUILT-IN is still refused, naming the reason",
      lines.some((l) => /^mod "rainbow" skipped — .*built-in/.test(l.text)),
      JSON.stringify(lines.slice(-2)));
    const rb = await cmd("rainbow all");
    check("S35: …and the built-in still works — it was never overwritten",
      rb.status === "ok" && rb.message === "colored 6000 points rainbow", JSON.stringify(rb));
  }, 1180, 780, "/terminal");
}

// ============ S37: channel bindings — static semantics (C-2) ==================
// bind/unbind/bindings + the ruled LWW-clear and undo composition, all BEFORE
// the live link exists (the binding bakes once; nothing re-derives on flip).
// The claims here are about state, coverage, and stroke composition, so the
// proofs are buffer- and registry-level through the seam; the ANIMATED pixel
// claims belong to the live-link scenario (C-3), not here.
async function S37(): Promise<void> {
  console.log("S37 — channel bindings: bind / LWW-clear / undo, static semantics");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const statusLine = () => d.evaluate<string>(`document.getElementById('status').textContent`);
    const changedVs = (snap: string, buf: string) => d.evaluate<number>(`(()=>{
      const c=${V}.rep.state.${buf}, s=window.${snap}; let n=0;
      for (let i=0;i<c.length;i++) if (Math.abs(c[i]-s[i])>1e-6) n++; return n;
    })()`);

    await d.evaluate(`void (window.__preC = Float32Array.from(${V}.rep.state.color))`);
    await d.evaluate(`void (window.__preS = Float32Array.from(${V}.rep.state.size))`);
    const depth0 = await undoDepth();

    // -- the gate refuses loudly, and a refusal leaves NOTHING behind ----------
    const noRange = await cmd("bind alpha energy color");
    check("S37: a partial declaration without an explicit range is refused",
      noRange.status === "error" && /does not declare a full min\/max range/.test(noRange.message),
      JSON.stringify(noRange));
    // (orientation is a REAL axis since O-1 — its acceptance and its own
    // refusal matrix live in S39; here we keep a width refusal so this
    // block still proves "a refusal leaves nothing behind")
    const wrongWidth = await cmd("bind alpha flow color");
    check("S37: a vector channel on a scalar axis is refused LOUDLY",
      wrongWidth.status === "error" && /vector channel \(components: 3\)/.test(wrongWidth.message),
      JSON.stringify(wrongWidth));
    check("S37: refusals bound nothing, wrote nothing, recorded nothing",
      (await cmd("bindings")).message === "no bindings" &&
        (await changedVs("__preC", "color")) === 0 && (await undoDepth()) === depth0);

    // -- bind: applied once, ONE stroke, listed, badged ------------------------
    // Index addressing (#lo-hi) keeps the subset arithmetic self-evident: the
    // harness dataset's label tree shares group ids across categories, so
    // label subsets are not strict subsets (a pre-existing resolution fact,
    // not this feature's concern).
    const bind1 = await cmd("bind #0-199 energy color 0 2.5");
    check("S37: bind applies the current frame's values and reports",
      bind1.status === "ok" && /^bound "energy" → color on 200 points of "#0-199"/.test(bind1.message),
      JSON.stringify(bind1));
    check("S37: bind is exactly ONE undo stroke", (await undoDepth()) === depth0 + 1);
    const changedAfterBind = await changedVs("__preC", "color");
    check("S37: the write touched ONLY the bound elements' color slots",
      changedAfterBind >= 200 && changedAfterBind <= 600, `changed=${changedAfterBind}`);
    check("S37: …and no other buffer", (await changedVs("__preS", "size")) === 0);
    check("S37: bindings lists it",
      /energy → color on "#0-199" — 200 points · range 0\.\.2\.5/.test((await cmd("bindings")).message));
    check("S37: the status badge counts it", /· 1 binding live$/.test(await statusLine()),
      await statusLine());

    // -- cross-axis coexistence over the SAME elements -------------------------
    const bind2 = await cmd("bind #0-199 energy size 0 2.5");
    check("S37: a second axis over the same elements coexists — no takeover",
      bind2.status === "ok" && !/took/.test(bind2.message) && /· 2 bindings live$/.test(await statusLine()),
      JSON.stringify(bind2));

    // -- LWW: a direct PARTIAL write clears same-axis coverage, same stroke ----
    await d.evaluate(`void (window.__preLww = Float32Array.from(${V}.rep.state.color))`);
    const depthLww = await undoDepth();
    const write = await cmd("colorpoints #0-99 red");
    check("S37: the direct write lands", write.status === "ok" && write.message === "colored 100 points red",
      JSON.stringify(write));
    check("S37: write + coverage clear are ONE stroke", (await undoDepth()) === depthLww + 1);
    const list2 = (await cmd("bindings")).message;
    check("S37: the color binding SHRANK by exactly the written elements; size untouched",
      list2.includes('energy → color on "#0-199" — 100 points') &&
        list2.includes('energy → size on "#0-199" — 200 points'),
      list2);

    // -- one Ctrl+Z restores the write AND the taken coverage together ---------
    await d.ctrlZ();
    await sleep(400);
    check("S37: one Ctrl+Z restores the written values AND the coverage",
      (await changedVs("__preLww", "color")) === 0 &&
        (await cmd("bindings")).message.includes('energy → color on "#0-199" — 200 points') &&
        (await undoDepth()) === depthLww,
      (await cmd("bindings")).message);

    // -- axis-scoped unbind touches only its axis ------------------------------
    const un = await cmd("unbind all color");
    check("S37: axis-scoped unbind releases color only",
      un.status === "ok" && / on color — values stay as last applied$/.test(un.message) &&
        /· 1 binding live$/.test(await statusLine()),
      JSON.stringify(un));

    // -- unwinding to the start: pristine buffers, zero bindings, clean badge --
    for (let i = 0; i < 3; i++) { await d.ctrlZ(); await sleep(200); } // unbind, bind2, bind1
    check("S37: full unwind → pristine color+size buffers, no bindings, no badge, base depth",
      (await changedVs("__preC", "color")) === 0 && (await changedVs("__preS", "size")) === 0 &&
        (await cmd("bindings")).message === "no bindings" &&
        !/binding/.test(await statusLine()) && (await undoDepth()) === depth0,
      `depth=${await undoDepth()} status=${await statusLine()}`);
  });
}

// ============ S38: the LIVE channel link — the interleaving suite (C-3) =======
// The heavy-bar gate for shared-buffer duality: baked and channel-derived
// values coexist element-by-element in one buffer, and every individually-
// green behavior can compose into ghost writes across bind / direct-write /
// pause / seek / undo interleavings. Each lettered block is one CONSUMER.md
// §2.7 assertion; the pixel blocks prove buffer→PICTURE (state without
// pixels is the defect class this project exists to catch). Runs under BOTH
// depth variants. Load-immunity: every capture waits for fresh rendered
// frames; every seek waits for the chunk AND the displayed flip.
async function S38(): Promise<void> {
  for (const variant of [2, 1] as const) {
    console.log(`S38 — the live channel link, depth variant ${variant}`);
    await withDriver(async (d) => {
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
      const vers = () =>
        d.evaluate<{ p: { color: number; size: number; opacity: number };
                     e: { start: number; sizeA: number; sizeB: number };
                     t: { start: number; radius: number; color: number } }>(
          `({ p: ${V}.repAttrVersions(), e: ${V}.edgeAttrVersions(), t: ${V}.traceAttrVersions() })`);
      const rafs = () => d.evaluate(`(async () => {
        for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
      })()`);
      // seek = playhead + chunk cached + the DISPLAYED flip actually ran
      const seekTo = async (f: number): Promise<void> => {
        await d.evaluate(`${V}.player.seek(${f})`);
        await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
        await rafs();
      };
      // the mapped expectation, computed from the SAME chunk data the flip
      // reads — proves offset/stride/mapping end to end (RANGE pinned below)
      const RANGE = "0, 0.004";
      const expectSize = (f: number, p: number) =>
        d.evaluate<number>(`(()=>{
          const chunk = ${V}.player.getFrame(${f});
          const v = chunk.channels.get("energy")[(${f} - chunk.start) * 6000 + ${p}];
          const [lo, hi] = [${RANGE}];
          return Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 6;
        })()`);
      const sizeAt = (p: number) => d.evaluate<number>(`${V}.rep.state.size[${p}]`);

      await seekTo(0);

      // -- A: UNBOUND PAYS ZERO --------------------------------------------
      const vA = await vers();
      const depA = await undoDepth();
      await seekTo(5); await seekTo(10);
      const vA2 = await vers();
      check("S38: flips actually ran (endpoint copies bumped)",
        vA2.e.start > vA.e.start && vA2.t.start > vA.t.start,
        JSON.stringify({ vA, vA2 }));
      check("S38: UNBOUND PAYS ZERO — no rep attribute uploads, no junction fills, no undo entries",
        vA2.p.color === vA.p.color && vA2.p.size === vA.p.size && vA2.p.opacity === vA.p.opacity &&
          vA2.e.sizeA === vA.e.sizeA && vA2.e.sizeB === vA.e.sizeB &&
          vA2.t.radius === vA.t.radius && vA2.t.color === vA.t.color &&
          (await undoDepth()) === depA,
        JSON.stringify({ vA, vA2 }));

      // -- B: BOUND AXIS UPDATES ON FLIP, ALONE (+ the junction carve-out) --
      const bindSize = await cmd(`bind #0-199 energy size ${RANGE.replace(",", "")}`);
      check("S38: (setup) size binding is live", bindSize.status === "ok" && /live/.test(bindSize.message),
        JSON.stringify(bindSize));
      const vB = await vers();
      await seekTo(20); await seekTo(25);
      const vB2 = await vers();
      check("S38: BOUND AXIS ALONE — size uploads on flip; color/opacity/trace stay silent; iSizeA/iSizeB re-derive (the S34 carve-out, bound scenes only)",
        vB2.p.size > vB.p.size && vB2.p.color === vB.p.color && vB2.p.opacity === vB.p.opacity &&
          vB2.e.sizeA > vB.e.sizeA && vB2.e.sizeB > vB.e.sizeB &&
          vB2.t.radius === vB.t.radius && vB2.t.color === vB.t.color,
        JSON.stringify({ vB, vB2 }));

      // -- C: VALUES CORRECT AT TWO FRAMES (offset/stride/mapping proof) ----
      for (const f of [25, 40]) {
        await seekTo(f);
        const got7 = await sizeAt(7); const want7 = await expectSize(f, 7);
        const got150 = await sizeAt(150); const want150 = await expectSize(f, 150);
        check(`S38: derived values EQUAL the mapped channel at frame ${f} (spot points 7, 150)`,
          Math.abs(got7 - want7) < 1e-5 && Math.abs(got150 - want150) < 1e-5,
          JSON.stringify({ f, got7, want7, got150, want150 }));
      }
      check("S38: an unbound point keeps the base size through it all",
        Math.abs((await sizeAt(300)) - 3) < 1e-6, `size[300]=${await sizeAt(300)}`);

      // -- C2: SEEK BACK to an already-displayed, already-CACHED frame ------
      // The dangerous case for any cache-shaped design: landing on a frame
      // whose chunk is already in the LRU fires NO arrival event. The
      // recompute trigger here is the DISPLAYED-FRAME FLIP itself, so a
      // cached landing must re-derive — the buffer shows the LANDED frame's
      // values, never the previous frame's. Precondition asserted first:
      // the two frames map to genuinely different values, so equality
      // discriminates (a stale buffer cannot pass both arms).
      const backWant = await expectSize(25, 150);
      const fortyWant = await expectSize(40, 150);
      check("S38: (data precondition) frames 25 and 40 map to different values at the spot point",
        Math.abs(backWant - fortyWant) > 1e-3, JSON.stringify({ backWant, fortyWant }));
      await seekTo(25); // 40 → BACK to 25: both chunks long cached, zero fetches
      const backGot = await sizeAt(150);
      check("S38: SEEK-TO-CACHED-FRAME re-derives — frame 25's values, NOT a stale frame 40",
        Math.abs(backGot - backWant) < 1e-5 && Math.abs(backGot - fortyWant) > 1e-3,
        JSON.stringify({ backGot, backWant, fortyWant }));

      // -- D: BIND → PLAY → ONE UNDO (the never-recorded assertion) ---------
      await d.evaluate(`void (window.__preC = Float32Array.from(${V}.rep.state.color))`);
      const depD = await undoDepth();
      await cmd(`bind #0-199 energy color ${RANGE.replace(",", "")}`);
      check("S38: bind is one stroke", (await undoDepth()) === depD + 1);
      const colorVerBefore = (await vers()).p.color;
      await d.evaluate(`${V}.setPlaying(true)`);
      await sleep(1500);
      await d.evaluate(`${V}.setPlaying(false)`);
      await rafs();
      const colorVerAfter = (await vers()).p.color;
      check("S38: playback re-derived the bound color (uploads happened)",
        colorVerAfter > colorVerBefore, `${colorVerBefore} → ${colorVerAfter}`);
      check("S38: NEVER RECORDED — any amount of playback adds ZERO undo entries",
        (await undoDepth()) === depD + 1, `depth=${await undoDepth()} want=${depD + 1}`);
      const colorDiff = () => d.evaluate<number>(`(()=>{
        const c=${V}.rep.state.color, s=window.__preC; let n=0;
        for (let i=0;i<c.length;i++) if (Math.abs(c[i]-s[i])>1e-6) n++; return n;
      })()`);
      await d.ctrlZ();
      await sleep(300);
      check("S38: ONE Ctrl+Z after playback → pristine pre-bind buffer, binding gone, depth back",
        (await colorDiff()) === 0 && (await undoDepth()) === depD &&
          !/energy → color/.test((await cmd("bindings")).message),
        `diff=${await colorDiff()} depth=${await undoDepth()}`);
      const fNow = await d.evaluate<number>(`${V}.player.frame`);
      await seekTo((fNow + 7) % 140);
      check("S38: …and a further seek does NOT re-trample (the binding is truly gone)",
        (await colorDiff()) === 0, `diff=${await colorDiff()}`);

      // -- E: PAUSE → DIRECT WRITE → SEEK (the ghost-write check) -----------
      await seekTo(40);
      const write = await cmd("pointsize #0-99 5");
      check("S38: (paused) the direct write lands and shrinks coverage",
        write.status === "ok" &&
          /energy → size on "#0-199" — 100 points/.test((await cmd("bindings")).message),
        (await cmd("bindings")).message);
      await seekTo(50);
      check("S38: PAUSE-WRITE-SEEK — written elements SURVIVE the flip; unwritten keep animating",
        Math.abs((await sizeAt(50)) - 5) < 1e-6 &&
          Math.abs((await sizeAt(150)) - (await expectSize(50, 150))) < 1e-5,
        JSON.stringify({ s50: await sizeAt(50), s150: await sizeAt(150), want150: await expectSize(50, 150) }));
      await seekTo(60);
      check("S38: …and keep surviving on further seeks",
        Math.abs((await sizeAt(50)) - 5) < 1e-6, `size[50]=${await sizeAt(50)}`);
      await d.ctrlZ();
      await sleep(300);
      await seekTo(70);
      check("S38: undoing the write RESTORES coverage — those elements re-derive again",
        Math.abs((await sizeAt(50)) - (await expectSize(70, 50))) < 1e-5 &&
          /energy → size on "#0-199" — 200 points/.test((await cmd("bindings")).message),
        JSON.stringify({ s50: await sizeAt(50), want: await expectSize(70, 50) }));

      // -- F: TWO BINDINGS, DISJOINT AXES, OVERLAPPING TARGETS --------------
      await cmd(`bind #100-299 energy color ${RANGE.replace(",", "")}`);
      const vF = await vers();
      await seekTo(80);
      const vF2 = await vers();
      const rgb150 = await d.evaluate<number[]>(`[...${V}.rep.state.color.slice(450, 453)]`);
      const t150 = (await expectSize(80, 150)) / 6;
      check("S38: TWO LIVE BINDINGS — one flip re-derives both axes; both correct at the overlap",
        vF2.p.color > vF.p.color && vF2.p.size > vF.p.size &&
          Math.abs((await sizeAt(150)) - t150 * 6) < 1e-5 && rgb150.length === 3,
        JSON.stringify({ rgb150, t150 }));

      // -- G: PIXELS — the animated claim and the stopped claim -------------
      // Probe point 150: color-bound (live), given a FAT FIXED size via a
      // deliberate LWW write on the size axis (clears size coverage on 150
      // only — the color binding is untouched; axes are orthogonal).
      await cmd("pointsize #150 8");
      // occlusion isolation (the standing pixel-proof rule): fade every
      // OTHER element to zero — zero-alpha impostor fragments DISCARD, so
      // nothing can sit in front of the probe sphere at any frame. The
      // opacity writes ride the opacity axis (no binding there — nothing
      // to clear); the color binding is untouched.
      await cmd("pointopacity all 0");
      await cmd("pointopacity #150 1");
      await cmd("bondopacity all 0");
      await cmd("bondopacityof all 0");
      await cmd("traceopacity all 0");
      // find two frames where the DERIVED hue at 150 is red (t≈0) vs blue
      // (t≈0.75): computed from the data, asserted found — a dataset drift
      // fails loudly instead of weakening the pixel claim.
      const frames = await d.evaluate<{ fRed: number; fBlue: number }>(`(()=>{
        let fRed = -1, fBlue = -1;
        for (let f = 0; f < 140; f++) {
          const chunk = ${V}.player.getFrame(f);
          if (!chunk) continue;
          const v = chunk.channels.get("energy")[(f - chunk.start) * 6000 + 150];
          const t = Math.min(1, Math.max(0, v / 0.004));
          if (fRed < 0 && t < 0.05) fRed = f;
          if (fBlue < 0 && t > 0.7 && t < 0.85) fBlue = f;
        }
        return { fRed, fBlue };
      })()`);
      check("S38: (data precondition) a red-frame and a blue-frame exist for the probe point",
        frames.fRed >= 0 && frames.fBlue >= 0, JSON.stringify(frames));
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 40; i++) {
          const a = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
          await rafs();
          const b = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
          if (Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) < 1e-4) return;
        }
      };
      // The probe point MOVES between frames (analytic oscillation), so
      // every capture re-frames it first — zoomToPoints is the flash-free
      // camera path (no pulse overlay to tint the patch).
      const patchAt150 = async (tag: string): Promise<{ red: number; blue: number }> => {
        await d.evaluate(`${V}.zoomToPoints([150])`);
        await settle();
        await rafs();
        const pr = await d.evaluate<{ x: number; y: number; front: boolean }>(`${V}.debug.projectPoint(150)`);
        const b64 = await d.captureB64(`${REPORT}/S38_v${variant}_${tag}.png`);
        return d.evaluate<{ red: number; blue: number }>(`(async () => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(${Math.round(pr.x) - 3}, ${Math.round(pr.y) - 3}, 7, 7).data;
          let red = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) red++;
            if (px[i+2] > px[i] + 60 && px[i+2] > px[i+1] + 40) blue++;
          }
          return { red, blue };
        })()`);
      };
      await seekTo(frames.fRed);
      const pxRed = await patchAt150("red");
      check("S38: PIXELS ANIMATE — at the red frame the probe sphere RENDERS red",
        pxRed.red > 5 && pxRed.blue === 0, JSON.stringify(pxRed));
      await seekTo(frames.fBlue);
      const pxBlue = await patchAt150("blue");
      check("S38: …and at the blue frame the SAME sphere renders blue — the picture follows the data",
        pxBlue.blue > 5 && pxBlue.red === 0, JSON.stringify(pxBlue));
      // the STOPPED claim: a direct write takes the element out of the live
      // link, and the PICTURE stops following the data
      await cmd("colorpoints #150 red");
      await seekTo(frames.fRed);
      await seekTo(frames.fBlue); // a frame whose DERIVED hue would be blue
      const pxStopped = await patchAt150("stopped");
      check("S38: PIXELS STOP — after a direct write the sphere stays red at the blue frame",
        pxStopped.red > 5 && pxStopped.blue === 0, JSON.stringify(pxStopped));
    });
  }
}

// ============ S39: the orientation seam (O-1) — stored ≡ supplied, state-only =
// The vector axis exists as STATE: a 3-wide channel binds to orientation,
// the per-vertex buffer stores the RAW vectors, re-derives on flip, and
// NOTHING draws it. Every check is a buffer/seam assertion — there are no
// pixels to photograph. `stored ≡ supplied` is the load-bearing identity:
// it is the precursor of O-2's `drawn ≡ supplied`.
async function S39(): Promise<void> {
  console.log("S39 — the orientation seam (O-1): stored ≡ supplied, nothing draws");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const statusLine = () => d.evaluate<string>(`document.getElementById('status').textContent`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    const vers = () =>
      d.evaluate<{ p: { color: number; size: number; opacity: number };
                   e: { sizeA: number; sizeB: number };
                   t: { radius: number; color: number } }>(
        `({ p: ${V}.repAttrVersions(), e: ${V}.edgeAttrVersions(), t: ${V}.traceAttrVersions() })`);
    // stored ≡ supplied at frame f, spot vertices (first/mid/last): the
    // orientation buffer's per-vertex triple equals the vertex's OWN
    // point's channel vector, straight from the chunk block.
    const storedEqualsSupplied = (f: number) =>
      d.evaluate<{ ok: boolean; detail: string }>(`(()=>{
        const tv = ${V}.traceVertices;
        const chunk = ${V}.player.getFrame(${f});
        const off = (${f} - chunk.start) * 6000 * 3;
        const block = chunk.channels.get("flow");
        const buf = ${V}.rep.state.orientation;
        const spots = [0, Math.floor(tv.length / 2), tv.length - 1];
        for (const v of spots) {
          for (let c = 0; c < 3; c++) {
            const want = block[off + tv[v] * 3 + c];
            const got = buf[v * 3 + c];
            if (Math.abs(got - want) > 1e-7) {
              return { ok: false, detail: "v=" + v + " c=" + c + " got=" + got + " want=" + want };
            }
          }
        }
        return { ok: true, detail: "spots " + spots.join(",") + " at frame " + ${f} };
      })()`);
    const oriAllZero = () =>
      d.evaluate<boolean>(`${V}.rep.state.orientation.every((x) => x === 0)`);

    // Pause autoplay: every check reads the buffer at a specific seeked
    // frame, so the displayed frame must not advance under us and re-derive
    // to a different frame (the same determinism S38 needs).
    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);

    // -- A: the buffer exists, per-vertex ×3, zero, and UNBOUND PAYS ZERO --
    const shape = await d.evaluate<{ len: number; tv: number }>(
      `({ len: ${V}.rep.state.orientation.length, tv: ${V}.traceVertices.length })`);
    check("S39: the orientation buffer is per-vertex stride 3, zero by default",
      shape.tv > 0 && shape.len === shape.tv * 3 && (await oriAllZero()),
      JSON.stringify(shape));
    const depA = await undoDepth();
    await seekTo(5); await seekTo(10);
    check("S39: UNBOUND PAYS ZERO — flips leave the buffer zero and the undo stack flat",
      (await oriAllZero()) && (await undoDepth()) === depA);

    // -- B: the gate refuses the wrong shapes loudly, writing nothing ------
    const refusals: [string, RegExp][] = [
      ["bind all energy orientation", /orientation needs a vector \(3-wide\) channel — "energy" is scalar/],
      ["bind all flow orientation 0 1", /meaningless for the orientation axis/],
      ["bind all flow color", /vector channel \(components: 3\)/],
    ];
    for (const [text, want] of refusals) {
      const r = await cmd(text);
      check(`S39: refusal — ${text}`, r.status === "error" && want.test(r.message), JSON.stringify(r));
    }
    check("S39: no refusal wrote anything", await oriAllZero());

    // -- C: bind accepts, says STORED-ONLY, lists, badges ------------------
    const bind = await cmd("bind all flow orientation");
    check("S39: bind all flow orientation is accepted and says stored-only",
      bind.status === "ok" &&
        /raw vectors/.test(bind.message) && /drives the oriented shapes/.test(bind.message) &&
        new RegExp(`on ${shape.tv} vertices`).test(bind.message),
      JSON.stringify(bind));
    check("S39: the badge counts it", /· 1 binding live$/.test(await statusLine()), await statusLine());
    check("S39: bindings lists the vector row",
      /flow → orientation on "all" — \d+ vertices · raw vectors/.test(
        (await cmd("bindings")).message),
      (await cmd("bindings")).message);

    // -- D/E: STORED ≡ SUPPLIED, live across flips, touching nothing else --
    const eq0 = await storedEqualsSupplied(10);
    check("S39: STORED ≡ SUPPLIED at the bound frame", eq0.ok, eq0.detail);
    const vD = await vers();
    const depD = await undoDepth();
    await seekTo(40);
    const eq40 = await storedEqualsSupplied(40);
    check("S39: the binding is LIVE — the buffer re-derives to frame 40's vectors", eq40.ok, eq40.detail);
    // precondition: the two frames genuinely differ, so equality discriminates
    const differ = await d.evaluate<boolean>(`(()=>{
      const tv = ${V}.traceVertices;
      const a = ${V}.player.getFrame(10), b = ${V}.player.getFrame(40);
      const ax = a.channels.get("flow")[(10 - a.start) * 6000 * 3 + tv[0] * 3];
      const bx = b.channels.get("flow")[(40 - b.start) * 6000 * 3 + tv[0] * 3];
      return Math.abs(ax - bx) > 1e-4;
    })()`);
    check("S39: (data precondition) frames 10 and 40 supply different vectors", differ);
    const vE = await vers();
    check("S39: orientation flips touch NO other buffer and record NOTHING",
      vE.p.color === vD.p.color && vE.p.size === vD.p.size && vE.p.opacity === vD.p.opacity &&
        vE.e.sizeA === vD.e.sizeA && vE.e.sizeB === vD.e.sizeB &&
        vE.t.radius === vD.t.radius && vE.t.color === vD.t.color &&
        (await undoDepth()) === depD,
      JSON.stringify({ vD, vE }));

    // -- F: one undo after bind + flips → pristine zeros, binding gone -----
    await d.ctrlZ();
    await sleep(300);
    check("S39: ONE Ctrl+Z restores the zero buffer and removes the binding",
      (await oriAllZero()) && (await cmd("bindings")).message === "no bindings" &&
        (await undoDepth()) === depA);
    await seekTo(50);
    check("S39: …and a further seek does not re-derive (truly gone)", await oriAllZero());

    // -- G: bake stores once, no binding, and does NOT re-derive on flip ---
    await seekTo(50);
    const bake = await cmd("bake all flow orientation");
    check("S39: bake stores the raw vectors without a binding",
      bake.status === "ok" && /stored; drawn by the oriented shapes/.test(bake.message) &&
        (await storedEqualsSupplied(50)).ok && (await cmd("bindings")).message === "no bindings",
      JSON.stringify(bake));
    // precondition: frames 50 and 60 supply different vectors, so "stale"
    // and "re-derived" are distinguishable
    const differ5060 = await d.evaluate<boolean>(`(()=>{
      const tv = ${V}.traceVertices;
      const a = ${V}.player.getFrame(50), b = ${V}.player.getFrame(60);
      const ax = a.channels.get("flow")[(50 - a.start) * 6000 * 3 + tv[0] * 3];
      const bx = b.channels.get("flow")[(60 - b.start) * 6000 * 3 + tv[0] * 3];
      return Math.abs(ax - bx) > 1e-4;
    })()`);
    check("S39: (data precondition) frames 50 and 60 supply different vectors", differ5060);
    await seekTo(60);
    const keeps50 = (await storedEqualsSupplied(50)).ok;
    const isNot60 = !(await storedEqualsSupplied(60)).ok;
    check("S39: a bake does NOT re-derive on flip — buffer keeps frame-50 values, stale to 60",
      keeps50 && isNot60, JSON.stringify({ keeps50, isNot60 }));
    await d.ctrlZ();
    await sleep(300);
    check("S39: undoing the bake restores the zero buffer", await oriAllZero());

    // -- H: the two id spaces through the REAL release composite ----------
    // The unit layer proves the verbs against a stub that MIRRORS the
    // main.ts composite; this block proves the composite itself. The probe
    // vertex's POINT id exceeds every vertex id, so a space-mixing
    // regression (releasing orientation coverage with POINT ids) provably
    // could not touch any vertex — the check discriminates by construction.
    const probe = await d.evaluate<{ v: number; p: number }>(`(()=>{
      const tv = ${V}.traceVertices;
      for (let v = 0; v < tv.length; v++) if (tv[v] >= tv.length) return { v, p: tv[v] };
      return { v: -1, p: -1 };
    })()`);
    check("S39: (data precondition) a vertex exists whose point id exceeds every vertex id",
      probe.v >= 0, JSON.stringify(probe));
    await cmd("bind all flow orientation");
    await seekTo(70);
    check("S39: (setup) the fresh binding re-derives at frame 70", (await storedEqualsSupplied(70)).ok);
    const un = await cmd(`unbind #${probe.p} orientation`);
    check("S39: the REAL composite releases in VERTEX space — exactly one vertex released",
      un.status === "ok" && /released 1 bound elements across 1 binding on orientation/.test(un.message),
      JSON.stringify(un));
    await seekTo(80);
    const spaces = await d.evaluate<{ probeStale: boolean; otherLive: boolean }>(`(()=>{
      const tv = ${V}.traceVertices;
      const chunk = ${V}.player.getFrame(80);
      const off = (80 - chunk.start) * 6000 * 3;
      const block = chunk.channels.get("flow");
      const buf = ${V}.rep.state.orientation;
      const eq = (v) => Math.abs(buf[v*3] - block[off + tv[v]*3]) < 1e-7
        && Math.abs(buf[v*3+1] - block[off + tv[v]*3+1]) < 1e-7;
      const vOther = ${probe.v} === 0 ? 1 : 0;
      return { probeStale: !eq(${probe.v}), otherLive: eq(vOther) };
    })()`);
    check("S39: …the released vertex STOPS re-deriving; the rest keep following the channel",
      spaces.probeStale && spaces.otherLive, JSON.stringify(spaces));
  });
}

// ====== S40: per-element edge/trace channel consumers (A-1, real wiring) ======
// The bond*/trace* scalar axes through the REAL applier: trace values read
// each vertex's OWN point, edge values the ENDPOINT MEAN (mean of raws,
// then the lens), both re-deriving on flip, undoing in one stroke, and
// paying zero when unbound. Buffer/seam assertions; the drawn pixels for
// these buffers are already pinned by the fast lane's existing scenarios.
async function S40(): Promise<void> {
  console.log("S40 — edge/trace channel consumers: mean rule + own-point rule, live");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    // stored ≡ supplied for the two new domains at frame f, spot elements
    const traceEquals = (f: number) =>
      d.evaluate<{ ok: boolean; detail: string }>(`(()=>{
        const tv = ${V}.traceVertices;
        const chunk = ${V}.player.getFrame(${f});
        const off = (${f} - chunk.start) * 6000;
        const block = chunk.channels.get("energy");
        const buf = ${V}.rep.state.traceSize;
        const t = (v) => Math.min(1, Math.max(0, block[off + tv[v]] / 0.004)) * 6;
        for (const v of [0, tv.length - 1]) {
          if (Math.abs(buf[v] - t(v)) > 1e-5) {
            return { ok: false, detail: "v=" + v + " got=" + buf[v] + " want=" + t(v) };
          }
        }
        return { ok: true, detail: "frame " + ${f} };
      })()`);
    const edgeEquals = (f: number) =>
      d.evaluate<{ ok: boolean; detail: string }>(`(()=>{
        const chunk = ${V}.player.getFrame(${f});
        const off = (${f} - chunk.start) * 6000;
        const block = chunk.channels.get("energy");
        const buf = ${V}.rep.state.edgeOpacity;
        const edges = ${V}.edges;
        for (const e of [0, 1234, edges.length - 1]) {
          const mean = (block[off + edges[e][0]] + block[off + edges[e][1]]) / 2;
          const want = Math.min(1, Math.max(0, mean / 0.004));
          if (Math.abs(buf[e] - want) > 1e-5) {
            return { ok: false, detail: "e=" + e + " got=" + buf[e] + " want=" + want };
          }
        }
        return { ok: true, detail: "frame " + ${f} };
      })()`);

    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);

    // -- unbound pays zero on the NEW axes ---------------------------------
    const snap0 = await d.evaluate<boolean>(`(()=>{
      window.__preTS = Float32Array.from(${V}.rep.state.traceSize);
      window.__preEO = Float32Array.from(${V}.rep.state.edgeOpacity);
      return true;
    })()`);
    check("S40: (setup) pre-bind snapshots taken", snap0);
    const depth0 = await undoDepth();
    await seekTo(5); await seekTo(10);
    const flat = await d.evaluate<boolean>(`(()=>{
      const a = ${V}.rep.state.traceSize, b = window.__preTS;
      const c = ${V}.rep.state.edgeOpacity, e = window.__preEO;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      for (let i = 0; i < c.length; i++) if (c[i] !== e[i]) return false;
      return true;
    })()`);
    check("S40: UNBOUND PAYS ZERO — flips leave the edge/trace buffers untouched",
      flat && (await undoDepth()) === depth0);

    // -- bind both new domains; stored ≡ supplied, live across flips -------
    const b1 = await cmd("bind all energy tracesize 0 0.004");
    check("S40: tracesize binds (own-point rule)",
      b1.status === "ok" && /→ tracesize on \d+ vertices/.test(b1.message), JSON.stringify(b1));
    const b2 = await cmd("bind all energy bondopacity 0 0.004");
    check("S40: bondopacity binds and names the mean rule",
      b2.status === "ok" && /→ bondopacity on \d+ edges/.test(b2.message) && /endpoint mean/.test(b2.message),
      JSON.stringify(b2));
    const eqT = await traceEquals(10);
    check("S40: STORED ≡ SUPPLIED (trace: vertex's own point)", eqT.ok, eqT.detail);
    const eqE = await edgeEquals(10);
    check("S40: STORED ≡ SUPPLIED (edge: endpoint mean)", eqE.ok, eqE.detail);
    await seekTo(40);
    const eqT2 = await traceEquals(40);
    const eqE2 = await edgeEquals(40);
    check("S40: both re-derive LIVE on flip", eqT2.ok && eqE2.ok, eqT2.detail + " / " + eqE2.detail);
    check("S40: flips recorded NOTHING", (await undoDepth()) === depth0 + 2);

    // -- one undo each → pristine buffers ----------------------------------
    await d.ctrlZ();
    await sleep(250);
    await d.ctrlZ();
    await sleep(250);
    const pristine = await d.evaluate<boolean>(`(()=>{
      const a = ${V}.rep.state.traceSize, b = window.__preTS;
      const c = ${V}.rep.state.edgeOpacity, e = window.__preEO;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
      for (let i = 0; i < c.length; i++) if (Math.abs(c[i] - e[i]) > 1e-7) return false;
      return true;
    })()`);
    check("S40: one undo per bind → pristine pre-bind buffers, bindings gone",
      pristine && (await cmd("bindings")).message === "no bindings" && (await undoDepth()) === depth0);
    await seekTo(50);
    const still = await d.evaluate<boolean>(`(()=>{
      const a = ${V}.rep.state.traceSize, b = window.__preTS;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
      return true;
    })()`);
    check("S40: …and further seeks never re-trample", still);
  });
}

// ========== S41: per-target style — the highlight obeys the style axis ========
// A-2's visible proof: `stylepoints <target> matte` kills the specular
// highlight on exactly the styled elements (style index rides a per-element
// attribute; params come from ONE packed uniform array, looked up in the
// vertex stage). Default = byte-identical `standard` — the full lane pins
// that; here we prove the SELECTED style changes pixels and undoes.
async function S41(): Promise<void> {
  console.log("S41 — per-target style: matte kills the highlight, one undo restores it");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    await d.evaluate(`${V}.setPlaying(false)`);
    await d.evaluate(`${V}.player.seek(0)`);
    await d.waitFor(`${V}.player.frame === 0 && ${V}.player.getFrame(0) !== null`, 20000);
    await rafs();
    // occlusion isolation + a fat probe, the standing pixel recipe
    await cmd("pointopacity all 0");
    await cmd("pointopacity #150 1");
    await cmd("pointsize #150 8");
    await cmd("bondopacity all 0");
    await cmd("bondopacityof all 0");
    await cmd("traceopacity all 0");
    await d.evaluate(`${V}.zoomToPoints([150])`);
    for (let i = 0; i < 40; i++) {
      const a = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
      await rafs();
      const b = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-4) break;
    }
    // the specular highlight sits at the sphere's view-facing center (nz≈1)
    const centerLum = async (tag: string): Promise<number> => {
      await rafs();
      const pr = await d.evaluate<{ x: number; y: number }>(`${V}.debug.projectPoint(150)`);
      const b64 = await d.captureB64(`${REPORT}/S41_${tag}.png`);
      return d.evaluate<number>(`(async () => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const px = g.getImageData(${Math.round(pr.x) - 1}, ${Math.round(pr.y) - 1}, 3, 3).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
        return sum / 9;
      })()`);
    };
    const base = await centerLum("standard");
    check("S41: (baseline) the standard highlight saturates the center", base > 245, `lum=${base}`);
    const styled = await cmd("stylepoints #150 matte");
    check("S41: stylepoints reports the action", styled.status === "ok" && styled.message === "styled 1 points matte",
      JSON.stringify(styled));
    const matte = await centerLum("matte");
    check("S41: MATTE KILLS THE HIGHLIGHT — center luminance drops measurably",
      base - matte > 12, `standard=${base} matte=${matte}`);
    // buffer truth + the other domains' writers
    check("S41: the style buffer holds the index", (await d.evaluate<number>(`${V}.rep.state.style[150]`)) === 1);
    await cmd("stylebonds all matte");
    check("S41: edge style buffer written", (await d.evaluate<number>(`${V}.rep.state.edgeStyle[0]`)) === 1);
    await cmd("styletrace all matte");
    const tStyled = await d.evaluate<boolean>(`${V}.rep.state.traceStyle.every((x) => x === 1)`);
    check("S41: trace style buffer written (map-up covers every vertex under all)", tStyled);
    await d.ctrlZ(); await sleep(200);
    await d.ctrlZ(); await sleep(200);
    await d.ctrlZ(); await sleep(200);
    const back = await centerLum("restored");
    check("S41: three undos → highlight restored, buffers pristine",
      back > 245 && (await d.evaluate<number>(`${V}.rep.state.style[150]`)) === 0 &&
        (await d.evaluate<number>(`${V}.rep.state.edgeStyle[0]`)) === 0,
      `lum=${back}`);
  });
}

// ====== S42: the shape verb surface (A-3) — per-domain, one shape each today ==
// The registry's enable machinery + the verb surface, pinned while every
// domain still has exactly ONE shape (a no-op swap must change NOTHING).
// The real two-shape swap proof arrives with the ribbon (B-2's scenario).
async function S42(): Promise<void> {
  console.log("S42 — shape verb surface: listing, no-op swap, loud refusals");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const list = await cmd("shapes");
    check("S42: shapes lists every domain with its active shape",
      list.status === "ok" &&
        /points: sphere \(active\)/.test(list.message) &&
        /bonds: tube \(active\)/.test(list.message) &&
        /traces: tube \(active\)  ribbon/.test(list.message),
      JSON.stringify(list));
    const depth0 = await undoDepth();
    const noop = await cmd("shape traces tube");
    check("S42: a no-op swap says so and records NOTHING",
      noop.status === "ok" && noop.message === "traces already draw as tube" &&
        (await undoDepth()) === depth0,
      JSON.stringify(noop));
    const bad = await cmd("shape traces cube");
    check("S42: an unregistered shape refuses loudly with the registry",
      bad.status === "error" && /no shape "cube" for traces — registered: tube, ribbon/.test(bad.message),
      JSON.stringify(bad));
    const badDomain = await cmd("shape lines tube");
    check("S42: an unknown domain refuses loudly",
      badDomain.status === "error" && /unknown domain "lines"/.test(badDomain.message),
      JSON.stringify(badDomain));
    // the scene still draws: the trace pass is enabled and visible
    const visible = await d.evaluate<boolean>(`(()=>{
      return ${V}.geometryMaterials !== undefined; // seam alive; pixel identity rides the lane
    })()`);
    check("S42: seam alive after the surface exercise", visible);
  });
}

// ====== S43: the RIBBON — the first oriented shape, driven by the vector ======
// B-2's gate, part 1: the two-shape swap is REAL (tube pixels vanish when
// the collapsed ribbon takes over), the degeneracy rule holds (no
// orientation data → no plane → no pixels), drawn ≡ supplied closes the
// O-1 chain (channel → buffer [S39] → instance attrs [versions] → PIXELS
// that follow the data across frames), the cadence split holds on the
// oriented axis, and one undo after playback restores the pre-bind
// picture. Runs under the DEFAULT variant; the crossing composition proof
// is S44's job (both variants).
async function S43(): Promise<void> {
  console.log("S43 — the ribbon: swap, degeneracy, drawn ≡ supplied, cadence, undo");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    const redCount = async (tag: string): Promise<number> => {
      await rafs();
      const b64 = await d.captureB64(`${REPORT}/S43_${tag}.png`);
      return d.evaluate<number>(`(async () => {
        const app = document.getElementById('app').getBoundingClientRect();
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const px = g.getImageData(Math.round(app.left), Math.round(app.top) + 60,
          Math.round(app.width), Math.round(app.height) - 60).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) n++;
        }
        return n;
      })()`);
    };
    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);
    // isolate the trace: hide the crowd, paint the path red, fatten it
    await cmd("pointopacity all 0");
    await cmd("bondopacity all 0");
    await cmd("bondopacityof all 0");
    await cmd("colortrace all red");
    await cmd("tracesize all 5");
    await d.evaluate(`${V}.frameVisible ? 0 : 0`);
    await d.evaluate(`${V}.resetCamera()`);
    await sleep(700);
    const tubeRed = await redCount("tube");
    check("S43: (baseline) the red tube draws", tubeRed > 300, `red=${tubeRed}`);

    // -- the swap is REAL + the degeneracy rule ---------------------------
    const swap = await cmd("shape traces ribbon");
    check("S43: the swap reports", swap.status === "ok" && /traces now draw as ribbon/.test(swap.message),
      JSON.stringify(swap));
    const collapsed = await redCount("ribbon_unbound");
    check("S43: DEGENERACY — no orientation data, no plane, no pixels (and the tube is truly gone)",
      collapsed < 40, `red=${collapsed} (tube had ${tubeRed})`);

    // -- bind the vector: the ribbon MATERIALIZES -------------------------
    const bind = await cmd("bind all flow orientation");
    check("S43: (setup) orientation binds", bind.status === "ok", JSON.stringify(bind));
    const bound = await redCount("ribbon_bound");
    check("S43: the ribbon DRAWS from the vector channel", bound > 200, `red=${bound}`);

    // -- cadence: flips re-derive ACROSS alone; nothing records -----------
    const v0 = await d.evaluate<{ start: number; across: number; width: number; color: number }>(
      `${V}.ribbonAttrVersions()`);
    const dep0 = await undoDepth();
    await seekTo(10); await seekTo(20);
    const v1 = await d.evaluate<{ start: number; across: number; width: number; color: number }>(
      `${V}.ribbonAttrVersions()`);
    check("S43: BOUND-AXIS-ALONE, oriented edition — flips bump start AND across; width/color never; undo flat",
      v1.start > v0.start && v1.across > v0.across &&
        v1.width === v0.width && v1.color === v0.color && (await undoDepth()) === dep0,
      JSON.stringify({ v0, v1 }));

    // -- drawn ≡ supplied, the visible half: pixels FOLLOW the data -------
    // flow rotates with frame; the plane's projected area changes → the
    // red footprint measurably differs between distant frames, and stays
    // PRESENT at adjacent frames (no whip-to-zero: supplied is smooth,
    // stored ≡ supplied is S39's identity, so drawn follows smoothly)
    const r20 = await redCount("f20");
    await seekTo(21);
    const r21 = await redCount("f21");
    await seekTo(40);
    const r40 = await redCount("f40");
    check("S43: pixels FOLLOW the vector data across frames",
      Math.abs(r40 - r20) > 40, `f20=${r20} f40=${r40}`);
    check("S43: …and smoothly (adjacent frames both draw, bounded change)",
      r20 > 150 && r21 > 150 && Math.abs(r21 - r20) < Math.max(200, r20),
      `f20=${r20} f21=${r21}`);

    // -- one undo after playback: pre-bind picture, collapsed again -------
    await d.ctrlZ();
    await sleep(250);
    await rafs();
    const undone = await redCount("undone");
    check("S43: ONE Ctrl+Z after seeks → the binding is gone and the ribbon collapses",
      undone < 40 && (await cmd("bindings")).message === "no bindings",
      `red=${undone}`);
    // swap back: the tube returns (onEnable re-fills after the skip gap)
    await cmd("shape traces tube");
    const tubeBack = await redCount("tube_back");
    check("S43: swapping back re-fills the tube (enable after the dispatch gap)",
      tubeBack > 300, `red=${tubeBack}`);
  });
}

// ====== S44: the CROSSING — real ribbon depth × impostor sphere depth =========
// §0.4's test: the one that catches the depth-composition defect. A ribbon
// (REAL per-fragment depth) crosses an impostor sphere; at every found
// crossing the pixel must belong to whichever surface is CLOSER — computed
// analytically (segment depth at the crossing vs the sphere's SURFACE
// depth at that pixel), across several frames (in motion). Assertions run
// under VARIANT 2 (the chosen default: analytic sprite depth composes
// with real geometry by construction). Under variant 1 the same probes
// run and their outcomes are LOGGED, not asserted — flat billboard depth
// mis-sorting near-depth crossings is precisely why variant 2 was chosen;
// the record documents what the other default would have cost.
async function S44(): Promise<void> {
  for (const variant of [2, 1] as const) {
    const assertive = variant === 2;
    console.log(`S44 — crossing composition, depth variant ${variant}${assertive ? " (ASSERTED)" : " (recorded)"}`);
    await withDriver(async (d) => {
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      const rafs = () => d.evaluate(`(async () => {
        for (let i = 0; i < 2; i++) await new Promise(r => requestAnimationFrame(r));
      })()`);
      const seekTo = async (f: number): Promise<void> => {
        await d.evaluate(`${V}.player.seek(${f})`);
        await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
        await rafs();
      };
      await d.evaluate(`${V}.setPlaying(false)`);
      await seekTo(0);
      // SEVERAL probes: the matrix needs BOTH halves — crossings where the
      // sphere is closer AND crossings where the RIBBON is closer (a
      // ribbon-depth bug that pushes the band BACK would pass every
      // sphere-wins probe; only ribbon-wins probes catch it).
      const PROBES = [150, 300, 700, 900, 1200, 1500, 2000, 2500, 3200, 4200];
      await cmd("pointopacity all 0");
      for (const p of PROBES) {
        await cmd(`pointopacity #${p} 1`);
        await cmd(`colorpoints #${p} blue`);
        await cmd(`pointsize #${p} 8`);
      }
      await cmd("bondopacity all 0");
      await cmd("bondopacityof all 0");
      await cmd("colortrace all red");
      await cmd("tracesize all 5");
      await cmd("bind all flow orientation");
      await cmd("shape traces ribbon");
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
      // scan frames for screen-space crossings of the probe's disc and a
      // path segment; expected winner computed analytically per crossing
      type Crossing = { f: number; x: number; y: number; winner: "sphere" | "ribbon"; near: boolean };
      const crossings: Crossing[] = [];
      const kinds = () => ({
        sphere: crossings.filter((c) => c.winner === "sphere").length,
        ribbon: crossings.filter((c) => c.winner === "ribbon").length,
      });
      let flipped = false;
      for (let f = 0; f <= 144 && (kinds().sphere < 2 || kinds().ribbon < 2); f += 4) {
        // half-sweep camera FLIP: viewed from the opposite side, every
        // sphere-in-front crossing becomes ribbon-in-front — the reliable
        // way to exercise BOTH halves of the matrix with the same probes
        if (f >= 76 && !flipped) {
          flipped = true;
          await d.evaluate(`(()=>{
            const cam = ${V}.camera, t = ${V}.controls.target;
            cam.position.set(2 * t.x - cam.position.x, 2 * t.y - cam.position.y, 2 * t.z - cam.position.z);
          })()`);
          await rafs();
        }
        await seekTo(f);
        const wanted = kinds().sphere >= 2 ? "ribbon" : kinds().ribbon >= 2 ? "sphere" : "any";
        const found = await d.evaluate<Omit<Crossing, "f">[]>(`(()=>{
          const tv = ${V}.traceVertices;
          const pw = ${V}.sizing.pxPerWorld();
          const wps = ${V}.sizing.worldPerSize;
          const rWorld = wps * 8;
          const out = [];
          const probes = ${JSON.stringify(PROBES)}.map((p) => ({ p, pr: ${V}.debug.projectPoint(p) }));
          for (const { p, pr } of probes) {
            if (!pr.front) continue;
            const rPx = rWorld * pw / pr.depth;
            for (let k = 0; k + 1 < tv.length; k++) {
              const A = ${V}.debug.projectPoint(tv[k]);
              const B = ${V}.debug.projectPoint(tv[k + 1]);
              if (!A.front || !B.front) continue;
              const dx = B.x - A.x, dy = B.y - A.y;
              const L2 = dx * dx + dy * dy;
              if (L2 < 1) continue;
              let t = ((pr.x - A.x) * dx + (pr.y - A.y) * dy) / L2;
              t = Math.min(0.9, Math.max(0.1, t));
              const cx = A.x + t * dx, cy = A.y + t * dy;
              const distPx = Math.hypot(pr.x - cx, pr.y - cy);
              if (distPx > rPx * 0.7) continue;
              // a THIRD object over the pixel would break the two-body
              // winner math — require every OTHER probe's disc to miss it
              let clear = true;
              for (const o of probes) {
                if (o.p === p || !o.pr.front) continue;
                if (Math.hypot(o.pr.x - cx, o.pr.y - cy) < (rWorld * pw / o.pr.depth) + 3) { clear = false; break; }
              }
              if (!clear) continue;
              const segDepth = A.depth + t * (B.depth - A.depth);
              const dWorld = distPx * pr.depth / pw;
              const bulge = Math.sqrt(Math.max(0, rWorld * rWorld - dWorld * dWorld));
              const sphereSurface = pr.depth - bulge;
              const sep = Math.abs(segDepth - sphereSurface);
              if (sep < 0.15 * rWorld) continue; // genuinely ambiguous — skip
              const winner = sphereSurface < segDepth ? "sphere" : "ribbon";
              // the 5×5 patch must not straddle the winner-flip BOUNDARY
              // (pixels past the intersection curve legitimately belong to
              // the other surface): re-derive the winner at the patch
              // corners; any disagreement → skip this crossing
              let uniform = true;
              for (const [ox, oy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) {
                const qx = cx + ox, qy = cy + oy;
                let tq = ((qx - A.x) * dx + (qy - A.y) * dy) / L2;
                tq = Math.min(1, Math.max(0, tq));
                const segQ = A.depth + tq * (B.depth - A.depth);
                const dWq = Math.hypot(pr.x - qx, pr.y - qy) * pr.depth / pw;
                const surfQ = dWq >= rWorld
                  ? Infinity
                  : pr.depth - Math.sqrt(rWorld * rWorld - dWq * dWq);
                if ((surfQ < segQ ? "sphere" : "ribbon") !== winner) { uniform = false; break; }
              }
              if (!uniform) continue;
              out.push({ x: cx, y: cy, winner, near: sep < rWorld });
            }
          }
          return out;
        })()`);
        const pick =
          found.find((c) => c.winner === wanted) ??
          (wanted === "any" ? found[0] : found.find((c) => kinds()[c.winner] < 2));
        if (pick) crossings.push({ f, ...pick });
      }
      const mix = kinds();
      check(`S44 v${variant}: (data precondition) BOTH halves of the matrix found — sphere-wins AND ribbon-wins, in motion`,
        crossings.length >= 3 && mix.sphere >= 1 && mix.ribbon >= 1,
        JSON.stringify({ mix, crossings: crossings.map((c) => ({ f: c.f, w: c.winner, near: c.near })) }));
      let logLine = "";
      for (const c of crossings) {
        await seekTo(c.f);
        const b64 = await d.captureB64(`${REPORT}/S44_v${variant}_f${c.f}.png`);
        const patch = await d.evaluate<{ red: number; blue: number }>(`(async () => {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${b64}"; });
          const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
          const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
          const px = g.getImageData(${Math.round(c.x) - 2}, ${Math.round(c.y) - 2}, 5, 5).data;
          let red = 0, blue = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i] > px[i+1] + 60 && px[i] > px[i+2] + 60) red++;
            if (px[i+2] > px[i] + 60 && px[i+2] > px[i+1] + 40) blue++;
          }
          return { red, blue };
        })()`);
        // Asymmetric on purpose: the sphere SURFACE is modelled exactly
        // (analytic bulge), so a sphere-wins patch tolerates ZERO enemy
        // pixels — any red inside it is a real depth artifact (variant 1's
        // recorded mis-sorts are exactly that). The RIBBON is modelled at
        // AXIS depth, but the band TILTS (its plane's depth varies across
        // the width — both variants render the same few enemy pixels where
        // the band recedes), so ribbon-wins asserts DOMINANCE, not purity.
        // KNOWN LIMIT (deliberate): dominance is a WEAKER gate than its
        // sphere-wins twin — a ribbon-side depth bug leaking a FEW pixels
        // could pass 16/5. The assertion is only as strong as the model
        // earns; if a ribbon-side defect is ever suspected, TIGHTEN THIS
        // RATIO FIRST (model the band's tilt, then assert exclusivity).
        const correct = c.winner === "sphere"
          ? patch.blue > 0 && patch.red === 0
          : patch.red >= 12 && patch.red > 3 * patch.blue;
        if (assertive) {
          check(`S44 v2: CROSSING f${c.f} — the ${c.winner} is closer and OWNS the pixel${c.near ? " (near-depth)" : ""}`,
            correct, `expected ${c.winner}, patch=${JSON.stringify(patch)}`);
        } else {
          logLine += ` f${c.f}:${c.winner}${c.near ? "~" : ""}=${correct ? "OK" : "MIS-SORT"}(${patch.red}r/${patch.blue}b)`;
        }
      }
      if (!assertive) {
        console.log(`  [INFO] S44 v1 recorded outcomes:${logLine || " (none)"}`);
        check("S44 v1: the scene RENDERS under the non-default variant (both variants build)",
          crossings.length >= 2);
      }
    }, 1180, 780, `/?depthVariant=${variant}`);
  }
}

// ====== S45: figures — the letterboxed mapping is the gate (produces: figure) =
// The HEAVY bar: frame↔pixel through the contain-fitted content rect,
// asserted NUMERICALLY (marker at the computed x, click seeks the computed
// frame, resize recomputes — the silent-misalignment class). The LIGHT
// bar: the hermetic 64×32 PNG patch-samples its known color. All payloads
// come from the scripted stub (figure-demo / figure-bad) — matplotlib is
// never involved in this lane.
async function S45(): Promise<void> {
  console.log("S45 — figures: letterboxed mapping, click-to-seek, resize, fail-closed");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const typeInto = async (id: string, text: string): Promise<void> => {
      const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
        const b=${el(id)}.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};
      })()`);
      await d.click(r.x, r.y);
      await d.insertText(text);
      await d.key("Enter", "Enter", 13);
    };
    const bindLines = () =>
      d.evaluate<string[]>(
        `[...document.querySelectorAll('#claude-transcript .cl-bind')].map(n=>n.textContent)`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f}`, 10000)
        .catch(() => { /* timeout falls through — downstream checks go red */ });
      await d.evaluate(`(async () => { for (let i=0;i<2;i++) await new Promise(r=>requestAnimationFrame(r)); })()`);
      await sleep(120); // the frameChanged → plotFrame relay hop
    };
    const N = 150;
    const FRAMES_AX = { bbox: [0.125, 0.25, 0.75, 0.5] as [number, number, number, number],
      xlim: [0, N - 1] as [number, number], x_is_frames: true };
    // page-side geometry, recomputed on demand (rect changes on resize)
    const geom = () => d.evaluate<{ w: number; h: number; left: number; top: number }>(
      `(()=>{ const r=${el("plot-svg")}.getBoundingClientRect();
        return { w: r.width, h: r.height, left: r.left, top: r.top }; })()`);
    const expectedMarkerVx = async (f: number): Promise<{ vx: number; clickX: number; clickY: number }> => {
      const g = await geom();
      const content = figureContentRect(g.w, g.h, 64, 32);
      const px = figureFrameToPx(f, FRAMES_AX, content);
      const span = figureAxesYSpan(FRAMES_AX, content);
      return { vx: (px / g.w) * 800, clickX: g.left + px, clickY: g.top + (span.y0 + span.y1) / 2 };
    };
    const markerVx = () => d.evaluate<number>(
      `(()=>{ const m = ${el("plot-fig-markers")}.children;
        return m.length === 1 ? Number(m[0].getAttribute('x1')) : (m.length === 0 ? -1 : -2); })()`);

    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);
    // the harness stacks the surfaces: raise the plot ONLY around plot
    // clicks (raised, it covers the claude input; lowered, clicks type)
    const plotOnTop = (on: boolean) =>
      d.evaluate(`document.getElementById('plot-harness').style.zIndex = ${on ? "'200'" : "''"}`);
    await typeInto("term-input", "/claude");
    await sleep(150);
    await typeInto("claude-input", "please figure-demo now");
    // family retrofit (harness chapter): this bind-line wait is the exact
    // class as the series/scatter ones (a persistent stub ⤷ line); it was
    // an 8000ms OUTLIER against the family value 15000 and, with no catch,
    // a timeout CRASHED the scenario (0/0 checks) instead of failing a
    // check. Match the sibling bound and fall through on timeout so a slow
    // load yields an assertable red with detail, never a crash.
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')]
        .some(n => /figure "example_figure" drawn/.test(n.textContent)) && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S45: the ⤷ line reports the figure",
      (await bindLines()).some((t) => /figure "example_figure" drawn \(64×32, 2 axes — click a frames axis to seek\)/.test(t)),
      JSON.stringify(await bindLines()));
    check("S45: the image displays; the chart furniture yields",
      await d.evaluate<boolean>(`!${el("plot-img")}.hasAttribute('hidden') &&
        ${el("plot-img")}.src.startsWith('data:image/png') &&
        ${el("plot-frame-axis")}.hasAttribute('hidden') &&
        (${el("plot-line")}.getAttribute('points') ?? '') === ''`));
    // LIGHT bar: the known solid color, sampled from the img itself
    const teal = await d.evaluate<boolean>(`(async () => {
      const img = ${el("plot-img")};
      await (img.decode ? img.decode() : Promise.resolve());
      const c = document.createElement('canvas'); c.width = 64; c.height = 32;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 32);
      const p = g.getImageData(32, 16, 1, 1).data;
      return Math.abs(p[0] - 32) < 3 && Math.abs(p[1] - 180) < 3 && Math.abs(p[2] - 170) < 3;
    })()`);
    check("S45: (content, light bar) the hermetic PNG renders its known color", teal);

    // -- THE MAPPING, numeric: marker at the computed x, one marker only --
    for (const f of [0, 74, 149]) {
      await seekTo(f);
      const want = await expectedMarkerVx(f);
      const got = await markerVx();
      check(`S45: MARKER at the computed x for frame ${f} (one marker; the static axes has none)`,
        got >= 0 && Math.abs(got - want.vx) < 0.75, `got=${got} want=${want.vx.toFixed(2)}`);
    }

    // -- click → the computed frame; static axes and letterbox bars: no seek
    await plotOnTop(true);
    const target = await expectedMarkerVx(100);
    await d.click(target.clickX, target.clickY);
    await sleep(250);
    const landed = await d.evaluate<number>(`${V}.player.frame`);
    check("S45: CLICK in the frames axes seeks the computed frame", Math.abs(landed - 100) <= 1, `landed=${landed}`);
    const g0 = await geom();
    await d.click(g0.left + 2, g0.top + 2); // far corner: letterbox/outside every bbox
    await sleep(250);
    check("S45: a click outside every frames-axes seeks NOTHING",
      Math.abs((await d.evaluate<number>(`${V}.player.frame`)) - landed) <= 1);

    // -- round-trip on screen (seek AWAY first, so the click must act) ----
    await seekTo(42);
    const rt = await expectedMarkerVx(42);
    await seekTo(140);
    await d.click(rt.clickX, rt.clickY);
    await d.waitFor(`Math.abs(${V}.player.frame - 42) <= 1`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S45: round-trip frame → marker x → click → frame within ±1",
      Math.abs((await d.evaluate<number>(`${V}.player.frame`)) - 42) <= 1,
      `landed=${await d.evaluate<number>(`${V}.player.frame`)}`);

    // -- RESIZE recomputes the content rect (the silent-drift class) ------
    await seekTo(60);
    const before = await markerVx();
    const g1 = await geom();
    await d.evaluate(`(()=>{ const b = ${el("plot-body")};
      b.style.flex = 'none'; b.style.width = '420px'; b.style.height = '160px';
      window.dispatchEvent(new Event('resize')); })()`);
    await sleep(150);
    const g2 = await geom();
    check("S45: (precondition) the resize actually changed the panel rect",
      Math.abs(g2.w - g1.w) > 10 || Math.abs(g2.h - g1.h) > 10, JSON.stringify({ g1, g2 }));
    const wantA = await expectedMarkerVx(60);
    const gotA = await markerVx();
    check("S45: RESIZE #1 — the marker recomputes to the new content rect",
      gotA >= 0 && Math.abs(gotA - wantA.vx) < 0.75 && Math.abs(gotA - before) > 0.5,
      `got=${gotA} want=${wantA.vx.toFixed(2)} before=${before}`);
    await d.evaluate(`(()=>{ const b = ${el("plot-body")};
      b.style.flex = 'none'; b.style.width = '640px'; b.style.height = '300px';
      window.dispatchEvent(new Event('resize')); })()`);
    await sleep(150);
    const wantB = await expectedMarkerVx(60);
    const gotB = await markerVx();
    check("S45: RESIZE #2 — and again at a second size",
      gotB >= 0 && Math.abs(gotB - wantB.vx) < 0.75, `got=${gotB} want=${wantB.vx.toFixed(2)}`);

    // -- zero per-frame cost: seeks move the marker, never the image ------
    const srcBefore = await d.evaluate<string>(`${el("plot-img")}.src.length + ':' + ${el("plot-img")}.src.slice(30, 60)`);
    await seekTo(20); await seekTo(90);
    check("S45: seeks never re-request or re-decode the image (src identity)",
      (await d.evaluate<string>(`${el("plot-img")}.src.length + ':' + ${el("plot-img")}.src.slice(30, 60)`)) === srcBefore);

    // -- fail-closed: the mis-declared figure leaves THIS one standing ----
    await plotOnTop(false);
    await typeInto("claude-input", "please figure-bad now");
    await d.waitFor(
      `[...document.querySelectorAll('#claude-transcript .cl-bind')].some(n => /does not overlap frames 0\\.\\.149 — not drawn/.test(n.textContent)) && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S45: the well-formed-but-wrong axes REJECTS by name",
      (await bindLines()).some((t) => /does not overlap frames 0\.\.149 — not drawn/.test(t)),
      JSON.stringify(await bindLines()));
    check("S45: …and the previous figure still displays (nothing partial, no blank)",
      await d.evaluate<boolean>(`!${el("plot-img")}.hasAttribute('hidden')`) &&
        (await markerVx()) >= 0);

    // -- kind-swap hygiene + reopen-restore -------------------------------
    await typeInto("claude-input", "please series-demo now");
    await d.waitFor(`${el("plot-img")}.hasAttribute('hidden') && !${el("plot-frame-axis")}.hasAttribute('hidden') && ${el("plot-fig-markers")}.children.length === 0 && (${el("plot-line")}.getAttribute('points') ?? '').length > 0 && !document.getElementById('claude-input').disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S45: a series replaces the figure (img hidden, furniture back)",
      await d.evaluate<boolean>(`${el("plot-img")}.hasAttribute('hidden') &&
        !${el("plot-frame-axis")}.hasAttribute('hidden') &&
        ${el("plot-fig-markers")}.children.length === 0 &&
        (${el("plot-line")}.getAttribute('points') ?? '').length > 0`));
    await typeInto("claude-input", "please figure-demo now");
    // wait for the figure to be back AND the turn ended before dispatching
    // the reopen (plot-ready), so the re-push acts on a settled turn
    await d.waitFor(
      `!${el("plot-img")}.hasAttribute('hidden') && !${el("claude-input")}.disabled`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    await d.evaluate(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'plot-ready' } }))`);
    // the re-push → render → marker reposition is a relay envelope: poll for
    // the full asserted state (img shown AND the single figure marker
    // positioned) instead of a fixed 200ms
    await d.waitFor(
      `!${el("plot-img")}.hasAttribute('hidden') &&
        (()=>{ const m = ${el("plot-fig-markers")}.children;
          return m.length === 1 && Number(m[0].getAttribute('x1')) >= 0; })()`, 15000)
      .catch(() => { /* timeout falls through — the check below goes red */ });
    check("S45: plot-ready re-pushes the held figure (reopen restores)",
      await d.evaluate<boolean>(`!${el("plot-img")}.hasAttribute('hidden')`) &&
        (await markerVx()) >= 0);
  }, 1180, 780, "/terminal");
}

// ==================== S46: produced channels — the mod→channel pipe ============
// B-3 end to end on the REAL pipe (synthetic source, real serve.py through the
// broker): a mod DECLARES a per-point-per-frame vector channel mid-session, it
// becomes bindable with NO reload, drives an axis, animates across a flip, and
// one undo removes the binding — plus the two seams the ruling owed: S2 (a
// cached frame read after the declaration converges to the new block) and the
// assert-unreachable counter (debug.missingBoundBlockHits stays 0). S39 proves
// the SAME orientation seam on the FIXTURE's `flow`; S46 proves the channel can
// instead be PRODUCED by a mod and reach the identical machinery.
async function S46(): Promise<void> {
  console.log("S46 — produced channels: a mod declares a bindable channel mid-session");
  await withDriver(async (d) => {
    const el = (id: string) => `document.getElementById(${JSON.stringify(id)})`;
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const missBlocks = () => d.evaluate<number>(`${V}.debug.missingBoundBlockHits()`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    // async mod outcome lines ride the commandResult id:-1 channel
    await d.evaluate(`void (window.__lines = [],
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'commandResult' && e.data.id === -1) window.__lines.push(e.data);
      }))`);
    const lastAsync = () =>
      d.evaluate<{ status: string; message: string } | null>(`window.__lines.at(-1) ?? null`);
    const someAsync = (reStr: string) =>
      d.evaluate<boolean>(`window.__lines.some(l => ${reStr}.test(l.message))`);

    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);

    // -- the channel does NOT exist until the mod runs -------------------------
    const preBind = await cmd("bind all flow_dir orientation");
    check("S46: binding an undeclared channel is refused (it doesn't exist yet)",
      preBind.status === "error", JSON.stringify(preBind));

    // cache a chunk that is OLD-shape (no produced block) so the S2 seam has a
    // pre-declaration cached frame to converge; frame 40 lives in a later chunk
    await seekTo(40);
    await seekTo(0);

    // -- run the shipped channel_flow mod → it DECLARES a vector channel -------
    const run = await cmd("channel_flow all");
    check("S46: the channel mod acknowledges and hands off",
      run.status === "ok", JSON.stringify(run));
    await d.waitFor(`window.__lines.some(l => /declared vector channel "flow_dir"/.test(l.message))`, 20000)
      .catch(() => { /* timeout → the check below goes red */ });
    check("S46: the async line reports a DECLARED, bindable channel (no reload)",
      await someAsync(`/channel_flow → declared vector channel "flow_dir" — bindable now/`),
      JSON.stringify(await lastAsync()));
    check("S46: a coherent channel declares WITHOUT a coherence warning",
      !(await someAsync(`/⚠/`)), JSON.stringify(await lastAsync()));

    // -- the `channels` verb lists it LIVE (the exact source get_context reads,
    //    proving a mid-session channel is visible to the assistant at once) ---
    const chans = await cmd("channels");
    check("S46: `channels` lists the produced channel live (per-frame vector)",
      /flow_dir — vector \(3-wide\) · per-frame/.test(chans.message), chans.message);

    // -- it is bindable IMMEDIATELY, same machinery as a header channel --------
    const bind = await cmd("bind all flow_dir orientation");
    check("S46: the produced channel binds to orientation with no reload",
      bind.status === "ok" && /orientation/.test(bind.message), JSON.stringify(bind));
    check("S46: bindings lists the produced channel's row",
      /flow_dir → orientation on "all"/.test((await cmd("bindings")).message),
      (await cmd("bindings")).message);
    check("S46: `channels` now flags the produced channel as bound",
      /flow_dir .* · bound/.test((await cmd("channels")).message),
      (await cmd("channels")).message);

    // -- it drives the axis and ANIMATES across a frame flip -------------------
    const oriAt = (f: number) =>
      d.evaluate<number[]>(`(()=>{ const b=${V}.rep.state.orientation;
        return [b[0], b[1], b[2], b[3*10], b[3*10+1], b[3*10+2]]; })()`);
    await seekTo(10);
    const o10 = await oriAt(10);
    check("S46: the bound axis re-derives from the produced channel (non-zero)",
      o10.some((x) => x !== 0), JSON.stringify(o10));
    await seekTo(40);
    const o40 = await oriAt(40);
    check("S46: the produced channel ANIMATES — the buffer differs at another frame",
      o10.some((x, i) => Math.abs(x - o40[i]) > 1e-6), `f10=${JSON.stringify(o10)} f40=${JSON.stringify(o40)}`);

    // -- the S2 seam: the pre-declaration cached frame converged, and the
    //    assert-unreachable counter never fired (invalidate-on-declare +
    //    the request-epoch belt keep the missing-block arm unreachable) ------
    check("S46: assert-unreachable HOLDS — no bound flip ever hit a missing block",
      (await missBlocks()) === 0, `missingBoundBlockHits=${await missBlocks()}`);

    // -- one undo removes the binding; the produced channel stays declared -----
    const depBeforeUndo = await undoDepth();
    check("S46: the bind recorded exactly one undo stroke", depBeforeUndo >= 1);
    await d.evaluate(`document.getElementById('term-input')?.blur()`);
    await d.ctrlZ();
    await rafs();
    check("S46: one undo releases the binding",
      !/flow_dir → orientation/.test((await cmd("bindings")).message),
      (await cmd("bindings")).message);
    // re-binding still works — the channel is still declared (data outlives the bind)
    const rebind = await cmd("bind all flow_dir orientation");
    check("S46: the channel is still declared after undo (re-bind succeeds)",
      rebind.status === "ok", JSON.stringify(rebind));
    check("S46: still no missing-block hit after the whole lifecycle",
      (await missBlocks()) === 0, `missingBoundBlockHits=${await missBlocks()}`);
  }, 1180, 780, "/terminal");
}

// ==================== S47: mod parameters end to end ==========================
// P-1 on the REAL wire (synthetic source through serve.py, no stub): a
// per-point-scalar mod DECLARES a `gamma` parameter; `?gamma=` reaches compute
// (a different gamma yields a different color buffer — the parameter genuinely
// crossed the wire and the producer called a THREE-arg compute), an omitted
// parameter takes its default, and a wrong-typed / unknown / duplicate parameter
// fails closed in the invocation parser BEFORE the producer runs. This is the
// ?-split → wire → producer arity gate → bind chain, end to end.
async function S47(): Promise<void> {
  console.log("S47 — mod parameters: ?gamma reaches compute through the real wire");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const readColor = () => d.evaluate<number[]>(`Array.from(${V}.rep.state.color)`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    await d.evaluate(`void (window.__lines = [],
      window.addEventListener('message', (e) => {
        if (e.data?.type === 'commandResult' && e.data.id === -1) window.__lines.push(e.data);
      }))`);
    const asyncCount = () => d.evaluate<number>(`window.__lines.length`);
    const lastAsync = () =>
      d.evaluate<{ status: string; message: string } | null>(`window.__lines.at(-1) ?? null`);
    // run a parameterized mod and WAIT for its async outcome line (a new one, so
    // the second/third runs don't read a stale buffer) + a few frames.
    const runAndWait = async (text: string): Promise<{ status: string; message: string }> => {
      const before = await asyncCount();
      const r = await cmd(text);
      await d.waitFor(`window.__lines.length > ${before}`, 20000).catch(() => {});
      await rafs();
      return r;
    };

    await d.evaluate(`${V}.setPlaying(false)`);

    // gamma = 1 (linear ramp)
    const r1 = await runAndWait("param_scale all ?gamma=1");
    check("S47: a parameterized mod acknowledges and hands off", r1.status === "ok", JSON.stringify(r1));
    check("S47: the async outcome reports a successful bind",
      (await lastAsync())?.status === "ok", JSON.stringify(await lastAsync()));
    const c1 = await readColor();

    // gamma = 2 (quadratic) — the SAME target, ONLY the parameter changed
    await runAndWait("param_scale all ?gamma=2");
    const c2 = await readColor();
    check("S47: a different gamma yields a different buffer — the parameter reached compute",
      c1.length === c2.length && c1.some((x, i) => Math.abs(x - c2[i]) > 1e-6),
      "gamma=1 and gamma=2 produced identical buffers");

    // omitted → the header default (gamma 1.0) reproduces the gamma=1 buffer
    await runAndWait("param_scale all");
    const cDef = await readColor();
    check("S47: an omitted parameter takes its default (reproduces gamma=1)",
      cDef.length === c1.length && cDef.every((x, i) => Math.abs(x - c1[i]) < 1e-6),
      "the default did not reproduce gamma=1");

    // fail closed BEFORE the producer — a bad type, an unknown name, a duplicate
    const badType = await cmd("param_scale all ?gamma=abc");
    check("S47: a wrong-typed parameter fails closed by name (never reaches the producer)",
      badType.status === "error" && /gamma.*number/.test(badType.message), JSON.stringify(badType));
    const unknown = await cmd("param_scale all ?bogus=1");
    check("S47: an unknown parameter fails closed",
      unknown.status === "error" && /unknown parameter "bogus"/.test(unknown.message), JSON.stringify(unknown));
    const dup = await cmd("param_scale all ?gamma=1 ?gamma=2");
    check("S47: a duplicate parameter fails closed",
      dup.status === "error" && /given twice/.test(dup.message), JSON.stringify(dup));
  }, 1180, 780, "/terminal");
}

// ==================== S48: requires-channel sequencing (P-3) ==================
// A consumer that declares `# requires-channel: flow_dir` runs the shipped
// channel_flow provider FIRST (one invocation instead of two), on the REAL wire.
// The HEAVY assertion is the partial-state: provider succeeds → consumer FAILS →
// the channel STAYS declared (append-only, not undoable), the message says so,
// and the undo stack reflects it (zero — nothing undoable was written). Plus the
// direct path (channel already live → no re-run) and a missing provider (refused
// before anything executes). Fixtures live in a TEMP mods dir (E2E_MODS_DIR), so
// nothing here touches the real .molaro/mods (same discipline as S29).
async function S48(): Promise<void> {
  console.log("S48 — requires-channel: provider-then-consumer, the partial-state limit, missing provider");
  const modsDir = mkdtempSync(join(tmpdir(), "molaro-s48-mods-"));
  try {
    copyFileSync(join(".molaro/mods", "channel_flow.py"), join(modsDir, "channel_flow.py"));
    // a consumer that REQUIRES flow_dir; `?bad=true` returns out-of-[0,1] values
    // so its per-point-scalar bind FAILS (the partial-state trigger).
    writeFileSync(join(modsDir, "flow_probe.py"), [
      "# molaro-mod", "# name: flow_probe", "# kind: analysis",
      "# produces: per-point-scalar", "# axis: color", "# requires-channel: flow_dir",
      "# param: bad boolean false", "",
      "def compute(data, target_indices, params):",
      "    if params['bad']:",
      "        return [2.0] * len(target_indices)  # out of [0,1] -> validation FAILS",
      "    return [0.5] * len(target_indices)", "",
    ].join("\n"));
    // a consumer whose required channel has NO provider — refused before running.
    writeFileSync(join(modsDir, "orphan.py"), [
      "# molaro-mod", "# name: orphan", "# kind: analysis",
      "# produces: per-frame-series", "# requires-channel: nonexistent", "",
      "def compute(data, target_indices):", "    return [1.0]", "",
    ].join("\n"));
    // a SECOND provider (scalar channel `heat`) + a COMMANDS consumer that
    // requires it and whose macro FAILS — proves the partial-state note fires on
    // the commands path too (its own fresh channel, so the provider sequences).
    writeFileSync(join(modsDir, "heat_provider.py"), [
      "# molaro-mod", "# name: heat_provider", "# kind: analysis",
      "# produces: channel", "# channel: heat", "",
      "def compute(data, target_indices):",
      "    h = data.give_header(); n, t = h.n_points, h.n_frames",
      "    return {'values': [0.5] * (n * t), 'components': 1}", "",
    ].join("\n"));
    writeFileSync(join(modsDir, "heat_cmd.py"), [
      "# molaro-mod", "# name: heat_cmd", "# kind: analysis",
      "# produces: commands", "# requires-channel: heat", "",
      "def compute(data, target_indices):",
      "    return ['not_a_real_verb all']  # macro pre-validation FAILS", "",
    ].join("\n"));
    process.env.E2E_MODS_DIR = modsDir;

    await withDriver(async (d) => {
      const cmd = (text: string) =>
        d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
      const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
      const rafs = () => d.evaluate(`(async () => { for (let i=0;i<3;i++) await new Promise(r=>requestAnimationFrame(r)); })()`);
      await d.evaluate(`void (window.__lines = [],
        window.addEventListener('message', (e) => {
          if (e.data?.type === 'commandResult' && e.data.id === -1) window.__lines.push(e.data);
        }))`);
      const someLine = (reStr: string) => d.evaluate<boolean>(`window.__lines.some(l => ${reStr}.test(l.message))`);
      const asyncCount = () => d.evaluate<number>(`window.__lines.length`);
      const runWait = async (text: string, minNew = 1): Promise<{ status: string; message: string }> => {
        const before = await asyncCount();
        const r = await cmd(text);
        await d.waitFor(`window.__lines.length >= ${before + minNew}`, 20000).catch(() => {});
        await rafs();
        return r;
      };

      await d.evaluate(`${V}.setPlaying(false)`);

      // -- STEP A (HEAVY): flow_dir is NOT live → the provider runs FIRST, then
      //    the consumer FAILS → partial state: the channel STAYS declared. ------
      const notLive = await cmd("channels");
      check("S48: flow_dir is not live before the requiring mod runs",
        !/flow_dir/.test(notLive.message), notLive.message);
      const depth0 = await undoDepth();
      await cmd("flow_probe all ?bad=true");
      // the async chain ends with the partial-state note — wait for THAT so all
      // four lines (provider-first, provider-declared, consumer-error, note) exist
      await d.waitFor(`window.__lines.some(l => /REMAINS declared/.test(l.message))`, 20000).catch(() => {});
      await rafs();
      check("S48: the provider ran FIRST (one invocation, not two)",
        await someLine(`/flow_probe needs channel "flow_dir" — running provider "channel_flow" first/`),
        JSON.stringify(await d.evaluate(`window.__lines.map(l=>l.message)`)));
      check("S48: the required channel WAS declared by the provider",
        /flow_dir — vector/.test((await cmd("channels")).message), (await cmd("channels")).message);
      check("S48: the consumer FAILED (out-of-[0,1] values, nothing bound)",
        await someLine(`/flow_probe failed:.*\\[0,1\\]/`), "no consumer-failure line");
      check("S48: the PARTIAL-STATE note fired — channel remains declared, sequencing is not atomicity",
        await someLine(`/channel "flow_dir".*REMAINS declared.*sequencing is not atomicity/`),
        "no partial-state note");
      check("S48: the channel declaration is NOT undoable — the undo stack is unchanged (nothing to undo)",
        (await undoDepth()) === depth0, `depth ${depth0} → ${await undoDepth()}`);

      // -- STEP B: flow_dir is now LIVE → the consumer runs DIRECTLY (no re-run),
      //    and with valid values it SUCCEEDS. --------------------------------------
      const before = await asyncCount();
      const rB = await runWait("flow_probe all ?bad=false", 1);
      check("S48: the second invocation is accepted (target resolves, params valid)", rB.status === "ok", JSON.stringify(rB));
      const newLines = await d.evaluate<string[]>(`window.__lines.slice(${before}).map(l=>l.message)`);
      check("S48: no provider-first line the second time (channel was already live)",
        !newLines.some((m) => /running provider/.test(m)), JSON.stringify(newLines));
      check("S48: the consumer succeeded (a bind landed)",
        newLines.some((m) => /flow_probe → colored/.test(m)), JSON.stringify(newLines));

      // -- STEP C: a required channel with NO provider is refused BEFORE running. --
      const cBefore = await asyncCount();
      const rC = await cmd("orphan all");
      // the refusal rides the async outcome (id:-1); wait for it
      await d.waitFor(`window.__lines.length > ${cBefore}`, 20000).catch(() => {});
      check("S48: a missing provider is refused, naming the channel, nothing run",
        await someLine(`/orphan:.*channel "nonexistent".*no registered mod declares it/`),
        JSON.stringify(rC));

      // -- STEP D: the partial-state note ALSO fires for a COMMANDS consumer whose
      //    macro fails after a provider was sequenced (the fresh `heat` channel). -
      const notLiveHeat = await cmd("channels");
      check("S48: heat is not live before heat_cmd runs", !/^heat /m.test(notLiveHeat.message) && !/\bheat —/.test(notLiveHeat.message), notLiveHeat.message);
      await cmd("heat_cmd all");
      await d.waitFor(`window.__lines.some(l => /REMAINS declared/.test(l.message) && /heat/.test(l.message))`, 20000).catch(() => {});
      await rafs();
      check("S48: the commands consumer sequenced its provider first",
        await someLine(`/heat_cmd needs channel "heat" — running provider "heat_provider" first/`), "no provider-first line for heat_cmd");
      check("S48: heat WAS declared by its provider",
        /heat — scalar/.test((await cmd("channels")).message), (await cmd("channels")).message);
      check("S48: the commands macro FAILED (an invalid command, nothing written)",
        await someLine(`/heat_cmd → .*(not_a_real_verb|invalid|Nothing ran)/`), "no macro-failure line");
      check("S48: PARTIAL-STATE note fires for the FAILED COMMANDS consumer too (the review fix)",
        await someLine(`/channel "heat" was declared by "heat_provider" and REMAINS declared/`),
        "the commands-consumer partial-state note did not fire");
    }, 1180, 780, "/terminal");
  } finally {
    delete process.env.E2E_MODS_DIR;
    rmSync(modsDir, { recursive: true, force: true });
  }
}

// ============================ runner ==========================================
const which = process.argv.slice(2);
// ==================== S49: the hold gesture ==================================
// The only surface shipped in the last two nights with no pinned test, and it is
// an INPUT surface — the blast radius is every matching event.
//
// It exercises the REAL default-resolution path on purpose. The harness serves its
// own page rather than renderHtml, so window.__VIEWER__ carries no holdCommand and
// the webview falls through to DEFAULT_HOLD_COMMAND — the same fallback the product
// uses if the host ever omits the setting. The expected string is IMPORTED from the
// source rather than written out here, so this pins the single-sourced default
// instead of pinning a copy of it (a copy would pass while the two drifted).
/** Comfortably past the product's dwell, derived from it rather than guessed —
 * a hardcoded wait would pass while the two drifted apart. */
const HOLD_WAIT = HOLD_MS + 250;
async function S49(): Promise<void> {
  console.log("S49 — the hold gesture: dwell, indication, cancel, refusal, newest-wins, one command path");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const status = () => d.evaluate<string>(`document.getElementById("status")?.textContent ?? ""`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const centre = await d.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector("canvas").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const hover = (x: number, y: number) =>
      d.evaluate(`window.dispatchEvent(new PointerEvent("pointermove",{clientX:${x},clientY:${y},bubbles:true}))`);
    const holdDown = () => d.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown",{key:"f",bubbles:true}))`);
    const holdUp = () => d.evaluate(`window.dispatchEvent(new KeyboardEvent("keyup",{key:"f",bubbles:true}))`);

    // -- the template actually in force is the single-sourced default ----------
    check("S49: the harness injects no template, so the REAL default-resolution path runs",
      (await d.evaluate<string>(`String((window.__VIEWER__ && window.__VIEWER__.holdCommand) ?? "(absent)")`)) === "(absent)");

    // -- a point in NO committed selection refuses, visibly --------------------
    // Boot commits NOTHING now (the auto-seeded bulk selections are gone), so
    // "no selection" is already true at startup; the delete-all sweep stays as
    // defensive construction — this check must never again pass by resolving
    // to a selection nobody made.
    await d.evaluate(`(() => {
      const m = ${V}.model;
      for (const c of [...m.committed()]) m.deleteSelection(c.id);
    })()`);
    check("S49: (setup) no committed selections remain",
      (await d.evaluate<number>(`${V}.model.committed().length`)) === 0);
    await hover(centre.x, centre.y);
    await holdDown();
    await sleep(80);
    const refusal = await status();
    check("S49: a point in no committed selection REFUSES, and says so",
      /no committed selection|nothing under the pointer/.test(refusal), refusal);
    const depthAfterRefusal = await undoDepth();
    await holdUp();
    await sleep(HOLD_WAIT);
    check("S49: …and nothing ran — a refusal is not a silent no-op",
      (await undoDepth()) === depthAfterRefusal);

    // -- with a selection: the dwell SHOWS the resolving target before firing ---
    const made = await cmd("create_sele all [held]"); // `all` covers whatever is under the cursor
    check("S49: (setup) a committed selection exists", made.status === "ok", JSON.stringify(made));
    await hover(centre.x, centre.y);
    const before = await undoDepth();
    await holdDown();
    await sleep(80);
    const during = await status();
    check("S49: the dwell NAMES the command and the resolved target before firing",
      /hold to run:/.test(during) && /@/.test(during), during);
    check("S49: …and it is the single-sourced default template, not a copy",
      during.includes(DEFAULT_HOLD_COMMAND.split(" ")[0]), `${during} vs ${DEFAULT_HOLD_COMMAND}`);
    check("S49: nothing has run yet — the dwell has not elapsed", (await undoDepth()) === before);

    // -- it fires through the command path -------------------------------------
    await sleep(HOLD_WAIT);
    const fired = await status();
    check("S49: the dwell FIRES and reports the command's own outcome",
      /→/.test(fired) && !/hold to run:/.test(fired), fired);
    check("S49: a camera-only template records NO undo entry (it went through the command path, which decides that)",
      (await undoDepth()) === before, `depth ${before} → ${await undoDepth()}`);
    await holdUp();

    // -- move-off cancels -------------------------------------------------------
    await hover(centre.x, centre.y);
    const preCancel = await undoDepth();
    await holdDown();
    await sleep(60);
    await hover(centre.x + 120, centre.y + 120);
    const cancelled = await status();
    check("S49: moving the pointer CANCELS the dwell, and says so",
      /cancel/i.test(cancelled), cancelled);
    await sleep(HOLD_WAIT);
    check("S49: …and nothing ran after the cancel",
      (await undoDepth()) === preCancel && !/→/.test(await status()));
    await holdUp();

    // -- several selections: the NEWEST wins, and its name is the one shown -----
    // Both must actually CONTAIN the point under the cursor, so the target is the
    // picked index rather than a category that may not cover it — the first
    // version of this check asserted newest-wins while the newer selection did not
    // contain the point at all, and passed nothing.
    // `all` necessarily contains whatever is under the cursor, so both selections
    // genuinely overlap it without the test needing to pick the point itself.
    const first = await cmd("create_sele all [older]");
    const second = await cmd("create_sele all [newer]");
    check("S49: (setup) two overlapping selections, newest last",
      first.status === "ok" && second.status === "ok", JSON.stringify([first, second]));
    await hover(centre.x, centre.y);
    await holdDown();
    await sleep(80);
    const ambiguous = await status();
    check("S49: with several selections over the point, the NEWEST is resolved and displayed",
      /@newer/.test(ambiguous), ambiguous);
    await holdUp();
  });
}

// ==================== S50: background <color> ================================
// The targetless scene-background primitive: one color token drives BOTH sinks
// (scene.background + the renderer clear color), rides the ONE undo stack
// (one Ctrl+Z per background, LIFO), and fails quietly (error result, no
// write, no stroke). Pixel proofs sample an EMPTY spot (the S3 scan) so the
// patch reads pure background; the debug seam (sRGB hex) is asserted EXACTLY.
async function S50(): Promise<void> {
  console.log("S50 — background <color>: both sinks, seam + pixels, LIFO undo, quiet errors");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const seam = () => d.evaluate<string>(`${V}.debug.background()`);
    // settle-before-capture (the load-immunity rule): the write lands in scene
    // state instantly, but a pixel read is only honest after frames DREW it
    const settle = () =>
      d.evaluate(`(async () => {
        for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
      })()`);
    // the S3 empty-spot scan: a pixel showing pure background, no geometry
    const empty = await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const r=document.getElementById('app').getBoundingClientRect();
      const spots=[[r.left+20,r.bottom-20],[r.left+20,r.top+80],[r.right-20,r.bottom-20]];
      for (const [x,y] of spots) if (${V}.debug.pick(x,y) < 0) return {x,y};
      return null;
    })()`);
    check("S50: found an empty pixel to sample", empty !== null);
    // a 2×2 patch at the empty spot, every pixel within ±3 of the expected RGB
    const patch = (rgb: [number, number, number]) =>
      d.samplePatch({
        centerExpr: `({x:${empty!.x},y:${empty!.y}})`,
        half: 1,
        classify: `Math.abs(r-${rgb[0]})<=3 && Math.abs(g-${rgb[1]})<=3 && Math.abs(b-${rgb[2]})<=3`,
      });

    // -- baseline: the shipped default, seam and pixels agreeing ---------------
    const base = await undoDepth();
    check("S50: the seam reads the default background", (await seam()) === "1e1e1e", await seam());
    if (empty) {
      await settle();
      const p0 = await patch([30, 30, 30]);
      check("S50: baseline pixels ARE the default (30,30,30)±3", p0.count === 4, `${p0.count}/4`);
    }

    // -- background navy: ok, one undo entry, both reads flip ------------------
    const navy = await cmd("background navy");
    check("S50: background navy → ok", navy.status === "ok", JSON.stringify(navy));
    check("S50: …one undo entry", (await undoDepth()) === base + 1,
      `depth ${await undoDepth()} vs base ${base}`);
    check("S50: …seam reads navy exactly", (await seam()) === "000080", await seam());
    if (empty) {
      await settle();
      const p1 = await patch([0, 0, 128]);
      check("S50: …pixels ARE navy (0,0,128)±3", p1.count === 4, `${p1.count}/4`);
    }

    // -- repeating the SAME color applies but records NOTHING (no hollow undo) --
    const again = await cmd("background navy");
    check("S50: repeating the current color is ok but records NO op",
      again.status === "ok" && (await undoDepth()) === base + 1,
      `depth ${await undoDepth()}`);

    // -- a second color stacks a second entry ----------------------------------
    const gold = await cmd("background gold");
    check("S50: background gold → ok, depth +2", gold.status === "ok" && (await undoDepth()) === base + 2,
      `depth ${await undoDepth()}`);
    check("S50: …seam reads gold exactly", (await seam()) === "ffd700", await seam());
    await settle();
    await d.screenshot(`${REPORT}/S50_background_gold.png`);

    // -- undo is LIFO: one Ctrl+Z per background -------------------------------
    await d.ctrlZ();
    await sleep(100);
    check("S50: Ctrl+Z steps back to navy (seam)", (await seam()) === "000080", await seam());
    check("S50: …depth +1", (await undoDepth()) === base + 1, `depth ${await undoDepth()}`);
    if (empty) {
      await settle();
      const p2 = await patch([0, 0, 128]);
      check("S50: …and the PIXELS are navy again", p2.count === 4, `${p2.count}/4`);
    }
    await d.ctrlZ();
    await sleep(100);
    check("S50: second Ctrl+Z restores the default (seam)", (await seam()) === "1e1e1e", await seam());
    check("S50: …depth back to base", (await undoDepth()) === base, `depth ${await undoDepth()}`);
    if (empty) {
      await settle();
      const p3 = await patch([30, 30, 30]);
      check("S50: …and the PIXELS are the default again", p3.count === 4, `${p3.count}/4`);
    }

    // -- the quiet-error paths: error result, no write, no stroke --------------
    for (const bad of ["background", "background notacolor", "background navy extra"]) {
      const r = await cmd(bad);
      check(`S50: \`${bad}\` errors quietly`,
        r.status === "error" && (await undoDepth()) === base && (await seam()) === "1e1e1e",
        `${r.status} depth=${await undoDepth()} seam=${await seam()}`);
    }
  });
}

// ==================== S51: the OFFSET axis — shown = raw + offset =============
// The second vector axis (vector-on-POINT; orientation is vector-on-vertex):
// a bound 3-wide channel DISPLACES the drawn positions. The claims:
//   A  UNBOUND PAYS ZERO — the position path is the byte-identical zero-copy
//      chunk subarray (buffer identity, no allocation), undo stack flat
//   B  the gate refusals name the offset axis; bake refuses it (bind-only)
//   C  PARTIAL application — shown = raw + offset for covered points, = raw
//      EXACTLY for uncovered; re-derived live across seeks; applied visibly
//      while PAUSED (the write-cadence refresh)
//   D  cross-buffer isolation (the S39 discipline): offset flips touch no
//      style buffer, no junction fill, and record NOTHING
//   E  DISPLAY ≠ MEASURE follows SHOWN — visibleBounds/projectPoint/pick all
//      compute from the displaced positions
//   F  one Ctrl+Z after bind + flips → pristine (zero-copy raw, zero buffer,
//      no binding, base depth)
//   G  pixels — a covered point RENDERS at the displaced location
//   H  the RULING: unbind ZEROES (recorded) — positions snap back to raw
//      immediately, one stroke; undoing the unbind restores the binding AND
//      the displacement, and the restored binding is LIVE again
async function S51(): Promise<void> {
  console.log("S51 — the offset axis: shown = raw + offset, unbind zeroes");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    const vers = () =>
      d.evaluate<{ p: { color: number; size: number; opacity: number };
                   e: { sizeA: number; sizeB: number };
                   t: { radius: number; color: number } }>(
        `({ p: ${V}.repAttrVersions(), e: ${V}.edgeAttrVersions(), t: ${V}.traceAttrVersions() })`);
    // THE ZERO-COPY IDENTITY: inactive offset must repoint the attribute at
    // the chunk's own buffer (no allocation, no copy) — asserted by buffer
    // IDENTITY and exact byte offset, not by value equality.
    const zeroCopy = () => d.evaluate<boolean>(`(()=>{
      const f = ${V}.player.frame;
      const chunk = ${V}.player.getFrame(f);
      if (!chunk) return false;
      const arr = ${V}.positionAttr.array;
      const off = (f - chunk.start) * 6000 * 3;
      return arr.buffer === chunk.positions.buffer &&
        arr.byteOffset === chunk.positions.byteOffset + off * 4 &&
        arr.length === 6000 * 3;
    })()`);
    // shown ≡ raw + offset at the DISPLAYED frame: covered spot points carry
    // raw + their own flow vector (float32-rounded); uncovered points equal
    // raw EXACTLY. Straight from the same chunk data the flip read.
    const shownState = () => d.evaluate<{ covOk: boolean; uncovOk: boolean; detail: string }>(`(()=>{
      const f = ${V}.player.frame;
      const chunk = ${V}.player.getFrame(f);
      const arr = ${V}.positionAttr.array;
      const off = (f - chunk.start) * 6000 * 3;
      const flow = chunk.channels.get("flow");
      let covOk = true, uncovOk = true, detail = "f=" + f;
      for (const p of [0, 7, 150, 199]) {
        for (let c = 0; c < 3; c++) {
          const want = Math.fround(chunk.positions[off + p*3 + c] + flow[off + p*3 + c]);
          if (Math.abs(arr[p*3 + c] - want) > 1e-6) {
            covOk = false; detail += " cov p=" + p + " c=" + c;
          }
        }
      }
      for (const p of [200, 3000, 5999]) {
        for (let c = 0; c < 3; c++) {
          if (arr[p*3 + c] !== chunk.positions[off + p*3 + c]) {
            uncovOk = false; detail += " uncov p=" + p + " c=" + c;
          }
        }
      }
      return { covOk, uncovOk, detail };
    })()`);
    const offsetAllZero = () =>
      d.evaluate<boolean>(`${V}.rep.state.offset.every((x) => x === 0)`);
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const a = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
        await rafs();
        const b = await d.evaluate<number[]>(`${V}.camera.position.toArray()`);
        if (Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) < 1e-4) return;
      }
    };

    // Determinism: every check reads buffers at a specific seeked frame.
    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);

    // -- A: UNBOUND PAYS ZERO — zero-copy identity, flat undo stack --------
    const shape = await d.evaluate<{ len: number }>(`({ len: ${V}.rep.state.offset.length })`);
    check("S51: the offset buffer is per-point stride 3, zero by default",
      shape.len === 6000 * 3 && (await offsetAllZero()), JSON.stringify(shape));
    const depth0 = await undoDepth();
    check("S51: UNBOUND — the position path is the zero-copy chunk subarray", await zeroCopy());
    await seekTo(5); await seekTo(10);
    check("S51: …and stays zero-copy across seeks, undo stack flat",
      (await zeroCopy()) && (await undoDepth()) === depth0);

    // -- B: the gate refuses the wrong shapes; bake refuses offset ---------
    const refusals: [string, RegExp][] = [
      ["bind all energy offset", /offset needs a vector \(3-wide\) channel — "energy" is scalar/],
      ["bind all flow offset 0 1", /meaningless for the offset axis/],
      ["bake all flow offset", /offset is bind-only/],
    ];
    for (const [text, want] of refusals) {
      const r = await cmd(text);
      check(`S51: refusal — ${text}`, r.status === "error" && want.test(r.message), JSON.stringify(r));
    }
    check("S51: no refusal wrote or recorded anything",
      (await offsetAllZero()) && (await zeroCopy()) && (await undoDepth()) === depth0);

    // -- C: bind → partial application, visible while PAUSED, live on seek --
    const bounds0 = await d.evaluate<{ center: number[]; radius: number }>(`${V}.debug.visibleBounds()`);
    const bind = await cmd("bind #0-199 flow offset");
    check("S51: bind #0-199 flow offset is accepted and says it displaces",
      bind.status === "ok" && /displaces the drawn positions/.test(bind.message) &&
        /raw vectors/.test(bind.message),
      JSON.stringify(bind));
    check("S51: bind is exactly ONE undo stroke", (await undoDepth()) === depth0 + 1);
    check("S51: bindings lists the points · raw vectors row",
      /flow → offset on "#0-199" — 200 points · raw vectors/.test((await cmd("bindings")).message),
      (await cmd("bindings")).message);
    const paused = await shownState();
    check("S51: PAUSED APPLY — shown = raw + offset for covered, = raw for uncovered, NO flip needed",
      paused.covOk && paused.uncovOk, paused.detail);
    await seekTo(40);
    const at40 = await shownState();
    check("S51: LIVE — a seek re-derives the displacement from frame 40's vectors",
      at40.covOk && at40.uncovOk, at40.detail);
    // precondition: the two frames genuinely differ, so C discriminates
    const differ = await d.evaluate<boolean>(`(()=>{
      const a = ${V}.player.getFrame(10), b = ${V}.player.getFrame(40);
      const ax = a.channels.get("flow")[(10 - a.start) * 6000 * 3];
      const bx = b.channels.get("flow")[(40 - b.start) * 6000 * 3];
      return Math.abs(ax - bx) > 1e-4;
    })()`);
    check("S51: (data precondition) frames 10 and 40 supply different vectors", differ);

    // -- D: offset flips touch NO style buffer and record NOTHING ----------
    const vD = await vers();
    const depD = await undoDepth();
    await seekTo(50); await seekTo(60);
    const vD2 = await vers();
    check("S51: offset flips touch NO other buffer and record NOTHING (S39 discipline)",
      vD2.p.color === vD.p.color && vD2.p.size === vD.p.size && vD2.p.opacity === vD.p.opacity &&
        vD2.e.sizeA === vD.e.sizeA && vD2.e.sizeB === vD.e.sizeB &&
        vD2.t.radius === vD.t.radius && vD2.t.color === vD.t.color &&
        (await undoDepth()) === depD,
      JSON.stringify({ vD, vD2 }));

    // -- E: DISPLAY ≠ MEASURE follows SHOWN --------------------------------
    // visibleBounds' center is the MEAN of the drawn positions, so binding
    // must move it by exactly the mean displacement over the visible points
    // (computed from the offset buffer, independent of the position path).
    await seekTo(10);
    const boundsNow = await d.evaluate<{ center: number[]; radius: number }>(`${V}.debug.visibleBounds()`);
    const expectDelta = await d.evaluate<{ n: number; d: number[]; mag: number }>(`(()=>{
      const vis = ${V}.rep.state.visible, off = ${V}.rep.state.offset;
      let n = 0, dx = 0, dy = 0, dz = 0;
      for (let p = 0; p < vis.length; p++) {
        if (vis[p] > 0.5) { n++; dx += off[p*3]; dy += off[p*3+1]; dz += off[p*3+2]; }
      }
      return { n, d: [dx/n, dy/n, dz/n], mag: Math.hypot(dx/n, dy/n, dz/n) };
    })()`);
    check("S51: (data precondition) the mean visible displacement is measurable",
      expectDelta.mag > 1e-3, JSON.stringify(expectDelta));
    // bounds0 was captured at frame 10 pre-bind; boundsNow at frame 10 bound —
    // the raw positions are identical, so the center delta IS the displacement
    const boundsFollow = [0, 1, 2].every((c) =>
      Math.abs((boundsNow.center[c] - bounds0.center[c]) - expectDelta.d[c]) < 1e-3);
    check("S51: visibleBounds follows SHOWN — center moved by exactly the mean displacement",
      boundsFollow,
      JSON.stringify({ before: bounds0.center, after: boundsNow.center, want: expectDelta.d }));
    // projectPoint parity: the seam's screen position equals a manual
    // projection of raw + flow (the displaced world position)
    const parity = await d.evaluate<{ dx: number; dy: number; front: boolean }>(`(()=>{
      const f = ${V}.player.frame;
      const chunk = ${V}.player.getFrame(f);
      const off = (f - chunk.start) * 6000 * 3;
      const flow = chunk.channels.get("flow");
      const p = 150;
      const cam = ${V}.camera;
      cam.updateMatrixWorld();
      const v = cam.position.clone().set(
        chunk.positions[off + p*3] + flow[off + p*3],
        chunk.positions[off + p*3+1] + flow[off + p*3+1],
        chunk.positions[off + p*3+2] + flow[off + p*3+2]).project(cam);
      const rect = document.querySelector('#app canvas').getBoundingClientRect();
      const mx = rect.left + ((v.x + 1) / 2) * rect.width;
      const my = rect.top + ((1 - v.y) / 2) * rect.height;
      const pr = ${V}.debug.projectPoint(p);
      return { dx: Math.abs(pr.x - mx), dy: Math.abs(pr.y - my), front: pr.front };
    })()`);
    check("S51: projectPoint follows SHOWN — matches a manual raw+flow projection sub-pixel",
      parity.dx < 0.5 && parity.dy < 0.5, JSON.stringify(parity));

    // -- F: derived-not-recorded — ONE Ctrl+Z restores everything ----------
    check("S51: any amount of seeking added ZERO undo entries", (await undoDepth()) === depth0 + 1);
    await d.ctrlZ();
    await sleep(300);
    check("S51: ONE Ctrl+Z → zero buffer, zero-copy raw positions, binding gone, base depth",
      (await offsetAllZero()) && (await zeroCopy()) &&
        (await cmd("bindings")).message === "no bindings" && (await undoDepth()) === depth0);
    await seekTo(20);
    check("S51: …and a further seek does not re-displace (truly gone)", await zeroCopy());

    // -- G: PIXELS — a covered point renders at the DISPLACED location -----
    await cmd("bind #0-199 flow offset");
    await cmd("colorpoints #150 red");
    // occlusion isolation (the standing pixel-proof rule): fade every OTHER
    // element to zero — zero-alpha fragments discard, nothing occludes
    await cmd("pointopacity all 0");
    await cmd("pointopacity #150 1");
    await cmd("bondopacity all 0");
    await cmd("bondopacityof all 0");
    await cmd("traceopacity all 0");
    // find a frame where the probe's displacement is USEFULLY off the view
    // axis: after zooming to the (displaced) probe, its raw location must
    // project ≥ 60 px away, else the pixel claim cannot discriminate
    let probeFrame = -1;
    let pr: { x: number; y: number; front: boolean } | null = null;
    let rawScreen: { x: number; y: number; front: boolean; sep: number } | null = null;
    for (const f of [10, 25, 40, 55, 70]) {
      await seekTo(f);
      await d.evaluate(`${V}.zoomToPoints([150])`);
      await settle();
      await rafs();
      pr = await d.evaluate<{ x: number; y: number; front: boolean }>(`${V}.debug.projectPoint(150)`);
      rawScreen = await d.evaluate<{ x: number; y: number; front: boolean; sep: number }>(`(()=>{
        const f = ${V}.player.frame;
        const chunk = ${V}.player.getFrame(f);
        const off = (f - chunk.start) * 6000 * 3;
        const cam = ${V}.camera;
        cam.updateMatrixWorld();
        const v = cam.position.clone().set(
          chunk.positions[off + 450], chunk.positions[off + 451], chunk.positions[off + 452]).project(cam);
        const rect = document.querySelector('#app canvas').getBoundingClientRect();
        const x = rect.left + ((v.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - v.y) / 2) * rect.height;
        const pr = ${V}.debug.projectPoint(150);
        return { x, y, front: v.z < 1 && v.z > -1, sep: Math.hypot(pr.x - x, pr.y - y) };
      })()`);
      if (rawScreen.sep > 60) { probeFrame = f; break; }
    }
    check("S51: (setup) found a frame separating displaced from raw by > 60 px",
      probeFrame >= 0, JSON.stringify(rawScreen));
    // pick follows SHOWN: a click at the DISPLACED screen location hits 150
    const picked = await d.evaluate<number>(`${V}.debug.pick(${pr!.x}, ${pr!.y})`);
    check("S51: pick follows SHOWN — the displaced screen location picks the probe",
      picked === 150, `picked ${picked}`);
    const redAt = (x: number, y: number) =>
      d.samplePatch({
        centerExpr: `({x:${Math.round(x)},y:${Math.round(y)}})`,
        half: 3,
        classify: `r > g + 60 && r > b + 60`,
      });
    await rafs();
    const pxDisplaced = await redAt(pr!.x, pr!.y);
    check("S51: PIXELS — the covered point RENDERS at the displaced location",
      pxDisplaced.count > 5, JSON.stringify(pxDisplaced));
    await d.screenshot(`${REPORT}/S51_offset_displaced.png`);
    // …and NOT at the raw location (only when that location is on-canvas)
    const rawOnCanvas = await d.evaluate<boolean>(`(()=>{
      const rect = document.querySelector('#app canvas').getBoundingClientRect();
      return ${rawScreen!.front} && ${rawScreen!.x} > rect.left + 8 && ${rawScreen!.x} < rect.right - 8 &&
        ${rawScreen!.y} > rect.top + 8 && ${rawScreen!.y} < rect.bottom - 8;
    })()`);
    if (rawOnCanvas) {
      const pxRaw = await redAt(rawScreen!.x, rawScreen!.y);
      check("S51: …and NOT at the raw location", pxRaw.count === 0, JSON.stringify(pxRaw));
    }

    // -- H: the RULING — unbind ZEROES (recorded); undo restores it --------
    const depH = await undoDepth();
    const un = await cmd("unbind all offset");
    check("S51: unbind all offset says zeroed, positions return to raw",
      un.status === "ok" && /offsets zeroed, positions return to raw/.test(un.message),
      JSON.stringify(un));
    check("S51: unbind is ONE stroke", (await undoDepth()) === depH + 1);
    check("S51: …the buffer is zero and the positions SNAPPED back to zero-copy raw, while paused",
      (await offsetAllZero()) && (await zeroCopy()) &&
        !/flow → offset/.test((await cmd("bindings")).message));
    await d.evaluate(`void document.activeElement?.blur?.()`);
    await d.ctrlZ();
    await sleep(300);
    const restored = await shownState();
    check("S51: UNDOING the unbind restores the binding AND the displacement",
      restored.covOk && restored.uncovOk &&
        /flow → offset on "#0-199" — 200 points · raw vectors/.test((await cmd("bindings")).message) &&
        (await undoDepth()) === depH,
      restored.detail);
    await seekTo(probeFrame >= 0 ? (probeFrame + 15) % 140 : 30);
    const liveAgain = await shownState();
    check("S51: …and the restored binding is LIVE — it re-derives on the next seek",
      liveAgain.covOk && liveAgain.uncovOk, liveAgain.detail);
    check("S51: the missing-block arm stayed unreachable",
      (await d.evaluate<number>(`${V}.debug.missingBoundBlockHits()`)) === 0);
  });
}

// ==================== S52: the smoothing mod — FIRST offset consumer =========
// The two-mod smoothing pair over the offset axis (S51's foundation): a
// `produces: channel` provider (`smoothing`) computes a per-point-per-frame
// windowed-average DISPLACEMENT, and a `produces: commands` macro (`smooth`,
// requires-channel: smoothing) binds it to offset — one command. The claims:
//   A  invocation DECLARES the vector channel and BINDS it to offset (the P-3
//      sequence: provider first, then the macro's `bind all smoothing offset`),
//      as exactly ONE undo stroke (the bind; the declaration is not an op)
//   B  shown = raw + offset AND shown = the ±window windowed MEAN over frames —
//      the smoothing is exact, and it equals the mean for THIS window (window=7),
//      which proves the `?window=` level reached the provider's computation
//   C  the offset is nonzero over the smoothed region and EXACTLY zero outside;
//      uncovered points draw at their raw position (untouched)
//   D  jitter reduced — a covered point's peak-to-peak motion over frames is
//      strictly SMALLER than raw; an uncovered point's is identical
//   E  one Ctrl+Z reverses the bind (offset zeroed, zero-copy raw, base depth);
//      the channel stays declared (append-only, not undoable)
async function S52(): Promise<void> {
  console.log("S52 — smoothing mod: a windowed-average offset bound to the offset axis");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    // THE ZERO-COPY IDENTITY (S51's discipline): inactive offset must repoint the
    // attribute at the chunk's own buffer — buffer identity + exact byte offset.
    const zeroCopy = () => d.evaluate<boolean>(`(()=>{
      const f = ${V}.player.frame;
      const chunk = ${V}.player.getFrame(f);
      if (!chunk) return false;
      const arr = ${V}.positionAttr.array;
      const off = (f - chunk.start) * 6000 * 3;
      return arr.buffer === chunk.positions.buffer &&
        arr.byteOffset === chunk.positions.byteOffset + off * 4 &&
        arr.length === 6000 * 3;
    })()`);
    const offsetAllZero = () => d.evaluate<boolean>(`${V}.rep.state.offset.every((x) => x === 0)`);
    const channelsMsg = async () => (await cmd("channels")).message;
    const bindingsMsg = async () => (await cmd("bindings")).message;

    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);
    const depth0 = await undoDepth();

    // clean slate: neither the channel nor a binding exists yet
    check("S52: no smoothing channel or binding before invocation",
      !(await channelsMsg()).includes("smoothing") && (await bindingsMsg()) === "no bindings",
      `${await channelsMsg()} | ${await bindingsMsg()}`);

    // -- A: invoke the ONE command — smooth a region with a chosen window ------
    const WINDOW = 7; // ±7 frames → the window is [0,7] at frame 0 = exactly chunk 0
    const r = await cmd(`smooth #0-199 ?window=${WINDOW}`);
    check("S52: `smooth` acknowledges and hands off to the async producer round-trip",
      r.status === "ok" && /running smooth on 200 points/.test(r.message), JSON.stringify(r));

    // the P-3 sequence is async: the provider declares the channel, then the
    // macro binds it; then the channel's data rides refetched chunks and the
    // offset applies. Poll each stage rather than sleep.
    await d.waitFor(`${V}.command("channels").message.includes("smoothing")`, 20000);
    await d.waitFor(`${V}.command("bindings").message.includes("smoothing")`, 20000);
    await seekTo(0);
    await d.waitFor(
      `${V}.player.getFrame(0) !== null && ${V}.rep.state.offset.slice(0, 600).some((x) => Math.abs(x) > 1e-3)`,
      20000);
    await rafs();

    check("S52: `smoothing` declared as a per-frame VECTOR (3-wide) channel",
      /smoothing — vector \(3-wide\)/.test(await channelsMsg()) &&
        /smoothing.*per-frame/.test(await channelsMsg()),
      await channelsMsg());
    check("S52: it is BOUND to the offset axis over `all`",
      /smoothing → offset on "all" — 6000 points · raw vectors/.test(await bindingsMsg()),
      await bindingsMsg());
    check("S52: the whole macro is EXACTLY one undo stroke (the bind; the declaration is not an op)",
      (await undoDepth()) === depth0 + 1, `depth ${depth0} → ${await undoDepth()}`);

    // -- B/C: shown = raw + offset = windowed mean; region vs outside ----------
    // At the DISPLAYED frame 0, the ±7 window clamps to frames [0,7] — which are
    // exactly the 8 frames of chunk 0 — so the windowed mean is computable from
    // that one chunk's raw positions, independent of the offset path.
    const state = await d.evaluate<{
      rawOffOk: boolean; meanOk: boolean; covMax: number;
      uncovOffMax: number; uncovShownOk: boolean; detail: string;
    }>(`(()=>{
      const N = 6000, W = ${WINDOW};
      const chunk = ${V}.player.getFrame(0);      // frames [0, 8), start 0
      const arr = ${V}.positionAttr.array;         // shown buffer at frame 0
      const off = ${V}.rep.state.offset;
      const hi = Math.min(W, chunk.count - 1);     // = 7
      const mean = (p, c) => { let s = 0; for (let k = 0; k <= hi; k++) s += chunk.positions[k*N*3 + p*3 + c]; return s / (hi + 1); };
      let rawOffOk = true, meanOk = true, covMax = 0, uncovOffMax = 0, uncovShownOk = true, detail = "";
      for (const p of [0, 50, 120, 199]) {           // covered
        for (let c = 0; c < 3; c++) {
          const raw = chunk.positions[p*3 + c];      // frame 0 (k=0)
          const shown = arr[p*3 + c];
          if (Math.abs(shown - (raw + off[p*3 + c])) > 1e-4) { rawOffOk = false; detail += " rawoff p=" + p + " c=" + c; }
          if (Math.abs(shown - mean(p, c)) > 1e-3) { meanOk = false; detail += " mean p=" + p + " c=" + c; }
          covMax = Math.max(covMax, Math.abs(off[p*3 + c]));
        }
      }
      for (const p of [200, 3000, 5999]) {           // uncovered
        for (let c = 0; c < 3; c++) {
          uncovOffMax = Math.max(uncovOffMax, Math.abs(off[p*3 + c]));
          if (arr[p*3 + c] !== chunk.positions[p*3 + c]) uncovShownOk = false;
        }
      }
      return { rawOffOk, meanOk, covMax, uncovOffMax, uncovShownOk, detail };
    })()`);
    check("S52: shown = raw + offset for covered points (the offset axis applies the channel)",
      state.rawOffOk, state.detail);
    check("S52: shown = the ±7-frame windowed MEAN — smoothing is exact, and window=7 reached the compute",
      state.meanOk, state.detail);
    check("S52: the offset is NONZERO over the smoothed region", state.covMax > 1e-2, `covMax=${state.covMax}`);
    check("S52: the offset is EXACTLY zero outside the region", state.uncovOffMax === 0, `uncovMax=${state.uncovOffMax}`);
    check("S52: uncovered points draw at their raw position (untouched)", state.uncovShownOk);

    // -- D: jitter reduced — covered peak-to-peak SMALLER, uncovered identical -
    const covIdx = [10, 50, 120, 190], uncIdx = [3000, 5999];
    const allIdx = [...covIdx, ...uncIdx];
    const sMin: Record<number, number[]> = {}, sMax: Record<number, number[]> = {};
    const rMin: Record<number, number[]> = {}, rMax: Record<number, number[]> = {};
    for (const p of allIdx) {
      sMin[p] = [Infinity, Infinity, Infinity]; sMax[p] = [-Infinity, -Infinity, -Infinity];
      rMin[p] = [Infinity, Infinity, Infinity]; rMax[p] = [-Infinity, -Infinity, -Infinity];
    }
    for (const f of [0, 20, 40, 60]) {
      await seekTo(f);
      const sample = await d.evaluate<{ shown: number[][]; raw: number[][] }>(`(()=>{
        const N = 6000, idx = ${JSON.stringify(allIdx)};
        const chunk = ${V}.player.getFrame(${f});
        const base = (${f} - chunk.start) * N * 3;
        const arr = ${V}.positionAttr.array;         // shown at frame ${f}
        return {
          shown: idx.map((p) => [arr[p*3], arr[p*3+1], arr[p*3+2]]),
          raw: idx.map((p) => [chunk.positions[base+p*3], chunk.positions[base+p*3+1], chunk.positions[base+p*3+2]]),
        };
      })()`);
      allIdx.forEach((p, i) => {
        for (let c = 0; c < 3; c++) {
          sMin[p][c] = Math.min(sMin[p][c], sample.shown[i][c]); sMax[p][c] = Math.max(sMax[p][c], sample.shown[i][c]);
          rMin[p][c] = Math.min(rMin[p][c], sample.raw[i][c]); rMax[p][c] = Math.max(rMax[p][c], sample.raw[i][c]);
        }
      });
    }
    const ppSum = (mn: Record<number, number[]>, mx: Record<number, number[]>, ids: number[]) =>
      ids.reduce((acc, p) => acc + (mx[p][0]-mn[p][0]) + (mx[p][1]-mn[p][1]) + (mx[p][2]-mn[p][2]), 0);
    const covShownPP = ppSum(sMin, sMax, covIdx), covRawPP = ppSum(rMin, rMax, covIdx);
    check("S52: JITTER REDUCED — covered peak-to-peak motion is strictly smaller than raw",
      covShownPP < covRawPP - 1e-3, `shownPP=${covShownPP.toFixed(4)} rawPP=${covRawPP.toFixed(4)}`);
    const uncShownPP = ppSum(sMin, sMax, uncIdx), uncRawPP = ppSum(rMin, rMax, uncIdx);
    check("S52: an uncovered point's motion is UNCHANGED (its peak-to-peak equals raw)",
      Math.abs(uncShownPP - uncRawPP) < 1e-4, `shownPP=${uncShownPP.toFixed(4)} rawPP=${uncRawPP.toFixed(4)}`);
    await seekTo(0);
    await d.screenshot(`${REPORT}/S52_smoothed.png`);

    // -- E: one Ctrl+Z reverses the bind; the channel stays declared -----------
    await d.evaluate(`void document.activeElement?.blur?.()`);
    await d.ctrlZ();
    await sleep(300);
    await seekTo(0);
    check("S52: one Ctrl+Z zeroes the offset, snaps back to zero-copy raw, base depth, binding gone",
      (await offsetAllZero()) && (await zeroCopy()) &&
        !(await bindingsMsg()).includes("smoothing") && (await undoDepth()) === depth0,
      `offZero=${await offsetAllZero()} zc=${await zeroCopy()} depth=${await undoDepth()}`);
    check("S52: the smoothing CHANNEL remains declared (append-only, not undoable)",
      (await channelsMsg()).includes("smoothing"), await channelsMsg());
    await seekTo(30);
    check("S52: a further seek does not re-displace (truly unbound)", await zeroCopy());
  });
}

// ==================== S53: the delay mod — SECOND offset consumer ============
// The two-mod delay pair over the SAME offset axis (S51's foundation, S52's
// rail): a `produces: channel` provider (`delay_offset`) computes a
// per-point-per-frame LAG displacement — the vector from raw[t] to raw[t-k] —
// and a `produces: commands` macro (`delay`, requires-channel: delay_offset)
// binds it to offset in one command. It exists to PROVE the extensibility: a
// new position effect is a new mod PAIR on the identical rail, with NO engine
// change. The claims mirror S52 exactly:
//   A  invocation DECLARES the vector channel and BINDS it to offset (provider
//      first, then the macro's `bind all delay_offset offset`), as exactly ONE
//      undo stroke (the bind; the declaration is not an op)
//   B  GATHER — at a frame t with history, shown = raw + offset AND shown =
//      raw[t-k] EXACTLY (the position from k frames earlier). k=3 is NON-default
//      (the declared default is 5), so shown == raw[t-3] and not raw[t-5] proves
//      the `?frames=` level reached the provider's computation
//   C  the offset is nonzero over the delayed region and EXACTLY zero outside;
//      uncovered points draw at their raw position (untouched)
//   D  CLAMP — at a frame t < k (no history) the earliest frame is held:
//      shown = raw[0], offset = raw[0] - raw[t] (the documented edge policy)
//   E  one Ctrl+Z reverses the bind (offset zeroed, zero-copy raw, base depth);
//      the channel stays declared (append-only, not undoable)
// Single-chunk verification (S52's trick): CHUNK_FRAMES = 8, so chunk 0 is
// frames [0, 8). With k=3, the GATHER frame 7 reads raw[4] and the CLAMP frame 1
// holds raw[0] — every frame this scenario inspects (0, 1, 4, 7) lives in that
// one chunk, so raw[t] and raw[t-k] are both readable without the offset path.
async function S53(): Promise<void> {
  console.log("S53 — delay mod: a temporal-lag offset bound to the offset axis (second consumer)");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const rafs = () => d.evaluate(`(async () => {
      for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
    })()`);
    const seekTo = async (f: number): Promise<void> => {
      await d.evaluate(`${V}.player.seek(${f})`);
      await d.waitFor(`${V}.player.frame === ${f} && ${V}.player.getFrame(${f}) !== null`, 20000);
      await rafs();
    };
    // THE ZERO-COPY IDENTITY (S51's discipline): inactive offset must repoint the
    // attribute at the chunk's own buffer — buffer identity + exact byte offset.
    const zeroCopy = () => d.evaluate<boolean>(`(()=>{
      const f = ${V}.player.frame;
      const chunk = ${V}.player.getFrame(f);
      if (!chunk) return false;
      const arr = ${V}.positionAttr.array;
      const off = (f - chunk.start) * 6000 * 3;
      return arr.buffer === chunk.positions.buffer &&
        arr.byteOffset === chunk.positions.byteOffset + off * 4 &&
        arr.length === 6000 * 3;
    })()`);
    const offsetAllZero = () => d.evaluate<boolean>(`${V}.rep.state.offset.every((x) => x === 0)`);
    const channelsMsg = async () => (await cmd("channels")).message;
    const bindingsMsg = async () => (await cmd("bindings")).message;

    await d.evaluate(`${V}.setPlaying(false)`);
    await seekTo(0);
    const depth0 = await undoDepth();

    // clean slate: neither the channel nor a binding exists yet
    check("S53: no delay_offset channel or binding before invocation",
      !(await channelsMsg()).includes("delay_offset") && (await bindingsMsg()) === "no bindings",
      `${await channelsMsg()} | ${await bindingsMsg()}`);

    // -- A: invoke the ONE command — delay a region by a chosen (non-default) lag -
    const K = 3;             // NON-default (declared default is 5) → proves forwarding
    const GATHER = 7;        // t-k = 4, still in chunk 0 → history exists (the gather)
    const SRC = GATHER - K;  // = 4
    const CLAMP = 1;         // t < k → no history → hold raw[0] (the clamp)
    const r = await cmd(`delay #0-199 ?frames=${K}`);
    check("S53: `delay` acknowledges and hands off to the async producer round-trip",
      r.status === "ok" && /running delay on 200 points/.test(r.message), JSON.stringify(r));

    // the P-3 sequence is async: the provider declares the channel, then the
    // macro binds it; then the channel's data rides refetched chunks and the
    // offset applies. Poll each stage rather than sleep. Poll at GATHER (frame 7),
    // NOT frame 0 — at frame 0 the region is in its clamp (raw[0]-raw[0] = 0), so
    // its offset is legitimately zero and would never trip a nonzero poll.
    await d.waitFor(`${V}.command("channels").message.includes("delay_offset")`, 20000);
    await d.waitFor(`${V}.command("bindings").message.includes("delay_offset")`, 20000);
    await seekTo(GATHER);
    await d.waitFor(
      `${V}.player.getFrame(${GATHER}) !== null && ${V}.rep.state.offset.slice(0, 600).some((x) => Math.abs(x) > 1e-3)`,
      20000);
    await rafs();

    check("S53: `delay_offset` declared as a per-frame VECTOR (3-wide) channel",
      /delay_offset — vector \(3-wide\)/.test(await channelsMsg()) &&
        /delay_offset.*per-frame/.test(await channelsMsg()),
      await channelsMsg());
    check("S53: it is BOUND to the offset axis over `all`",
      /delay_offset → offset on "all" — 6000 points · raw vectors/.test(await bindingsMsg()),
      await bindingsMsg());
    check("S53: the whole macro is EXACTLY one undo stroke (the bind; the declaration is not an op)",
      (await undoDepth()) === depth0 + 1, `depth ${depth0} → ${await undoDepth()}`);

    // -- B/C: shown = raw + offset = raw[t-k] EXACTLY; region vs outside -------
    // At the displayed GATHER frame 7 the lag reads frame SRC = 4; both live in
    // chunk 0, so raw[7] and raw[4] are read straight from the one chunk. A
    // default-5 run would show raw[2] here, so shown == raw[4] proves frames=3.
    const state = await d.evaluate<{
      rawOffOk: boolean; gatherOk: boolean; covMax: number;
      uncovOffMax: number; uncovShownOk: boolean; detail: string;
    }>(`(()=>{
      const N = 6000;
      const chunk = ${V}.player.getFrame(${GATHER});  // chunk 0, start 0
      const arr = ${V}.positionAttr.array;             // shown buffer at frame ${GATHER}
      const off = ${V}.rep.state.offset;
      const base = (${GATHER} - chunk.start) * N * 3;  // frame ${GATHER} raw
      const srcBase = (${SRC} - chunk.start) * N * 3;  // frame ${SRC} raw = raw[t-k]
      let rawOffOk = true, gatherOk = true, covMax = 0, uncovOffMax = 0, uncovShownOk = true, detail = "";
      for (const p of [0, 50, 120, 199]) {              // covered
        for (let c = 0; c < 3; c++) {
          const rawT = chunk.positions[base + p*3 + c];
          const rawSrc = chunk.positions[srcBase + p*3 + c];
          const shown = arr[p*3 + c];
          if (Math.abs(shown - (rawT + off[p*3 + c])) > 1e-4) { rawOffOk = false; detail += " rawoff p=" + p + " c=" + c; }
          if (Math.abs(shown - rawSrc) > 1e-3) { gatherOk = false; detail += " gather p=" + p + " c=" + c; }
          covMax = Math.max(covMax, Math.abs(off[p*3 + c]));
        }
      }
      for (const p of [200, 3000, 5999]) {              // uncovered
        for (let c = 0; c < 3; c++) {
          uncovOffMax = Math.max(uncovOffMax, Math.abs(off[p*3 + c]));
          if (arr[p*3 + c] !== chunk.positions[base + p*3 + c]) uncovShownOk = false;
        }
      }
      return { rawOffOk, gatherOk, covMax, uncovOffMax, uncovShownOk, detail };
    })()`);
    check("S53: shown = raw + offset for covered points (the offset axis applies the channel)",
      state.rawOffOk, state.detail);
    check("S53: shown = raw[t-3] EXACTLY — the lag is a pure gather, and frames=3 reached the compute",
      state.gatherOk, state.detail);
    check("S53: the offset is NONZERO over the delayed region", state.covMax > 1e-2, `covMax=${state.covMax}`);
    check("S53: the offset is EXACTLY zero outside the region", state.uncovOffMax === 0, `uncovMax=${state.uncovOffMax}`);
    check("S53: uncovered points draw at their raw position (untouched)", state.uncovShownOk);

    // -- D: CLAMP — at frame 1 (< k=3, no history) the earliest frame is held ---
    await seekTo(CLAMP);
    const clamp = await d.evaluate<{ shownOk: boolean; offOk: boolean; mag: number; detail: string }>(`(()=>{
      const N = 6000;
      const chunk = ${V}.player.getFrame(${CLAMP});    // chunk 0
      const arr = ${V}.positionAttr.array;             // shown at frame ${CLAMP}
      const off = ${V}.rep.state.offset;
      const base = (${CLAMP} - chunk.start) * N * 3;   // frame ${CLAMP} raw = raw[t]
      const srcBase = 0;                                // held earliest = raw[0]
      let shownOk = true, offOk = true, mag = 0, detail = "";
      for (const p of [0, 50, 120, 199]) {
        for (let c = 0; c < 3; c++) {
          const rawT = chunk.positions[base + p*3 + c];
          const raw0 = chunk.positions[srcBase + p*3 + c];
          const shown = arr[p*3 + c];
          if (Math.abs(shown - raw0) > 1e-3) { shownOk = false; detail += " shown p=" + p + " c=" + c; }
          if (Math.abs(off[p*3 + c] - (raw0 - rawT)) > 1e-3) { offOk = false; detail += " off p=" + p + " c=" + c; }
          mag = Math.max(mag, Math.abs(raw0 - rawT));
        }
      }
      return { shownOk, offOk, mag, detail };
    })()`);
    check("S53: CLAMP — a frame before the lag holds the earliest frame: shown = raw[0]",
      clamp.shownOk, clamp.detail);
    check("S53: CLAMP — the offset there is exactly raw[0] − raw[t] (the documented edge policy)",
      clamp.offOk, clamp.detail);
    check("S53: (data precondition) the clamp actually displaces (raw[0] ≠ raw[1])",
      clamp.mag > 1e-3, `mag=${clamp.mag}`);
    await seekTo(GATHER);
    await d.screenshot(`${REPORT}/S53_delayed.png`);

    // -- E: one Ctrl+Z reverses the bind; the channel stays declared -----------
    await d.evaluate(`void document.activeElement?.blur?.()`);
    await d.ctrlZ();
    await sleep(300);
    await seekTo(0);
    check("S53: one Ctrl+Z zeroes the offset, snaps back to zero-copy raw, base depth, binding gone",
      (await offsetAllZero()) && (await zeroCopy()) &&
        !(await bindingsMsg()).includes("delay_offset") && (await undoDepth()) === depth0,
      `offZero=${await offsetAllZero()} zc=${await zeroCopy()} depth=${await undoDepth()}`);
    check("S53: the delay_offset CHANNEL remains declared (append-only, not undoable)",
      (await channelsMsg()).includes("delay_offset"), await channelsMsg());
    await seekTo(30);
    check("S53: a further seek does not re-displace (truly unbound)", await zeroCopy());
  });
}

// ==================== S54: bicolorbonds — the endpoint-color snapshot ========
// The per-endpoint edge-color primitive: the edgeColorA/edgeColorB PAIR is the
// one edge-color truth (colorbonds writes the same constant into both halves —
// byte-identical to the retired single buffer), and bicolorbonds/bicolorbondsof
// SNAPSHOT each matched edge's halves from its endpoints' CURRENT point colors
// (read at execution time — never a live link; re-run to re-snapshot).
async function S54(): Promise<void> {
  console.log("S54 — bicolorbonds/bicolorbondsof: per-endpoint edge color (endpoint snapshot)");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: "color" | "edgeColorA" | "edgeColorB" | "traceColor") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: "color" | "edgeColorA" | "edgeColorB" | "traceColor") =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    /** A==B on every edge of the scene (the solid-color identity). */
    const pairIdentical = () =>
      d.evaluate<boolean>(`(()=>{
        const a=${V}.rep.state.edgeColorA, b=${V}.rep.state.edgeColorB;
        for (let i=0;i<a.length;i++) if (a[i]!==b[i]) return false;
        return true;
      })()`);
    /** Run a bicolor verb and audit the SNAPSHOT PARITY in-page: every edge
     * matching the endpoint predicate must carry A == color[endA] and
     * B == color[endB] (the two halves from the two endpoints); every other
     * edge must be byte-untouched vs the pre-snap. `split` counts matched
     * edges whose two halves DIFFER (endpoint colors differ); `reach` counts
     * matched edges leaning on an out-of-set endpoint. */
    const paintEnds = async (verb: "bicolorbonds" | "bicolorbondsof", expr: string) => {
      await snap("__preA", "edgeColorA");
      await snap("__preB", "edgeColorB");
      const r = await cmd(`${verb} ${expr}`);
      const audit = await d.evaluate<{
        matched: number; wrongSnap: number; touchedOutside: number; split: number; reach: number;
      }>(`(()=>{
        const v=${V};
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        const both=${verb === "bicolorbonds"};
        const A=v.rep.state.edgeColorA, B=v.rep.state.edgeColorB, C=v.rep.state.color;
        const preA=window.__preA, preB=window.__preB;
        let matched=0, wrongSnap=0, touchedOutside=0, split=0, reach=0;
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          const want=both ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b));
          if (want) {
            matched++;
            if (!pts.has(a)||!pts.has(b)) reach++;
            let ok=true, eq=true;
            for (let c=0;c<3;c++) {
              if (A[3*e+c]!==C[3*a+c] || B[3*e+c]!==C[3*b+c]) ok=false;
              if (A[3*e+c]!==B[3*e+c]) eq=false;
            }
            if (!ok) wrongSnap++;
            if (!eq) split++;
          } else {
            for (let c=0;c<3;c++) {
              if (A[3*e+c]!==preA[3*e+c] || B[3*e+c]!==preB[3*e+c]) { touchedOutside++; break; }
            }
          }
        }
        return { matched, wrongSnap, touchedOutside, split, reach };
      })()`);
      return { r, audit };
    };

    // -- (0) the seed identity: both halves boot byte-identical ------------------
    check("S54: at boot the pair is byte-identical (the single-buffer look, promoted)",
      await pairIdentical());
    await snap("__pristineA", "edgeColorA");
    await snap("__pristineB", "edgeColorB");
    const baseDepth = await undoDepth();

    // -- (a) the snapshot, contained: upstream rainbow → split halves ------------
    // rainbow gives every point its OWN color, so adjacent endpoints differ and
    // nearly every matched edge must come out split (A != B).
    await cmd("rainbow all");
    const contained = await paintEnds("bicolorbonds", "alpha");
    check("S54: bicolorbonds alpha — every contained edge's halves = its endpoints' CURRENT colors",
      contained.r.status === "ok" && contained.audit.matched > 0 &&
        contained.audit.wrongSnap === 0 && contained.audit.reach === 0,
      JSON.stringify(contained));
    check("S54: ...unmatched edges are byte-untouched", contained.audit.touchedOutside === 0,
      `touched=${contained.audit.touchedOutside}`);
    check("S54: ...the rainbow upstream makes them SPLIT (A != B on most matched edges)",
      contained.audit.split > contained.audit.matched * 0.5,
      `split=${contained.audit.split}/${contained.audit.matched}`);
    check("S54: ...message reports the action and count",
      contained.r.message === `bicolored ${contained.audit.matched} edges from their endpoints' colors`,
      contained.r.message);
    check("S54: ...as exactly ONE undo stroke", (await undoDepth()) === baseDepth + 2,
      `depth=${await undoDepth()}`); // rainbow + bicolorbonds

    // -- (b) SNAPSHOT means snapshot: upstream recolor does NOT retro-update -----
    await snap("__snapA", "edgeColorA");
    await snap("__snapB", "edgeColorB");
    await cmd("colorpoints alpha white");
    check("S54: recoloring the points afterwards leaves the snapshot untouched",
      (await equalsSnap("__snapA", "edgeColorA")) && (await equalsSnap("__snapB", "edgeColorB")));
    const resnap = await paintEnds("bicolorbonds", "alpha");
    check("S54: re-running bicolorbonds tracks the NEW point colors (and now A==B: one constant upstream)",
      resnap.r.status === "ok" && resnap.audit.wrongSnap === 0 && resnap.audit.split === 0,
      JSON.stringify(resnap.audit));

    // -- (c) the incident variant reaches out, reading the out-of-set endpoint ---
    const incident = await paintEnds("bicolorbondsof", "beta.group-*.*.t1");
    check("S54: bicolorbondsof beta.group-*.*.t1 — incident snapshot, ALL reaching out",
      incident.r.status === "ok" && incident.audit.matched > 0 &&
        incident.audit.wrongSnap === 0 && incident.audit.reach === incident.audit.matched,
      JSON.stringify(incident.audit));

    // -- (d) independence: the pair only — point and trace buffers untouched -----
    await snap("__indepP", "color");
    await snap("__indepT", "traceColor");
    await paintEnds("bicolorbonds", "gamma");
    check("S54: bicolorbonds touches NEITHER the point nor the trace buffer",
      (await equalsSnap("__indepP", "color")) && (await equalsSnap("__indepT", "traceColor")));

    // -- (e) byte-identical backward compat: colorbonds writes A==B --------------
    const depthCB = await undoDepth();
    const cb = await cmd("colorbonds alpha red");
    check("S54: colorbonds alpha red still lands", cb.status === "ok", JSON.stringify(cb));
    check("S54: ...and edgeColorA==edgeColorB on EVERY matched edge (assert per edge)",
      await d.evaluate<boolean>(`(()=>{
        const v=${V};
        const pts=new Set(v.debug.resolvePoints("alpha"));
        const A=v.rep.state.edgeColorA, B=v.rep.state.edgeColorB;
        const red=[Math.fround(1),0,0];
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (!(pts.has(a)&&pts.has(b))) continue;
          for (let c=0;c<3;c++) {
            if (A[3*e+c]!==red[c] || B[3*e+c]!==red[c]) return false;
          }
        }
        return true;
      })()`));
    check("S54: ...one stroke for the composed pair write", (await undoDepth()) === depthCB + 1);

    // -- (f) LWW + undo: strokes over the pair unwind in order -------------------
    const lww = await paintEnds("bicolorbonds", "alpha.group-0.subgroup-0");
    check("S54: bicolorbonds over a colorbonds overlap overwrites those edges (LWW)",
      lww.r.status === "ok" && lww.audit.wrongSnap === 0, JSON.stringify(lww.audit));
    await d.evaluate(`void document.activeElement?.blur?.()`);
    await d.ctrlZ();
    await sleep(120);
    check("S54: one Ctrl+Z restores the PREVIOUS pair (the red constant), not the base look",
      (await equalsSnap("__preA", "edgeColorA")) && (await equalsSnap("__preB", "edgeColorB")));
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    check("S54: unwinding every stroke restores the pristine pair",
      (await equalsSnap("__pristineA", "edgeColorA")) && (await equalsSnap("__pristineB", "edgeColorB")) &&
        (await pairIdentical()));

    // -- (g) quiet paths: nomatch / pin / usage write nothing --------------------
    await snap("__quietA", "edgeColorA");
    await snap("__quietB", "edgeColorB");
    const depthQuiet = await undoDepth();
    const quiet: [string, string][] = [
      ["bicolorbonds nothere", "nomatch"],
      ["bicolorbondsof nothere", "nomatch"],
      ["bicolorbonds #124", "nomatch"], // one-point set: no contained edge
      ["bicolorbonds", "error"],
      ["bicolorbondsof", "error"],
      ["bicolorbonds alpha.[x]", "error"], // [ reserved
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S54: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S54: ...none of them wrote a single component",
      (await equalsSnap("__quietA", "edgeColorA")) && (await equalsSnap("__quietB", "edgeColorB")));
    check("S54: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);
    const pin = await paintEnds("bicolorbondsof", "#124");
    check("S54: bicolorbondsof #124 snapshots exactly the incident edges",
      pin.r.status === "ok" && pin.audit.wrongSnap === 0 &&
        pin.audit.reach === pin.audit.matched && pin.audit.touchedOutside === 0,
      JSON.stringify(pin.audit));

    await d.screenshot(`${REPORT}/S54_bicolor.png`);
  });
}

// ==================== S55: dashbonds — per-edge solid/dashed =================
// The dash primitive's STATE story (S18's paintSize shape on the edgeDash
// buffer): contained/incident parity, 0 = solid as a literal legal value,
// clamp, independence, LWW, undo, and the bonddash channel seam (bake/bind
// through the shared gate, endpoint mean, size-style fixed range). The
// PIXEL story (dashed < solid lit fraction) is the stage-3 prove-render.
async function S55(): Promise<void> {
  console.log("S55 — dashbonds/dashbondsof: per-edge dash scale (0 = solid; bonddash axis)");
  const BUFS = ["edgeDash", "edgeSize", "edgeColorA", "edgeColorB", "edgeOpacity", "size", "color"] as const;
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: string) =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: string) =>
      d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.${buf}, s=window.${slot};
        if (c.length !== s.length) return false;
        for (let i=0;i<c.length;i++) if (c[i]!==s[i]) return false;
        return true;
      })()`);
    const snapAll = async () => {
      for (const b of BUFS) await snap(`__all_${b}`, b);
    };
    const changedBuffers = async (): Promise<string> => {
      const out: string[] = [];
      for (const b of BUFS) if (!(await equalsSnap(`__all_${b}`, b))) out.push(b);
      return JSON.stringify(out);
    };
    /** Dash parity (S18's paintSize on the edgeDash buffer): the changed
     * slot set must equal the verb's endpoint predicate over resolvePoints;
     * `reach` counts changed edges leaning on an out-of-set endpoint. */
    const paintDash = async (verb: "dashbonds" | "dashbondsof", expr: string, scale: string) => {
      await snap("__preDash", "edgeDash");
      const r = await cmd(`${verb} ${expr} ${scale}`);
      const parity = await d.evaluate<{ changed: number; match: boolean; reach: number; value: boolean }>(`(()=>{
        const v=${V}; const c=v.rep.state.edgeDash; const s=window.__preDash;
        const changed=[];
        for (let e=0;e<c.length;e++) if (c[e]!==s[e]) changed.push(e);
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        const both=${verb === "dashbonds"};
        const want=[]; let reach=0;
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (both ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b))) want.push(e);
        }
        for (const e of changed) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (!pts.has(a)||!pts.has(b)) reach++;
        }
        const w=Math.fround(${JSON.stringify(scale)});
        const value=changed.every(e=>c[e]===Math.max(0,w));
        return { changed: changed.length, reach, value,
                 match: changed.length===want.length && changed.every((e,i)=>e===want[i]) };
      })()`);
      return { r, parity };
    };
    /** Every matched contained edge of expr carries exactly this dash. */
    const edgesDashed = (expr: string, val: number) =>
      d.evaluate<boolean>(`(()=>{
        const v=${V}; const c=v.rep.state.edgeDash; const w=Math.fround(${val});
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          if (pts.has(a)&&pts.has(b) && c[e]!==w) return false;
        }
        return true;
      })()`);

    // -- (0) the base look: every edge solid (dash 0) ----------------------------
    check("S55: at boot every edge is SOLID (edgeDash all zero — the byte-identical default)",
      await d.evaluate<boolean>(`(()=>{
        const c=${V}.rep.state.edgeDash;
        for (let e=0;e<c.length;e++) if (c[e]!==0) return false;
        return true;
      })()`));
    await snap("__pristineDash", "edgeDash");
    const baseDepth = await undoDepth();

    // -- (a) contained parity across target kinds --------------------------------
    const bonds = await paintDash("dashbonds", "alpha", "1.5");
    check("S55: dashbonds alpha 1.5 — dashes EXACTLY the both-endpoints edges (reach 0)",
      bonds.r.status === "ok" && bonds.parity.match && bonds.parity.changed > 0 &&
        bonds.parity.reach === 0 && bonds.parity.value,
      JSON.stringify(bonds));
    check("S55: ...message reports the action and count",
      bonds.r.message === `set ${bonds.parity.changed} edges to dash 1.5`, bonds.r.message);
    check("S55: ...as exactly ONE undo stroke", (await undoDepth()) === baseDepth + 1);

    // -- (b) the incident reach ---------------------------------------------------
    const bondsof = await paintDash("dashbondsof", "beta.group-*.*.t1", "2.5");
    check("S55: dashbondsof beta.group-*.*.t1 — the either-endpoint set, ALL reaching out",
      bondsof.r.status === "ok" && bondsof.parity.match && bondsof.parity.reach > 0 &&
        bondsof.parity.value,
      `${JSON.stringify(bondsof.r)} reach=${bondsof.parity.reach}`);

    // -- (c) the single-point pin -------------------------------------------------
    await snap("__quietDash", "edgeDash");
    const depthPin = await undoDepth();
    const pin = await cmd("dashbonds #124 2");
    check("S55: dashbonds #124 → nomatch (no contained edge in a one-point set)",
      pin.status === "nomatch" && pin.message === `no edges with both endpoints in "#124"`,
      JSON.stringify(pin));
    check("S55: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietDash", "edgeDash")) && (await undoDepth()) === depthPin);
    const pinOf = await paintDash("dashbondsof", "#124", "2.25");
    check("S55: dashbondsof #124 dashes exactly the incident edges",
      pinOf.r.status === "ok" && pinOf.parity.match && pinOf.parity.reach > 0 &&
        pinOf.r.message === "set 2 edges to dash 2.25",
      JSON.stringify(pinOf));

    // -- (d) 0 = SOLID, a literal legal write; dash ⊥ hide ------------------------
    await snap("__preZeroVis", "visible");
    const visBefore = await visibleCount(d);
    const zero = await cmd("dashbonds alpha 0");
    check("S55: dashbonds alpha 0 — a literal write, reported as solid (never a hide)",
      zero.status === "ok" && /^set \d+ edges to dash 0 \(solid\)$/.test(zero.message),
      JSON.stringify(zero));
    check("S55: ...the dash buffer really is 0 there", await edgesDashed("alpha", 0));
    check("S55: ...hide-state is BYTE-IDENTICAL and the scene count unchanged",
      (await equalsSnap("__preZeroVis", "visible")) && (await visibleCount(d)) === visBefore);

    // -- (e) the negative clamp ---------------------------------------------------
    const neg = await cmd("dashbonds gamma -2");
    check("S55: a negative scale clamps to 0 and the message says both things",
      neg.status === "ok" && /^set \d+ edges to dash 0 \(clamped to 0\) \(solid\)$/.test(neg.message),
      JSON.stringify(neg));

    // -- (f) independence: the dash verbs touch ONLY edgeDash --------------------
    await snapAll();
    await cmd("dashbonds gamma 1.75");
    check("S55: dashbonds touches ONLY edgeDash", (await changedBuffers()) === `["edgeDash"]`,
      await changedBuffers());
    // and the OTHER edge verbs leave edgeDash alone
    await snapAll();
    await cmd("colorbonds gamma #313233");
    await cmd("bondsize gamma 1.25");
    await cmd("bondopacity gamma 0.7");
    check("S55: color/size/opacity edge verbs leave edgeDash untouched",
      await equalsSnap("__all_edgeDash", "edgeDash"));

    // -- (g) LWW + undo -----------------------------------------------------------
    while ((await undoDepth()) > baseDepth) {
      await d.ctrlZ();
      await sleep(60);
    }
    check("S55: unwinding every stroke restores the pristine (all-solid) buffer",
      await equalsSnap("__pristineDash", "edgeDash"));
    await cmd("dashbonds alpha 5");
    await cmd("dashbonds alpha.group-0.subgroup-0 7");
    check("S55: re-dashing an overlap overwrites those edges (LWW)",
      await edgesDashed("alpha.group-0.subgroup-0", 7));
    await d.evaluate(`void document.activeElement?.blur?.()`);
    await d.ctrlZ();
    await sleep(120);
    check("S55: undo restores the PREVIOUS scale (5), not the base look",
      await edgesDashed("alpha.group-0.subgroup-0", 5));
    await d.ctrlZ();
    await sleep(120);
    check("S55: a second undo restores solid (0)", await edgesDashed("alpha", 0));

    // -- (h) the bonddash channel seam: bake + bind through the shared gate ------
    await snap("__preBake", "edgeDash");
    const depthBake = await undoDepth();
    const bake = await cmd("bake all energy bonddash 0 1");
    check("S55: bake … bonddash lands through the shared gate (endpoint mean)",
      bake.status === "ok" && /baked "energy" → bonddash on \d+ edges .*endpoint mean/.test(bake.message),
      JSON.stringify(bake));
    const baked = await d.evaluate<{ changed: number; inRange: boolean }>(`(()=>{
      const c=${V}.rep.state.edgeDash, s=window.__preBake;
      let changed=0, inRange=true;
      for (let e=0;e<c.length;e++) {
        if (c[e]!==s[e]) changed++;
        if (c[e] < 0 || c[e] > 4) inRange=false;
      }
      return { changed, inRange };
    })()`);
    check("S55: ...the baked values land on edgeDash inside 0..BIND_DASH_MAX",
      baked.changed > 0 && baked.inRange && (await undoDepth()) === depthBake + 1,
      JSON.stringify(baked));
    await d.ctrlZ();
    await sleep(120);
    check("S55: one Ctrl+Z reverses the bake", await equalsSnap("__preBake", "edgeDash"));
    const bind = await cmd("bind all energy bonddash 0 1");
    check("S55: bind … bonddash registers and applies",
      bind.status === "ok" && /bound "energy" → bonddash on \d+ edges .*live/.test(bind.message),
      JSON.stringify(bind));
    check("S55: ...the bindings listing carries it, endpoint mean",
      /energy → bonddash on "all" — \d+ edges · range 0\.\.1 · endpoint mean/.test(
        (await cmd("bindings")).message),
      (await cmd("bindings")).message);
    await d.ctrlZ();
    await sleep(120);
    check("S55: one Ctrl+Z removes the binding AND restores the buffer",
      (await equalsSnap("__preBake", "edgeDash")) &&
        (await cmd("bindings")).message === "no bindings");

    // -- (i) quiet paths ----------------------------------------------------------
    await snapAll();
    const depthQuiet = await undoDepth();
    const quiet: [string, string][] = [
      ["dashbonds nothere 2", "nomatch"],
      ["dashbonds alpha abc", "error"],
      ["dashbonds", "error"],
      ["dashbondsof 2", "error"], // one chunk: a scale but no target
      ["dashbonds alpha.[x] 2", "error"], // [ reserved
    ];
    for (const [text, status] of quiet) {
      const r = await cmd(text);
      check(`S55: ${text} → ${status}`, r.status === status, JSON.stringify(r));
    }
    check("S55: ...none of them wrote a single component anywhere",
      (await changedBuffers()) === "[]");
    check("S55: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet);

    await d.screenshot(`${REPORT}/S55_dash.png`);
  });
}

const all: Record<string, () => Promise<void>> = { S0, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S15, S16, S17, S18, S19, S20, S21, S22, S23, S24, S25, S26, S27, S28, S29, S30, S31, S32, S33, S34, S35, S36, S37, S38, S39, S40, S41, S42, S43, S44, S45, S46, S47, S48, S49, S50, S51, S52, S53, S54, S55 };
/** Scenarios that must run ALONE, never in a parallel pool, with the reason.
 * S29 VACATED this slot in the harness chapter (it once mutated the real
 * .molaro/mods; it now deletes only inside its own temp dir, E2E_MODS_DIR).
 * S30 now holds it for a DIFFERENT reason: it is the sole real-mdtraj
 * scenario (a 3341-atom adk trajectory — the heaviest producer AND the
 * heaviest chrome, streaming into the 3D viewer while ALSO rendering the
 * plot). In a width-6 pool that chrome's plot render is starved and the
 * series never draws (chronic pre-chapter flake; the stub plot scenarios
 * S25/S28/S45 pass under identical pool load, so the plot PATH is sound —
 * it is CPU starvation of the heavy scenario, not a product race). Alone,
 * S30 is reliably green (8/8). Single-sourced here; the runner reads it
 * via --list. */
const EXCLUSIVE: readonly string[] = ["S30"];
// (review fix) EXCLUSIVE must name real scenarios — a typo would silently
// drop the member from BOTH lanes (the runner filters by membership)
for (const n of EXCLUSIVE) {
  if (!(n in all)) throw new Error(`EXCLUSIVE names unknown scenario: ${n}`);
}
/** Every scenario belongs to EXACTLY ONE lane — single-sourced here, next to
 * the scenario table, and asserted exhaustive in BOTH directions below, so a
 * scenario can never silently fall out of both lanes or into neither.
 *   fast — the pixel-sensitive / correctness-critical set (junction, overlay,
 *          depth variants, buffer independence, pulses, null-bbox, the trace
 *          pixel proofs): what runs on every change during iteration.
 *   full — everything else. The full LANE runs every scenario (fast included);
 *          tiering decides WHEN a scenario runs, never WHETHER it still holds.
 */
const TIER: Record<string, "fast" | "full"> = {
  S0: "full", S1: "full", S2: "full", S3: "full", S4: "full", S5: "fast",
  S6: "full", S7: "full", S8: "full", S9: "full", S10: "full", S11: "full",
  S12: "full", S13: "full", S14: "full", S15: "full", S16: "full",
  S17: "fast", S18: "fast", S19: "fast", S20: "full", S21: "full",
  S22: "full", S23: "full", S24: "full", S25: "full", S26: "full",
  S27: "full", S28: "full", S29: "full", S30: "full", S31: "full",
  S32: "fast", S33: "fast", S34: "fast", S35: "full", S36: "fast",
  S37: "fast", S38: "fast", S39: "fast", S40: "fast", S41: "fast",
  S42: "fast", S43: "fast", S44: "fast", S45: "fast", S46: "full", S47: "full",
  S48: "full", S49: "full", S50: "full", S51: "full", S52: "full",
  S53: "full", S54: "full", S55: "full",
};
for (const name of Object.keys(all)) {
  if (!(name in TIER)) {
    console.error(`scenario ${name} has NO TIER — every scenario must be in exactly one lane`);
    process.exit(2);
  }
}
for (const name of Object.keys(TIER)) {
  if (!(name in all)) {
    console.error(`tier entry ${name} has no scenario`);
    process.exit(2);
  }
}
// Machine-readable listing for the parallel runner (tests/run_e2e.ts): the
// ONE source of scenario names, exclusivity, and tiers — the runner never
// hardcodes them (the "two lists that must agree" defect class).
if (which[0] === "--list") {
  console.log(JSON.stringify({ scenarios: Object.keys(all), exclusive: EXCLUSIVE, tiers: TIER }));
  process.exit(0);
}
const run = which.length ? which : Object.keys(all);
for (const name of run) {
  const fn = all[name];
  if (!fn) {
    console.error(`unknown scenario ${name}`);
    process.exit(2);
  }
  await fn();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
