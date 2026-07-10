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

    // ...and dragging BACK shortens the region (same as the left trail)
    await d.mouse("mousePressed", beta.x, beta.y, { button: "right", buttons: 2 });
    await d.mouse("mouseMoved", gamma.x, gamma.y, { buttons: 2 });
    await d.mouse("mouseMoved", beta.x, beta.y, { buttons: 2 });
    await d.mouse("mouseReleased", beta.x, beta.y, { button: "right" });
    await sleep(600);
    check("S1: right-drag back SHORTENS the region (only the surviving row focuses)",
      (await flashCount(d)) === 400, `flash=${await flashCount(d)}`);
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
    await d.mouse("mousePressed", subRow!.x, subRow!.y, { clickCount: 1 });
    await d.wheel(subRow!.x, subRow!.y, 54, 1); // ≈3 rows slide under the pointer
    await sleep(250);
    const midScroll = await pendingEntries(d);
    check("S7: rows joining under the pointer paint WHILE scrolling",
      midScroll >= 3, `entries=${midScroll}`);
    await d.wheel(subRow!.x, subRow!.y, 54, 1);
    await sleep(250);
    await d.mouse("mouseReleased", subRow!.x, subRow!.y, { clickCount: 1 });
    await sleep(150);
    const afterScroll = await pendingEntries(d);
    check("S7: a second wheel tick keeps extending the same stroke",
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
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    // camera pose = position + target (6 numbers); parity compares both
    const camState = () =>
      d.evaluate<number[]>(
        `[...${V}.camera.position.toArray(), ...${V}.controls.target.toArray()]`,
      );
    const closeCam = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.01);
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
    const home = await camState();
    const rA = await cmd("view alpha.group-0.subgroup-0");
    check("S9: view <path> resolves and reports the point count",
      rA.status === "ok" && rA.message === "focused 100 points", JSON.stringify(rA));
    await sleep(150);
    check("S9: command pulses exactly the entry's points", (await flashCount(d)) === 100,
      `flash=${await flashCount(d)}`);
    check("S9: command flashes the mounted matching row (same row feedback)",
      await rowFlashed("/subgroup-0\\b/"));
    await sleep(500);
    const camCmd = await camState();
    check("S9: command moved the camera off home", !closeCam(home, camCmd));

    await reset();
    const subRow = (await bottomRow(d, "/subgroup-0\\b/"))!;
    check("S9: subgroup row still mounted for the gesture half", subRow !== null);
    await d.rightClick(subRow.x, subRow.y);
    await sleep(150);
    check("S9: gesture pulses the same points", (await flashCount(d)) === 100,
      `flash=${await flashCount(d)}`);
    check("S9: gesture flashes the same row class", await rowFlashed("/subgroup-0\\b/"));
    await sleep(500);
    const camGesture = await camState();
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
    await sleep(150);
    check("S9: ...pulsing the whole spanning group", (await flashCount(d)) === 400,
      `flash=${await flashCount(d)}`);
    await sleep(500);
    const camGroupCmd = await camState();
    await reset();
    const grpRow = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const rows=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
        .filter(r=>r.getBoundingClientRect().height>0);
      const el=rows.find(r=>r.dataset.level==='group');
      if(!el) return null; const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.rightClick(grpRow.x, grpRow.y);
    await sleep(150);
    check("S9: a real click on that category-scoped group row pulses the same 400",
      (await flashCount(d)) === 400, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camGroupClick = await camState();
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
    const camScopeCmd = await camState();
    await reset();
    const s0 = (await bottomRow(d, "/subgroup-0\\b/"))!;
    const s3 = (await bottomRow(d, "/subgroup-3\\b/"))!;
    await d.drag(s0.x, s0.y, s3.x, s3.y, 4, { button: "right" });
    await sleep(150);
    check("S9: right-drag over the SAME rendered rows pulses the same 200",
      (await flashCount(d)) === 200, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camScopeDrag = await camState();
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
    await sleep(150);
    check("S9: #index pulses one point", (await flashCount(d)) === 1,
      `flash=${await flashCount(d)}`);
    await sleep(500);
    const camIdxCmd = await camState();
    await reset();
    await d.rightClick(ptRow.x, ptRow.y);
    await sleep(150);
    check("S9: the real point-row click pulses the same single point",
      (await flashCount(d)) === 1, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camIdxClick = await camState();
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
    const camSelIdx = await camState();
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
      closeCam(camSelIdx, await camState()),
      `cmd=${camSelIdx.map((v) => v.toFixed(3))}`);

    // glob filter parity: the same subset a manual pick of those rows frames
    await reset();
    const rSelGlob = await cmd("view @selection_1.t*");
    check("S9: @sel.<glob> filters by type within the selection",
      rSelGlob.status === "ok" && rSelGlob.message === "focused 2 points",
      JSON.stringify(rSelGlob));
    await sleep(650);
    const camSelGlob = await camState();
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
    await d.drag(rows12[0].x, rows12[0].y, rows12[1].x, rows12[1].y, 4, { button: "right" });
    await sleep(150);
    check("S9: the manual pick pulses the same 2 points", (await flashCount(d)) === 2,
      `flash=${await flashCount(d)}`);
    await sleep(500);
    check("S9: @sel.<glob> ≡ a manual pick of those rows (same camera pose)",
      closeCam(camSelGlob, await camState()),
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
    const camCover = await camState();
    await reset();
    const subRowAgain = (await bottomRow(d, "/subgroup-0\\b/"))!;
    await d.rightClick(subRowAgain.x, subRowAgain.y);
    await sleep(650);
    check("S9: @cover.<member-label> ≡ clicking that subgroup row",
      closeCam(camCover, await camState()),
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
    await sleep(150);
    check("S9: glob command pulses the whole union", (await flashCount(d)) === 1200,
      `flash=${await flashCount(d)}`);
    check("S9: glob command flashes every mounted matching row",
      (await rowFlashed("/alpha/")) && (await rowFlashed("/beta/")) && (await rowFlashed("/gamma/")));
    await sleep(500);
    const camGlob = await camState();

    await reset();
    const alpha = (await bottomRow(d, "/alpha/"))!;
    const gamma = (await bottomRow(d, "/gamma/"))!;
    await d.drag(alpha.x, alpha.y, gamma.x, gamma.y, 4, { button: "right" });
    await sleep(150);
    check("S9: right-drag over the same rows pulses the same union",
      (await flashCount(d)) === 1200, `flash=${await flashCount(d)}`);
    await sleep(500);
    const camDrag = await camState();
    check("S9: glob command frames the SAME union a right-drag frames",
      closeCam(camGlob, camDrag),
      `cmd=${camGlob.map((v) => v.toFixed(3))} drag=${camDrag.map((v) => v.toFixed(3))}`);

    // -- @name parity: `view @solvent` vs clicking the committed selection name --
    await reset();
    const rAt = await cmd("view @solvent");
    check("S9: @name resolves the committed selection",
      rAt.status === "ok" && rAt.message === "focused 4800 points", JSON.stringify(rAt));
    await sleep(650);
    const camAt = await camState();
    await reset();
    const nm = (await d.evaluate<{ x: number; y: number } | null>(`(()=>{
      const blocks=[...document.querySelectorAll('#selections .sel-block')];
      const el=blocks.find(b=>/solvent/.test(b.querySelector('.sel-name')?.textContent ?? ''));
      if(!el) return null; const r=el.querySelector('.sel-name').getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`))!;
    await d.click(nm.x, nm.y); // name click = focus the whole selection
    await sleep(650);
    const camName = await camState();
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
    const camBeforeMiss = await camState();
    const rMiss = await cmd("view alpha.group-0.subgroup-99");
    await sleep(400);
    check("S9: empty match is nomatch, not an error", rMiss.status === "nomatch",
      JSON.stringify(rMiss));
    check("S9: nomatch moves nothing", closeCam(camBeforeMiss, await camState()) &&
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
    const camHiddenCmd = await camState();
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
    const camHiddenClick = await camState();
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
    await sleep(700);
    check("S9: (setup) zoomed in", (await dist()) < d0 * 0.8, `${(await dist()).toFixed(1)}`);
    const rHome = await cmd("view");
    await sleep(700);
    check("S9: bare view frames the visible scene", rHome.status === "ok" &&
      Math.abs((await dist()) - d0) < d0 * 0.1, `dist=${(await dist()).toFixed(1)} vs ${d0.toFixed(1)}`);
    await d.screenshot(`${REPORT}/S9_command_parity.png`);
  });
}

// ============================ S10: flash-parity matrix ========================
async function S10(): Promise<void> {
  console.log("S10 — flash-parity: flashed rows == mounted rows ∩ resolved set, all shapes");
  await withDriver(async (d) => {
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

    // camera frames the FULL union: command pose == focusPoints(resolved set)
    for (const expr of [`@selection_1."subgroup-0" + @selection_1.t1`,
                        "alpha.group-0.subgroup-3 + #5"]) {
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
      await d.evaluate(`${V}.focusPoints(${V}.debug.resolvePoints(${JSON.stringify(expr)}))`);
      await sleep(650);
      const direct = await d.evaluate<number[]>(
        `[...${V}.camera.position.toArray(), ...${V}.controls.target.toArray()]`);
      await d.evaluate(`${V}.resetCamera()`);
      await sleep(700);
      await d.evaluate(`${V}.command(${JSON.stringify("view " + expr)})`);
      await sleep(650);
      const viaCmd = await d.evaluate<number[]>(
        `[...${V}.camera.position.toArray(), ...${V}.controls.target.toArray()]`);
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
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: "color" | "edgeColor") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: "color" | "edgeColor") =>
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
      await snap("__preEdge", "edgeColor");
      const r = await cmd(`${verb} ${expr} ${tok}`);
      const parity = await d.evaluate<{ changed: number; match: boolean; reach: number }>(`(()=>{
        const v=${V}; const ec=v.rep.state.edgeColor; const s=window.__preEdge;
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
        const v=${V}; const ec=v.rep.state.edgeColor;
        const w=[${rgb.join(",")}].map(x=>Math.fround(x/255));
        const pts=new Set(v.debug.resolvePoints(${JSON.stringify(expr)}));
        for (let e=0;e<v.edges.length;e++) {
          const a=v.edges[e][0], b=v.edges[e][1];
          const hit=${both} ? (pts.has(a)&&pts.has(b)) : (pts.has(a)||pts.has(b));
          if (hit && (ec[3*e]!==w[0]||ec[3*e+1]!==w[1]||ec[3*e+2]!==w[2])) return false;
        }
        return true;
      })()`);

    await snap("__pristineE", "edgeColor");
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
    await snap("__quietE", "edgeColor");
    const depthQuiet1 = await undoDepth();
    const single = await cmd("colorbonds #124 red");
    check("S16: colorbonds on a one-point set is a nomatch (no contained edge exists)",
      single.status === "nomatch" &&
        single.message === `no edges with both endpoints in "#124"`,
      JSON.stringify(single));
    check("S16: ...byte- and depth-identical no-op",
      (await equalsSnap("__quietE", "edgeColor")) && (await undoDepth()) === depthQuiet1);
    const incident = await paintE("colorbondsof", "#124", "#818283");
    check("S16: colorbondsof #124 colors exactly the edges incident to that point",
      incident.r.status === "ok" && incident.parity.match && incident.parity.changed > 0 &&
        incident.parity.reach === incident.parity.changed,
      JSON.stringify(incident));
    check("S16: ...one stroke", (await undoDepth()) === depthQuiet1 + 1);

    // -- (d) independence: each verb writes ITS primitive's buffer only ----------
    await snap("__indepE", "edgeColor");
    await cmd("colorpoints beta #0a0b0c");
    check("S16: colorpoints leaves the edge buffer untouched",
      await equalsSnap("__indepE", "edgeColor"));
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
      await equalsSnap("__pristineE", "edgeColor"));
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
      (await equalsSnap("__preEdge", "edgeColor")) &&
        (await undoDepth()) === depthHidden && (await visibleCount(d)) === visHidden);

    // -- (g) the remaining quiet paths for the edge verbs -------------------------
    await snap("__quiet2E", "edgeColor");
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
      await equalsSnap("__quiet2E", "edgeColor"));
    check("S16: ...none of them pushed a stroke", (await undoDepth()) === depthQuiet2);

    await d.screenshot(`${REPORT}/S16_colorbonds.png`);
  });
}

