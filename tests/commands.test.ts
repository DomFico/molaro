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
  commandMacroRefusal,
  createCommandRegistry,
  HELP_TEXT,
  installModList,
  isFileAlreadyGone,
  makeAnalysisModHandler,
  modInstallReport,
  parseColor,
  parseOpacity,
  parseSize,
  runCommandMacro,
  type CommandContext,
  type CommandResult,
} from "../webview/commands.ts";
import {
  getRecipe,
  listRecipes,
  registerRecipe,
  unregisterRecipe,
  type AnalysisMod,
} from "../webview/recipes.ts";
import { BIND_SIZE_MAX, bindTypedResult } from "../webview/claudebind.ts";
import type { ChannelDecl } from "../webview/channelmap.ts";
import { BindingRegistry, type Binding } from "../webview/bindings.ts";
import { AXIS_DOMAIN, SCALAR_AXES } from "../webview/channelmap.ts";

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

function makeRegistry(fixture?: { traceVertices?: number[] }) {
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
  const chanDecls: ChannelDecl[] = [
    { name: "energy", scope: "per_point_per_frame", components: 1, min: 0 },
    { name: "mass", scope: "per_point", components: 1, min: 1, max: 3 },
    { name: "time", scope: "per_frame", components: 1, min: 0, max: 9 },
    { name: "flow", scope: "per_point_per_frame", components: 3 },
  ];
  const chanValues = new Map<string, { values: number[]; frame: number | null }>([
    ["energy", { values: [0, 1.25, 2.5], frame: 4 }],
    ["mass", { values: [1, 2, 3], frame: null }],
    ["flow", { values: [1, 0, 0, 0, 1, 0, 0, 0, 1], frame: 4 }],
  ]);
  const bindingReg = new BindingRegistry();
  const bindCalls: { b: Binding; scalars: number[] }[] = [];
  const orientationOps: { vertexIds: number[]; values: number[] }[] = [];
  const elemEachOps: { axis: string; ids: number[]; values: number[] }[] = [];
  const styleOps: { kind: "points" | "edges" | "trace"; ids: number[]; index: number }[] = [];
  const refOps: { names: string[]; hidden: boolean }[] = [];
  const memberOps: { name: string; mode: "add" | "remove"; entries: Entry[] }[] = [];
  const colorOps: { points: number[]; rgb: [number, number, number] }[] = [];
  const colorEachOps: { points: number[]; rgb: number[] }[] = [];
  const eachOps: { kind: "size" | "opacity"; points: number[]; values: number[] }[] = [];
  const modRuns: { name: string; points: number[]; expr: string }[] = [];
  const modRunCode: string[] = [];
  const rmArms: string[][] = [];
  const edgeOps: { edgeIds: number[]; rgb: [number, number, number] }[] = [];
  // a chain over the 3 points: edge 0 sits inside c0 ({0,1}); edge 1 crosses
  // the category boundary (point 1 in c0, point 2 in c1) — the contained-vs-
  // incident distinction is decidable from these two alone
  const edges: [number, number][] = [[0, 1], [1, 2]];
  const traceOps: { vertexIds: number[]; rgb: [number, number, number] }[] = [];
  // Default: ONE polyline vertex, point 0 (subgroup s0). Point 1 shares s0
  // but is NOT a vertex (pins the map-up); s1 owns no vertex (pins the
  // nomatch). The ORIENTATION tests override with [0, 2] — a NON-identity
  // vertex→point map (vertex 1 → point 2), because with [0] alone the
  // vertex-id and point-id spaces are numerically identical and a
  // space-mixing regression is undetectable (a vacuous guard).
  const traceVertices: number[] = fixture?.traceVertices ?? [0];
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
    // The bake/bind gate's read surface: one channel per gate case —
    // "energy" declares min ONLY (partial: the explicit-range path),
    // "mass" is static per_point with a full range, "time" is per-frame
    // (a series — refused), "flow" is 3-wide (refused for scalar axes).
    channels: () => chanDecls,
    channelValues: (name) => chanValues.get(name) ?? null,
    // A REAL registry behind the binding stubs — the verbs' semantics
    // (last-bind-wins, element-level release) are the registry's, and the
    // stub records what the composite (main.ts's one stroke) was asked for.
    createBinding: (b, scalars) => {
      bindCalls.push({ b: { ...b, points: [...b.points] }, scalars: [...scalars] });
      return bindingReg.add(b);
    },
    releaseBindings: (sel, axis) => {
      // mirror the main.ts composite: each axis gets ITS OWN id space
      const total = { touched: 0, removed: 0, points: 0 };
      const acc = (s: { touched: number; removed: number; points: number }): void => {
        total.touched += s.touched;
        total.removed += s.removed;
        total.points += s.points;
      };
      const idsFor = (a: (typeof SCALAR_AXES)[number]) =>
        AXIS_DOMAIN[a] === "point" ? sel.points : AXIS_DOMAIN[a] === "edge" ? sel.edges : sel.vertices;
      for (const a of SCALAR_AXES) {
        if (axis === null || axis === a) acc(bindingReg.release(idsFor(a), a));
      }
      if (axis === null || axis === "orientation") acc(bindingReg.release(sel.vertices, "orientation"));
      return total;
    },
    listBindings: () => bindingReg.all(),
    orientationVerticesEach: (vertexIds, values) => {
      orientationOps.push({ vertexIds: [...vertexIds], values: [...values] });
      return vertexIds.length;
    },
    colorEdgesEach: (ids, rgb) => {
      elemEachOps.push({ axis: "bondcolor", ids: [...ids], values: [...rgb] });
      return ids.length;
    },
    sizeEdgesEach: (ids, values) => {
      elemEachOps.push({ axis: "bondsize", ids: [...ids], values: [...values] });
      return ids.length;
    },
    opacityEdgesEach: (ids, values) => {
      elemEachOps.push({ axis: "bondopacity", ids: [...ids], values: [...values] });
      return ids.length;
    },
    colorTraceEach: (ids, rgb) => {
      elemEachOps.push({ axis: "tracecolor", ids: [...ids], values: [...rgb] });
      return ids.length;
    },
    sizeTraceEach: (ids, values) => {
      elemEachOps.push({ axis: "tracesize", ids: [...ids], values: [...values] });
      return ids.length;
    },
    opacityTraceEach: (ids, values) => {
      elemEachOps.push({ axis: "traceopacity", ids: [...ids], values: [...values] });
      return ids.length;
    },
    stylePoints: (points, index) => {
      styleOps.push({ kind: "points", ids: [...points], index });
      return points.length;
    },
    styleEdges: (edgeIds, index) => {
      styleOps.push({ kind: "edges", ids: [...edgeIds], index });
      return edgeIds.length;
    },
    styleTrace: (vertexIds, index) => {
      styleOps.push({ kind: "trace", ids: [...vertexIds], index });
      return vertexIds.length;
    },
    styleNames: () => ["standard", "matte"],
    styleIndexOf: (name) => ["standard", "matte"].indexOf(name),
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
      // The CODE the handler would ship to the producer — the only thing that
      // separates one version of a mod from another (kept out of modRuns, which
      // is deepEqual-asserted elsewhere).
      modRunCode.push(mod.code);
    },
    armRmDeletion: (names) => {
      rmArms.push([...names]);
    },
  };
  return {
    registry: createCommandRegistry(ctx),
    ctx,
    calls, commits, hiddenState, refOps, memberOps,
    colorOps, colorEachOps, eachOps, edgeOps, traceOps, sizeOps, opacityOps, modRuns, modRunCode, rmArms, sels,
    bindCalls, bindingReg, orientationOps, elemEachOps, styleOps,
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

// -- bake: the Tier-1 channel consumer (channel → axis via the shared gate) -------

test("bake: a streamed channel with an explicit range writes each axis, one stroke", () => {
  const { registry, colorEachOps, eachOps } = makeRegistry();
  // energy declares min only — the explicit range is REQUIRED and given.
  // raw [0, 1.25, 2.5] over 0..2.5 → t = [0, 0.5, 1].
  const size = registry.runCommand("bake all energy size 0 2.5");
  assert.equal(size.status, "ok");
  assert.equal(size.message, 'baked "energy" → size on 3 points of "all" (frame 4, range 0..2.5)');
  assert.deepEqual(eachOps, [{ kind: "size", points: [0, 1, 2], values: [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX] }],
    "one writer stroke, t × BIND_SIZE_MAX");
  const opacity = registry.runCommand("bake all energy opacity 0 2.5");
  assert.equal(opacity.status, "ok");
  assert.deepEqual(eachOps[1], { kind: "opacity", points: [0, 1, 2], values: [0, 0.5, 1] }, "opacity is t as-is");
  const color = registry.runCommand("bake all energy color 0 2.5");
  assert.equal(color.status, "ok");
  // the built-in colormap: t=0 → red, t=1 → magenta (rainbow's exact ramp)
  assert.deepEqual(colorEachOps[0].rgb.slice(0, 3), [1, 0, 0]);
  assert.deepEqual(colorEachOps[0].rgb.slice(6, 9), [1, 0, 1]);
});

test("bake: a static per_point channel uses its DECLARED range and says static", () => {
  const { registry, eachOps } = makeRegistry();
  // mass [1,2,3] declared 1..3 → t = [0, 0.5, 1]
  const r = registry.runCommand("bake all mass size");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "mass" → size on 3 points of "all" (static, range 1..3)');
  assert.deepEqual(eachOps[0].values, [0, BIND_SIZE_MAX / 2, BIND_SIZE_MAX]);
});

test("bake: out-of-range values saturate; the target selects and orders the write", () => {
  const { registry, eachOps } = makeRegistry();
  // range 0..1 over raw [0, 1.25, 2.5]: t clamps to [0, 1, 1]
  assert.equal(registry.runCommand("bake all energy opacity 0 1").status, "ok");
  assert.deepEqual(eachOps[0].values, [0, 1, 1]);
  // subgroup s1 = point 2 only → one element, its own value
  assert.equal(registry.runCommand("bake c1 energy opacity 0 2.5").status, "ok");
  assert.deepEqual(eachOps[1], { kind: "opacity", points: [2], values: [1] });
});

test("bake: the gate refuses loudly — nothing written on any failure", () => {
  const { registry, colorEachOps, eachOps } = makeRegistry();
  const cases: [string, RegExp][] = [
    ["bake all nope color", /no channel named "nope" — channels: energy, mass, time, flow/],
    ["bake all time color", /per-frame/],
    ["bake all flow color", /components: 3/],
    ["bake all energy color", /does not declare a full min\/max range/],
    ["bake all energy colr 0 1", /unknown axis "colr"/],
    ["bake all energy color 2 2", /min must be strictly less than max/],
    ["bake all energy color 1", /explicit range needs BOTH bounds/],
    ["bake all energy", /bake needs a target, a channel, and an axis/],
    ["bake", /bake needs a target, a channel, and an axis/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  // valid syntax, empty result: nomatch — the grammar's standing distinction
  assert.equal(registry.runCommand("bake zz energy color 0 1").status, "nomatch");
  assert.equal(colorEachOps.length + eachOps.length, 0, "no failure wrote anything");
});

test("bake: help surfaces the verb in both the summary and describe", () => {
  const { registry } = makeRegistry();
  assert.match(HELP_TEXT, /bake <expr> <channel> <axis>/);
  assert.match(registry.runCommand("help bake").message, /^bake — /);
});

// -- bind/unbind/bindings: the INERT binding registry (C-2) -----------------------

test("bind: registers through the SHARED gate, applies once, and says live", () => {
  const { registry, bindCalls, bindingReg } = makeRegistry();
  const r = registry.runCommand("bind all energy color 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "energy" → color on 3 points of "all" (applied at frame 4, range 0..2.5) — live: re-derives as the displayed frame changes',
  );
  // the composite got the binding AND the normalized scalars (the same
  // mapping bake proved: raw [0, 1.25, 2.5] over 0..2.5 → [0, 0.5, 1])
  assert.equal(bindCalls.length, 1);
  assert.deepEqual(bindCalls[0].b, {
    channel: "energy", axis: "color", points: [0, 1, 2], expr: "all", range: [0, 2.5],
  });
  assert.deepEqual(bindCalls[0].scalars, [0, 0.5, 1]);
  assert.equal(bindingReg.count(), 1);
});

test("bind: gate parity with bake — the same refusals, word for word", () => {
  const { registry, bindingReg } = makeRegistry();
  for (const [bakeCmd, bindCmd] of [
    ["bake all flow color", "bind all flow color"],
    ["bake all energy color", "bind all energy color"],
    ["bake all time color", "bind all time color"],
  ]) {
    const bake = registry.runCommand(bakeCmd);
    const bind = registry.runCommand(bindCmd);
    assert.equal(bind.status, "error", bindCmd);
    assert.equal(bind.message, bake.message, `${bakeCmd} vs ${bindCmd}`);
  }
  assert.equal(bindingReg.count(), 0, "no failure registered anything");
});

test("bind: last-bind-wins WITHIN an axis — the overlap is taken and reported; cross-axis coexists", () => {
  const { registry, bindingReg } = makeRegistry();
  registry.runCommand("bind all energy color 0 2.5");
  // a DIFFERENT axis over the same elements: coexists, takes nothing
  const size = registry.runCommand("bind all mass size");
  assert.equal(size.status, "ok");
  assert.doesNotMatch(size.message, /took/, "cross-axis bind reports no takeover");
  assert.equal(bindingReg.count(), 2);
  // the SAME axis over a subset: element-level takeover, reported
  const r = registry.runCommand("bind c1 mass color 1 3");
  assert.equal(r.status, "ok");
  assert.match(r.message, /took 1 elements from 1 earlier binding/);
  assert.deepEqual(bindingReg.all().map((b) => ({ channel: b.channel, axis: b.axis, points: b.points })), [
    { channel: "energy", axis: "color", points: [0, 1] },
    { channel: "mass", axis: "size", points: [0, 1, 2] },
    { channel: "mass", axis: "color", points: [2] },
  ]);
});

test("unbind: element-wise release; all clears; empty and no-overlap are nomatch", () => {
  const { registry, bindingReg } = makeRegistry();
  assert.equal(registry.runCommand("unbind all").status, "nomatch", "nothing bound yet");
  registry.runCommand("bind all energy color 0 2.5");
  const part = registry.runCommand("unbind c1"); // point 2 only
  assert.equal(part.status, "ok");
  assert.equal(part.message, "released 1 bound elements across 1 binding — values stay as last applied");
  assert.deepEqual(bindingReg.all().map((b) => b.points), [[0, 1]]);
  const rest = registry.runCommand("unbind all");
  assert.equal(rest.status, "ok");
  assert.equal(rest.message, "released 2 bound elements across 1 binding (1 removed) — values stay as last applied");
  assert.equal(bindingReg.count(), 0);
  assert.equal(registry.runCommand("unbind").status, "error", "bare unbind is a usage error");
});

test("unbind: an axis word scopes the release to that axis alone", () => {
  const { registry, bindingReg } = makeRegistry();
  registry.runCommand("bind all energy color 0 2.5");
  registry.runCommand("bind all mass size");
  const r = registry.runCommand("unbind all color");
  assert.equal(r.status, "ok");
  assert.equal(r.message, "released 3 bound elements across 1 binding (1 removed) on color — values stay as last applied");
  assert.deepEqual(bindingReg.all().map((b) => b.axis), ["size"], "the size binding is untouched");
  const part = registry.runCommand("unbind c1 size");
  assert.equal(part.message, "released 1 bound elements across 1 binding on size — values stay as last applied");
  assert.equal(registry.runCommand("unbind c1 color").status, "nomatch", "nothing bound on that axis there");
});

// -- orientation (O-1): the vector axis, STATE-ONLY — stored, listed, never drawn --

// The orientation tests run on a NON-IDENTITY vertex→point map ([0, 2]:
// vertex 1 → point 2), so the vertex-id and point-id spaces are numerically
// DISTINCT — with the default [0] fixture the two spaces coincide and a
// space-mixing regression is undetectable (found by adversarial review).
const ORI_FIXTURE = { traceVertices: [0, 2] };

test("orientation: bind accepts a 3-wide channel RAW onto polyline vertices, and says stored-only", () => {
  const { registry, bindingReg, bindCalls } = makeRegistry(ORI_FIXTURE);
  // vertex 0 → point 0's flow (1,0,0); vertex 1 → point 2's flow (0,0,1)
  const r = registry.runCommand("bind all flow orientation");
  assert.equal(r.status, "ok");
  assert.equal(
    r.message,
    'bound "flow" → orientation on 2 vertices of "all" (applied at frame 4, raw vectors) — live: re-derives as the displayed frame changes; STORED ONLY, no shape reads orientation yet',
  );
  assert.equal(bindCalls.length, 1);
  assert.deepEqual(bindCalls[0].b.points, [0, 1],
    "coverage holds VERTEX ids — [0, 2] here would be the point ids leaking in");
  assert.deepEqual(bindCalls[0].scalars, [1, 0, 0, 0, 0, 1], "each vertex's OWN point's raw vector");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points, range: b.range })),
    [{ axis: "orientation", points: [0, 1], range: null }],
  );
  const list = registry.runCommand("bindings");
  assert.match(list.message, /flow → orientation on "all" — 2 vertices · raw vectors \(stored; nothing draws orientation yet\)/);
});

