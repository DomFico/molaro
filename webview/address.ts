/**
 * Address grammar v1 — the textual way to NAME a set of nodes in the fixed
 * four-level tree (category → group → subgroup → point). The command layer
 * (webview/commands.ts) feeds verb arguments through here.
 *
 *   target-expr := term ("+" term)*             union across subtrees
 *   term        := path | at-term | index-term
 *   at-term     := "@" name ("." leaf-pred)?    @name = a committed selection,
 *                                               optionally FILTERED by ONE
 *                                               leaf predicate (a "," list)
 *   index-term  := "#" index-spec ("," "#" index-spec)*
 *   index-spec  := INT | INT "-" INT            the CONTRACT POINT INDEX
 *   path        := segment ("." segment)*       1–4 segments, top-down;
 *                                               segment COUNT = target level
 *   segment     := predicate ("," predicate)*   list = union within the parent
 *   predicate   := "*" | glob | range | literal | "#" index-spec (leaf only)
 *   range       := INT "-" INT                  trailing integer in [lo, hi]
 *
 * `#N` addresses points by their contract index — the one always-unique axis
 * — so it is inherently point-level: legal only as a standalone term
 * (`#161`, `#156-187`, unconditional) or as a predicate in a path's FINAL
 * (4th) segment, where it INTERSECTS the scope (`cat.grp.sub.#161` matches
 * only if point 161 lies under that subgroup — a containment check). A `#`
 * in segments 1–3 is a parse error. The bare range `44-55` keeps its label
 * trailing-integer meaning; the `#` is the sole distinguisher. Out-of-range
 * indices resolve to nothing (nomatch), not an error.
 *
 * `@name.<leaf-pred>` filters a committed selection: the selection's resolved
 * POINT SET intersected with one leaf predicate (index, #-range, literal,
 * glob, or a "," list of those — the exact predicates a path's leaf accepts).
 * The predicate matches ANYWHERE on a point's identity: its leaf type token
 * OR its subgroup / group / category label — multi-level hits union (broad by
 * design; refine by typing a narrower predicate). A committed selection is a
 * FLAT set with no sub-levels, so this is an intersection, never a positional
 * descent; `@name.a.b` is a parse error. The trailing predicate binds tighter
 * than `+` — `@a.H + @b.O` is two independently filtered terms unioned.
 * RESERVED: `:` inside a filter predicate is a parse error, keeping the
 * syntax free for a future explicit level qualifier (`@sel.<level>:<pred>`).
 *
 * Matching is SCOPED RECURSIVE DESCENT over the VISIBLE TREE — the same
 * `classification.ts buildTree` model the bottom panel renders — so a path
 * resolves to exactly the entries that clicking the corresponding rows would
 * produce (parity by construction). A group with points in several categories
 * is rendered under EACH of them with only that category's subgroups; descent
 * follows that: `cat.group.*` stays inside `cat`'s branch. A path that
 * TERMINATES at a group yields the bare group entry — precisely what clicking
 * that row selects (the whole group, even where it also appears under other
 * categories; Entry carries no category, and neither does the row's click).
 * Levels 1–3 match against the node's label; level 4 matches the point's
 * `type` string over the subgroup's drilled point rows. All matching is
 * case-sensitive. A k-segment path yields entries at level k — it never
 * auto-descends.
 *
 * Reserved for later syntax (clear parse errors today, so adding them can't
 * change the meaning of existing expressions): `[`, `]`, `?`, and the empty
 * segment (`..`, leading or trailing `.`). Quoted strings (`"…"`) are exact
 * literals — `*` inside quotes is not a glob; unbalanced quotes are errors.
 *
 * `completeTarget` is resolution's inverse: it walks the same descent to the
 * cursor's scope and enumerates the labels one level down (Tab completion).
 *
 * Pure — no DOM, no Three.js; unit-tested in Node (tests/address.test.ts).
 */
import type { CategoryNode, GroupNode, SubgroupNode, TreeModel } from "./classification.ts";
import { entryKey, type Entry, type Hierarchy } from "./sets.ts";

export type Predicate =
  | { kind: "star" }
  | { kind: "literal"; value: string }
  | { kind: "glob"; pattern: string }
  | { kind: "range"; lo: number; hi: number }
  | { kind: "index"; lo: number; hi: number }; // "#N" / "#lo-hi" — leaf only

export interface Segment {
  predicates: Predicate[];
}

