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
      type: category.map(() => "C"),
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

test("every target get_context advertises resolves to a NON-EMPTY set", () => {
  const header = makeHeader();
  const examples = buildTargetExamples(presentCategories(header));
  for (const ex of examples) {
    const n = resolveCount(header, ex);
    assert.ok(n > 0, `advertised target "${ex}" must resolve non-empty — got ${n}`);
  }
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
