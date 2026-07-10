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
  const hiddenState = { whole: new Map<string, boolean>(), pts: new Set<number>(), members: new Set<string>() };
  // two committed selections so batch-hide / @all / rename have material
  const sels = new Map<string, readonly Entry[]>([
    ["stored", [{ level: "subgroup", id: 0 }, { level: "point", id: 2 }]],
    ["second", [{ level: "subgroup", id: 1 }]],
  ]);
  const refOps: { names: string[]; hidden: boolean }[] = [];
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
  };
  return { registry: createCommandRegistry(ctx), calls, commits, hiddenState, refOps, sels };
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
