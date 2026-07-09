/**
 * Unit tests for the address grammar (webview/address.ts): parseTarget's AST
 * and errors, and resolveTarget's scoped recursive descent over a hand-built
 * Hierarchy. Pure, no DOM. Run from viewer/:  node --test tests/address.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { buildTree } from "../webview/classification.ts";
import { Hierarchy, type Entry } from "../webview/sets.ts";
import {
  completeTarget,
  globMatch,
  parseTarget,
  resolveTarget,
  type ParseError,
  type TargetAst,
} from "../webview/address.ts";

/**
 * Fixture tree (labels chosen to exercise every predicate kind per level):
 *
 *   cat 0 "alpha"  group 10 "g-1"  sub 100 "s1"  pts 0 "tH", 1 "t2"
 *                                  sub 101 "s2"  pt  2 "anchor"
 *                  group 11 "g-2"  sub 102 "s1"  pts 3 "t2", 4 "aX"   ← duplicate
 *   cat 1 "beta"   group 12 "g-7"  sub 103 "s7"  pts 5 "tH", 6 "t9", 7 "anchor"
 *   cat 2 "env3"   group 13 "bath" sub 104 "w1"  pts 8, 9  "w"
 *                                  sub 105 "w2"  pts 10,11 "w"
 *
 * Subgroups 100 and 102 share the LABEL "s1" under different groups — the
 * scoped-descent leak probe.
 */
function makeHeader(): Header {
  const category = [0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2];
  const group_id = [10, 10, 10, 11, 11, 12, 12, 12, 13, 13, 13, 13];
  const subgroup_id = [100, 100, 101, 102, 102, 103, 103, 103, 104, 104, 105, 105];
  const type = ["tH", "t2", "anchor", "t2", "aX", "tH", "t9", "anchor", "w", "w", "w", "w"];
  return {
    version: "0.1.0", name: "t", n_points: category.length, n_frames: 1, units: "m", bbox: null,
    points: { type, group_id, subgroup_id, category },
    categories: ["alpha", "beta", "env3"],
    groups: { "10": "g-1", "11": "g-2", "12": "g-7", "13": "bath" },
    subgroups: { "100": "s1", "101": "s2", "102": "s1", "103": "s7", "104": "w1", "105": "w2" },
    edges: [], polylines: [], channels: [],
  };
}

const header = makeHeader();
const hier = new Hierarchy(header);
const tree = buildTree(header);
const none = new Map<string, readonly Entry[]>();

function resolve(expr: string, committed: ReadonlyMap<string, readonly Entry[]> = none): Entry[] {
  const ast = parseTarget(expr);
  assert.equal(ast.kind, "target", `parse failed for "${expr}": ${(ast as ParseError).message}`);
  return resolveTarget(ast as TargetAst, tree, hier, header.points.type, committed);
}
/** Sorted "level:id" keys — resolution results are sets, order-insensitive here. */
function keys(expr: string, committed?: ReadonlyMap<string, readonly Entry[]>): string[] {
  return resolve(expr, committed).map((e) => `${e.level}:${e.id}`).sort();
}
function parseErr(expr: string): string {
  const r = parseTarget(expr);
  assert.equal(r.kind, "error", `expected a parse error for "${expr}"`);
  return (r as ParseError).message;
}

// -- parsing: AST shapes -------------------------------------------------------

test("parseTarget classifies predicates: star / glob / range / literal / quoted", () => {
  const ast = parseTarget(`*.a*b.3-9."3-9",lit`) as TargetAst;
  assert.equal(ast.kind, "target");
  const segs = (ast.terms[0] as { segments: { predicates: unknown[] }[] }).segments;
  assert.deepEqual(segs[0].predicates, [{ kind: "star" }]);
  assert.deepEqual(segs[1].predicates, [{ kind: "glob", pattern: "a*b" }]);
  assert.deepEqual(segs[2].predicates, [{ kind: "range", lo: 3, hi: 9 }]);
  assert.deepEqual(segs[3].predicates, [
    { kind: "literal", value: "3-9" }, // quoted — never a range
    { kind: "literal", value: "lit" },
  ]);
});

