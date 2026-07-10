/**
 * Command layer — registry + dispatcher + the built-in verbs.
 *
 * The registry is the extensibility seam: every verb — the built-ins today,
 * user-supplied verbs later — enters through the same `register(verb, handler)`
 * call, and the dispatcher knows nothing about any specific verb (no switch
 * over names, no special path for built-ins).
 *
 * The hard invariant for handlers: executing a command must be
 * INDISTINGUISHABLE from performing the equivalent gesture. Handlers close
 * over the viewer's hierarchy / model / action surface (`CommandContext`,
 * wired in main.ts) and call the exact action paths the mouse gestures call —
 * same state mutations, same camera tween, same flashes, same row feedback.
 * Commands get no rendering or camera code of their own.
 */
import {
  COMPLETION_LIST_CAP,
  completeTarget,
  parseTarget,
  resolveTarget,
  splitLeadingRef,
  splitTrailingName,
  splitTrailingWord,
  type Completion,
  type Segment,
  type TargetAst,
} from "./address.ts";
import type { TreeModel } from "./classification.ts";
import type { Entry, Hierarchy } from "./sets.ts";

export type CommandStatus = "ok" | "nomatch" | "error";

export interface CommandResult {
  status: CommandStatus;
  message: string;
}

/** A verb implementation: receives the text after the verb (trimmed). */
export type CommandHandler = (args: string) => CommandResult;

/** The viewer surface handlers close over — every member is the SAME object
 * or function the gesture handlers use (see the wiring in main.ts). */
export interface CommandContext {
  hierarchy: Hierarchy;
  /** The buildTree model the bottom panel renders — target resolution
   * descends THIS structure so commands mirror the visible rows exactly. */
  tree: TreeModel;
  /** header.points.type — the level-4 (leaf) match strings. */
  pointTypes: readonly string[];
  /** Committed-selection name → its stored entries (for "@name"). */
  committedEntries(): ReadonlyMap<string, readonly Entry[]>;
  /** The gesture focus path: camera tween + yellow flash (main.ts focusPoints). */
  focusPoints(points: number[]): void;
  /** The empty-space-click path: frame the visible scene (parked while editing). */
  frameVisible(): void;
  /** Flash every currently-mounted row whose points intersect this resolved
   * set — point-set matching, so term kind/level never changes which rows
   * light (main.ts flashPointRows; rides the gesture flashRow). `cls` picks
   * the swatch (default the yellow focus flash; "sel-covered" = the pending
   * green, used for the create_sele commit pulse). */
  flashPointRows(points: readonly number[], cls?: string): void;
  /** THE MUTATION ROUTE (create_sele/hide; future mutating verbs inherit
   * it): commit these entries as a new selection through the exact
   * SelectionModel path the "Create selection" button uses — one stroke, so
   * a single undo removes the whole command with no residue. `hide` folds a
   * whole-selection hide into the SAME stroke (hide <target> =
   * commit-then-hide, one undo op). Returns the created name + point count,
   * or an error (name collision). */
  commitEntries(
    entries: Entry[],
    name: string | null,
    hide?: boolean,
  ): { name: string; points: number } | { error: string };
  /** Hide/show a BATCH of committed-reference targets in place — whole
   * selections (entries null) and/or member subsets — as ONE stroke = one
   * undo op (the all-reference arm of the commit rule, principle 3).
   * affected = points whose state changed; changed = selections touched.
   * null = a named selection doesn't exist. */
  setRefsHidden(
    ops: { name: string; entries: Entry[] | null }[],
    hidden: boolean,
  ): { affected: number; changed: number } | null;
  /** The committed selections, in panel order (ls / @all expansion). */
  selectionsInfo(): { name: string; points: number; hidden: boolean }[];
  /** Rename through the model's unique-name mutator (one undo op, exact
   * parity with the panel's inline rename). */
  renameSelection(oldName: string, newName: string): { ok: true } | { error: string };
  /** WHOLE-MEMBER hide/show for @name.<pred>: the filter resolves stored
   * member entries and this hides/shows exactly those members (the member
   * right-click's setEntriesHidden — no sub-member state can exist).
   * affected = points whose state changed (0 = idempotent); wholeHidden
   * reports a whole-selection flag the member op cannot touch. One undo op. */
  setMembersHiddenIn(
    name: string,
    entries: Entry[],
    hidden: boolean,
  ): { affected: number; wholeHidden: boolean } | null;
  /** show @name: clear ALL hidden state on the selection — whole flag AND
   * member hides — one undo op. affected 0 = nothing was hidden. */
  clearSelectionHidden(name: string): { affected: number } | null;
  /** show <path>: clear hidden state wherever these points are hidden —
   * never commits. Returns distinct affected points (0 = nothing hidden). */
  showPointsCovering(points: readonly number[]): number;
  /** Bare show: clear ALL hidden state (one undo op). */
  showAll(): number;
  /** add/remove: mutate a committed selection's MEMBERSHIP through the same
   * gesture mutators edit mode drives (addToTarget/removeFromTarget), all
   * inside ONE stroke = one undo op; edit mode is parked onto the selection
   * and the prior mode restored around it. add inserts entries at their
   * natural level (idempotent per entry); remove drops EXACT stored members
   * only — the wiring skips anything else, so the model's carve path is
   * structurally unreachable from the terminal (principle 4). Returns the
   * points whose membership changed and the selection's remaining entry
   * count, or null when the named selection doesn't exist. */
  mutateMembers(
    name: string,
    mode: "add" | "remove",
    entries: Entry[],
  ): { points: number; remaining: number } | null;
  /** Bare `remove @name` / `remove @all`: delete whole selections through
   * the SAME model op the panel's ✕ button uses, all in ONE stroke — a
   * single Ctrl+Z restores every deleted selection intact (members, hidden
   * state, lane). null = a named selection doesn't exist. */
  deleteSelections(names: string[]): { deleted: number; points: number } | null;
  /** colorpoints <target> <c> — THE FIRST REPRESENTATION MUTATION: write a
   * constant per-point RGB (0..1) on exactly these points in the
   * representation layer's color buffer, last-write-wins, recorded as ONE
   * stroke on the SAME undo stack every gesture uses (never a second undo
   * system). Points never colored keep the uniform base look. Returns the
   * count written. */
  colorPoints(points: readonly number[], rgb: [number, number, number]): number;
  /** The contract's edge list — endpoint point-index pairs, in header order.
   * colorbonds/colorbondsof test these endpoints against the resolved point
   * set; edge ids (indexes into this list) key the edge-color buffer. */
  edges: readonly [number, number][];
  /** colorPoints' EDGE twin: write a constant per-edge RGB on exactly these
   * edge ids in the ONE edge-color buffer (colorbonds and colorbondsof both
   * write it — they compose by last-write-wins per edge). Same one-stroke
   * recordOp discipline; edges never written keep the uniform base look.
   * Returns the count written. */
  colorEdges(edgeIds: readonly number[], rgb: [number, number, number]): number;
}