async function S17(): Promise<void> {
  console.log("S17 — colortrace: per-vertex polyline color, mapped up to subgroup grain");
  await withDriver(async (d) => {
    const cmd = (text: string) =>
      d.evaluate<{ status: string; message: string }>(`${V}.command(${JSON.stringify(text)})`);
    const undoDepth = () => d.evaluate<number>(`${V}.model.undoDepth`);
    const snap = (slot: string, buf: "color" | "edgeColor" | "traceColor") =>
      d.evaluate(`void (window.${slot} = Float32Array.from(${V}.rep.state.${buf}))`);
    const equalsSnap = (slot: string, buf: "color" | "edgeColor" | "traceColor") =>
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
    await snap("__indepE", "edgeColor");
    await cmd("colortrace beta #0a0b0c");
    check("S17: colortrace leaves the point AND edge buffers untouched",
      (await equalsSnap("__indepP", "color")) && (await equalsSnap("__indepE", "edgeColor")));
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
  const BUFS = ["color", "edgeColor", "traceColor", "size", "edgeSize", "traceSize"] as const;
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
      ["colorbonds gamma #141516", `["edgeColor"]`],
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
    "color", "edgeColor", "traceColor",
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
      ["colorbonds gamma #242526", `["edgeColor"]`],
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

// ============================ runner ==========================================
const which = process.argv.slice(2);
const all: Record<string, () => Promise<void>> = { S0, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, S13, S14, S15, S16, S17, S18, S19 };
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
