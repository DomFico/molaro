# Command layer — architecture & invariants

The knowledge a future coding agent needs before touching this layer, gathered
from the commit history (`82226ce` … `5ba5c83`) into one place. The user-facing
grammar is documented in [COMMANDS.md](COMMANDS.md); this note is about *why
the code is shaped the way it is* and which properties must not regress.

## Consistency principles

Invariants that govern the layer. When a change touches one of these areas,
this section is the check it must pass; add future invariants here rather
than scattering them.

1. **A committed selection is flat to its MEMBERS.** `@name` resolves to the
   selection's stored entries; `@name.<pred>` filters those stored entries —
   matching a predicate against a member's own label (for label-level
   members) or its type/index (for point-level members) — and does **not**
   descend into the ancestry of points beneath a member. A predicate that
   names something below a stored member (a descendant label, or a point
   index inside a coarse member) matches nothing — that granularity isn't in
   the selection. To address finer entries, commit a finer selection
   (`create_sele <deep-path>`); its members then ARE the fine entries: depth
   is a property of how a selection was committed, not a hidden capability
   of the filter. This guarantees the terminal never produces state finer
   than the UI can display and reverse — every filter result is a whole
   member, every operation on it whole-member, exactly as a panel gesture.
   `@name.a.b` stays an error (one predicate, no path descent; the message
   points at the reserved `&`), and completion after `@name.` offers exactly
   the stored member labels/types under the "filter by" header.
   **Superseding note:** an earlier version of this principle said the
   filter matches over the points' retained ancestry (match-anywhere) —
   that is REVERSED here; the filter sees membership only. The old rule let
   commands create sub-member hidden state the UI could neither display per
   row nor clear with its gestures.

2. **The terminal must not create state the UI cannot represent and
   reverse.** When a command capability would produce selection/visibility/
   representation state that no UI gesture can display or undo, the
   capability is wrong, not the UI — resolve it by matching the UI's
   granularity, never by adding hidden depth. New verbs are checked against
   this. (This is the second reversal driven by that class of problem; the
   first was the flash/echo presentation implying structure.)

3. **A commit-then-act verb commits only when its target isn't already
   committed — all-or-nothing at the whole-target level.** A target made
   entirely of committed references (`@name` terms joined by `+`, `@all`
   included) is already committed: the verb acts on those selections in
   place and creates nothing (`hide @a + @b` flips two hidden flags in ONE
   undo op; a `[name]` is a usage error there). Any non-reference term — a
   path, a glob, a `#` term, the `all` keyword — makes the WHOLE target
   commit as one new selection, referenced selections contributing entries
   but staying untouched themselves (`hide @a + <path>` creates one new
   hidden selection; `@a` keeps its own state, and show-wins handles the
   overlap). There is no per-term splitting: one target, one decision. So
   `hide @all` hides everything committed with zero new state, while
   `hide all` commits one honest whole-system selection — same verb, the
   commit decided by what the target already is. Future commit-then-act
   verbs inherit this rule.

4. **Carving is not exposed to the terminal.** Membership mutation operates
   at whole-member granularity only: `add` inserts tree-addressed entries
   as members at their natural level; `remove` drops entries that are
   already members. Neither splits a coarse member into its complement (the
   model's carve operation, which materializes the sibling set — its most
   expensive op). A remove predicate that names something below a stored
   coarse member (a descendant, not a member) matches nothing — it does not
   carve. To operate on finer entries, commit a finer selection so those
   entries ARE members. This keeps membership mutation cliff-free and
   consistent with principle 1 (flat-to-members).
   **Deletion corollary:** deleting a selection happens ONLY through the
   bare forms — `remove @name` (one selection, the panel-✕ analog) and
   `remove @all` (every selection; the one deliberate bulk delete, of the
   selection OBJECTS, not their members). Emptying a membership — via
   `remove @name all` or an incidental last-member predicate — always
   leaves the selection standing as an empty block, matching the UI, which
   never auto-deletes (only its ✕ button deletes). Incidental and explicit
   empties behave identically.

## Layering and the purity fence

```
webview/address.ts    parseTarget / resolveTarget / completeTarget — PURE
                      (no DOM, no Three; unit-tested directly in Node)
webview/commands.ts   CommandRegistry + runCommand dispatcher + verb handlers
                      (view, help/?) — pure except through the injected context
webview/main.ts       the CommandContext wiring: the SAME closures the mouse
                      gestures call (focusPoints, frameVisible, flashPointRows),
                      the host-message routing, and the window.__viewer seam
webview/terminal.ts   a deliberately DUMB surface: ships {command|complete,
                      id, text[, cursor]} through the extension host, prints
                      whatever {commandResult|completeResult} returns
src/extension.ts      the host is a verbatim relay between the two panels
```

Keep `address.ts` free of DOM/Three imports — its Node-testability is what
makes the grammar cheap to evolve. The terminal holds **no hierarchy and no
domain state**; all resolution and completion happen viewer-side.

## The registry, not a switch

Verbs enter through one mechanism — `registry.register(verb, handler,
description)` — and the dispatcher knows nothing about any specific verb.
Built-ins (`view`, `help`, `?`) are the first entries of the same API future
or user-supplied verbs will use. `registry.verbs()` feeds verb autocomplete,
and `describe(verb)` feeds `help <verb>`, so a new verb appears in both for
free. Do not add a switch over verb names anywhere.

**The defining contract:** executing a command must be indistinguishable from
performing the equivalent gesture — same state mutations, same camera tween,
same flash animations, same row feedback. Handlers call the exact action paths
the mouse gestures call; commands get no rendering or camera code of their own.
The S9 suite asserts camera-pose equality (to 0.01) between commands and real
clicks/drags.

### Built-in vs. mod verbs — and why a push REPLACES

A mod's code lives in **two** name-keyed caches in the webview: its entry in the
recipe registry (which holds `mod.code`, the string shipped to the producer) and
its command handler, **which closes over the mod object**. `installModList` is
the one door both are written through — at boot, and again after every
`write_mod` save — and **a re-push replaces both together**. Replace one without
the other and the viewer runs a mod that no longer exists.