export class CommandRegistry {
  private readonly entries = new Map<string, { handler: CommandHandler; description: string }>();

  register(verb: string, handler: CommandHandler, description = ""): void {
    this.entries.set(verb, { handler, description });
  }

  /** Registered verb names (completion pool — grows with every new verb). */
  verbs(): string[] {
    return [...this.entries.keys()];
  }

  /** The one-line description a verb registered with (`help <verb>`). */
  describe(verb: string): string | undefined {
    return this.entries.get(verb)?.description;
  }

  /** Dispatch: leading token = verb, remainder = the handler's argument. */
  runCommand(text: string): CommandResult {
    const trimmed = text.trim();
    if (!trimmed) return { status: "error", message: "empty command" };
    const space = trimmed.search(/\s/);
    const verb = space < 0 ? trimmed : trimmed.slice(0, space);
    const args = space < 0 ? "" : trimmed.slice(space + 1).trim();
    const entry = this.entries.get(verb);
    if (!entry) return { status: "error", message: `unknown command: ${verb}` };
    return entry.handler(args);
  }
}

/**
 * `view` — camera focus, the text twin of the row-click / right-drag focus
 * gestures. No argument frames the VISIBLE scene (the empty-space-click
 * analog); with a target expression it frames the FULL resolved union —
 * hidden points included, exactly like clicking a hidden row: the camera
 * goes there, the yellow pulse lights only the currently visible points
 * (the overlay gates on visibility — no logic added here), and nothing is
 * unhidden. Never a state change; `nomatch` means only that the address
 * resolves to nothing.
 */
export function makeViewHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (args === "") {
      ctx.frameVisible();
      return { status: "ok", message: "framed the visible scene" };
    }
    const ast = parseTarget(args);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    // Union the entries' points — hidden ones included (a click on a hidden
    // row frames it too; only the pulse is visibility-gated, downstream).
    const seen = new Set<number>();
    const points: number[] = [];
    for (const e of entries) {
      for (const p of ctx.hierarchy.pointsOf(e)) {
        if (seen.has(p)) continue;
        seen.add(p);
        points.push(p);
      }
    }
    if (points.length === 0) {
      return { status: "nomatch", message: `nothing matches "${args}"` };
    }
    ctx.focusPoints(points); // the same call the right-drag union-focus makes
    ctx.flashPointRows(points); // the FULL union — term count/kind/level irrelevant
    return { status: "ok", message: `focused ${points.length} points` };
  };
}

/**
 * `create_sele <target-expr> [name]` — the first state-mutating verb, and the
 * template every future one inherits: resolve with the SAME resolveTarget
 * view uses, then route through the existing SelectionModel commit path (via
 * ctx.commitEntries — no parallel commit machinery).
 *
 * ENTRY-LEVEL PARITY (every mutating verb inherits this): the target is
 * committed as exactly the resolved entries, at their natural levels — a
 * group-level path stays ONE coarse group entry, a leaf/#index target stays
 * point entries, and @name contributes its stored entries unflattened. This
 * mirrors what clicking those rows and pressing "Create selection" would
 * store, entry-for-entry; unions may therefore produce mixed-level member
 * lists, which is correct. Never expand a coarse entry into points and never
 * collapse fine entries into a coarser one here.
 */
export function makeCreateSeleHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const split = splitTrailingName(args);
    if ("kind" in split) return { status: "error", message: split.message };
    const ast = parseTarget(split.expr);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    if (entries.length === 0) {
      // an empty target commits nothing — nomatch, no mutation
      return { status: "nomatch", message: `nothing matches "${split.expr}"` };
    }
    const result = ctx.commitEntries(entries, split.name);
    if ("error" in result) return { status: "error", message: result.error };
    return { status: "ok", message: `created "${result.name}" — ${result.points} points` };
  };
}

