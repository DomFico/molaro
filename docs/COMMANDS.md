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
| `colortrace <expr> <color>` | Color polyline vertices whose **subgroup** contains a resolved point (maps up; boundary segments blend) | `colortrace alpha steelblue` |
| `pointsize <expr> <size>` | Size those points — a **world-anchored** sphere radius that scales with zoom (0 is legal and **never hides**; negatives clamp to 0) | `pointsize alpha 2` |
| `bondsize <expr> <size>` | Width for edges with **both** endpoints in the target — a world-anchored tube radius that scales with zoom | `bondsize beta.group-0.subgroup-0 0` |
| `bondsizeof <expr> <size>` | Width for edges **touching** the target (either endpoint — the incident reach) | `bondsizeof #124 1.5` |
| `tracesize <expr> <size>` | Thickness for polyline vertices whose **subgroup** contains a resolved point | `tracesize alpha 1.5` |
| `pointopacity <expr> <a>` | Fade those points (0–1; 0 is invisible-but-**present**, never a hide; clamps) | `pointopacity alpha 0.5` |
| `bondopacity <expr> <a>` | Alpha for edges with **both** endpoints in the target | `bondopacity beta.group-0.subgroup-0 0` |
| `bondopacityof <expr> <a>` | Alpha for edges **touching** the target (either endpoint — the incident reach) | `bondopacityof #124 0.3` |
| `traceopacity <expr> <a>` | Alpha for polyline vertices whose **subgroup** contains a resolved point | `traceopacity alpha 0.7` |
| `rainbow <expr>` | Color those points an even hue ramp in resolution order (the first **recipe**: per-point values, not one constant; one undo stroke) | `rainbow alpha.group-0` |
| `bake <expr> <channel> <axis> [<min> <max>]` | Write a declared data channel (at the displayed frame) onto a representation axis — scalar channel → point `color`/`size`/`opacity`, edge `bondcolor`/`bondsize`/`bondopacity` (**endpoint mean**, contained edges), polyline `tracecolor`/`tracesize`/`traceopacity` (each vertex reads **its** point), normalized over min..max; **vector (3-wide) channel → `orientation`, raw** (one undo stroke) | `bake all energy color 0 2.5` |
| `bind <expr> <channel> <axis> [<min> <max>]` | Register a **channel→axis binding** (same gate as `bake`): the axis **re-derives from the channel on every frame flip**; last-bind-wins per element within an axis; one undo stroke. Vector channel → `orientation` (raw; **stored only — no shape reads it yet**) | `bind all energy color 0 2.5` |
| `unbind <expr> [<axis>]` / `unbind all [<axis>]` | Release binding **coverage element-wise**, one axis or all (values stay as last applied; one undo op) | `unbind alpha color` |
| `bindings` | Read-only list of the channel bindings (bare — takes no target) | `bindings` |
| `stylepoints` / `stylebonds` / `styletrace` `<expr> <style>` | Select a registered **shading style** per target (per-element style index; `standard` is the default look, byte-identical; `stylebonds` = contained edges, `styletrace` = subgroup map-up; one undo stroke) | `stylepoints alpha matte` |
| `styles` | Read-only listing of the style registry (bare; index 0 = default) | `styles` |
| `shape <points\|bonds\|traces> <name>` | Draw a whole **domain** as a named registered shape (scene-level — per-target assignment is a parked chapter; one undo op) | `shape traces tube` |
| `shapes` | Read-only listing of the shape registry per domain (bare) | `shapes` |

