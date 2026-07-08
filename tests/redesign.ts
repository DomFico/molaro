/**
 * Interaction-redesign validation — drives the REAL webview over the REAL
 * synthetic producer via CDP and asserts the new model end-to-end:
 *
 *   S0  startup: pre-hidden bulk selection + mirrored top section (shared tree)
 *   S1  bottom section: build pending (click/paint/backtrack), right-click focus
 *   S2  commit + top section operate: focus, hide (purple), edit mode, rename
 *   S3  3D: plain-click focus; Ctrl+left subgroup / Ctrl+right point select;
 *       both surfaces build the SAME pending set; Create/Done button
 *   S4  undo (Ctrl+Z) & Escape chains
 *   S5  visuals: green pulse, yellow flash, hidden-wins, brackets (+ drag)
 *   S6  layout sanity: docking preserved, no auto-scroll from 3D actions
 *
 * Screenshots + [PASS]/[FAIL] lines; evidence in reports/redesign/.
 * Run from viewer/ (after npm run build):  node tests/redesign.ts [S0 S1 ...]
 */
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
const committed = (d: E2EDriver) =>
  d.evaluate<{ name: string; hidden: boolean; pts: number; entries: number; lane: number }[]>(
    `${V}.model.committed().map(c=>({name:c.name,hidden:c.hidden,pts:c.set.pointCount,entries:c.set.entryCount,lane:c.lane}))`,
  );
const editingName = (d: E2EDriver) => d.evaluate<string | null>(`${V}.model.editing?.name ?? null`);
const camPos = (d: E2EDriver) => d.evaluate<number[]>(`${V}.camera.position.toArray()`);
const camMoved = (a: number[], b: number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-3;
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

let portBase = 9000;
async function withDriver(fn: (d: E2EDriver) => Promise<void>, w = 1180, h = 780): Promise<void> {
  portBase += 2;
  const d = new E2EDriver({
    bridgePort: portBase, cdpPort: portBase + 300, width: w, height: h,
    producerArgs: ["--n-points", "6000", "--n-frames", "150"],
  });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(3200);
    await pause(d);
    await fn(d);
  } finally {
    await d.dispose();
  }
}

// ============================ S0: startup & mirror ===========================
async function S0(): Promise<void> {
  console.log("S0 — startup: all visible, pre-made bulk selection, flat top section");
  await withDriver(async (d) => {
    const list = await committed(d);
    check("S0: one pre-made committed selection at startup", list.length === 1, JSON.stringify(list));
    check("S0: it is the bulk category, VISIBLE, neutral category name",
      list[0]?.name === "solvent" && list[0]?.hidden === false, JSON.stringify(list[0]));
    const vis = await visibleCount(d);
    check("S0: nothing is hidden by default — the user decides", vis === 6000, `visible=${vis}`);
    check("S0: pending target starts empty", (await pendingEntries(d)) === 0);
    check("S0: commit button disabled while pending is empty",
      await d.evaluate<boolean>(`document.getElementById('commit-btn').disabled`));

    // one right-click on the pre-made selection hides the environment
    const head0 = (await selHead(d, "/solvent/"))!;
    await d.rightClick(head0.x, head0.y);
    await sleep(150);
    check("S0: one action hides the bulk environment",
      (await visibleCount(d)) === 6000 - list[0].pts, `visible=${await visibleCount(d)}`);
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
    check("S1: row is marked covered (green pulse class)", /sel-covered/.test(alphaAfter.cls), alphaAfter.cls);
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
    check("S1: right-click focuses the camera on the entry", camMoved(before, await camPos(d)));
    check("S1: right-click never changes the selection", (await pendingEntries(d)) === 0);
    check("S1: focus plays a pulse over the region", (await flashCount(d)) > 0);
    await d.screenshot(`${REPORT}/S1_focus_flash.png`);

    // right-DRAG = view a region: focuses the union of the dragged rows
    const before2 = await camPos(d);
    await d.drag(beta.x, beta.y, gamma.x, gamma.y, 4, { button: "right" });
    await sleep(600);
    check("S1: right-drag focuses the dragged region", camMoved(before2, await camPos(d)));
    check("S1: region focus pulses BOTH rows' points", (await flashCount(d)) >= 800,
      `flash=${await flashCount(d)}`);
    check("S1: right-drag changes no selection", (await pendingEntries(d)) === 0);
  });
}