test("orientation: bake stores once without a binding; wrong shapes refuse loudly", () => {
  const { registry, bindingReg, orientationOps } = makeRegistry(ORI_FIXTURE);
  const bake = registry.runCommand("bake all flow orientation");
  assert.equal(bake.status, "ok");
  assert.match(bake.message, /baked "flow" → orientation on 2 vertices of "all" \(frame 4, raw vectors\) — stored; no shape reads orientation yet/);
  assert.equal(orientationOps.length, 1);
  assert.deepEqual(orientationOps[0], { vertexIds: [0, 1], values: [1, 0, 0, 0, 0, 1] },
    "vertex ids + each vertex's own point's raw vector");
  assert.equal(bindingReg.count(), 0, "bake registers nothing");
  const cases: [string, RegExp][] = [
    ["bind all energy orientation", /orientation needs a vector \(3-wide\) channel — "energy" is scalar/],
    ["bind all flow orientation 0 1", /meaningless for the orientation axis/],
    ["bake all energy orientation", /orientation needs a vector/],
  ];
  for (const [cmd, want] of cases) {
    const r = registry.runCommand(cmd);
    assert.equal(r.status, "error", cmd);
    assert.match(r.message, want, cmd);
  }
  assert.equal(orientationOps.length, 1, "no refusal wrote anything");
});

