# HANDOFF — Terminal, address grammar, and command verbs

**Audience**: a TypeScript engineer joining cold, with no prior context on
this project and no knowledge of any application domain. None is needed:
everything below operates on an abstract, neutral tree — **category →
group → subgroup → point** — where levels 1–3 carry opaque label strings
and each point carries an opaque **type** token plus a unique integer
**index**. A "selection" is a set of points. That is all it is.

**Read this first, then the two canonical companions:**

- [`docs/COMMANDS.md`](docs/COMMANDS.md) — the **user-facing grammar and
  verb reference**. Canonical for syntax and observable behavior.
- [`docs/COMMAND_LAYER.md`](docs/COMMAND_LAYER.md) — the **developer
  invariants**: the consistency principles, the mutation template, the
  reserved-character table, the test topology. Canonical for design rules.

This handoff is the orientation layer above them: the map, the why, and
where everything lives. Where the three overlap, those two win for their
domains. (For the viewer/UI substrate underneath this layer, the companion
orientation doc is `HANDOFF_fable_viewer_UI.md`.)

---

## 1. What this layer is

A **text command interface** for the viewer. A terminal panel (a second
VS Code webview) accepts typed commands — `view alpha.group-0`,
`create_sele beta [picks]`, `hide @picks` — and drives the viewer's
existing selection/visibility state.

**The founding contract, stated up front because it explains most design
decisions:** *executing a command is indistinguishable from performing the
equivalent UI gesture.* Same state, same single undo step, same visual
feedback, same panel updates. Handlers call the exact code paths the
gestures call (`focusPoints`, `frameVisible`, `addToTarget`,
`removeFromTarget`, `SelectionModel.commit`, `setHidden`, …) — never a
parallel implementation. The E2E suite enforces this literally: scenario
S9 asserts camera pose equality (to 0.01) between a command and the real
click it mirrors; S11 and S14 assert byte-identical model snapshots
between command and gesture arms.

Two corollaries you will feel everywhere:

- If a command capability cannot be expressed as UI state the panel can
  display and reverse, the capability is wrong (consistency principle 2).
  Two features were **reversed** post-ship because of this; see §5.
- Commands never bypass the undo system. Every mutating verb is exactly
  one `Ctrl+Z` step (a model "stroke"); read-only verbs push nothing.

---

## 2. Architecture and the purity fence

```
webview/terminal.ts      the terminal surface (DOM). DUMB on purpose: an
                         output log + one input line. Enter ships
                         {type:"command", id, text}; Tab ships
                         {type:"complete", id, text, cursor}; Up/Down walk
                         local history. It renders results; it never
                         interprets them. One exception: the literal input
                         `clear` is intercepted locally (wipes the log,
                         never reaches the viewer — see §4).
        │  postMessage
src/extension.ts         the extension host. A VERBATIM RELAY between the
                         two webviews: command/complete → viewer;
                         commandResult/completeResult → terminal. Also owns
                         panel lifecycle (`viewer.openTerminal`, the HUD
                         "Terminal" button, `retainContextWhenHidden: true`
                         so tab-away keeps terminal state).
        │  postMessage
webview/main.ts          the viewer entry module. Owns the WIRING: a
                         CommandContext of closures over the live model
                         (commitTargetEntries, setRefsHidden,
                         mutateMembers, deleteSelections, selectionsInfo,
                         renameSelection, focusPoints, flashPointRows, …)
                         plus the test seam `window.__viewer`
                         (.command(text), .complete(…), .model, .debug.*).
        │  direct calls
webview/commands.ts      CommandRegistry (a Map verb → handler; NOT a
                         switch — help/? register through the same
                         mechanism as every verb) + all verb handlers +
                         HELP_TEXT. Handlers parse arguments, resolve
                         targets, call ctx closures, and word messages.
        │  pure calls
webview/address.ts       THE GRAMMAR. parseTarget / resolveTarget /
                         completeTarget / splitTrailingName /
                         splitLeadingRef. PURE: no DOM, no rendering
                         imports — only types from classification.ts and
                         sets.ts. Unit-tested directly under `node --test`.
webview/sets.ts          the state model (SelectionModel, NodeSet,
                         Hierarchy). Owned by the UI layer; this layer
                         CALLS its mutators and never forks them.
```

