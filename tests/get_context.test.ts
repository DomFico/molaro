/**
 * get_context truthfulness guard (Part B). Everything get_context advertises as
 * a usable target must actually resolve through the SAME grammar resolver the
 * commands use — the tool is the model's ground truth about the scene, and a
 * lie there burns a turn and shows the user a red error for nothing.
 *
 * The observed bug: get_context advertised `@all`, but `@all` is the union of
 * committed SELECTIONS (empty when there are none) — the whole-system token is
 * the bare `all` keyword. And it advertised every domain category, most of
 * which have no atoms on a given system. This asserts the fix and, generally,
 * that no example it emits can resolve to nothing again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { buildTree } from "../webview/classification.ts";
import { Hierarchy } from "../webview/sets.ts";
import { parseTarget, resolveTarget, type TargetAst } from "../webview/address.ts";
import { buildTargetExamples } from "../src/claudetools.ts";

/** entries a target resolves to (0 = resolves to nothing; -1 = parse error). */
function resolveCount(header: Header, expr: string): number {
  const ast = parseTarget(expr);
  if (ast.kind !== "target") return -1;
  return resolveTarget(ast as TargetAst, buildTree(header), new Hierarchy(header), header.points.type, new Map()).length;
}

/** the present-category filter get_context applies host-side. */
function presentCategories(header: Header): string[] {
  const present = new Set(header.points.category);
  return header.categories.filter((_, i) => present.has(i));
}

// alpha/beta/env3 all present; adds a 4th declared-but-EMPTY category "ghost".
function makeHeader(): Header {
  const category = [0, 0, 0, 1, 1, 2, 2, 2];
  return {
    version: "0.1.0", name: "adk-like", n_points: category.length, n_frames: 98, units: "nm", bbox: null,
    points: {
      type: ["C", "N", "O", "C", "N", "O", "S", "C"], // element-symbol point types
      group_id: [10, 10, 10, 11, 11, 12, 12, 12],
      subgroup_id: [100, 100, 101, 102, 102, 103, 103, 103],
      category,
    },
    categories: ["alpha", "beta", "env3", "ghost"], // "ghost" has NO points
    groups: { "10": "g-1", "11": "g-2", "12": "g-7" },
    subgroups: { "100": "s1", "101": "s2", "102": "s3", "103": "s4" },
    edges: [], polylines: [], channels: [],
  };
}

/** the distinct point types get_context advertises, sorted (host computation). */
function presentPointTypes(header: Header): string[] {
  return [...new Set(header.points.type.map((t) => String(t).trim()).filter(Boolean))].sort();
}

test("every target get_context advertises resolves to a NON-EMPTY set", () => {
  const header = makeHeader();
  const examples = buildTargetExamples(presentCategories(header));
  for (const ex of examples) {
    const n = resolveCount(header, ex);
    assert.ok(n > 0, `advertised target "${ex}" must resolve non-empty — got ${n}`);
  }
});

test("every advertised point type resolves via `*.*.*.<type>` (Part A — the CPK fix)", () => {
  const header = makeHeader();
  const types = presentPointTypes(header);
  assert.deepEqual(types, ["C", "N", "O", "S"], "distinct element types, sorted");
  for (const t of types) {
    // exactly the address get_context tells the model to use for a type class
    assert.ok(resolveCount(header, `*.*.*.${t}`) > 0, `advertised point type "${t}" must resolve as *.*.*.${t}`);
  }
  // a type NOT present resolves to nothing (so we never advertise it)
  assert.equal(resolveCount(header, "*.*.*.H"), 0, "an absent type resolves to nothing — correctly not advertised");
});

test("`all` is the whole-system token; `@all` (the reported bug) resolves to nothing", () => {
  const header = makeHeader();
  assert.ok(resolveCount(header, "all") > 0, "`all` resolves");
  assert.equal(resolveCount(header, "@all"), 0, "`@all` = union of committed selections — empty with none");
});

