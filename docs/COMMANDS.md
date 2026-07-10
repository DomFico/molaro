# Command reference — the address grammar

This is the complete reference for the viewer's terminal commands. The grammar
is **domain-agnostic**: it addresses an abstract fixed tree of
**category → group → subgroup → point**, where the first three levels carry
opaque label strings and each point carries an opaque **type** token plus a
unique integer **index**. The same grammar addresses real-world dataset labels
without the grammar knowing what any of them represent. All examples below use
the synthetic producer's actual labels (categories `alpha`/`beta`/`gamma`/
`solvent`, groups `group-0`…, subgroups `subgroup-0`… and `solvent-0`…,
point types `anchor` and `t0`–`t3`).

> The in-terminal `help` command (alias `?`) prints a condensed version of the
> quick reference below. The two are maintained together — if you change one,
> change the other (`HELP_TEXT` in `webview/commands.ts`).

## Quick reference

| Syntax | Meaning | Example |
|---|---|---|
| `a.b.c.d` | Walk the tree one segment per level; **segment count = target level** | `view alpha.group-0.subgroup-0` |
| `label` | Exact label match (case-sensitive) | `view beta` |
| `*` | Every node at that level under the matched parents | `view alpha.group-0.*` |
| `ab*` / `*z` / `*m*` | Glob: `*` = any run of characters, including empty | `view alpha.group-0.subgroup-*` |
| `lo-hi` | Label range: matches the integer at the **end of a label** | `view alpha.group-0.0-3` |
| `a,b,c` | List: union of predicates **within one segment** | `view alpha.group-0.subgroup-0,subgroup-3` |
| `"…"` | Quote labels containing spaces/delimiters | `view gamma.group-2."subgroup 11"` |
| `#N` / `#lo-hi` / `#*` | Point(s) by **contract index** (the `#N` on point rows; `#*` = all in scope) | `view #161`, `view #156-187` |
| `@name` | A committed selection (its whole point set) | `view @selection_1` |
| `@name.<pred>` | Filter the selection's **stored members**: a member's own label, or a point member's type/index | `view @selection_1.anchor` |
| `all` | Everything in existence (every top-level category) | `hide all` |
| `@all` | Everything **committed** (the union of every selection) | `hide @all` |
| `a + b` | Union of terms (the only cross-subtree operator) | `view alpha + @selection_1.t0` |
| `view` | Frame the visible scene (no argument) | `view` |
| `create_sele <expr> [name]` | Commit the target as a new selection (auto-named without `[name]`) | `create_sele alpha.group-0.* [ring]` |
| `hide <expr>` / `hide @name[.pred]` | Hide it (an uncommitted target commits first; an all-`@` target hides in place) | `hide @selection_1.t0` |
| `show [<expr>` / `@name[.pred]]` | Clear hidden state (never commits); bare `show` reveals everything | `show @selection_1` |
| `colorpoints <expr> <color>` | Color those points a constant color (CSS name or `#hex`; hidden points too; last-write-wins; one undo stroke) | `colorpoints alpha green` |
| `colorbonds <expr> <color>` | Color every edge with **both** endpoints in the target (contained) | `colorbonds beta.group-0.subgroup-0 #ff8800` |
| `colorbondsof <expr> <color>` | Color every edge **touching** the target (either endpoint — deliberately reaches one hop outside) | `colorbondsof #124 red` |
| `ls [@name` / `<path>]` | List selections / a selection's members / a node's contents (read-only) | `ls @selection_1` |
| `rename @name [new]` | Rename a committed selection | `rename @selection_1 [ring]` |
| `add @name <tree-target>` | Add tree-addressed entries as **members** at their natural level (no `@` on the right) | `add @ring alpha.group-0` |
| `remove @name <member-pred>` | Drop matched **stored members** (never carves) | `remove @ring subgroup-3` |
| `remove @name all` / `remove @name` / `remove @all` | Empty its members (it remains) / **delete** it / delete **every** selection | `remove @ring` |
| `clear` | Wipe the terminal's own log (viewer state untouched) | `clear` |
| `help` / `?` | This summary; `help <verb>` describes one verb | `help view` |