The guard in front of them refuses exactly one thing: a name that is a **built-in
verb**, so a mod file can never shadow one. It must *not* ask "is this name
already a verb" — that is true of every already-installed mod, **including the
one being replaced**. `CommandRegistry.sealBuiltins()` (called once by
`createCommandRegistry`, after the built-ins are in and before any mod can be
installed) draws that line; `isBuiltin()` is the question the guard asks.

This is not a style point. `write_mod` is a **gated** tool: the human is shown a
mod's full source and approves it. Conflating the two questions meant a rewritten
mod collided with *itself*, was skipped, and kept running its first version — the
human approved version B and version A executed. `delete_mod` + rewrite appeared
to "fix" it only because it is the one path that evicts those caches (a
content-keyed "cache-bust" comment does nothing; nothing here keys on content).
**S35 pins the invariant: the code that RUNS is the code that was APPROVED.**

And because registration happens in the *webview* while the file is written by
the *host*, `write_mod` must not report a registration it never heard confirmed:
the push carries an `id`, the viewer answers `modInstallReport` on the existing
id-correlated `commandResult` channel, and the tool reports **that** — never its
own disk write. A skipped registration is an error in the assistant's transcript,
naming the reason, not a line on a surface it cannot read.

## Resolution mirrors the VISIBLE tree

`resolveTarget` descends `classification.ts buildTree`'s `TreeModel` — the
same object the bottom panel renders — **not** `Hierarchy.childrenOf`. The two
diverge: a group whose points span categories is pinned by `childrenOf` to its
first-seen category, while `buildTree` renders it under *each* category with
only that category's subgroups. Parity with what the user clicks is the
layer's contract, so the resolver follows the render model; any future
`buildTree` change propagates automatically.