test("orientation: the two id spaces never mix — the DISCRIMINATING partial unbind", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all flow orientation"); // VERTEX ids: [0, 1]
  registry.runCommand("bind all energy color 0 2.5"); // POINT ids: [0, 1, 2]
  assert.equal(bindingReg.count(), 2, "cross-axis coexistence");
  // c1 = point 2. In vertex space that is vertex 1 (traceVertices[1] = 2).
  // CORRECT: orientation loses vertex 1, color loses point 2 → 2 elements
  // across 2 bindings, orientation coverage [0].
  // A space-mixing regression (releasing orientation with POINT ids {2})
  // would leave orientation [0, 1] untouched — this fixture DISCRIMINATES
  // (with the identity map [0] it could not; adversarial-review finding).
  const part = registry.runCommand("unbind c1");
  assert.equal(part.message, "released 2 bound elements across 2 bindings — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "orientation", points: [0] }, { axis: "color", points: [0, 1] }],
  );
  // …and the mirror: point 0 / vertex 0 collide numerically; unbind c0.g0.s0.a
  // (= point 0 = vertex 0's point) must shrink BOTH bindings by their OWN
  // element, never cross-shrink.
  const both = registry.runCommand("unbind c0.g0.s0.a");
  assert.equal(both.message, "released 2 bound elements across 2 bindings (1 removed) — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "color", points: [1] }],
  );
  // axis-scoped: unbind all orientation touches nothing (already gone)
  const none = registry.runCommand("unbind all orientation");
  assert.equal(none.status, "nomatch");
});

