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
  completeTargetExpr,
  completeToken,
  parseTarget,
  resolveTarget,
  splitLeadingRef,
  splitOnUnquoted,
  splitTrailingName,
  splitTrailingWord,
  type Completion,
  type Segment,
  type TargetAst,
} from "./address.ts";
import type { Binding, ReleaseStats } from "./bindings.ts";
import type { TreeModel } from "./classification.ts";
import {
  AXIS_DOMAIN,
  BIND_AXES,
  BIND_DASH_MAX,
  BIND_SIZE_MAX,
  gateChannelBind,
  mapScalar,
  normalizeScalars,
  OFFSET_AXIS,
  ORIENTATION_AXIS,
  SCALAR_AXES,
  VECTOR_AXES,
  type BindAxis,
  type ScalarAxis,
  type VectorAxis,
  type ChannelDecl,
} from "./channelmap.ts";
import {
  channelProviders,
  getRecipe,
  listRecipes,
  rainbow,
  resolveChannelDependency,
  resolveModSelector,
  resolveParameters,
  type AnalysisMod,
  type Mod,
  type ParamValue,
  type RecipeOrigin,
  channelConsumers,
  machineryNote,
} from "./recipes.ts";
import type { Entry, Hierarchy } from "./sets.ts";

/** The hold gesture's default command template. `{target}` is replaced by the
 * resolved selection. Lives here so the webview default and the host's
 * getConfiguration fallback are ONE value — two spellings of a default is the
 * two-lists shape, and it fails silently (the gesture would work in one context
 * and not the other). `view` is neutral and camera-only: a default gesture should
 * demonstrate the feature without writing state nobody asked for. */
export const DEFAULT_HOLD_COMMAND = "view {target}";

export type CommandStatus = "ok" | "nomatch" | "error";

export interface CommandResult {
  status: CommandStatus;
  message: string;
  /** Set by a verb whose action needs a y/n CONFIRMATION before it runs:
   * the message is the prompt, and the terminal arms its single pending
   * slot — the NEXT input is the answer, never a command. Only `rm` sets
   * this today; the slot is general (webview/prompt.ts) but one-at-a-time
   * by design. */
  confirm?: boolean;
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
  /** colorPoints' PER-ELEMENT sibling — the recipe write path: `rgb` is a
   * flat 3×points.length array giving EACH point its own RGB (0..1), in the
   * points' order. Same buffer, same one-stroke recordOp discipline, same
   * LWW and GPU sync as colorPoints; only the value shape differs. */
  colorPointsEach(points: readonly number[], rgb: readonly number[]): number;
  /** The per-element siblings on the other two point axes — same factory,
   * same discipline (one stroke, LWW, own buffer, GPU sync); `values` is
   * one value per point in the points' order. Consumed by the typed-result
   * binding (claudebind.ts); no verb writes through these yet. */
  sizePointsEach(points: readonly number[], values: readonly number[]): number;
  opacityPointsEach(points: readonly number[], values: readonly number[]): number;
  /** Header channel declarations (width already resolved), for the bake/bind
   * gate — READ surface, real in the validation context too. */
  channels(): ChannelDecl[];
  /** The named channel's per-element values IN HAND at the displayed frame —
   * per_point: the header-carried block (frame null: static); per_point_per_
   * frame: the displayed chunk's zero-copy view at the displayed frame.
   * null = unknown channel, a non-per-element scope, or no data in hand. */
  channelValues(name: string): { values: ArrayLike<number>; frame: number | null } | null;
  /** Register a channel binding AND apply its initial scalars — ONE stroke
   * (the writers' capture + a registry snapshot), so one Ctrl+Z removes the
   * binding and restores prior values together. The binding then re-derives
   * on every displayed-frame flip (raw, unrecorded — derived state).
   * Returns what last-bind-wins took
   * from earlier SAME-AXIS bindings' coverage. */
  createBinding(b: Binding, scalars: readonly number[]): ReleaseStats;
  /** Release binding coverage element-wise, each axis in ITS OWN id space
   * (AXIS_DOMAIN keys the three spaces — point/edge/vertex ids overlap
   * numerically and must never be released with each other's ids). null in
   * a slot = every element of that space; axis null = every axis. One
   * recorded stroke when anything changed. Values stay as last applied —
   * EXCEPT the offset axis, whose released coverage is ZEROED in the same
   * stroke (positions snap back to raw; a frozen per-frame offset would be
   * a broken static shift). `offsetZeroed` reports how many points that
   * zeroing touched (absent/0 = none). */
  releaseBindings(
    sel: {
      points: readonly number[] | null;
      vertices: readonly number[] | null;
      edges: readonly number[] | null;
    },
    axis: BindAxis | null,
  ): ReleaseStats & { offsetZeroed?: number };
  /** Per-element edge/trace writers — the Each siblings of the broadcast
   * writers, for the channel consumers (bake/bind) and any future
   * per-element scalar source. Same one-stroke capture/LWW discipline. */
  colorEdgesEach(edgeIds: readonly number[], rgb: readonly number[]): number;
  /** The PER-ENDPOINT edge-color writer pair (the bicolor primitive):
   * aFlat/bFlat are flat 3×ids.length RGBs in the ids' order — each edge's
   * A half from aFlat, B half from bFlat. ONE composed stroke (both halves'
   * captures fold; one Ctrl+Z restores both), LWW per edge, releases the
   * edge-color binding coverage. `colorEdgesEnds` is the verb's snapshot
   * writer; `colorEdgesEndsEach` the bake/bind sibling — one spine behind
   * both names (the value shape is identical: per-edge A/B triples). */
  colorEdgesEnds(edgeIds: readonly number[], aFlat: readonly number[], bFlat: readonly number[]): number;
  colorEdgesEndsEach(edgeIds: readonly number[], aFlat: readonly number[], bFlat: readonly number[]): number;
  /** READ surface: the live per-point RGB buffer (rep.state.color, length
   * 3N) — the endpoint-color SNAPSHOT source bicolorbonds reads. Real in
   * the validation context too (reads stay real; writes are stubbed). */
  pointColors(): ArrayLike<number>;
  sizeEdgesEach(edgeIds: readonly number[], values: readonly number[]): number;
  opacityEdgesEach(edgeIds: readonly number[], values: readonly number[]): number;
  colorTraceEach(vertexIds: readonly number[], rgb: readonly number[]): number;
  sizeTraceEach(vertexIds: readonly number[], values: readonly number[]): number;
  opacityTraceEach(vertexIds: readonly number[], values: readonly number[]): number;
  /** Style writers (value = the style's REGISTRY INDEX): per-point,
   * per-edge (contained targeting), per-trace-vertex (subgroup map-up —
   * the trace verb family's grain). Style is NOT a bindable axis. */
  stylePoints(points: readonly number[], index: number): number;
  styleEdges(edgeIds: readonly number[], index: number): number;
  styleTrace(vertexIds: readonly number[], index: number): number;
  /** Registered style names, registration order (index = shader index). */
  styleNames(): string[];
  /** name → registry index, -1 unknown (single-sourced from styles.ts). */
  styleIndexOf(name: string): number;
  /** Draw a DOMAIN as a named registered shape (scene-level, per the
   * ruling's fallback — per-target assignment is a parked chapter). One
   * undo op. null = the name isn't registered for the domain. */
  setShape(
    domain: "point" | "edge" | "vertex",
    label: string,
  ): { prev: string | null; requiresAxis?: BindAxis } | null;
  /** The shape registry's read surface: each domain's names + active. */
  shapesInfo(): { domain: "point" | "edge" | "vertex"; names: string[]; active: string | null }[];
  /** Set the scene background to a constant color — TARGETLESS scene state
   * (not per-element; no `all`), session-only. One undo op via recordOp in
   * the implementation; repeating the CURRENT color applies but records
   * NOTHING (the setShape no-op discipline — no hollow undo entry). */
  setBackground(rgb: [number, number, number]): void;
  /** The orientation writer: per-vertex RAW 3-vectors (flat, 3 × ids
   * length) into the stride-3 orientation buffer — the SAME writer core
   * color rides (capture, LWW-clear of same-axis coverage, one stroke,
   * GPU-less dispatch: nothing subscribes yet). STATE-ONLY until O-2. */
  orientationVerticesEach(vertexIds: readonly number[], values: readonly number[]): number;
  /** The offset writer: per-POINT RAW displacement 3-vectors (flat, 3 × ids
   * length) into the stride-3 offset buffer — the same writer core, plus a
   * shown-position refresh so a recorded write (bind's initial apply, undo,
   * redo) moves the drawn positions visibly while paused. Reached only
   * through `bind` (offset is bind-only — bake refuses it). */
  offsetPointsEach(points: readonly number[], values: readonly number[]): number;
  /** The binding registry, read-only (the bindings verb + status badge). */
  listBindings(): readonly Binding[];
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
  /** The polyline vertices in HEADER ORDER (flattened polylines) —
   * traceVertices[v] = that vertex's point index. colortrace maps the
   * resolved point set up to subgroup grain and colors the vertices whose
   * subgroup is active; vertex ids index the trace-color buffer. */
  traceVertices: readonly number[];
  /** colorPoints' POLYLINE twin: write a constant per-vertex RGB on exactly
   * these vertex ids in the trace-color buffer. Same one-stroke recordOp
   * discipline and last-write-wins per vertex; vertices never written keep
   * the uniform base look. Returns the count written. */
  colorTrace(vertexIds: readonly number[], rgb: [number, number, number]): number;
  /** The SIZE axis of the family — the color closures' twins on the size
   * buffers: same one-stroke recordOp discipline, LWW per element, each
   * writing ONLY its primitive's size buffer. Size ⊥ hide: 0 is a literal
   * extent and never touches visibility. Return the count written. */
  sizePoints(points: readonly number[], size: number): number;
  /** bondsize/bondsizeof share the ONE edge-size buffer (as the edge verbs
   * share the edge-color pair). State-only pending impostor geometry — the commands,
   * undo, and buffers are complete; visible thickness lags the renderer. */
  sizeEdges(edgeIds: readonly number[], size: number): number;
  sizeTrace(vertexIds: readonly number[], size: number): number;
  /** dashbonds/dashbondsof share the ONE edge-dash buffer (sizeEdges' exact
   * shape): a constant dash scale per edge, 0 = solid. LWW per edge, one
   * stroke, releases bonddash binding coverage. RENDERS today (the edge
   * tube's dash block). */
  dashEdges(edgeIds: readonly number[], dash: number): number;
  /** The per-element sibling for the channel consumers (bake/bind). */
  dashEdgesEach(edgeIds: readonly number[], values: readonly number[]): number;
  /** The OPACITY axis — the third scalar axis on the same writer/predicate
   * machinery. OPACITY ⊥ HIDE: 0 is invisible-but-present (in the scene,
   * pickable), never a hide. Alpha is a SEPARATE buffer per primitive — the
   * RGB color buffers stay RGB, so color and opacity stay independent.
   * Renders via naive blending; overlap compositing is a recorded
   * follow-up (draw-order/OIT). Return the count written. */
  opacityPoints(points: readonly number[], opacity: number): number;
  /** bondopacity/bondopacityof share the ONE edge-opacity buffer. */
  opacityEdges(edgeIds: readonly number[], opacity: number): number;
  opacityTrace(vertexIds: readonly number[], opacity: number): number;
  /** Type A (analysis) mods: fire the producer round-trip for `mod` on the
   * resolved indices. Fire-and-forget from the verb's view — the sync
   * return is the "running…" line; the outcome arrives asynchronously
   * (validated FAIL-CLOSED, bound through the EXISTING rails per the mod's
   * declared `produces`, reported as a follow-up terminal line). */
  runAnalysisMod(
    mod: AnalysisMod,
    points: number[],
    expr: string,
    params?: Record<string, ParamValue>,
  ): void;
  /** rm: stash the workspace mod names awaiting the terminal's y answer
   * (a single slot — a newer rm replaces it). On confirmation the wiring
   * deletes files HOST-side FIRST, then unregisters only what succeeded,
   * so the registry re-derives from disk truth. NOT undoable and NOT on
   * the undo stack — the filesystem is outside the undo model. */
  armRmDeletion(names: string[]): void;
}

export class CommandRegistry {
  private readonly entries = new Map<string, { handler: CommandHandler; description: string }>();
  private readonly builtins = new Set<string>();

  register(verb: string, handler: CommandHandler, description = ""): void {
    this.entries.set(verb, { handler, description });
  }

  /** Freeze the verbs registered SO FAR as the built-ins — called once by
   * createCommandRegistry, after the built-in verbs are in and before any mod
   * can be installed. Everything registered afterwards is a mod's own verb.
   *
   * This distinction is the whole point: "is this name a built-in" is NOT the
   * same question as "is this name currently a verb", because a mod's verb is
   * registered by the installer itself. Conflating the two made every re-push of
   * an existing mod look like a built-in collision, so it was skipped — and the
   * viewer kept running the mod's PREVIOUS code. */
  sealBuiltins(): void {
    for (const verb of this.entries.keys()) this.builtins.add(verb);
  }

  /** True only for a verb that was present at seal time. An unsealed registry
   * has no built-ins — a mod verb never becomes one by being registered. */
  isBuiltin(verb: string): boolean {
    return this.builtins.has(verb);
  }