## The mental model: one segment per level

A path is a walk down the fixed four-level tree, one dot-separated segment per
level, **top-down**. The number of segments decides what the path addresses:

| Segments | Resolves | Example |
|---|---|---|
| 1 | categories | `alpha` |
| 2 | groups | `alpha.group-0` |
| 3 | subgroups | `alpha.group-0.subgroup-0` |
| 4 | points (matched on their **type**) | `alpha.group-0.subgroup-0.t2` |

A path never auto-descends: `alpha.group-0` is the group, not its subgroups or
points. Five or more segments is a parse error.

Resolution mirrors **exactly what the panel tree shows**. A group whose points
span several categories appears in the tree under each of those categories,
listing only that category's subgroups — and paths follow the same branches:

- `alpha.group-0.*` → only the subgroups the tree shows under *alpha's*
  `group-0` branch (`subgroup-0`, `subgroup-3`), never another category's.
- But a path that **ends at** a group resolves that row's whole group —
  exactly what clicking the row selects — even where the group also appears
  under other categories. `view alpha.group-0` frames all of `group-0`;
  `view alpha.group-0.*` stays inside alpha's branch. Descent is
  category-scoped; a terminal group segment is the whole group.

## Segment predicates

Each segment holds one predicate, or a comma-list of them. All matching is
**case-sensitive** against opaque strings.

- **Exact literal** — `beta` matches the label `beta` and nothing else.
- **`*`** — every node at this level under the matched parents:
  `alpha.*` → alpha's groups; `*.*.*.t2` → every `t2` point in the system.
- **Glob** — `*` inside a token matches any run of characters, including the
  empty one: `sub*` (prefix), `*3` (suffix), `*group*` (contains),
  `s*0` (starts-s-ends-0). `view alpha.group-0.subgroup-*` matches both of
  that branch's subgroups.
- **Label range `lo-hi`** — parses the integer **at the end** of each label
  and matches when it lies in the inclusive range. `alpha.group-0.0-3`
  matches `subgroup-0` and `subgroup-3`. A label with no trailing integer
  (e.g. `solvent-bath`) never matches a range. **Range order is not
  semantic**: bounds normalize to `[min, max]`, so `9-2` and `2-9` denote
  the same set — for label ranges and `#` index ranges alike. (A range names
  a set, not a direction; a directional range would get its own syntax.)
- **List `a,b,c`** — the union of its element predicates, evaluated within
  the same parent scope. Elements may mix kinds:
  `alpha.group-0.subgroup-0.t1,t2,anchor`.

### The level footgun: count the dots

Because **slot position is meaning**, a token placed one level too shallow
resolves nothing — with no error, because it is valid syntax:

```
view alpha.group-0.t0          ✗ nomatch — t0 sits in the SUBGROUP slot
view alpha.group-0.*.t0        ✓ every t0 point under that branch
```

`t0` is a point-type token; the third segment addresses subgroups, and no
subgroup is labeled `t0`. When a command silently matches nothing, count the
dots first.

## Quoting

Labels containing spaces (or any delimiter character: `.`, `,`, `+`, `@`,
`#`, quotes) must be wrapped in double quotes. Quoted text is always an exact
literal — a `*` inside quotes is not a glob.

```
view gamma.group-2."subgroup 11"     ✓ the spaced label
view gamma.group-2.subgroup 11      ✗ parse error (the space splits the term)
```

The unquoted form is a **parse error**, not a silent miss.

## The point-index axis: `#`

Every point has a unique contract index — the number shown as `#N` on point
rows. `#` addresses points by that index directly:

- `view #161` — the single point with index 161.
- `view #156-187` — every point whose index is in `[156, 187]` inclusive.
  Bound order doesn't matter: `#187-156` is the same set.
