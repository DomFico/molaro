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
  splitLeadingRef,
  splitOnUnquoted,
  splitTrailingName,
  splitTrailingWord,
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

test("REVERSED: @sel.#N matches only STORED point members — no reach inside", () => {
  // mix stores subgroup:100 (points 0,1) and point:5 — only #5 is a MEMBER
  assert.deepEqual(keys("@mix.#5", FNAMES), ["point:5"]);
  assert.deepEqual(keys("@mix.#1", FNAMES), [],
    "an index INSIDE the coarse member is not a member — nomatch, no exception");
  assert.deepEqual(keys("@mix.#7", FNAMES), []);
  assert.deepEqual(keys("@mix.#0-9", FNAMES), ["point:5"]); // stored point members in range
});

test("REVERSED: @sel.<pred> matches stored members at their OWN levels", () => {
  // point members match on their TYPE; label members on their LABEL
  assert.deepEqual(keys("@mix.tH", FNAMES), ["point:5"]); // point 0 is NOT a member
  assert.deepEqual(keys("@mix.t*", FNAMES), ["point:5"]);
  assert.deepEqual(keys("@mix.t2", FNAMES), [], "type inside the coarse member: nomatch");
  assert.deepEqual(keys("@mix.s1", FNAMES), ["subgroup:100"]); // the member's own label
  assert.deepEqual(keys(`@mix."s1"`, FNAMES), ["subgroup:100"]);
  assert.deepEqual(keys("@mix.s*", FNAMES), ["subgroup:100"]);
  assert.deepEqual(keys("@env.env3", FNAMES), ["category:2"]); // its one member's label
  assert.deepEqual(keys("@env.w", FNAMES), [], "descendant TYPE: nomatch");
});

test("REVERSED: ancestry never matches — descendant/ancestor tokens nomatch", () => {
  // the old match-anywhere rule reached into a member's ancestry; now the
  // filter sees MEMBERSHIP only (consistency principle 1)
  assert.deepEqual(keys("@mix.g-7", FNAMES), [], "a member's GROUP label: nomatch");
  assert.deepEqual(keys("@mix.alpha", FNAMES), [], "a member's CATEGORY label: nomatch");
  assert.deepEqual(keys("@mix.beta", FNAMES), []);
  assert.deepEqual(keys("@mix.g-*", FNAMES), []);
  assert.deepEqual(keys("@env.w1", FNAMES), [], "a SUBGROUP under the category member: nomatch");
  assert.deepEqual(keys("@env.bath", FNAMES), [], "the GROUP under the category member: nomatch");
  // the route to finer granularity: commit a finer selection whose members
  // ARE the fine entries — then the same tokens match as member labels
  const fine = new Map<string, readonly Entry[]>([
    ["fine", [{ level: "subgroup", id: 104 }, { level: "subgroup", id: 105 }]],
  ]);
  assert.deepEqual(keys("@fine.w1", fine), ["subgroup:104"]);
  assert.deepEqual(keys("@fine.w*", fine), ["subgroup:104", "subgroup:105"]);
});

test("REVERSED: point members match on type only — labels of their ancestry don't", () => {
  const duo = new Map<string, readonly Entry[]>([
    ["duo", [{ level: "point", id: 2 }, { level: "point", id: 8 }]],
  ]);
  assert.deepEqual(keys("@duo.anchor", duo), ["point:2"]); // its own type
  assert.deepEqual(keys("@duo.w", duo), ["point:8"]);
  assert.deepEqual(keys("@duo.*a*", duo), ["point:2"]); // "anchor" only; ancestry ignored
  assert.deepEqual(keys("@duo.bath", duo), [], "p8's group label is not its membership");
});

// -- all / @all: the two everything-terms --------------------------------------------

test("bare `all` = every top-level category (everything in existence)", () => {
  assert.deepEqual(keys("all"), ["category:0", "category:1", "category:2"]);
  assert.deepEqual(keys("all + beta"), ["category:0", "category:1", "category:2"],
    "all already covers beta — union dedups");
  const ast = parseTarget("all + beta") as TargetAst;
  assert.deepEqual(ast.terms[0], { kind: "all" });
  assert.equal(ast.terms[1].kind, "path");
});

