# Parked — forks declined during the overnight run, each with a lean

## P1 — hold-F gesture semantics
**Parked by the brief.** Item E answered reachability only; the build waits.
**Lean:** dwell-to-fire while showing the resolving selection name during the dwell,
moving off to cancel. It gets run-on-release's safety (you see what resolved before
it acts) without a second gesture stage or a second hold-feel, and it reuses
`HOLD_MS` from `tree.ts` so the two holds cannot drift apart.
**Blocked on:** nothing technical. It is a taste call on a live surface.

## P2 — a guard that every pending-set mutation records an op
`commit()`'s justification rests on strict LIFO covering every mutation of the interim
pending set. B1 pinned the *consequences*; nothing pins the *premise*.
**Lean:** not yet worth it. The premise is currently enforced by there being only a
handful of mutators, all in one file. Revisit if a mutator ever lands outside `sets.ts`.

## P3 — routing mod outcome lines somewhere other than the terminal panel
`asyncLine` posts `commandResult id:-1`, which the host forwards only to the terminal.
Anything triggered from the viewer (a gesture, a future button) would be silent.
**Lean:** mirror non-`ok` statuses to the topbar status line, not just `error` — the
all-nomatch summary is status `nomatch` and is exactly what a non-terminal user must
not miss. Out of scope tonight; it is gesture-adjacent and the gesture is parked.
