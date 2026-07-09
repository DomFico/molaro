/**
 * Address grammar v1 — the textual way to NAME a set of nodes in the fixed
 * four-level tree (category → group → subgroup → point). The command layer
 * (webview/commands.ts) feeds verb arguments through here.
 *
 *   target-expr := term ("+" term)*             union across subtrees
 *   term        := path | "@" name              @name = a committed selection
 *   path        := segment ("." segment)*       1–4 segments, top-down;
 *                                               segment COUNT = target level
 *   segment     := predicate ("," predicate)*   list = union within the parent
 *   predicate   := "*" | glob | range | literal
 *   range       := INT "-" INT                  trailing integer in [lo, hi]
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
  | { kind: "range"; lo: number; hi: number };

export interface Segment {
  predicates: Predicate[];
}

export type Term =
  | { kind: "path"; segments: Segment[] }
  | { kind: "ref"; name: string };

export interface TargetAst {
  kind: "target";
  terms: Term[];
}

export interface ParseError {
  kind: "error";
  message: string;
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
      const c = this.s[this.i];
      if (this.i < this.s.length && c !== "+" && !/\s/.test(c)) {
        throw new Failure(`unexpected "${c}" after "@${name}"`);
      }
      return { kind: "ref", name };
    }
    const segments: Segment[] = [this.segment()];
    while (this.s[this.i] === ".") {
      this.i++;
      if (segments.length === 4) {
        throw new Failure("too many segments — a path has at most 4 (category.group.subgroup.point)");
      }
      segments.push(this.segment());
    }
    return { kind: "path", segments };
  }

  private segment(): Segment {
    const first = this.predicate();
    if (!first) {
      throw new Failure(`empty segment — ".." and leading/trailing "." are not allowed`);
    }
    const predicates = [first];
    while (this.s[this.i] === ",") {
      this.i++;
      const p = this.predicate();
      if (!p) throw new Failure(`empty predicate in a "," list`);
      predicates.push(p);
    }
    return { predicates };
  }

  /** One predicate, or null when the input yields no token here (the caller
   * knows whether that means an empty segment or an empty list element). */
  private predicate(): Predicate | null {
    if (this.s[this.i] === '"') return { kind: "literal", value: this.quoted() };
    const tok = this.token();
    if (tok === "") return null;
    if (tok === "*") return { kind: "star" };
    const range = /^(\d+)-(\d+)$/.exec(tok);
    if (range) return { kind: "range", lo: Number(range[1]), hi: Number(range[2]) };
    if (tok.includes("*")) return { kind: "glob", pattern: tok };
    return { kind: "literal", value: tok };
  }

  private token(): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (RESERVED.has(c)) throw new Failure(`reserved character "${c}"`);
      if (c === '"' && this.i > start) {
        throw new Failure("unexpected quote — quotes must wrap a whole predicate");
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
      for (const e of committedNames.get(term.name) ?? []) add(e);
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
    // level 4: the subgroup's drilled point rows, matched on the type string
    for (const s of subs) {
      for (const p of hierarchy.subgroupPoints(s.subgroupId)) {
        if (segmentMatches(segs[3], types[p] ?? "")) add({ level: "point", id: p });
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
 * `@` the committed-selection names; after `+` a fresh term. A unique
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

  // pattern-in-progress → completion opts out (globs, numeric ranges, junk)
  if (/[*[\]?"]/.test(token)) return none;
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
