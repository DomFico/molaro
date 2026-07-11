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
import {
  createCommandRegistry,
  HELP_TEXT,
  makeAnalysisModHandler,
  parseColor,
  parseOpacity,
  parseSize,
  type CommandContext,
} from "../webview/commands.ts";
import { listRecipes, registerRecipe, unregisterRecipe } from "../webview/recipes.ts";
import { BIND_SIZE_MAX, bindTypedResult } from "../webview/claudebind.ts";

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
  const hiddenState = { whole: new Map<string, boolean>(), pts: new Set<number>(), members: new Set<string>() };
  // two committed selections so batch-hide / @all / rename have material
  const sels = new Map<string, readonly Entry[]>([
    ["stored", [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]],
    ["second", [{ level: "subgroup", id: 1 }]],
  ]);
  const refOps: { names: string[]; hidden: boolean }[] = [];
  const memberOps: { name: string; mode: "add" | "remove"; entries: Entry[] }[] = [];
  const colorOps: { points: number[]; rgb: [number, number, number] }[] = [];
  const colorEachOps: { points: number[]; rgb: number[] }[] = [];
  const eachOps: { kind: "size" | "opacity"; points: number[]; values: number[] }[] = [];
  const modRuns: { name: string; points: number[]; expr: string }[] = [];
  const rmArms: string[][] = [];
  const edgeOps: { edgeIds: number[]; rgb: [number, number, number] }[] = [];
  // a chain over the 3 points: edge 0 sits inside c0 ({0,1}); edge 1 crosses
  // the category boundary (point 1 in c0, point 2 in c1) — the contained-vs-
  // incident distinction is decidable from these two alone
  const edges: [number, number][] = [[0, 1], [1, 2]];
  const traceOps: { vertexIds: number[]; rgb: [number, number, number] }[] = [];
  // ONE polyline vertex: point 0 (subgroup s0). Point 1 shares s0 but is NOT
  // a vertex (pins the map-up); s1 owns no vertex (pins the nomatch).
  const traceVertices: number[] = [0];
  const sizeOps: { kind: "points" | "edges" | "trace"; ids: number[]; size: number }[] = [];
  const opacityOps: { kind: "points" | "edges" | "trace"; ids: number[]; opacity: number }[] = [];
  const ctx: CommandContext = {
    hierarchy,
    tree: buildTree(header),
    pointTypes: header.points.type,
    committedEntries: () => sels,
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
    setRefsHidden: (ops, hidden) => {
      // one batch = one stroke in the real model; the stub records the batch
      refOps.push({ names: ops.map((o) => o.name), hidden });
      let affected = 0;
      let changed = 0;
      for (const op of ops) {
        const stored = sels.get(op.name);
        if (!stored) return null;
        if (op.entries === null) {
          if ((hiddenState.whole.get(op.name) ?? false) !== hidden) {
            hiddenState.whole.set(op.name, hidden);
            let n = 0;
            for (const e of stored) n += hierarchy.pointsOf(e).length;
            affected += n;
            changed++;
          }
        } else {
          let n = 0;
          for (const e of op.entries) {
            const key = `${e.level}:${e.id}`;
            if (hiddenState.members.has(key) !== hidden) {
              if (hidden) hiddenState.members.add(key);
              else hiddenState.members.delete(key);
              n += hierarchy.pointsOf(e).length;
            }
          }
          if (n > 0) changed++;
          affected += n;
        }
      }
      return { affected, changed };
    },
    selectionsInfo: () =>
      [...sels.keys()].map((name) => {
        let points = 0;
        for (const e of sels.get(name)!) points += hierarchy.pointsOf(e).length;
        return { name, points, hidden: hiddenState.whole.get(name) ?? false };
      }),
    renameSelection: (oldName, newName) => {
      if (!sels.has(oldName)) return { error: `no selection named "${oldName}"` };
      if (newName === "all") return { error: `"all" is reserved` };
      if (sels.has(newName)) return { error: `a selection named "${newName}" already exists` };
      sels.set(newName, sels.get(oldName)!);
      sels.delete(oldName);
      return { ok: true };
    },
    mutateMembers: (name, mode, entries) => {
      const stored = sels.get(name);
      if (!stored) return null;
      memberOps.push({ name, mode, entries });
      const keys = new Set(stored.map((e) => `${e.level}:${e.id}`));
      let next = [...stored];
      let points = 0;
      for (const e of entries) {
        const key = `${e.level}:${e.id}`;
        if (mode === "add") {
          if (keys.has(key)) continue; // idempotent, like addToTarget
          keys.add(key);
          next.push(e);
          points += hierarchy.pointsOf(e).length;
        } else {
          if (!keys.has(key)) continue; // exact members only — never carves
          keys.delete(key);
          next = next.filter((x) => `${x.level}:${x.id}` !== key);
          points += hierarchy.pointsOf(e).length;
        }
      }
      sels.set(name, next);
      return { points, remaining: next.length };
    },
    deleteSelections: (names) => {
      if (names.some((n) => !sels.has(n))) return null;
      const pts = new Set<number>();
      for (const n of names) {
        for (const e of sels.get(n)!) for (const p of hierarchy.pointsOf(e)) pts.add(p);
        sels.delete(n);
        hiddenState.whole.delete(n);
      }
      return { deleted: names.length, points: pts.size };
    },
    setMembersHiddenIn: (name, entries, hidden) => {
      // whole-MEMBER stub: tracks member keys; affected = points of changed members
      let affected = 0;
      for (const e of entries) {
        const key = `${e.level}:${e.id}`;
        if (hiddenState.members.has(key) !== hidden) {
          if (hidden) hiddenState.members.add(key);
          else hiddenState.members.delete(key);
          affected += hierarchy.pointsOf(e).length;
        }
      }
      return { affected, wholeHidden: hiddenState.whole.get(name) ?? false };
    },
    clearSelectionHidden: (name) => {
      let n = hiddenState.pts.size + hiddenState.members.size;
      hiddenState.pts.clear();
      hiddenState.members.clear();
      if (hiddenState.whole.get(name)) {
        for (const e of sels.get(name) ?? []) n += hierarchy.pointsOf(e).length;
        hiddenState.whole.set(name, false);
      }
      return { affected: n };
    },
    showPointsCovering: (points) => {
      const delta = points.filter((p) => hiddenState.pts.has(p));
      for (const p of delta) hiddenState.pts.delete(p);
      return delta.length;
    },
    showAll: () => {
      let n = hiddenState.pts.size + hiddenState.members.size;
      hiddenState.pts.clear();
      hiddenState.members.clear();
      for (const [k, v] of hiddenState.whole) {
        if (v) {
          for (const e of sels.get(k) ?? []) n += hierarchy.pointsOf(e).length;
          hiddenState.whole.set(k, false);
        }
      }
      return n;
    },
    colorPoints: (points, rgb) => {
      // one call = one stroke in the real wiring; the stub records the write
      colorOps.push({ points: [...points], rgb });
      return points.length;
    },
    colorPointsEach: (points, rgb) => {
      colorEachOps.push({ points: [...points], rgb: [...rgb] });
      return points.length;
    },
    sizePointsEach: (points, values) => {
      eachOps.push({ kind: "size", points: [...points], values: [...values] });
      return points.length;
    },
    opacityPointsEach: (points, values) => {
      eachOps.push({ kind: "opacity", points: [...points], values: [...values] });
      return points.length;
    },
    edges,
    colorEdges: (edgeIds, rgb) => {
      edgeOps.push({ edgeIds: [...edgeIds], rgb });
      return edgeIds.length;
    },
    traceVertices,
    colorTrace: (vertexIds, rgb) => {
      traceOps.push({ vertexIds: [...vertexIds], rgb });
      return vertexIds.length;
    },
    sizePoints: (points, size) => {
      sizeOps.push({ kind: "points", ids: [...points], size });
      return points.length;
    },
    sizeEdges: (edgeIds, size) => {
      sizeOps.push({ kind: "edges", ids: [...edgeIds], size });
      return edgeIds.length;
    },
    sizeTrace: (vertexIds, size) => {
      sizeOps.push({ kind: "trace", ids: [...vertexIds], size });
      return vertexIds.length;
    },
    opacityPoints: (points, opacity) => {
      opacityOps.push({ kind: "points", ids: [...points], opacity });
      return points.length;
    },
    opacityEdges: (edgeIds, opacity) => {
      opacityOps.push({ kind: "edges", ids: [...edgeIds], opacity });
      return edgeIds.length;
    },
    opacityTrace: (vertexIds, opacity) => {
      opacityOps.push({ kind: "trace", ids: [...vertexIds], opacity });
      return vertexIds.length;
    },
    runAnalysisMod: (mod, points, expr) => {
      modRuns.push({ name: mod.name, points: [...points], expr });
    },
    armRmDeletion: (names) => {
      rmArms.push([...names]);
    },
  };
  return {
    registry: createCommandRegistry(ctx),
    ctx,
    calls, commits, hiddenState, refOps, memberOps,
    colorOps, colorEachOps, eachOps, edgeOps, traceOps, sizeOps, opacityOps, modRuns, rmArms, sels,
  };
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
  // @name → whole-selection flag; NEVER toggles (idempotent ok).
  // "stored" = subgroup:0 (points 0,1) + point:2 → 3 points.
  res = registry.runCommand("hide @stored");
  assert.deepEqual(res, { status: "ok", message: `hid "stored" — 3 points` });
  assert.deepEqual(registry.runCommand("hide @stored"),
    { status: "ok", message: `"stored" is already hidden` });
  // @name.<pred> → MEMBERSHIP-ONLY (reversed): the filter sees the stored
  // entries — subgroup:0 (label "s0") and point:2 (type "c") — never the
  // ancestry of points beneath the coarse member
  res = registry.runCommand("hide @stored.c"); // a point MEMBER's type
  assert.deepEqual(res, { status: "ok", message: `hid 1 points in "stored"` });
  assert.match(registry.runCommand("hide @stored.c").message, /already hidden — 1 members/);
  res = registry.runCommand("hide @stored.s0"); // a label MEMBER — whole-member hide
  assert.deepEqual(res, { status: "ok", message: `hid 2 points in "stored"` });
  assert.equal(registry.runCommand("hide @stored.a").status, "nomatch",
    "a type INSIDE the coarse member is not a member — nomatch");
  assert.equal(registry.runCommand("hide @stored.#0").status, "nomatch",
    "an index inside a coarse member is not a member — nomatch, no exception");
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
    { status: "ok", message: `showed "stored" — 3 points` });
  registry.runCommand("hide @stored.c"); // hides the point MEMBER 2
  assert.deepEqual(registry.runCommand("show @stored.c"),
    { status: "ok", message: `showed 1 points in "stored"` });
  assert.deepEqual(registry.runCommand("show @stored.c"),
    { status: "ok", message: `nothing hidden there` });
  assert.equal(registry.runCommand("show @stored.a").status, "nomatch",
    "descendant tokens nomatch on show too — the filter is membership-only");
  // bare show clears everything, in one call
  registry.runCommand("hide @stored");
  registry.runCommand("hide @stored.c");
  assert.match(registry.runCommand("show").message, /showed everything — \d+ points/);
  // show never commits and rejects [name]
  assert.match(registry.runCommand("show c0 [x]").message, /show takes no \[name\]/);
  assert.equal(registry.runCommand("show zzz").status, "nomatch");
  assert.equal(registry.runCommand("show @nope").status, "nomatch");
  assert.equal(commits.length, 0, "show committed nothing, ever");
  assert.ok(registry.verbs().includes("hide") && registry.verbs().includes("show"));
});