Why the purity fence matters: `address.ts` is the largest single surface
of behavior (parsing, resolution, completion) and it runs identically in
Node tests and in the webview. Keeping it import-clean is what makes the
65-test grammar suite possible without a browser, and what guarantees
completion and resolution can share descent helpers (they literally call
the same `catsMatching`/`groupsMatching`/`subgroupsMatching` functions, so
they cannot disagree about what sits under a prefix).

Resolution walks **the same `buildTree` model the panel renders**
(`webview/classification.ts`), not the raw hierarchy — so a path resolves
to exactly the rows it denotes on screen. One subtlety worth knowing
before it bites you: groups and subgroups may **span** categories. A path
*terminating* at a spanning group yields the whole group entry, but
descent *past* the group is scoped to the named category's branch. In the
synthetic data, `alpha.group-0` holds only `subgroup-0` and `subgroup-3` —
`alpha.group-0.subgroup-1` is a legitimate nomatch even though `ls
alpha.group-0`-style tree walks elsewhere show four subgroups with that
group id. (This cost an E2E round during the `add`/`remove` work.)

---

## 3. The address grammar

Full reference: `docs/COMMANDS.md`. The condensed engineer's version:

```
target-expr := term ("+" term)*            union, the only cross-subtree operator
term        := path | @name[.leaf-pred] | "#"index-spec("," "#"index-spec)* | "all"
path        := segment ("." segment)*      1–4 segments, top-down
segment     := predicate ("," predicate)*  comma list = union within one parent
predicate   := "*" | glob | lo-hi | literal | "#" index-spec   (# leaf-only)
index-spec  := "*" | INT | INT "-" INT
```

**One segment per level — segment count = target level.** `alpha` is a
category. `alpha.group-0` is a group. `alpha.group-0.subgroup-0` is a
subgroup. `alpha.group-0.subgroup-0.t2` is points, matched on their
**type**. A path never auto-descends: `view beta` frames the category
entry, not "everything under beta expanded to points" (they cover the same
points, but the resolved *entry* is one category-level entry — this
matters for `create_sele`/`add`, which commit entries at their natural
level).

**Predicates**, all case-sensitive:

- `literal` — exact label (levels 1–3) or exact point type (level 4).
- `*` — every node at that level under the matched parents.
- `glob` — `sub*`, `*-3`, `*roup*`; `*` = any run of characters.
- `lo-hi` — numeric **label range**: matches the integer at the END of a
  label (`subgroup-7` has trailing integer 7). No trailing integer = no
  match. Bounds are unordered — `9-5` ≡ `5-9` (a range denotes a set, not
  a direction; `inRange` normalizes).
- `a,b,c` — list union within the segment's scope.

**Quoting**: `"…"` is an exact literal — `*` inside quotes is not a glob,
`3-9` inside quotes is not a range, spaces are fine. The synthetic data
deliberately contains a spaced label as a probe:
`view gamma.group-2."subgroup 11"`. Unbalanced quotes are parse errors.

**The point-index axis `#`**: `#161`, `#156-187`, `#*` address points by
their contract index — the one always-unique axis. `#` is the **sole
distinguisher** from label ranges: bare `44-55` stays a label range.
Placement is parse-enforced: standalone term (unconditional) or a path's
**4th segment** (where it intersects the scope — `a.g.s.#161` matches only
if point 161 lies under that subgroup); `#` in segments 1–3 is a parse
error. Ranges normalize order then clamp to `n_points`; out-of-range
resolves to nothing (nomatch, not an error). `#*` = every index in scope.

