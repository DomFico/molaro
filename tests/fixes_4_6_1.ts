/**
 * Increment 4.6.1 validation — dockable/collapsible panel + zoom-out-keeps-
 * orientation + reduced pan. Drives the real webview via CDP; screenshots into
 * reports/fixes_4_6_1/. Run from viewer/ (after `npm run build`):
 *   node tests/fixes_4_6_1.ts
 */
import { E2EDriver, sleep } from "./e2e_driver.ts";

const REPORT = "reports/fixes_4_6_1";
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
const camPos = (d: E2EDriver) =>
  d.evaluate<[number, number, number]>(`(()=>{const p=${V}.camera.position;return [p.x,p.y,p.z];})()`);
const camTarget = (d: E2EDriver) =>
  d.evaluate<[number, number, number]>(`(()=>{const t=${V}.controls.target;return [t.x,t.y,t.z];})()`);
const dir = (p: number[], t: number[]) => {
  const v = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const distv = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const overlaps = (a: any, b: any) =>
  !!a && !!b && a.w > 0 && b.w > 0 && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

async function withDriver(fn: (d: E2EDriver) => Promise<void>): Promise<void> {
  const d = new E2EDriver({
    bridgePort: 8991, cdpPort: 9291, width: 1100, height: 760,
    producerArgs: ["--n-points", "5000", "--n-frames", "120"],
  });
  try {
    await d.start();
    await d.navigate("/");
    await sleep(2800);
    await fn(d);
  } finally {
    await d.dispose();
  }
}

async function docking(d: E2EDriver): Promise<void> {
  console.log("dock — panel on each edge, disjoint from canvas");
  const edgeCheck: Record<string, (s: any, a: any) => boolean> = {
    left: (s, a) => s.x + s.w <= a.x + 2,
    right: (s, a) => s.x >= a.x + a.w - 2,
    top: (s, a) => s.y + s.h <= a.y + 2,
    bottom: (s, a) => s.y >= a.y + a.h - 2,
  };
  for (const pos of ["left", "right", "top", "bottom"] as const) {
    await d.evaluate(`${V}.panel.setDock(${JSON.stringify(pos)})`);
    await sleep(300);
    const s = await rect(d, "#sidebar");
    const a = await rect(d, "#app");
    check(`dock ${pos}: panel on the ${pos} edge`, edgeCheck[pos](s, a), `sidebar=${JSON.stringify(s)} app=${JSON.stringify(a)}`);
    check(`dock ${pos}: panel and canvas disjoint`, !overlaps(s, a));
    // expand a category so the (horizontal, when top/bottom) tree shows content
    await d.evaluate("(()=>{const c=document.querySelector('#sidebar .cat-block .caret'); if(c) c.click();})()");
    await d.screenshot(`${REPORT}/dock_${pos}.png`);
  }
}

async function collapsing(d: E2EDriver): Promise<void> {
  console.log("collapse — panel hides behind a show button");
  await d.evaluate(`${V}.panel.setDock("left")`);
  await d.evaluate(`${V}.panel.setCollapsed(true)`);
  await sleep(250);
  const s = await rect(d, "#sidebar");
  const showBtn = await d.evaluate<boolean>("(()=>{const b=document.getElementById('panel-reopen'); return !!b && getComputedStyle(b).display!=='none';})()");
  const hidden = !s || s.w === 0;
  await d.screenshot(`${REPORT}/collapsed.png`);
  check("collapsed: panel not shown", hidden, `sidebar=${JSON.stringify(s)}`);
  check("collapsed: reopen tab visible", showBtn);
  // restore
  await d.evaluate("document.getElementById('panel-reopen').click()");
  await sleep(200);
  const s2 = await rect(d, "#sidebar");
  check("show: panel restored", !!s2 && s2.w > 0);
}

async function zoomOutKeepsOrientation(d: E2EDriver): Promise<void> {
  console.log("zoom-out — double-click empty keeps current orientation");
  await d.evaluate(`${V}.panel.setDock("left")`);
  await d.evaluate(`(()=>{const p=document.getElementById('playpause'); if(p.textContent==='pause')p.click();})()`);
  const r = await rect(d, "#app");
  const cx = r!.x + r!.w / 2, cy = r!.y + r!.h / 2;
  // Rotate to a non-home orientation, then let inertia FULLY settle before
  // recording the reference direction (otherwise the reference itself is still
  // coasting).
  await d.drag(cx - 100, cy - 60, cx + 110, cy + 40, 8);
  await sleep(1800);
  const dRot = dir(await camPos(d), await camTarget(d));
  // Zoom into a subgroup, then double-click empty to scale back out.
  await d.evaluate(`${V}.actions.toggleSelect({level:'subgroup', id:0})`);
  await d.evaluate(`${V}.zoomToSelection()`);
  await sleep(600);
  await d.screenshot(`${REPORT}/zoomout_before.png`);
  await d.doubleClick(r!.x + 10, r!.y + 10);
  await sleep(700);
  const dOut = dir(await camPos(d), await camTarget(d));
  await d.screenshot(`${REPORT}/zoomout_after.png`);
  check("zoom-out preserves viewing direction", dot(dRot, dOut) > 0.99, `dot=${dot(dRot, dOut).toFixed(4)}`);
  // and it actually backed out to frame the whole scene (target ~ scene center;
  // distance large relative to a single subgroup zoom)
  const distOut = distv(await camPos(d), await camTarget(d));
  check("zoom-out framed the whole scene (backed out)", distOut > 15, `dist=${distOut.toFixed(1)}`);
}

async function run(): Promise<void> {
  await withDriver(async (d) => {
    await docking(d);
    await collapsing(d);
    await zoomOutKeepsOrientation(d);
  });
  console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
run();