test("bindings: read-only list with the live notice; empty says so; bare only", () => {
  const { registry } = makeRegistry();
  assert.equal(registry.runCommand("bindings").message, "no bindings");
  registry.runCommand("bind all energy opacity 0 2.5");
  const r = registry.runCommand("bindings");
  assert.equal(r.status, "ok");
  const lines = r.message.split("\n");
  assert.match(lines[0], /1 binding \(live: re-derived from the channel as the displayed frame changes\):/);
  assert.equal(lines[1], '  energy → opacity on "all" — 3 points · range 0..2.5');
  assert.equal(registry.runCommand("bindings all").status, "error", "takes no arguments");
});

// -- A-1: per-element edge/trace axes (bond*/trace* — the completeness pass) -----

test("A-1 bake: edge axes use the ENDPOINT MEAN, contained edges only", () => {
  const { registry, elemEachOps } = makeRegistry();
  // edges [[0,1],[1,2]]; energy raw [0, 1.25, 2.5], range 0..2.5:
  // edge0 mean 0.625 → t 0.25 → size 1.5; edge1 mean 1.875 → t 0.75 → 4.5
  const r = registry.runCommand("bake all energy bondsize 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "energy" → bondsize on 2 edges of "all" (frame 4, range 0..2.5, endpoint mean)');
  assert.deepEqual(elemEachOps, [{ axis: "bondsize", ids: [0, 1], values: [1.5, 4.5] }]);
  // contained rule: a target holding only ONE endpoint matches no edge
  const none = registry.runCommand("bake c1 energy bondsize 0 2.5");
  assert.equal(none.status, "nomatch");
  assert.match(none.message, /no edges contained in "c1"/);
});

test("A-1 bake: trace axes read each vertex's OWN point (the orientation map)", () => {
  const { registry, elemEachOps } = makeRegistry(ORI_FIXTURE);
  // vertices [0,1] → points [0,2] → raw [0, 2.5] → t [0,1] → sizes [0,6]
  const r = registry.runCommand("bake all energy tracesize 0 2.5");
  assert.equal(r.status, "ok");
  assert.equal(r.message, 'baked "energy" → tracesize on 2 vertices of "all" (frame 4, range 0..2.5)');
  assert.deepEqual(elemEachOps, [{ axis: "tracesize", ids: [0, 1], values: [0, 6] }]);
});

test("A-1 bind: edge/trace bindings register in their own id spaces and list with their nouns", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all energy bondsize 0 2.5");
  registry.runCommand("bind all energy tracecolor 0 2.5");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [{ axis: "bondsize", points: [0, 1] }, { axis: "tracecolor", points: [0, 1] }],
  );
  const list = registry.runCommand("bindings").message;
  assert.match(list, /energy → bondsize on "all" — 2 edges · range 0\.\.2\.5 · endpoint mean/);
  assert.match(list, /energy → tracecolor on "all" — 2 vertices · range 0\.\.2\.5/);
});