**Committed-selection references `@name`** (quoted if spaced:
`@"my picks"`): resolves to the selection's **stored entries at their
stored levels**. One optional trailing predicate filters the **membership
only** — a label member matches on its own label, a point member on its
type or `#index`; the filter NEVER reaches inside a coarse member (see
principle 1, §5 — this is a reversal with history). Results are whole
members. `@sel.*` ≡ `@sel`; `@sel.#*` = its stored point members only.
`@name.a.b` is a parse error whose message forward-references the unbuilt
`&` intersection operator.

**`all` and `@all`**: bare `all` = everything in existence (resolves to
every top-level category entry); `@all` = everything **committed** (the
deduped union of every committed selection's stored entries; empty when
nothing is committed). `all` is a keyword only when it is the whole term —
`all.x`, `allx`, `"all"` are ordinary labels. `"all"` is a **reserved
selection name** (refused by `create_sele` and `rename`) so `@all` can
never be shadowed. The two sit on opposite sides of hide's commit rule
(§4) — that contrast is the reason both exist.

**Parse error vs nomatch** — the debugging distinction the result statuses
encode: `error` = the expression is malformed (reserved character, bad
placement, unbalanced quote — nothing was attempted); `nomatch` = the
expression is well-formed but names nothing (wrong label, empty
selection, out-of-range index — nothing was mutated). Mutating verbs
guarantee nomatch/error paths commit nothing.

**Reserved but unbuilt** (all are clean parse errors today, so building
them later cannot silently change existing expressions):

| Syntax | Intended future |
|---|---|
| `[` `]` | set/slice syntax (today: reserved in expressions; doubles as the trailing `[name]` delimiter of mutating verbs — `splitTrailingName` strips it before the parser sees the expression) |
| `?` | single-character wildcard (as a bare verb it is the `help` alias) |
| `..` (empty segment) | ordered ranges, if ever wanted (unordered `lo-hi` covers sets) |
| `:` | explicit level qualifier in `@name` filters (`@sel.<level>:<pred>`) — reserved in the filter span only; a `:` in ordinary path tokens is a legal literal character |
| `&` | intersection operator — **referenced in an error message but NOT reserved**; labels containing `&` parse as literals today. Reserve before building (see §8) |

---

## 4. The verbs

All registered in `createCommandRegistry` (`webview/commands.ts`); the
in-terminal `help` (alias `?`) prints `HELP_TEXT`, which is kept in sync
with `docs/COMMANDS.md`'s quick-reference table by convention (a note at
both sites). `help <verb>` prints the verb's registered one-liner.

