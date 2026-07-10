/**
 * Unit tests for the command registry's built-ins that need no DOM — the
 * help/? verb and the registry surface. Pure, no DOM. Run from viewer/:
 * node --test tests/commands.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { buildTree } from "../webview/classification.ts";
import { Hierarchy, type Entry } from "../webview/sets.ts";
import { createCommandRegistry, HELP_TEXT, type CommandContext } from "../webview/commands.ts";

function makeHeader(): Header {
  const category = [0, 0, 1];
  const group_id = [0, 0, 1];
  const subgroup_id = [0, 0, 1];
  return {
    version: "0.1.0", name: "t", n_points: 3, n_frames: 1, units: "m", bbox: null,
    points: { type: ["a", "b", "c"], group_id, subgroup_id, category },
    categories: ["c0", "c1"], groups: { "0": "g0", "1": "g1" },
    subgroups: { "0": "s0", "1": "s1" }, edges: [], polylines: [], channels: [],
  };
}

function makeRegistry() {
  const header = makeHeader();
  const hierarchy = new Hierarchy(header);
  const calls = { focus: 0, frame: 0, flash: 0 };
  // stateful stubs: record what the handlers asked for and mimic the model's
  // surface (collision error for "taken", auto-name, idempotence via state)
  const commits: { entries: Entry[]; name: string | null; hide: boolean }[] = [];
  const hiddenState = { whole: new Map<string, boolean>(), pts: new Set<number>() };
  const ctx: CommandContext = {
    hierarchy,
    tree: buildTree(header),
    pointTypes: header.points.type,
    committedEntries: () =>
      new Map<string, readonly Entry[]>([
        ["stored", [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]],
      ]),
    focusPoints: () => { calls.focus++; },
    frameVisible: () => { calls.frame++; },
    flashPointRows: () => { calls.flash++; },
    commitEntries: (entries, name, hide = false) => {
      if (name === "taken") return { error: `a selection named "taken" already exists` };
      commits.push({ entries, name, hide });
      const pts = new Set<number>();
      for (const e of entries) for (const p of hierarchy.pointsOf(e)) pts.add(p);
      return { name: name ?? "selection_1", points: pts.size };
    },
    setSelectionHidden: (name, hidden) => {
      const cur = hiddenState.whole.get(name) ?? false;
      if (cur === hidden) return { affected: 0 };
      hiddenState.whole.set(name, hidden);
      return { affected: 4 };
    },
    setPointsHiddenIn: (_name, points, hidden) => {
      const delta = points.filter((p) => hiddenState.pts.has(p) !== hidden);
      for (const p of delta) {
        if (hidden) hiddenState.pts.add(p);
        else hiddenState.pts.delete(p);
      }
      return { affected: delta.length };
    },
    showPointsCovering: (points) => {
      const delta = points.filter((p) => hiddenState.pts.has(p));
      for (const p of delta) hiddenState.pts.delete(p);
      return delta.length;
    },
    showAll: () => {
      let n = hiddenState.pts.size;
      hiddenState.pts.clear();
      for (const [k, v] of hiddenState.whole) {
        if (v) {
          n += 4;
          hiddenState.whole.set(k, false);
        }
      }
      return n;
    },
  };
  return { registry: createCommandRegistry(ctx), calls, commits, hiddenState };
}

test("help and ? return a non-empty ok summary pointing at the full reference", () => {
  const { registry, calls } = makeRegistry();
  for (const cmd of ["help", "?"]) {
    const res = registry.runCommand(cmd);
    assert.equal(res.status, "ok", cmd);
    assert.ok(res.message.length > 0);
    assert.match(res.message, /docs\/COMMANDS\.md/);
    assert.match(res.message, /@name/); // the summary covers the grammar essentials
    assert.match(res.message, /#N/);
  }
  assert.equal(registry.runCommand("help").message, HELP_TEXT);
  assert.equal(calls.focus + calls.frame + calls.flash, 0, "help drives no viewer action");
});

test("help is an ordinary registry verb (present in the autocomplete pool)", () => {
  const { registry } = makeRegistry();
  const verbs = registry.verbs();
  assert.ok(verbs.includes("help"));
  assert.ok(verbs.includes("?"));
  assert.ok(verbs.includes("view"));
});

test("help <verb> prints the registered one-liner; unknown verb is a nomatch", () => {
  const { registry } = makeRegistry();
  const res = registry.runCommand("help view");
  assert.equal(res.status, "ok");
  assert.match(res.message, /^view — .+/);
  assert.match(registry.runCommand("help ?").message, /alias of help/);
  const miss = registry.runCommand("help bogus");
  assert.equal(miss.status, "nomatch");
  assert.match(miss.message, /no such command: bogus/);
});

test("create_sele commits the resolved entries AT THEIR NATURAL LEVEL", () => {
  const { registry, commits } = makeRegistry();
  // a category-level path stays ONE coarse entry (never expanded to points)
  let res = registry.runCommand("create_sele c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, `created "selection_1" — 2 points`);
  assert.deepEqual(commits.at(-1),
    { entries: [{ level: "category", id: 0 }], name: null, hide: false });
  // a leaf path stays point entries (never collapsed to a coarser handle)
  registry.runCommand("create_sele c0.g0.s0.*");
  assert.deepEqual(commits.at(-1)?.entries, [{ level: "point", id: 0 }, { level: "point", id: 1 }]);
  // #N is a single point entry
  registry.runCommand("create_sele #1");
  assert.deepEqual(commits.at(-1)?.entries, [{ level: "point", id: 1 }]);
  // @name contributes its STORED entries, unflattened — mixed levels survive
  registry.runCommand("create_sele @stored");
  assert.deepEqual(commits.at(-1)?.entries,
    [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]);
  // a union commits each term at its own level (mixed-level member list)
  registry.runCommand("create_sele c1 + #0");
  assert.deepEqual(commits.at(-1)?.entries,
    [{ level: "category", id: 1 }, { level: "point", id: 0 }]);
});

test("create_sele [name] is verbatim; collisions error; empty target commits nothing", () => {
  const { registry, commits } = makeRegistry();
  const res = registry.runCommand("create_sele c0 [a+b.c #5]");
  assert.equal(res.status, "ok");
  assert.equal(res.message, `created "a+b.c #5" — 2 points`);
  assert.equal(commits.at(-1)?.name, "a+b.c #5");
  const clash = registry.runCommand("create_sele c0 [taken]");
  assert.equal(clash.status, "error");
  assert.match(clash.message, /a selection named "taken" already exists/);
  const before = commits.length;
  const miss = registry.runCommand("create_sele zzz");
  assert.equal(miss.status, "nomatch");
  assert.equal(commits.length, before, "no commit on an empty target");
  assert.match((registry.runCommand("create_sele c0 []")).message, /empty selection name/);
  assert.match((registry.runCommand("create_sele c[0]x")).message, /reserved character "\["/);
  assert.ok(registry.verbs().includes("create_sele"), "registered like any verb");
});

test("hide: commit-then-hide for plain targets, whole/member for @name, errors", () => {
  const { registry, commits } = makeRegistry();
  assert.match(registry.runCommand("hide").message, /hide needs a target/);
  assert.equal(registry.runCommand("hide").status, "error");
  // plain target → the create_sele template with hide folded in
  let res = registry.runCommand("hide c0");
  assert.equal(res.message, `created and hid "selection_1" — 2 points`);
  assert.deepEqual(commits.at(-1),
    { entries: [{ level: "category", id: 0 }], name: null, hide: true });
  res = registry.runCommand("hide c1 [dark]");
  assert.equal(res.message, `created and hid "dark" — 1 points`);
  assert.equal(commits.at(-1)?.hide, true);
  assert.match(registry.runCommand("hide c0 [taken]").message, /already exists/);
  // @name → whole-selection flag; NEVER toggles (idempotent ok)
  res = registry.runCommand("hide @stored");
  assert.deepEqual(res, { status: "ok", message: `hid "stored" — 4 points` });
  assert.deepEqual(registry.runCommand("hide @stored"),
    { status: "ok", message: `"stored" is already hidden` });
  // @name.<pred> → member subset (types: pts 0,1 = "a","b"; pt 2 = "c")
  res = registry.runCommand("hide @stored.a");
  assert.deepEqual(res, { status: "ok", message: `hid 1 points in "stored"` });
  assert.match(registry.runCommand("hide @stored.a").message, /already hidden — 1 points/);
  // usage errors and empty matches
  assert.match(registry.runCommand("hide @stored [x]").message,
    /applies only when hide commits/);
  assert.equal(registry.runCommand("hide @nope").status, "nomatch");
  assert.equal(registry.runCommand("hide zzz").status, "nomatch");
  assert.equal(commits.length, 2, "nomatch/errors committed nothing further");
});

test("show: never commits — clears whole/member/covering state, honest no-ops", () => {
  const { registry, commits } = makeRegistry();
  // nothing hidden yet: bare show and path-show no-op honestly
  assert.deepEqual(registry.runCommand("show"), { status: "ok", message: "nothing hidden" });
  assert.match(registry.runCommand("show c0").message, /nothing hidden there — 2 points already visible/);
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `"stored" is already visible` });
  // hide, then show inverts each granularity
  registry.runCommand("hide @stored");
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 4 points` });
  registry.runCommand("hide @stored.a"); // hides point 0
  assert.deepEqual(registry.runCommand("show @stored.a"),
    { status: "ok", message: `showed 1 points in "stored"` });
  assert.deepEqual(registry.runCommand("show @stored.a"),
    { status: "ok", message: `nothing hidden there` });
  // path-show clears covering hidden state without committing
  registry.runCommand("hide @stored.a"); // point 0 hidden again
  assert.deepEqual(registry.runCommand("show c0"), { status: "ok", message: "showed 1 points" });
  // bare show clears everything, in one call
  registry.runCommand("hide @stored");
  registry.runCommand("hide @stored.a");
  assert.match(registry.runCommand("show").message, /showed everything — 5 points/);
  // show never commits and rejects [name]
  assert.match(registry.runCommand("show c0 [x]").message, /show takes no \[name\]/);
  assert.equal(registry.runCommand("show zzz").status, "nomatch");
  assert.equal(registry.runCommand("show @nope").status, "nomatch");
  assert.equal(commits.length, 0, "show committed nothing, ever");
  assert.ok(registry.verbs().includes("hide") && registry.verbs().includes("show"));
});

test("view still dispatches through the same registry (bare view = frameVisible)", () => {
  const { registry, calls } = makeRegistry();
  const res = registry.runCommand("view");
  assert.equal(res.status, "ok");
  assert.equal(calls.frame, 1);
  const res2 = registry.runCommand("view c0");
  assert.equal(res2.message, "focused 2 points");
  assert.equal(calls.focus, 1);
  assert.equal(calls.flash, 1);
});
