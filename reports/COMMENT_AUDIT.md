# Comment audit — claims cross-checked against the code (Item C)

Twice this week a comment described a mechanism that was never written:
`assert_single_channel_mirror` (a named tripwire with no test behind it) and
`sets.ts` documenting bracket-lane moves as undoable with no lane-mutation code.
Two instances is a pattern, so this is the sweep.

**Method.** Three passes over `webview/`, `src/`, `contract/`, `producer/`:
1. every comment naming a test file or an `assert_*`-style guard by identifier;
2. every comment claiming something is *guarded / asserted / enforced / pinned*;
3. every *single-source* claim ("the ONE …", "the only place …", "so no second …").
Each named thing was then looked for.

## Findings

| claim | where | verdict |
|---|---|---|
| `assert_single_channel_mirror` is "the tripwire against a second mirror appearing" | `main.ts:2297` | **WAS FALSE — now true.** Written tonight as `tests/channel_mirror.test.ts` (commit 502fc34), verified to fire. |
| `lane` is "(movable)" | `sets.ts:331` | **STALE — removed.** |
| undo covers "bracket-lane moves" | `sets.ts:356` | **STALE — removed.** `lane` is assigned only at construction (`freeLane()` at 609 and 770), read for layout at `brackets.ts:95`, and never mutated. No lane operation exists, so none can be undoable. |
| styles are "byte-identical … pinned by unit test AND the pixel scenarios" | `styles.ts:40`, `shaders.ts:54` | **TRUE** — `tests/styles.test.ts` asserts the constants. |
| the security fence is "asserted by test" | `claudetools.ts:14` | **TRUE** — `tests/tool_surface.test.ts`. |
| the `write_mod` schema "can never drift … Asserted in tests/recipes.test.ts" | `claudetools.ts:326` | **TRUE** — the `MOD_PRODUCES` ↔ `z.enum` equality assertion is there. |
| trace-color scatter is "pinned by S17" | `commands.ts:876` | **TRUE** — `S17` exists in `tests/redesign.ts`. |
| the partial-state wording is "pinned by tests/redesign.ts" | `main.ts:2533` | **TRUE** — matched verbatim at two sites. |
| "so no second undo system can ever exist" | `sets.ts:587` | **TRUE, and structurally enforced** — `undoStack` is `private readonly` and appears only inside `sets.ts`; `recordOp` is the sole external seam. This is the strongest claim in the set because TypeScript enforces it rather than a convention. |

## What the pattern actually is

Both false claims describe a feature that was *designed and not built* — a guard
that was going to be written, a lane move that was going to be implemented. Neither
describes code that rotted. So the failure mode is **a comment written in the
intended tense and left in the indicative**, which reads identically to a
description of reality a year later.

The cheap defence is the one that worked tonight: when a comment names a mechanism
by identifier, the identifier is greppable, and the check is mechanical. The two
false claims were both found that way. A claim written as prose ("undo covers …")
is not greppable and was only caught because someone read it.

**Log-only, no change made:** `sets.ts:576` pushes to `undoStack` directly rather
than through `pushUndo`. No comment claims otherwise, so it is not an audit finding
— but it is load-bearing for the redo work (a redo-invalidation hook on `pushUndo`
alone would miss every compound stroke), and it is recorded here because the audit
is where it was re-confirmed.
