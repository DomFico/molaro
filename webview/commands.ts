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
import { completeTarget, parseTarget, resolveTarget, type Completion } from "./address.ts";
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
   * light (main.ts flashPointRows; rides the gesture flashRow). */
  flashPointRows(points: readonly number[]): void;
}

export class CommandRegistry {
  private readonly handlers = new Map<string, CommandHandler>();

  register(verb: string, handler: CommandHandler): void {
    this.handlers.set(verb, handler);
  }

  /** Registered verb names (completion pool — grows with every new verb). */
  verbs(): string[] {
    return [...this.handlers.keys()];
  }

  /** Dispatch: leading token = verb, remainder = the handler's argument. */
  runCommand(text: string): CommandResult {
    const trimmed = text.trim();
    if (!trimmed) return { status: "error", message: "empty command" };
    const space = trimmed.search(/\s/);
    const verb = space < 0 ? trimmed : trimmed.slice(0, space);
    const args = space < 0 ? "" : trimmed.slice(space + 1).trim();
    const handler = this.handlers.get(verb);
    if (!handler) return { status: "error", message: `unknown command: ${verb}` };
    return handler(args);
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

/** The viewer's registry with the built-in verbs installed — through the same
 * `register` mechanism any future verb will use. */
export function createCommandRegistry(ctx: CommandContext): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register("view", makeViewHandler(ctx));
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