test("get_context advertises ONLY categories that have atoms (empty domain categories excluded)", () => {
  const header = makeHeader();
  const present = presentCategories(header);
  assert.deepEqual(present, ["alpha", "beta", "env3"]); // "ghost" excluded
  // the excluded category, had it been advertised, would resolve to nothing:
  assert.equal(resolveCount(header, "ghost"), 0);
  // and every actually-advertised example resolves:
  for (const ex of buildTargetExamples(present)) assert.ok(resolveCount(header, ex) > 0, ex);
});

// ---------------------------------------------------------------------------
// LIVE state (B-3 prompt pass, Half 1): get_context reports channels /
// bindings / shapes / styles from the RUNNING VIEWER, never the cached
// header — so a thing created mid-session is visible in the NEXT call.
// ---------------------------------------------------------------------------
import { gatherLiveState } from "../src/claudetools.ts";
import { makeChannelsHandler } from "../webview/commands.ts";

test("gatherLiveState reflects the LIVE query — a mid-session channel appears at once", async () => {
  // a viewer whose `channels` output GROWS between two calls (a mod declared
  // one); every other verb is stubbed. gatherLiveState must track the query,
  // proving get_context reads live state, not a boot snapshot.
  let declared = false;
  const query = async (verb: string) => {
    if (verb === "channels") {
      return { ok: true, message: declared
        ? "channels (bake/bind read these):\n  energy — scalar · per-frame\n  produced_dir — vector (3-wide) · per-frame"
        : "channels (bake/bind read these):\n  energy — scalar · per-frame" };
    }
    if (verb === "bindings") return { ok: true, message: "no bindings" };
    if (verb === "shapes") return { ok: true, message: "shapes:\n  points: (none)" };
    if (verb === "styles") return { ok: true, message: "styles:\n  standard (default)" };
    return { ok: false, message: `unknown ${verb}` };
  };

  const before = await gatherLiveState(query);
  assert.ok(!before.channels.includes("produced_dir"),
    "the produced channel must not appear before it is declared");

  declared = true; // a `produces: channel` mod ran mid-session
  const after = await gatherLiveState(query);
  assert.ok(after.channels.includes("produced_dir"),
    "the produced channel MUST appear in the very next get_context (live, not cached)");
  assert.ok(after.bindings.includes("no bindings") && after.styles.includes("standard"),
    "the other live sections are gathered too");
});

test("gatherLiveState degrades a failed query to a marker, never throws", async () => {
  const query = async (verb: string) => {
    if (verb === "channels") throw new Error("viewer gone");
    return { ok: true, message: `${verb}-ok` };
  };
  const live = await gatherLiveState(query);
  assert.equal(live.channels, "(unavailable)");
  assert.equal(live.shapes, "shapes-ok");
});

test("the `channels` verb lists declared channels live, flags per-frame vs static and bound", () => {
  // a minimal CommandContext exercising only what makeChannelsHandler reads.
  const ctxChannels = [
    { name: "mass", scope: "per_point" as const, components: 1, min: 0.5, max: 5 },
    { name: "energy", scope: "per_point_per_frame" as const, components: 1 },
    { name: "produced_dir", scope: "per_point_per_frame" as const, components: 3 },
  ];
  const ctx = {
    channels: () => ctxChannels,
    listBindings: () => [{ channel: "energy" }],
  } as unknown as Parameters<typeof makeChannelsHandler>[0];
  const r = makeChannelsHandler(ctx)("");
  assert.equal(r.status, "ok");
  assert.match(r.message, /mass — scalar \[0\.5, 5\] · per_point \(static\)/);
  assert.match(r.message, /energy — scalar · per-frame · bound/);
  assert.match(r.message, /produced_dir — vector \(3-wide\) · per-frame/);
  // no arguments allowed (bare verb)
  assert.equal(makeChannelsHandler(ctx)("all").status, "error");
});