test("show @name clears whole AND member state; subset shows explain a whole-flag hide", () => {
  const { registry } = makeRegistry();
  // member hides no longer hide behind "already visible"
  registry.runCommand("hide @stored.c");
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 1 points` });
  // a MEMBER show against a WHOLE-hidden selection says so, honestly
  registry.runCommand("hide @stored");
  assert.match(registry.runCommand("show @stored.c").message,
    /hidden whole — show @stored to reveal it/);
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `showed "stored" — 3 points` });
  assert.deepEqual(registry.runCommand("show @stored"),
    { status: "ok", message: `"stored" is already visible` });
});

// -- hide's commit rule (consistency principle 3) ------------------------------------

test("hide: an ALL-REFERENCE target hides in place — no commit, ONE batch (one undo)", () => {
  const { registry, commits, refOps, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored + @second");
  assert.deepEqual(res, { status: "ok", message: "hid 4 points across 2 selections" });
  assert.equal(commits.length, 0, "already committed — nothing new created");
  assert.deepEqual(refOps, [{ names: ["stored", "second"], hidden: true }],
    "one setRefsHidden batch = one stroke = one undo");
  assert.equal(hiddenState.whole.get("stored"), true);
  assert.equal(hiddenState.whole.get("second"), true);
  assert.deepEqual(registry.runCommand("hide @stored + @second"),
    { status: "ok", message: "already hidden" }, "idempotent, never toggles");
  assert.match(registry.runCommand("hide @stored + @second [x]").message,
    /applies only when hide commits/, "[name] is a usage error on a committed target");
  assert.equal(commits.length, 0);
});

test("hide @all: every committed selection, in place, one batch", () => {
  const { registry, commits, refOps } = makeRegistry();
  const res = registry.runCommand("hide @all");
  assert.deepEqual(res, { status: "ok", message: "hid 4 points across 2 selections" });
  assert.equal(commits.length, 0);
  assert.deepEqual(refOps, [{ names: ["stored", "second"], hidden: true }]);
  assert.match(registry.runCommand("hide @all [z]").message, /applies only when hide commits/);
});

test("hide with ANY non-reference term: the whole target commits as ONE new selection", () => {
  const { registry, commits, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored + c1");
  assert.equal(res.message, `created and hid "selection_1" — 3 points`);
  assert.equal(commits.length, 1, "all-or-nothing: exactly one commit for the whole target");
  assert.equal(commits[0].hide, true);
  assert.deepEqual(
    commits[0].entries.map((e) => `${e.level}:${e.id}`).sort(),
    ["category:1", "point:2", "subgroup:0"],
    "the referenced selection CONTRIBUTES entries but stays untouched",
  );
  assert.notEqual(hiddenState.whole.get("stored"), true, "show-wins handles the overlap");
  // `hide all` — the everything KEYWORD is not a reference: commit + honest size
  const all = registry.runCommand("hide all");
  assert.equal(all.message, `created and hid "selection_1" — 3 points`);
  assert.equal(commits.length, 2);
  assert.deepEqual(
    commits[1].entries.map((e) => `${e.level}:${e.id}`).sort(),
    ["category:0", "category:1"],
  );
});

test("hide @name.<pred> + @other: still all-references — in place at member grain", () => {
  const { registry, commits, hiddenState } = makeRegistry();
  const res = registry.runCommand("hide @stored.c + @second");
  assert.deepEqual(res, { status: "ok", message: "hid 2 points across 2 selections" });
  assert.equal(commits.length, 0);
  assert.ok(hiddenState.members.has("point:2"), "the filtered MEMBER hid");
  assert.equal(hiddenState.whole.get("second"), true);
  assert.notEqual(hiddenState.whole.get("stored"), true, "not the whole selection");
});

// -- ls / rename / clear -------------------------------------------------------------

test("ls: read-only listing — selections, members, contents; no state, ever", () => {
  const { registry, commits, refOps } = makeRegistry();
  // bare = the committed selections (the panel's top section as text)
  assert.deepEqual(registry.runCommand("ls"),
    { status: "ok", message: "stored — 3 points\nsecond — 1 points" });
  // @name = its STORED MEMBERS, exactly as the panel lists them
  assert.deepEqual(registry.runCommand("ls @stored"),
    { status: "ok", message: "s0 — 2 points\nc #2 — 1 points" });
  assert.deepEqual(registry.runCommand("ls @all"),
    { status: "ok", message: "s0 — 2 points\nc #2 — 1 points\ns1 — 1 points" });
  // <path> = the contents ONE level below the resolved nodes
  assert.deepEqual(registry.runCommand("ls c0"), { status: "ok", message: "g0 — 2 points" });
  assert.deepEqual(registry.runCommand("ls c0.g0"), { status: "ok", message: "s0 — 2 points" });
  assert.deepEqual(registry.runCommand("ls c0.g0.s0"),
    { status: "ok", message: "a #0 — 1 points\nb #1 — 1 points" });
  assert.equal(registry.runCommand("ls c1.g1.s1.c").message,
    "nothing below — points have no contents");
  // the hidden flag surfaces in the bare listing
  registry.runCommand("hide @second");
  assert.match(registry.runCommand("ls").message, /second — 1 points · hidden/);
  // guards: no [name]; honest nomatch
  assert.match(registry.runCommand("ls c0 [x]").message, /ls takes no \[name\]/);
  assert.equal(registry.runCommand("ls @nope").status, "nomatch");
  assert.equal(registry.runCommand("ls zzz").status, "nomatch");
  assert.equal(commits.length, 0, "ls committed nothing");
  assert.equal(refOps.length, 1, "only the explicit hide touched state");
  assert.ok(registry.verbs().includes("ls"));
});

test("rename: exactly one @name, bracketed new name, model-routed collision/reserve", () => {
  const { registry, sels } = makeRegistry();
  assert.deepEqual(registry.runCommand("rename @stored [best]"),
    { status: "ok", message: `renamed "stored" → "best"` });
  assert.ok(sels.has("best") && !sels.has("stored"), "routed through the model's rename");
  assert.match(registry.runCommand("rename @best [second]").message,
    /a selection named "second" already exists/);
  assert.match(registry.runCommand("rename @best [all]").message, /reserved/);
  assert.match(registry.runCommand("rename @best").message, /needs a bracketed name/);
  for (const bad of ["rename @best + @second [x]", "rename @best.c [x]",
    "rename c0 [x]", "rename @all [x]"]) {
    assert.match(registry.runCommand(bad).message, /exactly one committed selection/, bad);
  }
  assert.equal(registry.runCommand("rename @nope [x]").status, "nomatch");
  assert.ok(sels.has("best") && sels.has("second"), "failed renames changed nothing");
});

test("clear is a registered verb (the terminal surface intercepts it locally)", () => {
  const { registry, commits, refOps } = makeRegistry();
  assert.ok(registry.verbs().includes("clear"));
  assert.equal(registry.runCommand("clear").status, "ok");
  assert.match(registry.runCommand("help clear").message, /terminal/);
  assert.equal(commits.length + refOps.length, 0, "clear never reaches viewer state");
});

// -- add / remove: membership mutation (whole-member granularity, no carve) -----------

test("add: tree-addressed entries join as members at their NATURAL level", () => {
  const { registry, sels } = makeRegistry();
  // a group-level address adds ONE group entry, never its points
  let res = registry.runCommand("add @second c0.g0");
  assert.deepEqual(res, { status: "ok", message: `added 1 members to "second" — 2 points` });
  assert.deepEqual(sels.get("second"),
    [{ level: "subgroup", id: 1 }, { level: "group", id: 0 }]);
  // a point-level address adds point members
  res = registry.runCommand("add @second c1.g1.s1.c");
  assert.equal(res.status, "ok");
  assert.ok(sels.get("second")!.some((e) => e.level === "point" && e.id === 2));
  // multi-term: both sides of the + join in one command
  const { registry: r2, sels: s2 } = makeRegistry();
  res = r2.runCommand("add @second c0.g0 + c1.g1.s1.c");
  assert.equal(res.message, `added 2 members to "second" — 3 points`);
  assert.equal(s2.get("second")!.length, 3);
});

test("add: idempotent at the entry level — exact members are never duplicated", () => {
  const { registry, sels, memberOps } = makeRegistry();
  // subgroup:0 is already a stored member of "stored"
  let res = registry.runCommand("add @stored c0.g0.s0");
  assert.deepEqual(res, { status: "ok", message: `already members — nothing to add to "stored"` });
  assert.equal(sels.get("stored")!.length, 2, "no mutation");
  assert.equal(memberOps.length, 0, "the mutator was never called");
  // mixed: only the fresh entry goes through
  res = registry.runCommand("add @stored c0.g0.s0 + c0.g0");
  assert.equal(res.message, `added 1 members to "stored" — 2 points`);
  assert.deepEqual(memberOps.at(-1)?.entries, [{ level: "group", id: 0 }]);
});

test("add: usage errors — one lone @name on the left, tree-only on the right", () => {
  const { registry, memberOps } = makeRegistry();
  assert.match(registry.runCommand("add @stored @second").message,
    /add takes TREE addresses .*no @ terms on the right/);
  assert.match(registry.runCommand("add @stored @all").message, /no @ terms on the right/);
  assert.match(registry.runCommand("add @stored + @second c0").message,
    /ONE selection at a time/);
  assert.match(registry.runCommand("add @all c0").message,
    /@all is not a single selection/);
  assert.match(registry.runCommand("add c0 @stored").message,
    /needs a committed selection first/);
  assert.match(registry.runCommand("add @stored.c c0").message, /no filter/);
  assert.match(registry.runCommand("add @stored").message, /needs something to add/);
  assert.match(registry.runCommand("add @stored c0 [x]").message, /takes no \[name\]/);
  assert.equal(registry.runCommand("add @nope c0").status, "nomatch");
  assert.equal(registry.runCommand("add @stored zzz").status, "nomatch");
  assert.equal(memberOps.length, 0, "no error path mutated anything");
});

test("remove <member-pred>: drops matched STORED members via the @name.<pred> matcher", () => {
  const { registry, sels } = makeRegistry();
  // a member's own label
  let res = registry.runCommand("remove @stored s0");
  assert.deepEqual(res, { status: "ok", message: `removed 1 members from "stored" — 2 points` });
  assert.deepEqual(sels.get("stored"), [{ level: "point", id: 2 }]);
  // a point member's type; the LAST member leaves the selection standing
  res = registry.runCommand("remove @stored c");
  assert.equal(res.message,
    `removed 1 members from "stored" — 1 points (now empty — the selection remains)`);
  assert.ok(sels.has("stored"), "emptied, NOT deleted");
  assert.equal(sels.get("stored")!.length, 0);
  // multi-term union in one command
  const { registry: r2, sels: s2 } = makeRegistry();
  res = r2.runCommand("remove @stored s0 + #2");
  assert.match(res.message, /removed 2 members .*now empty/);
  assert.ok(s2.has("stored"));
});

test("remove: a predicate below a coarse member NOMATCHES — carving is impossible", () => {
  const { registry, sels, memberOps } = makeRegistry();
  // "a" is the TYPE of point 0 INSIDE stored's coarse member s0 — not a member
  assert.equal(registry.runCommand("remove @stored a").status, "nomatch");
  assert.equal(registry.runCommand("remove @stored #0").status, "nomatch",
    "an index inside the coarse member is not a member");
  assert.equal(registry.runCommand("remove @stored g0").status, "nomatch",
    "an ancestor label is not a member");
  assert.equal(sels.get("stored")!.length, 2, "member list untouched — no complement materialized");
  assert.equal(memberOps.length, 0);
  // paths are rejected outright: members are named by their OWN label
  assert.match(registry.runCommand("remove @stored c0.g0").message,
    /OWN members .* no paths/s);
});

test("remove @name all: empties the membership — the selection REMAINS", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @stored all");
  assert.equal(res.message,
    `removed 2 members from "stored" — 3 points (now empty — the selection remains)`);
  assert.ok(sels.has("stored"), "all empties; it never deletes");
  assert.equal(sels.get("stored")!.length, 0);
  assert.ok(sels.has("second"), "other selections untouched");
});

test("bare remove @name: DELETES the selection (the panel's ✕)", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @second");
  assert.deepEqual(res, { status: "ok", message: `deleted "second" — 1 points` });
  assert.ok(!sels.has("second"), "gone from the committed list");
  assert.deepEqual(sels.get("stored")!.length, 2, "the other selection untouched");
  assert.equal(registry.runCommand("remove @second").status, "nomatch");
});

test("remove @all: deletes EVERY committed selection (the one bulk delete)", () => {
  const { registry, sels } = makeRegistry();
  const res = registry.runCommand("remove @all");
  assert.deepEqual(res, { status: "ok", message: `deleted 2 selections — 3 points` });
  assert.equal(sels.size, 0);
  assert.equal(registry.runCommand("remove @all").status, "nomatch");
  // @all with a second argument is a usage error, not a member form
  const { registry: r2 } = makeRegistry();
  assert.match(r2.runCommand("remove @all s0").message,
    /remove @all takes no second argument/);
});

test("remove: left-side guards match add's — one @name, no unions, no filter", () => {
  const { registry, sels } = makeRegistry();
  assert.match(registry.runCommand("remove @stored + @second").message,
    /ONE selection at a time/);
  assert.match(registry.runCommand("remove @stored.c s0").message, /no filter/);
  assert.match(registry.runCommand("remove c0 s0").message, /needs a committed selection first/);
  assert.match(registry.runCommand("remove @stored s0 [x]").message, /takes no \[name\]/);
  assert.equal(registry.runCommand("remove @nope s0").status, "nomatch");
  assert.equal(sels.size, 2, "nothing deleted by the error paths");
  assert.ok(registry.verbs().includes("add") && registry.verbs().includes("remove"));
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

// -- the color family: colorpoints / colorbonds / colorbondsof -----------------------

test("parseColor: CSS names, hex long/short, case-insensitive; junk is null", () => {
  assert.deepEqual(parseColor("red"), [1, 0, 0]);
  assert.deepEqual(parseColor("black"), [0, 0, 0]);
  assert.deepEqual(parseColor("white"), [1, 1, 1]);
  assert.deepEqual(parseColor("steelblue"), [0x46 / 255, 0x82 / 255, 0xb4 / 255]);
  assert.deepEqual(parseColor("#ff8800"), [1, 0x88 / 255, 0]);
  assert.deepEqual(parseColor("#f80"), parseColor("#ff8800"), "#rgb expands to #rrggbb");
  assert.deepEqual(parseColor("Red"), parseColor("red"), "CSS names are case-insensitive");
  assert.deepEqual(parseColor("#FF8800"), parseColor("#ff8800"));
  for (const junk of ["notacolor", "#ggg", "#12345", "#1234567", "#", "", "rgb(1,2,3)"]) {
    assert.equal(parseColor(junk), null, junk);
  }
});

test("the rename is total: colorpoints is the verb, color is UNKNOWN", () => {
  const { registry, colorOps } = makeRegistry();
  const old = registry.runCommand("color c0 red");
  assert.equal(old.status, "error");
  assert.equal(old.message, "unknown command: color", "no alias — color is gone");
  assert.equal(colorOps.length, 0);
  assert.ok(registry.verbs().includes("colorpoints"));
  assert.ok(!registry.verbs().includes("color"));
});

test("colorpoints resolves EXACTLY like view (same resolver, hidden included), writes once", () => {
  const { registry, colorOps } = makeRegistry();
  // category path → the same 2 points "view c0" focuses (points 0 and 1)
  const res = registry.runCommand("colorpoints c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 points red");
  assert.equal(colorOps.length, 1, "one invocation = one write (one stroke)");
  assert.deepEqual(colorOps[0].points, [0, 1]);
  assert.deepEqual(colorOps[0].rgb, [1, 0, 0]);
  // full grammar: leaf type, @name (stored members), all, hex color
  assert.equal(registry.runCommand("colorpoints c0.g0.s0.a #ff8800").message, "colored 1 points #ff8800");
  assert.deepEqual(colorOps[1].points, [0]);
  assert.equal(registry.runCommand("colorpoints @stored steelblue").status, "ok");
  assert.deepEqual(colorOps[2].points, [0, 1, 2], "@stored = subgroup s0 (0,1) + point 2");
  assert.equal(registry.runCommand("colorpoints all white").message, "colored 3 points white");
});

test("colorpoints: re-coloring an overlap is simply a NEW write (LWW downstream)", () => {
  const { registry, colorOps } = makeRegistry();
  registry.runCommand("colorpoints c0 red");
  registry.runCommand("colorpoints c0.g0.s0.a blue");
  assert.equal(colorOps.length, 2, "two invocations, two strokes — no merge, no precedence");
  assert.deepEqual(colorOps[1].points, [0]);
  assert.deepEqual(colorOps[1].rgb, [0, 0, 1]);
});

test("colorbonds: BOTH endpoints in the set (contained) — same resolver as view", () => {
  const { registry, edgeOps, colorOps } = makeRegistry();
  // c0 = {0,1}: edge 0 (0,1) contained; edge 1 (1,2) leaks out → excluded
  const res = registry.runCommand("colorbonds c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0], { edgeIds: [0], rgb: [1, 0, 0] });
  // all = {0,1,2}: both edges contained
  assert.equal(registry.runCommand("colorbonds all #f80").message, "colored 2 edges #f80");
  assert.deepEqual(edgeOps[1].edgeIds, [0, 1]);
  assert.equal(colorOps.length, 0, "the POINT buffer is never touched (independence)");
});

test("colorbondsof: AT LEAST ONE endpoint (incident) — reaches one hop outside", () => {
  const { registry, edgeOps } = makeRegistry();
  // c0 = {0,1}: edge 1 (1,2) has its OTHER endpoint outside c0 and is colored
  // anyway — the incident reach is the verb's contract, not a bug
  const res = registry.runCommand("colorbondsof c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 edges red");
  assert.deepEqual(edgeOps[0].edgeIds, [0, 1]);
});

test("single-point target pins contained-vs-incident: bonds nomatch, bondsof incident", () => {
  const { registry, edgeOps } = makeRegistry();
  // c0.g0.s0.a = point {0}: no edge has both endpoints in a one-point set
  const bonds = registry.runCommand("colorbonds c0.g0.s0.a red");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(edgeOps.length, 0, "a no-edge nomatch writes nothing");
  // …but exactly the edges incident to that point color under colorbondsof
  const bondsof = registry.runCommand("colorbondsof c0.g0.s0.a red");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "colored 1 edges red");
  assert.deepEqual(edgeOps[0].edgeIds, [0]);
});

test("the edge verbs: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, edgeOps } = makeRegistry();
  for (const verb of ["colorbonds", "colorbondsof"]) {
    const nomatch = registry.runCommand(`${verb} nothere red`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 notacolor`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /unknown color "notacolor"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} <target> <color>`));
    const oneArg = registry.runCommand(`${verb} red`); // one chunk = no target
    assert.equal(oneArg.status, "error", verb);
    assert.match(oneArg.message, /needs a target and a color/);
    const parseErr = registry.runCommand(`${verb} c0.[x] red`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(edgeOps.length, 0, "no path wrote anything");
});

test("colortrace: active subgroups → vertices, with the map-up to subgroup grain", () => {
  const { registry, traceOps, colorOps, edgeOps } = makeRegistry();
  // c0 = {0,1}: s0 active → vertex 0 (its anchor, point 0)
  const res = registry.runCommand("colortrace c0 red");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 1 trace vertices red");
  assert.deepEqual(traceOps[0], { vertexIds: [0], rgb: [1, 0, 0] });
  // THE MAP-UP: point 1 is NOT a vertex, but its subgroup s0 is activated,
  // so s0's vertex colors — resolution-to-granularity, not reach
  const up = registry.runCommand("colortrace c0.g0.s0.b steelblue");
  assert.equal(up.message, "colored 1 trace vertices steelblue");
  assert.deepEqual(traceOps[1].vertexIds, [0]);
  assert.equal(colorOps.length + edgeOps.length, 0, "no other primitive's buffer is touched");
});

test("colortrace: a target whose subgroups own no vertices is a nomatch", () => {
  const { registry, traceOps } = makeRegistry();
  // c1 = {2}: s1 is active but owns no polyline vertex
  const res = registry.runCommand("colortrace c1 red");
  assert.equal(res.status, "nomatch");
  assert.equal(res.message, `no trace vertices in "c1"`);
  assert.equal(traceOps.length, 0, "a no-vertex nomatch writes nothing");
});

test("colortrace: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, traceOps } = makeRegistry();
  const nomatch = registry.runCommand("colortrace nothere red");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /nothing matches "nothere"/);
  const bad = registry.runCommand("colortrace c0 notacolor");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown color "notacolor"/);
  const bare = registry.runCommand("colortrace");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /colortrace <target> <color>/);
  const oneArg = registry.runCommand("colortrace red"); // one chunk = no target
  assert.equal(oneArg.status, "error");
  assert.match(oneArg.message, /needs a target and a color/);
  const parseErr = registry.runCommand("colortrace c0.[x] red"); // [ reserved
  assert.equal(parseErr.status, "error");
  assert.equal(traceOps.length, 0, "no path wrote anything");
});

// -- the size family: pointsize / bondsize / bondsizeof / tracesize -------------------

test("parseSize: non-negative numbers; negatives clamp; junk is null", () => {
  assert.deepEqual(parseSize("1.5"), { size: 1.5, clamped: false });
  assert.deepEqual(parseSize("0"), { size: 0, clamped: false });
  assert.deepEqual(parseSize("3"), { size: 3, clamped: false });
  assert.deepEqual(parseSize(".5"), { size: 0.5, clamped: false });
  assert.deepEqual(parseSize("2."), { size: 2, clamped: false });
  assert.deepEqual(parseSize("3e2"), { size: 300, clamped: false });
  assert.deepEqual(parseSize("-2"), { size: 0, clamped: true }, "negative clamps to 0");
  assert.deepEqual(parseSize("-0.1"), { size: 0, clamped: true });
  for (const junk of ["abc", "", "1,5", "1.5x", "--1", "Infinity", "NaN", "#3", "1 5"]) {
    assert.equal(parseSize(junk), null, junk);
  }
});

test("pointsize resolves EXACTLY like colorpoints/view; zero is literal, never a hide", () => {
  const { registry, sizeOps } = makeRegistry();
  const res = registry.runCommand("pointsize c0 2");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "set 2 points to size 2");
  assert.deepEqual(sizeOps[0], { kind: "points", ids: [0, 1], size: 2 });
  // ZERO: a legal literal value — the write happens, the message says size 0
  const zero = registry.runCommand("pointsize c0 0");
  assert.equal(zero.status, "ok");
  assert.equal(zero.message, "set 2 points to size 0", "reports the action, never 'hidden'");
  assert.deepEqual(sizeOps[1], { kind: "points", ids: [0, 1], size: 0 });
  // negative clamps, and the message says so
  const neg = registry.runCommand("pointsize c0 -2");
  assert.equal(neg.status, "ok");
  assert.equal(neg.message, "set 2 points to size 0 (clamped to 0)");
  assert.deepEqual(sizeOps[2].size, 0);
});

test("bondsize/bondsizeof use the IDENTICAL predicates as their color siblings", () => {
  const { registry, sizeOps, edgeOps } = makeRegistry();
  // both-endpoints: same edge set as colorbonds, on the size buffer
  registry.runCommand("colorbonds c0 red");
  registry.runCommand("bondsize c0 2");
  assert.deepEqual(sizeOps[0], { kind: "edges", ids: edgeOps[0].edgeIds, size: 2 });
  // either-endpoint: same edge set as colorbondsof (the incident reach)
  registry.runCommand("colorbondsof c0 red");
  registry.runCommand("bondsizeof c0 1.5");
  assert.deepEqual(sizeOps[1], { kind: "edges", ids: edgeOps[1].edgeIds, size: 1.5 });
  assert.deepEqual(sizeOps[1].ids, [0, 1], "edge 1 leans on an out-of-set endpoint — sized anyway");
  assert.equal(registry.runCommand("bondsize c0 2").message, "set 1 edges to size 2");
  assert.equal(registry.runCommand("bondsizeof c0 2").message, "set 2 edges to size 2");
});

test("single-point pin on the size axis: bondsize nomatches, bondsizeof sizes incidents", () => {
  const { registry, sizeOps } = makeRegistry();
  const bonds = registry.runCommand("bondsize c0.g0.s0.a 2");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(sizeOps.length, 0);
  const bondsof = registry.runCommand("bondsizeof c0.g0.s0.a 2");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "set 1 edges to size 2");
  assert.deepEqual(sizeOps[0].ids, [0]);
});

test("tracesize uses the IDENTICAL subgroup map-up as colortrace", () => {
  const { registry, sizeOps, traceOps } = makeRegistry();
  registry.runCommand("colortrace c0 red");
  registry.runCommand("tracesize c0 2.5");
  assert.deepEqual(sizeOps[0], { kind: "trace", ids: traceOps[0].vertexIds, size: 2.5 });
  // the map-up: point 1 is not a vertex; its subgroup's vertex sizes anyway
  const up = registry.runCommand("tracesize c0.g0.s0.b 1.5");
  assert.equal(up.message, "set 1 trace vertices to size 1.5");
  assert.deepEqual(sizeOps[1].ids, [0]);
  // no-vertex subgroups nomatch, identical wording to colortrace
  const none = registry.runCommand("tracesize c1 2");
  assert.equal(none.status, "nomatch");
  assert.equal(none.message, `no trace vertices in "c1"`);
});

test("the size verbs: nomatch / bad size / usage / parse errors write NOTHING", () => {
  const { registry, sizeOps } = makeRegistry();
  for (const verb of ["pointsize", "bondsize", "bondsizeof", "tracesize"]) {
    const nomatch = registry.runCommand(`${verb} nothere 2`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 abc`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /not a size: "abc"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} <target> <size>`));
    const oneArg = registry.runCommand(`${verb} 2`); // one chunk = no target
    assert.equal(oneArg.status, "error", verb);
    assert.match(oneArg.message, /needs a target and a size/);
    const parseErr = registry.runCommand(`${verb} c0.[x] 2`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(sizeOps.length, 0, "no path wrote anything");
});

// -- the opacity family: pointopacity / bondopacity / bondopacityof / traceopacity ----

test("parseOpacity: [0,1] values; two-sided clamp; junk is null", () => {
  assert.deepEqual(parseOpacity("0.5"), { opacity: 0.5, clampedTo: null });
  assert.deepEqual(parseOpacity("0"), { opacity: 0, clampedTo: null });
  assert.deepEqual(parseOpacity("1"), { opacity: 1, clampedTo: null });
  assert.deepEqual(parseOpacity(".25"), { opacity: 0.25, clampedTo: null });
  assert.deepEqual(parseOpacity("-0.5"), { opacity: 0, clampedTo: 0 }, "below range clamps to 0");
  assert.deepEqual(parseOpacity("1.5"), { opacity: 1, clampedTo: 1 }, "above range clamps to 1");
  assert.deepEqual(parseOpacity("2e3"), { opacity: 1, clampedTo: 1 });
  for (const junk of ["abc", "", "0.5x", "--1", "Infinity", "NaN", "#5", "0 5"]) {
    assert.equal(parseOpacity(junk), null, junk);
  }
});

test("the THREE axes share one mapping per shape — set-identity across color/size/opacity", () => {
  const { registry, edgeOps, sizeOps, opacityOps, traceOps } = makeRegistry();
  // edge-contained: colorbonds / bondsize / bondopacity → the same edge ids
  registry.runCommand("colorbonds c0 red");
  registry.runCommand("bondsize c0 2");
  registry.runCommand("bondopacity c0 0.5");
  assert.deepEqual(opacityOps[0], { kind: "edges", ids: edgeOps[0].edgeIds, opacity: 0.5 });
  assert.deepEqual(opacityOps[0].ids, sizeOps[0].ids);
  // edge-incident: colorbondsof / bondsizeof / bondopacityof → the same ids
  registry.runCommand("colorbondsof c0 red");
  registry.runCommand("bondsizeof c0 2");
  registry.runCommand("bondopacityof c0 0.25");
  assert.deepEqual(opacityOps[1].ids, edgeOps[1].edgeIds);
  assert.deepEqual(opacityOps[1].ids, sizeOps[1].ids);
  assert.deepEqual(opacityOps[1].ids, [0, 1], "the incident reach, identical on every axis");
  // subgroup-vertex: colortrace / tracesize / traceopacity → the same vertex ids
  registry.runCommand("colortrace c0 red");
  registry.runCommand("tracesize c0 2");
  registry.runCommand("traceopacity c0 0.75");
  assert.deepEqual(opacityOps[2].ids, traceOps[0].vertexIds);
  assert.deepEqual(opacityOps[2].ids, sizeOps[2].ids);
});

test("pointopacity: zero is literal (never a hide); the clamp is two-sided and reported", () => {
  const { registry, opacityOps } = makeRegistry();
  const half = registry.runCommand("pointopacity c0 0.5");
  assert.equal(half.message, "set 2 points to opacity 0.5");
  assert.deepEqual(opacityOps[0], { kind: "points", ids: [0, 1], opacity: 0.5 });
  const zero = registry.runCommand("pointopacity c0 0");
  assert.equal(zero.status, "ok");
  assert.equal(zero.message, "set 2 points to opacity 0", "reports the action, never 'hidden'");
  assert.deepEqual(opacityOps[1].opacity, 0);
  const high = registry.runCommand("pointopacity c0 1.5");
  assert.equal(high.message, "set 2 points to opacity 1 (clamped to 1)");
  assert.equal(opacityOps[2].opacity, 1);
  const low = registry.runCommand("pointopacity c0 -0.5");
  assert.equal(low.message, "set 2 points to opacity 0 (clamped to 0)");
  assert.equal(opacityOps[3].opacity, 0);
});

test("single-point pin on the opacity axis: bondopacity nomatches, bondopacityof fades incidents", () => {
  const { registry, opacityOps } = makeRegistry();
  const bonds = registry.runCommand("bondopacity c0.g0.s0.a 0.5");
  assert.equal(bonds.status, "nomatch");
  assert.equal(bonds.message, `no edges with both endpoints in "c0.g0.s0.a"`);
  assert.equal(opacityOps.length, 0);
  const bondsof = registry.runCommand("bondopacityof c0.g0.s0.a 0.5");
  assert.equal(bondsof.status, "ok");
  assert.equal(bondsof.message, "set 1 edges to opacity 0.5");
  assert.deepEqual(opacityOps[0].ids, [0]);
});

test("traceopacity: the shared map-up, and the no-vertex nomatch", () => {
  const { registry, opacityOps } = makeRegistry();
  const up = registry.runCommand("traceopacity c0.g0.s0.b 0.5"); // maps up to s0's vertex
  assert.equal(up.message, "set 1 trace vertices to opacity 0.5");
  assert.deepEqual(opacityOps[0].ids, [0]);
  const none = registry.runCommand("traceopacity c1 0.5");
  assert.equal(none.status, "nomatch");
  assert.equal(none.message, `no trace vertices in "c1"`);
});

test("the opacity verbs: nomatch / bad value / usage / parse errors write NOTHING", () => {
  const { registry, opacityOps } = makeRegistry();
  for (const verb of ["pointopacity", "bondopacity", "bondopacityof", "traceopacity"]) {
    const nomatch = registry.runCommand(`${verb} nothere 0.5`);
    assert.equal(nomatch.status, "nomatch", verb);
    assert.match(nomatch.message, /nothing matches "nothere"/);
    const bad = registry.runCommand(`${verb} c0 abc`);
    assert.equal(bad.status, "error", verb);
    assert.match(bad.message, /not an opacity: "abc"/);
    const bare = registry.runCommand(verb);
    assert.equal(bare.status, "error", verb);
    assert.match(bare.message, new RegExp(`${verb} <target> <opacity>`));
    const oneArg = registry.runCommand(`${verb} 0.5`); // one chunk = no target
    assert.equal(oneArg.status, "error", verb);
    assert.match(oneArg.message, /needs a target and an? opacity/);
    const parseErr = registry.runCommand(`${verb} c0.[x] 0.5`); // [ reserved
    assert.equal(parseErr.status, "error", verb);
  }
  assert.equal(opacityOps.length, 0, "no path wrote anything");
});

test("colorpoints: nomatch / bad color / usage / parse errors write NOTHING", () => {
  const { registry, colorOps } = makeRegistry();
  const nomatch = registry.runCommand("colorpoints nothere red");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /nothing matches "nothere"/);
  const bad = registry.runCommand("colorpoints c0 notacolor");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown color "notacolor"/);
  const bare = registry.runCommand("colorpoints");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /colorpoints <target> <color>/);
  const oneArg = registry.runCommand("colorpoints red"); // one chunk = no target
  assert.equal(oneArg.status, "error");
  assert.match(oneArg.message, /needs a target and a color/);
  const parseErr = registry.runCommand("colorpoints c0.[x] red"); // [ reserved in expressions
  assert.equal(parseErr.status, "error");
  assert.equal(colorOps.length, 0, "no path wrote anything");
});

test("rainbow: the value VARIES per element — one write, resolution order, ramp ends", () => {
  const { registry, colorEachOps, colorOps } = makeRegistry();
  // c0 = {0,1}: a 2-point ramp — t = 0 then 1 → hue 0 (red) then 300 (magenta)
  const res = registry.runCommand("rainbow c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "colored 2 points rainbow");
  assert.equal(colorEachOps.length, 1, "one invocation = one per-element write (one stroke)");
  assert.deepEqual(colorEachOps[0].points, [0, 1], "view's exact resolution and order");
  assert.equal(colorEachOps[0].rgb.length, 6, "flat 3×N — each point carries its OWN RGB");
  assert.deepEqual(colorEachOps[0].rgb.slice(0, 3), [1, 0, 0], "t=0 → hue 0 (red)");
  assert.deepEqual(colorEachOps[0].rgb.slice(3, 6), [1, 0, 1], "t=1 → hue 300 (magenta)");
  assert.notDeepEqual(colorEachOps[0].rgb.slice(0, 3), colorEachOps[0].rgb.slice(3, 6),
    "the per-element values DIFFER — the recipe/constant-verb distinction");
  assert.equal(colorOps.length, 0, "never the broadcast writer — recipes are per-element");
});

test("rainbow: full grammar rides the shared resolve core (@name, all, leaf)", () => {
  const { registry, colorEachOps } = makeRegistry();
  // @stored = subgroup s0 (0,1) + point 2 → a 3-point ramp: t = 0, 0.5, 1
  assert.equal(registry.runCommand("rainbow @stored").message, "colored 3 points rainbow");
  assert.deepEqual(colorEachOps[0].points, [0, 1, 2]);
  assert.deepEqual(colorEachOps[0].rgb.slice(0, 3), [1, 0, 0], "t=0 → red");
  assert.deepEqual(colorEachOps[0].rgb.slice(3, 6), [0, 1, 0.5], "t=0.5 → hue 150");
  assert.deepEqual(colorEachOps[0].rgb.slice(6, 9), [1, 0, 1], "t=1 → magenta");
  // a single-point target is the [0] ramp — no divide-by-zero, plain red
  assert.equal(registry.runCommand("rainbow c0.g0.s0.a").message, "colored 1 points rainbow");
  assert.deepEqual(colorEachOps[1], { points: [0], rgb: [1, 0, 0] });
  assert.equal(registry.runCommand("rainbow all").message, "colored 3 points rainbow");
});

test("mods: lists the registry — rainbow grouped under built-in with its credit", () => {
  const { registry } = makeRegistry();
  const r = registry.runCommand("mods");
  assert.equal(r.status, "ok");
  const lines = r.message.split("\n");
  assert.ok(lines.includes("built-in:"), "grouped by origin");
  assert.ok(
    lines.includes("  rainbow — representation · point-color · by Dominic Fico · https://github.com/DomFico/molaro"),
    r.message);
  assert.ok(lines.indexOf("built-in:") < lines.findIndex((l) => l.startsWith("  rainbow")),
    "recipe rows sit under their origin header");
  assert.ok(!r.message.includes("colorpoints") && !r.message.includes("view"),
    "recipes only — verb discoverability stays with help/?");
});

test("mods: attribution renders for ANY recipe's credit; author/source stay optional", () => {
  // a stub with distinct provenance strings proves the credit display isn't
  // rainbow-specific; a bare stub pins that credit fields are optional
  registerRecipe({
    name: "stub-credit",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0),
    colormap: () => [0, 0, 0],
    origin: "built-in",
    author: "Stub Author",
    source: "stub-source-string",
  });
  registerRecipe({
    name: "stub-plain",
    kind: "representation",
    axis: "point-color",
    compute: (points) => points.map(() => 0),
    colormap: () => [0, 0, 0],
    origin: "built-in",
  });
  const { registry } = makeRegistry();
  const lines = registry.runCommand("mods").message.split("\n");
  assert.ok(lines.includes("  stub-credit — representation · point-color · by Stub Author · stub-source-string"),
    lines.join("|"));
  assert.ok(lines.includes("  stub-plain — representation · point-color"), "no credit fields → the bare line");
});

test("mods: stray arguments are a usage error, nothing listed", () => {
  const { registry } = makeRegistry();
  const r = registry.runCommand("mods rainbow");
  assert.equal(r.status, "error");
  assert.equal(r.message, "mods takes no arguments — it lists the recipe registry");
  assert.ok(!r.message.includes("built-in:"), "no listing rides the error");
  assert.ok(registry.verbs().includes("mods"), "registered like every verb");
});

test("rainbow: nomatch / usage / parse errors write NOTHING", () => {
  const { registry, colorEachOps } = makeRegistry();
  const nomatch = registry.runCommand("rainbow nothere");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /nothing matches "nothere"/);
  const bare = registry.runCommand("rainbow");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /rainbow <target>/);
  const parseErr = registry.runCommand("rainbow c0.[x]"); // [ reserved in expressions
  assert.equal(parseErr.status, "error");
  assert.equal(colorEachOps.length, 0, "no path wrote anything");
  assert.ok(registry.verbs().includes("rainbow"), "registered like every verb");
});

// -- the typed-result binding (claudebind.ts) — dispatch on the stub ctx ----------

function makeBinder() {
  const made = makeRegistry();
  const run = (raw: unknown) =>
    bindTypedResult(made.ctx, (t) => made.registry.runCommand(t), raw);
  return { ...made, run };
}

test("bind per-point-scalar color: header-ordered points through the built-in colormap", () => {
  const { run, colorEachOps } = makeBinder();
  // c0 = {0,1}: scalars 0 and 1 → the hue sweep's ends (red, magenta)
  const out = run({ kind: "per-point-scalar", target: "c0", axis: "color", scalars: [0, 1] });
  assert.equal(out.ok, true, out.message);
  assert.match(out.message, /colored 2 points of "c0" from scalars/);
  assert.equal(colorEachOps.length, 1, "one per-element write = one stroke");
  assert.deepEqual(colorEachOps[0].points, [0, 1], "view's exact resolution order");
  assert.deepEqual(colorEachOps[0].rgb, [1, 0, 0, 1, 0, 1], "scalar 0 → red, 1 → magenta");
});

test("bind per-point-scalar size/opacity: [0,1] maps to the axis range, per element", () => {
  const { run, eachOps } = makeBinder();
  const sized = run({ kind: "per-point-scalar", target: "all", axis: "size", scalars: [0, 0.5, 1] });
  assert.equal(sized.ok, true, sized.message);
  assert.deepEqual(eachOps[0],
    { kind: "size", points: [0, 1, 2], values: [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX] },
    "size: t*6 — a fixed visual range, never an interpretation");
  const faded = run({ kind: "per-point-scalar", target: "all", axis: "opacity", scalars: [0, 0.5, 1] });
  assert.equal(faded.ok, true, faded.message);
  assert.deepEqual(eachOps[1],
    { kind: "opacity", points: [0, 1, 2], values: [0, 0.5, 1] },
    "opacity: identity — [0,1] IS its range");
});

test("bind command: runs the exact command path and changes scene state", () => {
  const { run, commits } = makeBinder();
  const out = run({ kind: "command", command: "create_sele c0 [assistant_pick]" });
  assert.equal(out.ok, true, out.message);
  assert.match(out.message, /^create_sele c0 \[assistant_pick\] → created "assistant_pick"/);
  assert.equal(commits.length, 1, "the command really committed a selection");
  const bad = run({ kind: "command", command: "view nothere" });
  assert.equal(bad.ok, false, "a nomatch command is a failed binding");
  assert.match(bad.message, /nothing matches/);
});

test("bind per-frame-series: DEFENSIVE only — the host routes series to the plot panel", () => {
  // production never sends a series here (the host intercepts it before the
  // viewer relay; main.ts also guards); the branch stays as a closed-union
  // safety net that writes nothing
  const { run, colorEachOps, eachOps, commits } = makeBinder();
  const out = run({ kind: "per-frame-series", label: "example_series", values: [0, 0.5, 1] });
  assert.equal(out.ok, false);
  assert.match(out.message, /per-frame-series is routed to the plot panel/);
  assert.equal(colorEachOps.length + eachOps.length + commits.length, 0, "wrote nothing");
});

test("bind: length mismatch writes NOTHING and errors (no partial writes)", () => {
  const { run, colorEachOps, eachOps } = makeBinder();
  const out = run({ kind: "per-point-scalar", target: "c0", axis: "color", scalars: [0.5] });
  assert.equal(out.ok, false);
  assert.match(out.message, /scalar count mismatch: 1 values for 2 points of "c0" — nothing written/);
  const nomatch = run({ kind: "per-point-scalar", target: "nothere", axis: "size", scalars: [1] });
  assert.equal(nomatch.ok, false);
  assert.match(nomatch.message, /nothing matches "nothere"/);
  assert.equal(colorEachOps.length + eachOps.length, 0, "no path wrote anything");
});

test("bind: the union is CLOSED — unknown kinds and junk error, never guess", () => {
  const { run, colorEachOps, eachOps, commits } = makeBinder();
  for (const raw of [
    { kind: "per-point-vector", target: "c0", scalars: [1] },
    { kind: "command" },                                   // missing field
    { kind: "per-point-scalar", target: "c0", axis: "hue", scalars: [1] }, // bad axis
    { kind: "per-point-scalar", target: "c0", axis: "color", scalars: ["x"] }, // bad values
    null, 42, "command", {},
  ]) {
    const out = run(raw);
    assert.equal(out.ok, false, JSON.stringify(raw));
    assert.match(out.message, /unrecognized result payload/, JSON.stringify(raw));
  }
  assert.equal(colorEachOps.length + eachOps.length + commits.length, 0, "wrote nothing");
});

// -- Type A (analysis) mod verbs: resolve → hand off, routing by produces --------

test("an analysis mod verb resolves like every verb and hands off the EXACT indices", () => {
  const { registry, ctx, modRuns } = makeRegistry();
  const mod = {
    name: "index_ramp", kind: "analysis" as const, produces: "per-point-scalar" as const,
    axis: "color" as const, code: "def compute(data, target_indices):\n    return []",
    origin: "workspace" as const,
  };
  registry.register("index_ramp", makeAnalysisModHandler(ctx, mod), "test mod");
  const res = registry.runCommand("index_ramp c0");
  assert.equal(res.status, "ok");
  assert.equal(res.message, "running index_ramp on 2 points…", "the sync acknowledgement");
  assert.deepEqual(modRuns, [{ name: "index_ramp", points: [0, 1], expr: "c0" }],
    "view's exact header-ordered resolution, handed off verbatim");
  // nomatch / bare / parse errors NEVER reach the producer
  assert.equal(registry.runCommand("index_ramp nothere").status, "nomatch");
  assert.equal(registry.runCommand("index_ramp").status, "error");
  assert.equal(registry.runCommand("index_ramp c0.[x]").status, "error");
  assert.equal(modRuns.length, 1, "only the valid invocation ran");
});

test("mods lists analysis mods with kind · produces → axis alongside attribution", () => {
  registerRecipe({
    name: "stub-analysis", kind: "analysis", produces: "per-point-scalar", axis: "opacity",
    code: "def compute(d, t):\n    return []", origin: "workspace", author: "Example Author",
  });
  registerRecipe({
    name: "stub-series", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d, t):\n    return []", origin: "workspace",
  });
  const { registry } = makeRegistry();
  const lines = registry.runCommand("mods").message.split("\n");
  assert.ok(lines.includes("workspace:"), "workspace mods group separately from built-ins");
  assert.ok(lines.includes("  stub-analysis — analysis · per-point-scalar → opacity · by Example Author"),
    lines.join("|"));
  assert.ok(lines.includes("  stub-series — analysis · per-frame-series"), lines.join("|"));
  assert.ok(lines.indexOf("built-in:") < lines.indexOf("workspace:"),
    "registration order groups built-ins first");
});

// -- rm: the destructive verb's resolution/refusal/prompt buckets -----------------

test("rm: usage, nomatch, and the built-in refusal — none of them arm a prompt", () => {
  const { registry, rmArms } = makeRegistry();
  const bare = registry.runCommand("rm");
  assert.equal(bare.status, "error");
  assert.match(bare.message, /rm <name> \[\+ <name>…\] or rm all/);
  const nomatch = registry.runCommand("rm nothere");
  assert.equal(nomatch.status, "nomatch");
  assert.match(nomatch.message, /no mod named "nothere"[\s\S]*nothing to delete/);
  assert.equal(nomatch.confirm, undefined);
  const builtin = registry.runCommand("rm rainbow");
  assert.equal(builtin.status, "error");
  assert.match(builtin.message,
    /"rainbow" is built-in — code, not a file; it cannot be deleted[\s\S]*nothing to delete/);
  assert.equal(builtin.confirm, undefined, "refusal-only never prompts");
  // `rm all` against whatever the SHARED module registry currently holds
  // (earlier tests register workspace stubs): empty → nomatch, else a
  // prompt listing exactly the workspace names
  const ws = listRecipes().filter((m) => m.origin !== "built-in").map((m) => m.name);
  const allRes = registry.runCommand("rm all");
  if (ws.length === 0) {
    assert.equal(allRes.status, "nomatch");
    assert.equal(allRes.message, "no workspace mods to delete");
    assert.equal(rmArms.length, 0, "nothing was ever armed");
  } else {
    assert.equal(allRes.confirm, true);
    assert.match(allRes.message, new RegExp(`will delete ${ws.length} workspace mods?: ${ws.join(", ")}`));
    assert.deepEqual(rmArms, [ws], "armed = every workspace mod, never built-ins");
  }
});

test("rm: a deletable selector prompts (confirm:true) and arms EXACTLY the workspace names", () => {
  registerRecipe({
    name: "zz_rm_a", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "workspace",
  });
  registerRecipe({
    name: "zz_rm_b", kind: "analysis", produces: "per-frame-series",
    code: "def compute(d,t):\n pass", origin: "workspace",
  });
  try {
    const { registry, rmArms } = makeRegistry();
    const r = registry.runCommand("rm rainbow + zz_rm_a + nothere + zz_rm_b");
    assert.equal(r.status, "ok");
    assert.equal(r.confirm, true, "the terminal arms its pending slot on this");
    assert.match(r.message, /"rainbow" is built-in/, "mixed selector still refuses the built-in");
    assert.match(r.message, /no mod named "nothere"/);
    assert.match(r.message, /will delete 2 workspace mods: zz_rm_a, zz_rm_b/,
      "the confirmation states EXACTLY what will be deleted");
    assert.match(r.message, /CANNOT be undone\. y\/n\?/);
    assert.deepEqual(rmArms, [["zz_rm_a", "zz_rm_b"]], "armed = the deletable names only");
  } finally {
    unregisterRecipe("zz_rm_a");
    unregisterRecipe("zz_rm_b");
  }
});

test("CommandRegistry.unregister removes a verb from dispatch and the completion pool", () => {
  const { registry } = makeRegistry();
  registry.register("zz_verb", () => ({ status: "ok", message: "hi" }), "test");
  assert.equal(registry.runCommand("zz_verb").status, "ok");
  assert.equal(registry.unregister("zz_verb"), true);
  assert.equal(registry.runCommand("zz_verb").status, "error");
  assert.match(registry.runCommand("zz_verb").message, /unknown command/);
  assert.ok(!registry.verbs().includes("zz_verb"));
});