/**
 * `hide` / `show` — the mutating pair over the model's hidden state. Hiding
 * is a property of COMMITTED selections (no free-floating hidden set), so:
 *
 *   hide <target>        commit-then-hide, one undo op (the create_sele
 *                        template + setHidden in the same stroke)
 *   hide @name           whole-selection flag (never commits, never toggles
 *                        — already hidden is an idempotent ok)
 *   hide @name.<pred>    per-member subset via the resolved filter points
 *   hide                 ERROR — no "hide everything" (no gesture analog)
 *
 *   show @name           clear the whole-selection flag only
 *   show @name.<pred>    clear the hiddenPart entries the filter intersects
 *   show <target>        clear hidden state COVERING those points — show
 *                        NEVER commits (a point in no selection is already
 *                        visible); nothing hidden there = honest ok, no-op
 *   show                 reveal everything (non-destructive; one undo op)
 *
 * Result messages report the ACTION performed, never implied visibility —
 * under show-wins, hiding a selection masked by a visible coverer changes no
 * pixels, and that is the accepted trade-off, not a failure.
 */
export function makeHideHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const split = splitTrailingName(args);
    if ("kind" in split) return { status: "error", message: split.message };
    if (split.expr === "") {
      return { status: "error", message: `hide needs a target — there is no "hide everything"` };
    }
    const ast = parseTarget(split.expr);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    // COMMIT-ONLY-WHEN-UNCOMMITTED (consistency principle 3, all-or-nothing
    // at the whole-target level): a target made ENTIRELY of committed
    // references (@name / @all, joined by +) is already committed — hide it
    // in place, commit nothing. Any non-reference term (path, glob, #, all…)
    // makes the WHOLE target commit as one new selection, leaving referenced
    // selections untouched (show-wins handles the overlap).
    const refs = ast.terms.every((t) => t.kind === "ref")
      ? (ast.terms as { kind: "ref"; name: string; filter?: unknown }[])
      : null;
    if (refs) {
      if (split.name !== null) {
        return {
          status: "error",
          message: `a [name] applies only when hide commits a new selection — this target is already committed`,
        };
      }
      const known = ctx.selectionsInfo().map((s) => s.name);
      const ops: { name: string; entries: Entry[] | null }[] = [];
      let filteredMembers = 0;
      for (const ref of ast.terms as { kind: "ref"; name: string; filter?: Segment }[]) {
        if (ref.name !== "all" && !ctx.committedEntries().has(ref.name)) {
          return { status: "nomatch", message: `no selection named "${ref.name}"` };
        }
        const names = ref.name === "all" ? known : [ref.name];
        if (ref.name === "all" && names.length === 0) {
          return { status: "nomatch", message: "no committed selections" };
        }
        for (const n of names) {
          if (!ref.filter) {
            ops.push({ name: n, entries: null });
          } else {
            // this selection's filtered MEMBERS, via the ordinary resolver
            const sub: TargetAst = {
              kind: "target",
              terms: [{ kind: "ref", name: n, filter: ref.filter }],
            };
            const members = resolveTarget(sub, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
            if (members.length > 0) {
              ops.push({ name: n, entries: members });
              filteredMembers += members.length;
            }
          }
        }
      }
      if (ops.length === 0) {
        return { status: "nomatch", message: `nothing matches "${split.expr}"` };
      }
      const r = ctx.setRefsHidden(ops, true)!;
      const soleWhole = ops.length === 1 && ops[0].entries === null;
      const soleFiltered = ops.length === 1 && ops[0].entries !== null;
      if (r.affected === 0) {
        if (soleWhole) return { status: "ok", message: `"${ops[0].name}" is already hidden` };
        if (soleFiltered) {
          return { status: "ok", message: `already hidden — ${filteredMembers} members in "${ops[0].name}"` };
        }
        return { status: "ok", message: "already hidden" };
      }
      if (soleWhole) return { status: "ok", message: `hid "${ops[0].name}" — ${r.affected} points` };
      if (soleFiltered) return { status: "ok", message: `hid ${r.affected} points in "${ops[0].name}"` };
      return { status: "ok", message: `hid ${r.affected} points across ${r.changed} selections` };
    }
    // an uncommitted target: commit the WHOLE target as one new selection,
    // then hide it (one undo unit), entry-level parity exactly as create_sele
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    if (entries.length === 0) {
      return { status: "nomatch", message: `nothing matches "${split.expr}"` };
    }
    const result = ctx.commitEntries(entries, split.name, true);
    if ("error" in result) return { status: "error", message: result.error };
    return { status: "ok", message: `created and hid "${result.name}" — ${result.points} points` };
  };
}

