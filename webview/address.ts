/**
 * Address grammar v1 — the textual way to NAME a set of nodes in the fixed
 * four-level tree (category → group → subgroup → point). The command layer
 * (webview/commands.ts) feeds verb arguments through here.
 *
 *   target-expr := term ("+" term)*             union across subtrees
 *   term        := path | at-term | index-term | "all"
 *   at-term     := "@" name ("." leaf-pred)?    @name = a committed selection,
 *                                               optionally FILTERED by ONE
 *                                               leaf predicate (a "," list)
 *
 * `all` (a whole term, exactly that token) = every point in the system —
 * the union of all top-level categories, evaluated at command time. `@all`
 * (the RESERVED name "all") = the union of every committed selection's
 * stored entries, also evaluated at command time; with no selections it
 * resolves to nothing. They are DIFFERENT sets: `all` is everything in
 * existence, `@all` everything currently committed. `all.x` / `all,x` fall
 * back to an ordinary literal (a label that happens to read "all"), and
 * `"all"` quoted is always the literal — the keyword applies only to the
 * bare, whole term. Selections cannot be created or renamed to "all".
 *   index-term  := "#" index-spec ("," "#" index-spec)*
 *   index-spec  := "*" | INT | INT "-" INT      the CONTRACT POINT INDEX
 *                                               ("#*" = every index in scope)
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
 * `@name.<leaf-pred>` filters a committed selection's STORED MEMBERSHIP: the
 * predicate (index, #-range, literal, glob, or a "," list) matches each
 * stored entry at that entry's OWN level — a member's label (levels 1–3) or
 * a point member's type/index — and NEVER descends into the ancestry of
 * points beneath a coarse member. Anything finer than the membership matches
 * nothing (nomatch): to address finer entries, commit a finer selection
 * first — depth is a property of how a selection was committed, not of the
 * filter. Matched results are the WHOLE members, at their stored levels. A
 * committed selection is flat to its members, so this is one flat filter,
 * never a positional descent; `@name.a.b` is a parse error. The trailing
 * predicate binds tighter than `+`. RESERVED: `:` inside a filter predicate
 * is a parse error, keeping the syntax free for a future qualifier.
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
  | { kind: "points"; specs: { lo: number; hi: number }[] } // standalone "#…"
  | { kind: "all" }; // the bare keyword term "all" — every point in the system

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

/** Split the LAST whitespace-delimited word (quotes respected) from a verb's
 * arguments — the shape of `color <target> <color>`-style verbs whose final
 * argument is a plain token rather than part of the target expression.
 * `word: null` when the args hold fewer than two chunks. Pure argument-SHAPE
 * parsing like splitTrailingName — the verb words its own usage errors. */
export function splitTrailingWord(args: string): { expr: string; word: string | null } {
  const s = args.trim();
  let inQuote = false;
  let prevWs = true;
  let cut = -1; // start index of the last top-level chunk
  for (let i = 0; i < s.length; i++) {
    const ws = !inQuote && /\s/.test(s[i]);
    if (!ws && prevWs) cut = i;
    if (s[i] === '"') inQuote = !inQuote;
    prevWs = ws;
  }
  if (cut <= 0) return { expr: s, word: null }; // zero or one chunk
  return { expr: s.slice(0, cut).trim(), word: s.slice(cut) };
}

/** The shape of a member-mutation verb's FIRST argument (add/remove take
 * exactly one lone committed-selection reference before their expression). */
export type LeadingRef =
  | { kind: "ref"; name: string; filtered: boolean; rest: string }
  | { kind: "none" } // the args don't start with an @ reference
  | { kind: "multi" } // "@a+@b …" — more than one term in the first chunk
  | { kind: "error"; message: string };

/** Split a leading whitespace-delimited `@name` chunk (quotes respected)
 * from the rest of a verb's arguments. Pure argument-SHAPE parsing — the
 * verb decides what each shape means and words its own usage errors. */
export function splitLeadingRef(args: string): LeadingRef {
  const s = args.trimStart();
  if (s[0] !== "@") return { kind: "none" };
  let i = 0;
  let inQuote = false;
  while (i < s.length && (inQuote || !/\s/.test(s[i]))) {
    if (s[i] === '"') inQuote = !inQuote;
    i++;
  }
  const ast = parseTarget(s.slice(0, i));
  if (ast.kind === "error") return { kind: "error", message: ast.message };
  if (ast.terms.length !== 1) return { kind: "multi" };
  const t = ast.terms[0];
  if (t.kind !== "ref") return { kind: "none" };
  return { kind: "ref", name: t.name, filtered: t.filter !== undefined, rest: s.slice(i).trim() };
}