test("parseTarget: terms, refs, and whitespace around '+'", () => {
  const ast = parseTarget(`  alpha.g-1.*.t2 + @x + @"my picks"  `) as TargetAst;
  assert.equal(ast.terms.length, 3);
  assert.equal((ast.terms[0] as { segments: unknown[] }).segments.length, 4);
  assert.deepEqual(ast.terms[1], { kind: "ref", name: "x" });
  assert.deepEqual(ast.terms[2], { kind: "ref", name: "my picks" });
});

// -- parsing: errors -------------------------------------------------------------

test("parse errors: empty input, empty segments, empty list elements", () => {
  assert.match(parseErr(""), /empty target expression/);
  assert.match(parseErr("   "), /empty target expression/);
  assert.match(parseErr("alpha..s1"), /empty segment/);
  assert.match(parseErr(".alpha"), /empty segment/);
  assert.match(parseErr("alpha."), /empty segment/);
  assert.match(parseErr("a,,b"), /empty predicate/);
  assert.match(parseErr("a,"), /empty predicate/);
});

test("parse errors: reserved characters produce clear messages", () => {
  assert.match(parseErr("a[0]"), /reserved character "\["/);
  assert.match(parseErr("a]"), /reserved character "\]"/);
  assert.match(parseErr("wh?t"), /reserved character "\?"/);
  assert.match(parseErr("?"), /reserved character "\?"/);
});

test("parse errors: quotes, depth, refs, term joins", () => {
  assert.match(parseErr(`"unclosed`), /unbalanced quote/);
  assert.match(parseErr(`ab"cd"`), /quote/);
  assert.match(parseErr(`"ab"cd`), /after a quoted string/);
  assert.match(parseErr("a.b.c.d.e"), /at most 4/);
  assert.match(parseErr("@"), /selection name/);
  assert.match(parseErr("@name.x"), /unexpected "\."/);
  assert.match(parseErr("alpha beta"), /joined with "\+"/);
  assert.match(parseErr("+alpha"), /term before "\+"/);
  assert.match(parseErr("alpha +"), /term after "\+"/);
});

// -- resolution: literals & stars at every level ---------------------------------

test("literal matches at each level; segment count = target level", () => {
  assert.deepEqual(keys("alpha"), ["category:0"]);
  assert.deepEqual(keys("alpha.g-1"), ["group:10"]);
  assert.deepEqual(keys("alpha.g-1.s2"), ["subgroup:101"]);
  assert.deepEqual(keys("alpha.g-1.s1.t2"), ["point:1"]);
  // a k-segment path never auto-descends
  const groupOnly = resolve("alpha.g-1");
  assert.equal(groupOnly.length, 1);
  assert.equal(groupOnly[0].level, "group");
});

test("star matches at each level", () => {
  assert.deepEqual(keys("*"), ["category:0", "category:1", "category:2"]);
  assert.deepEqual(keys("alpha.*"), ["group:10", "group:11"]);
  assert.deepEqual(keys("alpha.g-1.*"), ["subgroup:100", "subgroup:101"]);
  assert.deepEqual(keys("alpha.g-1.s1.*"), ["point:0", "point:1"]);
  assert.equal(resolve("*.*.*.*").length, 12);
  assert.ok(resolve("*.*.*.*").every((e) => e.level === "point"));
});

// -- resolution: globs -----------------------------------------------------------