**The ribbon** (`shape traces ribbon`) is the first ORIENTED shape: a flat
band along each polyline whose plane comes from the **orientation** buffer —
bind a 3-wide vector channel (`bind all <vector-channel> orientation`) and
the band's "across" follows the data every frame. Unbound orientation means
no defined plane: every segment **collapses and nothing draws** (the honest
degeneracy — the tube stays the default shape). Width reads `tracesize`,
colors/opacity the trace axes, shading the style axis; ends/bends are naive
(no joint caps — the tube's joint-sphere trick needs rotational symmetry).
| `mods` | List the **recipe registry** (read-only): each recipe's name, axis, origin, and credit — bare, takes no target | `mods` |
| `rm <mods>` | Delete **workspace mod files** (y/n confirmed, **not undoable**; built-ins refused) | `rm index_ramp + xy_metric` |
| `ls [@name` / `<path>]` | List selections / a selection's members / a node's contents (read-only) | `ls @selection_1` |
| `rename @name [new]` | Rename a committed selection | `rename @selection_1 [ring]` |
| `add @name <tree-target>` | Add tree-addressed entries as **members** at their natural level (no `@` on the right) | `add @ring alpha.group-0` |
| `remove @name <member-pred>` | Drop matched **stored members** (never carves) | `remove @ring subgroup-3` |
| `remove @name all` / `remove @name` / `remove @all` | Empty its members (it remains) / **delete** it / delete **every** selection | `remove @ring` |
| `clear` | Wipe the terminal's own log (viewer state untouched) | `clear` |
| `/claude` | Toggle the conversation panel above the terminal (its own input; tool calls gate on approve/deny) | `/claude` |
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

To address a whole **class of points by type** across the entire system, wildcard
the first three levels and name the type in the 4th segment: `*.*.*.C` is every
point of type `C`. On a molecule the point type is the atom's element, so this is
how you do CPK / color-by-element compactly — `colorpoints *.*.*.C gray`,
`colorpoints *.*.*.N blue`, … — instead of an atom-by-atom `#index` list. The
type vocabulary present on the loaded system is reported by `get_context`.

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

## The representation family: color, size, and opacity

```
colorpoints  <t> <color> │ pointsize  <t> <size> │ pointopacity  <t> <a>
colorbonds   <t> <color> │ bondsize   <t> <size> │ bondopacity   <t> <a>
colorbondsof <t> <color> │ bondsizeof <t> <size> │ bondopacityof <t> <a>
colortrace   <t> <color> │ tracesize  <t> <size> │ traceopacity  <t> <a>
```

The **representation** verbs form a grid: four *shapes* (how a point set
maps onto a renderable primitive) × three *axes* (color, size, opacity) —
twelve verbs, one template. Every verb targets **exactly like `view`** — the
full grammar, the same resolver, **hidden points included**, and it never
commits a selection — so each resolves precisely the point set
`view <target>` frames. The verbs of one shape share the *same* mapping
code across all three axes, so the axes cannot disagree about which
elements a target reaches. The four shapes:

- **Point** (`colorpoints` / `pointsize`) — the points in the set, the
  identity mapping. (`colorpoints` shipped as `color`; renamed when the
  family grew — `color` is no longer a command, there is no alias.)
- **Edge-contained** (`colorbonds` / `bondsize`) — every edge whose **both**
  endpoints are in the set: *contained*, parity-preserving — every written
  edge lies inside the target.
- **Edge-incident** (`colorbondsof` / `bondsizeof`) — every edge with **at
  least one** endpoint in the set: *incident*. An edge is written **even
  when its other endpoint is outside the target**: reaching one hop out is
  this shape's whole point (on a single named element it is *the* way to
  address that element's emanating edges), and the one deliberate break
  from strict target-containment in the family — which is why it is a
  separate verb, not a flag. The two edge shapes write the same per-edge
  state on each axis (one edge-color buffer, one edge-size buffer), so they
  compose by last-write-wins per edge. Corollary on broad incident targets:
  an edge bridging the target and a neighboring element is *shared* — if a
  later command addresses the neighbor, that boundary edge resolves
  last-write-wins. Inherent to incident semantics, identical on both axes,
  documented rather than prevented.
- **Subgroup-vertex** (`colortrace` / `tracesize`) — polyline geometry **per
  vertex, mapped up to the subgroup level**: the subgroups containing ≥1
  resolved point are *active*, and a vertex is written iff its subgroup is
  active. This stays *contained* — no vertex outside the target's subgroups
  is ever written; the map-up is resolution-to-primitive-**granularity** (a
  single point activates its whole subgroup's vertex), not the incident
  reach. Segments between differently-valued vertices **interpolate**
  (color: a gradient toward the base look; size likewise, once thickness
  renders) — inherent to per-vertex state, and intended; there is no
  per-segment rule. A target whose active subgroups own no polyline
  vertices is a **nomatch**. (On the synthetic data a single-category
  target like `colortrace alpha` writes a *scattered* vertex set — the
  polyline's categories cycle — so the trace looks dashed. Correct, by
  design.)

So on each axis: three **contained** shapes at three granularities (point /
edge-both / subgroup-vertex) and one intentional **reach** (edge-either).
The contained-vs-incident line is sharpest on a single point:
`colorbonds #124 red` / `bondsize #124 2` / `bondopacity #124 0.5` are
**nomatch** (no edge has both endpoints in a one-point set) while
`colorbondsof #124 red` / `bondsizeof #124 1.5` / `bondopacityof #124 0.3`
write exactly the edges incident to point 124 — and the trace shapes with
`#124` in scope write exactly the one vertex of the subgroup owning
point 124.

```
colorpoints alpha green      pointsize alpha 2      pointopacity alpha 0.5
colorbonds beta.group-0.subgroup-0 #ff8800          bondopacity beta.group-0.subgroup-0 0
colorbondsof #124 red        bondsizeof #124 1.5    bondopacityof #124 0.3
colortrace alpha steelblue   tracesize alpha 1.5    traceopacity alpha 0.7
colorpoints gamma.group-2."subgroup 11" red         pointopacity all 1
```

The axis values:

- **`<color>`** is a CSS color name (`red`, `steelblue`, `rebeccapurple`) or
  hex (`#ff8800`, or the short form `#f80`). The color token is
  **case-insensitive** (CSS semantics — it is a color, not a tree label);
  an unknown or malformed color is an **error** and nothing is written.
- **`<size>`** is a plain non-negative number (`2`, `1.5`, `0`). Size numbers
  keep their historical meaning — a size-v element spans about v pixels at
  the initial camera framing — but the value is now anchored in **world
  units** (one scene-scale constant converts it), so elements **grow and
  shrink with zoom** instead of staying pinned to screen pixels. **Zero is a
  legal, literal value — it does NOT hide**: a size-0 element stays in the
  scene, stays in its buffer slot, and its hide-state is untouched (size
  and hide are orthogonal channels; a zero-extent element draws **zero
  pixels**, which is not the same thing as hidden — it stays pickable, and
  the message says `set N points to size 0`, never "hidden"). **Negative
  values clamp to 0** and the message notes it (`(clamped to 0)`). A
  non-numeric size token is an **error** and nothing is written.
- **`<opacity>`** is a number in **[0, 1]** (`0.5`, `0`, `1`). **Zero is a
  legal, literal alpha — it does NOT hide**: a zero-opacity element is
  *invisible-but-present* — still in the scene, still in its buffer slot,
  still pickable, hide-state untouched (a hidden element is *gone*; the two
  channels never touch each other — which is exactly what makes "fade an
  element to fully transparent while keeping it selectable" expressible).
  The message says `set N points to opacity 0`, never "hidden".
  **Out-of-range clamps two-sidedly** — below 0 → 0, above 1 → 1 — and the
  message names the bound (`(clamped to 0)` / `(clamped to 1)`). A
  non-numeric token is an **error** and nothing is written.
- **Visible thickness caveat**: point sizes render as shaded, depth-correct
  **spheres** (ray-traced impostors) and edge widths render as shaded
  **tubes** with real world thickness — `bondsize`/`bondsizeof` move pixels,
  scale with zoom, and share the points' scene-scale constant (the default
  3 : 1 point : edge ratio is geometric). Trace **widths are stored but not
  yet drawn** — the polyline pass still rasterizes 1 px GL lines until
  increment C's tube pass. Its buffers, undo, and messages are fully live;
  only those pixels lag.
- **Transparency-ordering caveat**: per-element opacity renders **today**
  on all three primitives via alpha blending, but blending is draw-order
  **naive** — overlapping *semi*-transparent elements may composite in the
  wrong order (correct depth-sorting / order-independent transparency is a
  recorded follow-up). Fully-opaque and fully-transparent elements render
  exactly right; it is the translucent-over-translucent overlap that can
  mis-composite.

Shared rules (identical across the twelve verbs):

- **Each verb writes its own primitive's buffer on its own axis only** — no
  size verb touches any color buffer or another primitive's size buffer,
  and vice versa. Within each buffer, **last-write-wins per element** — no
  precedence system, no blending. Elements never written keep the uniform
  base look, and undoing past the first write restores it.
- **One undo stroke per invocation** — `Ctrl+Z` restores the exact previous
  values, which may themselves be an earlier verb's (strokes compose LIFO).
- **Hidden geometry is written too** — the write lands in the
  representation state regardless of visibility, and the message reports
  the **action** (`colored N points green`, `set N edges to size 2`), not
  pixels, exactly like `hide`/`show` under show-wins. The value shows
  whenever the geometry does.
- A nomatch or any error **writes nothing and pushes no undo stroke**. A
  well-formed target that matches points but no edges or trace vertices
  (e.g. a contained edge verb on a single point, a trace verb on bulk
  subgroups) is a nomatch too. A bare verb (or a single argument) is a
  usage error — it needs both a target and a value.
- Constant values only, deliberately, within this family: each of the
  twelve verbs writes ONE value across its elements. Values that *vary* per
  element are the **recipes'** job (see `rainbow` below) or the **channel
  consumer's** (see `bake`); live per-flip channel bindings and
  shape/primitive-type verbs remain future work. (The trace
  shapes' boundary interpolation is a rendering consequence of per-vertex
  state, not a mapping feature; size-0 and opacity-0 are distinct literal
  values on distinct channels, and neither is a hide.)

## Recipes: `rainbow`

```
rainbow alpha.group-0
rainbow alpha.group-0.subgroup-0
rainbow @selection_1
rainbow alpha.group-0 + beta.group-2
```

A **recipe** is a stored, named function over a resolved target that writes
a representation buffer — the generalization of the twelve fixed verbs
(one *constant* value) into verbs whose written value **varies per element**
as a function of the resolved set. `rainbow` is the first: it spreads an
even 0→1 ramp across the resolved points **in resolution order** and colors
them through one built-in hue sweep (red at the start of the set, magenta
at the end; a single-point target is plain red). Under the hood the recipe
computes a per-point scalar and a colormap turns scalars into colors — the
two stages stay separate so future scalar sources reuse the same
color-mapping step.

- `rainbow <target>` takes **no value token and no `[name]`** — the whole
  argument is the target expression, resolved exactly like `view` (full
  grammar, hidden points included, never commits).
- It writes the same per-point color buffer `colorpoints` writes, with all
  the family's shared rules: **one undo stroke** per invocation,
  **last-write-wins per element** (a later `colorpoints` overwrites ramp
  colors and vice versa), hidden points written too, message reports the
  action and count (`colored N points rainbow`), and a nomatch or error
  writes nothing and pushes no stroke.
- Recipes live in an in-memory registry (name → recipe) the verb resolves
  through; parameters and other axes are future work.

## Channels: `bake`

```
bake all energy color 0 2.5
bake polymer mass size
bake @selection_1 energy opacity 0 1
```

`bake` is the first **channel consumer**: it reads a header-declared data
channel's per-element values **at the displayed frame** (`per_point`
channels are static — their header block is the value source at every
frame), normalizes them into `[0,1]` over a range, and writes the target's
points on one axis — `color` through the built-in hue ramp, `size` over the
fixed `0..6` visual range, `opacity` as-is. It is a **plain recorded
write**, indistinguishable from a hand-typed rep verb: one undo stroke,
last-write-wins, nothing persists past it — scrubbing to another frame does
NOT re-derive (a *live* per-flip binding is separate, future work).

- The **range**: the channel's declared `min`/`max` when both are present;
  otherwise the explicit trailing pair is required (`bake … <min> <max>`,
  which also *overrides* a full declaration). Values outside the range
  saturate at 0/1 — the range is a lens, not a validity bound.
- The **gate** fails loudly and writes nothing: unknown channel or axis,
  a `per_frame` channel (a series, not per-element), a vector channel
  (`components: 3` — scalar axes need 1-wide), a missing or empty range,
  or a non-finite value in the displayed frame's block.

### Bindings: `bind` / `unbind` / `bindings` — the live channel link

`bind <target> <channel> <axis> [<min> <max>]` registers a **binding** —
the durable statement "this channel drives this axis over these points" —
through the exact gate and normalization `bake` uses, applies the current
frame's values in the same single undo stroke (one Ctrl+Z removes the
binding *and* restores prior values), and from then on **re-derives the
bound axis from the channel on every displayed-frame flip**: scrub, seek,
or play and the bound elements follow the data. The per-flip re-derive is
*derived state* — it is never recorded, so one undo after any amount of
playback still restores the pre-bind picture in one step. Bindings are
listed by `bindings` and counted in the status-line badge.