- `#*` — every index at the current scope: standalone `#*` is every point in
  the system, `<path>.#*` every point under that path, `@name.#*` every point
  in that selection. Deliberately redundant — `#*` ≡ `*` standalone and
  `@name.#*` ≡ `@name` in point terms; it exists as the consistent
  "all indices" spelling on the `#` axis, not as new capability.

`#` is the **sole distinguisher** between an index range and a label range:
`#44-55` matches point indices; bare `44-55` matches the trailing integer of
labels. The two are unrelated.

Placement rule: `#` is inherently point-level, so it is valid only as a
**standalone term** or in a path's **final (4th) segment**, where it
intersects the path's scope — `alpha.group-0.subgroup-0.#161` matches only if
point 161 actually lies under that subgroup (a containment check). A `#` in
segments 1–3 is a parse error. A well-formed but out-of-range index (larger
than the dataset) is a *nomatch*, not an error.

## Committed selections: `@name`

`@name` resolves a committed selection — the things listed in the panel's top
section — by its exact name. Names containing spaces are quoted:
`@"my picks"`.

- `view @selection_1` — the whole selection (its full point set).
- A selection is a **flat set of points**: there is no descent past `@name`,
  only a single optional trailing predicate. `@name.a.b` is a parse error.

### Filtering: `@name.<predicate>` filters the STORED MEMBERS

The trailing predicate filters the selection's **member list** — exactly
what the panel shows under its block (and what `ls @name` prints). Each
member is matched at its own level: a label-level member (category, group,
or subgroup entry) by its **label**; a point-level member by its **type or
`#index`**. The result is the whole matched members.

```
view @picks.anchor          its POINT members whose type is anchor
view @picks."subgroup 11"   that member, if the SUBGROUP is a stored member
view @picks.#161            its stored point member 161
view @picks.s*              a glob over member labels and types
view @picks.t0,anchor       lists union, as in any segment
```

The filter never reaches **inside** a member: if the selection stores a
whole subgroup, the types, indices, and deeper labels of the points under it
are not members and match nothing — that granularity isn't in the
selection. To address finer pieces, commit a finer selection first
(`create_sele alpha.group-0.subgroup-0.* [fine]`); its members then ARE the
points, and the same tokens match. Depth is a property of how a selection
was committed, not of the filter. This keeps every command result something
the panel can display and every hide something its gestures can reverse.

A `:` in the filter is reserved for a future explicit level qualifier and
is currently a parse error, and combining two conditions (a label **and** a
type) is not yet expressible — the reserved `&` intersection operator is
the intended future path (the `@name.a.b` error says so).

### `all` and `@all` — the two "everything" terms

- `all` (bare keyword) is **everything in existence**: it resolves to every
  top-level category, exactly as if you had unioned them by hand. It is
  only a keyword standing alone as a term — `all.x`, `allx`, and `"all"`
  are ordinary labels.
- `@all` is **everything committed**: the union of every committed
  selection's members, deduplicated. With nothing committed it matches
  nothing (an honest nomatch). `@all.<pred>` filters the pooled membership
  under the same stored-members rule.

Both are ordinary terms and compose with `+`. The difference matters most
to `hide` (see below): `hide @all` hides your existing selections in
place, while `hide all` creates one new selection holding the whole
system. Because `@all` must always mean this, **`all` is refused as a
selection name** by `create_sele` and `rename`.

## Union: `+`

`+` unions any terms and is the only operator that crosses subtrees:

```
view alpha.group-0.*.t2 + beta.*
view #161 + @selection_1.anchor
```

The `@name` trailing predicate binds tighter than `+`:
`@a.t0 + @b.anchor` is two independently filtered selections, unioned.
Results are always de-duplicated.

## What `view` does

- **Frames the resolved set** — camera tween to fit it. Hidden points are
  **included** in the framing (this matches clicking a row, which frames its
  target wherever it is; it is *not* the empty-space click, which frames only
  what is visible). Nothing is unhidden; hidden points simply don't pulse.
- **Pulses the matching rows** — every *currently-mounted* panel row whose
  points intersect the result flashes, in both panel sections. A collapsed or
  scrolled-away branch legitimately does **not** highlight — that is the
  "only mounted rows flash, never force-expand" rule, not a bug.