  /** Remove a verb (rm's deregistration of a deleted mod's own-verb — the
   * only caller; built-ins are never unregistered). */
  unregister(verb: string): boolean {
    return this.entries.delete(verb);
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

/** The scalar axes' shared numeric core: a plain finite number or null. */
function parseNumericToken(token: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) return null;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/** Parse a size token — a plain non-negative number (1.5, 0, 3). A NEGATIVE
 * clamps to 0 with the clamp flagged so the verb reports it (a negative
 * extent is meaningless; clamping beats rejection for obvious intent).
 * null = not a number. Size and hide are ORTHOGONAL channels: 0 is a
 * literal zero-extent, never a hide. */
export function parseSize(token: string): { size: number; clamped: boolean } | null {
  const n = parseNumericToken(token);
  if (n === null) return null;
  return n < 0 ? { size: 0, clamped: true } : { size: n, clamped: false };
}

/** Parse an opacity token — a number CLAMPED to [0, 1] (the two-sided
 * version of size's negative clamp; clampedTo reports which bound fired).
 * null = not a number. OPACITY ⊥ HIDE: 0 is a literal, legal alpha — an
 * invisible-but-PRESENT element (still in the scene, still pickable); a
 * hidden element is gone. The two channels never touch each other. */
export function parseOpacity(token: string): { opacity: number; clampedTo: 0 | 1 | null } | null {
  const n = parseNumericToken(token);
  if (n === null) return null;
  if (n < 0) return { opacity: 0, clampedTo: 0 };
  if (n > 1) return { opacity: 1, clampedTo: 1 };
  return { opacity: n, clampedTo: null };
}

/** The representation families' shared argument/target front half — generic
 * over the trailing VALUE token, so the color and size axes CANNOT diverge
 * on argument shape or resolution: split the trailing token, validate it,
 * parse the expression, and resolve to the deduped point union — hidden
 * points included, never committing: view's EXACT resolution, so every
 * family verb works off the point set `view <target>` frames. Errors/
 * nomatch come back as the CommandResult; success carries the points, the
 * parsed value, and the split for the verb's own wording. */
function resolveRepArgs<T>(
  ctx: CommandContext,
  verb: string,
  args: string,
  noun: string,
  example: string,
  parse: (word: string) => T | null,
  badValue: (word: string) => string,
): { points: number[]; value: T; expr: string; word: string } | CommandResult {
  const split = splitTrailingWord(args);
  if (split.word === null) {
    const art = /^[aeiou]/.test(noun) ? "an" : "a";
    return {
      status: "error",
      message: `${verb} needs a target and ${art} ${noun} — ${verb} <target> <${noun}> (e.g. ${verb} alpha ${example})`,
    };
  }
  const value = parse(split.word);
  if (value === null) return { status: "error", message: badValue(split.word) };
  const r = resolveTargetPoints(ctx, split.expr);
  if ("status" in r) return r;
  return { points: r.points, value, expr: split.expr, word: split.word };
}

/** The resolve-and-dedupe core the whole representation family targets
 * through — parse, resolve, and union the entries' points (hidden ones
 * included): view's EXACT resolution and dedupe, factored out of
 * resolveRepArgs so verbs WITHOUT a trailing value token (the recipes) hit
 * the same code, never a re-implementation. Errors/nomatch come back as the
 * CommandResult. Exported for the typed-result binding (claudebind.ts) —
 * the same header-ordered point set, never a local copy. */
export function resolveTargetPoints(
  ctx: CommandContext,
  expr: string,
): { points: number[] } | CommandResult {
  const ast = parseTarget(expr);
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
    return { status: "nomatch", message: `nothing matches "${expr}"` };
  }
  return { points };
}

function resolveColorArgs(ctx: CommandContext, verb: string, args: string) {
  return resolveRepArgs(ctx, verb, args, "color", "green", parseColor,
    (w) => `unknown color "${w}" — use a CSS color name (red, steelblue) or hex (#ff8800)`);
}

function resolveSizeArgs(ctx: CommandContext, verb: string, args: string) {
  return resolveRepArgs(ctx, verb, args, "size", "1.5", parseSize,
    (w) => `not a size: "${w}" — use a non-negative number (e.g. 1.5 or 0)`);
}

function resolveOpacityArgs(ctx: CommandContext, verb: string, args: string) {
  return resolveRepArgs(ctx, verb, args, "opacity", "0.5", parseOpacity,
    (w) => `not an opacity: "${w}" — use a number from 0 to 1 (e.g. 0.5)`);
}

/** The edge-mapping predicate, written ONCE for BOTH axes (colorbonds/
 * bondsize = both endpoints in the set; colorbondsof/bondsizeof = at least
 * one — the incident reach). Matching edge ids, header order. */
function edgesMatching(
  edges: readonly [number, number][],
  points: readonly number[],
  both: boolean,
): number[] {
  const inSet = new Set(points);
  const ids: number[] = [];
  for (let e = 0; e < edges.length; e++) {
    const [a, b] = edges[e];
    if (both ? inSet.has(a) && inSet.has(b) : inSet.has(a) || inSet.has(b)) ids.push(e);
  }
  return ids;
}

/** The subgroup map-up, written ONCE for BOTH axes (colortrace/tracesize):
 * polyline vertices whose subgroup contains ≥1 resolved point. */
function activeTraceVertexIds(ctx: CommandContext, points: readonly number[]): number[] {
  const active = new Set<number>();
  for (const p of points) active.add(ctx.hierarchy.subgroupOfPoint(p));
  const ids: number[] = [];
  for (let v = 0; v < ctx.traceVertices.length; v++) {
    if (active.has(ctx.hierarchy.subgroupOfPoint(ctx.traceVertices[v]))) ids.push(v);
  }
  return ids;
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
    const n = ctx.colorPoints(r.points, r.value);
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
    const edgeIds = edgesMatching(ctx.edges, r.points, both);
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${r.expr}"`
          : `no edges touching "${r.expr}"`,
      };
    }
    const n = ctx.colorEdges(edgeIds, r.value);
    return { status: "ok", message: `colored ${n} edges ${r.word}` };
  };
}

/**
 * `bicolorbonds <target>` / `bicolorbondsof <target>` — the endpoint-color
 * SNAPSHOT pair: each matched edge's two halves take their endpoint points'
 * CURRENT `color` values (read at execution time — a later colorpoints does
 * NOT retro-update the edge; run the verb again to re-snapshot). No color
 * token by design (rainbow's shape: the values are computed, not passed) —
 * and no two-argument color form exists. Targeting is the colorbonds pair's
 * exactly: same resolver, same edgesMatching predicates (contained vs
 * incident), same nomatch wording. Writes the edgeColorA/edgeColorB PAIR in
 * one stroke (LWW per edge; colorbonds and bicolorbonds compose by
 * last-write-wins, since both write the same pair).
 */
export function makeBicolorBondsHandler(
  ctx: CommandContext,
  verb: "bicolorbonds" | "bicolorbondsof",
): CommandHandler {
  const both = verb === "bicolorbonds";
  return (args: string): CommandResult => {
    const expr = args.trim();
    if (expr === "") {
      return {
        status: "error",
        message: `${verb} needs a target — ${verb} <target> (e.g. ${verb} alpha.group-0)`,
      };
    }
    const r = resolveTargetPoints(ctx, expr);
    if ("status" in r) return r;
    const edgeIds = edgesMatching(ctx.edges, r.points, both);
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${expr}"`
          : `no edges touching "${expr}"`,
      };
    }
    // The snapshot: each half from ITS endpoint's current point color.
    const colors = ctx.pointColors();
    const aFlat = new Array<number>(edgeIds.length * 3);
    const bFlat = new Array<number>(edgeIds.length * 3);
    for (let i = 0; i < edgeIds.length; i++) {
      const [a, b] = ctx.edges[edgeIds[i]];
      for (let c = 0; c < 3; c++) {
        aFlat[i * 3 + c] = colors[a * 3 + c];
        bFlat[i * 3 + c] = colors[b * 3 + c];
      }
    }
    const n = ctx.colorEdgesEnds(edgeIds, aFlat, bFlat);
    return { status: "ok", message: `bicolored ${n} edges from their endpoints' colors` };
  };
}

/**
 * `colortrace <target> <color>` — the POLYLINE member of the family,
 * completing it (four verbs: point / edge-both / edge-either /
 * subgroup-vertex). Per-VERTEX color, mapped UP to the subgroup level: the
 * target resolves to the family's usual point set, `active` = the subgroups
 * containing ≥1 resolved point, and vertex V colors iff subgroup(V) is
 * active. That keeps the containment discipline — no vertex outside the
 * target's subgroups ever colors; the map-up is resolution-to-primitive-
 * GRANULARITY (a single point activates its whole subgroup's vertex), not
 * colorbondsof's deliberate reach-out. Segments between a colored and an
 * uncolored vertex render as a GRADIENT (colored → base look) — inherent to
 * per-vertex color and intended; there is no per-segment rule. On the
 * synthetic data a single-category target colors a SCATTERED, dashed-looking
 * vertex set (the polyline's categories cycle) — correct, pinned by S17.
 * Active subgroups owning no polyline vertices = nomatch, nothing written.
 */
export function makeColorTraceHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveColorArgs(ctx, "colortrace", args);
    if ("status" in r) return r;
    const vertexIds = activeTraceVertexIds(ctx, r.points);
    if (vertexIds.length === 0) {
      return { status: "nomatch", message: `no trace vertices in "${r.expr}"` };
    }
    const n = ctx.colorTrace(vertexIds, r.value);
    return { status: "ok", message: `colored ${n} trace vertices ${r.word}` };
  };
}

/** `set N <noun> to size S`, with the clamp note when a negative clamped. */
function sizedMsg(n: number, noun: string, v: { size: number; clamped: boolean }): string {
  return `set ${n} ${noun} to size ${v.size}${v.clamped ? " (clamped to 0)" : ""}`;
}

/**
 * The SIZE family — `pointsize` / `bondsize` / `bondsizeof` / `tracesize` —
 * clones the color family verb-for-verb: same shared front half
 * (resolveRepArgs → identical resolution), same map-up grains through the
 * SAME predicate functions (edgesMatching / activeTraceVertexIds — written
 * once, never re-implemented per axis), same one-stroke recordOp discipline,
 * LWW per element, own buffer only. Together the two axes form the grid
 * {point, edge-both, edge-either, subgroup-vertex} × {color, size}.
 *
 * Size semantics: 0 is a LITERAL extent — it never hides (size ⊥ hide; a
 * zero-extent element may draw no pixels, which is not a reason to couple
 * the channels). Negatives clamp to 0 and the message says so. bondsizeof's
 * incident reach mirrors colorbondsof exactly: on a single named element it
 * sizes that element's incident edges unambiguously (the primary use); on a
 * broad target, a boundary edge shared with a neighboring region resolves
 * last-write-wins if a later command touches the neighbor — inherent to
 * incident semantics, identical to color, documented rather than prevented.
 */
export function makePointSizeHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveSizeArgs(ctx, "pointsize", args);
    if ("status" in r) return r;
    const n = ctx.sizePoints(r.points, r.value.size);
    return { status: "ok", message: sizedMsg(n, "points", r.value) };
  };
}

export function makeBondSizeHandler(
  ctx: CommandContext,
  verb: "bondsize" | "bondsizeof",
): CommandHandler {
  const both = verb === "bondsize";
  return (args: string): CommandResult => {
    const r = resolveSizeArgs(ctx, verb, args);
    if ("status" in r) return r;
    const edgeIds = edgesMatching(ctx.edges, r.points, both);
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${r.expr}"`
          : `no edges touching "${r.expr}"`,
      };
    }
    const n = ctx.sizeEdges(edgeIds, r.value.size);
    return { status: "ok", message: sizedMsg(n, "edges", r.value) };
  };
}

export function makeTraceSizeHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveSizeArgs(ctx, "tracesize", args);
    if ("status" in r) return r;
    const vertexIds = activeTraceVertexIds(ctx, r.points);
    if (vertexIds.length === 0) {
      return { status: "nomatch", message: `no trace vertices in "${r.expr}"` };
    }
    const n = ctx.sizeTrace(vertexIds, r.value.size);
    return { status: "ok", message: sizedMsg(n, "trace vertices", r.value) };
  };
}

/**
 * `dashbonds <target> <scale>` / `dashbondsof <target> <scale>` — the DASH
 * pair, cloning the bondsize pair verb-for-verb: same shared front half
 * (resolveRepArgs; the value token rides parseSize — a non-negative number,
 * negatives clamping to 0 with the clamp reported), same edgesMatching
 * predicates (contained vs incident), same one-stroke/LWW/own-buffer
 * discipline on the edgeDash buffer. 0 = SOLID (the base look, and a
 * literal legal value — never a hide); >0 dashes the tube with a
 * world-length period proportional to the scale (zoom-stable: zooming
 * magnifies dashes with the geometry). Dash ⊥ color/size/opacity: it
 * composes with all three on the same edge.
 */
