/**
 * Terminal smoke test — the SURFACE and ROUTING, not command semantics (those
 * are proven by tests/address.test.ts and redesign.ts S9 through the seam).
 *
 * The harness can't run two VS Code webviews, so bridge.ts's "/terminal" route
 * serves the REAL terminal bundle into the same page as the REAL viewer, with
 * the extension host's relay emulated by the shim's message loopback (the real
 * host forwards {command}/{commandResult} verbatim between the two panels —
 * the loopback does exactly that within one document). Asserts: the panel
 * loads, accepts input, round-trips a command to the viewer, and displays the
 * result; plus Enter-submit, up/down history, and the HUD's Terminal button.
 *
 * Run from viewer/ (after npm run build):  node tests/terminal_smoke.ts
 */
import { E2EDriver, sleep } from "./e2e_driver.ts";

const REPORT = "reports/terminal";
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
}

console.log("terminal smoke — panel loads, round-trips a command, prints the result");
const d = new E2EDriver({
  bridgePort: 9700, cdpPort: 9980, width: 1180, height: 780,
  producerArgs: ["--n-points", "6000", "--n-frames", "150"],
  route: "/terminal",
});
try {
  await d.start();
  await d.navigate();
  await sleep(3200);

  const logLines = () =>
    d.evaluate<{ cls: string; text: string }[]>(
      `[...document.querySelectorAll('#term-log .term-line')].map(l=>({cls:l.className,text:l.textContent}))`,
    );
  const inputValue = () => d.evaluate<string>(`document.getElementById('term-input').value`);
  const clickInput = async () => {
    const r = await d.evaluate<{ x: number; y: number }>(`(()=>{
      const b=document.getElementById('term-input').getBoundingClientRect();
      return {x:b.left+b.width/2, y:b.top+b.height/2};
    })()`);
    await d.click(r.x, r.y);
  };
  const submit = async (text: string) => {
    await clickInput();
    await d.insertText(text);
    await d.key("Enter", "Enter", 13);
    await sleep(300);
  };

  // surface loads: real terminal DOM + the real viewer alive underneath
  check("terminal surface loads (log + input)",
    await d.evaluate<boolean>(`!!document.getElementById('term-log') && !!document.getElementById('term-input')`));
  check("viewer booted in the same harness",
    await d.evaluate<boolean>(`typeof window.__viewer === 'object'`));
  check("HUD carries the Terminal button (the panel's entry point)",
    await d.evaluate<boolean>(
      `document.getElementById('terminal-btn')?.textContent === 'Terminal'`));

  // round trip: typed text → {command} → viewer runCommand → {commandResult} → log
  const camBefore = await d.evaluate<number[]>(`window.__viewer.camera.position.toArray()`);
  await submit("view alpha");
  let lines = await logLines();
  check("submit echoes the command line",
    lines.length === 2 && /term-echo/.test(lines[0].cls) && lines[0].text === "› view alpha",
    JSON.stringify(lines));
  check("the viewer's result comes back and prints",
    /term-ok/.test(lines[1]?.cls ?? "") && lines[1]?.text === "focused 400 points",
    JSON.stringify(lines[1]));
  check("input clears after submit", (await inputValue()) === "");
  check("the command actually drove the viewer (focus flash live)",
    (await d.evaluate<number>(`window.__viewer.debug.flashCount()`)) === 400);
  await sleep(600);
  const camAfter = await d.evaluate<number[]>(`window.__viewer.camera.position.toArray()`);
  check("…and the camera tweened",
    Math.hypot(camAfter[0] - camBefore[0], camAfter[1] - camBefore[1], camAfter[2] - camBefore[2]) > 1e-3);

  // error and nomatch statuses render distinctly
  await submit("bogus");
  lines = await logLines();
  check("unknown verb prints as an error line",
    /term-err/.test(lines[3]?.cls ?? "") && lines[3]?.text === "unknown command: bogus",
    JSON.stringify(lines[3]));
  await submit("view zzz");
  lines = await logLines();
  check("nomatch prints as a dim line",
    /term-nomatch/.test(lines[5]?.cls ?? "") && /no visible points match/.test(lines[5]?.text ?? ""),
    JSON.stringify(lines[5]));

  // up/down history over the three submitted commands
  await clickInput();
  await d.key("ArrowUp", "ArrowUp", 38);
  check("ArrowUp recalls the last command", (await inputValue()) === "view zzz");
  await d.key("ArrowUp", "ArrowUp", 38);
  await d.key("ArrowUp", "ArrowUp", 38);
  check("ArrowUp walks to the oldest command", (await inputValue()) === "view alpha");
  await d.key("ArrowUp", "ArrowUp", 38);
  check("ArrowUp stops at the oldest", (await inputValue()) === "view alpha");
  await d.key("ArrowDown", "ArrowDown", 40);
  check("ArrowDown walks back forward", (await inputValue()) === "bogus");

  await d.screenshot(`${REPORT}/terminal_smoke.png`);
} finally {
  await d.dispose();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