- **Read-only** — `view` never changes the selection state and never adds an
  undo entry.
- **Bare `view`** (no argument) frames the visible scene — the empty-space
  click analog.

## Creating selections: `create_sele`

```
create_sele <target-expr> [name]
```

Commits the resolved target as a new committed selection — the text mirror of
"build this target, then press **Create selection**". `<target-expr>` is the
full address grammar above (any term kind, any union); no new syntax.

- **`[name]`** — optional. Square brackets are the delimiter, and the text
  inside is the **literal** name: grammar tokens (`.` `+` `#` `@`, spaces)
  carry no meaning there. `create_sele alpha.group-0.* [my ring #1]` names
  the selection `my ring #1`. Without `[name]`, the selection auto-names to
  the smallest free `selection_N`, exactly like the button. The name is the
  *trailing* bracketed run; inside the target expression itself `[` `]`
  remain reserved (parse error).
- **Entries keep their level.** The target commits as exactly the entries it
  resolves to — a group-level path stores **one group entry** (the member
  list shows that single coarse row), a leaf or `#` target stores point
  entries, and `@name` contributes its stored entries unflattened. A union
  can therefore produce a mixed-level member list (a subgroup entry plus a
  lone point entry, say) — that is correct, and mirrors what clicking those
  rows would store, entry-for-entry.

  ```
  create_sele alpha.group-0            one group entry (many points, one row)
  create_sele alpha.group-0.*.t0       point entries
  create_sele alpha.group-0.subgroup-0 + #301 [mix]   a subgroup + a point
  ```
- **Feedback**: the matching mounted rows pulse the pending-green once as the
  selection commits — the build→commit rhythm in a single call — then the
  named block appears in the top section with its brackets in the tree
  gutter. `created "<name>" — N points` prints in the terminal.
- **Undo**: one `Ctrl+Z` removes a `create_sele` selection completely.
- **Edit mode is irrelevant**: `create_sele` always creates a *new* selection
  and never touches the one being edited (it is a distinct verb, not the
  context-sensitive button that reads "Done" mid-edit).
- **Errors**: an explicit `[name]` that already exists is an error
  (`a selection named "<name>" already exists`) and nothing changes; an empty
  target is a *nomatch* and commits nothing; `[]` / an unbalanced `]` are
  parse errors.

## Hiding and showing: `hide` / `show`

Hiding is a property of **committed selections** — there is no free-floating
hidden set. That shapes the pair's asymmetry:

- **The commit rule — hide commits only what isn't already committed,
  all-or-nothing at the target level.** A target made **entirely of `@`
  references** (`hide @a`, `hide @a + @b`, `hide @all`) is already
  committed: hide flips hidden state on those selections **in place**,
  creates nothing, and the whole batch is **one undo op**; a `[name]` there
  is a usage error. A target containing **any non-reference term** — a
  path, glob, `#`, range, list, or the `all` keyword — **commits first as
  ONE new selection** (exactly like `create_sele`, including the optional
  trailing `[name]` and its collision rule), then hides — one action, **one
  undo**: a single `Ctrl+Z` removes the selection and its hidden state
  together. Referenced terms in a mixed target contribute their members to
  the new selection but their own selections stay untouched (show-wins
  covers the overlap). So `hide @all` hides your existing selections and
  creates nothing, while `hide all` creates one selection holding the
  whole system and reports its honest full size. The full cascade plays on
  the commit arm: green commit pulse → the new block → brackets → purple.
- **`hide @name`** — sets the whole-selection hidden flag. No commit, no
  green — purple only, points drop per show-wins.
- **`hide @name.<pred>`** — hides the matched **stored members** of an
  existing selection (`@sel.#12`, `@sel.#*`, or label/type predicates over
  the member list — the stored-members rule above). Matched members go
  purple as rows, exactly like the member right-click.
- `hide` **never toggles** — hiding something already hidden is an idempotent
  `already hidden` line (the header right-click gesture toggles; the verb
  chooses directional clarity). Bare `hide` is an **error** — there is no
  "hide everything" (say `hide all` or `hide @all` and mean it).