export function makeDashBondsHandler(
  ctx: CommandContext,
  verb: "dashbonds" | "dashbondsof",
): CommandHandler {
  const both = verb === "dashbonds";
  return (args: string): CommandResult => {
    const r = resolveRepArgs(ctx, verb, args, "dash scale", "1.5", parseSize,
      (w) => `not a dash scale: "${w}" — use a non-negative number (0 = solid, e.g. 1.5)`);
    if ("status" in r) return r;
    const edgeIds = edgesMatching(ctx.edges, r.points, both);
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${r.expr}"`
          : `no edges touching "${r.expr}"`,
      };
    }
    const n = ctx.dashEdges(edgeIds, r.value.size);
    return {
      status: "ok",
      message: `set ${n} edges to dash ${r.value.size}${
        r.value.clamped ? " (clamped to 0)" : ""
      }${r.value.size === 0 ? " (solid)" : ""}`,
    };
  };
}

/** `set N <noun> to opacity A`, with the bound named when a clamp fired. */
function opacityMsg(n: number, noun: string, v: { opacity: number; clampedTo: 0 | 1 | null }): string {
  return `set ${n} ${noun} to opacity ${v.opacity}${
    v.clampedTo === null ? "" : ` (clamped to ${v.clampedTo})`
  }`;
}

/**
 * The OPACITY family — `pointopacity` / `bondopacity` / `bondopacityof` /
 * `traceopacity` — the third and final scalar axis, completing the
 * twelve-verb grid {point, edge-both, edge-either, subgroup-vertex} ×
 * {color, size, opacity}. A pure third wrapper on the shared machinery:
 * resolveRepArgs front half (parseOpacity is the only new part),
 * edgesMatching / activeTraceVertexIds predicates reused unchanged, the
 * same writer factory behind the ctx closures. Semantics mirror size:
 * opacity 0 is LITERAL — invisible-but-present, never a hide (the element
 * stays in the scene, stays pickable, hide-state untouched — exactly what
 * makes "fade to fully transparent while keeping it selectable"
 * expressible); out-of-range clamps to [0,1] two-sidedly with the bound
 * reported. bondopacityof's incident reach and broad-target boundary-edge
 * LWW follow the color/size precedent — documented, not special-cased.
 * Rendering note: per-element alpha blends NAIVELY (no depth sorting) —
 * overlapping translucency may mis-composite; a recorded follow-up.
 */
export function makePointOpacityHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveOpacityArgs(ctx, "pointopacity", args);
    if ("status" in r) return r;
    const n = ctx.opacityPoints(r.points, r.value.opacity);
    return { status: "ok", message: opacityMsg(n, "points", r.value) };
  };
}

export function makeBondOpacityHandler(
  ctx: CommandContext,
  verb: "bondopacity" | "bondopacityof",
): CommandHandler {
  const both = verb === "bondopacity";
  return (args: string): CommandResult => {
    const r = resolveOpacityArgs(ctx, verb, args);
    if ("status" in r) return r;
    const edgeIds = edgesMatching(ctx.edges, r.points, both);
    if (edgeIds.length === 0) {
      return {
        status: "nomatch",
        message: both
          ? `no edges with both endpoints in "${r.expr}"`
          : `no edges touching "${r.expr}"`,
      };
    }
    const n = ctx.opacityEdges(edgeIds, r.value.opacity);
    return { status: "ok", message: opacityMsg(n, "edges", r.value) };
  };
}

export function makeTraceOpacityHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveOpacityArgs(ctx, "traceopacity", args);
    if ("status" in r) return r;
    const vertexIds = activeTraceVertexIds(ctx, r.points);
    if (vertexIds.length === 0) {
      return { status: "nomatch", message: `no trace vertices in "${r.expr}"` };
    }
    const n = ctx.opacityTrace(vertexIds, r.value.opacity);
    return { status: "ok", message: opacityMsg(n, "trace vertices", r.value) };
  };
}

/** The recipes' mapping-and-write step, SOURCE-AGNOSTIC on purpose: it takes
 * an array of per-element scalars (it never knows which recipe — or future
 * scalar source — computed them), maps each through the colormap, and writes
 * the point-color buffer through the per-element writer (one recordOp
 * stroke, LWW, GPU sync — colorPoints' exact discipline). This split is the
 * reason the recipe contract is scalar-then-colormap rather than a direct
 * RGB function; do not collapse it. */
export function applyColorScalars(
  ctx: CommandContext,
  points: readonly number[],
  scalars: readonly number[],
  colormap: (t: number) => [number, number, number],
): number {
  const rgb = new Array<number>(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const [r, g, b] = colormap(scalars[i]);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return ctx.colorPointsEach(points, rgb);
}

/**
 * `rainbow <target>` — the FIRST RECIPE verb: where the twelve fixed verbs
 * write one constant, a recipe COMPUTES a per-element value from the
 * resolved set (rainbow: an even 0→1 ramp across the points in resolution
 * order, through the built-in hue sweep). No trailing value token — the
 * whole argument is the target expression, resolved through the SAME
 * resolve-and-dedupe core the fixed verbs use (view's exact point set).
 * The handler resolves the recipe BY NAME from the recipe registry and runs
 * it — never a hardcoded compute — so the recipe object is the invocable
 * unit later recipes clone. Same family invariants: one undo stroke, LWW,
 * nomatch/error writes nothing, message reports the action and count.
 */
export function makeRainbowHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const expr = args.trim();
    if (expr === "") {
      return {
        status: "error",
        message: "rainbow needs a target — rainbow <target> (e.g. rainbow alpha.group-0)",
      };
    }
    const recipe = getRecipe("rainbow");
    if (!recipe || recipe.kind !== "representation") {
      return { status: "error", message: 'no representation mod named "rainbow"' };
    }
    const r = resolveTargetPoints(ctx, expr);
    if ("status" in r) return r;
    const scalars = recipe.compute(r.points);
    const n = applyColorScalars(ctx, r.points, scalars, recipe.colormap);
    return { status: "ok", message: `colored ${n} points rainbow` };
  };
}

/** The [0,1]-scalar→axis application, written ONCE for every scalar source —
 * the bake verb and the typed-result binding (claudebind.ts) both land here:
 * color through the built-in colormap, size through the fixed 0..BIND_SIZE_MAX
 * visual range, opacity as-is. One per-element writer stroke; the caller owns
 * normalization. `bondcolorends` alone takes TWO scalars per element
 * (interleaved [A0,B0,A1,B1,…] — resolveChannelAxis's per-endpoint carry);
 * every other axis takes one. */
export function applyScalarsToAxis(
  ctx: CommandContext,
  axis: ScalarAxis,
  ids: readonly number[],
  scalars: readonly number[],
): number {
  const rgbOf = (ts: readonly number[]): number[] => {
    const rgb = new Array<number>(ts.length * 3);
    for (let i = 0; i < ts.length; i++) {
      const [cr, cg, cb] = rainbow.colormap(ts[i]);
      rgb[i * 3] = cr;
      rgb[i * 3 + 1] = cg;
      rgb[i * 3 + 2] = cb;
    }
    return rgb;
  };
  switch (axis) {
    case "color": return applyColorScalars(ctx, ids, scalars, rainbow.colormap);
    case "size": return ctx.sizePointsEach(ids, scalars.map((t) => t * BIND_SIZE_MAX));
    case "opacity": return ctx.opacityPointsEach(ids, scalars);
    case "bondcolor": return ctx.colorEdgesEach(ids, rgbOf(scalars));
    case "bondcolorends": {
      // de-interleave the per-endpoint pairs into the two halves' colormapped RGBs
      const aFlat = new Array<number>(ids.length * 3);
      const bFlat = new Array<number>(ids.length * 3);
      for (let i = 0; i < ids.length; i++) {
        const [ar, ag, ab] = rainbow.colormap(scalars[i * 2]);
        aFlat[i * 3] = ar;
        aFlat[i * 3 + 1] = ag;
        aFlat[i * 3 + 2] = ab;
        const [br, bg, bb] = rainbow.colormap(scalars[i * 2 + 1]);
        bFlat[i * 3] = br;
        bFlat[i * 3 + 1] = bg;
        bFlat[i * 3 + 2] = bb;
      }
      return ctx.colorEdgesEndsEach(ids, aFlat, bFlat);
    }
    case "bondsize": return ctx.sizeEdgesEach(ids, scalars.map((t) => t * BIND_SIZE_MAX));
    case "bonddash": return ctx.dashEdgesEach(ids, scalars.map((t) => t * BIND_DASH_MAX));
    case "bondopacity": return ctx.opacityEdgesEach(ids, scalars);
    case "tracecolor": return ctx.colorTraceEach(ids, rgbOf(scalars));
    case "tracesize": return ctx.sizeTraceEach(ids, scalars.map((t) => t * BIND_SIZE_MAX));
    case "traceopacity": return ctx.opacityTraceEach(ids, scalars);
  }
}

/** The bake/bind SHARED argument front half: walk trailing words back to
 * front — [<min> <max>] when the last word is numeric, then <axis>, then
 * <channel>; the remainder is the target expression (which may itself
 * contain spaces). ONE parser for both verbs (resolveRepArgs' discipline:
 * shared shape, impossible drift). */
function parseChannelAxisArgs(
  verb: string,
  usage: string,
  args: string,
): { expr: string; channel: string; axisWord: string; explicitRange: [number, number] | null } | CommandResult {
  const needs: CommandResult = {
    status: "error",
    message: `${verb} needs a target, a channel, and an axis — ${usage}`,
  };
  const w1 = splitTrailingWord(args);
  if (w1.word === null) return needs;
  let explicitRange: [number, number] | null = null;
  let axisWord: string;
  let rest: string;
  const hi = parseNumericToken(w1.word);
  if (hi !== null) {
    const w2 = splitTrailingWord(w1.expr);
    const lo = w2.word === null ? null : parseNumericToken(w2.word);
    if (lo === null) {
      return { status: "error", message: `an explicit range needs BOTH bounds — ${usage}` };
    }
    explicitRange = [lo, hi];
    const w3 = splitTrailingWord(w2.expr);
    if (w3.word === null) return needs;
    axisWord = w3.word;
    rest = w3.expr;
  } else {
    axisWord = w1.word;
    rest = w1.expr;
  }
  const w4 = splitTrailingWord(rest);
  if (w4.word === null || w4.expr === "") return needs;
  return { expr: w4.expr, channel: w4.word, axisWord, explicitRange };
}

/** The bake/bind SHARED resolve half: declaration lookup (loud with the
 * channel list), target resolution (view's exact core), the gate, and the
 * value extraction — everything up to "what happens with the values", which
 * is the ONLY place the two verbs differ. Two result kinds:
 *   "scalar" — normalized [0,1] scalars over the axis's OWN element domain:
 *     point axes → the point's value over POINT ids; trace axes → the
 *     vertex's OWN point's value over VERTEX ids (direct membership; the
 *     trace verbs' subgroup map-up is a constant-write convenience, not a
 *     data read); edge axes → the ENDPOINT MEAN over CONTAINED edge ids
 *     (both endpoints resolved — colorbonds' rule; mean of raws, THEN the
 *     lens) — EXCEPT `bondcolorends`, which carries BOTH endpoint scalars
 *     per edge (interleaved [A,B]; no mean — the per-endpoint axis).
 *   "vector" — a vector axis, RAW 3-vectors over the axis's OWN domain
 *     (AXIS_DOMAIN): orientation → VERTEX ids, each vertex its point's
 *     vector (the map-up); offset → POINT ids, each point its own vector.
 */