test("`all` is a KEYWORD only at a term boundary — otherwise an ordinary label", () => {
  assert.deepEqual(keys(`"all"`), [], "quoted = literal path token, no category named all");
  assert.deepEqual(keys("all.x"), [], "all.x is a PATH (no category labeled all) — not keyword+descent");
  assert.equal((parseTarget("all.x") as TargetAst).terms[0].kind, "path");
  assert.deepEqual(keys("allx"), [], "prefix does not trigger the keyword");
  assert.equal((parseTarget("allx") as TargetAst).terms[0].kind, "path");
});

test("@all = the union of every committed selection's stored entries, deduped", () => {
  const committed = new Map<string, readonly Entry[]>([
    ["picks", [{ level: "subgroup", id: 100 }, { level: "point", id: 5 }]],
    ["solvent", [{ level: "category", id: 2 }]],
    ["overlap", [{ level: "point", id: 5 }]], // stored twice across selections
  ]);
  assert.deepEqual(keys("@all", committed), ["category:2", "point:5", "subgroup:100"]);
  assert.deepEqual(keys("@all + @picks", committed), ["category:2", "point:5", "subgroup:100"]);
  assert.deepEqual(keys("@all", none), [], "no committed selections — empty match, not an error");
});

test("@all.<pred> filters the pooled membership — same membership-only rule as @name", () => {
  assert.deepEqual(keys("@all.tH", FNAMES), ["point:5"]); // mix's stored point member
  assert.deepEqual(keys("@all.s1", FNAMES), ["subgroup:100"]); // a member's own label
  assert.deepEqual(keys("@all.env3", FNAMES), ["category:2"]);
  assert.deepEqual(keys("@all.#5", FNAMES), ["point:5"]);
  assert.deepEqual(keys("@all.w1", FNAMES), [], "descendants stay out of reach under @all too");
});

// -- splitLeadingRef: the member-verbs' first-argument SHAPE ---------------------------

test("splitLeadingRef separates a lone leading @name chunk from the rest", () => {
  assert.deepEqual(splitLeadingRef("@picks alpha.g-1"),
    { kind: "ref", name: "picks", filtered: false, rest: "alpha.g-1" });
  assert.deepEqual(splitLeadingRef(`@"my picks" beta + env3`),
    { kind: "ref", name: "my picks", filtered: false, rest: "beta + env3" });
  assert.deepEqual(splitLeadingRef("  @picks  "),
    { kind: "ref", name: "picks", filtered: false, rest: "" }, "bare form: empty rest");
  assert.equal((splitLeadingRef("@picks.tH s1") as { filtered: boolean }).filtered, true,
    "a filter on the first chunk is reported, not judged (the verb words the error)");
  assert.deepEqual(splitLeadingRef("@a+@b x"), { kind: "multi" });
  assert.deepEqual(splitLeadingRef("alpha @picks"), { kind: "none" });
  assert.equal(splitLeadingRef(`@"unclosed x`).kind, "error");
});

test(':" is reserved in @name filters (future level qualifier) — paths unaffected', () => {
  assert.match(parseErr("@mix.x:y"), /level qualifiers .* not yet supported/);
  assert.match(parseErr(`@mix."x:y"`), /level qualifiers .* not yet supported/);
  // a colon inside a PATH token stays an ordinary literal character
  assert.equal(parseTarget("x:y").kind, "target");
  assert.equal(parseTarget("a.b.c.x:y").kind, "target");
});

test("REVERSED: filter results are WHOLE members at their stored levels; @sel.* ≡ @sel", () => {
  assert.deepEqual(keys("@mix.s1,#5", FNAMES), ["point:5", "subgroup:100"]); // list over members
  assert.deepEqual(keys("@mix.*", FNAMES), ["point:5", "subgroup:100"]); // all stored members
  assert.deepEqual(keys("@mix.*", FNAMES), keys("@mix", FNAMES)); // ≡ the unfiltered form
});

test("the trailing predicate binds tighter than + (two independent filters)", () => {
  const ast = parseTarget("@mix.tH + @env.env3") as TargetAst;
  assert.equal(ast.terms.length, 2);
  assert.equal((ast.terms[0] as { filter?: unknown }).filter !== undefined, true);
  assert.equal((ast.terms[1] as { filter?: unknown }).filter !== undefined, true);
  assert.deepEqual(keys("@mix.tH + @env.env3", FNAMES), ["category:2", "point:5"]);
});

