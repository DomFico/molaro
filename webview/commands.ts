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
  splitTrailingName,
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
  "  ls [@name|<path>]   list selections / a selection's members / a node's contents",
  "  rename @name [new]  rename a selection · clear  wipe the terminal log",
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