function resolveChannelAxis(
  ctx: CommandContext,
  verb: string,
  usage: string,
  args: string,
):
  | {
      kind: "scalar";
      domain: "point" | "edge" | "vertex";
      ids: number[];
      scalars: number[];
      range: [number, number];
      channel: string;
      axis: ScalarAxis;
      expr: string;
      frame: number | null;
    }
  | {
      kind: "vector";
      axis: VectorAxis;
      ids: number[];
      values: number[];
      channel: string;
      expr: string;
      frame: number | null;
    }
  | CommandResult {
  const p = parseChannelAxisArgs(verb, usage, args);
  if ("status" in p) return p;
  const decl = ctx.channels().find((c) => c.name === p.channel);
  if (!decl) {
    const names = ctx.channels().map((c) => c.name);
    return {
      status: "error",
      message: `no channel named "${p.channel}"${
        names.length > 0 ? ` — channels: ${names.join(", ")}` : " — this dataset declares none"
      }`,
    };
  }
  const r = resolveTargetPoints(ctx, p.expr);
  if ("status" in r) return r;
  const inHand = ctx.channelValues(p.channel);
  const gate = gateChannelBind(decl, p.axisWord, p.explicitRange, inHand ? inHand.values : null);
  if ("error" in gate) return { status: "error", message: gate.error };
  if ((VECTOR_AXES as readonly string[]).includes(p.axisWord)) {
    const vAxis = p.axisWord as VectorAxis;
    const src = inHand!.values;
    if (AXIS_DOMAIN[vAxis] === "vertex") {
      // orientation: VERTEX ids, each vertex reads ITS point's vector.
      const inSet = new Set(r.points);
      const ids: number[] = [];
      for (let v = 0; v < ctx.traceVertices.length; v++) {
        if (inSet.has(ctx.traceVertices[v])) ids.push(v);
      }
      if (ids.length === 0) {
        return {
          status: "nomatch",
          message: `no polyline vertices in "${p.expr}" — ${vAxis} lives on the polyline domain`,
        };
      }
      const values = new Array<number>(ids.length * 3);
      for (let i = 0; i < ids.length; i++) {
        const at = ctx.traceVertices[ids[i]] * 3;
        values[i * 3] = src[at];
        values[i * 3 + 1] = src[at + 1];
        values[i * 3 + 2] = src[at + 2];
      }
      return { kind: "vector", axis: vAxis, ids, values, channel: p.channel, expr: p.expr, frame: inHand!.frame };
    }
    // offset: POINT ids, each point its OWN vector — no map, no mean.
    const ids = r.points;
    const values = new Array<number>(ids.length * 3);
    for (let i = 0; i < ids.length; i++) {
      const at = ids[i] * 3;
      values[i * 3] = src[at];
      values[i * 3 + 1] = src[at + 1];
      values[i * 3 + 2] = src[at + 2];
    }
    return { kind: "vector", axis: vAxis, ids, values, channel: p.channel, expr: p.expr, frame: inHand!.frame };
  }
  const axis = p.axisWord as ScalarAxis;
  const domain = AXIS_DOMAIN[axis];
  const src = inHand!.values;
  const range = gate.range!;
  let ids: number[];
  let scalars: number[];
  if (domain === "vertex") {
    const inSet = new Set(r.points);
    ids = [];
    for (let v = 0; v < ctx.traceVertices.length; v++) {
      if (inSet.has(ctx.traceVertices[v])) ids.push(v);
    }
    if (ids.length === 0) {
      return {
        status: "nomatch",
        message: `no polyline vertices in "${p.expr}" — ${axis} lives on the polyline domain`,
      };
    }
    scalars = normalizeScalars(src, ids.map((v) => ctx.traceVertices[v]), range);
  } else if (domain === "edge") {
    ids = edgesMatching(ctx.edges, r.points, true); // CONTAINED — colorbonds' rule
    if (ids.length === 0) {
      return {
        status: "nomatch",
        message: `no edges contained in "${p.expr}" — ${axis} lives on the edge domain (both endpoints must resolve)`,
      };
    }
    if (axis === "bondcolorends") {
      // PER-ENDPOINT (no mean — the axis's whole point): carry BOTH endpoint
      // scalars per contained edge, interleaved [A,B] in edge order; the
      // apply half de-interleaves into the two color halves.
      scalars = [];
      for (const e of ids) {
        const [a, b] = ctx.edges[e];
        scalars.push(
          mapScalar(Number(src[a]), range[0], range[1]),
          mapScalar(Number(src[b]), range[0], range[1]),
        );
      }
    } else {
      // The ruled combining rule: the edge's raw value is the MEAN of its two
      // endpoints' channel values, then the normalization lens.
      scalars = ids.map((e) => {
        const [a, b] = ctx.edges[e];
        return mapScalar((Number(src[a]) + Number(src[b])) / 2, range[0], range[1]);
      });
    }
  } else {
    ids = r.points;
    scalars = normalizeScalars(src, ids, range);
  }
  return {
    kind: "scalar",
    domain,
    ids,
    scalars,
    range,
    channel: p.channel,
    axis,
    expr: p.expr,
    frame: inHand!.frame,
  };
}

/** The unit noun for a scalar result's element domain (messages/listings). */
function domainNoun(domain: "point" | "edge" | "vertex"): string {
  return domain === "point" ? "points" : domain === "edge" ? "edges" : "vertices";
}

/** The verb-facing domain tokens (the family vocabulary: points/bonds/
 * traces) → the registry's element domains. */
const SHAPE_DOMAINS = { points: "point", bonds: "edge", traces: "vertex" } as const;

/** `shape <domain> <name>` — draw a whole DOMAIN as a named registered
 * shape (points | bonds | traces; scene-level by ruling — the per-target
 * form is a parked chapter). One undo op; `shapes` lists the registry. */
export function makeShapeHandler(ctx: CommandContext): CommandHandler {
  const usage = "shape <domain> <name> (domain: points | bonds | traces; see `shapes`)";
  return (args: string): CommandResult => {
    const words = args.trim().split(/\s+/).filter((w) => w !== "");
    if (words.length !== 2) {
      return { status: "error", message: `shape needs a domain and a shape name — ${usage}` };
    }
    const [domWord, label] = words;
    const domain = (SHAPE_DOMAINS as Record<string, "point" | "edge" | "vertex">)[domWord];
    if (!domain) {
      return {
        status: "error",
        message: `unknown domain "${domWord}" — use ${Object.keys(SHAPE_DOMAINS).join(" | ")}`,
      };
    }
    const r = ctx.setShape(domain, label);
    if (r === null) {
      const info = ctx.shapesInfo().find((i) => i.domain === domain);
      return {
        status: "error",
        message: `no shape "${label}" for ${domWord} — registered: ${info?.names.join(", ") ?? "none"}`,
      };
    }
    // A shape that READS a bindable axis has no geometry without a binding
    // there — enabling it then draws NOTHING, which must never read as a
    // silent failure. Say so, with the fix in hand.
    const warn =
      r.requiresAxis !== undefined &&
      !ctx.listBindings().some((b) => b.axis === r.requiresAxis)
        ? ` — NOTE: ${label} reads the ${r.requiresAxis} axis and nothing is bound to it, so nothing will draw (bind a vector channel: bind <target> <channel> ${r.requiresAxis})`
        : "";
    return {
      status: "ok",
      message: (r.prev === label
        ? `${domWord} already draw as ${label}`
        : `${domWord} now draw as ${label} (was ${r.prev ?? "none"})`) + warn,
    };
  };
}

/** `background <color>` — set the scene background. TARGETLESS by decision:
 * the background is scene state, not per-element, so there is no target (no
 * `all`) — exactly one color token. Bare `background`, extra tokens, or a
 * non-color are quiet errors (the color family's discipline: error result,
 * no write, no stroke). The color vocabulary and the bad-color wording are
 * resolveColorArgs' EXACTLY — one parser (parseColor), one message. */
export function makeBackgroundHandler(ctx: CommandContext): CommandHandler {
  const usage = "background <color> (e.g. background navy)";
  return (args: string): CommandResult => {
    const words = args.trim().split(/\s+/).filter((w) => w !== "");
    if (words.length !== 1) {
      return { status: "error", message: `background needs exactly one color — ${usage}` };
    }
    const rgb = parseColor(words[0]);
    if (rgb === null) {
      return {
        status: "error",
        message: `unknown color "${words[0]}" — use a CSS color name (red, steelblue) or hex (#ff8800)`,
      };
    }
    ctx.setBackground(rgb);
    return { status: "ok", message: `background → ${words[0]}` };
  };
}

/** `shapes` — read-only listing of the shape registry per domain. */
export function makeShapesHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (args.trim() !== "") {
      return { status: "error", message: "shapes takes no arguments — it lists the shape registry" };
    }
    const names = Object.entries(SHAPE_DOMAINS) as ["points" | "bonds" | "traces", "point" | "edge" | "vertex"][];
    const rows = names.map(([word, domain]) => {
      const info = ctx.shapesInfo().find((i) => i.domain === domain);
      const list = (info?.names ?? []).map((n) => (n === info?.active ? `${n} (active)` : n));
      return `  ${word}: ${list.length > 0 ? list.join("  ") : "none"}`;
    });
    return { status: "ok", message: ["shapes:", ...rows].join("\n") };
  };
}

/** The style verbs' shared front half — resolveRepArgs with the trailing
 * word being a REGISTERED STYLE NAME (resolved to its registry index). */
function resolveStyleArgs(ctx: CommandContext, verb: string, args: string) {
  return resolveRepArgs(ctx, verb, args, "style", "matte",
    (w) => {
      const index = ctx.styleIndexOf(w);
      return index >= 0 ? { index, name: w } : null;
    },
    (w) => `unknown style "${w}" — styles: ${ctx.styleNames().join(", ")}`);
}

/** `stylepoints <target> <style>` — select a registered style's shading
 * parameters for the target's points (per-element style INDEX; LWW; one
 * undo stroke; `standard` restores the default look exactly). */
export function makeStylePointsHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveStyleArgs(ctx, "stylepoints", args);
    if ("status" in r) return r;
    const n = ctx.stylePoints(r.points, r.value.index);
    return { status: "ok", message: `styled ${n} points ${r.value.name}` };
  };
}

/** `stylebonds <target> <style>` — the contained-edge twin (both endpoints
 * in the target — colorbonds' rule). */
export function makeStyleBondsHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveStyleArgs(ctx, "stylebonds", args);
    if ("status" in r) return r;
    const ids = edgesMatching(ctx.edges, r.points, true);
    if (ids.length === 0) {
      return { status: "nomatch", message: `no edges are contained in "${r.expr}"` };
    }
    const n = ctx.styleEdges(ids, r.value.index);
    return { status: "ok", message: `styled ${n} edges ${r.value.name}` };
  };
}

/** `styletrace <target> <style>` — the subgroup map-up twin (colortrace's
 * grain: vertices whose subgroup holds a resolved point). */
export function makeStyleTraceHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const r = resolveStyleArgs(ctx, "styletrace", args);
    if ("status" in r) return r;
    const ids = activeTraceVertexIds(ctx, r.points);
    if (ids.length === 0) {
      return { status: "nomatch", message: `no polyline vertices map up from "${r.expr}"` };
    }
    const n = ctx.styleTrace(ids, r.value.index);
    return { status: "ok", message: `styled ${n} polyline vertices ${r.value.name}` };
  };
}

/** `styles` — read-only listing of the style registry (bare). */
export function makeStylesHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (args.trim() !== "") {
      return { status: "error", message: "styles takes no arguments — it lists the style registry" };
    }
    const rows = ctx.styleNames().map((name, i) => `  ${name}${i === 0 ? " (default)" : ""}`);
    return { status: "ok", message: ["styles:", ...rows].join("\n") };
  };
}

/**
 * `bake <target> <channel> <axis> [<min> <max>]` — the Tier-1 channel
 * consumer: read the named channel's per-element values AT THE DISPLAYED
 * FRAME, gate the request (gateChannelBind — THE choke point bind shares),
 * normalize over the range (declared min/max, or the explicit trailing pair
 * when the declaration is partial), and write the target's points through
 * the per-element writers. A PLAIN RECORDED WRITE: one undo stroke, LWW,
 * indistinguishable from a hand-typed rep verb — nothing lives past it
 * (the LIVE link is `bind`'s binding object, not this verb). Verb name is
 * provisional (parked P-4).
 */
export function makeBakeHandler(ctx: CommandContext): CommandHandler {
  const usage =
    "bake <target> <channel> <axis> [<min> <max>] (axes: point color|size|opacity · edge bondcolor|bondcolorends|bondsize|bondopacity|bonddash · polyline tracecolor|tracesize|traceopacity · orientation; e.g. bake all energy color 0 2.5)";
  return (args: string): CommandResult => {
    const r = resolveChannelAxis(ctx, "bake", usage, args);
    if ("status" in r) return r;
    if (r.kind === "vector") {
      if (r.axis === OFFSET_AXIS) {
        // RULED: offset is BIND-ONLY. A baked (frozen) per-frame offset
        // over a moving trajectory is a broken static shift — the same
        // reason unbind zeroes instead of freezing. Nothing was applied
        // (resolveChannelAxis only reads).
        return {
          status: "error",
          message: `offset is bind-only — a one-time frozen offset is not supported; use: bind ${r.expr} ${r.channel} offset`,
        };
      }
      const n = ctx.orientationVerticesEach(r.ids, r.values);
      const at = r.frame === null ? "static" : `frame ${r.frame}`;
      return {
        status: "ok",
        message: `baked "${r.channel}" → orientation on ${n} vertices of "${r.expr}" (${at}, raw vectors) — stored; drawn by the oriented shapes`,
      };
    }
    const n = applyScalarsToAxis(ctx, r.axis, r.ids, r.scalars);
    const at = r.frame === null ? "static" : `frame ${r.frame}`;
    const rule = r.domain === "edge"
      ? (r.axis === "bondcolorends" ? ", per endpoint" : ", endpoint mean")
      : "";
    return {
      status: "ok",
      message: `baked "${r.channel}" → ${r.axis} on ${n} ${domainNoun(r.domain)} of "${r.expr}" (${at}, range ${r.range[0]}..${r.range[1]}${rule})`,
    };
  };
}

/**
 * `bind <target> <channel> <axis> [<min> <max>]` — register a channel→axis
 * BINDING: the durable statement "this channel drives this axis over these
 * points". Same parse, same gate, same normalization, same initial write as
 * bake (resolveChannelAxis + ctx.createBinding's one stroke) — PLUS the
 * registry entry, with LAST-BIND-WINS element-level coverage (an overlap is
 * released from earlier bindings in the same stroke; one Ctrl+Z restores
 * both the values and the coverage).
 *
 * LIVE: after the initial apply, the bound axis re-derives from the
 * channel on every displayed-frame flip (the applier in main.ts — raw,
 * unrecorded). The message says so, because now it is true.
 */