test("A-1: the THREE id spaces never mix — the edge-space discriminator", () => {
  const { registry, bindingReg } = makeRegistry(ORI_FIXTURE);
  registry.runCommand("bind all energy size 0 2.5"); // points [0,1,2]
  registry.runCommand("bind all energy bondsize 0 2.5"); // edges [0,1]
  registry.runCommand("bind all energy tracesize 0 2.5"); // vertices [0,1]
  assert.equal(bindingReg.count(), 3);
  // c0 = points {0,1}: contained edges = {0} ONLY (edge 1 needs point 2).
  // A space-mixing regression releasing edge coverage with POINT ids {0,1}
  // would drop BOTH edges — this discriminates: edge 1 must survive.
  const r = registry.runCommand("unbind c0");
  assert.equal(r.message, "released 4 bound elements across 3 bindings — values stay as last applied");
  assert.deepEqual(
    bindingReg.all().map((b) => ({ axis: b.axis, points: b.points })),
    [
      { axis: "size", points: [2] },
      { axis: "bondsize", points: [1] },
      { axis: "tracesize", points: [1] },
    ],
  );
});

// -- A-2: per-target style selection ---------------------------------------------

test("A-2: style verbs write the REGISTRY INDEX per family targeting; unknown names list the registry", () => {
  const { registry, styleOps } = makeRegistry();
  const p = registry.runCommand("stylepoints all matte");
  assert.equal(p.status, "ok");
  assert.equal(p.message, "styled 3 points matte");
  assert.deepEqual(styleOps[0], { kind: "points", ids: [0, 1, 2], index: 1 });
  const b = registry.runCommand("stylebonds all standard");
  assert.equal(b.message, "styled 2 edges standard");
  assert.deepEqual(styleOps[1], { kind: "edges", ids: [0, 1], index: 0 });
  // contained rule: c1 = point 2 only → no contained edge
  assert.equal(registry.runCommand("stylebonds c1 matte").status, "nomatch");
  const t = registry.runCommand("styletrace c0 matte");
  assert.equal(t.message, "styled 1 polyline vertices matte");
  assert.deepEqual(styleOps[2], { kind: "trace", ids: [0], index: 1 });
  const bad = registry.runCommand("stylepoints all glossy");
  assert.equal(bad.status, "error");
  assert.match(bad.message, /unknown style "glossy" — styles: standard, matte/);
  assert.equal(styleOps.length, 3, "no failure wrote anything");
  const list = registry.runCommand("styles");
  assert.equal(list.message, "styles:\n  standard (default)\n  matte");
});

