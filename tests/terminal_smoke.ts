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

  // Tab completion round-trips through the SAME relay, with the STATELESS
  // two-stage rule: a partial token settles (no dot); Tab on the now-exact
  // token descends — appends "." and prints the next level's candidates
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view alp");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("stage one: a partial token settles WITHOUT a dot",
    (await inputValue()) === "view alpha", JSON.stringify(await inputValue()));
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  let lines2 = await logLines();
  let lastLine = lines2[lines2.length - 1];
  check("stage two: Tab on the exact token descends (dot + next level printed)",
    (await inputValue()) === "view alpha." &&
      /term-echo/.test(lastLine?.cls ?? "") && lastLine?.text === "group-0  group-1  group-2",
    `input=${JSON.stringify(await inputValue())} line=${JSON.stringify(lastLine)}`);
  await d.insertText("group-");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("a partial multi-match still lists candidates, input unchanged",
    (await inputValue()) === "view alpha.group-" &&
      lastLine?.text === "group-0  group-1  group-2",
    JSON.stringify(lastLine));
  await d.insertText("0");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("exact group descends into ITS branch (dot + scoped subgroups printed)",
    (await inputValue()) === "view alpha.group-0." &&
      lastLine?.text === "subgroup-0  subgroup-3",
    `input=${JSON.stringify(await inputValue())} line=${JSON.stringify(lastLine)}`);
  await d.insertText("sub");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("common-prefix extension is unchanged (stage one again)",
    (await inputValue()) === "view alpha.group-0.subgroup-", JSON.stringify(await inputValue()));

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
  // REVERSED: the filter sees the seed's stored MEMBERSHIP — one category
  // member labeled "solvent"; descendant tokens beneath it match nothing
  lastLine = await runLine("view @solvent.anchor");
  check("a descendant token nomatches through the relay (membership-only)",
    /term-nomatch/.test(lastLine?.cls ?? ""), JSON.stringify(lastLine));
  lastLine = await runLine("view @solvent.solvent");
  check("the member's OWN label matches — the whole member",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 4800 points",
    JSON.stringify(lastLine));
  lastLine = await runLine("view @solvent.x:y");
  check("':' in a @name filter is the reserved-syntax parse error",
    /term-err/.test(lastLine?.cls ?? "") && /level qualifiers/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  // fine-grained addressing = commit a fine selection; its members ARE points
  lastLine = await runLine("create_sele alpha.group-0.subgroup-0.* [fine]");
  check("(setup) a fine selection with point members",
    lastLine?.text === `created "fine" — 100 points`, JSON.stringify(lastLine));
  lastLine = await runLine("view @fine.anchor");
  check("point members match on their own type",
    lastLine?.text === "focused 1 points", JSON.stringify(lastLine));
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view @fine.an");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("Tab after @name. completes a point MEMBER's type",
    (await inputValue()) === "view @fine.anchor", JSON.stringify(await inputValue()));

  // #* — the stored point-level members ≡ the whole fine selection
  lastLine = await runLine("view @fine.#*");
  const wholeSel = await runLine("view @fine");
  check("view @name.#* = the stored point members (≡ @name for a fine selection)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 100 points" &&
      wholeSel?.text === lastLine?.text,
    JSON.stringify([lastLine?.text, wholeSel?.text]));

  // an exact @name token descends on the second Tab (stateless two-stage)
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view @fin");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  check("a partial @name settles without a dot",
    (await inputValue()) === "view @fine", JSON.stringify(await inputValue()));
  await d.key("Tab", "Tab", 9);
  await sleep(600);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("Tab on the exact @name descends — the MEMBER pool under the filter header",
    (await inputValue()) === "view @fine." &&
      /term-echo/.test(lastLine?.cls ?? "") &&
      lastLine?.text === "filter by (type or label):\nanchor  t0  t1  t2  t3",
    `input=${JSON.stringify(await inputValue())} line=${JSON.stringify(lastLine)}`);
  // the volume cap still applies when the MEMBERSHIP itself is large
  lastLine = await runLine("create_sele solvent.solvent-bath.0-59 [sixty]");
  check("(setup) a 60-member selection", /created "sixty"/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  await d.evaluate(`(()=>{document.getElementById('term-input').value=''; return true;})()`);
  await clickInput();
  await d.insertText("view @sixty.");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("an oversized MEMBER pool caps to the hint under the header",
    /^filter by \(type or label\):\n\d+ matches\s+— type to narrow$/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  await d.insertText("solvent-1");
  await d.key("Tab", "Tab", 9);
  await sleep(400);
  lines2 = await logLines();
  lastLine = lines2[lines2.length - 1];
  check("…and a prefix narrows it to a listable member set",
    /^filter by \(type or label\):\nsolvent-1  solvent-10/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  // repeated Tab on the unchanged input must NOT stack duplicate previews
  const logLenAt = (await logLines()).length;
  await d.key("Tab", "Tab", 9);
  await sleep(300);
  await d.key("Tab", "Tab", 9);
  await sleep(300);
  check("mashing Tab shows the preview once — no stacking",
    (await logLines()).length === logLenAt,
    `len ${(await logLines()).length} vs ${logLenAt}`);

  // inverted range bounds normalize: #hi-lo ≡ #lo-hi
  lastLine = await runLine("view #10-5");
  const forward = await runLine("view #5-10");
  check("an inverted # range resolves identically to its forward form",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "focused 6 points" &&
      forward?.text === lastLine?.text,
    JSON.stringify([lastLine?.text, forward?.text]));

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

  // hide/show through the real relay, with the panel's purple reflecting it
  lastLine = await runLine("hide alpha.group-0.subgroup-3");
  check("hide <target> commits-then-hides via the relay",
    /term-ok/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `created and hid "selection_1" — 100 points`,
    JSON.stringify(lastLine));
  lastLine = await runLine("hide @solvent");
  check("hide @name hides the whole selection",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === `hid "solvent" — 4800 points`,
    JSON.stringify(lastLine));
  check("…and its block goes purple in the panel",
    await d.evaluate<boolean>(`[...document.querySelectorAll('#selections .sel-block')]
      .some(b=>b.querySelector('.sel-name')?.textContent==='solvent'
        && b.classList.contains('hidden-sel'))`));
  lastLine = await runLine("show @solvent");
  check("show @name clears the whole-selection flag",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === `showed "solvent" — 4800 points`,
    JSON.stringify(lastLine));
  lastLine = await runLine("show");
  check("bare show reveals everything",
    /term-ok/.test(lastLine?.cls ?? "") && /^showed everything — \d+ points$/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  check("…and no block stays purple",
    await d.evaluate<boolean>(`[...document.querySelectorAll('#selections .sel-block')]
      .every(b=>!b.classList.contains('hidden-sel'))`));
  // member-state symmetry: show @name reveals what member hides hid
  await runLine("hide @fine.t1");
  lastLine = await runLine("show @fine");
  check("hide @name.<member-pred> then show @name leaves the selection fully visible",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === `showed "fine" — 25 points`,
    JSON.stringify(lastLine));

  // ---- the batch: ls / clear / rename / hide's commit rule --------------------
  lastLine = await runLine("ls");
  check("ls lists the committed selections through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && /solvent — 4800 points/.test(lastLine?.text ?? "") &&
      /picked — 100 points/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  lastLine = await runLine("ls @solvent");
  check("ls @name prints the stored members, panel-style",
    lastLine?.text === "solvent — 4800 points", JSON.stringify(lastLine));
  lastLine = await runLine("ls @sixty");
  check("an oversized ls caps with the count-and-hint",
    lastLine?.text === "60 members — narrow the target", JSON.stringify(lastLine));

  check("(setup) the log is non-empty before clear", (await logLines()).length > 0);
  await submit("clear");
  check("clear empties the terminal log", (await logLines()).length === 0,
    `${(await logLines()).length} lines left`);
  lastLine = await runLine("ls @solvent");
  check("the session keeps working after clear",
    lastLine?.text === "solvent — 4800 points", JSON.stringify(lastLine));

  lastLine = await runLine("rename @picked [x2]");
  check("rename lands through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === `renamed "picked" → "x2"`,
    JSON.stringify(lastLine));
  check("…and the panel block carries the new name",
    await d.evaluate<boolean>(`(()=>{
      const names=[...document.querySelectorAll('#selections .sel-name')].map(n=>n.textContent);
      return names.includes('x2') && !names.includes('picked');
    })()`));

  const blocksBefore = await d.evaluate<number>(
    `document.querySelectorAll('#selections .sel-block').length`);
  lastLine = await runLine("hide @all");
  check("hide @all hides in place — the honest across-selections line",
    /^hid \d+ points across \d+ selections$/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  check("…and commits NO new selection",
    (await d.evaluate<number>(`document.querySelectorAll('#selections .sel-block').length`)) ===
      blocksBefore);
  await runLine("show");
  lastLine = await runLine("hide all");
  check("hide all (the everything KEYWORD) commits ONE new selection, honestly sized",
    /^created and hid "selection_\d+" — 6000 points$/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  check("…as a new panel block",
    (await d.evaluate<number>(`document.querySelectorAll('#selections .sel-block').length`)) ===
      blocksBefore + 1);
  await runLine("show");

  // ---- add / remove: membership mutation through the relay ---------------------
  lastLine = await runLine("add @x2 alpha.group-0.subgroup-3");
  check("add @name <tree-target> lands through the relay",
    /term-ok/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `added 1 members to "x2" — 100 points`,
    JSON.stringify(lastLine));
  lastLine = await runLine("add @x2 @fine");
  check("an @ term on add's right side is the transfer usage error",
    /term-err/.test(lastLine?.cls ?? "") && /no @ terms on the right/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  lastLine = await runLine("remove @x2 subgroup-3");
  check("remove @name <member-pred> drops the matched member",
    lastLine?.text === `removed 1 members from "x2" — 100 points`, JSON.stringify(lastLine));
  lastLine = await runLine("remove @x2 t0");
  check("a non-member predicate (inside the coarse member) is an honest nomatch",
    /term-nomatch|term-err/.test(lastLine?.cls ?? "") &&
      /no members of "x2" match "t0"/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  lastLine = await runLine("remove @sixty all");
  check("remove @name all empties the membership but keeps the block",
    lastLine?.text === `removed 60 members from "sixty" — 180 points (now empty — the selection remains)` &&
      (await d.evaluate<boolean>(`[...document.querySelectorAll('#selections .sel-name')]
        .some(n=>n.textContent==='sixty')`)),
    JSON.stringify(lastLine));
  const blocksBeforeDel = await d.evaluate<number>(
    `document.querySelectorAll('#selections .sel-block').length`);
  lastLine = await runLine("remove @selection_2");
  check("bare remove @name deletes the selection (the ✕ analog)",
    lastLine?.text === `deleted "selection_2" — 6000 points` &&
      (await d.evaluate<number>(`document.querySelectorAll('#selections .sel-block').length`)) ===
        blocksBeforeDel - 1,
    JSON.stringify(lastLine));

  // the color family through the real relay: per-primitive writes + errors
  lastLine = await runLine("colorpoints alpha.group-0.subgroup-0 green");
  check("colorpoints <target> <color> lands through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "colored 100 points green",
    JSON.stringify(lastLine));
  check("…and the point buffer actually carries the CSS green (008000)",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const c=v.rep.state.color;
      const want=[0x00,0x80,0x00].map(x=>Math.fround(x/255));
      return v.debug.resolvePoints("alpha.group-0.subgroup-0")
        .every(p=>c[3*p]===want[0]&&c[3*p+1]===want[1]&&c[3*p+2]===want[2]);
    })()`));
  lastLine = await runLine("color alpha green");
  check("the RENAME is total — color is an unknown command through the relay",
    /term-err/.test(lastLine?.cls ?? "") && lastLine?.text === "unknown command: color",
    JSON.stringify(lastLine));
  lastLine = await runLine("colorbonds alpha.group-0.subgroup-0 steelblue");
  check("colorbonds lands through the relay (contained edges of the subgroup)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "colored 99 edges steelblue",
    JSON.stringify(lastLine));
  check("…and the edge buffer carries steelblue on exactly the contained edges",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const ec=v.rep.state.edgeColor;
      const want=[0x46,0x82,0xb4].map(x=>Math.fround(x/255));
      const pts=new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"));
      let hits=0;
      for (let e=0;e<v.edges.length;e++) {
        const both=pts.has(v.edges[e][0])&&pts.has(v.edges[e][1]);
        const painted=ec[3*e]===want[0]&&ec[3*e+1]===want[1]&&ec[3*e+2]===want[2];
        if (both !== painted) return false;
        if (painted) hits++;
      }
      return hits === 99;
    })()`));
  lastLine = await runLine("colorbondsof #124 tomato");
  check("colorbondsof lands through the relay (edges incident to one point)",
    /term-ok/.test(lastLine?.cls ?? "") && /^colored \d+ edges tomato$/.test(lastLine?.text ?? ""),
    JSON.stringify(lastLine));
  lastLine = await runLine("colortrace alpha orchid");
  check("colortrace lands through the relay (active-subgroup vertices, mapped up)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "colored 4 trace vertices orchid",
    JSON.stringify(lastLine));
  check("…and the trace buffer carries orchid on exactly the active vertices",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const tc=v.rep.state.traceColor;
      const want=[0xda,0x70,0xd6].map(x=>Math.fround(x/255));
      const active=new Set(v.debug.resolvePoints("alpha")
        .map(p=>v.hierarchy.subgroupOfPoint(p)));
      let hits=0;
      for (let i=0;i<v.traceVertices.length;i++) {
        const on=active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]));
        const painted=tc[3*i]===want[0]&&tc[3*i+1]===want[1]&&tc[3*i+2]===want[2];
        if (on !== painted) return false;
        if (painted) hits++;
      }
      return hits === 4;
    })()`));
  lastLine = await runLine("colorbonds alpha nope");
  check("an unknown color is the specific error line",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `unknown color "nope" — use a CSS color name (red, steelblue) or hex (#ff8800)`,
    JSON.stringify(lastLine));

  // the size family through the real relay (buffer state; size ⊥ hide)
  lastLine = await runLine("pointsize alpha.group-0.subgroup-0 5");
  check("pointsize lands through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 100 points to size 5",
    JSON.stringify(lastLine));
  check("…and exactly those points carry size 5 (the rest keep the base 3)",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const s=v.rep.state.size;
      const target=new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"));
      const five=Math.fround(5), three=Math.fround(3);
      let hits=0;
      for (let p=0;p<s.length;p++) {
        if (target.has(p)) { if (s[p]!==five) return false; hits++; }
        else if (s[p]!==three) return false;
      }
      return hits === 100;
    })()`));
  lastLine = await runLine("bondsize alpha.group-0.subgroup-0 2");
  check("bondsize lands through the relay (contained edges, stored width)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 99 edges to size 2",
    JSON.stringify(lastLine));
  check("…and exactly the contained edges carry size 2 in the edge-size buffer",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const es=v.rep.state.edgeSize;
      const pts=new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"));
      const two=Math.fround(2), one=Math.fround(1);
      let hits=0;
      for (let e=0;e<v.edges.length;e++) {
        const both=pts.has(v.edges[e][0])&&pts.has(v.edges[e][1]);
        if (both) { if (es[e]!==two) return false; hits++; }
        else if (es[e]!==one) return false;
      }
      return hits === 99;
    })()`));
  lastLine = await runLine("bondsizeof #124 1.5");
  check("bondsizeof lands through the relay (incident edges of one point)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 2 edges to size 1.5",
    JSON.stringify(lastLine));
  lastLine = await runLine("tracesize alpha 2.5");
  check("tracesize lands through the relay (active-subgroup vertices)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 4 trace vertices to size 2.5",
    JSON.stringify(lastLine));
  check("…and exactly the active vertices carry 2.5 in the trace-size buffer",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const ts=v.rep.state.traceSize;
      const active=new Set(v.debug.resolvePoints("alpha")
        .map(p=>v.hierarchy.subgroupOfPoint(p)));
      const want=Math.fround(2.5), base=Math.fround(1);
      let hits=0;
      for (let i=0;i<v.traceVertices.length;i++) {
        const on=active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]));
        if (on) { if (ts[i]!==want) return false; hits++; }
        else if (ts[i]!==base) return false;
      }
      return hits === 4;
    })()`));
  lastLine = await runLine("pointsize alpha nope");
  check("a non-numeric size is the specific error line",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `not a size: "nope" — use a non-negative number (e.g. 1.5 or 0)`,
    JSON.stringify(lastLine));
  lastLine = await runLine("pointsize beta -3");
  check("a negative size clamps, and the line says so",
    /term-ok/.test(lastLine?.cls ?? "") &&
      lastLine?.text === "set 400 points to size 0 (clamped to 0)",
    JSON.stringify(lastLine));

  // the opacity family through the real relay (opacity ⊥ hide)
  lastLine = await runLine("pointopacity alpha.group-0.subgroup-0 0.5");
  check("pointopacity lands through the relay",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 100 points to opacity 0.5",
    JSON.stringify(lastLine));
  check("…and exactly those points carry alpha 0.5 (the rest stay opaque)",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const o=v.rep.state.opacity;
      const target=new Set(v.debug.resolvePoints("alpha.group-0.subgroup-0"));
      const half=Math.fround(0.5), one=Math.fround(1);
      let hits=0;
      for (let p=0;p<o.length;p++) {
        if (target.has(p)) { if (o[p]!==half) return false; hits++; }
        else if (o[p]!==one) return false;
      }
      return hits === 100;
    })()`));
  lastLine = await runLine("bondopacity alpha.group-0.subgroup-0 0.25");
  check("bondopacity lands through the relay (contained edges)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 99 edges to opacity 0.25",
    JSON.stringify(lastLine));
  lastLine = await runLine("bondopacityof #124 0.3");
  check("bondopacityof lands through the relay (incident edges of one point)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 2 edges to opacity 0.3",
    JSON.stringify(lastLine));
  lastLine = await runLine("traceopacity alpha 0.7");
  check("traceopacity lands through the relay (active-subgroup vertices)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "set 4 trace vertices to opacity 0.7",
    JSON.stringify(lastLine));
  check("…and exactly the active vertices carry 0.7 in the trace-opacity buffer",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const to=v.rep.state.traceOpacity;
      const active=new Set(v.debug.resolvePoints("alpha")
        .map(p=>v.hierarchy.subgroupOfPoint(p)));
      const want=Math.fround(0.7), base=Math.fround(1);
      let hits=0;
      for (let i=0;i<v.traceVertices.length;i++) {
        const on=active.has(v.hierarchy.subgroupOfPoint(v.traceVertices[i]));
        if (on) { if (to[i]!==want) return false; hits++; }
        else if (to[i]!==base) return false;
      }
      return hits === 4;
    })()`));
  lastLine = await runLine("pointopacity alpha nope");
  check("a non-numeric opacity is the specific error line",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `not an opacity: "nope" — use a number from 0 to 1 (e.g. 0.5)`,
    JSON.stringify(lastLine));
  lastLine = await runLine("pointopacity beta 1.5");
  check("an above-range opacity clamps to 1, and the line says so",
    /term-ok/.test(lastLine?.cls ?? "") &&
      lastLine?.text === "set 400 points to opacity 1 (clamped to 1)",
    JSON.stringify(lastLine));

  // the first recipe through the real relay: per-point values, one write
  lastLine = await runLine("rainbow beta.group-1.subgroup-4");
  check("rainbow <target> lands through the relay (the first recipe verb)",
    /term-ok/.test(lastLine?.cls ?? "") && lastLine?.text === "colored 100 points rainbow",
    JSON.stringify(lastLine));
  check("…and the buffer carries a VARYING ramp: red start, magenta end, distinct middle",
    await d.evaluate<boolean>(`(()=>{
      const v=window.__viewer; const c=v.rep.state.color;
      const pts=v.debug.resolvePoints("beta.group-1.subgroup-4");
      const rgb=p=>[c[3*p],c[3*p+1],c[3*p+2]];
      const a=rgb(pts[0]), b=rgb(pts[pts.length-1]), m=rgb(pts[Math.floor(pts.length/2)]);
      return a[0]===1&&a[1]===0&&a[2]===0 &&
             b[0]===1&&b[1]===0&&b[2]===1 &&
             (m[0]!==a[0]||m[1]!==a[1]||m[2]!==a[2]) &&
             (m[0]!==b[0]||m[1]!==b[1]||m[2]!==b[2]);
    })()`));
  lastLine = await runLine("rainbow beta.nonexistent");
  check("a rainbow nomatch is the standard no-write line",
    /term-nomatch/.test(lastLine?.cls ?? "") &&
      lastLine?.text === `nothing matches "beta.nonexistent"`,
    JSON.stringify(lastLine));
  lastLine = await runLine("rainbow");
  check("bare rainbow is the usage error",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === "rainbow needs a target — rainbow <target> (e.g. rainbow alpha.group-0)",
    JSON.stringify(lastLine));

  // the recipe registry read-face through the real relay
  lastLine = await runLine("mods");
  check("mods lists the registry grouped by origin, with rainbow's credit",
    /term-ok/.test(lastLine?.cls ?? "") &&
      lastLine?.text ===
        "built-in:\n  rainbow — point-color · by Dominic Fico · https://github.com/DomFico/molaro",
    JSON.stringify(lastLine));
  lastLine = await runLine("mods rainbow");
  check("mods with stray arguments is the usage error",
    /term-err/.test(lastLine?.cls ?? "") &&
      lastLine?.text === "mods takes no arguments — it lists the recipe registry",
    JSON.stringify(lastLine));

  await d.screenshot(`${REPORT}/terminal_smoke.png`);
} finally {
  await d.dispose();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
