# Command layer — architecture & invariants

The knowledge a future coding agent needs before touching this layer, gathered
from the commit history (`82226ce` … `5ba5c83`) into one place. The user-facing
grammar is documented in [COMMANDS.md](COMMANDS.md); this note is about *why
the code is shaped the way it is* and which properties must not regress.

## Consistency principles

Invariants that govern the layer. When a change touches one of these areas,
this section is the check it must pass; add future invariants here rather
than scattering them.

1. **A committed selection is a flat set of points.** `@name` resolves to
   points; `@name.<pred>` filters those points by a single flat predicate
   (match-anywhere: the point's type or any ancestor label). It is *not* a
   path segment — there is no descent, no sub-levels, no navigable structure.
   The nuance that makes this easy to over-read: the selection's MEMBERSHIP
   is flat (what it stores and the panel shows), but its points RETAIN FULL
   ANCESTRY — type, subgroup, group, category — and the filter matches over
   exactly that retained ancestry. "Filter a flat selection by a subgroup
   label" is therefore not a contradiction: the bag is flat, the points
   inside it are not. Resolution, error messages, and completion must all
   tell this same story: `@name.a.b` is an error (no second level, enforced
   for every verb, with the message pointing at the reserved `&` for future
   condition-combining); `@name.<token>` matches points whose type or any
   ancestor label equals the token; and completion after `@name.` offers
   exactly the tokens that would match as such a flat predicate — rendered
   under a "filter by (type or label)" header so the list reads as filter
   VOCABULARY, never a curated "membership" list that implies the selection
   has structure to enter. (Both hide/show bugs fixed in this layer's
   history came from a component quietly treating the flat bag as if it had
   structure.)

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
  like any range) — deliberately redundant with `*` / bare `@name`, kept for
  axis symmetry; it must always resolve the same point set those do.
- `@name` = the committed selection's stored entries; `@name.<pred>` filters
  its resolved **point set** — match-anywhere: leaf type OR subgroup/group/
  category label (via `subgroupOfPoint` → `ancestorsOfSubgroup` → `label`,
  cached per subgroup). Results are **always point-level** (stored entry
  levels are not preserved). Exactly one trailing predicate (`@n.a.b` errors);
  it binds tighter than `+`. Multi-level hits union by design.
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

- `hide <target>` = the commit template with `setHidden(true)` folded into
  the SAME stroke (`commitEntries(entries, name, hide)`) — one undo removes
  selection + hidden state together. `hide @name` / `show @name` are the
  whole-flag mutator; `@name.<pred>` subsets go through
  `setEntriesHidden`. Model widening made for this (reported, deliberate):
  `setEntryHidden` now accepts entries COVERED by a stored member, not just
  exact members — `hiddenPart` already resolves point-wise and
  `isPointHidden` gates on `set.contains(point)` first, so visibility
  semantics are unchanged and gestures (which only pass exact members) are
  unaffected. The wiring consolidates: members fully inside the filter hide
  as MEMBER entries (row-purple, gesture parity); the remainder hides as
  point entries (count-only feedback — no row exists for sub-member points).
- `show` NEVER commits (a point in no selection is already visible).
  MEMBER-STATE SYMMETRY (`SelectionModel.setPointsHidden`, composed purely of
  existing mutators in one stroke): `show @name.<pred>` clears exactly the
  state `hide @name.<pred>` wrote — a hiddenPart entry only PARTIALLY named
  by the predicate SPLITS (cleared, its unnamed remainder re-hidden as point
  entries), so a narrower show reveals exactly its subset, never a
  whole-entry superset. Beware: a split against a huge coarse entry re-hides
  the remainder point-by-point (thousands of mutator calls) — rare, accepted.
  `show @name` = `clearAllHidden`: the whole flag AND every member hide (the
  reliable inverse of any hiding on that selection); the path form clears
  every selection covering the named points; bare `show` clears all hidden
  state. Each action is one stroke = one undo op; empty strokes push
  nothing, so idempotent calls leave the undo depth untouched. A subset show
  against a WHOLE-hidden selection reports `hidden whole — show @name to
  reveal it` rather than a misleading "nothing hidden there".
- `hide` never toggles (idempotent `already hidden`); bare `hide` errors (no
  gesture analog, destructive-feeling). Messages report the ACTION —
  show-wins masking means a hide may change no pixels; that's the accepted
  trade-off, not a failure.

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
- After `@name.` the pool is the selection's own identity tokens — its
  distinct types AND the subgroup/group/category labels its points sit under —
  never the global label space. Do NOT curate or "membership-scope" this pool
  (consistency principle 1): it is the exact flat match-anywhere token set.
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

- **`:` level qualifier** — match-anywhere `@name` filtering cannot pin a
  token that legitimately collides across fields (a type equal to an ancestor
  label). Today that resolves to the safe union; `@sel.<level>:<pred>` would
  let users pin the field. The character is reserved in the filter span so the
  syntax can land without ambiguity. Deferred: the collision is visible (an
  over-large framed set) and refinable by typing a narrower predicate.
- **`&` intersection operator** — `+` union plus single-predicate filters
  covered every need so far; intersection was never blocking. The
  `@name.a.b` error message now references `&` as the intended path for
  combining conditions (e.g. a label AND a type over one selection) — keep
  that message in sync if this thread moves. NOTE: `&` is *not* yet
  reserved — labels containing `&` parse as literals today, so making it an
  operator later is a (small) breaking change for such labels. Reserve it
  first if/when the operator becomes concrete.

## Test topology

- **Unit** (`npm test`, Node-native TS): `address.test.ts` (grammar + resolver
  + completion, incl. spanning fixtures and quoted spaced labels),
  `commands.test.ts` (registry + help), `sets.test.ts` (state model +
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
  cleanly, edit mode is independent, collisions mutate nothing. The harness
  runs the synthetic producer at **N=6000** (the extension default is 20000 —
  counts differ).
- **Terminal smoke** (`node tests/terminal_smoke.ts`): the real terminal
  bundle + real viewer in one page, host relay emulated by the bridge shim's
  loopback; commands, completion, history, help.
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