test("glob matches at each level (starts / ends / contains / A*C), case-sensitive", () => {
  assert.deepEqual(keys("a*"), ["category:0"]); // starts-with
  assert.deepEqual(keys("*a"), ["category:0", "category:1"]); // ends-with
  assert.deepEqual(keys("*n*"), ["category:2"]); // contains
  assert.deepEqual(keys("alpha.g*"), ["group:10", "group:11"]);
  assert.deepEqual(keys("*.*.*.*H"), ["point:0", "point:5"]); // type ends "H"
  assert.deepEqual(keys("*.*.*.a*X"), ["point:4"]); // starts-a-ends-X
  assert.deepEqual(keys("ALPHA"), []); // case-sensitive
  assert.deepEqual(keys("*.*.*.*h*"), ["point:2", "point:7"]); // 'h' only in "anchor"
});

test("scoped descent: a glob under one parent never leaks to siblings", () => {
  // both groups have a subgroup LABELED "s1"; scope decides which resolves
  assert.deepEqual(keys("alpha.g-1.s1"), ["subgroup:100"]);
  assert.deepEqual(keys("alpha.g-2.s1"), ["subgroup:102"]);
  assert.deepEqual(keys("alpha.g-1.s*"), ["subgroup:100", "subgroup:101"]);
  assert.deepEqual(keys("alpha.g-2.s*"), ["subgroup:102"]);
  // ...and a subtree glob under beta never reaches alpha's subgroups
  assert.deepEqual(keys("beta.*.s*"), ["subgroup:103"]);
});

// -- resolution: ranges ----------------------------------------------------------

test("range matches the trailing integer, inclusive, at every level", () => {
  assert.deepEqual(keys("1-5"), ["category:2"]); // env3 → 3
  assert.deepEqual(keys("alpha.1-1"), ["group:10"]); // g-1
  assert.deepEqual(keys("alpha.1-2"), ["group:10", "group:11"]);
  assert.deepEqual(keys("*.2-7"), ["group:11", "group:12"]); // g-2, g-7
  assert.deepEqual(keys("alpha.*.1-1"), ["subgroup:100", "subgroup:102"]); // both "s1"s
  assert.deepEqual(keys("beta.g-7.s7.2-9"), ["point:6"]); // t9
});

test("range: no trailing integer ⇒ no match; inverted bounds match nothing", () => {
  assert.deepEqual(keys("env3.0-99"), []); // "bath" has no trailing int
  assert.deepEqual(keys("beta.g-7.s7.0-8"), []); // tH/anchor no int; t9 out of range
  assert.deepEqual(keys("alpha.9-2"), []); // lo > hi
});

// -- resolution: lists -----------------------------------------------------------

test("list = union of element predicates within the same parent scope", () => {
  assert.deepEqual(keys("alpha.g-1.s1,s2"), ["subgroup:100", "subgroup:101"]);
  assert.deepEqual(keys("alpha.g-1,g-2"), ["group:10", "group:11"]);
  assert.deepEqual(keys("alpha,beta"), ["category:0", "category:1"]);
  // mixed element kinds: literal + range + glob in one list
  assert.deepEqual(keys("alpha.g-1.s2,1-1"), ["subgroup:100", "subgroup:101"]);
  assert.deepEqual(keys("beta.g-7.s7.anchor,t*"), ["point:5", "point:6", "point:7"]);
  // overlapping elements don't duplicate a child
  assert.deepEqual(keys("alpha.g*,g-1,1-2"), ["group:10", "group:11"]);
});

// -- resolution: + union ----------------------------------------------------------

test("+ unions terms across subtrees, deduplicated", () => {
  assert.deepEqual(keys("alpha + beta"), ["category:0", "category:1"]);
  assert.deepEqual(keys("alpha + alpha"), ["category:0"]);
  assert.deepEqual(keys("alpha.g-1.* + alpha.g-1.s1"), ["subgroup:100", "subgroup:101"]);
  assert.deepEqual(keys("alpha.g-1 + beta.g-7.s7.t*"), ["group:10", "point:5", "point:6"]);
});

// -- resolution: @name -------------------------------------------------------------