export function makeShowHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const split = splitTrailingName(args);
    if ("kind" in split) return { status: "error", message: split.message };
    if (split.name !== null) {
      return { status: "error", message: `show takes no [name] — it never creates a selection` };
    }
    if (split.expr === "") {
      const n = ctx.showAll();
      return n === 0
        ? { status: "ok", message: "nothing hidden" }
        : { status: "ok", message: `showed everything — ${n} points` };
    }
    const ast = parseTarget(split.expr);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    const soleRef = ast.terms.length === 1 && ast.terms[0].kind === "ref" ? ast.terms[0] : null;
    if (soleRef?.name === "all" && !soleRef.filter) {
      // show @all ≡ bare show: clear every selection's hidden state
      const n = ctx.showAll();
      return n === 0
        ? { status: "ok", message: "nothing hidden" }
        : { status: "ok", message: `showed everything — ${n} points` };
    }
    if (soleRef && soleRef.name !== "all") {
      if (!ctx.committedEntries().has(soleRef.name)) {
        return { status: "nomatch", message: `no selection named "${soleRef.name}"` };
      }
      if (!soleRef.filter) {
        // "show the whole selection" = make ALL of it visible: whole flag
        // AND member hides (the reliable inverse of any hiding on it)
        const r = ctx.clearSelectionHidden(soleRef.name)!;
        return r.affected === 0
          ? { status: "ok", message: `"${soleRef.name}" is already visible` }
          : { status: "ok", message: `showed "${soleRef.name}" — ${r.affected} points` };
      }
      const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
      if (entries.length === 0) {
        return { status: "nomatch", message: `nothing matches "${split.expr}"` };
      }
      const r = ctx.setMembersHiddenIn(soleRef.name, entries, false)!;
      if (r.affected === 0) {
        return r.wholeHidden
          ? { status: "ok", message: `"${soleRef.name}" is hidden whole — show @${soleRef.name} to reveal it` }
          : { status: "ok", message: `nothing hidden there` };
      }
      return { status: "ok", message: `showed ${r.affected} points in "${soleRef.name}"` };
    }
    // a plain target: clear hidden state covering those points — NEVER commit
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    if (entries.length === 0) {
      return { status: "nomatch", message: `nothing matches "${split.expr}"` };
    }
    const seen = new Set<number>();
    const points: number[] = [];
    for (const e of entries) {
      for (const p of ctx.hierarchy.pointsOf(e)) {
        if (!seen.has(p)) {
          seen.add(p);
          points.push(p);
        }
      }
    }
    const n = ctx.showPointsCovering(points);
    return n === 0
      ? { status: "ok", message: `nothing hidden there — ${points.length} points already visible` }
      : { status: "ok", message: `showed ${n} points` };
  };
}

/** The CSS named colors (Color Module Level 4), name:rrggbb — parsed once.
 * Kept as data, not code, so the table stays greppable and diffable. */
const CSS_COLOR_DATA =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff," +
  "beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff," +
  "blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00," +
  "chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c," +
  "cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9," +
  "darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b," +
  "darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000," +
  "darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f," +
  "darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493," +
  "deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222," +
  "floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc," +
  "ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000," +
  "greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c," +
  "indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5," +
  "lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080," +
  "lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90," +
  "lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa," +
  "lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899," +
  "lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6," +
  "magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd," +
  "mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371," +
  "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc," +
  "mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1," +
  "moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000," +
  "olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa," +
  "palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5," +
  "peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6," +
  "purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1," +
  "saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee," +
  "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090," +
  "slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c," +
  "teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee," +
  "wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";
const CSS_COLORS: ReadonlyMap<string, string> = new Map(
  CSS_COLOR_DATA.split(",").map((s) => s.split(":") as [string, string]),
);

/** Parse a color token — a CSS color name (red, steelblue) or hex (#ff8800,
 * #f80) — to RGB in 0..1. Case-insensitive (CSS semantics; the token is a
 * color, not a grammar label). null = not a color. */
export function parseColor(token: string): [number, number, number] | null {
  const t = token.toLowerCase();
  let hex: string | undefined;
  if (t.startsWith("#")) {
    const body = t.slice(1);
    if (!/^[0-9a-f]{6}$/.test(body) && !/^[0-9a-f]{3}$/.test(body)) return null;
    hex = body.length === 3 ? [...body].map((c) => c + c).join("") : body;
  } else {
    hex = CSS_COLORS.get(t);
  }
  if (!hex) return null;
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

/** The color family's shared argument/target front half: split the trailing
 * color token, validate it, parse the expression, and resolve to the deduped
 * point union — hidden points included, never committing: view's EXACT
 * resolution, so every family verb colors off the point set `view <target>`
 * frames. Errors/nomatch come back as the CommandResult; success carries the
 * points, the RGB, and the split for the verb's own wording. */
function resolveColorArgs(
  ctx: CommandContext,
  verb: string,
  args: string,
): { points: number[]; rgb: [number, number, number]; expr: string; word: string } | CommandResult {
  const split = splitTrailingWord(args);
  if (split.word === null) {
    return {
      status: "error",
      message: `${verb} needs a target and a color — ${verb} <target> <color> (e.g. ${verb} alpha green)`,
    };
  }
  const rgb = parseColor(split.word);
  if (!rgb) {
    return {
      status: "error",
      message: `unknown color "${split.word}" — use a CSS color name (red, steelblue) or hex (#ff8800)`,
    };
  }
  const ast = parseTarget(split.expr);
  if (ast.kind === "error") return { status: "error", message: ast.message };
  const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
  // Union the entries' points, hidden ones included — view's exact dedupe.
  const seen = new Set<number>();
  const points: number[] = [];
  for (const e of entries) {
    for (const p of ctx.hierarchy.pointsOf(e)) {
      if (seen.has(p)) continue;
      seen.add(p);
      points.push(p);
    }
  }
  if (points.length === 0) {
    return { status: "nomatch", message: `nothing matches "${split.expr}"` };
  }
  return { points, rgb, expr: split.expr, word: split.word };
}

/**
 * `colorpoints <target> <color>` — the FIRST representation verb (shipped as
 * `color`, renamed when the family grew): a constant per-point color write,
 * and the template every appearance verb clones. It targets EXACTLY like
 * view — the same resolveTarget over the same descent helpers, full grammar,
 * hidden points included, no commit — so `colorpoints <t> <c>` colors
 * precisely the point set `view <t>` frames. Where it diverges from view: it
 * MUTATES — one undo stroke per invocation (re-coloring overlapping points
 * last-write-wins as a NEW stroke), and a nomatch / invalid color / usage
 * error writes nothing and pushes no stroke. The message reports the ACTION
 * and count, never pixels — some colored points may be hidden (show's
 * report-the-action rule). <color> is a CSS color name or hex. It writes the
 * POINT buffer only — edges and polylines are other verbs' primitives.
 */
export function makeColorPointsHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveColorArgs(ctx, "colorpoints", args);
    if ("status" in r) return r;
    const n = ctx.colorPoints(r.points, r.rgb);
    return { status: "ok", message: `colored ${n} points ${r.word}` };
  };
}