test("@name.a.b is a parse error — a committed selection has no sub-levels", () => {
  assert.match(parseErr("@mix.a.b"), /at most one leaf predicate/);
  assert.match(parseErr("@mix.#1.b"), /at most one leaf predicate/);
  // the message explains the flat-set model and points at the reserved "&"
  assert.match(parseErr("@mix.a.b"), /flat set of points/);
  assert.match(parseErr("@mix.a.b"), /"&" is the intended intersection operator/);
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
  // REVERSED: #* = the STORED point-level members only (never points inside
  // a coarse member); a selection with no point members yields nothing
  assert.deepEqual(keys("@mix.#*", FNAMES), ["point:5"]);
  assert.deepEqual(keys("@env.#*", FNAMES), [], "no point members → #* is empty");
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

test("completion: @ completes committed-selection names (+ the reserved @all)", () => {
  // "all" is always in the pool — @all is the union of every committed selection
  assert.deepEqual(comp("view @").candidates, ["all", "my picks", "picks", "sol2", "solvent"]);
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
  // stage two: the exact name descends into its filter level — offering the
  // STORED MEMBERSHIP (reversed from the old ancestry pool)
  assert.deepEqual(comp("view @solvent"),
    { start: 6, candidates: ["env3"], applied: ".", kind: "filter" });
  assert.deepEqual(comp("view @picks"),
    { start: 6, candidates: ["s1"], applied: ".", kind: "filter" });
  // stateless: same input, same result
  assert.deepEqual(comp("view @solvent"), comp("view @solvent"));
  // a partial with several names still settles (no dot)
  assert.deepEqual(comp("view @sol").candidates, ["sol2", "solvent"]);
  assert.equal(comp("view @sol").applied, "");
  // unknown exact-looking name: plain name completion (here: no candidates)
  assert.deepEqual(comp("view @nope").candidates, []);
});

test("REVERSED: @name. completion offers the STORED MEMBERS, not descendants", () => {
  // picks stores ONE subgroup member (label "s1") — the pool is that member,
  // never the types/ancestor labels of the points beneath it
  assert.deepEqual(comp("view @picks."),
    { start: 12, candidates: ["s1"], applied: "s1", kind: "filter" });
  // the tag marks FILTER vocabulary; genuine tree navigation stays untagged
  assert.equal(comp("view @picks.s").kind, "filter");
  assert.equal(comp("view alpha.").kind, undefined);
  assert.equal(comp("view alpha").kind, undefined);
  assert.equal(comp("view ").kind, undefined);
  assert.deepEqual(comp("view @picks.t").candidates, [], "descendant types not offered");
  // solvent stores one category member (label "env3")
  assert.deepEqual(comp("view @solvent.").candidates, ["env3"]);
  assert.deepEqual(comp("view @solvent.w").candidates, [], "descendant labels not offered");
  assert.deepEqual(comp(`view @"my picks".`).candidates, ["s1"]);
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

// -- splitTrailingWord: `color <target> <color>`-shaped verb arguments -----------------

test("splitTrailingWord: last top-level chunk splits off; quoted spaces stay in the expr", () => {
  assert.deepEqual(splitTrailingWord("alpha green"), { expr: "alpha", word: "green" });
  assert.deepEqual(splitTrailingWord("beta.group-0.subgroup-0.t2 #ff8800"),
    { expr: "beta.group-0.subgroup-0.t2", word: "#ff8800" });
  // a quoted spaced label is ONE chunk — the split never cuts inside quotes
  assert.deepEqual(splitTrailingWord('gamma.group-2."subgroup 11" red'),
    { expr: 'gamma.group-2."subgroup 11"', word: "red" });
  assert.deepEqual(splitTrailingWord("a + b   red"), { expr: "a + b", word: "red" });
  assert.deepEqual(splitTrailingWord("  alpha   green  "), { expr: "alpha", word: "green" });
});

test("splitTrailingWord: fewer than two chunks → word null (the verb words the usage error)", () => {
  assert.deepEqual(splitTrailingWord("green"), { expr: "green", word: null });
  assert.deepEqual(splitTrailingWord(""), { expr: "", word: null });
  assert.deepEqual(splitTrailingWord("   "), { expr: "", word: null });
  // an unbalanced quote swallows to the end: one chunk, word null — the
  // grammar's own unbalanced-quote error surfaces downstream on the expr
  assert.deepEqual(splitTrailingWord('"abc def'), { expr: '"abc def', word: null });
});

// -- completion display-volume cap -----------------------------------------------------

/** 60 one-point subgroups under one branch — big enough to trip the cap. */
function makeBigHeader(): Header {
  const n = 60;
  return {
    version: "0.1.0", name: "big", n_points: n, n_frames: 1, units: "m", bbox: null,
    points: {
      type: Array.from({ length: n }, (_, i) => `k${i}`),
      group_id: Array(n).fill(500),
      subgroup_id: Array.from({ length: n }, (_, i) => 600 + i),
      category: Array(n).fill(0),
    },
    categories: ["big"], groups: { "500": "grp" },
    subgroups: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [String(600 + i), `node-${i}`]),
    ),
    edges: [], polylines: [], channels: [],
  };
}
const bigHeader = makeBigHeader();
const bigHier = new Hierarchy(bigHeader);
const bigTree = buildTree(bigHeader);
const BIGNAMES = new Map<string, readonly Entry[]>([
  // 60 subgroup MEMBERS — the membership pool itself is big enough to cap
  ["broad", Array.from({ length: 60 }, (_, i) => ({ level: "subgroup" as const, id: 600 + i }))],
]);
function compBig(text: string) {
  return completeTarget(text, text.length, bigTree, bigHier, bigHeader.points.type, BIGNAMES, VERBS);
}

test("completion cap: an oversized list prints a count-and-hint, never the pool", () => {
  // @broad. pool = its 60 stored member labels
  assert.deepEqual(compBig("view @broad."),
    { start: 12, candidates: ["60 matches", "— type to narrow"], applied: "", kind: "filter" });
  // the exact-@name descend caps its PREVIEW but keeps the descend dot
  assert.deepEqual(compBig("view @broad"),
    { start: 6, candidates: ["60 matches", "— type to narrow"], applied: ".", kind: "filter" });
  // the same one rule applies to large PATH pools — not an @ special case
  assert.deepEqual(compBig("view big.grp.").candidates, ["60 matches", "— type to narrow"]);
  assert.equal(compBig("view big.grp.").applied, "");
});

test("completion cap: a prefix narrows to a listable set; the POOL is unchanged", () => {
  const narrowed = compBig("view @broad.node-1");
  assert.equal(narrowed.candidates.length, 11); // node-1, node-10 … node-19
  assert.ok(narrowed.candidates.includes("node-13"));
  // a token the cap withheld from display still RESOLVES — display-only cap
  // (to the WHOLE member, at its stored level)
  const ast = parseTarget("@broad.node-42") as TargetAst;
  const got = resolveTarget(ast, bigTree, bigHier, bigHeader.points.type, BIGNAMES);
  assert.deepEqual(got.map((e) => `${e.level}:${e.id}`), ["subgroup:642"]);
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

// -- P-1: splitOnUnquoted — the collision-proof target/parameter boundary ---------

test("splitOnUnquoted: splits on every top-level separator; none → one part", () => {
  assert.deepEqual(splitOnUnquoted("alpha ?k=v ?j=w", "?"), ["alpha ", "k=v ", "j=w"]);
  assert.deepEqual(splitOnUnquoted("alpha.A", "?"), ["alpha.A"], "no separator → the whole string");
  assert.deepEqual(splitOnUnquoted("", "?"), [""], "empty stays one empty part");
});

test('splitOnUnquoted: a "?" inside quotes is NOT a boundary; unbalanced quote holds the tail', () => {
  // a quoted label containing '?' stays in the FIRST part (the target)
  assert.deepEqual(splitOnUnquoted('"a?b" ?k=v', "?"), ['"a?b" ', "k=v"]);
  // a value may itself be quoted to hold a '?'
  assert.deepEqual(splitOnUnquoted('t ?k="a?b"', "?"), ["t ", 'k="a?b"']);
  // an unbalanced quote leaves the rest in-quote → the '?' is not split (fails loudly downstream)
  assert.deepEqual(splitOnUnquoted('"a ?b', "?"), ['"a ?b'], "unbalanced quote: no split");
});