test("@name yields a committed selection's stored entries at their stored levels", () => {
  const committed = new Map<string, readonly Entry[]>([
    ["picks", [{ level: "subgroup", id: 100 }, { level: "point", id: 5 }]],
    ["solvent", [{ level: "category", id: 2 }]],
    ["my picks", [{ level: "group", id: 12 }]],
  ]);
  assert.deepEqual(keys("@picks", committed), ["point:5", "subgroup:100"]);
  assert.deepEqual(keys("@solvent + env3", committed), ["category:2"]); // dedup across term kinds
  assert.deepEqual(keys(`@"my picks"`, committed), ["group:12"]);
  assert.deepEqual(keys("@nope", committed), []); // unknown name = empty match, not an error
  assert.deepEqual(keys("alpha.g-1.3-9 + @picks", committed), ["point:5", "subgroup:100"]);
});

// -- resolution: quoting ------------------------------------------------------------

test("quoted literals are exact — no glob, no range", () => {
  assert.deepEqual(keys(`alpha."g-1".s1`), ["subgroup:100"]);
  assert.deepEqual(keys(`alpha."g*"`), []); // no group literally named "g*"
  assert.deepEqual(keys(`"1-5"`), []); // no category literally named "1-5"
});

// -- category-spanning groups: the resolver mirrors the VISIBLE tree -----------------

/**
 * A group whose points span categories (contract-legal: only subgroup→group
 * is constrained). The visible tree renders "span" under BOTH left and right,
 * each branch listing only that category's subgroups:
 *
 *   left  → span { sA: pts 0,1 } + { sD: pt 5 }    right → span { sB: pts 2,3 } + { sD: pt 6 }
 *   lone  → solo { sC: pt 4 }
 *
 * sD (pts 5,6) even spans categories itself — the defensive shape buildTree
 * renders under both branches; drilling it shows ALL its points either way.
 */
function makeSpanningHeader(): Header {
  const category = [0, 0, 1, 1, 2, 0, 1];
  const group_id = [20, 20, 20, 20, 21, 20, 20];
  const subgroup_id = [200, 200, 201, 201, 202, 203, 203];
  const type = ["p0", "p1", "p2", "p3", "p4", "p5", "p6"];
  return {
    version: "0.1.0", name: "span", n_points: category.length, n_frames: 1, units: "m", bbox: null,
    points: { type, group_id, subgroup_id, category },
    categories: ["left", "right", "lone"],
    groups: { "20": "span", "21": "solo" },
    subgroups: { "200": "sA", "201": "sB", "202": "sC", "203": "sD" },
    edges: [], polylines: [], channels: [],
  };
}

const spanHeader = makeSpanningHeader();
const spanHier = new Hierarchy(spanHeader);
const spanTree = buildTree(spanHeader);
function spanKeys(expr: string): string[] {
  const ast = parseTarget(expr);
  assert.equal(ast.kind, "target", `parse failed for "${expr}": ${(ast as ParseError).message}`);
  return resolveTarget(ast as TargetAst, spanTree, spanHier, spanHeader.points.type, none)
    .map((e) => `${e.level}:${e.id}`)
    .sort();
}

test("descent through a spanning group stays inside the category branch", () => {
  // the required exclusion: a category-prefixed path over a spanning group
  // never resolves the other category's children/points
  assert.deepEqual(spanKeys("left.span.*"), ["subgroup:200", "subgroup:203"]);
  assert.deepEqual(spanKeys("right.span.*"), ["subgroup:201", "subgroup:203"]);
  assert.deepEqual(spanKeys("left.span.s*.p0,p1"), ["point:0", "point:1"]); // never 2,3
  assert.deepEqual(spanKeys("right.span.sB.*"), ["point:2", "point:3"]); // never 0,1
  // sB is rendered only under right — reaching it through left resolves nothing
  assert.deepEqual(spanKeys("left.span.sB"), []);
});

test("a category prefix surfaces every group the tree renders under it", () => {
  // pre-fix, descent used first-seen-category childrenOf, so right.* was
  // empty; the visible tree shows span under right too
  assert.deepEqual(spanKeys("right.*"), ["group:20"]);
  assert.deepEqual(spanKeys("left.*"), ["group:20"]);
  assert.deepEqual(spanKeys("*.span"), ["group:20"]); // one entry, deduped across branches
});

