# Command layer — architecture & invariants

The knowledge a future coding agent needs before touching this layer, gathered
from the commit history (`82226ce` … `5ba5c83`) into one place. The user-facing
grammar is documented in [COMMANDS.md](COMMANDS.md); this note is about *why
the code is shaped the way it is* and which properties must not regress.

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

## Completion

`completeTarget` is resolution's inverse over the SAME descent helpers
(`catsMatching`/`groupsMatching`/`subgroupsMatching`) — completion and
resolution cannot disagree about what sits under a prefix. Rules that took
deliberate decisions:

- Unique verb completion appends a space; unique category/group appends `.`;
  subgroup/leaf/@name append nothing.
- No-op on `*` tokens and on **range-in-progress** tokens (`^\d+-\d*$`) only —
  deliberately narrower than "contains a dash", or `group-0`-style labels
  would be uncompletable. `#`-tokens are inert (indices aren't enumerable).
- After `@name.` the pool is the selection's own identity tokens — its
  distinct types AND the subgroup/group/category labels its points sit under —
  never the global label space. (Bare Tab on a huge selection prints a huge
  list; that's per spec — prefix first.)

## Reserved characters and where each is enforced

| Char | Enforced in | Site |
|---|---|---|
| `[` `]` `?` | any expression token | `RESERVED` set in the tokenizer (`address.ts`) |
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
  covered every need so far; intersection was never blocking. NOTE: `&` is
  *not* yet reserved — labels containing `&` parse as literals today, so
  making it an operator later is a (small) breaking change for such labels.
  Reserve it first if/when the operator becomes concrete.

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
  seam. The harness runs the synthetic producer at **N=6000** (the extension
  default is 20000 — counts differ).
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