- **`show` never commits** — a point in no selection is already visible.
  `show @name` makes the **whole selection visible**: it clears the
  whole-selection flag *and* every per-member hide, so it is the reliable
  inverse of any hiding on that selection. `show @name.<pred>` clears
  **exactly** the matched hidden members (and if the selection is hidden
  *whole*, the subset form tells you: `hidden whole — show @name to reveal
  it`). `show <target>` clears hidden state *covering* those points
  wherever it lives — and no-ops honestly (`nothing hidden there`) when
  nothing is. Bare **`show`** and **`show @all`** reveal everything
  (non-destructive, one undo op).
- **Messages report the action, not pixels**: under show-wins, hiding a
  selection whose points are covered by another *visible* selection changes
  nothing on screen until the coverer hides too — the command still reports
  `hid "name" — N points`, because that is what it did.

## The color family: `colorpoints` / `colorbonds` / `colorbondsof`

```
colorpoints  <target-expr> <color>    the points themselves
colorbonds   <target-expr> <color>    edges with BOTH endpoints in the target
colorbondsof <target-expr> <color>    edges with AT LEAST ONE endpoint in it
```

The **representation** verbs: they paint a renderable primitive a constant
color. Every verb in the family targets **exactly like `view`** — the full
grammar, the same resolver, **hidden points included**, and it never commits
a selection — so each resolves precisely the point set `view <target>`
frames. They differ only in how that point set maps onto a primitive:

- **`colorpoints`** colors the points in the set (the identity mapping).
  (Shipped as `color`; renamed when the family grew — `color` is no longer
  a command, there is no alias.)
- **`colorbonds`** colors every edge whose **both** endpoints are in the set
  — *contained*, parity-preserving: every colored edge lies inside the
  target.
- **`colorbondsof`** colors every edge with **at least one** endpoint in the
  set — *incident*. An edge is colored **even when its other endpoint is
  outside the target**: reaching one hop out is this verb's whole point, and
  the one deliberate break from strict target-containment in the family —
  which is why it is a separate verb, not a flag. The two edge verbs write
  the same per-edge color state, so they compose by last-write-wins per
  edge.

The contained-vs-incident line is sharpest on a single point:
`colorbonds #124 red` is a **nomatch** (no edge has both endpoints in a
one-point set) while `colorbondsof #124 red` colors exactly the edges
incident to point 124.

```
colorpoints alpha green
colorpoints beta.group-0.subgroup-0.t2 #ff8800
colorpoints gamma.group-2."subgroup 11" red
colorbonds beta.group-0.subgroup-0 #ff8800
colorbonds all blue
colorbondsof #124 red
colorbondsof @selection_1 steelblue
```

Shared rules (identical across the family):

- **`<color>`** is a CSS color name (`red`, `steelblue`, `rebeccapurple`) or
  hex (`#ff8800`, or the short form `#f80`). The color token is
  **case-insensitive** (CSS semantics — it is a color, not a tree label);
  an unknown or malformed color is an **error** and nothing is written.
- **Each verb writes its own primitive only**: `colorpoints` never affects
  edges; the edge verbs never affect points or polylines. Within each
  primitive, **last-write-wins per element** — no precedence system, no
  blending. Elements never colored keep the uniform base look, and undoing
  past the first write restores it.
- **One undo stroke per invocation** — `Ctrl+Z` restores the exact previous
  colors, which may themselves be an earlier verb's (strokes compose LIFO).
- **Hidden geometry colors too** — the write lands in the representation
  state regardless of visibility, and the message reports the **action**
  (`colored N points green`, `colored N edges red`), not pixels, exactly
  like `hide`/`show` under show-wins. The color shows whenever the geometry
  does.
- A nomatch or any error **writes nothing and pushes no undo stroke**. A
  well-formed target that matches points but no edges (e.g. `colorbonds` on
  a single point) is a nomatch too. A bare verb (or a single argument) is a
  usage error — it needs both a target and a color.
