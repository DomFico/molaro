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
| `@name.<pred>` | Filter the selection: keep points whose **type or any ancestor label** matches | `view @selection_1.anchor` |
| `a + b` | Union of terms (the only cross-subtree operator) | `view alpha + @selection_1.t0` |
| `view` | Frame the visible scene (no argument) | `view` |
| `create_sele <expr> [name]` | Commit the target as a new selection (auto-named without `[name]`) | `create_sele alpha.group-0.* [ring]` |
| `hide <expr>` / `hide @name[.pred]` | Hide it (an uncommitted target commits first); never toggles | `hide @selection_1.t0` |
| `show [<expr>` / `@name[.pred]]` | Clear hidden state (never commits); bare `show` reveals everything | `show @selection_1` |
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

### Filtering: `@name.<predicate>` matches anywhere

The trailing predicate keeps each of the selection's points whose **leaf type
OR any ancestor label** (subgroup, group, or category) matches — one rule for
all of these:

```
view @selection_1.anchor          points whose TYPE is anchor
view @selection_1."subgroup 11"   its points under that SUBGROUP
view @selection_1.group-0         its points under that GROUP
view @selection_1.alpha           its points under that CATEGORY
view @selection_1.t*              a glob, matched against type and all labels
view @selection_1.#161            its point 161 (containment check)
view @selection_1.t0,anchor       lists union, as in any segment
```

If a token matches at more than one level (or different points at different
levels), the result is the **union of all matching points** — deliberately
broad, never a "which level did you mean" question. If the framed set is
larger than intended, type a narrower predicate. A `:` in the filter is
reserved for a future explicit level qualifier and is currently a parse error.

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

- **`hide <target>`** (a path/glob/`#`/range/list target) — the target
  **commits first** (exactly like `create_sele`, including the optional
  trailing `[name]` and its collision rule), then the new selection hides —
  one action, **one undo**: a single `Ctrl+Z` removes the selection and its
  hidden state together. The full cascade plays: green commit pulse → the new
  block → brackets → purple.
- **`hide @name`** — sets the whole-selection hidden flag. No commit, no
  green — purple only, points drop per show-wins.
- **`hide @name.<pred>`** — hides the matched members of an existing
  selection (`@sel.#12`, `@sel.#12-40`, `@sel.#*`, or type/label predicates
  matched against its points). Members fully matched go purple as rows; a
  subset *inside* a coarse member hides exactly those points, reported in the
  block's "N hidden" count (there is no row for a sub-member point).
- `hide` **never toggles** — hiding something already hidden is an idempotent
  `already hidden` line (the header right-click gesture toggles; the verb
  chooses directional clarity). Bare `hide` is an **error** — there is no
  "hide everything".
- **`show` never commits** — a point in no selection is already visible.
  `show @name` clears the whole-selection flag only; `show @name.<pred>`
  clears the member hides the predicate intersects (whole-entry granularity,
  like every un-hide); `show <target>` clears hidden state *covering* those
  points wherever it lives — and no-ops honestly (`nothing hidden there`)
  when nothing is. Bare **`show` reveals everything** (non-destructive, one
  undo op).
- **Messages report the action, not pixels**: under show-wins, hiding a
  selection whose points are covered by another *visible* selection changes
  nothing on screen until the coverer hides too — the command still reports
  `hid "name" — N points`, because that is what it did.

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
are that selection's own identity tokens (types + ancestor labels).

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
