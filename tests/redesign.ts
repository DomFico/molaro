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
      if (px[i+1] > px[i] + 40 && px[i+1] > px[i+2] + 20) n++;
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
  console.log("S0 — startup: pre-hidden bulk selection, mirrored top section");
  await withDriver(async (d) => {
    const list = await committed(d);
    check("S0: one pre-made committed selection at startup", list.length === 1, JSON.stringify(list));
    check("S0: it is the bulk category, hidden, neutral category name",
      list[0]?.name === "solvent" && list[0]?.hidden === true, JSON.stringify(list[0]));
    const vis = await visibleCount(d);
    check("S0: bulk points are invisible by default", vis === 6000 - list[0].pts, `visible=${vis}`);
    check("S0: pending target starts empty", (await pendingEntries(d)) === 0);
    check("S0: commit button disabled while pending is empty",
      await d.evaluate<boolean>(`document.getElementById('commit-btn').disabled`));

    // top section mirrors the hierarchy through the SAME tree component
    const head = await selHead(d, "/solvent/");
    check("S0: top section shows the hidden selection (purple class)",
      head !== null && /hidden-sel/.test(head.cls), head?.cls ?? "missing");
    await d.evaluate(`(()=>{
      const b=[...document.querySelectorAll('#selections .sel-block')][0];
      b.querySelector('.caret').click();
    })()`);
    await sleep(150);
    const topRows = await d.evaluate<number>(
      `document.querySelectorAll('#selections .tree-row.selectable').length`);
    check("S0: expanding it renders shared tree rows in the top section", topRows > 0, `${topRows} rows`);
    // drill to the huge subgroup list: category → group; must be virtualized
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      const cat=rows.find(r=>/solvent/.test(r.textContent)); cat?.querySelector('.caret')?.click();
    })()`);
    await sleep(120);
    await d.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('#selections .tree-row.selectable')];
      const grp=rows.find(r=>r.dataset.level==='group'); grp?.querySelector('.caret')?.click();
    })()`);
    await sleep(250);
    const stats = await d.evaluate<{ rendered: number; total: number }>(`(()=>{
      const v=document.querySelector('#selections .vlist');
      if(!v) return {rendered:-1,total:-1};
      return {rendered:v.children.length, total:Math.round(v.getBoundingClientRect().height/18)};
    })()`);
    check("S0: top-section subgroup list is virtualized (windowed, no truncation)",
      stats.total > 800 && stats.rendered > 0 && stats.rendered < 300, JSON.stringify(stats));
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

    // one Ctrl+Z per stroke
    await d.ctrlZ();
    await sleep(100);
    await d.ctrlZ();
    await sleep(100);
    check("S1: each paint stroke undoes as one unit", (await pendingEntries(d)) === 0,
      `entries=${await pendingEntries(d)}`);

    // right-click = focus (camera moves, light pulse, NO selection change)
    const before = await camPos(d);
    await d.rightClick(gamma.x, gamma.y);
    await sleep(600);
    check("S1: right-click focuses the camera on the entry", camMoved(before, await camPos(d)));
    check("S1: right-click never changes the selection", (await pendingEntries(d)) === 0);
    check("S1: focus plays a pulse over the region", (await flashCount(d)) > 0);
    await d.screenshot(`${REPORT}/S1_focus_flash.png`);
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
    const bracketName = await d.evaluate<string>(`(()=>{
      const names=[...document.querySelectorAll('.bracket-name')].map(b=>b.textContent);
      return names.join(',');
    })()`);
    check("S2: bracket in the bottom tree carries the new name", /core/.test(bracketName), bracketName);
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
    const scrollBefore = await scrollTop(d);
    const camBefore = await camPos(d);
    await d.click(proj.x, proj.y);
    await sleep(600);
    check("S3: plain click focuses the subgroup (camera orients)", camMoved(camBefore, await camPos(d)));
    check("S3: plain click selects nothing", (await pendingEntries(d)) === 0);
    check("S3: focus pulse covers the subgroup", (await flashCount(d)) > 1);
    check("S3: no auto-scroll of the panel from 3D actions", (await scrollTop(d)) === scrollBefore);
    await d.screenshot(`${REPORT}/S3_click_focus.png`);

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

    // Ctrl+right-click = POINT-level select (a distinct entry in the SAME
    // pending set, even though its subgroup entry already covers the point)
    await d.rightClick(proj2.x, proj2.y, 2 /* Ctrl */);
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

    // hidden wins: selecting the hidden bulk category shows NO green in 3D
    await d.escape();
    await sleep(100);
    const clean = await greenCount(d, await d.captureB64(`${REPORT}/S5_clean.png`));
    const solvent = (await bottomRow(d, "/solvent/"))!;
    await d.click(solvent.x, solvent.y);
    await sleep(200);
    const hiddenSel = await greenCount(d, await d.captureB64(`${REPORT}/S5_hidden_wins.png`));
    const selN = await selCount(d);
    check("S5: hidden selection is in the target (state)", selN > 1000, `selCount=${selN}`);
    check("S5: but hidden wins — no green glow for hidden points",
      hiddenSel < clean + 500, `green px ${hiddenSel} (clean ${clean})`);
    await d.escape();
    await sleep(100);

    // brackets: committed bracket present, movable by dragging its name
    await d.click(alpha.x, alpha.y);
    await sleep(80);
    const btn = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const r=document.getElementById('commit-btn').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    await d.click(btn.x, btn.y);
    await sleep(200);
    const br = await d.evaluate<{ x: number; y: number; lane: number } | null>(`(()=>{
      const b=[...document.querySelectorAll('.bracket')].find(x=>
        /selection_1/.test(x.querySelector('.bracket-name')?.textContent ?? ''));
      if(!b) return null; const r=b.getBoundingClientRect();
      return {x:r.left+3, y:r.top+r.height/2, lane:${V}.model.committed()[1].lane};
    })()`);
    check("S5: committed bracket rendered in the gutter", br !== null);
    if (br) {
      await d.drag(br.x, br.y, br.x + 14, br.y, 5);
      await sleep(200);
      const lane = await d.evaluate<number>(`${V}.model.committed()[1].lane`);
      check("S5: dragging the bracket moves its lane (undoable)", lane === br.lane + 2,
        `lane ${br.lane}→${lane}`);
      await d.ctrlZ();
      await sleep(120);
      check("S5: bracket move undoes", (await d.evaluate<number>(
        `${V}.model.committed()[1].lane`)) === br.lane);
    }
    await d.screenshot(`${REPORT}/S5_brackets.png`);
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

// ============================ runner ==========================================
const which = process.argv.slice(2);
const all: Record<string, () => Promise<void>> = { S0, S1, S2, S3, S4, S5, S6 };
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