test("bind family: help surfaces all three verbs", () => {
  const { registry } = makeRegistry();
  assert.match(HELP_TEXT, /bind <expr> <channel> <axis>/);
  assert.match(HELP_TEXT, /unbind <expr>\|all/);
  for (const verb of ["bind", "unbind", "bindings"]) {
    assert.match(registry.runCommand(`help ${verb}`).message, new RegExp(`^${verb} — `));
  }
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

// -- rm reconciliation: a file already gone vs a real failure (Part A) --------
test("isFileAlreadyGone: ENOENT reconciles (unregister), other errors stay registered", () => {
  assert.ok(isFileAlreadyGone("ENOENT: no such file or directory, unlink '/x/rg_all.py'"));
  assert.ok(isFileAlreadyGone("no such file"));
  // a real failure — must NOT be reconciled (leaves the mod registered)
  assert.ok(!isFileAlreadyGone("EACCES: permission denied, unlink '/x/rg.py'"));
  // the fileless-mod case (broken_ramp) is a distinct 'no file recorded' — not ENOENT
  assert.ok(!isFileAlreadyGone("no file recorded for this mod"));
});

// -- produces: commands — refusals + all-or-nothing (the macro-mod boundary) --
function macroTracker() {
  const calls = { validate: [] as string[], run: [] as string[], beginStroke: 0, endStroke: 0 };
  const ok: CommandResult = { status: "ok", message: "ok" };
  const make = (
    validate: (c: string) => CommandResult = () => ok,
    run: (c: string) => CommandResult = (c) => ({ status: "ok", message: `ran ${c}` }),
  ) => ({
    modNames: new Set(["rainbow", "color_ab"]),
    validate: (c: string) => { calls.validate.push(c); return validate(c); },
    run: (c: string) => { calls.run.push(c); return run(c); },
    beginStroke: () => { calls.beginStroke++; },
    endStroke: () => { calls.endStroke++; },
  });
  return { calls, make };
}

test("commandMacroRefusal: rm and mod-invocation refused; scene verbs allowed", () => {
  const mods = new Set(["rainbow", "color_ab"]);
  assert.match(commandMacroRefusal("rm all", mods)!, /rm.*not allowed/);
  assert.match(commandMacroRefusal("color_ab all", mods)!, /invoking a mod.*recursion/);
  assert.match(commandMacroRefusal("rainbow alpha", mods)!, /recursion/);
  assert.equal(commandMacroRefusal("colorbonds alpha.group-0.* red", mods), null);
  assert.equal(commandMacroRefusal("hide beta", mods), null);
});

test("runCommandMacro refuses rm anywhere in the list — executes NOTHING", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("m", ["colorbonds alpha red", "rm all", "hide beta"], make());
  assert.equal(r.status, "error");
  assert.match(r.message, /refused.*rm.*not allowed.*Nothing ran/s);
  assert.equal(calls.run.length, 0, "no command executed");
  assert.equal(calls.beginStroke, 0, "no undo stroke opened");
});

test("runCommandMacro refuses invoking a mod (no recursion) — executes NOTHING", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("color_ab", ["colorbonds alpha red", "color_ab all"], make());
  assert.equal(r.status, "error");
  assert.match(r.message, /invoking a mod.*Nothing ran/s);
  assert.equal(calls.run.length, 0);
});