export function makeBindHandler(ctx: CommandContext): CommandHandler {
  const usage =
    "bind <target> <channel> <axis> [<min> <max>] (axes: point color|size|opacity · edge bondcolor|bondcolorends|bondsize|bondopacity|bonddash · polyline tracecolor|tracesize|traceopacity · orientation · offset; e.g. bind all energy color 0 2.5)";
  return (args: string): CommandResult => {
    const r = resolveChannelAxis(ctx, "bind", usage, args);
    if ("status" in r) return r;
    const at = r.frame === null ? "static" : `frame ${r.frame}`;
    if (r.kind === "vector") {
      const released = ctx.createBinding(
        { channel: r.channel, axis: r.axis, points: r.ids, expr: r.expr, range: null },
        r.values,
      );
      const took =
        released.points > 0
          ? `; took ${released.points} elements from ${released.touched} earlier binding${released.touched === 1 ? "" : "s"}`
          : "";
      if (r.axis === OFFSET_AXIS) {
        return {
          status: "ok",
          message:
            `bound "${r.channel}" → offset on ${r.ids.length} points of "${r.expr}" ` +
            `(applied at ${at}, raw vectors)${took} — live: re-derives as the displayed frame changes; ` +
            `displaces the drawn positions (shown = raw + offset; unbind zeroes it)`,
        };
      }
      return {
        status: "ok",
        message:
          `bound "${r.channel}" → orientation on ${r.ids.length} vertices of "${r.expr}" ` +
          `(applied at ${at}, raw vectors)${took} — live: re-derives as the displayed frame changes; ` +
          `drives the oriented shapes (shape traces ribbon)`,
      };
    }
    const released = ctx.createBinding(
      { channel: r.channel, axis: r.axis, points: r.ids, expr: r.expr, range: r.range },
      r.scalars,
    );
    const took =
      released.points > 0
        ? `; took ${released.points} elements from ${released.touched} earlier binding${released.touched === 1 ? "" : "s"}`
        : "";
    const rule = r.domain === "edge"
      ? (r.axis === "bondcolorends" ? ", per endpoint" : ", endpoint mean")
      : "";
    return {
      status: "ok",
      message:
        `bound "${r.channel}" → ${r.axis} on ${r.ids.length} ${domainNoun(r.domain)} of "${r.expr}" ` +
        `(applied at ${at}, range ${r.range[0]}..${r.range[1]}${rule})${took} — live: re-derives as the displayed frame changes`,
    };
  };
}

/** `unbind <target> [<axis>]` / `unbind all [<axis>]` — release binding
 * coverage ELEMENT-WISE (the ruled partial-clear granularity): covered
 * elements of the target leave their bindings (shrink; emptied bindings
 * drop), scoped to one axis when the trailing word names one, across every
 * axis otherwise. Values stay as last applied — releasing a binding
 * freezes the current look, it repaints nothing — EXCEPT the offset axis:
 * released offset coverage is ZEROED in the same stroke (positions snap
 * back to raw; a frozen per-frame offset over a moving trajectory would be
 * a broken static shift). One recorded stroke when anything changed. */
export function makeUnbindHandler(ctx: CommandContext): CommandHandler {
  const usage = "unbind <target> [<axis>] | unbind all [<axis>]";
  return (args: string): CommandResult => {
    // Optional trailing axis word; anything else trailing is target text.
    let expr = args.trim();
    let axis: BindAxis | null = null;
    const split = splitTrailingWord(expr);
    if (
      split.word !== null &&
      ((SCALAR_AXES as readonly string[]).includes(split.word) ||
        (VECTOR_AXES as readonly string[]).includes(split.word))
    ) {
      axis = split.word as BindAxis;
      expr = split.expr;
    }
    if (expr === "") {
      return { status: "error", message: `unbind needs a target — ${usage}` };
    }
    if (ctx.listBindings().length === 0) {
      return { status: "nomatch", message: "no bindings to release" };
    }
    let stats: ReleaseStats & { offsetZeroed?: number };
    if (expr === "all") {
      // exact: every binding (of the axis), no resolution needed
      stats = ctx.releaseBindings({ points: null, vertices: null, edges: null }, axis);
    } else {
      const r = resolveTargetPoints(ctx, expr);
      if ("status" in r) return r;
      // THREE id spaces, one target: point coverage releases by POINT id;
      // trace/orientation coverage by the target's polyline-VERTEX ids
      // (direct membership); edge coverage by CONTAINED edge ids — each
      // the same mapping bind used to build that coverage.
      const inSet = new Set(r.points);
      const vertices: number[] = [];
      for (let v = 0; v < ctx.traceVertices.length; v++) {
        if (inSet.has(ctx.traceVertices[v])) vertices.push(v);
      }
      const edges = edgesMatching(ctx.edges, r.points, true);
      stats = ctx.releaseBindings({ points: r.points, vertices, edges }, axis);
    }
    if (stats.touched === 0) {
      return {
        status: "nomatch",
        message: `nothing bound matches "${expr}"${axis === null ? "" : ` on ${axis}`}`,
      };
    }
    // The tail must stay TRUTHFUL per axis: style-axis releases freeze the
    // current look; offset releases ZERO (positions return to raw).
    const zeroed = stats.offsetZeroed ?? 0;
    const tail =
      axis === OFFSET_AXIS
        ? "offsets zeroed, positions return to raw"
        : zeroed > 0
          ? `values stay as last applied; ${zeroed} offset${zeroed === 1 ? "" : "s"} zeroed, positions return to raw`
          : "values stay as last applied";
    return {
      status: "ok",
      message: `released ${stats.points} bound elements across ${stats.touched} binding${
        stats.touched === 1 ? "" : "s"
      }${stats.removed > 0 ? ` (${stats.removed} removed)` : ""}${
        axis === null ? "" : ` on ${axis}`
      } — ${tail}`,
    };
  };
}

/** `bindings` — read-only list of the channel bindings (the `mods`/`ls`
 * precedent). */
/**
 * `channels` — read-only listing of the DECLARED channels (bare, no target).
 * The bindable vocabulary: what `bake`/`bind` can read. Reads ctx.channels()
 * LIVE (header.channels, which a `produces: channel` mod grows mid-session),
 * so a produced channel appears here — and in get_context — the instant it
 * declares. Symmetric with `bindings`/`styles`/`shapes`.
 */
export function makeChannelsHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (args.trim() !== "") {
      return { status: "error", message: "channels takes no arguments — it lists the declared channels" };
    }
    const chans = ctx.channels();
    if (chans.length === 0) return { status: "ok", message: "no channels" };
    const bound = new Set(ctx.listBindings().map((b) => b.channel));
    const rows = chans.map((c) => {
      const width = c.components === 3 ? "vector (3-wide)" : "scalar";
      const range = c.min !== undefined && c.max !== undefined ? ` [${c.min}, ${c.max}]` : "";
      const animatable = c.scope === "per_point_per_frame" ? " · per-frame" : ` · ${c.scope} (static)`;
      return `  ${c.name} — ${width}${range}${animatable}${bound.has(c.name) ? " · bound" : ""}`;
    });
    return { status: "ok", message: ["channels (bake/bind read these):", ...rows].join("\n") };
  };
}

export function makeBindingsHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    if (args.trim() !== "") {
      return { status: "error", message: "bindings takes no arguments — it lists the channel bindings" };
    }
    const list = ctx.listBindings();
    if (list.length === 0) return { status: "ok", message: "no bindings" };
    const rows = list.map(
      (b) =>
        `  ${b.channel} → ${b.axis} on "${b.expr}" — ${b.points.length} ${
          b.axis === ORIENTATION_AXIS
            ? "vertices · raw vectors"
            : b.axis === OFFSET_AXIS
              ? "points · raw vectors"
              : `${domainNoun(AXIS_DOMAIN[b.axis])} · range ${b.range![0]}..${b.range![1]}${b.axis === "bondcolorends" ? " · per endpoint" : AXIS_DOMAIN[b.axis] === "edge" ? " · endpoint mean" : ""}`
        }`,
    );
    return {
      status: "ok",
      message: [
        `${list.length} binding${list.length === 1 ? "" : "s"} (live: re-derived from the channel as the displayed frame changes):`,
        ...rows,
      ].join("\n"),
    };
  };
}

/**
 * The own-verb handler for a Type A (analysis) mod: resolve the target
 * through the SAME resolver every verb uses, then hand off to the async
 * producer round-trip (ctx.runAnalysisMod — exec in the producer, validate
 * FAIL-CLOSED, bind through the EXISTING rails per the mod's declared
 * `produces`). The sync return is the "running…" acknowledgement; the
 * outcome prints as a follow-up terminal line. A per-frame-series mod takes
 * a target too (its Python may use or ignore it); `all` is the natural
 * whole-dataset target.
 */
export function makeAnalysisModHandler(ctx: CommandContext, mod: AnalysisMod): CommandHandler {
  return (args: string): CommandResult => {
    // Split the target from the parameter block at the first UNQUOTED `?` — a
    // reserved grammar char, so this boundary is collision-proof (a `?` in a
    // quoted label stays in the target). The target keeps its whitespace and
    // unions; parameters are `?key=value`, values may hold spaces (delimited by
    // the next `?`, not whitespace).
    const parsed = parseModParams(mod, args);
    if ("status" in parsed) return parsed;
    const { expr, params } = parsed;
    if (expr === "") {
      // A commands mod MAY ignore target_indices, so bare invocation is allowed
      // (empty target_indices = the whole system per the mod contract). The
      // per-point/per-frame kinds need a target to bind their result to.
      if (mod.produces === "commands") {
        ctx.runAnalysisMod(mod, [], "", params);
        return { status: "ok", message: `running ${mod.name}…` };
      }
      return {
        status: "error",
        message: `${mod.name} needs a target — ${mod.name} <target> (e.g. ${mod.name} alpha.group-0)`,
      };
    }
    const r = resolveTargetPoints(ctx, expr);
    if ("status" in r) return r;
    ctx.runAnalysisMod(mod, r.points, expr, params);
    return {
      status: "ok",
      message: `running ${mod.name} on ${r.points.length} points…`,
    };
  };
}

/** Split a mod invocation `<target> ?k=v ?k2=v2` into its target expression and
 * its resolved parameter set (defaults filled, types coerced, all validated
 * against the mod's declared schema — the SHARED resolveParameters). Fail-closed:
 * an unknown/malformed/wrong-typed/missing parameter is a CommandResult error and
 * nothing runs. `params` is undefined when the mod declares none and none were
 * passed (the two-arg call path). Exported for the invocation test. */
export function parseModParams(
  mod: AnalysisMod,
  args: string,
): { expr: string; params?: Record<string, ParamValue> } | CommandResult {
  // An unbalanced `"` would silently let an unclosed quote in a value swallow the
  // following `?param` (there is no escape). Reject it loudly instead — a legal
  // invocation always has balanced quotes (paired label / value delimiters).
  if (((args.match(/"/g) ?? []).length) % 2 !== 0) {
    return { status: "error", message: `${mod.name}: unbalanced '"' in the invocation` };
  }
  const segs = splitOnUnquoted(args, "?");
  const expr = segs[0].trim();
  const passed = new Map<string, unknown>();
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i].trim();
    if (seg === "") {
      return { status: "error", message: `${mod.name}: empty parameter — each is ?key=value` };
    }
    const eq = seg.indexOf("=");
    if (eq < 0) {
      return { status: "error", message: `${mod.name}: parameter "${seg}" must be key=value` };
    }
    const key = seg.slice(0, eq).trim();
    let value = seg.slice(eq + 1).trim();
    // Unwrap ONLY a single fully-quoted region (no interior quote), so a value
    // may hold a `?` or edge spaces when quoted, while `"a" "b"` is NOT mangled
    // to `a" "b`. A stray interior `"` survives to coerceValue, which refuses it.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"') &&
        value.indexOf('"', 1) === value.length - 1) {
      value = value.slice(1, -1);
    }
    if (passed.has(key)) {
      return { status: "error", message: `${mod.name}: parameter "${key}" given twice` };
    }
    passed.set(key, value);
  }
  const resolved = resolveParameters(mod.params ?? [], passed);
  if (!resolved.ok) return { status: "error", message: `${mod.name}: ${resolved.error}` };
  return {
    expr,
    ...(Object.keys(resolved.values).length ? { params: resolved.values } : {}),
  };
}

/** The refusal that follows a mod-emitted COMMAND (not the caller): `rm` and
 * mod-invocation are forbidden inside a `produces: commands` macro. Enforced at
 * the execution boundary — the guarantee, since the Python can generate strings
 * the write_mod preview never showed. Returns a reason, or null to allow. */
export function commandMacroRefusal(text: string, modNames: ReadonlySet<string>): string | null {
  const verb = text.trim().split(/\s+/)[0] ?? "";
  if (verb === "rm") {
    return "`rm` is not allowed inside a mod (deletion is destructive and outside the undo model)";
  }
  if (modNames.has(verb)) {
    return `invoking a mod ("${verb}") from inside a mod is not allowed (no recursion)`;
  }
  return null;
}

export interface CommandMacroDeps {
  /** Every registered mod's verb name — mod-invocation is refused. */
  modNames: ReadonlySet<string>;
  /** Pre-validate a command WITHOUT side effects (parse + resolve). */
  validate(cmd: string): CommandResult;
  /** Execute a command for real. */
  run(cmd: string): CommandResult;
  /** Group the whole batch into ONE undo stroke. */
  beginStroke(): void;
  endStroke(): void;
}