/**
 * `colorbonds <target> <color>` / `colorbondsof <target> <color>` — the edge
 * pair. Both resolve the target to the same point set colorpoints/view use,
 * then map it onto EDGES; they differ only in the endpoint predicate:
 *
 *   colorbonds    BOTH endpoints in the set (contained — parity-preserving:
 *                 every colored edge lies inside the resolved target)
 *   colorbondsof  AT LEAST ONE endpoint in the set (incident). Edges whose
 *                 OTHER endpoint is OUTSIDE the target are colored
 *                 INTENTIONALLY — reaching one hop out is this verb's whole
 *                 point, and the one deliberate break from strict
 *                 target-containment in the family; hence a separate verb
 *                 rather than a flag.
 *
 * Both write the ONE edge-color buffer (they compose by last-write-wins per
 * edge) and touch no other primitive. A well-formed target that matches
 * points but no edges is a nomatch (e.g. colorbonds on a single point — no
 * edge has both endpoints in a one-point set) — nothing written, no stroke.
 */
export function makeColorBondsHandler(
  ctx: CommandContext,
  verb: "colorbonds" | "colorbondsof",
): CommandHandler {
  const both = verb === "colorbonds";
  return (args: string): CommandResult => {
    const r = resolveColorArgs(ctx, verb, args);
    if ("status" in r) return r;
    const inSet = new Set(r.points);
    const edgeIds: number[] = [];
    for (let e = 0; e < ctx.edges.length; e++) {
      const [a, b] = ctx.edges[e];
      if (both ? inSet.has(a) && inSet.has(b) : inSet.has(a) || inSet.has(b)) edgeIds.push(e);
    }
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${r.expr}"`
          : `no edges touching "${r.expr}"`,
      };
    }
    const n = ctx.colorEdges(edgeIds, r.rgb);
    return { status: "ok", message: `colored ${n} edges ${r.word}` };
  };
}

/** Cap long listings the way completion caps candidate lists. */
function capLines(lines: string[], noun: string): string {
  return lines.length > COMPLETION_LIST_CAP
    ? `${lines.length} ${noun} — narrow the target`
    : lines.join("\n");
}

/**
 * `ls` — READ-ONLY listing (no state, no undo). Three forms:
 *   ls            the committed selections (the top panel section as text)
 *   ls @name      that selection's stored members (the panel's member list;
 *                 membership only — never descendants, per principle 1)
 *   ls <path>     the immediate contents one level below the resolved nodes
 */