test("runCommandMacro: a parse error in the THIRD string runs ZERO commands", () => {
  const { calls, make } = macroTracker();
  const validate = (c: string): CommandResult =>
    c.includes("BAD") ? { status: "error", message: "empty segment — \"..\" not allowed" } : { status: "ok", message: "" };
  const r = runCommandMacro("m", ["colorbonds alpha red", "hide beta", "view a..b BAD"], make(validate));
  assert.equal(r.status, "error");
  assert.match(r.message, /command 3 is invalid.*Nothing ran/s);
  assert.equal(calls.run.length, 0, "ZERO commands executed — not two");
  assert.equal(calls.beginStroke, 0);
});

test("runCommandMacro: a nomatch is NOT an error — the rest still execute", () => {
  const { calls, make } = macroTracker();
  const validate = (c: string): CommandResult =>
    c.includes("nothere") ? { status: "nomatch", message: "nothing matches" } : { status: "ok", message: "" };
  const r = runCommandMacro("m", ["colorbonds alpha red", "colorbonds nothere blue"], make(validate));
  assert.equal(r.status, "ok");
  assert.equal(calls.run.length, 2, "both ran despite the nomatch");
  assert.equal(calls.beginStroke, 1);
  assert.equal(calls.endStroke, 1);
});

test("runCommandMacro: EVERY command nomatches → loud nomatch summary, not cheerful ok (Part B)", () => {
  const { calls, make } = macroTracker();
  // validate passes (labels are grammatically fine), but at RUN time each one
  // resolves to nothing — the guessed-label trap.
  const pass = (): CommandResult => ({ status: "ok", message: "" });
  const run = (): CommandResult => ({ status: "nomatch", message: "nothing matches" });
  const r = runCommandMacro("dssp", ["colorbonds polymer.C.* red", "colorbonds polymer.D.* blue"], make(pass, run));
  assert.equal(r.status, "nomatch", "all-nomatch is surfaced, not reported as success");
  assert.match(r.message, /nothing matched/i);
  assert.match(r.message, /nothing was written/i);
  assert.match(r.message, /data\.labels/, "the message points the mod at the fix");
  assert.equal(calls.run.length, 2, "it still ran everything — the batch is just empty of matches");
  assert.equal(calls.beginStroke, 1);
  assert.equal(calls.endStroke, 1, "one stroke, balanced");
});

test("runCommandMacro: a PARTIAL nomatch stays a normal ok (one match is enough)", () => {
  const { make } = macroTracker();
  const pass = (): CommandResult => ({ status: "ok", message: "" });
  const run = (c: string): CommandResult =>
    c.includes("good") ? { status: "ok", message: "colored 5 edges" } : { status: "nomatch", message: "nothing matches" };
  const r = runCommandMacro("m", ["colorbonds good red", "colorbonds nothere blue"], make(pass, run));
  assert.equal(r.status, "ok", "one real match keeps the macro a success");
  assert.match(r.message, /ran 2 commands/);
});

test("runCommandMacro: all valid → runs all in ONE stroke, reports per-command outcomes", () => {
  const { calls, make } = macroTracker();
  const r = runCommandMacro("look", ["colorbonds alpha red", "colorbonds beta blue"], make());
  assert.equal(r.status, "ok");
  assert.deepEqual(calls.run, ["colorbonds alpha red", "colorbonds beta blue"]);
  assert.equal(calls.beginStroke, 1, "exactly one stroke opened");
  assert.equal(calls.endStroke, 1, "and closed once → one undo stroke");
  assert.match(r.message, /ran 2 commands \(one undo stroke\)/);
  assert.match(r.message, /colorbonds alpha red → ran colorbonds alpha red/);
});

// ================== the code that RUNS is the code that was APPROVED ==========
// write_mod is a GATED tool: the human is shown a mod's FULL source and approves
// it. So the viewer must run the code it was last handed. It did not: installMods
// guarded with "is this name already a verb", which is true of every already-
// installed mod — so a mod re-pushed under its own name collided with ITSELF, was
// skipped, and both caches (the recipe entry holding mod.code, and the command
// handler CLOSING OVER the mod object) kept version 1. The human approved version
// B; version A ran. delete_mod + rewrite worked only because it is the one path
// that evicts those caches.

/** Install into a real registry + the real recipe registry, exactly as main.ts
 * wires it — the deps are the only thing main.ts adds. */
