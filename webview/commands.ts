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
  completeTarget,
  parseTarget,
  resolveTarget,
  splitTrailingName,
  type Completion,
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
  /** Whole-selection hide/show flag (model.setHidden). affected 0 = already
   * in that state (idempotent); null = no such selection. One undo op. */
  setSelectionHidden(name: string, hidden: boolean): { affected: number } | null;
  /** Member-subset hide/show for @name.<pred> — a resolved point set through
   * the model's setPointsHidden (hide consolidates; show SPLITS partially-
   * named coarse entries so exactly the named points reveal). affected =
   * named points whose state changed (0 = nothing to change); wholeHidden
   * reports a whole-selection flag the subset op cannot touch. One undo op. */
  setPointsHiddenIn(
    name: string,
    points: readonly number[],
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
    const soleRef = ast.terms.length === 1 && ast.terms[0].kind === "ref" ? ast.terms[0] : null;
    if (soleRef) {
      if (split.name !== null) {
        return {
          status: "error",
          message: `a [name] applies only when hide commits a new selection — "@${soleRef.name}" already exists`,
        };
      }
      if (!ctx.committedEntries().has(soleRef.name)) {
        return { status: "nomatch", message: `no selection named "${soleRef.name}"` };
      }
      if (!soleRef.filter) {
        const r = ctx.setSelectionHidden(soleRef.name, true)!;
        return r.affected === 0
          ? { status: "ok", message: `"${soleRef.name}" is already hidden` }
          : { status: "ok", message: `hid "${soleRef.name}" — ${r.affected} points` };
      }
      const entries = resolveTarget(ast, ctx.tree, ctx.hierarchy, ctx.pointTypes, ctx.committedEntries());
      if (entries.length === 0) {
        return { status: "nomatch", message: `nothing matches "${split.expr}"` };
      }
      const r = ctx.setPointsHiddenIn(soleRef.name, entries.map((e) => e.id), true)!;
      return r.affected === 0
        ? { status: "ok", message: `already hidden — ${entries.length} points in "${soleRef.name}"` }
        : { status: "ok", message: `hid ${r.affected} points in "${soleRef.name}"` };
    }
    // an uncommitted target: commit-then-hide (one undo unit), entry-level
    // parity exactly as create_sele
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
    if (soleRef) {
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
      const r = ctx.setPointsHiddenIn(soleRef.name, entries.map((e) => e.id), false)!;
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
  "  @name        a committed selection; @name.<pred> keeps points whose type OR any",
  "               ancestor label matches (one trailing predicate only)",
  "  a + b        union of terms",
  "  view <expr>  frame it (hidden points included); bare view frames the visible scene",
  "  create_sele <expr> [name]   commit the target as a new selection",
  "               (auto-named selection_N without [name]; entries keep their level)",
  "  hide <expr>|@name[.pred]    hide it (an uncommitted target commits first);",
  "               never toggles — already hidden is a no-op; bare hide is an error",
  "  show [<expr>|@name[.pred]]  clear hidden state (never commits);",
  "               bare show reveals everything",
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