export function makeLsHandler(ctx: CommandContext): CommandHandler {
  const entryLine = (e: Entry): string =>
    `${ctx.hierarchy.label(e)} — ${ctx.hierarchy.pointsOf(e).length} points`;
  return (args: string): CommandResult => {
    const split = splitTrailingName(args);
    if ("kind" in split) return { status: "error", message: split.message };
    if (split.name !== null) {
      return { status: "error", message: `ls takes no [name] — it lists, it doesn't create` };
    }
    if (split.expr === "") {
      const sels = ctx.selectionsInfo();
      if (sels.length === 0) return { status: "ok", message: "no selections" };
      return {
        status: "ok",
        message: capLines(
          sels.map((s) => `${s.name} — ${s.points} points${s.hidden ? " · hidden" : ""}`),
          "selections",
        ),
      };
    }
    const ast = parseTarget(split.expr);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    if (ast.terms.every((t) => t.kind === "ref")) {
      // MEMBERS view: exactly what the panel's member list shows
      for (const t of ast.terms as { kind: "ref"; name: string }[]) {
        if (t.name !== "all" && !ctx.committedEntries().has(t.name)) {
          return { status: "nomatch", message: `no selection named "${t.name}"` };
        }
      }
      if (entries.length === 0) {
        return { status: "nomatch", message: `nothing matches "${split.expr}"` };
      }
      return { status: "ok", message: capLines(entries.map(entryLine), "members") };
    }
    // CONTENTS view: children one level below each resolved node
    if (entries.length === 0) {
      return { status: "nomatch", message: `nothing matches "${split.expr}"` };
    }
    const lines: string[] = [];
    const seen = new Set<string>();
    const push = (level: Entry["level"], id: number, label: string, points: number): void => {
      const key = `${level}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(`${label} — ${points} points`);
    };
    for (const e of entries) {
      if (e.level === "category") {
        const c = ctx.tree.categories.find((x) => x.categoryIndex === e.id);
        for (const g of c?.groups ?? []) {
          push("group", g.groupId, g.label,
            ctx.hierarchy.pointsOf({ level: "group", id: g.groupId }).length);
        }
      } else if (e.level === "group") {
        for (const c of ctx.tree.categories) {
          for (const g of c.groups) {
            if (g.groupId !== e.id) continue;
            for (const sg of g.subgroups) push("subgroup", sg.subgroupId, sg.label, sg.pointCount);
          }
        }
      } else if (e.level === "subgroup") {
        for (const p of ctx.hierarchy.subgroupPoints(e.id)) {
          push("point", p, ctx.hierarchy.label({ level: "point", id: p }), 1);
        }
      } // points have no contents below
    }
    if (lines.length === 0) {
      return { status: "ok", message: "nothing below — points have no contents" };
    }
    return { status: "ok", message: capLines(lines, "items") };
  };
}

/** `rename @name [new]` — exactly one committed selection, bracketed new
 * name, routed through the model's unique-name rename (one undo op, exact
 * parity with the panel's inline rename). */
export function makeRenameHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const split = splitTrailingName(args);
    if ("kind" in split) return { status: "error", message: split.message };
    if (split.name === null) {
      return { status: "error", message: `rename needs a bracketed name — rename @name [new-name]` };
    }
    const ast = parseTarget(split.expr);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    const sole = ast.terms.length === 1 && ast.terms[0].kind === "ref" ? ast.terms[0] : null;
    if (!sole || sole.filter || sole.name === "all") {
      return {
        status: "error",
        message: `rename applies to exactly one committed selection — rename @name [new-name]`,
      };
    }
    if (!ctx.committedEntries().has(sole.name)) {
      return { status: "nomatch", message: `no selection named "${sole.name}"` };
    }
    const r = ctx.renameSelection(sole.name, split.name);
    if ("error" in r) return { status: "error", message: r.error };
    return { status: "ok", message: `renamed "${sole.name}" → "${split.name}"` };
  };
}

/** Shared FIRST-argument validation for the membership-mutation pair:
 * exactly one lone committed `@name` (add/remove edit ONE selection at a
 * time — matching the UI, which cannot edit two selections at once), then
 * the verb's own right-side expression. */
function leadingSelection(
  verb: "add" | "remove",
  args: string,
  ctx: CommandContext,
  usage: string,
): { name: string; rest: string } | CommandResult {
  const split = splitTrailingName(args);
  if ("kind" in split) return { status: "error", message: split.message };
  if (split.name !== null) {
    return { status: "error", message: `${verb} takes no [name] — it edits an existing selection` };
  }
  const lead = splitLeadingRef(split.expr);
  if (lead.kind === "error") return { status: "error", message: lead.message };
  if (lead.kind === "none") {
    return { status: "error", message: `${verb} needs a committed selection first — ${usage}` };
  }
  if (lead.kind === "multi" || lead.rest.startsWith("+")) {
    return {
      status: "error",
      message: `${verb} edits ONE selection at a time — a single @name comes first (${usage})`,
    };
  }
  if (lead.filtered) {
    return { status: "error", message: `${verb} takes a lone @name first — no filter (${usage})` };
  }
  return { name: lead.name, rest: lead.rest };
}

/**
 * `add @name <tree-target>` — insert tree-addressed entries as MEMBERS at
 * their natural level (entry-level parity). The right side is a TREE
 * address (full grammar: paths, globs, ranges, #, lists, + unions) because
 * the things being added are not yet members and must be named from the
 * tree; `@` terms are a usage error — the UI cannot transfer members
 * between selections, and neither can add.
 */
export function makeAddHandler(ctx: CommandContext): CommandHandler {
  const USAGE = "add @name <tree-target>";
  return (args: string): CommandResult => {
    const lead = leadingSelection("add", args, ctx, USAGE);
    if ("status" in lead) return lead;
    if (lead.name === "all") {
      return {
        status: "error",
        message: `add edits ONE selection at a time — @all is not a single selection`,
      };
    }
    if (!ctx.committedEntries().has(lead.name)) {
      return { status: "nomatch", message: `no selection named "${lead.name}"` };
    }
    if (lead.rest === "") {
      return { status: "error", message: `add needs something to add — ${USAGE}` };
    }
    const ast = parseTarget(lead.rest);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    if (ast.terms.some((t) => t.kind === "ref")) {
      return {
        status: "error",
        message: `add takes TREE addresses — members can't be transferred from another selection (no @ terms on the right)`,
      };
    }
    const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
    if (entries.length === 0) {
      return { status: "nomatch", message: `nothing matches "${lead.rest}"` };
    }
    // idempotence at the entry level: exact members are already there
    const stored = new Set(
      (ctx.committedEntries().get(lead.name) ?? []).map((e) => `${e.level}:${e.id}`),
    );
    const fresh = entries.filter((e) => !stored.has(`${e.level}:${e.id}`));
    if (fresh.length === 0) {
      return { status: "ok", message: `already members — nothing to add to "${lead.name}"` };
    }
    const r = ctx.mutateMembers(lead.name, "add", fresh);
    if (!r) return { status: "nomatch", message: `no selection named "${lead.name}"` };
    return {
      status: "ok",
      message: `added ${fresh.length} members to "${lead.name}" — ${r.points} points`,
    };
  };
}