- Constant colors only, deliberately: gradients, by-channel mappings, other
  appearance verbs (size, opacity), and a polyline verb (`colortrace` —
  deferred; see `docs/COMMAND_LAYER.md` open threads) are future work that
  will clone this family's shape.

## Listing: `ls`

`ls` is **read-only** — it never changes viewer state and never adds an
undo step. Three forms, each the text twin of a panel surface:

```
ls                     the committed selections: name — N points [· hidden]
ls @name               that selection's STORED members, as the panel lists them
ls @all                every selection's members, pooled
ls alpha.group-0       the contents ONE level below the resolved node(s)
```

For a path, `ls` lists the immediate children of whatever the path
resolves to (subgroups under a group, points under a subgroup); points have
nothing below. Very long listings cap with a count-and-hint
(`1600 items — narrow the target`) — the same volume rule Tab completion
uses. `ls` takes no `[name]`, and an empty result is an honest nomatch.

## Renaming: `rename @name [new-name]`

Renames a committed selection — the command twin of the panel's inline
rename (double-click the block's name), sharing its machinery: **one undo
op**, and the same collision error if `new-name` is taken. The target must
be exactly one unfiltered `@name` (`@all`, predicates, paths, and unions
are usage errors), the new name must be bracketed, and `all` is refused
(reserved so `@all` always means the union of every selection).

## Membership mutation: `add` / `remove`

The command analog of the panel's **edit mode** — growing and shrinking an
existing selection's member list. Both verbs take exactly **one** committed
selection first, as a lone `@name`: a `+` union on the left, `@all` (except
the bulk-delete form below), a filter (`@name.<pred>`), or a path there is
a usage error — they edit one selection at a time, just like the UI. Both
work in any UI mode (being in edit mode on another selection doesn't
matter), and each command is **one undo op**.

The second argument differs in kind between the two, and the asymmetry is
deliberate:

### `add @name <tree-target>` — the right side is a TREE address

What you're adding **isn't a member yet**, so it must be named from the
tree — the full address grammar applies (paths, globs, ranges, `#index`,
lists, `+` unions):

```
add @ring alpha.group-0.subgroup-3        one subgroup member
add @ring alpha.group-0                   ONE group-level member (natural level)
add @ring alpha.group-0.* + beta          several at once
```

Entries join at their **natural level** — a group-level address adds a
group entry, never its expanded points. Adding something already a member
is an honest no-op (`already members — nothing to add`). **`@` terms are
not allowed on the right**: the UI cannot transfer members between
selections, and neither can `add` — address the geometry from the tree
instead.

### `remove @name <member-pred>` — the right side is MEMBER predicates

What you're removing **is already a member**, so you name it directly — a
member's own label, or a point member's type/`#index` (globs, ranges, `,`
lists, and `+` unions compose); no tree path needed, because you're already
scoped to the selection:

```
remove @ring subgroup-3          a member, by its own label
remove @ring t0 + anchor         point members, by type
remove @ring subgroup-*          every member the glob matches
```

Matching is exactly `@name.<pred>` filtering (the stored-members rule):
whole members only. A predicate naming something *below* a coarse member —
a descendant label, a type or index inside it — **matches nothing**:
`remove` never splits a coarse member into its complement (no carving from
the terminal). To operate on finer pieces, commit a finer selection first.

### Emptying vs. deleting

- `remove @name all` — drop **every member**; the selection **remains** as
  an empty block.
- A predicate that happens to remove the last member behaves identically —
  the selection stays, empty. The message says so: `(now empty — the
  selection remains)`.
- **`remove @name`** (bare, no second argument) — **delete** the selection
  entirely: the command analog of the block's ✕ button.
- **`remove @all`** — delete **every** committed selection (the one
  deliberate bulk delete — it removes the selection objects, not their
  members). One `Ctrl+Z` restores them all. `remove @a + @b` stays a usage
  error: bulk deletion is exactly one selection or, explicitly, all of
  them — never an arbitrary union.

Deletion happens **only** through the bare forms; every member-targeting
form leaves the selection standing.

## `clear` — wipe the terminal log

`clear` empties the terminal's own output log. It is **terminal-local**:
nothing reaches the viewer, no selection or hidden state changes, no undo
step is created; the command history (Up/Down) survives. Not to be
confused with the panel's **Clear button**, which discards the pending
(uncommitted) target in the sidebar — that one *is* a viewer operation,
with its own two-step confirm.

## Tab completion — stateless and two-stage

Tab's behavior is a pure function of the current input; it keeps no memory of
prior presses. The two stages come from the token under the cursor:

- **Partial token** → it settles: the full label if unique, the common prefix
  plus a printed candidate list if several. No `.` is appended.
  `view alp` ⇥ → `view alpha`.
- **Exact-complete token at a descendable level** (category / group /
  subgroup, or an exact `@name` — a selection has its filter level below) →
  Tab appends `.` and prints the next level's candidates. So pressing Tab
  again right after a completion naturally walks down a level:
  `view alpha` ⇥ → `view alpha.` + its groups listed; `view @selection_1` ⇥ →
  `view @selection_1.` + that selection's identity tokens. Exact-match descent
  is unconditional — even when longer sibling labels share the token as a
  prefix, the fully-typed node descends; keep typing to reach a longer
  sibling.
- **The leaf (point-type), and `#` / `@name` / glob / range tokens** never
  descend and never gain a dot. An exact leaf token is terminal — Tab does
  nothing further.

Verb completion appends a space on a unique match; after `@name.` candidates
are the selection's stored-member tokens (member labels + point-member
types) — the exact set a `@name.<token>` filter could match, because a
selection is a flat bag of members with no structure to enter. To keep that
unmistakable, the
terminal prints these under a `filter by (type or label):` header — each
token is a **predicate you could apply**, not a member of the selection.
Path-level completion has no header: those candidates genuinely are tree
levels. Mashing Tab never stacks duplicates — an identical hint/list prints
once and stays until the input changes.