test("a path TERMINATING at a spanning group yields the bare group entry (click parity)", () => {
  // clicking the "span" row under either category creates {level:"group",
  // id:20}, whose pointsOf is the WHOLE group — the resolver returns that
  // same entry; the category prefix scopes which ROWS match, and scopes any
  // FURTHER descent, but a group entry cannot carry a category
  assert.deepEqual(spanKeys("left.span"), ["group:20"]);
  assert.deepEqual(spanKeys("right.span"), ["group:20"]);
  assert.deepEqual(spanHier.pointsOf({ level: "group", id: 20 }).sort(), [0, 1, 2, 3, 5, 6]);
});

test("a category-spanning SUBGROUP mirrors its rows too (defensive shape)", () => {
  // sD renders under both branches; drilling it shows all its points either
  // way (the tree's drill uses subgroupPoints) — resolution matches
  assert.deepEqual(spanKeys("left.span.sD"), ["subgroup:203"]);
  assert.deepEqual(spanKeys("right.span.sD"), ["subgroup:203"]);
  assert.deepEqual(spanKeys("left.span.sD.*"), ["point:5", "point:6"]);
  assert.deepEqual(spanKeys("*.*.sD"), ["subgroup:203"]); // deduped across branches
});

// -- completion: the inverse of resolution over the same scoped descent --------------

const VERBS = ["view", "hide"];
const NAMES = new Map<string, readonly Entry[]>([
  ["solvent", [{ level: "category", id: 2 }]],
  ["sol2", [{ level: "group", id: 13 }]],
  ["my picks", [{ level: "subgroup", id: 100 }]],
]);
/** Complete at the END of `text` against the main fixture (cursor omitted). */
function comp(text: string, cursor = text.length) {
  return completeTarget(text, cursor, tree, hier, header.points.type, NAMES, VERBS);
}
function compSpan(text: string, cursor = text.length) {
  return completeTarget(text, cursor, spanTree, spanHier, spanHeader.points.type, NAMES, VERBS);
}

test("completion: verbs at the start of the line (unique adds a space)", () => {
  assert.deepEqual(comp("vi"), { start: 0, candidates: ["view"], applied: "ew " });
  assert.deepEqual(comp(""), { start: 0, candidates: ["hide", "view"], applied: "" });
  assert.deepEqual(comp("  h"), { start: 2, candidates: ["hide"], applied: "ide " });
  assert.deepEqual(comp("   ", 3).candidates, ["hide", "view"]);
  assert.deepEqual(comp("zoom").candidates, []);
});

test("completion: categories (interior level — unique appends the dot)", () => {
  assert.deepEqual(comp("view a"), { start: 5, candidates: ["alpha"], applied: "lpha." });
  assert.deepEqual(comp("view "), { start: 5, candidates: ["alpha", "beta", "env3"], applied: "" });
});

test("completion: groups under the scoped category (dot on unique)", () => {
  assert.deepEqual(comp("view alpha."), { start: 11, candidates: ["g-1", "g-2"], applied: "g-" });
  assert.deepEqual(comp("view alpha.g-1"), { start: 11, candidates: ["g-1"], applied: "." });
  assert.deepEqual(comp("view beta."), { start: 10, candidates: ["g-7"], applied: "g-7." });
});

test("completion: subgroups scoped by the branch — NO trailing dot", () => {
  assert.deepEqual(comp("view alpha.g-1."), { start: 15, candidates: ["s1", "s2"], applied: "s" });
  assert.deepEqual(comp("view alpha.g-1.s1"), { start: 15, candidates: ["s1"], applied: "" });
  assert.deepEqual(comp("view alpha.g-2."), { start: 15, candidates: ["s1"], applied: "s1" });
});

