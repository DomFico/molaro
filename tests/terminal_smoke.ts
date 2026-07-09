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
    /term-nomatch/.test(lines[5]?.cls ?? "") && /nothing matches/.test(lines[5]?.text ?? ""),
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

  // Tab completion round-trips through the SAME relay: the terminal ships
  // {complete, text, cursor}, the viewer computes over its tree, the result
  // extends the input and ambiguous candidates print into the log
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view alp");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab completes a unique category and appends the level dot",
    (await inputValue()) === "view alpha.", JSON.stringify(await inputValue()));
  await d.insertText("group-");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  let lines2 = await logLines();
  let lastLine = lines2[lines2.length - 1];
  check("ambiguous Tab prints the candidate list through the relay",
    /term-echo/.test(lastLine?.cls ?? "") && lastLine?.text === "group-0  group-1  group-2",
    JSON.stringify(lastLine));
  check("…and the input is unchanged (no shared extension)",
    (await inputValue()) === "view alpha.group-");
  await d.insertText("0.sub");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab extends to the common prefix of the branch's subgroups",
    (await inputValue()) === "view alpha.group-0.subgroup-", JSON.stringify(await inputValue()));
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("…printing the scoped candidates (alpha's subgroups only)",
    lastLine?.text === "subgroup-0  subgroup-3", JSON.stringify(lastLine));

  // #index through the real relay: frames one point; Tab on a #-token is inert
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view #42");
  const logLenBefore = (await logLines()).length;
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab on a #-prefixed token is inert (input and log unchanged)",
    (await inputValue()) === "view #42" && (await logLines()).length === logLenBefore);
  await d.key("Enter", "Enter", 13);
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("view #N frames a single point through the real relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 1 points",
    JSON.stringify(lastLine));

  // @name.<leaf-pred>: filter the seeded selection through the real relay.
  // The solvent seed at this harness's N=6000 holds 1,600 tiny subgroups,
  // one anchor each; "solvent-bath" is its group label (match-anywhere).
  const runLine = async (text: string) => {
    await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
    await clickInput();
    await d.insertText(text);
    await d.key("Enter", "Enter", 13);
    await sleep(500);
    const all = await logLines();
    return all[all.length - 1];
  };
  lastLine = await runLine("view @solvent.anchor");
  check("view @name.<type literal> filters the committed selection via the relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 1600 points",
    JSON.stringify(lastLine));
  lastLine = await runLine("view @solvent.solvent-bath");
  check("view @name.<ancestor label> matches anywhere (group label = whole seed)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 4800 points",
    JSON.stringify(lastLine));
  lastLine = await runLine("view @solvent.x:y");
  check("':' in a @name filter is the reserved-syntax parse error",
    /term-err/.test(lastLine?.cls ?? "") && /level qualifiers/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  // Tab after @name. draws from the MERGED identity pool (types + labels):
  // a type token completes…
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view @solvent.an");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab after @name. completes a selection type token",
    (await inputValue()) === "view @solvent.anchor", JSON.stringify(await inputValue()));
  // …and so does an ancestor label from the same pool
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view @solvent.solvent-b");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab after @name. completes a selection ancestor label",
    (await inputValue()) === "view @solvent.solvent-bath", JSON.stringify(await inputValue()));

  // help through the real relay, and verb autocomplete offering it
  lastLine = await runLine("help");
  check("help prints the grammar summary through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && /docs\/COMMANDS\.md/.test(lastLine?.text ?? "") &&
      /@name/.test(lastLine?.text ?? "") && /#N/.test(lastLine?.text ?? ""),
    (lastLine?.text ?? "").slice(0, 80));
  lastLine = await runLine("? view");
  check("? is the help alias; help <verb> prints the verb's one-liner",
    /term-ok/.test(lastLine?.cls ?? "") && /^view — /.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.key("Tab", "Tab", 9); // empty prompt → the verb list
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("Tab at an empty prompt lists the verbs, help included",
    /term-echo/.test(lastLine?.cls ?? "") && /\bhelp\b/.test(lastLine?.text ?? "") &&
      /\bview\b/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));

  // create_sele through the real relay: commit, top-section block, collision
  lastLine = await runLine("create_sele alpha.group-0.subgroup-0 [picked]");
  check("create_sele commits through the relay with the created line",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === `created "picked" — 100 points`,
    JSON.stringify(lastLine));
  check("…and the new block renders in the top section",
    await d.evaluate<boolean>(`[...document.querySelectorAll('#selections .sel-name')]
      .some(n=>n.textContent==='picked')`));
  lastLine = await runLine("create_sele beta [picked]");
  check("an explicit-name collision is the specific error line",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `a selection named "picked" already exists`,
    JSON.stringify(lastLine));

  await d.screenshot(`${REPORT}/terminal_smoke.png`);
} finally {
  await d.dispose();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