export type Term =
  | { kind: "path"; segments: Segment[] }
  | { kind: "ref"; name: string; filter?: Segment } // "@name" / "@name.<leaf-pred>"
  | { kind: "points"; specs: { lo: number; hi: number }[] }; // standalone "#…"

export interface TargetAst {
  kind: "target";
  terms: Term[];
}

export interface ParseError {
  kind: "error";
  message: string;
}

/**
 * Split a mutating verb's argument into `<target-expr>` and an optional
 * trailing `[name]`. In this TRAILING position, `[ ]` are the name delimiter
 * — the bracketed text is the literal selection name, so grammar tokens
 * inside it (`.` `+` `#` `@` spaces) carry no meaning. Inside the target
 * expression itself `[ ]` stay reserved (parseTarget errors on them), so the
 * old reservation still holds everywhere except this one argument slot.
 * Total — malformed input returns a ParseError, never throws.
 */
export function splitTrailingName(
  args: string,
): { expr: string; name: string | null } | ParseError {
  const trimmed = args.trimEnd();
  if (!trimmed.endsWith("]")) return { expr: trimmed, name: null };
  const open = trimmed.lastIndexOf("[");
  if (open < 0) {
    return { kind: "error", message: `unbalanced "]" — a selection name is written [like this]` };
  }
  const name = trimmed.slice(open + 1, -1).trim();
  if (name === "") {
    return { kind: "error", message: "empty selection name — [ ] must contain a name" };
  }
  return { expr: trimmed.slice(0, open).trim(), name };
}

/** Parse a target expression. Total — malformed input returns a ParseError,
 * never throws. */