Recorded finding behind the design: `Entry {level, id}` **cannot express
"group G restricted to category C"** (and the contract permits both groups and
subgroups to span categories — only subgroup→group is constrained). Hence the
explicit decision: a category-prefixed path *descends* category-scoped
(`alpha.group-0.*` stays in alpha's branch), but a path *terminating* at a
group yields the bare group entry — the whole group, exactly what clicking
that row selects. Don't "fix" one side without the other; S9's spanning-group
checks lock both.

## Flash-parity: point-set intersection, never entry identity

Row highlighting for commands matches by **point-set intersection**
(`Hierarchy.entryIntersects` + `flashPointRows` in main.ts): a row flashes iff
it is mounted and at least one of its covered points is in the resolved union.

Why: the original matcher compared rows by `(level, id)` entry identity, and
`@name` filters always resolve *point-level* entries — so a mounted subgroup
member row never matched, and `view @sel."<subgroup label>" + @sel.<type>`
flashed only the type term's rows. Entry-identity matching silently drops any
term that resolves at a different level than the mounted row. Do not
"simplify" back to identity matching. Consequences that are intended, not
bugs: mounted ancestor/descendant rows of the resolved set also flash
(intersection semantics), and unmounted rows (collapsed/scrolled-out of a
virtual list) never flash — the no-force-expand rule.

S10 asserts the invariant *exactly* — flashed == mounted ∩ resolved, no
missing term, no extra rows — across a 20-case matrix; that exactness is the
property every earlier suite missed while the bug was live.

## `#` and `@name` semantics (condensed)

- `#N` / `#lo-hi` address the contract point index. The `#` is the sole
  distinguisher from label ranges (`44-55` = trailing integer of a label).
  Placement is parse-enforced: standalone term or a path's 4th segment only,
  where it **intersects** the scope (containment check). Out-of-range = 
  nomatch; ranges clamp to `n_points` so `#0-99999999` materializes nothing.
  Range bounds are UNORDERED for both kinds (`inRange` normalizes to
  `[min, max]`; normalization before clamping): a range denotes a set, not a
  direction — `..` stays reserved if an ordered range is ever wanted.
  `#*` is the all-indices wildcard ({lo:0, hi:Infinity} in the spec; clamped
  like any range). Standalone it ≡ `*` in point terms; in a `@name` filter it
  matches only the stored POINT-level members (membership-only, principle 1).
- `@name` = the committed selection's stored entries; `@name.<pred>` filters
  the STORED MEMBERSHIP — each entry matched at its own level (label-level
  members by label, point members by type/index) — and never reaches the
  ancestry of points beneath a member (REVERSED from an earlier
  match-anywhere rule; see principle 1). Results are the whole matched
  members at their stored levels. Exactly one trailing predicate (`@n.a.b`
  errors); it binds tighter than `+`.
- `all` (bare keyword) = everything in existence — resolves to every
  top-level category entry, ≡ the union of all top-level categories. It is
  a keyword only when it IS the whole term: `all.x`, `allx`, and `"all"`
  are ordinary path tokens. `@all` = everything **committed** — the union
  of every committed selection's stored entries (deduped); empty when
  nothing is committed (honest nomatch downstream). `@all.<pred>` filters
  the pooled membership under the same membership-only rule. Both compose
  with `+` like any term. In hide's commit rule they sit on OPPOSITE sides:
  `all` is a non-reference (commits), `@all` is all-reference (in place) —
  see principle 3. "all" is therefore a **reserved selection name**: both
  `create_sele … [all]` and `rename … [all]` refuse it, so `@all` can never
  be shadowed.
- `view` frames the **full resolved union, hidden points included** (the
  row-click analog; only the pulse is visibility-gated by the overlay).
  Bare `view` = `frameVisible`, the empty-space-click analog, parked during
  edit mode. Commands are read-only: no selection state, no undo entries.

## The mutation template (`create_sele`)

`create_sele` is the first state-mutating verb and the shape every future one
inherits (`commitTargetEntries` in main.ts):

- **Route through the existing model, never a parallel path**: the wiring
  parks edit mode (`endEdit`/`beginEdit` — mode flips are deliberately not
  undoable), stashes any in-progress pending target out, adds the resolved
  entries via `addToTarget`, calls the SAME `SelectionModel.commit()` the
  button uses (whose undo swaps the original set object back), renames if a
  `[name]` was given, restores the stash — **all inside one stroke**, so a
  single Ctrl+Z reverts the entire command with no residue. Model gap found
  and routed around (not forked): `commit()` returns null during edit mode,
  hence the park/restore.
- **Entry-level parity**: the verb commits exactly the resolved entries at
  their natural levels — never expanding a coarse entry to points, never
  collapsing fine entries. Unions produce mixed-level member lists; correct.
  Finding: the auto-seeded bulk selections store ONE coarse category entry,
  so `… + @<seed>` adds a single member row — the large-member-list cost only
  arises for fine-grained user selections (accepted per the handoff; do not
  "fix" by collapsing entries).
- **`[name]` parsing** is `splitTrailingName` in address.ts (pure): the
  trailing bracketed run is the literal name; `[ ]` remain reserved inside
  the target expression. Explicit-name collision is checked before any
  mutation and errors; auto-names come from the model's `selection_N` namer.
- **The green commit pulse**: a manual create shows green while building,
  then commits neutral. The verb reproduces that beat by pulsing the
  committed rows with the EXISTING `sel-covered` class through the EXISTING
  `flashRow` mechanism (`flashPointRows(points, "sel-covered")`) — no new
  visual style. S11 asserts the pulse plays and settles.
- S11 is the parity suite: gesture-built and command-built selections must
  snapshot identically (entries, levels, member rows, brackets).

`hide`/`show` extend the same template:

- `hide <target>` decides commit-vs-in-place by principle 3. A target made
  entirely of `@` references (`@all` included — the handler expands it to
  every committed selection) hides IN PLACE through `setRefsHidden`: ONE
  stroke wraps the whole batch (whole flags via `setHidden`, filtered
  member subsets via `setEntryHidden` — never the self-stroking
  `setEntriesHidden` inside an outer stroke), so `hide @a + @b` /
  `hide @all` are one undo op each and commit nothing; a `[name]` there is
  a usage error. Any non-reference term makes the WHOLE target commit once:
  the commit template with `setHidden(true)` folded into the SAME stroke
  (`commitEntries(entries, name, hide)`) — one undo removes selection +
  hidden state together; referenced terms contribute entries while their
  selections stay untouched (`hide all` is this arm: one honest
  6000-point selection). `hide @name` / `show @name` are the whole-flag
  mutators; `@name.<pred>` subsets resolve to whole members (row-purple,
  gesture parity). (An earlier `setEntryHidden` widening to covered
  sub-member entries was REVERTED with the membership-only reversal — see
  the show bullet.)
- `show` NEVER commits (a point in no selection is already visible).
  MEMBER-STATE SYMMETRY is now structural: `hide/show @name.<pred>` both
  resolve WHOLE MEMBERS and route through `setEntriesHidden`, so a show
  clears exactly the member state the matching hide wrote — no sub-member
  state exists to split (the old setPointsHidden split machinery was REMOVED
  with the membership-only reversal; the widened setEntryHidden guard was
  reverted to members-only, so finer-than-member hides cannot be reached at
  all). `show @name` = `clearAllHidden`: the whole flag AND every member
  hide (the reliable inverse of any hiding on that selection); the path form
  clears every selection covering the named points; bare `show` clears all
  hidden state. Each action is one stroke = one undo op; empty strokes push
  nothing, so idempotent calls leave the undo depth untouched. A member show
  against a WHOLE-hidden selection reports `hidden whole — show @name to
  reveal it` rather than a misleading "nothing hidden there".
- `hide` never toggles (idempotent `already hidden`); bare `hide` errors (no
  gesture analog, destructive-feeling). Messages report the ACTION —
  show-wins masking means a hide may change no pixels; that's the accepted
  trade-off, not a failure.

The REPRESENTATION FAMILY extends the template into representation state —
a TWELVE-VERB GRID: four shapes (how a point set maps onto a primitive) ×
three axes (color, size, opacity). `colorpoints` shipped first as `color`
and was renamed when the family grew (no alias — `color` is an unknown
command; the rename is pinned by unit, E2E, and smoke checks). Per axis:
three contained shapes at three granularities (point / edge-both /
subgroup-vertex) and one intentional reach (edge-either). The grid
guarantee — the verbs of one shape CANNOT diverge across axes — is
structural, not conventional: `resolveRepArgs` is the one generic front
half (argument shape + resolution, parameterized only by the value parser
and its error wording: `parseColor` / `parseSize` / `parseOpacity`, the
scalar two sharing `parseNumericToken`), the mapping predicates are written
ONCE (`edgesMatching` for both/either, `activeTraceVertexIds` for the
subgroup map-up) and called by all three axes' handlers, and ALL NINE
writer closures (3 primitives × 3 axes) come out of the one `makeRepWriter`
factory in main.ts (stride 3 for color, 1 for the scalars). Unit tests
assert the shared sets three ways; the code has one implementation to
assert about:

- **Non-selection mutations.** Writes land in the representation layer's
  buffers — one per primitive per axis: `rep.state.color` / `.size` /
  `.opacity` (per-point), `.edgeColor` / `.edgeSize` / `.edgeOpacity`
  (per-EDGE, header edge order — each shared by BOTH edge verbs of its
  axis, composing by last-write-wins per edge), `.traceColor` /
  `.traceSize` / `.traceOpacity` (per-POLYLINE-VERTEX, header vertex order
  = the flattened `header.polylines`). Alpha is a SEPARATE buffer per
  primitive — the RGB color buffers stay RGB, so the independence matrix
  can assert color ⊥ opacity. The uniform base look is each buffer's
  initial value (alpha base 1 = fully opaque), so unwritten elements keep
  it with no merge/override machinery. All nine wiring closures come out of
  `makeRepWriter`, mirroring how `refreshPoints` writes `rep.state.visible`
  directly. Each verb writes ITS primitive's buffer on ITS axis and touches
  no other (S16/S17/S18/S19 assert the independence across the whole grid,
  nine buffers by twelve verbs).
- **SIZE ⊥ HIDE, OPACITY ⊥ HIDE.** A zero on either scalar axis is a
  literal value: it never hides, never touches `visible` or any selection
  state, and the message reports the action (`set N points to size 0` /
  `… to opacity 0`), never "hidden" (S18/S19 pin the visible buffer
  byte-identical across zero writes, with the points still resolving and
  pickable). A zero-OPACITY element is invisible-but-PRESENT — exactly what
  makes "fade to fully transparent while keeping it selectable"
  expressible; a hidden element is gone. Size clamps negatives to 0;
  opacity clamps two-sidedly to [0, 1] — both report the clamp; non-numeric
  tokens error.
- **Opacity RENDERS today (unlike the widths) — via naive blending.** The
  point pass gained an `aOpacity` attribute (`gl_FragColor = vec4(vColor,
  vOpacity)`, `transparent: true`, and a discard at exactly-zero alpha so
  an invisible-but-present point never punches a depth hole; picking is
  CPU-side and never reads alpha). The two line passes carry alpha as the
  4th component of an itemSize-4 color attribute (three.js
  `USE_COLOR_ALPHA`) — the GPU arrays are DERIVED from the separate
  rep-state color+opacity buffers by `fillEdges` / `syncTraceSlots`.
  Blending is draw-order NAIVE: no depth sorting exists (drawables render
  in scene order; three.js sorts transparent objects per-object only, and
  each pass is one object), so overlapping SEMI-transparent elements may
  mis-composite — accepted, and formally recorded as the depth-sort/OIT
  follow-up (see open threads). Note the difference from the width
  follow-up: opacity is visible-but-may-mis-composite-on-overlap; width
  was not-visible-at-all.
- **Point size renders as SPHERE IMPOSTORS and edge width as INSTANCED
  TUBES (both world-anchored); trace width is still STATE ONLY.** The base
  point pass ray-traces a shaded
  sphere per point (`webview/shaders.ts` — a fixed headlight Lambert, no
  scene lights): `rep.state.size` now means a **world radius** = `k` × the
  stored value, where `k` (`worldPerSizeUnit` in `webview/geometry.ts`) is
  the ONE scene-scale constant, derived from the same `sceneExtent(header)`
  call the camera framing consumes — **never fork S**: pixel parity is a
  relationship between `k` and the camera, so both must read one value
  (even on the null-bbox fallback box both misframe together and a
  default-size element still lands at ~its historical pixel extent at the
  initial framing; sizes now scale with zoom instead of pinning to screen
  pixels). The size-value MEANING is unchanged and the `DEFAULT_*`
  base-look constants are untouched. Both overlays (pending green, focus
  flash) bind the same `aSize` attribute and the same sizing GLSL chunk at
  the same radius, so highlighting covers exactly the base silhouette — and
  a size-0 point shows no overlay, ever. `size 0` now draws **zero pixels**
  (the pre-impostor pass left a ~1px min-point-size residue — a "state
  without pixels" defect found by measurement; the radial discard fixes
  it), while the point still resolves and picks. Two depth behaviors ship
  in ONE shader behind the `molaro.viewer.depthVariant` dev switch
  (variant 1 = flat sprite depth, early-Z kept; variant 2 = analytic
  `gl_FragDepth`, correct interpenetration; the default is PROVISIONAL —
  the choice is made outside this lane on `tests/impostor_bench.ts`
  real-hardware numbers, and the switch is global across all geometry
  passes because a mixed scene clips wrongly at primitive junctions).
  `depthWrite` is pinned EXPLICITLY on all three geometry materials in the
  one factory that consumes the switch, and S32 asserts it — if the
  override lapsed, occlusion would silently revert to draw-order. Edge
  widths draw as instanced tubes (increment B — see the instanced-edge-pass
  entry below); the POLYLINE pass still rasterizes 1 px GL lines, so
  `traceSize` remains complete as command + buffer + undo but produces no
  visible thickness until increment C's tube pass (see open threads).
- **Impostor rendering: recorded trade-offs (accepted, do not "fix"
  piecemeal).** (1) `gl_PointSize` clamps at the driver cap (measured
  1023 px on the harness): a sphere stops growing once the camera is
  extremely close. (2) GL clips points by CENTER: a large near sphere pops
  out entirely when its center leaves the view. (3) The overlays keep
  `depthTest: false` — silhouette-coplanar depth testing would z-fight —
  so a highlighted element BEHIND opaque geometry shows its tint through;
  true today as before, merely more visible on solid spheres. (4) A header
  with **no bbox** anchors `k` to the default box permanently while later
  camera moves find the real data — element sizes may be misscaled for
  such a dataset; the viewer says so LOUDLY (status-line warning, pinned by
  S33 and a unit test) rather than silently. (5) Picking stays CPU-side and
  center-based: a large sphere is picked by proximity to its center, not
  across its drawn face (invariant — radius-aware picking would couple
  picking to representation state).
- **The INSTANCED edge tube pass** (increment B — supersedes the de-indexed
  LineSegments pass per-edge color originally forced). Edges draw as
  camera-facing quads with real world thickness: one static base quad
  instanced per edge, expanded in the vertex shader to radius
  `k × rep.state.edgeSize[e]` — the SAME scene-scale constant (one uniform
  object) the sphere pass uses, so the default point : edge ratio is
  geometric and `bondsize`/`bondsizeof` finally MOVE PIXELS. Per-instance
  attributes split by update cadence: endpoints re-copy on every
  displayed-frame flip (6 floats/edge, branch-free — measured cheaper than
  the old de-indexed fill at every scale); visibility only on hide/show;
  radius only on size writes; RGBA only on color/opacity writes.
  **Instance slot ≡ header edge index, never compacted** — the GPU arrays
  share the rep buffers' element order with no remap anywhere (hidden and
  zero-radius edges collapse in the vertex shader instead; do NOT introduce
  compaction as an "optimisation": it drags radius/RGBA into the per-flip
  loop and reintroduces a two-lists remap). Tube shading is the cylinder
  profile of the sphere pass's headlight Lambert; depth follows the ONE
  global variant (v1: fragments keep the quad's interpolated AXIS depth —
  the billboard plane contains the axis, so tube and sphere agree exactly
  at a shared endpoint, no junction hole; v2: analytic cylinder-surface
  depth through the same projection row). Zero alpha discards; zero radius
  collapses — both literal zeros, S34-pinned. **The junction is correct BY
  GEOMETRY** (brief B′): each tube end is trimmed to d = √(max(0, r_s² −
  r_t²)) from its endpoint's centre, putting the end ring exactly on that
  point's sphere surface from every angle (equal radii → d = 0, perfect
  capsule; a sphere ≥ the tube caps the end, so the shader discards past
  the ring; a tube swallowed whole collapses). The quad EXTENDS one radius
  past each trimmed end so the fragment shader — not the quad boundary —
  decides the silhouette; an EXPOSED end (sphere strictly smaller, incl.
  size 0) grows a hemispherical cap, so a bare tube end reads solid, never
  as a cut pipe. The endpoint sizes ride two per-instance attributes
  (iSizeA/iSizeB) at REP-WRITE cadence — pointsize writes update exactly
  the incident edges' slots via a point→edges map; frame flips never touch
  them (S34 asserts the upload versions). Because the trim is geometric,
  the junction assertions are variant-UNIFORM: no tube pixel on a larger
  sphere's near face under either variant.