/** Run a `produces: commands` mod's emitted strings — the FAIL-CLOSED,
 * ALL-OR-NOTHING execution boundary. Refuses `rm`/mod-invocation and
 * pre-validates EVERY string before executing ANY (a parse error in the third
 * string runs zero commands, not two); a nomatch is not an error. On success
 * runs all inside one undo stroke and reports per-command outcomes.
 *
 * If EVERY command nomatches, the summary is loud (`nomatch` status, not a
 * cheerful `ok`): the mod addressed labels that don't exist, so nothing was
 * written — the silent-success trap for a mod that guessed labels instead of
 * reading `data.labels`. A PARTIAL nomatch stays a normal `ok`. */
export function runCommandMacro(
  name: string,
  cmds: string[],
  deps: CommandMacroDeps,
): { status: "ok" | "nomatch" | "error"; message: string } {
  // 1a. refusals — the security guarantee, before anything runs
  for (let i = 0; i < cmds.length; i++) {
    const why = commandMacroRefusal(cmds[i], deps.modNames);
    if (why) return { status: "error", message: `${name} → command ${i + 1} refused ("${cmds[i]}"): ${why}. Nothing ran.` };
  }
  // 1b. pre-validate every string (no side effects) — a parse/usage error → zero execution
  for (let i = 0; i < cmds.length; i++) {
    const v = deps.validate(cmds[i]);
    if (v.status === "error") {
      return { status: "error", message: `${name} → command ${i + 1} is invalid ("${cmds[i]}"): ${v.message}. Nothing ran.` };
    }
  }
  // 2. execute all inside ONE reentrant stroke → one Ctrl+Z reverses the macro
  deps.beginStroke();
  const lines: string[] = [];
  let matched = 0; // commands that resolved to something (status !== nomatch)
  try {
    for (const c of cmds) {
      const r = deps.run(c);
      if (r.status !== "nomatch") matched++;
      lines.push(`  ${c} → ${r.message}`);
    }
  } finally {
    deps.endStroke();
  }
  const body = lines.join("\n");
  // every command nomatched → nothing was written. Say so plainly instead of
  // reporting success (the whole point of Part B). Reuses the existing nomatch
  // signal — not a new error class.
  if (cmds.length > 0 && matched === 0) {
    return {
      status: "nomatch",
      message: `${name} → nothing matched: all ${cmds.length} command${cmds.length === 1 ? "" : "s"} nomatched, so nothing was written (check the target labels against data.labels):\n${body}`,
    };
  }
  return {
    status: "ok",
    message: `${name} → ran ${cmds.length} command${cmds.length === 1 ? "" : "s"} (one undo stroke):\n${body}`,
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

/**
 * `mods` — READ-ONLY listing of the RECIPE REGISTRY (no state, no undo):
 * the vocabulary-side parallel to `ls` (ls lists committed selections —
 * scene state; mods lists the registered recipes — vocabulary state). One
 * line per recipe, grouped by origin, showing name, axis, and credit
 * (author/source when present — DISPLAY-ONLY opaque strings; nothing
 * resolves or fetches them). Bare only: it inspects the vocabulary, not
 * the scene, so any argument is a usage error. Recipes only — the built-in
 * command verbs stay with help/?.
 */
export function makeModsHandler(): CommandHandler {
  const recipeLine = (r: Mod, consumers: ReadonlyMap<string, string[]>): string => {
    let line = `  ${r.name} — `;
    line +=
      r.kind === "representation"
        ? `representation · ${r.axis}`
        : `analysis · ${r.produces}${r.produces === "per-point-scalar" ? ` → ${r.axis}` : ""}`;
    // Demote a channel mod that exists to serve another: say what it is for,
    // instead of presenting it beside the mods a person actually types. It stays
    // listed and stays invocable — a mod's name is its verb, so omitting it would
    // make this listing lie about what `help` and tab-completion still know.
    line += machineryNote("channel" in r ? r.channel : undefined, consumers);
    if (r.author) line += ` · by ${r.author}`;
    if (r.source) line += ` · ${r.source}`;
    return line;
  };
  return (args: string): CommandResult => {
    if (args !== "") {
      return { status: "error", message: "mods takes no arguments — it lists the recipe registry" };
    }
    const all = listRecipes();
    const consumers = channelConsumers(all);
    if (all.length === 0) return { status: "ok", message: "no recipes" };
    // group by origin, first-seen order; registration order within a group
    const byOrigin = new Map<RecipeOrigin, Mod[]>();
    for (const r of all) {
      const group = byOrigin.get(r.origin);
      if (group) group.push(r);
      else byOrigin.set(r.origin, [r]);
    }
    const lines: string[] = [];
    for (const [origin, group] of byOrigin) {
      lines.push(`${origin}:`);
      for (const r of group) lines.push(recipeLine(r, consumers));
    }
    return { status: "ok", message: capLines(lines, "recipes") };
  };
}

/**
 * `rm <mod-selector>` — delete WORKSPACE mod files, gated on a y/n
 * confirmation. The selector names MODS, not points (resolveModSelector —
 * the point resolver is deliberately not in this path): bare names, `+`
 * unions, and `all` (= all workspace mods, never built-ins). Built-ins are
 * code, not files — naming one is an explicit refusal, and a mixed
 * selector refuses the built-ins while confirming the deletable rest. The
 * FIRST destructive, non-undoable terminal operation: rm never touches the
 * undo stack, and the prompt says so. If nothing is deletable, no prompt
 * is armed at all.
 */
/** An unlink error from the host meaning the file is already gone (removed
 * outside the app). `rm` reconciles these by unregistering the mod so the
 * registry matches disk — it is NOT a persistent failure. Any OTHER unlink
 * error is a real failure that leaves the mod registered and is reported. */
export function isFileAlreadyGone(error: string): boolean {
  return /ENOENT|no such file/i.test(error);
}

export function makeRmHandler(ctx: CommandContext): CommandHandler {
  return (args: string): CommandResult => {
    const selector = args.trim();
    if (selector === "") {
      return {
        status: "error",
        message: "rm needs a mod selector — rm <name> [+ <name>…] or rm all (workspace mods only)",
      };
    }
    const sel = resolveModSelector(selector, listRecipes());
    if ("error" in sel) return { status: "error", message: sel.error };
    const refusals = sel.builtins.map(
      (n) => `"${n}" is built-in — code, not a file; it cannot be deleted`);
    const unknowns = sel.nomatch.map((n) => `no mod named "${n}"`);
    if (sel.workspace.length === 0) {
      const lines = [...refusals, ...unknowns];
      if (lines.length === 0) {
        return { status: "nomatch", message: "no workspace mods to delete" }; // rm all, empty
      }
      lines.push("nothing to delete");
      return { status: sel.builtins.length > 0 ? "error" : "nomatch", message: lines.join("\n") };
    }
    ctx.armRmDeletion(sel.workspace);
    const lines = [
      ...refusals,
      ...unknowns,
      `will delete ${sel.workspace.length} workspace mod${sel.workspace.length === 1 ? "" : "s"}: ` +
        sel.workspace.join(", "),
      "files are removed from disk — this CANNOT be undone. y/n?",
    ];
    return { status: "ok", message: lines.join("\n"), confirm: true };
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
  "  bicolorbonds <expr>         split-color contained edges: each HALF takes",
  "               its endpoint point's CURRENT color (a snapshot — no color",
  "               token; re-run after recoloring points; one undo stroke)",
  "  bicolorbondsof <expr>       the incident sibling (either endpoint —",
  "               reaches one hop outside, like colorbondsof)",
  "  colortrace <expr> <color>   color polyline vertices whose SUBGROUP holds",
  "               a resolved point (maps up; boundary segments blend)",
  "  pointsize <expr> <n>        size those points (0 is legal and never hides;",
  "               negatives clamp to 0; one undo stroke)",
  "  bondsize / bondsizeof / tracesize <expr> <n>   the same shapes on the",
  "               SIZE axis (edge/trace width stored; not yet drawn)",
  "  dashbonds <expr> <scale>    dash contained edges: 0 = solid (the",
  "               default), >0 sets a world-length dash period (zoom-",
  "               stable; negatives clamp to 0; one undo stroke)",
  "  dashbondsof <expr> <scale>  the incident sibling (either endpoint)",
  "  pointopacity <expr> <a>     fade those points (0..1; 0 is invisible-but-",
  "               PRESENT, never a hide; out-of-range clamps to 0/1)",
  "  bondopacity / bondopacityof / traceopacity <expr> <a>   the same shapes",
  "               on the OPACITY axis (overlap compositing is draw-order naive)",
  "  rainbow <expr>              color those points an even hue ramp in",
  "               resolution order (the first recipe: per-point values,",
  "               not one constant; one undo stroke)",
  "  bake <expr> <channel> <axis> [<min> <max>]   write a scalar data",
  "               channel (at the displayed frame) onto color|size|opacity,",
  "               normalized over min..max (declared on the channel, or",
  "               explicit when the declaration is partial; one undo stroke)",
  "  bind <expr> <channel> <axis> [<min> <max>]   register a channel→axis",
  "               binding (same gate as bake): the axis RE-DERIVES from the",
  "               channel on every frame flip; last-bind-wins per element",
  "               WITHIN an axis, axes coexist; one undo stroke;",
  "               a later direct write CLEARS its overlap, same stroke)",
  "               axes cover all three domains: point color|size|opacity,",
  "               edge bondcolor|bondsize|bondopacity|bonddash (value =",
  "               ENDPOINT MEAN, contained edges) and bondcolorends",
  "               (PER-ENDPOINT color: each half of the edge reads its own",
  "               endpoint — no mean),",
  "               polyline tracecolor|tracesize|traceopacity",
  "               (each vertex reads ITS point); axis `orientation` takes a",
  "               VECTOR (3-wide) channel, raw (no range), onto polyline",
  "               vertices — it drives the oriented shapes (shape traces",
  "               ribbon; unbound orientation = collapsed, nothing draws);",
  "               axis `offset` takes a VECTOR channel, raw, onto POINTS —",
  "               it DISPLACES the drawn positions (shown = raw + offset;",
  "               bind-only: bake refuses it)",
  "  unbind <expr>|all [<axis>]  release binding coverage element-wise,",
  "               one axis or all (values stay as last applied — except",
  "               offset, which is zeroed: positions return to raw)",
  "  bindings     list channel bindings (read-only)",
  "  stylepoints / stylebonds / styletrace <expr> <style>   select a",
  "               registered shading style per target (standard | matte;",
  "               standard is the default look; one undo stroke)",
  "  styles       list the style registry (read-only)",
  "  shape <points|bonds|traces> <name>   draw a whole domain as a named",
  "               registered shape (scene-level; one undo op) · shapes  list",
  "  background <color>          set the scene background (CSS name or #hex;",
  "               targetless — scene state, session-only; one undo op)",
  "  ls [@name|<path>]   list selections / a selection's members / a node's contents",
  "  mods         list the recipe registry: name, axis, origin, and credit",
  "               (author · source, display-only; recipes, not verbs)",
  "  rm <mods>    delete WORKSPACE mod files (rm <name> [+ <name>…] · rm all);",
  "               y/n confirmed, built-ins refused, NOT undoable",
  "  rename @name [new]  rename a selection · clear  wipe the terminal log",
  "  /claude      toggle the conversation panel above the terminal (its own",
  "               input; tool calls gate on approve/deny; typed results drive",
  "               the view — per-point scalars/commands; stub backend today)",
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
    "bicolorbonds",
    makeBicolorBondsHandler(ctx, "bicolorbonds"),
    "split-color every contained edge (both endpoints in the target): each half takes its endpoint point's CURRENT color — a snapshot, no color token: bicolorbonds <target>",
  );
  registry.register(
    "bicolorbondsof",
    makeBicolorBondsHandler(ctx, "bicolorbondsof"),
    "split-color every edge with AT LEAST ONE endpoint in the target (incident — reaches one hop outside): each half takes its endpoint point's CURRENT color: bicolorbondsof <target>",
  );
  registry.register(
    "colortrace",
    makeColorTraceHandler(ctx),
    "color polyline vertices whose subgroup contains a resolved point (contained at subgroup grain): colortrace <target> <color>",
  );
  registry.register(
    "pointsize",
    makePointSizeHandler(ctx),
    "size the target's points (0 is legal and never hides; negatives clamp to 0): pointsize <target> <size>",
  );
  registry.register(
    "bondsize",
    makeBondSizeHandler(ctx, "bondsize"),
    "size every edge with BOTH endpoints in the target (contained; width stored, not yet drawn): bondsize <target> <size>",
  );
  registry.register(
    "bondsizeof",
    makeBondSizeHandler(ctx, "bondsizeof"),
    "size every edge with AT LEAST ONE endpoint in the target (incident — reaches one hop outside): bondsizeof <target> <size>",
  );
  registry.register(
    "tracesize",
    makeTraceSizeHandler(ctx),
    "size polyline vertices whose subgroup contains a resolved point (contained at subgroup grain): tracesize <target> <size>",
  );
  registry.register(
    "dashbonds",
    makeDashBondsHandler(ctx, "dashbonds"),
    "dash every edge with BOTH endpoints in the target (contained; 0 = solid, >0 = world-length dash period): dashbonds <target> <scale>",
  );
  registry.register(
    "dashbondsof",
    makeDashBondsHandler(ctx, "dashbondsof"),
    "dash every edge with AT LEAST ONE endpoint in the target (incident — reaches one hop outside): dashbondsof <target> <scale>",
  );
  registry.register(
    "pointopacity",
    makePointOpacityHandler(ctx),
    "fade the target's points (0..1; 0 is invisible-but-present, never a hide): pointopacity <target> <opacity>",
  );
  registry.register(
    "bondopacity",
    makeBondOpacityHandler(ctx, "bondopacity"),
    "fade every edge with BOTH endpoints in the target (contained): bondopacity <target> <opacity>",
  );
  registry.register(
    "bondopacityof",
    makeBondOpacityHandler(ctx, "bondopacityof"),
    "fade every edge with AT LEAST ONE endpoint in the target (incident — reaches one hop outside): bondopacityof <target> <opacity>",
  );
  registry.register(
    "traceopacity",
    makeTraceOpacityHandler(ctx),
    "fade polyline vertices whose subgroup contains a resolved point (contained at subgroup grain): traceopacity <target> <opacity>",
  );
  registry.register(
    "rainbow",
    makeRainbowHandler(ctx),
    "color the target's points an even hue ramp in resolution order (the first recipe — per-point values, one undo stroke): rainbow <target>",
  );
  registry.register(
    "bake",
    makeBakeHandler(ctx),
    "write a declared scalar channel's values (at the displayed frame) onto a point axis, normalized over min..max (declared, or explicit when the declaration is partial; one undo stroke): bake <target> <channel> <axis> [<min> <max>]",
  );
  registry.register(
    "bind",
    makeBindHandler(ctx),
    "register a channel→axis binding over the target (same gate/range as bake): the axis re-derives from the channel on every frame flip; last-bind-wins per element within an axis; one undo stroke; axis `offset` (vector, bind-only) displaces the drawn positions: bind <target> <channel> <axis> [<min> <max>]",
  );
  registry.register(
    "unbind",
    makeUnbindHandler(ctx),
    "release binding coverage element-wise, one axis or all — unbind <target> [<axis>] | unbind all [<axis>] (values stay as last applied, except offset which is zeroed — positions return to raw; one undo op)",
  );
  registry.register(
    "channels",
    makeChannelsHandler(ctx),
    "read-only list of the declared channels — the bindable vocabulary bake/bind read (bare — takes no target)",
  );
  registry.register(
    "bindings",
    makeBindingsHandler(ctx),
    "read-only list of the channel bindings — channel → axis on target, points, range (bare — takes no target)",
  );
  registry.register(
    "stylepoints",
    makeStylePointsHandler(ctx),
    "select a registered style's shading for the target's points (per-element; standard restores the default look): stylepoints <target> <style>",
  );
  registry.register(
    "stylebonds",
    makeStyleBondsHandler(ctx),
    "style every edge with BOTH endpoints in the target (contained): stylebonds <target> <style>",
  );
  registry.register(
    "styletrace",
    makeStyleTraceHandler(ctx),
    "style polyline vertices whose subgroup contains a resolved point (map-up): styletrace <target> <style>",
  );
  registry.register(
    "styles",
    makeStylesHandler(ctx),
    "read-only listing of the style registry (bare — takes no target; index 0 is the default)",
  );
  registry.register(
    "shape",
    makeShapeHandler(ctx),
    "draw a whole domain as a named registered shape (scene-level; one undo op): shape <points|bonds|traces> <name>",
  );
  registry.register(
    "shapes",
    makeShapesHandler(ctx),
    "read-only listing of the shape registry per domain (bare — takes no target)",
  );
  registry.register(
    "background",
    makeBackgroundHandler(ctx),
    "set the scene background color (targetless — scene state, session-only; one undo op; repeating the current color records nothing): background <color>",
  );
  registry.register(
    "ls",
    makeLsHandler(ctx),
    "read-only listing: ls = selections · ls @name = its members · ls <path> = a node's contents",
  );
  registry.register(
    "mods",
    makeModsHandler(),
    "read-only listing of the recipe registry: each recipe's name, axis, origin, and credit (bare — takes no target)",
  );
  registry.register(
    "rm",
    makeRmHandler(ctx),
    "delete WORKSPACE mod files (y/n confirmed, NOT undoable): rm <name> [+ <name>…] · rm all — built-ins are refused",
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
  registry.register(
    "/claude",
    () => ({
      status: "ok",
      message: "/claude toggles the conversation panel — type it in the terminal",
    }),
    "toggle the conversation panel above the terminal (handled by the terminal surface itself; the panel has its own input and talks to the assistant backend)",
  );
  const help = makeHelpHandler(registry);
  registry.register("help", help, "this grammar summary; help <verb> describes one verb");
  registry.register("?", help, "alias of help");
  // Everything registered above is a BUILT-IN. Anything registered after this
  // line is a mod's own verb, and a mod may replace its own verb freely.
  registry.sealBuiltins();
  return registry;
}

// -- installing workspace mods ---------------------------------------------------

/** The two registries a mod's code lives in, behind one call. Both are keyed by
 * mod name and both must be REPLACED together on a re-push: the recipe entry
 * holds `mod.code`, and the command handler CLOSES OVER the mod object. Replace
 * one without the other and the viewer runs a mod that no longer exists. */
export interface ModInstallDeps {
  isBuiltin(name: string): boolean;
  /** Register or REPLACE the mod: its recipe entry AND its command handler. */
  install(mod: AnalysisMod): void;
  /** P-3: currently-live channel names (header + produced), so registration's
   * requires-channel check agrees with the runtime — a requirement satisfied by
   * a LIVE dataset channel (not a mod provider) is not a dependency issue. */
  liveChannels?(): readonly string[];
}

export interface ModInstallOutcome {
  installed: string[];
  skipped: { name: string; reason: string }[];
  /** P-2: channel names declared by MORE THAN ONE installed mod — knowable
   * without running them now the name is static. Empty when there are none. */
  channelCollisions: { channel: string; mods: string[] }[];
  /** P-3: `# requires-channel` dependencies that are unsatisfiable STATICALLY
   * (missing/ambiguous/too-deep provider) — detected at registration (parse
   * time), before any invocation. `mod` is the requiring mod; `issue` the reason. */
  dependencyIssues: { mod: string; issue: string }[];
}

/**
 * Install a pushed set of workspace mods — the ONE door a mod's code enters the
 * viewer through, at boot and after every `write_mod` save.
 *
 * **A push REPLACES.** A mod re-pushed under an existing name overwrites both its
 * recipe entry and its command handler, so the code that RUNS is always the code
 * that was last pushed — and therefore the code the human approved at the gate.
 *
 * The guard refuses exactly one thing: a name that is a BUILT-IN verb, so a mod
 * file can never shadow one. It deliberately does NOT ask "is this name already a
 * verb" — that is true of every already-installed mod, including the one being
 * replaced, which is what silently pinned the viewer to a mod's first version.
 *
 * Pure: the caller supplies the registries and reports the outcome.
 */
export function installModList(raw: unknown, deps: ModInstallDeps): ModInstallOutcome {
  const installed: string[] = [];
  const installedMods: AnalysisMod[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (!Array.isArray(raw)) return { installed, skipped, channelCollisions: [], dependencyIssues: [] };
  for (const entry of raw) {
    const mod = entry as AnalysisMod;
    if (!mod || mod.kind !== "analysis" || typeof mod.name !== "string" ||
        typeof mod.code !== "string") {
      const name = typeof (entry as { name?: unknown })?.name === "string"
        ? (entry as { name: string }).name : "(unnamed)";
      skipped.push({ name, reason: "it is not a well-formed analysis mod" });
      continue;
    }
    if (deps.isBuiltin(mod.name)) {
      skipped.push({ name: mod.name, reason: `"${mod.name}" is a built-in command` });
      continue;
    }
    deps.install(mod);
    installed.push(mod.name);
    installedMods.push(mod);
  }
  // P-2: two mods declaring the same channel name — detect (warn, not refuse:
  // both register fine, but the author should know one will overwrite the other).
  const channelCollisions: { channel: string; mods: string[] }[] = [];
  for (const [channel, mods] of channelProviders(installedMods)) {
    if (mods.length > 1) channelCollisions.push({ channel, mods });
  }
  // P-3: STATIC (parse-time) detection of unsatisfiable `# requires-channel`
  // dependencies — missing/ambiguous provider, self-requirement, or a chain
  // deeper than one level (cycles included). Resolved against the full pushed
  // set (which is the whole workspace). Warned, so a bad dependency is loud at
  // registration, not only when the mod is finally invoked.
  const dependencyIssues: { mod: string; issue: string }[] = [];
  const live = new Set(deps.liveChannels?.() ?? []);
  for (const m of installedMods) {
    if (!m.requiresChannel) continue;
    // A requirement already satisfied by a LIVE channel (a base dataset channel,
    // or one produced earlier) is not an issue — mirror the runtime, which runs
    // the consumer directly when its channel is present.
    if (live.has(m.requiresChannel)) continue;
    const dep = resolveChannelDependency(m, installedMods);
    if ("error" in dep) dependencyIssues.push({ mod: m.name, issue: dep.error });
  }
  return { installed, skipped, channelCollisions, dependencyIssues };
}

/**
 * What the viewer reports back about ONE mod in a push — the truthful ack.
 *
 * `write_mod` used to report success from the HOST, describing its own disk
 * write, while the viewer silently declined to register the mod. The tool must
 * only claim a registration the layer that performs it actually confirmed, so
 * this is the answer that rides the outcome round-trip back to the tool.
 */
export function modInstallReport(outcome: ModInstallOutcome, name: string): CommandResult {
  if (outcome.installed.includes(name)) {
    // Surface a channel-name collision the moment the colliding mod registers.
    const clash = outcome.channelCollisions.find((c) => c.mods.includes(name));
    const collide = clash
      ? ` ⚠ channel "${clash.channel}" is also declared by ${clash.mods.filter((m) => m !== name).join(", ")}` +
        ` — whichever runs last owns the data`
      : "";
    // P-3: surface an unsatisfiable required-channel dependency at registration —
    // the mod registered, but it can't auto-sequence its provider (it works once
    // the channel is made live by hand).
    const dep = outcome.dependencyIssues.find((d) => d.mod === name);
    const depWarn = dep ? ` ⚠ can't auto-run its provider: ${dep.issue}` : "";
    return { status: "ok", message: `registered mod "${name}"${collide}${depWarn}` };
  }
  const skip = outcome.skipped.find((s) => s.name === name);
  if (skip) {
    return { status: "error", message: `the viewer did NOT register "${name}" — ${skip.reason}` };
  }
  // No trailing period on any of these: the caller composes them into a sentence.
  return {
    status: "error",
    message: `the viewer did NOT register "${name}" — it was not among the mods loaded from disk ` +
      `(the file may be malformed, or the viewer was not ready)`,
  };
}

// -- argument-aware completion: the verb dispatcher --------------------------------

/** A mod invocation's non-target slots: `<target> ?name=value ?name2=…`.
 * The boundary is the SAME collision-proof split parseModParams executes on
 * (splitOnUnquoted at the reserved `?`), so completion and invocation can
 * never disagree about where the target ends. No unquoted `?` before the
 * cursor → the whole argument is target text (the caller's target slot).
 * Otherwise the LAST `?` segment holds the cursor:
 *   no `=` yet → complete the parameter NAME from the declared schema MINUS
 *     the names already used in EARLIER segments (resolveParameters'
 *     duplicate rule, mirrored); a unique match appends `=`;
 *   after `=` → complete the VALUE — enumerable only for a boolean
 *     parameter (true/false); number/string values are unenumerable (empty,
 *     never a guess).
 * Settling is completeToken's — identical two-stage behavior to paths. */
function completeModInvocation(
  mod: AnalysisMod,
  argsStart: number,
  argsHead: string,
  targetSlot: () => Completion,
): Completion {
  const segs = splitOnUnquoted(argsHead, "?");
  if (segs.length === 1) return targetSlot(); // no unquoted "?" → target text
  const seg = segs[segs.length - 1];
  const segStart = argsStart + (argsHead.length - seg.length);
  const none: Completion = { start: argsStart + argsHead.length, candidates: [], applied: "" };
  const declared = mod.params ?? [];
  const eq = seg.indexOf("=");
  if (eq < 0) {
    // parameter NAME slot
    const lead = seg.length - seg.trimStart().length;
    const token = seg.slice(lead);
    if (/[\s"]/.test(token)) return none; // a name never holds spaces/quotes
    const used = new Set(
      segs.slice(1, -1).map((s) => {
        const e = s.indexOf("=");
        return (e < 0 ? s : s.slice(0, e)).trim();
      }),
    );
    const pool = declared.map((p) => p.name).filter((n) => !used.has(n));
    return completeToken(segStart + lead, token, pool, { uniqueSuffix: "=", kind: "param" });
  }
  // VALUE slot: enumerable for a boolean (true/false) or a `color` (CSS color
  // NAMES — the SAME pool + settle path the colorpoints/background color slot
  // uses, single-sourced via colorSlot(); hex stays open input, exactly like
  // that slot). number/string values are unenumerable (empty, never a guess).
  const param = declared.find((p) => p.name === seg.slice(0, eq).trim());
  if (!param) return none;
  let pool: string[];
  if (param.type === "boolean") pool = ["true", "false"];
  else if (param.type === "color") pool = colorSlot().pool();
  else return none; // number / string — no enumerable value vocabulary
  const value = seg.slice(eq + 1);
  const lead = value.length - value.trimStart().length;
  return completeToken(segStart + eq + 1 + lead, value.slice(lead), pool, {
    kind: "value",
  });
}

/** Quote-aware whitespace chunking WITH OFFSETS — splitTrailingWord's exact
 * scan generalized to every chunk (a `"` toggles quote state, no escape),
 * so slot detection sees the same word boundaries the verbs' own argument
 * splitters see. Raw untrimmed slices; an unbalanced quote swallows to the
 * end as one chunk (never a throw). */
function chunkWords(s: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let inQuote = false;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ws = !inQuote && /\s/.test(s[i]);
    if (!ws && start < 0) start = i;
    if (s[i] === '"') inQuote = !inQuote;
    if (ws && start >= 0) {
      out.push({ start, end: i, text: s.slice(start, i) });
      start = -1;
    }
  }
  if (start >= 0) out.push({ start, end: s.length, text: s.slice(start) });
  return out;
}

/** Where the cursor sits among a verb's argument chunks: the chunks BEFORE
 * the token under construction, plus the token and its offset in argsHead
 * (empty token = the head ends at top-level whitespace, a fresh chunk). The
 * cursor is always at the END of argsHead (only text[0..cursor) exists). */
function argPosition(argsHead: string): {
  prior: { start: number; end: number; text: string }[];
  token: string;
  tokenStart: number;
} {
  const chunks = chunkWords(argsHead);
  const last = chunks[chunks.length - 1];
  if (last !== undefined && last.end === argsHead.length) {
    return { prior: chunks.slice(0, -1), token: last.text, tokenStart: last.start };
  }
  return { prior: chunks, token: "", tokenStart: argsHead.length };
}

/** How many leading chunks form the LONGEST prefix that parses as one
 * target expression (0 = none does). Slot detection needs to know where the
 * target ends, and the target grammar itself is the authority: spaces occur
 * inside a target only via quoted labels and ` + ` unions, both of which
 * parse — so the longest parseable chunk prefix IS the target. */
function targetChunkCount(
  argsHead: string,
  prior: readonly { start: number; end: number }[],
): number {
  for (let k = prior.length; k >= 1; k--) {
    if (parseTarget(argsHead.slice(prior[0].start, prior[k - 1].end)).kind !== "error") return k;
  }
  return 0;
}

/** One enumerable word slot after the target: its live vocabulary, the
 * separator a unique match appends, and the header kind. */
interface WordSlot {
  pool(): string[];
  uniqueSuffix?: string;
  kind?: Completion["kind"];
}

/** The shared `<verb> <target> <word> [<word>…]` completer: find where the
 * target ends (the longest parseable chunk prefix), then complete the
 * cursor's slot from the verb's slot table (slot 0 = the first word after
 * the target). The cursor before/inside the target — or continuing a `+`
 * union (`colorpoints alpha + be` completes `be` as a TARGET term) —
 * routes to the target slot; a malformed prior or an out-of-table slot
 * (e.g. bake's numeric range) is inert. Settling is completeToken's. */
function completeSlotsAfterTarget(
  argsStart: number,
  argsHead: string,
  targetSlot: () => Completion,
  slots: readonly WordSlot[],
): Completion {
  const { prior, token, tokenStart } = argPosition(argsHead);
  const none: Completion = { start: argsStart + tokenStart, candidates: [], applied: "" };
  // no finished chunk yet, or a token continuing a union → target text
  if (prior.length === 0 || token.startsWith("+")) return targetSlot();
  const priorText = argsHead.slice(prior[0].start, prior[prior.length - 1].end);
  if (priorText.trimEnd().endsWith("+")) return targetSlot();
  const k = targetChunkCount(argsHead, prior);
  if (k === 0) return none;
  const slot = slots[prior.length - k];
  if (slot === undefined) return none;
  return completeToken(argsStart + tokenStart, token, slot.pool(), {
    uniqueSuffix: slot.uniqueSuffix,
    kind: slot.kind,
  });
}

/** The channel slot bake/bind share: the DECLARED channel names, live from
 * ctx (a produced channel appears the instant it declares). An axis must
 * follow, so a unique match appends the separator space. */
function channelSlot(ctx: CommandContext): WordSlot {
  return {
    pool: () => ctx.channels().map((c) => c.name),
    uniqueSuffix: " ",
    kind: "channel",
  };
}

/** The axis slot, derived from the channelmap constants — never a
 * hand-copied list: bind/unbind take every bindable axis; bake EXCLUDES
 * `offset` (bake refuses it — offset is bind-only), so the two pools
 * differ by exactly that one constant. */
function axisSlot(includeOffset: boolean): WordSlot {
  return {
    pool: () =>
      ([...SCALAR_AXES, ...VECTOR_AXES] as string[]).filter(
        (a) => includeOffset || a !== OFFSET_AXIS,
      ),
    kind: "axis",
  };
}

/** The color slot the color-family verbs and background share: the CSS
 * NAMED colors only — hex stays open input (unenumerable, a no-op). */
function colorSlot(): WordSlot {
  return { pool: () => [...CSS_COLORS.keys()], kind: "value" };
}

/** The style slot the style verbs share: the registered style names. */
function styleSlot(ctx: CommandContext): WordSlot {
  return { pool: () => ctx.styleNames(), kind: "value" };
}

/** A verb whose FIRST argument is one enumerable word (background's color,
 * help's verb name): complete it there; anything beyond is inert. */
function completeFirstWord(argsStart: number, argsHead: string, slot: WordSlot): Completion {
  const { prior, token, tokenStart } = argPosition(argsHead);
  if (prior.length > 0) return { start: argsStart + tokenStart, candidates: [], applied: "" };
  return completeToken(argsStart + tokenStart, token, slot.pool(), {
    uniqueSuffix: slot.uniqueSuffix,
    kind: slot.kind,
  });
}

/** shape's two fixed word slots: the domain vocabulary (SHAPE_DOMAINS —
 * the verb's own table, never a copy), then the registry's names FOR the
 * already-typed domain. An unknown domain enumerates nothing. */
function completeShapeSlots(ctx: CommandContext, argsStart: number, argsHead: string): Completion {
  const { prior, token, tokenStart } = argPosition(argsHead);
  const at = argsStart + tokenStart;
  if (prior.length === 0) {
    return completeToken(at, token, Object.keys(SHAPE_DOMAINS), {
      uniqueSuffix: " ",
      kind: "value",
    });
  }
  if (prior.length === 1) {
    const domain = (SHAPE_DOMAINS as Record<string, "point" | "edge" | "vertex">)[prior[0].text];
    if (domain === undefined) return { start: at, candidates: [], applied: "" };
    const info = ctx.shapesInfo().find((i) => i.domain === domain);
    return completeToken(at, token, info?.names ?? [], { kind: "value" });
  }
  return { start: at, candidates: [], applied: "" };
}

/** rm's selector names MODS, not points: the deletable pool is the
 * workspace mod names (rm refuses built-ins, so they never complete) plus
 * the `all` keyword. Selector terms split on `+` with spaces optional, so
 * the token runs back to the nearest `+` or whitespace. */
function completeRmSelector(argsStart: number, argsHead: string): Completion {
  let ts = argsHead.length;
  while (ts > 0 && !/[\s+]/.test(argsHead[ts - 1])) ts--;
  const pool = [
    ...listRecipes().filter((mod) => mod.origin !== "built-in").map((mod) => mod.name),
    "all",
  ];
  return completeToken(argsStart + ts, argsHead.slice(ts), pool, { kind: "value" });
}

/** add/remove: `<verb> @name <target-expr>` — the target is the SECOND
 * argument. Cursor still in the first chunk → the plain target slot
 * (completeTarget's @-handling already completes the leading reference);
 * past a leading @chunk → the pure expr-relative core over the sliced
 * remainder, re-based to its offset (the slice is what completeTargetExpr
 * exists for). A non-@ first chunk is a malformed lead — inert. */
function completeSecondArgTarget(
  ctx: CommandContext,
  argsStart: number,
  argsHead: string,
  targetSlot: () => Completion,
): Completion {
  const chunks = chunkWords(argsHead);
  if (chunks.length === 0) return targetSlot();
  const first = chunks[0];
  if (chunks.length === 1 && first.end === argsHead.length) return targetSlot();
  if (!first.text.startsWith("@")) {
    return { start: argsStart + argsHead.length, candidates: [], applied: "" };
  }
  const inner = completeTargetExpr(
    argsHead.slice(first.end),
    argsHead.length - first.end,
    ctx.tree,
    ctx.hierarchy,
    ctx.pointTypes,
    ctx.committedEntries(),
  );
  return { ...inner, start: inner.start + argsStart + first.end };
}

/**
 * Complete the token under `cursor` in a partial command line — the
 * VERB-AWARE DISPATCHER over completion (`runCommand`'s sibling): it parses
 * the verb (the first word of `text[0..cursor)`) and routes the cursor's
 * slot —
 *   · cursor still in the first word → verb-name completion (completeTarget's
 *     verb position, unchanged);
 *   · an enumerable NON-TARGET slot under the cursor — a mod's `?params`,
 *     bake/bind's channel + axis, unbind's axis, the color/style value
 *     words, shape's domain + name, background's color, rm's mod
 *     selector, help's verb — → that slot's vocabulary, settled through
 *     the ONE shared completeToken helper — never a second settle path;
 *   · anything else → target completion (completeTarget — add/remove
 *     re-based past their leading @name), so target-grammar completion is
 *     untouched. Numeric slots (sizes, opacities, dashes, ranges) and hex
 *     colors stay unenumerable no-ops.
 * Total like completeTarget: junk and unenumerable slots yield an empty
 * Completion, never a throw. Only `text[0..cursor)` is considered.
 */
export function completeCommand(
  ctx: CommandContext,
  registry: CommandRegistry,
  text: string,
  cursor: number,
): Completion {
  const head = text.slice(0, Math.max(0, Math.min(cursor, text.length)));
  const targetSlot = (): Completion =>
    completeTarget(
      text,
      cursor,
      ctx.tree,
      ctx.hierarchy,
      ctx.pointTypes,
      ctx.committedEntries(),
      registry.verbs(),
    );
  // cursor still inside the first word (or leading whitespace) → verbs
  if (/^\s*\S*$/.test(head)) return targetSlot();
  const m = /^(\s*\S+\s+)([\s\S]*)$/.exec(head);
  if (!m) return targetSlot(); // defensive — the test above makes this unreachable
  const verb = m[1].trim();
  const argsStart = m[1].length;
  const argsHead = m[2];

  // the built-in verbs with enumerable non-target slots
  switch (verb) {
    case "bake":
      return completeSlotsAfterTarget(argsStart, argsHead, targetSlot, [
        channelSlot(ctx),
        axisSlot(false), // bake refuses offset — the pool says so
      ]);
    case "bind":
      return completeSlotsAfterTarget(argsStart, argsHead, targetSlot, [
        channelSlot(ctx),
        axisSlot(true),
      ]);
    case "unbind":
      return completeSlotsAfterTarget(argsStart, argsHead, targetSlot, [axisSlot(true)]);
    case "add":
    case "remove":
      return completeSecondArgTarget(ctx, argsStart, argsHead, targetSlot);
    case "colorpoints":
    case "colorbonds":
    case "colorbondsof":
    case "colortrace":
      return completeSlotsAfterTarget(argsStart, argsHead, targetSlot, [colorSlot()]);
    case "stylepoints":
    case "stylebonds":
    case "styletrace":
      return completeSlotsAfterTarget(argsStart, argsHead, targetSlot, [styleSlot(ctx)]);
    case "shape":
      return completeShapeSlots(ctx, argsStart, argsHead);
    case "background":
      return completeFirstWord(argsStart, argsHead, colorSlot());
    case "rm":
      return completeRmSelector(argsStart, argsHead);
    case "help":
    case "?":
      return completeFirstWord(argsStart, argsHead, {
        pool: () => registry.verbs(),
        kind: "value",
      });
  }

  // a mod's own verb: the ?parameter slots (the target slot falls through)
  const recipe = getRecipe(verb);
  if (recipe !== undefined && recipe.kind === "analysis") {
    return completeModInvocation(recipe, argsStart, argsHead, targetSlot);
  }

  return targetSlot();
}

/** Tab completion for the terminal — the late-bound closure main.ts wires:
 * completeCommand over the live ctx/registry; the terminal ships
 * {text, cursor} and applies the result. */
export function makeRunComplete(
  ctx: CommandContext,
  registry: CommandRegistry,
): (text: string, cursor: number) => Completion {
  return (text, cursor) => completeCommand(ctx, registry, text, cursor);
}