- **Coverage is element-disjoint PER AXIS**: a new bind takes its overlap
  from earlier **same-axis** bindings (last-bind-wins, element by
  element); bindings on *different* axes coexist over the same elements
  (color from one channel, size from another). `unbind <target> [<axis>]`
  releases coverage the same element-wise way — scoped to one axis when
  named, across all axes otherwise (`unbind all` releases everything;
  released values stay as last applied).
- **The LWW rule is live**: a direct representation write (`colorpoints`,
  `pointsize`, `pointopacity`, `bake`, a recipe) over bound elements
  **clears the overlapping same-axis coverage in the same undo stroke** —
  the write lands, those elements stop being channel-driven, and one
  Ctrl+Z restores both the values and the coverage. The last explicit
  action wins, visibly, element by element.
- **The orientation axis — a vector channel, stored only (for now)**:
  `bind <target> <vector-channel> orientation` binds a **3-wide** channel to
  the per-vertex **orientation** buffer on the polyline domain, raw (no
  range — a min/max there is a category error and refuses). It re-derives on
  flip and undoes like any axis, but **nothing draws it yet** — no shape
  reads orientation, so the effect is invisible; every message and the
  `bindings` row say so. A scalar channel on `orientation`, or a vector
  channel on a scalar axis, both refuse loudly by width.