- **The polyline pass stays zero-copy** — per-VERTEX color is exactly what
  indexed geometry renders natively. The pass keeps sharing the points'
  position attribute (nothing re-copies on frame flip) and gains a per-POINT
  color attribute (indexed draws fetch attributes by point index; only the
  polyline-vertex slots ever draw), written through from
  `rep.state.traceColor` on color-write only. The GPU interpolates between
  vertex colors along a segment, so a colored↔uncolored boundary renders as
  a GRADIENT toward the base look — inherent to per-vertex color and
  intended; there is no per-segment rule. This is the resolution of the
  former colortrace deferral: the segment-ownership ambiguity dissolves at
  vertex granularity (each vertex IS a point with one subgroup), and the
  gradient boundary is accepted as the honest rendering of it.
- **One undo system, ever** (the corollary of the founding contract): rather
  than a parallel stack, `SelectionModel.recordOp(undo)` is the one public
  seam for external undoable state — it routes through the same private
  `pushUndo` as every model mutator, so it coalesces inside strokes and pops
  on the same system-wide Ctrl+Z. Each closure captures the previous RGB of
  exactly the written elements and records their restoration (LIFO composes:
  undoing a re-color restores the *earlier* color, and unwinding every
  stroke restores the pristine buffer — S15/S16/S17 prove all three).
