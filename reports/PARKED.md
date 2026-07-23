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

## P4 — ribbon segment count (subdivision). Written up, not built.

The ribbon draws one quad per polyline vertex, so a bend is exactly as coarse as
the supplied curve. On a tight turn the band is visibly faceted, and the miter only
makes the facets meet cleanly — it cannot add any.

**Subdividing in the PRODUCER sidesteps what killed renderer-side subdivision.** The
renderer's objection was that generating vertices at draw time breaks
slot ≡ header order and forces compaction. A producer that emits a denser polyline
does not: it is still a linear copy, just of more vertices, and every downstream
invariant holds unchanged because the header simply says there are more of them.

**The fork that makes it a chapter is orientation, not geometry.**

`orientation` is a per-point-per-frame channel, and polyline vertices map UP from
points. A subdivided vertex is not a point — nothing in the contract gives it a
channel value. So one of two things has to happen, and they are different projects:

**(a) The producer supplies orientation at the subdivided resolution.**
Clean in the renderer: every vertex has a real supplied value and `drawn ≡ supplied`
holds unmodified. The cost is that the producer must now own the orientation field
for vertices that do not correspond to points — which means either the mod that
computes orientation also computes the subdivision (coupling two concerns that are
currently independent), or the contract grows a per-VERTEX channel scope beside the
per-point one. That second option is a wire change and is out of scope by standing
rule.

**(b) Something interpolates between supplied orientations.**
No contract change and no producer coupling. But interpolating a direction field has
its own coherence question, and it is the same one `ribbon_dir` already had to solve
along the chain: two adjacent supplied directions can be near-antiparallel, and the
naive interpolation through the midpoint is undefined exactly where you most need it.
Slerp on the sphere fixes magnitude but not the sign ambiguity; the sign has to be
resolved against a neighbour, which is a walk, which is the thing that made the
frame-to-frame flip-correction subtle. Doing it per frame at draw time also puts a
walk in the render loop.

**My lean: (a), with the producer emitting a denser polyline AND the orientation
values for it, and no contract change** — i.e. subdivision becomes something a mod
opts into by supplying both, rather than a renderer feature. That keeps
`drawn ≡ supplied` literally true, keeps the walk in Python where the existing
flip-correction already lives, and makes the coarseness a property of the data
rather than of the viewer. The cost is that a coarse polyline stays coarse until
someone re-emits it, which is honest: the viewer is not inventing curve that the
data did not contain.

**What I would want measured before building either:** how much of the faceting is
actually the segment count versus the miter limit clamp. The miter clamps at
`dot(along, m) ≥ 0.25`, and a tight enough bend hits that clamp — where more
segments would not help, because each one still meets its neighbour at a clamped
corner. If the visible faceting on real curves is mostly clamp rather than
resolution, this whole item is the wrong fix for the symptom.

## P5 — edge-primitives (bicolor + dashed) follow-ups
**Parked by the ship.** The bicolor/dashed edge primitives (incr 51) shipped with a
`clear_to_merge` adversarial pass; the completeness critic surfaced four non-blocking
items, each proven-safe-today, deferred rather than gold-plated into the same merge.
Pick these up when the edges work continues (especially before the "authorable edges"
substrate chapter, which extends this exact code).
- **Redo assertion for the new verbs.** Undo is E2E-proven; redo (Ctrl+Shift+Z)
  through the double-`withBindingClear` stroke for `bicolorbonds`/`bonddash`
  specifically is not asserted. **Lean:** add a redo leg to S54/S55 — cheap, closes an
  inherited-behavior gap. Low risk (no provider boundary in these direct rep writes,
  so the [[viewer-increment-44-d1-d4]] redo-future-drop rule doesn't bite).
- **Alpha-divergence guard.** `min(iColorA.a,iColorB.a)` alpha-pass routing is correct
  only because both halves' alpha always come from the single `edgeOpacity[e]`. That's
  an unguarded convention. **Lean:** add a unit assertion that no writer sets one
  half's alpha alone (a `two-lists-must-agree`-flavored guard), so a future edge writer
  can't silently diverge them.
- **Junction-dash depth.** Dash `discard` at a capped/analytic-trimmed junction isn't
  pixel-proven; only the straight tube is. **Lean:** reasoned safe (a gap reveals the
  sphere behind, not a background hole), so a written note may suffice; add a junction
  pixel spot-check only if the interaction-edge work makes dashed junctions common.
- **Bind-takeover advisory under-count (cosmetic).** `overlapStats` skips the other
  axis, so displacing the OTHER color axis's binding under-reports the element count in
  the advisory message (coverage IS released; message-only). **Lean:** count both color
  axes' coverage in the takeover advisory when the written axis shares the A/B buffer.