- **All three element domains bind**: the scalar axes cover points
  (`color`/`size`/`opacity`), edges (`bondcolor`/`bondsize`/`bondopacity` —
  an edge's value is the **mean of its two endpoints'** channel values,
  computed on the raw values before the range lens; coverage is the
  **contained** edges, both endpoints resolved, colorbonds' rule), and
  polyline vertices (`tracecolor`/`tracesize`/`traceopacity` — each vertex
  reads **its own point's** value). Coverage lives in each domain's own id
  space; releases never cross domains.
- **Static channels stay exact for free**: a `per_point` channel's values
  cannot change per frame, so its binding's bind-time apply is already
  correct at every frame (the per-flip applier skips it).
- **Unbound scenes pay zero**: with no bindings, per-flip work is
  byte-identical to a viewer without this feature.


A mod is one of two kinds. **Representation** mods (like `rainbow`) compute
in the webview over geometry only. **Analysis** mods carry Python source
that executes **in the producer process against the loaded dataset**, and
declare what they produce — the declaration is the routing key into the
existing machinery (nothing new renders):

- `produces: per-point-scalar` (+ an `axis`: color / size / opacity) — one
  value in `[0,1]` per resolved point, bound through the same per-element
  write rails as `rainbow` (one undo stroke, last-write-wins; the mod owns
  its own normalization).
- `produces: per-frame-series` — one **raw** value per frame, drawn in the
  plot tab exactly like a series tool result.
- `produces: scatter` — the ONE widened return shape: `compute` returns a
  **dict** `{"x": [...], "y": [...], "frames": [...]?, "xLabel": str?,
  "yLabel": str?}` (equal-length finite `x`/`y`; `frames`, if present,
  integer frame indices matching that length — the highlight/seek sync
  hook). Drawn in the plot tab exactly like a scatter tool result.
- `produces: figure` — a **rendered figure**: `compute` returns a dict
  `{"png": <base64>, "width": px, "height": px, "axes": [{"bbox": [x0, y0,
  w, h], "xlim": [lo, hi], "x_is_frames": bool}]}` — the image (≤ 2 MiB
  decoded) plus **one metadata entry per subplot**, emitted MECHANICALLY
  from the figure object (`ax.get_position().bounds`, `ax.get_xlim()`; the
  shipped `figure_metric` example's `_figure_reply` helper does exactly
  this — never hand-compute it, a wrong bbox is a plausible-looking,
  silently misaligned playhead). Drawn in the plot tab; every axes flagged
  `x_is_frames` gets the **live playhead marker** and **click-to-seek**,
  through the exact `plotSeek` path the series uses; an axes without the
  flag (histograms, maps, anything) is legitimately static. Matplotlib
  renders headless in the producer (`Agg`); a producer environment without
  matplotlib fails the mod loudly ("matplotlib not available"), never a
  blank panel. Note: figure CONTENT is an image — the harness asserts the
  mapping numerically but samples content as pixels, a knowingly lighter
  bar than the built-in kinds' element assertions.
- `produces: commands` — the **macro** mod: `compute` returns a flat
  **`list[str]`** of command strings (exactly as typed in the terminal), run
  through the existing command path. No `axis`. Because it is Python with the
  trajectory available, it can **compute first and then emit commands** (e.g.
  compute a per-atom quantity, then `colorpoints` the atoms above a
  threshold) — it is not limited to static strings. It is a saved, named,
  credited, re-runnable *look or action* — the way to persist a
  `colorbonds`/`colorpoints` styling that a `per-point-scalar` mod cannot
  reproduce (that path maps through one built-in hue ramp and writes every
  atom; a macro paints exact named colors and leaves the rest untouched).

  The list is handled at the **mod-run boundary** — it is NOT a fifth
  typed-result kind. Execution is **fail-closed and all-or-nothing**: the
  return must be a list of non-empty strings, EVERY string is validated
  (parsed + resolved, with no side effects) before ANY runs, and a parse
  error in the third string runs **zero** commands, not two. A *nomatch* is
  not an error (the rest still run; per-command outcomes are reported).
  `rm` and invoking any mod (itself or another) are **refused** inside a
  macro — enforced where the commands execute, so runtime-generated strings
  can't launder around it. The whole invocation is **ONE undo stroke**: a
  single `Ctrl+Z` reverses the entire macro. `mods` lists it with
  `produces: commands`; a `commands` mod may be invoked bare (no target),
  since it may ignore `target_indices`.

  Every other `produces` keeps the flat `list[float]` return.

**Invocation** is the same own-verb shape: `<modname> <target>`. The verb
acknowledges immediately (`running <mod> on N points…`) and the outcome
prints as a follow-up line when the producer answers — computation may
take a moment, and frame streaming queues behind it (bounded by a 5 s
timeout). Errors — a Python exception (with its traceback), a timeout, a
wrong-length or out-of-range return — **bind nothing** and report the
reason; validation is fail-closed and never partial-writes.

**Mod files.** Analysis mods persist as one Python file per mod under
`.molaro/mods/` in the workspace, loaded at startup (a malformed file is
skipped with a warning, never breaking the registry). The format is a
readable header + the source — the point is that you can **read the code
before running it**:

> **One root — the VS Code workspace root.** `.molaro/mods/` lives at the
> workspace root (`workspaceFolders[0]`), and **every** path agrees on it: the
> startup scan, `write_mod`/`saveWorkspaceMod`, and `rm`. The assistant writes
> there, you read there, `rm` deletes there — one folder, no ambiguity. (The
> repo's own `viewer/.molaro/mods/` holds the shipped **reference/example** mods
> — `rg`/`rmsd`/`rmsf` and the synthetic examples — as dev and test assets;
> they are excluded from the packaged `.vsix`, so a fresh install starts with an
> empty workspace `.molaro/mods/` that you fill by authoring mods or copying an
> example. The corpus check can target either location with `--mods-dir`.)

```python
# molaro-mod
# name: index_ramp
# kind: analysis
# produces: per-point-scalar
# axis: color
# author: Example Author
# description: a normalized index ramp over the target

def compute(data, target_indices):
    n = max(len(target_indices) - 1, 1)
    return [i / n for i in range(len(target_indices))]
```

`compute(data, target_indices)` is the fixed contract: `data` is the
dataset handle already resident in the producer (`data.give_header()`,
`data.give_frames(start, count)`); `target_indices` is the resolved point
set in header order (`scalars[i]` binds to `target_indices[i]`); the
return is a flat `list[float]` — one per target index for
`per-point-scalar`, one per frame for `per-frame-series`. Loaded files get
origin `workspace` (built-ins are code, not files). This is user-approved
code — there is no sandbox; the protections are validation and the
timeout.

#### The trajectory API inside `compute`

For molecular datasets, `data.trajectory` is the **live
[`mdtraj.Trajectory`](https://mdtraj.org)** backing the loaded system — so a
mod can call mdtraj's own analyses directly instead of reimplementing them.
It is **`None`** when the source has no trajectory (the synthetic dataset); a
domain analysis should check this and fail closed:

```python
def compute(data, target_indices):
    traj = data.trajectory
    if traj is None:
        raise RuntimeError("this analysis needs a trajectory-backed dataset")
    ...
```

Raising (or returning a wrong-shaped result) binds nothing and reports the
reason — the fail-closed contract already described.

#### The viewer's labels inside `compute`: `data.labels`

A `commands` mod builds command strings, which name the viewer's **labels**
(`polymer.A."ASP 33"`). `data.labels` gives a mod those exact strings so it
addresses real labels instead of guessing them:

```python
data.labels[i]          # -> ("polymer", "A", "ASP 33")  — (category, group, subgroup)
len(data.labels)        # n_points
```

`data.labels[i]` is the **category, group, and subgroup names the viewer
displays and the address grammar matches** for point index `i`, taken from the
header the producer already builds. It is **header-order indexed** — the same
correspondence as `data.trajectory` and `target_indices`, so `data.labels[i]`
describes the same atom as column `i` of `traj.xyz`. It is present for **every**
source, the synthetic one included (labels are neutral information, not domain
information), and is **read-only**.

Use it to build targets — never infer a group label from an mdtraj chain index
(`chr(65 + chain.index)`), which is right only by luck and silently nomatches
the moment a chain isn't named `A`/`B`/`C`:

```python
# produces: commands — colour each chain's acidic residues, addressed by the
# viewer's OWN group label rather than a guessed one.
def compute(data, target_indices):
    idx = target_indices or range(len(data.labels))
    groups = sorted({data.labels[i][:2] for i in idx})   # {(category, group)}
    return [f"colorbonds {cat}.{grp}.ASP*,GLU* red" for cat, grp in groups]
```

If every command a mod emits nomatches, the run reports plainly that nothing
matched (and nothing was written) — a mod addressing labels that don't exist is
visible, not a silent success.

**What's reachable** off `data.trajectory` (standard mdtraj):

- `traj.xyz` — `(n_frames, n_atoms, 3)` float32 coordinates, **in nanometers**.
- `traj.topology` — atoms, residues, chains, bonds; `traj.topology.select("…")`
  runs an [atom-selection query](https://mdtraj.org/latest/atom_selection.html)
  (e.g. `"name CA"`, `"protein"`, `"resname BNZ"`, `"name P"`) and returns atom
  indices; `traj.atom_slice(indices)` returns a sub-trajectory.
- `traj.n_frames`, `traj.n_atoms`, `traj.unitcell_vectors`, `traj.time`.
- All of `mdtraj`: `md.rmsd`, `md.rmsf`, `md.compute_rg`, `md.compute_phi`,
  `md.compute_distances`, … (`import mdtraj as md`; `numpy` is available too).

**Index alignment — the load-bearing guarantee.** Point index `i` in header
order **is** atom index `i` in `traj.topology` **and** column `i` in
`traj.xyz`. So `target_indices` (header order) can index the trajectory
directly: `traj.atom_slice(target_indices)` is exactly the selected atoms, in
the selected order. For a `per-point-scalar` mod this is what makes
`values[k]` land on `target_indices[k]` — verified against a real system in
`tests/reference_mods_corpus.py`.

**Units are nanometers** everywhere mdtraj touches — it normalizes every
container format to nm on read. Never multiply by 10; a length that looks
10× off is a unit bug, not a scale choice.

**Return contract by `produces`** (unchanged — the trajectory is just a richer
`data`):

- `per-point-scalar`: `list[float]` of length `len(target_indices)`, in that
  order, **each normalized to `[0,1]` by the mod itself** (it decides what
  "high" means — e.g. min-max over the returned set).
- `per-frame-series`: `list[float]` of length `n_frames`, **raw** (the plot
  auto-scales).
- `scatter`: the dict shape above.

**Definitional care** — the traps that separate a plausible number from a
correct one (each is a real choice the reference mods document in their
headers):

- **Mass weighting** — `md.compute_rg` and a mass-weighted radius differ from
  a geometric one; state which you mean.
- **Superposition** — `md.rmsd(traj, traj, frame=0)` superposes by default;
  RMSD with vs. without alignment are different observables.
- **Atom subset** — computing over all atoms vs. a `select(...)` subset
  changes the value; keep a subset run coherent (align on and measure the same
  atoms).
- **float32 accumulation** — `md.compute_rg` reduces in float32; for a tight
  match to a float64 reference, reduce coordinates in float64 yourself.

The shipped reference mods `rg`, `rmsd`, and `rmsf` (in `.molaro/mods/`) are
worked examples of all of the above, each verified against the benchmark
corpus to `1e-4` nm.

### Listing the registry: `mods`

```
> mods
built-in:
  rainbow — representation · point-color · by Dominic Fico · https://github.com/DomFico/molaro
workspace:
  index_ramp — analysis · per-point-scalar → color · by Example Author · https://github.com/DomFico/molaro
  frame_metric — analysis · per-frame-series · by Example Author · https://github.com/DomFico/molaro
```

`mods` is the registry's read-face — the vocabulary-side parallel to `ls`
(`ls` lists committed selections, which are *scene* state; `mods` lists the
registered mods, which are *vocabulary* state). One line per mod, grouped
by **origin**, showing the mod's name, its **kind** (and, for analysis
mods, what it produces), and its **credit**. It lists mods only — the
built-in command verbs stay with `help`/`?`.

Every mod carries attribution: a required `origin`, plus optional `author`
and `source` strings shown for credit. These are **display-only opaque
strings** — nothing resolves, fetches, validates, or acts on them; a
`source` that looks like a URL is a citation, not a reference the viewer
follows. Long listings share `ls`'s display cap.

`mods` is bare — it inspects the vocabulary, not the scene, so it takes no
target; any trailing argument is a usage error. Read-only: no state, no
undo impact.

### Deleting workspace mods: `rm`

```
> rm index_ramp + xy_metric
will delete 2 workspace mods: index_ramp, xy_metric
files are removed from disk — this CANNOT be undone. y/n?
> y
deleted 2 mods: index_ramp, xy_metric
```

`rm <name> [+ <name>…]` / `rm all` deletes **workspace mod files** from
`.molaro/mods/` and unregisters them (they leave `mods` and their verbs
stop resolving). The selector names **mods, not points** — bare names,
`+` unions, and `all`, which always means all *workspace* mods.

- **Built-ins are refused by name** (`rainbow` is code, not a file); a
  mixed selector refuses the built-ins and confirms the deletable rest —
  the prompt states exactly which mods will be deleted.
- **It asks first.** `rm` prints what will be deleted and waits: the next
  input is the answer, not a command. `y`/`yes` deletes; `n`/`no` — or
  ANYTHING else, including something that looks like a command — cancels
  and deletes nothing (fail-safe). `clear` discards a pending prompt.
- **It cannot be undone.** The undo stack covers scene state, not the
  filesystem. Files are deleted first and only what actually succeeded is
  unregistered, so a partial failure (a locked or missing file) is
  reported by name and the failed mod stays registered.
- If nothing is deletable (unknown names, only built-ins, or no workspace
  mods), `rm` reports and never prompts. It touches nothing outside
  `.molaro/mods/`.

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

## `/claude` — the conversation panel

`/claude` **toggles** a conversation panel sharing the terminal's view: the
first invocation splits the view (by default panel above, terminal below)
and focuses the panel's input; typing it again — or the panel's ✕ —
collapses back to the full terminal. Like `clear` it is **terminal-local**:
the toggle never reaches viewer state and creates no undo step.

**The split is yours to arrange — and it's remembered.** Drag the divider
between the panes to resize (each pane keeps a usable minimum). The two
small controls next to ✕: **⤢ flips** the orientation (stacked ↔
side-by-side, keeping the ratio) and **⇄ swaps** the pane order (each pane
keeps its size; positions exchange). The layout — orientation, order,
ratio, and whether the panel is open — persists across reloads and
tab-aways. Only the layout persists: the transcript, series, and scene
state do not.

The panel is a chat surface with its own input (the terminal keeps its own
input for the verbs above — two input surfaces, one relay):

- Assistant replies **stream** into the transcript.
- Tool calls render as inline blocks (tool name + args preview). Some run
  directly; a **gated** tool shows **approve / deny** buttons and runs only
  on approval (deny produces an error-styled result).
- A **stop** button interrupts the in-flight turn; the input re-enables
  when the turn completes.
- A thin status line shows the backend's connection state and hint —
  display only, no credential entry.

**Typed results drive the viewer.** A tool result may carry a typed
payload beyond its display summary; the viewer binds it on the existing
rails and the outcome renders as an italic `⤷` line in the tool's block
(error-styled when the binding refuses). The closed set of kinds:

- **per-point scalars** — one value per point (already normalized to
  `[0,1]`) over a target address, applied to a point axis: **color**
  through the built-in hue colormap, **size** as `0…6` (2× the base
  size), **opacity** as-is. `scalars[i]` matches the *i*-th point of the
  target in header order — the same resolution `view`/`rainbow` use; a
  count mismatch writes **nothing**. The write is one undo stroke,
  last-write-wins, exactly like a hand-typed representation verb.
- **command** — a command string run through the exact path a typed
  terminal command takes (so an approved tool can, say, `create_sele` a
  selection); undo comes from the verb itself.
- **per-frame series** — one **raw** value per frame (whatever its units —
  the plot auto-scales, it never normalizes), drawn as a line in the
  **plot tab**: its own editor panel (drag/split/dock like any tab),
  created or revealed when a series arrives. The plot shows the series
  label, its raw min/max, a **playhead marker** that tracks the current
  frame through playback and scrubbing, and **click-to-seek** — clicking
  the plot seeks the trajectory to that frame, so the plot is a control,
  not just a readout. A series whose length ≠ the frame count draws
  **nothing** and the `⤷` line reports the mismatch.
- **scatter** — raw (x, y) pairs drawn as points in the **same plot tab**
  (equal-length, non-empty `x`/`y`; **both** axes auto-scale to their own
  min/max, with optional `xLabel`/`yLabel` in the readout). An optional
  `frames` array (one frame index per point, same length) is the **sync
  hook**: when present, the current frame's point is highlighted as the
  playhead moves and **clicking a point seeks** the trajectory to that
  point's frame (nearest point within a small tolerance). Without
  `frames` the scatter is a legitimate **static picture** — no highlight,
  no seek. Malformed payloads (unequal lengths, empty, out-of-range
  frames) draw **nothing** and the `⤷` line reports why.

The plot tab holds **one active item at a time** — a line series or a
scatter; a new result of either kind replaces the current one, and the
held item is restored when the tab is reopened.

An unknown kind is an error, never a guess. The union closes at four.

### The assistant backend

By default the panel talks to a **real analysis assistant** built on the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk), running in the
extension host behind the same frozen message contract. Its job is to **author
and run analysis mods**: it writes a `.molaro/mods/*.py`, you approve the full
Python, it runs in the producer against the live trajectory, and its typed
result binds to the viewer — the curve, the coloring, the scatter — through the
machinery already described above. A scripted **stub backend** (no assistant, no
network, no key) remains available behind the `molaro.assistant.useStub` setting
and drives the test suite.

**Authentication — API key, via VS Code.** Molaro is a distributed extension, so
it uses Anthropic **API-key** auth (not your claude.ai / Claude Code login). The
key is read from VS Code **SecretStorage**, falling back to the
`ANTHROPIC_API_KEY` environment variable. If neither is set, run **“Molaro: Set
Anthropic API Key”** — a native password box stores it in SecretStorage.
**“Molaro: Clear Anthropic API Key”** removes it. The key is never shown in the
webview, never logged, and reaches the model only through the agent subprocess
environment. The panel's status line shows **connected** / **disconnected** with
a hint. The model is set by `molaro.assistant.model` (default a current Sonnet).

**The tool surface — exactly four, and nothing else.** The assistant has access
to four in-process tools and no others — no filesystem, shell, search, or
network. `allowedTools` only auto-*approves*, so the lockdown is enforced by
disallowing every non-molaro tool the SDK ships (its file/shell built-ins **and**
the managed-agent tools it also carries — `Task`, `Cron*`, `Workflow`, `Skill`,
`ToolSearch`, …), by `strictMcpConfig` (which drops any ambient MCP server, e.g.
a user's claude.ai Gmail/Drive/Calendar connectors), and by loading no
`.claude` settings. Because a deny-list can only catch names we thought to
write down, the guarantee is a test that reads the SDK's **actual** runtime tool
surface (the `init` message) and asserts it equals exactly our five — failing the
moment anything else appears:

| tool | approval | what it does |
|---|---|---|
| `get_context` | none (read-only) | Reports the loaded system's shape and scene state (including the point-type vocabulary and the base look). |
| `write_mod` | **required** | Writes a `.molaro/mods/*.py`; **the approval preview is the full Python source**. |
| `run_mod` | **required** | Runs a mod on a target; the typed result binds to the viewer. |
| `run_command` | none (undoable) | Runs one grammar command. **Refuses `rm` and analysis-mod runs** at the tool boundary. |
| `delete_mod` | **required** | Deletes a workspace mod file (`.molaro/mods/<name>.py`) and unregisters it; **built-ins and anything outside that directory are refused by construction** (the same path-map discipline `rm` uses). |

Gated tools surface as an **approve/deny** block in the panel — for `write_mod`,
the complete Python you're about to save; for `delete_mod`, the mod name and file
path; nothing runs unseen. The invariant is not a fixed tool count but that
**destructive operations are never ungated**: `run_command` and macro execution
stay closed to `rm` because they are *ungated* paths, while `delete_mod` may
delete precisely *because* it is gated behind an approval. `run_command` is
undoable and ungated, but **cannot** delete files (`rm`) or execute Python (an
analysis mod) — those go only through the gated tools. When a mod fails, the
producer's **traceback** is returned to the assistant so it can fix the mod and
try again.

**Platform support.** The Claude Agent SDK runs the assistant through a
platform-native binary, so this build's assistant works on the platform the
`.vsix` was packaged for. On an unsupported platform the assistant cannot start —
the panel reports it plainly (`disconnected`, with an error explaining the
platform limit); the rest of Molaro (viewer, terminal, mods) is unaffected.

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