- **Targets exactly like `view`**: same `resolveTarget`, same point-union
  dedupe (`resolveColorArgs`, the family's shared front half in commands.ts),
  hidden points included, never commits. The verbs differ ONLY in mapping
  the point set onto a primitive: colorpoints = identity; colorbonds = edges
  with BOTH endpoints in the set (contained — parity-preserving); colorbondsof
  = edges with AT LEAST ONE endpoint in the set (incident — an edge whose
  other endpoint is OUTSIDE the target is colored INTENTIONALLY; the
  one-hop reach is the verb's contract and the reason it is a separate verb,
  not a flag); colortrace = polyline vertices whose SUBGROUP contains a
  resolved point (contained at subgroup granularity — the map-up is
  resolution-to-primitive-GRANULARITY, a single point activating its whole
  subgroup's vertex, never colorbondsof's reach-out; on the synthetic data
  a single-category target therefore colors a SCATTERED vertex set, pinned
  as correct by S17). One stroke per invocation; last-write-wins per
  element; nomatch / unknown color / usage errors write nothing and push no
  stroke — including the well-formed-but-empty cases (`colorbonds` on a
  one-point set, `colortrace` on subgroups owning no vertices). Messages
  report the ACTION and count (`colored N points/edges/trace vertices …`) —
  show's report-the-action rule; colored-but-hidden is legitimate state.
- **Argument shape**: `splitTrailingWord` in address.ts (pure, quote-aware)
  splits the trailing color token off the target expression, so quoted
  spaced labels survive (`colorbonds gamma.group-2."subgroup 11" red`).
  `parseColor` in commands.ts validates CSS names (the full named-color
  table) and `#hex`/`#rgb`, case-insensitively — a color token is CSS, not
  a grammar label.
- **Principle-2 check** (how a verb with no panel surface passes it): the
  state is displayed by the viewport itself (the base-pass pixels) and
  reversed by the system-wide undo; it adds no hidden depth the UI cannot
  account for. A gesture analog may come later with the styling layer; the
  commands deliberately created no new UI surface.

## `ls`, `rename`, `clear`

- `ls` is READ-ONLY — no model mutation, no undo entry, ever. Its three
  forms each mirror an existing panel surface as text: bare `ls` = the
  committed-selections section (name, point count, `· hidden` marker);
  `ls @name` (and `ls @all`) = the STORED member list exactly as the panel
  shows it (membership only, principle 1); `ls <path>` = the contents ONE
  level below the resolved nodes (points list nothing below). All listings
  share completion's `COMPLETION_LIST_CAP` volume rule — past ~50 lines it
  prints a count-and-hint instead. `ls` takes no `[name]`.
- `rename @name [new]` routes through the SAME `SelectionModel.rename`
  the panel's inline rename uses — one undo op, identical collision error
  (`a selection named "<new>" already exists`), full parity. Exactly one
  unfiltered `@name` (not `@all`, no predicate, no paths) — anything else
  is a usage error; a missing `[new]` errors. `"all"` is refused as a new
  name (reserved for `@all`) here and in `create_sele`.
- `clear` is TERMINAL-LOCAL: the surface intercepts it before the host
  relay, wipes its own log, and resets the completion-preview dedup —
  viewer state and undo history never hear about it. It is still a
  registered verb so `help` can explain it. Distinct from the panel's
  "Clear" button, which discards the pending TARGET (a viewer-state
  operation with a two-step confirm); the shared word is unfortunate but
  each surface's noun is its own.

## `add`, `remove` — membership mutation

The command analog of edit mode; these complete the selection verbs. Both
take exactly ONE lone `@name` first — `@all` (except remove's bare
bulk-delete form), filters, unions, and paths on the left are usage errors,
because the UI cannot edit two selections at once (`splitLeadingRef` in
address.ts does the argument-shape split; the verbs word the errors). The
second argument differs IN KIND, and that asymmetry is the design:

- `add @name <tree-target>` — the right side is a TREE address (the full
  grammar: paths, globs, ranges, `#`, lists, `+` unions, resolved by the
  same `resolveTarget` view/create_sele use) because the entries being
  added are not yet members and must be named from the tree. `@` terms are
  a usage error: the UI cannot transfer members between selections, so
  neither can add. Resolved entries join at their NATURAL level
  (entry-level parity); entries already stored are filtered out first, so
  re-adding is an honest no-op that pushes no undo entry.
- `remove @name <member-pred>` — the right side is MEMBER predicates
  (labels, types, globs, ranges, `#index`, lists, `+` unions), each term
  resolved by the SAME `@name.<pred>` matcher (built as a synthetic
  single-ref TargetAst), so remove and filtering cannot diverge on what "a
  member matches" means. No tree paths — you are already scoped to the
  member list. The other forms: `remove @name all` = a star over the
  members (empties it; the selection REMAINS); bare `remove @name` =
  DELETE (the ✕ analog); `remove @all` = delete every selection in one
  stroke. See principle 4 for the no-carve and deletion rules.
- Wiring (`mutateMembers` in main.ts): edit mode is PARKED onto the named
  selection and the prior mode restored after (beginEdit/endEdit — mode
  flips are deliberately not undoable), with every addToTarget /
  removeFromTarget call — the exact gesture mutators — inside ONE stroke =
  one undo op; the verbs are edit-mode independent (mid-edit of another
  selection they still land on the named one). remove receives only exact
  stored members, and the wiring's `set.has(e)` guard skips anything else,
  so `removeFromTarget`'s carve branch is structurally unreachable from
  the terminal. `deleteSelections` batches the panel-✕'s
  `model.deleteSelection` in one stroke — `remove @all` restores every
  selection, intact, with a single Ctrl+Z.
- Feedback is the model's own onChange cascade — member rows appear and
  disappear in the block exactly as edit-mode gestures make them; no new
  styles, no flash.

## Completion

`completeTarget` is resolution's inverse over the SAME descent helpers
(`catsMatching`/`groupsMatching`/`subgroupsMatching`) — completion and
resolution cannot disagree about what sits under a prefix. Rules that took
deliberate decisions:

- Path segments follow the STATELESS TWO-STAGE rule (`pathStage`): a partial
  token settles (unique → full label, several → common prefix + list; never a
  dot); a token that already EXACTLY equals a node label at a descendable
  level (category/group/subgroup, or an exact `@name` — the selection's
  filter level sits below it, so second Tab appends `.` and offers its
  identity pool via `selectionPool`) appends `.` and offers the next level's
  candidates — unconditionally, even when longer siblings share the token as
  a prefix. An exact LEAF token is terminal (no dot, no candidates). The rule
  is a pure function of (text, cursor) — no last-Tab state anywhere; do not
  add any. Unique verb completion still appends a space; `@name.`-filter
  tokens never descend.
- No-op on `*` tokens and on **range-in-progress** tokens (`^\d+-\d*$`) only —
  deliberately narrower than "contains a dash", or `group-0`-style labels
  would be uncompletable. `#`-tokens are inert (indices aren't enumerable).
- After `@name.` the pool is the selection's STORED member labels/types —
  what the panel's member list shows and exactly what a filter can match
  (consistency principle 1). Never the descendants' types/labels, never the
  global label space.
- `@name.` completions return `kind: "filter"` (pure data on `Completion`);
  the terminal renders them under a `filter by (type or label):` header so
  the tokens read as PREDICATES, not membership — path completions are
  genuine tree levels and stay headerless. The terminal also suppresses a
  repeated identical preview while it is still the last log line (mashing
  Tab shows the hint/list once — the stateless completion result itself is
  unchanged; only the redundant echo is dropped).
- DISPLAY-VOLUME CAP (`COMPLETION_LIST_CAP`, one uniform rule in `capped()`):
  any completion list over ~50 candidates returns a `N matches — type to
  narrow` hint pair instead of the list, withholding the common-prefix
  extension until a typed prefix narrows it. The POOL is unchanged — every
  withheld token still matches when typed, keeping completion consistent with
  resolution. Descend sites keep their `.` (the dot is the stage-two action;
  only the list preview caps). Applies to @-pools and path pools alike.

## Reserved characters and where each is enforced

| Char | Enforced in | Site |
|---|---|---|
| `[` `]` `?` | any expression token — but `[ ]` double as the trailing `[name]` delimiter of mutating verbs (`splitTrailingName` strips the name BEFORE parseTarget sees the expression) | `RESERVED` set in the tokenizer (`address.ts`) |
| `..` (empty segment) | any path | `segment()` empty-predicate check |
| `#` misplacement | segments 1–3 | `predicate(level)` placement rule |
| `:` | `@name` filter span only | raw-span check after the filter parses |
| `&` | **nowhere** — not reserved today | — |

### Open threads (deliberate deferrals)

- **⚠ HARNESS HAZARD — S29 deletes the shipped workspace mod files.** The rm
  scenario writes a fixture into the REAL `.molaro/mods/`, `rm all`-deletes
  every shipped mod file, and restores them from in-memory snapshots in a
  `finally`. Two consequences, both live: (1) one crashed/killed harness
  process between delete and restore removes the reference mods from the
  working tree for real (recoverable only via git) — a latent data-loss bug
  awaiting a proper fix (point S29's bridge at a temp mods dir); (2) every
  scenario's bridge scans `.molaro/mods` at boot, so S29 can NEVER run
  concurrently with anything — it is tagged EXCLUSIVE in the scenario table
  (tests/redesign.ts) and the parallel runner (tests/run_e2e.ts) runs it
  alone after the pool drains. Do not un-tag it without fixing (1).

- **The mod registry has no invalidation story — only a re-push.** KNOWN GAP.
  The webview's two mod caches are written by `installModList` and evicted by
  `rm`/`delete_mod`. There is **no file watcher and no `reload` verb**, and
  `modsLoaded` is pushed from exactly two places: viewer boot, and a `write_mod`
  save. So a user who **hand-edits** `.molaro/mods/<name>.py` on disk and re-runs
  it **from the terminal** still gets the mod as it was at boot, until the panel
  is reopened. This is the same *class* as the approval-gate bug S35 pins (a
  name-keyed cache with no invalidation) reached by a different trigger — the
  difference being that the terminal user edited the file themselves and no gate
  claims otherwise, whereas `write_mod` previously *reported success*.
  The guard fix closes the **assistant** path completely and honestly; it does
  **not** give the system an invalidation story, and this doc will not pretend it
  does. A watcher or a `reload` verb is a separate piece of work.
- **`:` level qualifier** — reserved in the filter span for a future
  explicit field pin (`@sel.<level>:<pred>`). Under membership-only filtering
  the collision it would resolve (a point member's type equal to a label
  member's label) is rarer but still possible in mixed-level selections; the
  reservation stands.
- **`&` intersection operator** — `+` union plus single-predicate filters
  covered every need so far; intersection was never blocking. The
  `@name.a.b` error message now references `&` as the intended path for
  combining conditions (e.g. a label AND a type over one selection) — keep
  that message in sync if this thread moves. NOTE: `&` is *not* yet
  reserved — labels containing `&` parse as literals today, so making it an
  operator later is a (small) breaking change for such labels. Reserve it
  first if/when the operator becomes concrete.
(The former `colortrace` deferral is RESOLVED and built: the semantic
decision landed on per-vertex color with an explicit gradient-boundary
rendering — see the representation-family section above and S17.)

- **Honored edge/trace thickness — the flagged renderer follow-up (points
  AND edges now CLOSED; traces remain).** The point half landed as sphere
  impostors (increment A) and the edge half as instanced tube quads
  (increment B) — see the representation-family section above; both read
  the existing buffers with zero command-layer change, as predicted.
  `rep.state.traceSize` is still live-but-undrawn (the polyline pass
  rasterizes 1 px GL lines); increment C applies the same instanced
  construction with PER-END radius/color so the pinned per-vertex gradient
  semantics fall out of varying interpolation.
- **Correct transparency ordering (depth sort / OIT) — the second flagged
  renderer follow-up.** Per-element opacity renders NOW with naive
  blending: all three passes are `transparent: true`, drawn in scene order
  with no intra-object sorting, so overlapping SEMI-transparent elements
  can composite in the wrong order (a translucent element in front may
  fail to show a translucent one behind it correctly). Fully-opaque and
  fully-transparent render exactly right. The fix is per-element
  back-to-front sorting or an order-independent-transparency pass — a
  renderer brief of its own; the buffers and commands need no change.
  (Unlike the width follow-up, this one is visible-but-imperfect rather
  than invisible.)

## Webview lifecycle: retained context (the tab-away fix)

Applying representation writes, switching to another editor tab, and
switching back used to reset the viewer to the base look. Diagnosed by CDP
probe against the real workbench (not the harness — the harness has no
panel lifecycle): **the viewer webview was being DESTROYED on hide and
reloaded on re-show** — the webview CDP target vanished the moment the tab
was hidden, a fresh target appeared on return with none of the old JS state
(a planted `window` marker was gone), and the reloaded page re-requested
the stream over the *surviving* broker (the producer child process never
restarted — ruling out a reconnect as an independent cause). The reload
wiped everything not re-derivable: the nine representation buffers (the
only state that exists nowhere but the buffers), committed selections,
hides, the undo stack, camera pose, and the playhead — representation loss
was just the salient symptom. Re-seeding on a visibility/resize event was
ruled out structurally: `RepresentationLayer` is constructed exactly once
at page boot, and the resize path touches renderer size/camera only.

**The fix**: the viewer panel now sets `retainContextWhenHidden: true`,
exactly as the terminal panel always has (and for the same reason). The
context survives hide, so nothing is ever "restored" — and therefore **the
undo stack is untouched by tab round-trips, by construction**. That
invariant is non-negotiable for any future change here: re-showing must
never replay verbs or record strokes; state is kept (or, if a future cause
forces re-application, re-copied) — never re-issued as commands. After a
round-trip, Ctrl+Z pops exactly the strokes the user issued, in order
(S20 asserts this, along with byte-identical buffers, hide-state, camera
pose, and a pixel-level render check). Trade-off: a hidden viewer holds its
DOM/JS/GL memory — accepted knowingly, same decision as the terminal at a
higher cost.

## Test topology

- **Unit** (`npm test`, Node-native TS): `address.test.ts` (grammar + resolver
  + completion, incl. spanning fixtures, quoted spaced labels, and the
  argument-shape splitters `splitTrailingName`/`splitLeadingRef`/
  `splitTrailingWord`), `commands.test.ts` (every verb handler against a
  stateful stub context, `parseColor`, help), `sets.test.ts` (state model +
  `entryIntersects`), plus the substrate suites (contract/geometry/framing/
  playback/producer_protocol/classification/picking).
- **E2E** (`npm run build && node tests/redesign.ts`, headless Chrome over
  CDP): S0–S8 cover the interaction redesign; **S9** is command↔gesture
  parity (camera pose to 0.01 vs real clicks/drags, hidden targets, #index,
  @name filters, quoting against the producer); **S10** is the flash-parity
  matrix — the exactness check (flashed == mounted ∩ resolved) across term
  count/kind/level and both panel surfaces, using the `debug.resolvePoints`
  seam; **S11** is the mutation template — create_sele vs the real
  build+Create-selection gesture must snapshot identically, one undo removes
  cleanly, edit mode is independent, collisions mutate nothing; **S12** is
  hide/show — the commit rule's both arms, gesture interop (a command hide
  cleared by the panel's right-click and vice versa), member-state symmetry,
  idempotent no-ops leaving the undo depth untouched; **S13** is `all`/
  `@all`, hide's all-or-nothing commit rule across mixed targets, `ls`, and
  `rename` (model-routed collision parity); **S14** is `add`/`remove` —
  byte-identical membership vs the edit-mode gestures, natural-level adds,
  the no-carve nomatches, delete-vs-empty, and `remove @all`'s one-undo full
  restore; **S15** is `colorpoints` — resolution parity with `view` (the
  changed point set == `resolvePoints`, per target kind), hidden-set writes,
  one stroke per invocation, exact-one-step Ctrl+Z (restoring the *previous*
  color, then the base look; unwinding to the pristine buffer), last-write-
  wins, the no-write guarantees of nomatch/error/usage paths, and the
  rename (`color` is an unknown command); **S16** is the edge verbs — the
  contained/incident parity matrix (changed edge set == the endpoint
  predicate over `resolvePoints`, per target kind, via the seam's `edges`
  list), the single-point pin (`colorbonds #N` nomatches while
  `colorbondsof #N` colors exactly the incident edges), the deliberate
  out-of-set reach, per-primitive buffer independence both ways, and the
  same undo/LWW/hidden/no-write discipline on the edge buffer; **S17** is
  `colortrace` — vertex parity via the seam's `traceVertices` (changed
  vertex ids == active-subgroup vertices over `resolvePoints`), the exact
  SCATTERED single-category set (category cycling pinned as correct), the
  map-up pin (`#124` colors exactly its subgroup's one vertex), the
  no-vertex nomatch (`@solvent`), three-buffer independence in every
  direction, and the family's undo/LWW/hidden/no-write discipline on the
  trace buffer; **S18** is the size axis — per-shape parity on the size
  buffers (identity / contained / incident-with-reach / subgroup-map-up,
  mirroring S16/S17 exactly), the single-point contained-vs-incident pin on
  the size buffer, ZERO ⊥ HIDE (a zero write leaves the visible buffer
  byte-identical, the scene count unchanged, and the points resolving), the
  negative clamp with its message, the SIX-buffer independence matrix
  across all eight verbs (including the shared edge-size buffer), and the
  undo/LWW/hidden/no-write discipline on the size axis (unwinding restores
  all six buffers to pristine); **S19** is the opacity axis — per-shape
  parity mirroring S18, the single-point pin on the opacity buffer,
  OPACITY-ZERO ⊥ HIDE (visible buffer byte-identical, points still
  resolving), the two-sided clamp with its bound-naming messages, the
  PIXEL PROOF that transparency renders (an opaque red subgroup's pixels
  vanish at opacity 0 while the points still resolve — this check caught a
  real re-upload wiring bug), the NINE-buffer independence matrix across
  all twelve verbs, and the undo/LWW/hidden/no-write discipline on the
  opacity axis (unwinding restores all nine buffers to pristine); **S20**
  pins the retained-webview invariants behind the tab-away fix — after
  strokes across five buffers plus a hide, the visibility/resize round-trip
  a RETAINED webview experiences leaves all nine rep buffers and the hide
  state byte-identical, the undo stack untouched (no restore stroke), the
  camera pose unchanged, and the colored pixels still rendering; Ctrl+Z
  afterward pops exactly the user's strokes in order. (The retention itself
  — the webview surviving a real tab hide — is validated against the
  packaged VSIX by the real-VS-Code CDP probe, since the harness has no
  panel lifecycle.) **S32** is the impostor-geometry pixel suite, run TWICE
  — once per depth variant (`/?depthVariant=N` boots the harness on either
  path): the C2 depthWrite pin on all three geometry materials, the
  initial-framing parity band for a default-size sphere, extent scaling
  with the stored size, SIZE-0 = ZERO PIXELS while the point still
  resolves and picks, nearer-occludes-farther at equal sizes (the
  depth-state tripwire — must hold on BOTH variants), the interpenetration
  check with OPPOSITE expectations per variant (v2: a big sphere's front
  bulge eliminates a nearer small point; v1: the small point punches
  through — the only allowed divergence), overlay registration on the
  sphere's own pixels + scaling with size + none at size 0, focus-flash
  registration, and a full unwind restoring pristine buffers AND pristine
  pixels; **S33** boots the bridge with `--strip-bbox` (a test-infra
  header rewrite; `bbox: null` is contract-legal) and pins the LOUD
  null-bbox fallback — the status-line warning, the seam's fallback flag,
  and the self-correcting parity band on the fallback box; **S34** is the
  edge-tube suite, run twice (once per depth variant): default-width tubes
  draw, the HEADLINE `bondsize <t> 6` pixel increase on exactly the
  addressed edges (the other subgroup's count byte-flat), width 0 = zero
  pixels, one-Ctrl+Z width restore, tubes tracking a frame seek,
  hidden-wins collapse + show restore, the junction walk (sphere→tube with
  no background gap on BOTH variants), the variant-separating junction
  probe with expectations derived from measured depths (v2: the sphere's
  bulge holds the nearer tube off its face; v1: the tube's flat axis depth
  crosses it), and a full unwind to pristine buffers AND pixels. **A caution
  about the pre-S32 pixel checks:** when the impostor pass replaced EVERY
  point in the scene — 3×3 squares became shaded discs (9 px² → ~7 px²),
  the overlays went from a fixed 6 px to silhouette-matched, and a
  ~4,500-pixel size-0 residue vanished outright — the whole pre-existing
  suite passed **unchanged**. That is not evidence the change was inert; it
  is evidence those checks (thresholded classifier counts) are **too
  coarse to detect a total change of point geometry**. Treat green runs of
  the older pixel checks as weak evidence for anything geometry-shaped;
  S32/S33 are the sensitive checks and exist precisely because of that
  insensitivity. The harness runs the synthetic producer at **N=6000**
  (the extension default is 20000 — counts differ).
- **Terminal smoke** (`node tests/terminal_smoke.ts`): the real terminal
  bundle + real viewer in one page, host relay emulated by the bridge shim's
  loopback; commands (every verb incl. the representation family's buffer
  writes on all three axes, the total rename, the unknown-color /
  non-numeric-size / non-numeric-opacity errors, and the clamp lines),
  completion, history, help.
- **Real-relay VSIX smoke** (manual recipe): install the packaged VSIX into an
  isolated VS Code profile, drive the actual workbench over CDP — proves the
  true terminal→host→viewer→host→terminal path and panel lifecycle. Evidence
  in `reports/vsix_smoke/`.

## Packaging

`npm run package` = clean `dist/` → full build (extension-host bundle + BOTH
webview bundles, `main.js` and `terminal.js`) → `vsce package -o
viewer-0.1.0.vsix` (name/version pinned — the install command references the
filename). Install with `code --install-extension viewer-0.1.0.vsix --force`
and reload the window. The extension id is `undefined_publisher.viewer`; do
not add a `publisher` field casually — it changes the id and strands existing
installs. `.vscodeignore` ships `dist/`, `producer/*.py`, `contract/*.py`
(with `__init__.py` — `serve.py`'s import path) and excludes tests, reports,
sources, and local notes.