**Large lists cap for display**: when a completion would print more than ~50
candidates, Tab prints `N matches — type to narrow` instead of the list (and
withholds the common-prefix extension). Nothing is removed from the pool —
every withheld token still matches when you type it; a prefix narrows the
list back to normal. The same rule applies to path pools and `@name.` pools
alike.

## Parse error vs. nomatch — how to self-diagnose

This is the key debugging distinction:

- A **parse error** means the *syntax* is malformed. The message says what and
  where:

  ```
  view alpha..t0
  → empty segment — ".." and leading/trailing "." are not allowed
  ```

- A **nomatch** (`nothing matches "<expr>"`) means the syntax is *valid* but
  resolved to an empty set. The grammar is fine — check the tree: the level
  (count the dots), the exact spelling/case of labels, or whether the point
  index is in range.

  ```
  view alpha.group-0.t0
  → nothing matches "alpha.group-0.t0"     (t0 is one level too shallow)
  ```

An empty result is never reported as an error.

## Reserved syntax (deliberately "not yet")

These produce clear errors today so they can gain meaning later without
changing any existing command:

| Syntax | Today | Possible future |
|---|---|---|
| `[` `]` | parse error: `reserved character "["` **inside a target expression**; in the *trailing name position* of a mutating verb they are the `[name]` delimiter (an intentional dual role, not a collision) | set/slice syntax |
| `?` | parse error inside expressions (as a bare verb it is the `help` alias) | single-character wildcard |
| `..` | parse error: `empty segment` | range/descent sugar |
| `:` | parse error **inside `@name` filters** (`level qualifiers … not yet supported`); inside path labels it is currently an ordinary character | explicit level qualifier (`@sel.<level>:<pred>`) |
| `&` | **not reserved** — currently an ordinary label character | intersection operator |

Note the last two rows precisely: `:` is only reserved where the future
qualifier would live, and `&` is not yet reserved at all — a label containing
`&` matches normally today. If `&` becomes an operator, that will be a
breaking grammar change for such labels.