export function parseTarget(expr: string): TargetAst | ParseError {
  try {
    return new Parser(expr).parse();
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Internal parse failure — caught by parseTarget and returned as ParseError. */
class Failure extends Error {}

const RESERVED = new Set(["[", "]", "?"]);
const PLACEMENT_MSG =
  `"#" addresses points — valid only as a standalone term or in a path's final (4th) segment`;

class Parser {
  private readonly s: string;
  private i = 0;

  constructor(s: string) {
    this.s = s;
  }

  parse(): TargetAst {
    this.ws();
    if (this.i >= this.s.length) throw new Failure("empty target expression");
    if (this.s[this.i] === "+") throw new Failure(`expected a term before "+"`);
    const terms: Term[] = [this.term()];
    this.ws();
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c !== "+") {
        if (RESERVED.has(c)) throw new Failure(`reserved character "${c}"`);
        throw new Failure(`unexpected "${c}" — terms are joined with "+"`);
      }
      this.i++;
      this.ws();
      if (this.i >= this.s.length) throw new Failure(`expected a term after "+"`);
      terms.push(this.term());
      this.ws();
    }
    return { kind: "target", terms };
  }

  private term(): Term {
    if (this.s[this.i] === "@") {
      this.i++;
      const name = this.s[this.i] === '"' ? this.quoted() : this.token();
      if (name === "") throw new Failure(`expected a selection name after "@"`);
      let filter: Segment | undefined;
      if (this.s[this.i] === ".") {
        this.i++;
        const filterStart = this.i;
        filter = this.segment(4); // leaf-level predicates only ("#" included)
        if (this.s.slice(filterStart, this.i).includes(":")) {
          // reserved for a future explicit field pin (@sel.<level>:<pred>)
          throw new Failure(`level qualifiers (":") are not yet supported in @name filters`);
        }
        if (this.s[this.i] === ".") {
          throw new Failure(
            `@name accepts at most one leaf predicate — a committed selection has no sub-levels`,
          );
        }
      }
      const c = this.s[this.i];
      if (this.i < this.s.length && c !== "+" && !/\s/.test(c)) {
        throw new Failure(`unexpected "${c}" after "@${name}"`);
      }
      return filter ? { kind: "ref", name, filter } : { kind: "ref", name };
    }
    if (this.s[this.i] === "#") {
      // standalone index term: "#N" / "#lo-hi", optionally a "#"-only list
      const specs = [this.indexSpec()];
      while (this.s[this.i] === ",") {
        this.i++;
        if (this.s[this.i] !== "#") {
          throw new Failure(`expected "#" to start each index in the list`);
        }
        specs.push(this.indexSpec());
      }
      if (this.s[this.i] === ".") throw new Failure(PLACEMENT_MSG);
      return { kind: "points", specs };
    }
    const segments: Segment[] = [this.segment(1)];
    while (this.s[this.i] === ".") {
      this.i++;
      if (segments.length === 4) {
        throw new Failure("too many segments — a path has at most 4 (category.group.subgroup.point)");
      }
      segments.push(this.segment(segments.length + 1));
    }
    return { kind: "path", segments };
  }

  private segment(level: number): Segment {
    const first = this.predicate(level);
    if (!first) {
      throw new Failure(`empty segment — ".." and leading/trailing "." are not allowed`);
    }
    const predicates = [first];
    while (this.s[this.i] === ",") {
      this.i++;
      const p = this.predicate(level);
      if (!p) throw new Failure(`empty predicate in a "," list`);
      predicates.push(p);
    }
    return { predicates };
  }

  /** One predicate, or null when the input yields no token here (the caller
   * knows whether that means an empty segment or an empty list element). */
  private predicate(level: number): Predicate | null {
    if (this.s[this.i] === '"') return { kind: "literal", value: this.quoted() };
    if (this.s[this.i] === "#") {
      // "#" is point-level by nature; enforce the placement rule here
      if (level !== 4) throw new Failure(PLACEMENT_MSG);
      const spec = this.indexSpec();
      return { kind: "index", lo: spec.lo, hi: spec.hi };
    }
    const tok = this.token();
    if (tok === "") return null;
    if (tok === "*") return { kind: "star" };
    const range = /^(\d+)-(\d+)$/.exec(tok);
    if (range) return { kind: "range", lo: Number(range[1]), hi: Number(range[2]) };
    if (tok.includes("*")) return { kind: "glob", pattern: tok };
    return { kind: "literal", value: tok };
  }

  /** "#" INT ("-" INT)? — the point-index specifier. */
  private indexSpec(): { lo: number; hi: number } {
    this.i++; // the "#"
    const lo = this.integer(`expected an integer after "#"`);
    let hi = lo;
    if (this.s[this.i] === "-") {
      this.i++;
      hi = this.integer(`expected an integer after "-" in a "#" range`);
    }
    const c = this.s[this.i];
    if (this.i < this.s.length && c !== "." && c !== "," && c !== "+" && !/\s/.test(c)) {
      throw new Failure(`unexpected "${c}" after a "#" index`);
    }
    return { lo, hi };
  }

  private integer(missingMsg: string): number {
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i] >= "0" && this.s[this.i] <= "9") this.i++;
    if (this.i === start) throw new Failure(missingMsg);
    return Number(this.s.slice(start, this.i));
  }

  private token(): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (RESERVED.has(c)) throw new Failure(`reserved character "${c}"`);
      if (c === '"' && this.i > start) {
        throw new Failure("unexpected quote — quotes must wrap a whole predicate");
      }
      if (c === "#") {
        throw new Failure(`"#" must start an index specifier like "#161" (quote a label containing "#")`);
      }
      if (c === "." || c === "," || c === "+" || c === '"' || /\s/.test(c)) break;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  private quoted(): string {
    this.i++; // opening quote
    const start = this.i;
    while (this.i < this.s.length && this.s[this.i] !== '"') this.i++;
    if (this.i >= this.s.length) throw new Failure("unbalanced quote");
    const value = this.s.slice(start, this.i);
    this.i++; // closing quote
    const c = this.s[this.i];
    if (this.i < this.s.length && c !== "." && c !== "," && c !== "+" && !/\s/.test(c)) {
      throw new Failure(`unexpected "${c}" after a quoted string`);
    }
    return value;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an AST to a deduplicated Entry[] against the VISIBLE tree.
 *
 * - `tree` is the `buildTree` model the bottom panel renders — descending it
 *   (rather than any independent parent map) is what guarantees a resolved
 *   path equals the rows a user would click, including category-spanning
 *   groups/subgroups, which the tree renders once per category branch with
 *   only that branch's children.
 * - `hierarchy` supplies the drilled point rows of a subgroup (the same
 *   accessor the tree's drill-to-points uses).
 * - `types` is the header's per-point `type` array (the level-4 match string).
 * - `committedNames` maps committed-selection names to their STORED entries
 *   (returned at their stored levels; an unknown name resolves to nothing —
 *   an empty match is not an error).
 */
export function resolveTarget(
  ast: TargetAst,
  tree: TreeModel,
  hierarchy: Hierarchy,
  types: readonly string[],
  committedNames: ReadonlyMap<string, readonly Entry[]>,
): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();
  const add = (e: Entry): void => {
    const k = entryKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  };
  for (const term of ast.terms) {
    if (term.kind === "ref") {
      const stored = committedNames.get(term.name) ?? [];
      if (!term.filter) {
        for (const e of stored) add(e);
        continue;
      }
      // "@name.<leaf-pred>": INTERSECT the selection's resolved point set
      // with one leaf predicate, matched ANYWHERE on each point's identity —
      // its leaf type OR its subgroup / group / category label (a point hits
      // if any field matches; multi-level hits union, deliberately broad).
      // Unlike path resolution — where segment count sets the entry level —
      // the result here is ALWAYS point-level: a set of points reduced to a
      // subset of points. The stored entries' own levels are deliberately
      // not preserved. "#" predicates match the point index, as everywhere.
      const inSel = new Set<number>();
      for (const e of stored) for (const p of hierarchy.pointsOf(e)) inSel.add(p);
      const filter = term.filter;
      const labelsBySub = new Map<number, string[]>(); // ancestor labels, cached per subgroup
      const identityLabels = (p: number): string[] => {
        const sid = hierarchy.subgroupOfPoint(p);
        let labels = labelsBySub.get(sid);
        if (!labels) {
          labels = [hierarchy.label({ level: "subgroup", id: sid })];
          const a = hierarchy.ancestorsOfSubgroup(sid);
          if (a) {
            labels.push(hierarchy.label({ level: "group", id: a.group }));
            labels.push(hierarchy.label({ level: "category", id: a.category }));
          }
          labelsBySub.set(sid, labels);
        }
        return labels;
      };
      for (const p of inSel) {
        const hit = filter.predicates.some((pr) =>
          pr.kind === "index"
            ? p >= pr.lo && p <= pr.hi
            : predicateMatches(pr, types[p] ?? "") ||
              identityLabels(p).some((l) => predicateMatches(pr, l)),
        );
        if (hit) add({ level: "point", id: p });
      }
      continue;
    }
    if (term.kind === "points") {
      // standalone "#…": unconditional point entries, clamped to the contract
      // range — a well-formed but out-of-range index is an empty match
      for (const spec of term.specs) {
        const hi = Math.min(spec.hi, hierarchy.n - 1);
        for (let p = Math.max(0, spec.lo); p <= hi; p++) add({ level: "point", id: p });
      }
      continue;
    }
    const segs = term.segments;
    const cats = catsMatching(segs[0], tree);
    if (segs.length === 1) {
      for (const c of cats) add({ level: "category", id: c.categoryIndex });
      continue;
    }
    // level 2: the group nodes rendered under each matched category branch
    // (a spanning group appears once per category; a path ENDING here yields
    // the bare group entry — the same entry clicking that row creates)
    const groups = groupsMatching(segs[1], cats);
    if (segs.length === 2) {
      for (const g of groups) add({ level: "group", id: g.groupId });
      continue;
    }
    // level 3: the subgroup rows of those category-scoped branches only —
    // descent PAST a group never leaves the category it was reached through
    const subs = subgroupsMatching(segs[2], groups);
    if (segs.length === 3) {
      for (const s of subs) add({ level: "subgroup", id: s.subgroupId });
      continue;
    }
    // level 4: the subgroup's drilled point rows — type predicates match the
    // type string; "#" predicates match the point index, INTERSECTED with the
    // scope (an out-of-scope index simply doesn't match)
    for (const s of subs) {
      for (const p of hierarchy.subgroupPoints(s.subgroupId)) {
        if (leafHit(segs[3], p, types[p] ?? "")) add({ level: "point", id: p });
      }
    }
  }
  return out;
}

// The one scoped descent, shared by resolution and completion so the two can
// never disagree about what sits under a partially-specified path.
function catsMatching(seg: Segment, tree: TreeModel): CategoryNode[] {
  return tree.categories.filter((c) => segmentMatches(seg, c.label));
}
function groupsMatching(seg: Segment, cats: CategoryNode[]): GroupNode[] {
  const out: GroupNode[] = [];
  for (const c of cats) for (const g of c.groups) if (segmentMatches(seg, g.label)) out.push(g);
  return out;
}
function subgroupsMatching(seg: Segment, groups: GroupNode[]): SubgroupNode[] {
  const out: SubgroupNode[] = [];
  for (const g of groups) for (const s of g.subgroups) if (segmentMatches(seg, s.label)) out.push(s);
  return out;
}

// ---------------------------------------------------------------------------
// Completion — the inverse of resolution over the SAME scoped descent
// ---------------------------------------------------------------------------

export interface Completion {
  /** Index in `text` where the token under the cursor begins. */
  start: number;
  /** Sorted, distinct candidates whose literal prefix is the current token. */
  candidates: string[];
  /** The string to INSERT at the cursor: the unique completion (plus "." after
   * a category/group, " " after a verb) or the common-prefix extension. */
  applied: string;
}

/** Token characters end at these; the scan-back from the cursor stops here. */
const TOKEN_DELIMS = new Set([".", ",", "+", "@", '"']);

/**
 * Complete the token under `cursor` in a partial command line. Total — junk
 * or malformed prefixes yield empty candidates, never a throw.
 *
 * Positions: at line start it completes VERBS (caller supplies the registry's
 * names; a unique match also appends a space); inside a path it completes the
 * labels one level below the already-typed segments, resolved by the same
 * category-scoped descent `resolveTarget` performs over the visible tree
 * (completing `cat.group.` offers only that branch's subgroups); at the leaf
 * it offers the distinct point-type tokens under the scoped subgroups; after
 * `@` the committed-selection names; after `@name.` the distinct type tokens
 * of THAT selection's point set; after `+` a fresh term. A unique
 * category/group completion appends "." so tabbing flows down levels; leaf,
 * subgroup, and name completions append nothing.
 *
 * No-ops (empty candidates): a token containing `*` (glob in progress), a
 * token that IS a range in progress (`\d+-\d*` — a dash inside an ordinary
 * label like "group-0" still completes; only numeric range syntax opts out),
 * reserved characters, quotes, and anything whose structural prefix doesn't
 * parse. Only `text[0..cursor)` is considered.
 */
export function completeTarget(
  text: string,
  cursor: number,
  tree: TreeModel,
  hierarchy: Hierarchy,
  types: readonly string[],
  committedNames: ReadonlyMap<string, readonly Entry[]>,
  verbs: readonly string[],
): Completion {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)));

  // the token = the maximal run of token characters ending at the cursor
  let ts = head.length;
  while (ts > 0 && !TOKEN_DELIMS.has(head[ts - 1]) && !/\s/.test(head[ts - 1])) ts--;
  const token = head.slice(ts);
  const none: Completion = { start: ts, candidates: [], applied: "" };

  // pattern-in-progress → completion opts out (globs, numeric ranges, junk),
  // and "#" indices are an unbounded integer space — nothing to enumerate
  if (/[*[\]?"#]/.test(token)) return none;
  if (/^\d+-\d*$/.test(token)) return none;

  const before = head.slice(0, ts);

  // verb position: nothing but whitespace before the token
  if (/^\s*$/.test(before)) return finish(ts, token, verbs, " ");

  // @name: the token hangs directly off an "@"
  if (before.endsWith("@")) return finish(ts, token, committedNames.keys(), "");

  // current term = after the last "+" (or after the verb); the structural
  // prefix before the token must be empty or end at a "." / "," boundary
  const plusAt = before.lastIndexOf("+");
  let termBefore: string;
  if (plusAt >= 0) {
    termBefore = before.slice(plusAt + 1);
  } else {
    const m = /^\s*\S+\s+([\s\S]*)$/.exec(before);
    if (!m) return none;
    termBefore = m[1];
  }
  termBefore = termBefore.trim();

  // "@name." → the selection's OWN identity tokens: the distinct types AND
  // the distinct subgroup/group/category labels represented among its points
  // (match-anywhere completion, scoped to the selection — never the global
  // label space). Anything deeper or malformed after "@" is inert.
  if (termBefore.startsWith("@")) {
    if (!termBefore.endsWith(".")) return none;
    const nameText = termBefore.slice(1, -1);
    let selName: string | null = null;
    if (/^"[^"]*"$/.test(nameText)) selName = nameText.slice(1, -1);
    else if (!/[."]/.test(nameText)) selName = nameText;
    if (selName === null) return none; // a second level, or junk
    const stored = committedNames.get(selName);
    if (!stored) return none;
    const pool: string[] = [];
    const seenPts = new Set<number>();
    const seenSubs = new Set<number>();
    for (const e of stored) {
      for (const p of hierarchy.pointsOf(e)) {
        if (seenPts.has(p)) continue;
        seenPts.add(p);
        const t = types[p];
        if (t) pool.push(t);
        const sid = hierarchy.subgroupOfPoint(p);
        if (seenSubs.has(sid)) continue;
        seenSubs.add(sid);
        pool.push(hierarchy.label({ level: "subgroup", id: sid }));
        const a = hierarchy.ancestorsOfSubgroup(sid);
        if (a) {
          pool.push(hierarchy.label({ level: "group", id: a.group }));
          pool.push(hierarchy.label({ level: "category", id: a.category }));
        }
      }
    }
    return finish(ts, token, pool, "");
  }

  if (/[@"\s]/.test(termBefore)) return none; // refs/quotes/spaces → not a completable path

  // completed segments = everything before the segment the token belongs to
  let completed: string[];
  if (termBefore === "") {
    completed = [];
  } else if (termBefore.endsWith(".")) {
    completed = termBefore.slice(0, -1).split(".");
  } else if (termBefore.endsWith(",")) {
    completed = termBefore.slice(0, -1).split(".").slice(0, -1); // list continues the same segment
  } else {
    return none; // a finished token with no separator — malformed position
  }
  const k = completed.length;
  if (k > 3) return none; // nothing below the leaf level

  if (k === 0) return finish(ts, token, tree.categories.map((c) => c.label), ".");

  const parsed = parseTarget(completed.join("."));
  if (parsed.kind === "error" || parsed.terms[0].kind !== "path") return none;
  const segs = parsed.terms[0].segments;

  const cats = catsMatching(segs[0], tree);
  if (k === 1) {
    return finish(ts, token, cats.flatMap((c) => c.groups.map((g) => g.label)), ".");
  }
  const groups = groupsMatching(segs[1], cats);
  if (k === 2) {
    return finish(ts, token, groups.flatMap((g) => g.subgroups.map((s) => s.label)), "");
  }
  const subs = subgroupsMatching(segs[2], groups);
  const leafTypes: string[] = [];
  for (const s of subs) {
    for (const p of hierarchy.subgroupPoints(s.subgroupId)) {
      const t = types[p];
      if (t) leafTypes.push(t);
    }
  }
  return finish(ts, token, leafTypes, "");
}

function finish(
  start: number,
  token: string,
  pool: Iterable<string>,
  uniqueSuffix: string,
): Completion {
  const candidates = [...new Set(pool)].filter((c) => c.startsWith(token)).sort();
  if (candidates.length === 0) return { start, candidates, applied: "" };
  if (candidates.length === 1) {
    return { start, candidates, applied: candidates[0].slice(token.length) + uniqueSuffix };
  }
  let common = candidates[0];
  for (const c of candidates) {
    let i = 0;
    while (i < common.length && i < c.length && common[i] === c[i]) i++;
    common = common.slice(0, i);
  }
  return { start, candidates, applied: common.slice(token.length) };
}

function segmentMatches(seg: Segment, name: string): boolean {
  return seg.predicates.some((p) => predicateMatches(p, name));
}

/** Leaf matching, shared by path leaves and @name filters: "#" predicates
 * match the point INDEX, everything else the opaque type string. */
function leafHit(seg: Segment, pointId: number, typeName: string): boolean {
  return seg.predicates.some((pr) =>
    pr.kind === "index" ? pointId >= pr.lo && pointId <= pr.hi : predicateMatches(pr, typeName),
  );
}

export function predicateMatches(p: Predicate, name: string): boolean {
  switch (p.kind) {
    case "star":
      return true;
    case "literal":
      return name === p.value;
    case "glob":
      return globMatch(p.pattern, name);
    case "range": {
      const n = trailingInt(name);
      return n !== null && n >= p.lo && n <= p.hi;
    }
    case "index":
      // "#" matches point INDICES, never labels; the parser confines it to
      // the leaf, where resolution handles it against the index directly
      return false;
  }
}

/** `*` matches any run of characters, including the empty one. Case-sensitive. */
export function globMatch(pattern: string, text: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  if (!text.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  for (let k = 1; k < parts.length - 1; k++) {
    const at = text.indexOf(parts[k], pos);
    if (at < 0) return false;
    pos = at + parts[k].length;
  }
  const last = parts[parts.length - 1];
  return text.length - pos >= last.length && text.endsWith(last);
}

function trailingInt(name: string): number | null {
  const m = /(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}
