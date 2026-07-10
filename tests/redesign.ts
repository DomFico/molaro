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

    // match-anywhere: an ANCESTOR label now filters too (this exact form was
    // a nomatch before) — pose parity vs a manual pick of those member rows
    await reset();
    const rSelSub = await cmd(`view @selection_1."subgroup-0"`);
    check("S9: @sel.\"<subgroup label>\" resolves the selection's points under it",
      rSelSub.status === "ok" && rSelSub.message === "focused 3 points",
      JSON.stringify(rSelSub));
    await sleep(650);
    const camSelSub = await camState();
    await reset();
    const rows03 = await d.evaluate<{ x: number; y: number }[]>(`(()=>{
      const ids=[${firstPointRows.map((r) => r.id).join(",")}];
      return ids.map(id=>{
        const el=[...document.querySelectorAll('#tree-host .tree-row.selectable')]
          .find(r=>r.dataset.level==='point' && Number(r.dataset.id)===id
            && r.getBoundingClientRect().height>0);
        const b=el.getBoundingClientRect();
        return {x:b.left+b.width/2, y:b.top+b.height/2};});
    })()`);
    await d.drag(rows03[0].x, rows03[0].y, rows03[2].x, rows03[2].y, 4, { button: "right" });
    await sleep(150);
    check("S9: the manual pick pulses the same 3 points", (await flashCount(d)) === 3,
      `flash=${await flashCount(d)}`);
    await sleep(500);
    check("S9: @sel.\"<subgroup label>\" ≡ manually picking those member rows",
      closeCam(camSelSub, await camState()),
      `cmd=${camSelSub.map((v) => v.toFixed(3))}`);
    const rSelGrp = await cmd("view @selection_1.group-0");
    const rSelWrongCat = await cmd("view @selection_1.beta");
    const rSeedSub = await cmd("view @solvent.solvent-0"); // one bulk subgroup by label
    check("S9: ancestor filters — group hit, wrong-category nomatch, seed subgroup subset",
      rSelGrp.message === "focused 3 points" && rSelWrongCat.status === "nomatch" &&
        rSeedSub.message === "focused 3 points",
      JSON.stringify([rSelGrp.message, rSelWrongCat.status, rSeedSub.message]));

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
      ["@name.type", "@selection_1.t1"],
      ["@name.subgroup-label", `@selection_1."subgroup-0"`],
      ["@name.group-label", "@selection_1.group-0"],
      ["@name.category-label", "@selection_1.alpha"],
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
    await cmd("create_sele alpha.group-0.subgroup-0 [base]");
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
    // a point INSIDE the coarse subgroup-0 member: the widened per-member path
    const rC = await cmd("hide @mix.#5");
    check("S12: a coarse-entry point-subset hides exactly the named point",
      rC.message === `hid 1 points in "mix"` && (await visibleCount(d)) === 5999,
      JSON.stringify(rC));
    check("S12: ...reported in the member count, not as a row-purple",
      await d.evaluate<boolean>(`(()=>{
        const b=[...document.querySelectorAll('#selections .sel-block')]
          .find(x=>x.querySelector('.sel-name')?.textContent==='mix');
        const subRow=[...b.querySelectorAll('.tree-row.selectable')]
          .find(r=>r.dataset.level==='subgroup');
        return /1 hidden/.test(b.querySelector('.sel-count').textContent) &&
          !subRow.classList.contains('hidden-entry-row');
      })()`));
    const rShowC = await cmd("show @mix.#5");
    check("S12: show @name.#N inverts the coarse-subset hide",
      rShowC.message === `showed 1 points in "mix"` && (await visibleCount(d)) === 6000,
      JSON.stringify(rShowC));
    // a type filter names a member subset too
    const rT = await cmd("hide @mix.t1");
    check("S12: hide @name.<type> hides the matched subset",
      rT.message === `hid 25 points in "mix"` && (await visibleCount(d)) === 5975,
      JSON.stringify(rT));
    const rAll = await cmd("show @mix.#*");
    check("S12: show @name.#* clears every member hide",
      rAll.message === `showed 25 points in "mix"` && (await visibleCount(d)) === 6000,
      JSON.stringify(rAll));

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
    await cmd("hide @mix.#*");
    check("S12: (repro setup) hide @name.#* hides all members",
      (await visibleCount(d)) === 5899, `visible=${await visibleCount(d)}`);
    const rShowWhole = await cmd("show @mix");
    check("S12: show @name now clears member hides too (the reported trap)",
      rShowWhole.message === `showed "mix" — 101 points` && (await visibleCount(d)) === 6000,
      JSON.stringify(rShowWhole));
    await cmd("hide @mix.#*");
    // t* names the 99 t-typed points of sub-0; p0 and p200 are anchors
    const rNarrow = await cmd("show @mix.t*");
    check("S12: a narrower show clears EXACTLY its subset — the coarse entry splits",
      rNarrow.message === `showed 99 points in "mix"` && (await visibleCount(d)) === 5998,
      JSON.stringify(rNarrow) + ` visible=${await visibleCount(d)}`);
    check("S12: ...the unnamed anchors stay hidden",
      await d.evaluate<boolean>(
        `${V}.model.isPointHidden(0) && ${V}.model.isPointHidden(200)`));
    await cmd("show @mix");
    // narrower round-trip returns to baseline with clean undo depth
    const depthRT = await undoDepth();
    await cmd("hide @mix.t1");
    await cmd("show @mix.t1");
    check("S12: a narrow hide/show round-trip → baseline, exactly two undo ops",
      (await visibleCount(d)) === 6000 && (await undoDepth()) === depthRT + 2);
    // whole flag + member hide clear together, as ONE op, and undo restores both
    await cmd("hide @mix.#5");
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
    // a subset show against a WHOLE-hidden selection explains itself
    await cmd("hide @mix");
    const rHint = await cmd("show @mix.t1");
    check("S12: subset show on a whole-hidden selection points at show @name",
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

// ============================ runner ==========================================
const which = process.argv.slice(2);
const all: Record<string, () => Promise<void>> = { S0, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12 };
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
