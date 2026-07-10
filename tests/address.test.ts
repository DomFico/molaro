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
  splitTrailingName,
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
  assert.match(parseErr("@name..x"), /empty segment/); // @name.x itself is now a legal filter
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

test("range: no trailing integer ⇒ no match; INVERTED bounds normalize to [min,max]", () => {
  assert.deepEqual(keys("env3.0-99"), []); // "bath" has no trailing int
  assert.deepEqual(keys("beta.g-7.s7.0-8"), []); // tH/anchor no int; t9 out of range
  // range order is NOT semantic — either order denotes the same inclusive set
  assert.deepEqual(keys("alpha.9-2"), keys("alpha.2-9"));
  assert.deepEqual(keys("alpha.2-1"), keys("alpha.1-2")); // both groups g-1,g-2
  assert.deepEqual(keys("alpha.2-1"), ["group:10", "group:11"]);
  assert.deepEqual(keys("alpha.1-1"), ["group:10"]); // equal bounds: single value
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

// -- @name.<leaf-pred>: filter a committed selection by ONE leaf predicate -----------

/** mix = subgroup 100 ∪ point 5 → points {0,1,5} with types {tH,t2,tH};
 *  env = category 2 → points {8..11}, all type "w". */
const FNAMES = new Map<string, readonly Entry[]>([
  ["mix", [{ level: "subgroup", id: 100 }, { level: "point", id: 5 }]],
  ["env", [{ level: "category", id: 2 }]],
]);

test("@sel.#N is a containment check against the selection's point set", () => {
  assert.deepEqual(keys("@mix.#1", FNAMES), ["point:1"]);
  assert.deepEqual(keys("@mix.#7", FNAMES), []); // 7 ∉ {0,1,5} → nomatch
  assert.deepEqual(keys("@mix.#0-9", FNAMES), ["point:0", "point:1", "point:5"]);
});

test("@sel.<literal>/<glob> filter by the point type string (regression: leaf half)", () => {
  assert.deepEqual(keys("@mix.tH", FNAMES), ["point:0", "point:5"]);
  assert.deepEqual(keys("@mix.t2", FNAMES), ["point:1"]);
  assert.deepEqual(keys("@mix.t*", FNAMES), ["point:0", "point:1", "point:5"]);
  assert.deepEqual(keys("@mix.w", FNAMES), []); // type exists globally, not in sel
  assert.deepEqual(keys("@env.w", FNAMES), ["point:10", "point:11", "point:8", "point:9"]);
});

test("@sel.<pred> matches ANY ancestor label too — the previously-empty cases", () => {
  // mix = {p0,p1 under s1/g-1/alpha; p5 under s7/g-7/beta}
  assert.deepEqual(keys("@mix.s1", FNAMES), ["point:0", "point:1"]); // subgroup label
  assert.deepEqual(keys(`@mix."s1"`, FNAMES), ["point:0", "point:1"]); // quoted too
  assert.deepEqual(keys("@mix.g-7", FNAMES), ["point:5"]); // group label
  assert.deepEqual(keys("@mix.alpha", FNAMES), ["point:0", "point:1"]); // category label
  assert.deepEqual(keys("@mix.beta", FNAMES), ["point:5"]);
  // globs across ancestor labels
  assert.deepEqual(keys("@mix.g-*", FNAMES), ["point:0", "point:1", "point:5"]);
  assert.deepEqual(keys("@mix.*7", FNAMES), ["point:5"]); // s7 / g-7
  assert.deepEqual(keys("@env.w1", FNAMES), ["point:8", "point:9"]); // one subgroup of env
  assert.deepEqual(keys("@env.bath", FNAMES), ["point:10", "point:11", "point:8", "point:9"]);
});

test("multi-level hits union — matches at different fields never conflict", () => {
  // p2: type "anchor" (and category "alpha"); p8: type "w", group "bath" —
  // one glob hits p2 via its TYPE and p8 via its LABELS; the result unions
  const duo = new Map<string, readonly Entry[]>([
    ["duo", [{ level: "point", id: 2 }, { level: "point", id: 8 }]],
  ]);
  assert.deepEqual(keys("@duo.*a*", duo), ["point:2", "point:8"]);
  assert.deepEqual(keys("@duo.anchor", duo), ["point:2"]); // type-only hit
  assert.deepEqual(keys("@duo.bath", duo), ["point:8"]); // label-only hit
});

test(':" is reserved in @name filters (future level qualifier) — paths unaffected', () => {
  assert.match(parseErr("@mix.x:y"), /level qualifiers .* not yet supported/);
  assert.match(parseErr(`@mix."x:y"`), /level qualifiers .* not yet supported/);
  // a colon inside a PATH token stays an ordinary literal character
  assert.equal(parseTarget("x:y").kind, "target");
  assert.equal(parseTarget("a.b.c.x:y").kind, "target");
});

test("@sel lists union within the filter; @sel.* ≡ @sel's points (flattened)", () => {
  assert.deepEqual(keys("@mix.t2,#5", FNAMES), ["point:1", "point:5"]);
  assert.deepEqual(keys("@mix.tH,#1", FNAMES), ["point:0", "point:1", "point:5"]);
  // the filtered form is ALWAYS point-level — the stored entry levels
  // (here a subgroup + a point) are not preserved
  assert.deepEqual(keys("@mix.*", FNAMES), ["point:0", "point:1", "point:5"]);
  assert.deepEqual(keys("@mix", FNAMES), ["point:5", "subgroup:100"]); // unfiltered: stored levels
});

test("the trailing predicate binds tighter than + (two independent filters)", () => {
  const ast = parseTarget("@mix.tH + @env.w") as TargetAst;
  assert.equal(ast.terms.length, 2);
  assert.equal((ast.terms[0] as { filter?: unknown }).filter !== undefined, true);
  assert.equal((ast.terms[1] as { filter?: unknown }).filter !== undefined, true);
  assert.deepEqual(keys("@mix.tH + @env.w", FNAMES),
    ["point:0", "point:10", "point:11", "point:5", "point:8", "point:9"]);
});

test("@name.a.b is a parse error — a committed selection has no sub-levels", () => {
  assert.match(parseErr("@mix.a.b"), /at most one leaf predicate/);
  assert.match(parseErr("@mix.#1.b"), /at most one leaf predicate/);
});

test("malformed @ filters are parse errors; a missing selection is a nomatch", () => {
  assert.match(parseErr("@mix."), /empty segment/);
  assert.match(parseErr("@mix.#"), /expected an integer after "#"/);
  assert.match(parseErr("@mix.a?"), /reserved character/);
  assert.deepEqual(keys("@nope.#1", FNAMES), []); // nonexistent selection → empty match
  assert.deepEqual(keys("@nope", FNAMES), []);
});

// -- the #N point-index axis ----------------------------------------------------------

test("#N parses as a standalone points term; #lo-hi as a range of indices", () => {
  const one = parseTarget("#161") as TargetAst;
  assert.deepEqual(one.terms, [{ kind: "points", specs: [{ lo: 161, hi: 161 }] }]);
  const range = parseTarget("#156-187") as TargetAst;
  assert.deepEqual(range.terms, [{ kind: "points", specs: [{ lo: 156, hi: 187 }] }]);
  const list = parseTarget("#3,#7-8") as TargetAst;
  assert.deepEqual(list.terms, [{ kind: "points", specs: [{ lo: 3, hi: 3 }, { lo: 7, hi: 8 }] }]);
});

test("standalone #N resolves point entries unconditionally (no scope)", () => {
  assert.deepEqual(keys("#5"), ["point:5"]);
  assert.deepEqual(keys("#3-6"), ["point:3", "point:4", "point:5", "point:6"]);
  assert.deepEqual(keys("#5,#7"), ["point:5", "point:7"]);
  assert.deepEqual(keys("#5 + beta"), ["category:1", "point:5"]); // + composes
});

test("#* is the all-indices wildcard — equivalent spellings, same point sets", () => {
  // standalone: every point in the system, at point level
  const all = resolve("#*");
  assert.equal(all.length, 12);
  assert.ok(all.every((e) => e.level === "point"));
  assert.deepEqual(keys("#*"), keys("#0-999")); // ≡ a covering index range
  // scoped leaf: intersects the path's scope like any # form
  assert.deepEqual(keys("alpha.g-1.s1.#*"), ["point:0", "point:1"]);
  assert.deepEqual(keys("alpha.g-1.s1.#*"), keys("alpha.g-1.s1.*"));
  // @name filter: ≡ the selection's whole point set (and ≡ @name.*)
  assert.deepEqual(keys("@mix.#*", FNAMES), ["point:0", "point:1", "point:5"]);
  assert.deepEqual(keys("@mix.#*", FNAMES), keys("@mix.*", FNAMES));
  // lists and unions compose like any index spec
  assert.deepEqual(keys("alpha.g-1.s1.tH,#*"), ["point:0", "point:1"]);
  assert.equal(resolve("#* + beta").length, 13); // 12 points + the category
});

test("#* obeys the placement rule; malformed # forms still error", () => {
  assert.match(parseErr("alpha.#*"), /standalone term or in a path's final/);
  assert.match(parseErr("#*.x"), /standalone term or in a path's final/);
  assert.match(parseErr("#"), /expected an integer after "#"/);
  assert.match(parseErr("#abc"), /expected an integer after "#"/);
  assert.match(parseErr("#-5"), /expected an integer after "#"/);
  assert.match(parseErr("#5-"), /expected an integer after "-"/);
  assert.match(parseErr("#*5"), /unexpected "5" after a "#" index/);
  assert.match(parseErr("#5*"), /unexpected "\*" after a "#" index/);
});

test("range bounds NORMALIZE: #9-5 ≡ #5-9, in every position", () => {
  assert.deepEqual(keys("#6-3"), keys("#3-6")); // standalone
  assert.deepEqual(keys("#5-5"), ["point:5"]); // equal bounds untouched
  assert.deepEqual(keys("alpha.g-1.s1.#1-0"), keys("alpha.g-1.s1.#0-1")); // scoped leaf
  assert.deepEqual(keys("beta.g-7.s7.anchor,#6-5"), keys("beta.g-7.s7.anchor,#5-6")); // in a list
  assert.deepEqual(keys("#7-5 + alpha"), keys("#5-7 + alpha")); // in a + union
  assert.deepEqual(keys("@mix.#9-0", FNAMES), keys("@mix.#0-9", FNAMES)); // @name filter
});

test("out-of-range indices are an empty match (nomatch), never an error", () => {
  assert.deepEqual(keys("#500"), []); // n_points = 12
  assert.deepEqual(keys("#10-500"), ["point:10", "point:11"]); // clamped
  assert.deepEqual(keys("#500-10"), ["point:10", "point:11"]); // inverted clamps the same
});

test("scoped leaf #N INTERSECTS the scope — a containment check", () => {
  assert.deepEqual(keys("alpha.g-1.s1.#1"), ["point:1"]); // 1 ∈ s1 {0,1}
  assert.deepEqual(keys("alpha.g-1.s1.#5"), []); // 5 lives under beta — no match
  assert.deepEqual(keys("alpha.*.*.#0-99"), ["point:0", "point:1", "point:2", "point:3", "point:4"]);
  // mixed leaf list: a type literal and an index union within the segment
  assert.deepEqual(keys("beta.g-7.s7.anchor,#5"), ["point:5", "point:7"]);
});

test("#lo-hi is the INDEX range; bare lo-hi keeps the label-trailing-int meaning", () => {
  assert.deepEqual(keys("beta.g-7.s7.2-9"), ["point:6"]); // matches type "t9" by trailing int
  assert.deepEqual(keys("beta.g-7.s7.#2-9"), ["point:5", "point:6", "point:7"]); // indices 5..7 ∩ [2,9]
  assert.deepEqual(keys("beta.g-7.s7.#6"), ["point:6"]); // by index, not type
});

test("misplaced # (segments 1–3, or a dot after a standalone #) is a parse error", () => {
  assert.match(parseErr("#5.x"), /standalone term or in a path's final/);
  assert.match(parseErr("alpha.#5"), /standalone term or in a path's final/);
  assert.match(parseErr("alpha.g-1.#5"), /standalone term or in a path's final/);
  assert.match(parseErr("#5,alpha"), /expected "#" to start each index/);
});

test("malformed # forms are parse errors", () => {
  assert.match(parseErr("#"), /expected an integer after "#"/);
  assert.match(parseErr("#abc"), /expected an integer after "#"/);
  // "#*" is now VALID (the all-indices wildcard) — covered in its own suite
  assert.match(parseErr("#-5"), /expected an integer after "#"/);
  assert.match(parseErr("#5-"), /expected an integer after "-"/);
  assert.match(parseErr("#5x"), /unexpected "x" after a "#" index/);
  assert.match(parseErr("ab#c"), /must start an index specifier/);
});

// -- category-spanning groups: the resolver mirrors the VISIBLE tree -----------------

/**
 * A group whose points span categories (contract-legal: only subgroup→group
 * is constrained). The visible tree renders "span" under BOTH left and right,
 * each branch listing only that category's subgroups:
 *
 *   left  → span { sA: pts 0,1 } + { sD: pt 5 }    right → span { sB: pts 2,3 } + { sD: pt 6 }
 *   lone  → solo { "s C": pt 4 }                   ← spaced label (quoting probe)
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
    subgroups: { "200": "sA", "201": "sB", "202": "s C", "203": "sD" },
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

test("quoted spaced labels parse and resolve to the row the tree denotes", () => {
  // "s C" is subgroup 202 — the entry its tree row carries
  assert.deepEqual(spanKeys(`lone.solo."s C"`), ["subgroup:202"]);
  assert.deepEqual(spanKeys(`lone.solo."s C".*`), ["point:4"]);
  assert.deepEqual(spanKeys(`lone.*."s C" + left.span.sA`), ["subgroup:200", "subgroup:202"]);
  // unquoted, the space splits the term — a parse error, not a silent miss
  assert.match((parseTarget("lone.solo.s C") as ParseError).message, /joined with "\+"/);
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
  ["picks", [{ level: "subgroup", id: 100 }]],
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

test("completion stage one: a PARTIAL token settles with NO dot, at every level", () => {
  assert.deepEqual(comp("view a"), { start: 5, candidates: ["alpha"], applied: "lpha" });
  assert.deepEqual(comp("view "), { start: 5, candidates: ["alpha", "beta", "env3"], applied: "" });
  assert.deepEqual(comp("view alpha."), { start: 11, candidates: ["g-1", "g-2"], applied: "g-" });
  assert.deepEqual(comp("view beta."), { start: 10, candidates: ["g-7"], applied: "g-7" });
  assert.deepEqual(comp("view alpha.g-1."), { start: 15, candidates: ["s1", "s2"], applied: "s" });
  assert.deepEqual(comp("view alpha.g-2."), { start: 15, candidates: ["s1"], applied: "s1" });
});

test("completion stage two: an EXACT-complete descendable token appends '.' and offers the next level", () => {
  // category → its groups; group → its branch's subgroups; subgroup → its types
  assert.deepEqual(comp("view alpha"), { start: 5, candidates: ["g-1", "g-2"], applied: "." });
  assert.deepEqual(comp("view alpha.g-1"), { start: 11, candidates: ["s1", "s2"], applied: "." });
  assert.deepEqual(comp("view alpha.g-1.s1"), { start: 15, candidates: ["t2", "tH"], applied: "." });
  assert.deepEqual(comp("view beta.g-7"), { start: 10, candidates: ["s7"], applied: "." });
});

test("completion is STATELESS: the same input always yields the same result", () => {
  const a = comp("view alpha");
  const b = comp("view alpha");
  assert.deepEqual(a, b);
  const c = comp("view alpha.g-1.s1.t");
  const dd = comp("view alpha.g-1.s1.t");
  assert.deepEqual(c, dd);
});

test("completion honors the visible tree's category split of a spanning group", () => {
  // "span" renders under both left and right; each branch offers ONLY its own
  // subgroups (sD spans and shows under both)
  assert.deepEqual(compSpan("view left.span.").candidates, ["sA", "sD"]);
  assert.deepEqual(compSpan("view right.span.").candidates, ["sB", "sD"]);
  assert.deepEqual(compSpan("view *.span.").candidates, ["sA", "sB", "sD"]);
});

test("completion: the leaf never descends — an exact point-type token is TERMINAL", () => {
  assert.deepEqual(comp("view alpha.g-1.s1."), { start: 18, candidates: ["t2", "tH"], applied: "t" });
  assert.deepEqual(comp("view alpha.g-1.s2."), { start: 18, candidates: ["anchor"], applied: "anchor" });
  assert.deepEqual(comp("view alpha.g-1.s1.t").applied, "");
  assert.deepEqual(comp("view beta.g-7.s7.").candidates, ["anchor", "t9", "tH"]);
  // exact leaf: no dot, no candidates, nothing further
  assert.deepEqual(comp("view alpha.g-1.s2.anchor"), { start: 18, candidates: [], applied: "" });
  assert.deepEqual(comp("view alpha.g-1.s1.t2"), { start: 18, candidates: [], applied: "" });
});

/** Sibling-edge fixture: "sub" is BOTH an exact subgroup label AND a prefix of
 * its longer sibling "subX"; the types under "sub" repeat the shape ("tt" vs
 * "ttX"). Exact-complete descent must win over common-prefix extension. */
function makeSiblingHeader(): Header {
  return {
    version: "0.1.0", name: "sib", n_points: 3, n_frames: 1, units: "m", bbox: null,
    points: { type: ["tt", "ttX", "q"], group_id: [30, 30, 30], subgroup_id: [300, 300, 301],
      category: [0, 0, 0] },
    categories: ["c"], groups: { "30": "g" }, subgroups: { "300": "sub", "301": "subX" },
    edges: [], polylines: [], channels: [],
  };
}
const sibHeader = makeSiblingHeader();
const sibHier = new Hierarchy(sibHeader);
const sibTree = buildTree(sibHeader);
function compSib(text: string) {
  return completeTarget(text, text.length, sibTree, sibHier, sibHeader.points.type, none, VERBS);
}

test("the sibling edge: an exact token descends even with longer siblings present", () => {
  // "sub" is exact AND a prefix of "subX" — Tab descends into "sub"
  assert.deepEqual(compSib("view c.g.sub"), { start: 9, candidates: ["tt", "ttX"], applied: "." });
  assert.deepEqual(compSib("view c.g.subX"), { start: 9, candidates: ["q"], applied: "." });
  // a PARTIAL token still settles by common prefix (list, no dot)
  assert.deepEqual(compSib("view c.g.su"), { start: 9, candidates: ["sub", "subX"], applied: "b" });
  // at the LEAF the same shape is terminal: exact "tt" does nothing, despite "ttX"
  assert.deepEqual(compSib("view c.g.sub.tt"), { start: 13, candidates: [], applied: "" });
});

test("completion: @ completes committed-selection names", () => {
  assert.deepEqual(comp("view @").candidates, ["my picks", "picks", "sol2", "solvent"]);
  assert.deepEqual(comp("view @sol"), { start: 6, candidates: ["sol2", "solvent"], applied: "" });
  assert.deepEqual(comp("view @solv"), { start: 6, candidates: ["solvent"], applied: "ent" });
});

test("completion: after + a fresh term begins (path or @)", () => {
  assert.deepEqual(comp("view alpha + ").candidates, ["alpha", "beta", "env3"]);
  assert.deepEqual(comp("view alpha + e"), { start: 13, candidates: ["env3"], applied: "nv3" });
  assert.deepEqual(comp("view alpha + env3"), { start: 13, candidates: ["bath"], applied: "." });
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

test("completion: #-prefixed tokens are inert (indices aren't enumerable)", () => {
  assert.deepEqual(comp("view #"), { start: 5, candidates: [], applied: "" });
  assert.deepEqual(comp("view #16").candidates, []);
  assert.deepEqual(comp("view alpha.g-1.s1.#1").candidates, []);
});

test("an exact @name token is descendable: second Tab appends '.' + the filter pool", () => {
  // stage one: a partial name settles with NO dot
  assert.deepEqual(comp("view @solv"), { start: 6, candidates: ["solvent"], applied: "ent" });
  // stage two: the exact name descends into its filter level
  assert.deepEqual(comp("view @solvent"),
    { start: 6, candidates: ["bath", "env3", "w", "w1", "w2"], applied: "." });
  assert.deepEqual(comp("view @picks"),
    { start: 6, candidates: ["alpha", "g-1", "s1", "t2", "tH"], applied: "." });
  // stateless: same input, same result
  assert.deepEqual(comp("view @solvent"), comp("view @solvent"));
  // a partial with several names still settles (no dot)
  assert.deepEqual(comp("view @sol").candidates, ["sol2", "solvent"]);
  assert.equal(comp("view @sol").applied, "");
  // unknown exact-looking name: plain name completion (here: no candidates)
  assert.deepEqual(comp("view @nope").candidates, []);
});

test("completion after @name. merges the selection's types AND ancestor labels", () => {
  // picks = subgroup 100 (points 0,1): types tH,t2 under s1 / g-1 / alpha
  assert.deepEqual(comp("view @picks."),
    { start: 12, candidates: ["alpha", "g-1", "s1", "t2", "tH"], applied: "" });
  assert.deepEqual(comp("view @picks.t").candidates, ["t2", "tH"]);
  // solvent = category 2 (points 8-11): type w under w1,w2 / bath / env3
  assert.deepEqual(comp("view @solvent.").candidates, ["bath", "env3", "w", "w1", "w2"]);
  assert.deepEqual(comp("view @solvent.w").candidates, ["w", "w1", "w2"]);
  assert.deepEqual(comp(`view @"my picks".`).candidates, ["alpha", "g-1", "s1", "t2", "tH"]);
  assert.deepEqual(comp("view @picks.#1").candidates, []); // # stays inert
  assert.deepEqual(comp("view @nope.").candidates, []); // unknown selection
  assert.deepEqual(comp("view @picks.x.").candidates, []); // no second level
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
  assert.deepEqual(r, { start: 5, candidates: ["alpha"], applied: "lpha" });
});

// -- splitTrailingName: the mutating verbs' [name] argument ---------------------------

test("splitTrailingName: trailing [name] is the literal name; absent → null", () => {
  assert.deepEqual(splitTrailingName("alpha.g-1 [my sel]"), { expr: "alpha.g-1", name: "my sel" });
  assert.deepEqual(splitTrailingName("alpha.g-1"), { expr: "alpha.g-1", name: null });
  assert.deepEqual(splitTrailingName("alpha [x]  "), { expr: "alpha", name: "x" });
  // grammar tokens inside the brackets are LITERAL name characters
  assert.deepEqual(splitTrailingName("alpha [a+b.c #5 @x]"), { expr: "alpha", name: "a+b.c #5 @x" });
});

test("splitTrailingName: malformed names are parse errors; expr keeps [ ] reserved", () => {
  assert.equal((splitTrailingName("alpha []") as ParseError).kind, "error");
  assert.match((splitTrailingName("alpha [  ]") as ParseError).message, /empty selection name/);
  assert.match((splitTrailingName("alpha ]") as ParseError).message, /unbalanced "\]"/);
  // no trailing bracket → the whole string is the expr, and [ ] inside it
  // still hit the grammar's reserved-character error downstream
  const s = splitTrailingName("a[b]c") as { expr: string; name: string | null };
  assert.deepEqual(s, { expr: "a[b]c", name: null });
  assert.match(parseErr(s.expr), /reserved character "\["/);
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