test("completion honors the visible tree's category split of a spanning group", () => {
  // "span" renders under both left and right; each branch offers ONLY its own
  // subgroups (sD spans and shows under both)
  assert.deepEqual(compSpan("view left.span.").candidates, ["sA", "sD"]);
  assert.deepEqual(compSpan("view right.span.").candidates, ["sB", "sD"]);
  assert.deepEqual(compSpan("view *.span.").candidates, ["sA", "sB", "sD"]);
});

test("completion: leaf point types under the scoped subgroup — no dot ever", () => {
  assert.deepEqual(comp("view alpha.g-1.s1."), { start: 18, candidates: ["t2", "tH"], applied: "t" });
  assert.deepEqual(comp("view alpha.g-1.s2."), { start: 18, candidates: ["anchor"], applied: "anchor" });
  assert.deepEqual(comp("view alpha.g-1.s1.t").applied, "");
  assert.deepEqual(comp("view beta.g-7.s7.").candidates, ["anchor", "t9", "tH"]);
});

test("completion: @ completes committed-selection names", () => {
  assert.deepEqual(comp("view @").candidates, ["my picks", "sol2", "solvent"]);
  assert.deepEqual(comp("view @sol"), { start: 6, candidates: ["sol2", "solvent"], applied: "" });
  assert.deepEqual(comp("view @solv"), { start: 6, candidates: ["solvent"], applied: "ent" });
});

test("completion: after + a fresh term begins (path or @)", () => {
  assert.deepEqual(comp("view alpha + ").candidates, ["alpha", "beta", "env3"]);
  assert.deepEqual(comp("view alpha + e"), { start: 13, candidates: ["env3"], applied: "nv3." });
  assert.deepEqual(comp("view alpha +@sol").candidates, ["sol2", "solvent"]);
});

test("completion: list elements complete in the SAME segment's scope", () => {
  assert.deepEqual(comp("view alpha.g-1,"), { start: 15, candidates: ["g-1", "g-2"], applied: "g-" });
  assert.deepEqual(comp("view alpha,").candidates, ["alpha", "beta", "env3"]);
});

test("completion: no-op inside globs and ranges — but dashes in labels still work", () => {
  assert.deepEqual(comp("view al*").candidates, []); // glob in progress
  assert.deepEqual(comp("view alpha.3-").candidates, []); // range in progress
  assert.deepEqual(comp("view alpha.3-9").candidates, []); // complete range
  // a dash inside an ordinary label is NOT a range — completion keeps working
  assert.deepEqual(comp("view alpha.g-"), { start: 11, candidates: ["g-1", "g-2"], applied: "" });
});

test("completion: total on junk — empty candidates, never a throw", () => {
  assert.deepEqual(comp("view alpha..").candidates, []); // empty segment prefix
  assert.deepEqual(comp("view alpha beta").candidates, []); // space inside a term
  assert.deepEqual(comp("view a.b.c.d.").candidates, []); // below the leaf
  assert.deepEqual(comp('view "unclosed').candidates, []); // quote in token
  assert.deepEqual(comp("view nosuch.").candidates, []); // scope resolves nothing
});

test("completion: only text before the cursor counts", () => {
  // cursor after "view a" with trailing text present — completes the category
  const r = comp("view aXXXX", 6);
  assert.deepEqual(r, { start: 5, candidates: ["alpha"], applied: "lpha." });
});

// -- glob matcher edge cases ---------------------------------------------------------

test("globMatch edge cases", () => {
  assert.ok(globMatch("t*", "t")); // * matches empty
  assert.ok(globMatch("*t*", "t"));
  assert.ok(globMatch("s*1", "s1"));
  assert.ok(globMatch("a*b*c", "aXbYc"));
  assert.ok(!globMatch("a*a", "a")); // the two ends can't overlap
  assert.ok(!globMatch("a*b*c", "acb"));
  assert.ok(globMatch("*", ""));
  assert.ok(!globMatch("ab", "abc")); // no-star pattern = exact equality
});