| Verb | Mutates? | Commits? | UI-gesture analog |
|---|---|---|---|
| `view <target>` | no | no | clicking a row (focus: camera tween + yellow flash) |
| `view` (bare) | no | no | clicking empty space (frame the visible scene) |
| `create_sele <t> [name]` | yes | always | build a pending target + "Create selection" button |
| `hide <target> [name]` | yes | only if target has a non-`@` term | header/member right-click (hide direction only) |
| `show [<target>]` | yes | **never** | header/member right-click (show direction); bare = "reveal all" |
| `ls [...]` | **no** | no | reading the panel (no gesture — it's the panel as text) |
| `rename @name [new]` | yes | no | double-click the block name (inline rename) |
| `add @name <tree-t>` | yes | no | edit mode + clicking unselected rows |
| `remove @name …` | yes | no | edit mode + member ✕ / the block's ✕ button |
| `clear` | no (terminal-local) | no | none — it wipes the terminal's own log |
| `help` / `?` | no | no | none |

Details and asymmetries, in the order you're likely to touch them:

**`view`** — read-only, pushes nothing onto the undo stack. Frames the
**full resolved union, hidden points included** (the row-click analog;
only the flash overlay is visibility-gated). Bare `view` is the
empty-space-click path and is parked during edit mode, like the gesture.
Every currently-mounted row whose points intersect the resolved set
flashes — point-set matching, never entry identity (see S10).

**`create_sele <target> [name]`** — THE MUTATION TEMPLATE every later verb
inherits (`commitTargetEntries` in `webview/main.ts`): park edit mode,
stash any in-progress pending target, `addToTarget` the resolved entries
**at their natural levels** (a group-level address commits one group
entry — never expanded, never collapsed), `model.commit()`, optional
rename, restore — all inside ONE stroke, so a single `Ctrl+Z` removes the
whole command cleanly, nothing left behind. Name collisions error before
any mutation;
auto-names come from the model's restarting `selection_N` numbering. The
committed rows pulse with the existing pending-green look
(`flashPointRows(points, "sel-covered")`) — the build→commit beat in one
shot, no new style.

**`hide`** — governed by **the commit rule** (principle 3): commit only
when the target isn't already committed, all-or-nothing at the
whole-target level. A target made entirely of `@` references (`hide @a +
@b`, `hide @all`) hides those selections **in place** — one
`setRefsHidden` batch = one stroke = one undo, no new selection, and a
`[name]` is a usage error. Any non-reference term (`hide beta`, `hide @a +
alpha.group-0`, `hide all`) makes the WHOLE target commit **once** as a
new selection, then hide — commit-then-hide in the same stroke, one undo;
referenced selections contribute entries but keep their own state
(show-wins precedence handles the overlap). `hide all` honestly reports
the whole-system size. `hide` **never toggles**: re-hiding is an
idempotent `already hidden` line (the right-click gesture toggles; the
verb chooses directional clarity). Bare `hide` errors.

**`show`** — **never commits** (a point in no selection is already
visible; there is nothing to create). `show @name` clears the whole flag
AND every member hide — the reliable inverse of any hiding on that
selection. `show @name.<pred>` clears exactly the matched members; against
a whole-hidden selection it answers `hidden whole — show @name to reveal
it` instead of a misleading no-op. `show <path>` clears hidden state
covering those points wherever it lives. Bare `show` and `show @all`
reveal everything. Idempotent calls change nothing and leave the undo
depth untouched (empty strokes push no undo entry). Messages report the
ACTION, not pixels — under show-wins a hide can legitimately change
nothing on screen.

**`ls`** — read-only, zero undo impact, three forms mirroring panel
surfaces as text: bare (the committed selections: `name — N points ·
hidden`), `ls @name` / `ls @all` (the STORED member list, exactly as the
panel's block shows it), `ls <path>` (contents one level below the
resolved nodes; points list nothing). All forms share completion's
volume cap (§6): past ~50 lines you get `N items — narrow the target`.
Takes no `[name]`.

**`rename @name [new]`** — routes through the same
`SelectionModel.rename` as the panel's inline rename: one undo op,
identical collision error. Exactly one unfiltered `@name`; `all` refused
as a new name.

**`add @name <tree-target>` / `remove @name …`** — the membership pair,
the command analog of edit mode. Both take exactly ONE lone `@name` first
(`splitLeadingRef` in `address.ts` does the shape split; unions, filters,
and paths on the left are usage errors — the UI cannot edit two
selections at once). Both are edit-mode independent (mid-edit of another
selection, they still land on the named one — the wiring parks and
restores the mode). **The second argument differs in kind, by design**:

- `add`'s right side is a **tree address** (the full grammar) because the
  entries being added are not yet members and must be named from the
  tree. `@` terms there are a usage error — the UI cannot transfer
  members between selections, so neither can `add`. Entries join at their
  natural level; already-present entries are filtered out first, so
  re-adding is an honest no-op with **no undo entry**.
- `remove`'s right side is **member predicates** (a member's own label, a
  point member's type/`#index`; globs, ranges, lists, `+` compose),
  resolved per-term through the SAME matcher as `@name.<pred>` filtering
  (a synthetic single-ref target), so remove and filtering cannot diverge
  on what "a member matches" means. No tree paths — you are already
  scoped to the member list.

`remove` has four forms with a strict **delete-vs-empty rule**:

| Form | Effect |
|---|---|
| `remove @name <member-pred>` | drop matched members; if that empties the selection it **stays**, empty |
| `remove @name all` | drop every member; the selection **stays**, empty |
| `remove @name` (bare) | **delete** the selection — the block ✕ analog |
| `remove @all` | **delete every** committed selection — the one deliberate bulk delete (selection objects, not members); one `Ctrl+Z` restores all of them intact |

Deletion happens ONLY through the bare forms; incidental and explicit
empties behave identically (the message says `now empty — the selection
remains`). This mirrors the UI exactly: nothing in the model or panel
auto-deletes an emptied selection — the only `deleteSelection` caller is
the ✕ button. `remove @a + @b` stays a usage error: bulk deletion is one
selection or, explicitly, all of them, never an arbitrary union. And
**carving is structurally impossible** from `remove` — see principle 4.

**`clear`** — terminal-local. `webview/terminal.ts` intercepts the exact
input `clear` in its Enter handler *before* `postMessage`: wipes the log,
resets the completion-echo dedup, keeps history. Viewer state and the
undo stack never hear about it. It is still registered in the registry
(as a stub) so `help clear` can explain it. Do not confuse it with the
panel's "Clear" button, which discards the pending target — a viewer-state
operation with a two-step confirm. Different nouns, same word; documented
at both sites.

---

## 5. The four consistency principles

Recorded in `docs/COMMAND_LAYER.md` § "Consistency principles" — that
section is canonical; this is the orientation summary. **Each principle
was driven by a real shipped bug or a real design collision, and each is
enforced by tests. Check any new verb or grammar change against all four
before building.**

1. **A committed selection is flat to its members.** `@name.<pred>`
   filters the stored membership at each member's own level and never
   descends into the ancestry of points beneath a coarse member. *History,
   so you don't "fix" it back:* the filter originally matched anywhere on
   a point's retained ancestry (type or any ancestor label). That let
   commands hide sub-member point sets the panel could neither display per
   row nor clear with its gestures — so the behavior was **reversed** to
   membership-only, the sub-member split machinery deleted, and the old
   assertions rewritten positively. The route to finer granularity is to
   commit a finer selection whose members ARE the fine entries.

2. **The terminal must not create state the UI cannot represent and
   reverse.** The generalization of #1, applied as a checklist to every
   capability since. If a proposed command produces selection/visibility
   state no gesture can display or undo, the capability is wrong — match
   the UI's granularity; never add hidden depth.

3. **A commit-then-act verb commits only when its target isn't already
   committed — all-or-nothing at the whole-target level.** All-reference
   targets act in place committing nothing; one non-reference term makes
   the whole target commit as exactly one new selection. No per-term
   splitting. `hide` is the current subscriber; future commit-then-act
   verbs inherit it.

4. **Carving is not exposed to the terminal.** Membership mutation is
   whole-member only. The model CAN split a coarse member into its
   complement (`carveFromTarget` — its most expensive operation, used by
   edit-mode gestures); the terminal path never invokes it. `remove`
   passes only exact stored members and the wiring guards with
   `set.has(e)`, so the carve branch is unreachable. A predicate naming a
   descendant of a coarse member matches nothing rather than carving.
   Corollary: the delete-vs-empty rule of §4.

---

## 6. Tab completion

`completeTarget` (`address.ts`) is resolution's inverse over the same
descent helpers. It is a **pure function of (text, cursor)** — there is no
"last Tab" state anywhere, and none should be added. The terminal ships
every Tab through the relay and applies the returned `applied` suffix only
if the input hasn't changed since.

- **Stateless two-stage rule** (`pathStage`): a partial token settles
  (unique → completes fully; several → common prefix + listed candidates;
  never a dot). A token that already EXACTLY equals a descendable node
  (category, group, subgroup — or an exact committed `@name`, whose filter
  level sits below it) appends `.` and offers the next level's candidates —
  unconditionally, even when longer siblings share the token as a prefix
  (`sub` descends despite `subX`; keep typing to reach the sibling). An
  exact LEAF token (point type) is terminal — no dot, nothing offered.
- **Inert tokens**: `*` tokens, range-in-progress (`^\d+-\d*$` only —
  deliberately narrower than "contains a dash", or `group-0`-style labels
  would be uncompletable), and all `#` tokens (indices aren't enumerable).
- **`@name.` filter pool**: the selection's stored member labels + point
  members' types — what the panel's block lists and exactly what a filter
  can match (principle 1), never the global label space. These return
  `kind: "filter"` and the terminal renders them under a
  `filter by (type or label):` header so they read as predicates, not
  contents. Path completions stay headerless — those genuinely are levels.
- **Volume cap** (`COMPLETION_LIST_CAP` ≈ 50, `capped()`): oversized lists
  print `N matches — type to narrow` instead; the POOL is unchanged (every
  withheld token still matches when typed); descend-sites keep their `.`.
  One uniform rule for path pools, `@` pools, and `ls` output.
- **No-stack echo**: the terminal suppresses a repeated identical
  completion preview while it is still the last log line — mashing Tab
  prints the hint once. Purely presentational; the completion result
  itself never changes.

---

## 7. Build, run, test, package

Everything runs from the repo root. Node 22 executes TypeScript natively —
**erasable-only syntax** (type annotations erase; no enums/namespaces/
parameter properties). There is no dev-server step for tests; but note the
E2E harness loads **built** bundles:

```
npm run typecheck            # tsc --noEmit over everything incl. tests
npm test                     # 10 unit suites, node --test (158 tests)
npm run build                # esbuild: dist/extension.cjs + dist/webview/{main,terminal}.js
node tests/redesign.ts       # E2E, headless Chrome over CDP (S0–S14, 355 checks)
node tests/terminal_smoke.ts # terminal-surface smoke over the loopback relay (66 checks)
python3 -m tests.test_roundtrip   # synthetic producer wire round-trip (5 tests)
npm run package              # clean dist → build → vsce → viewer-0.1.0.vsix
code --install-extension viewer-0.1.0.vsix --force   # then reload the window
```

**⚠ Rebuild before E2E.** `tests/redesign.ts` and `tests/terminal_smoke.ts`
load `dist/` bundles; a stale build fails in confusing ways (verbs
"missing", old semantics). Always `npm run build` after source edits.

**Test topology and where coverage lives:**

- **Unit** — `tests/address.test.ts` (65: grammar, resolver, completion,
  `splitTrailingName`/`splitLeadingRef`, spanning fixtures, quoted spaced
  labels, all/@all), `tests/commands.test.ts` (25: every verb handler
  against a stateful stub `CommandContext`), `tests/sets.test.ts` (the
  state model), plus seven substrate suites.
- **E2E** — `tests/redesign.ts`, scenario-per-function, runnable
  individually (`node tests/redesign.ts S13`). S0–S8: the UI interaction
  redesign (pre-command-layer). Command layer: **S9** command↔gesture
  parity (camera pose, hidden targets, `#`, `@` filters, quoting);
  **S10** flash-parity matrix (flashed rows == mounted ∩ resolved,
  exactly); **S11** `create_sele` vs the real gesture, snapshot-identical;
  **S12** `hide`/`show` incl. gesture interop and the member round-trip
  regression; **S13** `all`/`@all`, hide's commit rule, `ls`, `rename`;
  **S14** `add`/`remove` incl. byte-identical membership vs edit-mode
  gestures, the no-carve nomatches, delete-vs-empty, and `remove @all`'s
  one-undo full restore. The harness serves the synthetic producer at
  **N=6000** (the packaged extension defaults to 20000 — expected counts
  differ; the seeded bulk selection `solvent` is 4800 points in the
  harness). The test seam is `window.__viewer`
  (`.command(text)` → `{status,message}`, `.model`, `.debug.selCount/
  visibleCount/flashCount/resolvePoints`, `.camera`).
- **Terminal smoke** — `tests/terminal_smoke.ts`. **This is the only
  automated coverage of the terminal SURFACE** (the redesign harness never
  loads `terminal.ts`; its scenarios drive `__viewer.command` directly).
  The smoke serves the real terminal bundle and the real viewer in one
  page with the bridge shim looping the relay messages back, and exercises
  typing, Enter, history, Tab completion (incl. the filter header, the
  cap, and the no-stack echo), `clear`'s local intercept, and every verb's
  message through the relay.
- **Real-relay VSIX smoke** — a manual recipe (documented in
  `docs/COMMAND_LAYER.md` § Packaging): install the VSIX into an isolated
  VS Code profile and drive the actual workbench over CDP. Proves the true
  terminal→host→viewer→host→terminal path. Evidence in
  `reports/vsix_smoke/`.

**Packaging**: `viewer-0.1.0.vsix`, name/version pinned. The extension id
is `undefined_publisher.viewer` — do **not** add a `publisher` field
casually; it changes the id and strands existing installs.
`.vscodeignore` ships `dist/`, `producer/*.py`, `contract/*.py` and
excludes tests, reports, sources, and `HANDOFF*.md` (this file does not
ship).

---

## 8. Open threads — known, deliberate, not urgent

- **`&` intersection operator** — unbuilt and, importantly, **not yet
  reserved**: labels containing `&` parse as literals today, so
  introducing the operator later is a (small) breaking change for such
  labels. The `@name.a.b` error message already name-drops `&` as the
  intended way to combine conditions — reserve the character first and
  keep that message in sync if this thread moves.
- **`:` level qualifier** — reserved in `@name` filter spans for a future
  explicit field pin (`@sel.<level>:<pred>`), against the (rare but
  possible) collision where a point member's type equals a label member's
  label in a mixed-level selection.
- **Quoted-`@name` Tab descend** — an exact `@"my picks"` does not
  Tab-descend into its filter pool (the completion token match is
  unquoted; see the `before.endsWith("@")` branch in `completeTarget`).
  Resolution and filtering of quoted names work fully; only the
  completion convenience is missing. Known, accepted.
- **`ls`/completion volume** — large listings are display-capped, never
  truncated from the pool; no perf issue at current scales.
- **The representation seam is reserved and unbuilt.** The viewer's base
  look is a deliberate stub (uniform styling) designed to be replaced by a
  richer styling layer; per-point channel data is plumbed through the
  contract but nothing reads it yet. That is the next natural direction —
  at the level this layer knows it: *a styling/representation layer the
  command grammar would eventually address.* Nothing about it is designed
  or promised here.
- **Companion-doc lag (reported, not fixed here):** `docs/COMMAND_LAYER.md`
  § "Test topology" describes the E2E suite only through S11; S12–S14
  (hide/show, the all/@all + ls/rename batch, add/remove) postdate it. The
  per-verb sections of both docs ARE current; only that one section lags.
  §7 above is accurate to HEAD.

---

## 9. Scope and fences — the next agent inherits these

This workstream owns, and this handoff describes, ONLY: the grammar/
command/terminal modules (`webview/address.ts`, `webview/commands.ts`,
`webview/terminal.ts`, `webview/terminalhud.ts`), the command wiring and
seam inside `webview/main.ts`, the host relay in `src/extension.ts`, this
layer's test files (`tests/address.test.ts`, `tests/commands.test.ts`,
`tests/redesign.ts` S9–S14, `tests/terminal_smoke.ts`), the two docs in
`docs/`, and the packaging config. The state model (`webview/sets.ts`) and
panel renderers (`webview/committed.ts`, `webview/tree.ts`, …) belong to
the UI substrate — this layer calls their existing mutators and does not
fork them (see `HANDOFF_fable_viewer_UI.md`).

**Frozen — treat as external API**: the contract, the transport, the
playback protocol, and the producer wire format.

**Out of scope for this layer — not read, not described, do not widen the
fence**: the domain data-source adapter files, real-dataset tests
(`tests/acceptance_corpus.py`), and the sibling directories
(`benchmark_systems/`, `md-viewer/`) are **out of scope**. All validation
in this workstream was synthetic-only (`producer/synthetic.py`).
`README.md` is written in application-domain terms and was intentionally
neither used nor updated (link-only). If a task appears to require any of
these, stop and confirm scope first — do not characterize their contents
in code, tests, or docs, and keep everything in this layer domain-free:
neutral tree vocabulary (category/group/subgroup/point/type/index) and the
synthetic producer's labels only.