function makeInstaller() {
  const made = makeRegistry();
  const install = (mods: unknown) =>
    installModList(mods, {
      isBuiltin: (name) => made.registry.isBuiltin(name),
      install: (mod) => {
        registerRecipe(mod);
        made.registry.register(mod.name, makeAnalysisModHandler(made.ctx, mod), "analysis mod");
      },
    });
  return { ...made, install };
}

const modV = (name: string, code: string): AnalysisMod => ({
  kind: "analysis", name, produces: "commands", origin: "workspace",
  description: "overwrite fixture", code,
});

test("§3.1 a re-pushed mod RUNS ITS NEW CODE — not the version it was first registered with", () => {
  const { registry, install, modRunCode } = makeInstaller();
  const A = modV("zz_over", "def compute(d,t): return ['A']");
  const B = modV("zz_over", "def compute(d,t): return ['B']");
  try {
    assert.deepEqual(install([A]), { installed: ["zz_over"], skipped: [] });
    registry.runCommand("zz_over c0");
    assert.deepEqual(modRunCode, [A.code], "version A runs first — the baseline");

    // The overwrite: same name, new code, NO delete in between. This is exactly
    // what write_mod does, and it is where the gate used to break.
    assert.deepEqual(install([B]), { installed: ["zz_over"], skipped: [] },
      "a re-push is an INSTALL, not a self-collision to skip");
    registry.runCommand("zz_over c0");
    assert.deepEqual(modRunCode, [A.code, B.code],
      "THE INVARIANT: the handler now ships version B — the code the human approved");

    // Both caches, not just one: a stale recipe entry is the same bug wearing a
    // different hat (run_mod reads mod.code straight off the registry).
    const entry = getRecipe("zz_over");
    assert.equal(entry?.kind === "analysis" ? entry.code : null, B.code,
      "the recipe registry holds version B too");
  } finally {
    unregisterRecipe("zz_over");
  }
});

test("§3.3 a mod named after a BUILT-IN is still refused — and the built-in still works", () => {
  const { registry, install, colorEachOps } = makeInstaller();
  const hostile = modV("rainbow", "def compute(d,t): return ['pwned']");
  const outcome = install([hostile]);
  assert.deepEqual(outcome.installed, [], "nothing installed");
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].name, "rainbow");
  assert.match(outcome.skipped[0].reason, /built-in/, "and it says WHY");

  // the reason the guard exists: the built-in must be untouched
  const r = registry.runCommand("rainbow c0");
  assert.equal(r.status, "ok", r.message);
  assert.equal(colorEachOps.length, 1, "the real rainbow ran — its handler was never replaced");
  assert.equal(getRecipe("rainbow")?.origin, "built-in", "and its recipe entry is still the built-in");
});

test("a mod's own verb is NOT a built-in — sealing draws the line where the factory ends", () => {
  const { registry, install } = makeInstaller();
  try {
    assert.ok(registry.isBuiltin("colorpoints") && registry.isBuiltin("rainbow") && registry.isBuiltin("help"));
    install([modV("zz_over", "def compute(d,t): return []")]);
    assert.ok(registry.verbs().includes("zz_over"), "it IS a verb");
    assert.ok(!registry.isBuiltin("zz_over"), "…but never a built-in — which is what makes the re-push legal");
  } finally {
    unregisterRecipe("zz_over");
  }
});

test("§3.2 modInstallReport is TRUTHFUL — it never reports a registration that did not happen", () => {
  const skipped = { installed: [], skipped: [{ name: "rainbow", reason: '"rainbow" is a built-in command' }] };
  const refused = modInstallReport(skipped, "rainbow");
  assert.equal(refused.status, "error", "a skip is an ERROR the tool can surface, not a silent line");
  assert.match(refused.message, /did NOT register/);
  assert.match(refused.message, /built-in command/, "the reason travels with it");

  const good = modInstallReport({ installed: ["rg"], skipped: [] }, "rg");
  assert.equal(good.status, "ok");
  assert.match(good.message, /registered mod "rg"/);

  // the file was written but never reached the registry at all (malformed on
  // re-parse, or the viewer was not ready): still not a success.
  const absent = modInstallReport({ installed: ["other"], skipped: [] }, "rg");
  assert.equal(absent.status, "error");
  assert.match(absent.message, /not among the mods loaded from disk/);
});

test("a malformed entry in a push is skipped WITH a reason, never silently dropped", () => {
  const { install } = makeInstaller();
  const outcome = install([{ name: "half", kind: "analysis" }, { kind: "analysis", code: "x" }]);
  assert.deepEqual(outcome.installed, []);
  assert.deepEqual(outcome.skipped.map((s) => s.name), ["half", "(unnamed)"]);
  assert.ok(outcome.skipped.every((s) => /well-formed/.test(s.reason)));
});