/** Split `s` on every TOP-LEVEL (unquoted) occurrence of a single-character
 * separator, respecting `"…"` regions exactly as the grammar's `quoted()` does:
 * a `"` toggles quote state, there is no escape, so `"` is the only delimiter. A
 * `sep` inside quotes is NOT a split point. Parts are returned untrimmed.
 *
 * The mod-invocation parameter split leans on this with sep `?`: `?` is a
 * RESERVED grammar char (`RESERVED`, `token()` throws on it, `parseTarget`
 * rejects it between terms and after `@`/`#`), so it can NEVER appear unquoted in
 * a legal target. The first unquoted `?` is therefore a collision-proof boundary
 * between the target expression and the parameter block — no heuristic, no
 * guessing where the target ends. An unbalanced quote leaves the tail in-quote so
 * a `?` inside it is (correctly) not a split; the malformed target then fails
 * loudly in `parseTarget`, never mis-split here. See reports/MOD_PARAMS_PHASE0.md. */
export function splitOnUnquoted(s: string, sep: string): string[] {
  const parts: string[] = [];
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inQuote = !inQuote;
    else if (!inQuote && s[i] === sep) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
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
            `@name accepts at most one leaf predicate — a selection is a flat set of points ` +
              `(one filter, no path descent); combining conditions is not yet expressible ` +
              `("&" is the intended intersection operator)`,
          );
        }
      }
      const c = this.s[this.i];
      if (this.i < this.s.length && c !== "+" && !/\s/.test(c)) {
        throw new Failure(`unexpected "${c}" after "@${name}"`);
      }
      return filter ? { kind: "ref", name, filter } : { kind: "ref", name };
    }
    // the bare keyword term "all" — only when it IS the whole term (a
    // following "." or "," demotes it to an ordinary literal segment, and
    // the quoted form "\"all\"" is always the literal)
    if (this.s.startsWith("all", this.i)) {
      const after = this.s[this.i + 3];
      if (after === undefined || after === "+" || /\s/.test(after)) {
        this.i += 3;
        return { kind: "all" };
      }
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

  /** "#" ("*" | INT ("-" INT)?) — the point-index specifier. */
  private indexSpec(): { lo: number; hi: number } {
    this.i++; // the "#"
    if (this.s[this.i] === "*") {
      // "#*" — the all-indices wildcard (resolution clamps to n_points).
      // Deliberately REDUNDANT: standalone #* ≡ * and @name.#* ≡ @name in
      // point terms — its value is a consistent "every index" spelling on
      // the # axis (removing the *-works-but-#*-errors papercut), not new
      // expressive power.
      this.i++;
      const c = this.s[this.i];
      if (this.i < this.s.length && c !== "." && c !== "," && c !== "+" && !/\s/.test(c)) {
        throw new Failure(`unexpected "${c}" after a "#" index`);
      }
      return { lo: 0, hi: Infinity };
    }
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
    if (term.kind === "all") {
      // everything in the system, as the top-level category entries
      // (entry-level parity: create_sele all commits the coarse categories)
      for (const c of tree.categories) add({ level: "category", id: c.categoryIndex });
      continue;
    }
    if (term.kind === "ref") {
      // "@all" is the RESERVED union of every committed selection's entries
      const stored =
        term.name === "all"
          ? [...committedNames.values()].flat()
          : (committedNames.get(term.name) ?? []);
      if (!term.filter) {
        for (const e of stored) add(e);
        continue;
      }
      // "@name.<leaf-pred>": MEMBERSHIP-ONLY filtering (consistency
      // principle 1 — this REVERSES the earlier match-anywhere-over-ancestry
      // rule). The predicate sees the selection's STORED entries at their
      // own levels: a member's label, or a point member's type; "#"
      // predicates match only stored POINT members' indices — an index
      // inside a coarse member matches nothing, no exception. Results are
      // the WHOLE matched members at their stored levels, so every
      // downstream operation is whole-member — exactly what the panel
      // gestures produce, and always reversible in the UI.
      const filter = term.filter;
      for (const e of stored) {
        const hit = filter.predicates.some((pr) => {
          if (pr.kind === "index") {
            return e.level === "point" && inRange(e.id, pr.lo, pr.hi);
          }
          const name = e.level === "point" ? (types[e.id] ?? "") : hierarchy.label(e);
          return predicateMatches(pr, name);
        });
        if (hit) add(e);
      }
      continue;
    }
    if (term.kind === "points") {
      // standalone "#…": unconditional point entries. Bounds NORMALIZE first
      // (range order is not semantic — #9-5 ≡ #5-9), then clamp to the
      // contract range — a well-formed but out-of-range index is an empty match
      for (const spec of term.specs) {
        const lo = Math.max(0, Math.min(spec.lo, spec.hi));
        const hi = Math.min(Math.max(spec.lo, spec.hi), hierarchy.n - 1);
        for (let p = lo; p <= hi; p++) add({ level: "point", id: p });
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
  /** What VOCABULARY the candidates are, when it isn't tree navigation —
   * the terminal renders a header naming it; path-level completions
   * (genuine tree levels) carry no kind. Returned data only — no DOM
   * concern lives here.
   *   "filter"  @name.<pred> filter vocabulary (predicates over the
   *             points' type or ancestor labels), not tree levels/members
   *   "param"   a mod invocation's declared ?parameter names
   *   "channel" declared channel names (bake/bind's read vocabulary)
   *   "axis"    bindable axis tokens (bake/bind/unbind)
   *   "value"   a fixed value vocabulary (booleans, styles, shapes,
   *             colors, mod selectors, verb names for help) */
  kind?: "filter" | "param" | "channel" | "axis" | "value";
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
 * of THAT selection's point set; after `+` a fresh term.
 *
 * Path segments follow a STATELESS TWO-STAGE rule — the result is a pure
 * function of (text, cursor), never of prior Tab presses:
 *   stage one — a PARTIAL token settles: unique → the full label, several →
 *   the common prefix + the candidate list; no "." is ever appended;
 *   stage two — a token that already EXACTLY equals a node label at a
 *   descendable level (category/group/subgroup) appends "." and offers the
 *   next level's candidates. Exact-match descent is unconditional, even when
 *   longer sibling labels share the token as a prefix (keep typing to reach
 *   those). At the leaf (point-type) an exact token is terminal — no dot,
 *   nothing further; #/@name/glob/range tokens never descend.
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

  // the "@name." filter candidate pool = the selection's STORED MEMBERSHIP
  // (a member's label, a point member's type) — what the panel's member list
  // shows, and exactly what a @name.<token> filter can match (consistency
  // principle 1: no descendant tokens, no ancestry pool). Deduped by finish().
  const selectionPool = (selName: string): string[] | null => {
    const stored =
      selName === "all"
        ? [...committedNames.values()].flat() // "@all" = the union membership
        : committedNames.get(selName);
    if (!stored) return null;
    return stored
      .map((e) => (e.level === "point" ? (types[e.id] ?? "") : hierarchy.label(e)))
      .filter((t) => t !== "");
  };

  // @name: the token hangs directly off an "@". The two-stage rule applies
  // here too — an EXACT-complete selection name is descendable (a filter
  // level exists below it): second Tab appends "." and offers the
  // selection's identity pool; a partial name settles with no dot.
  if (before.endsWith("@")) {
    if (token !== "" && (committedNames.has(token) || token === "all")) {
      const next = [...new Set(selectionPool(token) ?? [])].sort();
      return { ...capped(ts, next, ".", "."), kind: "filter" };
    }
    return finish(ts, token, [...committedNames.keys(), "all"], "");
  }

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
    const pool = selectionPool(selName);
    if (pool === null) return none;
    return { ...finish(ts, token, pool, ""), kind: "filter" };
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

  // STATELESS TWO-STAGE path completion: an exact-complete token at a
  // descendable level appends "." and offers the NEXT level's candidates
  // (unconditionally — longer siblings sharing the token as a prefix do not
  // block descending into the fully-typed node); a partial token settles
  // with no dot; an exact LEAF token is terminal. Pure in (text, cursor).
  const pathStage = (pool: string[], descend: (() => string[]) | null): Completion => {
    if (token !== "" && pool.includes(token)) {
      if (!descend) return { start: ts, candidates: [], applied: "" }; // exact leaf: terminal
      const next = [...new Set(descend())].filter((c) => c !== "").sort();
      return capped(ts, next, ".", ".");
    }
    return finish(ts, token, pool, ""); // settle the token — never a "."
  };

  if (k === 0) {
    return pathStage(
      tree.categories.map((c) => c.label),
      () => tree.categories.filter((c) => c.label === token)
        .flatMap((c) => c.groups.map((g) => g.label)),
    );
  }

  const parsed = parseTarget(completed.join("."));
  if (parsed.kind === "error" || parsed.terms[0].kind !== "path") return none;
  const segs = parsed.terms[0].segments;

  const cats = catsMatching(segs[0], tree);
  if (k === 1) {
    const groupsInScope = cats.flatMap((c) => c.groups);
    return pathStage(
      groupsInScope.map((g) => g.label),
      () => groupsInScope.filter((g) => g.label === token)
        .flatMap((g) => g.subgroups.map((s) => s.label)),
    );
  }
  const groups = groupsMatching(segs[1], cats);
  if (k === 2) {
    const subsInScope = groups.flatMap((g) => g.subgroups);
    return pathStage(
      subsInScope.map((s) => s.label),
      () => {
        const out: string[] = [];
        for (const s of subsInScope) {
          if (s.label !== token) continue;
          for (const p of hierarchy.subgroupPoints(s.subgroupId)) {
            const t = types[p];
            if (t) out.push(t);
          }
        }
        return out;
      },
    );
  }
  const subs = subgroupsMatching(segs[2], groups);
  const leafTypes: string[] = [];
  for (const s of subs) {
    for (const p of hierarchy.subgroupPoints(s.subgroupId)) {
      const t = types[p];
      if (t) leafTypes.push(t);
    }
  }
  return pathStage(leafTypes, null);
}

/** DISPLAY-VOLUME CAP (one rule, applied uniformly wherever a completion
 * would print a candidate list): above this many candidates, return a
 * count-and-hint pair instead of the full list, and complete nothing until
 * a typed prefix narrows it. The POOL is unchanged — every withheld token
 * still matches when typed; only the at-once printing is limited, keeping
 * completion consistent with resolution. */
export const COMPLETION_LIST_CAP = 50;

function capped(
  start: number,
  candidates: string[],
  applied: string,
  appliedWhenCapped = "", // descend sites keep their "." — the dot is the
  // stage-two ACTION, only the list display is capped
): Completion {
  if (candidates.length <= COMPLETION_LIST_CAP) return { start, candidates, applied };
  return {
    start,
    candidates: [`${candidates.length} matches`, `— type to narrow`],
    applied: appliedWhenCapped,
  };
}

/** The ONE settle helper for every NON-TARGET argument slot (the verb-aware
 * dispatcher in commands.ts routes param/channel/axis/style/shape/color/…
 * vocabularies through here): a thin export over the same `finish` + cap
 * path completion itself settles with, so an argument token behaves
 * IDENTICALLY to a path token — same COMPLETION_LIST_CAP, same sorted
 * distinct prefix-filtered candidates, same common-prefix extension, same
 * "a unique match appends the separator" rule (`uniqueSuffix`, e.g. "="
 * after a unique parameter name). Dispatcher slots get NO settle logic of
 * their own — growing a second settle path is the two-lists defect. */
export function completeToken(
  start: number,
  token: string,
  pool: Iterable<string>,
  opts: { uniqueSuffix?: string; kind?: Completion["kind"] } = {},
): Completion {
  const done = finish(start, token, pool, opts.uniqueSuffix ?? "");
  return opts.kind === undefined ? done : { ...done, kind: opts.kind };
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
  return capped(start, candidates, common.slice(token.length));
}

function segmentMatches(seg: Segment, name: string): boolean {
  return seg.predicates.some((p) => predicateMatches(p, name));
}

/** Leaf matching, shared by path leaves and @name filters: "#" predicates
 * match the point INDEX, everything else the opaque type string. */
function leafHit(seg: Segment, pointId: number, typeName: string): boolean {
  return seg.predicates.some((pr) =>
    pr.kind === "index" ? inRange(pointId, pr.lo, pr.hi) : predicateMatches(pr, typeName),
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
      return n !== null && inRange(n, p.lo, p.hi);
    }
    case "index":
      // "#" matches point INDICES, never labels; the parser confines it to
      // the leaf, where resolution handles it against the index directly
      return false;
  }
}

/** Inclusive range test with UNORDERED bounds. Range order is not semantic —
 * a range denotes a SET, so `9-5` ≡ `5-9` for both label and # index ranges
 * (a directional range, if ever wanted, gets its own syntax; `..` stays
 * reserved). Equal bounds still match exactly that value. */
function inRange(value: number, a: number, b: number): boolean {
  return value >= Math.min(a, b) && value <= Math.max(a, b);
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