// ============================ S2: commit & operate ============================
async function S2(): Promise<void> {
  console.log("S2 — commit; top section: focus / hide / edit / rename");
  await withDriver(async (d) => {
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
    check("S2: top left-click focuses the camera (yellow pulse)", camMoved(before, await camPos(d)));
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
    const beta = (await bottomRow(d, "/beta/"))!;
    await d.click(beta.x, beta.y);
    await sleep(120);
    check("S2: bottom clicks now add to the edited selection",
      (await committed(d))[1].entries === 2);
    // camera is PARKED while editing: focus actions pulse but never move it
    const camEdit = await camPos(d);
    const memberEdit = (await topRow(d, "/beta/"))!;
    await d.click(memberEdit.x, memberEdit.y);
    await sleep(600);
    check("S2: focus does not move the camera while editing",
      !camMoved(camEdit, await camPos(d)));
    check("S2: ...but still pulses the region", (await flashCount(d)) > 0);
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
    check("S2: focus moves the camera again after Done", camMoved(camDone, await camPos(d)));

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
    await sleep(600);
    check("S3: plain click focuses the subgroup (camera orients)", camMoved(camBefore, await camPos(d)));
    check("S3: plain click selects nothing", (await pendingEntries(d)) === 0);
    check("S3: focus pulse covers the subgroup", (await flashCount(d)) > 1);
    check("S3: no auto-scroll of the panel from 3D actions", (await scrollTop(d)) === scrollBefore);
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
      await sleep(700);
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
      await sleep(700);
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

    // yellow focus flash: swells then fades fully
    const beta = (await bottomRow(d, "/beta/"))!;
    await d.rightClick(beta.x, beta.y);
    await sleep(300);
    const f1 = await d.evaluate<{ flash: number }>(`${V}.debug.pulse()`);
    check("S5: focus flash active mid-pulse", f1.flash > 0.2, `flash=${f1.flash.toFixed(2)}`);
    await d.screenshot(`${REPORT}/S5_flash_mid.png`);
    await sleep(900);
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
    const alpha = (await bottomRow(d, "/alpha/"))!;
    const beta = (await bottomRow(d, "/beta/"))!;
    const gamma = (await bottomRow(d, "/gamma/"))!;

    // expandable carets have a forgiving hit box
    const caretW = await d.evaluate<number>(
      `document.querySelector('#tree-host .caret.exp').getBoundingClientRect().width`);
    check("S8: expandable carets have a generous hit box", caretW >= 18, `${caretW}px`);

    // non-contiguous coverage → the bracket SPLITS into segments
    await d.click(alpha.x, alpha.y);
    await sleep(80);
    await d.click(gamma.x, gamma.y); // beta (unselected) sits between
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
    const purple = await d.evaluate<{ state: boolean; sweep: boolean }>(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      return { state: rows.some(r=>r.classList.contains('hidden-entry-row')),
               sweep: rows.some(r=>r.classList.contains('row-flash-purple')) };
    })()`);
    check("S8: hidden member is marked purple", purple.state);
    check("S8: hide plays the purple right-to-left sweep", purple.sweep);
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

    // right-DRAG across members hides them all (one undo unit)
    const memberA2 = (await topRow(d, "/alpha/"))!;
    const memberG = (await topRow(d, "/gamma/"))!;
    await d.drag(memberA2.x, memberA2.y, memberG.x, memberG.y, 4, { button: "right" });
    await sleep(200);
    check("S8: right-drag hides the dragged members",
      (await visibleCount(d)) === visAll - 800, `visible=${await visibleCount(d)}`);
    await d.ctrlZ();
    await sleep(150);
    check("S8: the drag-hide undoes as one unit", (await visibleCount(d)) === visAll);

    // whole-selection hide via the header still works (with the same sweep)
    const head = (await selHead(d, "/selection_1/"))!;
    await d.rightClick(head.x, head.y);
    await sleep(150);
    check("S8: header right-click still hides the whole selection",
      (await committed(d))[1].hidden === true);
    check("S8: header hide sweeps purple too", await d.evaluate<boolean>(`(()=>{
      const heads=[...document.querySelectorAll('#selections .sel-head')];
      return heads.some(h=>h.classList.contains('row-flash-purple'));
    })()`));

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

// ============================ runner ==========================================
const which = process.argv.slice(2);
const all: Record<string, () => Promise<void>> = { S0, S1, S2, S3, S4, S5, S6, S7, S8 };
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