/**
 * `remove` — four forms, one asymmetric verb:
 *   remove @name <member-pred>  drop the matched STORED members
 *   remove @name all            drop every member; the selection REMAINS
 *   remove @name                DELETE the selection (the panel's ✕)
 *   remove @all                 DELETE every committed selection
 * Member predicates (labels, types, globs, ranges, #index, "," lists, +
 * unions) go through the SAME matcher as `@name.<pred>` filtering — no
 * tree paths, because you're already scoped to the member list. A predicate
 * naming something below a coarse member matches nothing (flat-to-members):
 * carving is structurally impossible from here (principle 4). Emptying a
 * selection — via `all` or an incidental last-member predicate — always
 * leaves it standing; DELETION happens only through the bare forms.
 */
export function makeRemoveHandler(ctx: CommandContext): CommandHandler {
  const USAGE = "remove @name <member-predicates>";
  return (args: string): CommandResult => {
    const lead = leadingSelection("remove", args, ctx, USAGE);
    if ("status" in lead) return lead;
    if (lead.name === "all") {
      // remove @all — the one deliberate bulk delete: the selection OBJECTS
      // go, not their members. One stroke = one Ctrl+Z restores everything.
      if (lead.rest !== "") {
        return {
          status: "error",
          message:
            `remove @all takes no second argument — it deletes EVERY committed ` +
            `selection (to empty one selection's members: remove @name all)`,
        };
      }
      const info = ctx.selectionsInfo();
      if (info.length === 0) return { status: "nomatch", message: "no committed selections" };
      const r = ctx.deleteSelections(info.map((s) => s.name));
      if (!r) return { status: "nomatch", message: "no committed selections" };
      return { status: "ok", message: `deleted ${r.deleted} selections — ${r.points} points` };
    }
    if (!ctx.committedEntries().has(lead.name)) {
      return { status: "nomatch", message: `no selection named "${lead.name}"` };
    }
    if (lead.rest === "") {
      // bare remove @name — the command analog of the panel's ✕ button
      const r = ctx.deleteSelections([lead.name]);
      if (!r) return { status: "nomatch", message: `no selection named "${lead.name}"` };
      return { status: "ok", message: `deleted "${lead.name}" — ${r.points} points` };
    }
    if (lead.rest.includes(":")) {
      return {
        status: "error",
        message: `level qualifiers (":") are not yet supported in member predicates`,
      };
    }
    const ast = parseTarget(lead.rest);
    if (ast.kind === "error") return { status: "error", message: ast.message };
    // each + term must be MEMBER-shaped: one leaf segment, or a "#" term;
    // the sole bare `all` empties the membership (a star over the members)
    const filters: Segment[] = [];
    if (ast.terms.length === 1 && ast.terms[0].kind === "all") {
      filters.push({ predicates: [{ kind: "star" }] });
    } else {
      for (const t of ast.terms) {
        if (t.kind === "path" && t.segments.length === 1) {
          filters.push(t.segments[0]);
        } else if (t.kind === "points") {
          filters.push({
            predicates: t.specs.map((s) => ({ kind: "index" as const, lo: s.lo, hi: s.hi })),
          });
        } else {
          return {
            status: "error",
            message:
              `remove names the selection's OWN members — a member's label, or a point ` +
              `member's type/#index (globs, ranges, "," and "+" compose); no paths, no @ ` +
              `terms. remove @name all empties it; bare remove @name deletes it; to ` +
              `operate on finer pieces, commit a finer selection`,
          };
        }
      }
    }
    // the @name.<pred> matcher itself — remove and filtering cannot diverge
    const matched: Entry[] = [];
    const seen = new Set<string>();
    for (const f of filters) {
      const sub: TargetAst = {
        kind: "target",
        terms: [{ kind: "ref", name: lead.name, filter: f }],
      };
      for (const e of resolveTarget(sub, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries())) {
        const key = `${e.level}:${e.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(e);
        }
      }
    }
    if (matched.length === 0) {
      return { status: "nomatch", message: `no members of "${lead.name}" match "${lead.rest}"` };
    }
    const r = ctx.mutateMembers(lead.name, "remove", matched);
    if (!r) return { status: "nomatch", message: `no selection named "${lead.name}"` };
    const empty = r.remaining === 0 ? " (now empty — the selection remains)" : "";
    return {
      status: "ok",
      message: `removed ${matched.length} members from "${lead.name}" — ${r.points} points${empty}`,
    };
  };
}

/**
 * The `help` summary. KEEP IN SYNC with the quick-reference table at the top
 * of docs/COMMANDS.md — the two carry the same content for different surfaces
 * and must be updated together.
 */
export const HELP_TEXT = [
  "address grammar — category.group.subgroup.point-type (segment count = level)",
  "  predicates   exact label · * · glob (ab*, *z, *m*) · lo-hi (label integer) · a,b,c list",
  '  "…"          quote labels containing spaces or other delimiter characters',
  "  #N #lo-hi #* point(s) by contract index (#* = all; either bound order) —",
  "               bare lo-hi is a LABEL range; # means index",
  "  @name        a committed selection; @name.<pred> filters its STORED MEMBERS",
  "               (a member's label, or a point member's type/index; one predicate;",
  "               finer than the membership = no match — commit a finer selection)",
  "  all / @all   everything in the system / the union of every committed selection",
  "  a + b        union of terms",
  "  view <expr>  frame it (hidden points included); bare view frames the visible scene",
  "  create_sele <expr> [name]   commit the target as a new selection",
  "               (auto-named selection_N without [name]; entries keep their level)",
  "  hide <expr>|@name[.pred]    hide it (an uncommitted target commits first);",
  "               never toggles — already hidden is a no-op; bare hide is an error",
  "  show [<expr>|@name[.pred]]  clear hidden state (never commits);",
  "               bare show reveals everything",
  "  colorpoints <expr> <color>  color those points (CSS name or #hex; hidden",
  "               points color too; last-write-wins; one undo stroke)",
  "  colorbonds <expr> <color>   color edges with BOTH endpoints in the target",
  "  colorbondsof <expr> <color> color edges TOUCHING the target (either",
  "               endpoint — deliberately reaches one hop outside it)",
  "  ls [@name|<path>]   list selections / a selection's members / a node's contents",
  "  rename @name [new]  rename a selection · clear  wipe the terminal log",
  "  add @name <tree-target>     add tree entries as members (natural level)",
  "  remove @name <member-pred>  drop matched STORED members (never carves);",
  "               remove @name all = empty it (it remains) · remove @name =",
  "               delete it · remove @all = delete EVERY selection",
  'errors: a parse error = malformed syntax · "nothing matches" = valid syntax, empty result',
  "full reference: docs/COMMANDS.md",
].join("\n");

/** `help` / `?` — the grammar summary; `help <verb>` describes one verb. */
export function makeHelpHandler(registry: CommandRegistry): CommandHandler {
  return (args: string): CommandResult => {
    if (args === "") return { status: "ok", message: HELP_TEXT };
    const verb = args.split(/\s+/)[0];
    const description = registry.describe(verb);
    if (description === undefined) {
      return { status: "nomatch", message: `no such command: ${verb}` };
    }
    return { status: "ok", message: `${verb} — ${description}` };
  };
}

/** The viewer's registry with the built-in verbs installed — through the same
 * `register` mechanism any future verb will use. */
export function createCommandRegistry(ctx: CommandContext): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(
    "view",
    makeViewHandler(ctx),
    "frame the resolved target (hidden points included); bare view frames the visible scene",
  );
  registry.register(
    "create_sele",
    makeCreateSeleHandler(ctx),
    "commit the resolved target as a new selection: create_sele <target> [name]",
  );
  registry.register(
    "hide",
    makeHideHandler(ctx),
    "hide the target (commits an uncommitted target first); hide @name / @name.<pred> for existing selections",
  );
  registry.register(
    "show",
    makeShowHandler(ctx),
    "clear hidden state on the target (never commits); bare show reveals everything",
  );
  registry.register(
    "colorpoints",
    makeColorPointsHandler(ctx),
    "color the target's points a constant color (CSS name or #hex, one undo stroke): colorpoints <target> <color>",
  );
  registry.register(
    "colorbonds",
    makeColorBondsHandler(ctx, "colorbonds"),
    "color every edge with BOTH endpoints in the target (contained): colorbonds <target> <color>",
  );
  registry.register(
    "colorbondsof",
    makeColorBondsHandler(ctx, "colorbondsof"),
    "color every edge with AT LEAST ONE endpoint in the target (incident — reaches one hop outside): colorbondsof <target> <color>",
  );
  registry.register(
    "ls",
    makeLsHandler(ctx),
    "read-only listing: ls = selections · ls @name = its members · ls <path> = a node's contents",
  );
  registry.register(
    "rename",
    makeRenameHandler(ctx),
    "rename a committed selection: rename @name [new-name]",
  );
  registry.register(
    "add",
    makeAddHandler(ctx),
    "add tree-addressed entries to a selection's members (natural level): add @name <tree-target>",
  );
  registry.register(
    "remove",
    makeRemoveHandler(ctx),
    "drop matched STORED members (never carves): remove @name <member-pred> · " +
      "remove @name all empties it · bare remove @name deletes it · remove @all deletes every selection",
  );
  registry.register(
    "clear",
    () => ({ status: "ok", message: "cleared" }),
    "clear the terminal's output log (handled by the terminal surface itself)",
  );
  const help = makeHelpHandler(registry);
  registry.register("help", help, "this grammar summary; help <verb> describes one verb");
  registry.register("?", help, "alias of help");
  return registry;
}

/** Tab completion for the terminal — `runCommand`'s sibling. Gathers the
 * registry's verb names plus the viewer surface and defers to the pure
 * completeTarget; the terminal ships {text, cursor} and applies the result. */
export function makeRunComplete(
  ctx: CommandContext,
  registry: CommandRegistry,
): (text: string, cursor: number) => Completion {
  return (text, cursor) =>
    completeTarget(
      text,
      cursor,
      ctx.tree,
      ctx.hierarchy,
      ctx.pointTypes,
      ctx.committedEntries(),
      registry.verbs(),
    );
}
