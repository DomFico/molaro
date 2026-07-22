# Autonomous log — overnight: close the live gaps, then build redo

One decision per entry: what was decided, what was weighed, why, what would make it
wrong, the hash, and what depends on it.

Starting state: tree clean, pushed, `b8a5eed`.

---

## A1 — the P-3 success path says what undo does not cover · `66da9ba`

**Decided.** When a provider is sequenced and the consumer SUCCEEDS, say that the
channel was declared or refreshed and that undo reverses the consumer's writes but
not the declaration. Previously only the failure path said anything.

**Weighed.** (i) Say nothing on success — the status quo; rejected because the
asymmetry is structural, not incidental: the provider runs outside any stroke
(`runModOnce` opens none, `declareProducedChannel` records nothing) while a
`produces: commands` consumer opens exactly one, so one typed command produces two
effects and one Ctrl+Z reverses one of them. (ii) Say it once per session — rejected,
there is no session state to hang it on and a note the user missed is a note that
did not fire. (iii) Say it every time, branched first-declaration vs refresh, in the
failure note's register — chosen.

**Wrong if.** The note proves noisy enough in daily use that people stop reading the
outcome lines. That would be a real cost and is worth watching; the alternative was
a promise quietly narrower than the one stated.

**Depends on it.** Nothing. Independently revertible.

---

## B1 — commit()'s live pendingSet read is a redo prerequisite, not a live defect · `9d5e1dc`

**Decided.** Investigation says NO undo-only sequence can break it, so the fix lands
with the redo work rather than ahead of it. The invariant it rests on is pinned now.

**Weighed.** Nothing to weigh on the finding itself — it is a fact, established three
ways: `pendingSet` is REASSIGNED in exactly three places (constructor, `commit()`,
`commit()`'s undo), so only the interim object can change in between; every mutator of
that object records an op, so strict LIFO reverts them all first (measured: the
interim set is empty when `commit`'s undo reads it); and `seed()`, the one documented
unrecorded mutator, builds its own set and never touches it. What WAS decided: to pin
the invariant with tests now rather than when redo needs it, because a redo stack
replays forward and forward replay is exactly what would invalidate the justification.

**Wrong if.** A future op mutates the pending set without recording — the tests would
not catch that directly, they only pin the consequences. The narrow guard would be a
check that every pending mutation records; not built, not obviously worth it yet.

**Depends on it.** D-1 (the commit op is one of the records that must gain a forward
face, and these tests are its regression net).

---

## C1 — two stale comment claims deleted; the rest verified · `909b575`

**Decided.** Delete the claims that `lane` is "(movable)" and that undo covers
"bracket-lane moves". No lane operation exists — `lane` is assigned at construction
and never mutated.

**Weighed.** (i) Log as a gap and build lane moves — rejected, nothing asks for the
feature and inventing one to make a comment true is backwards. (ii) Leave and log —
rejected, a false claim in the indicative is exactly the failure mode being audited.
(iii) Delete — chosen.

**The finding worth keeping** is in `reports/COMMENT_AUDIT.md`: both false claims
described a feature that was *designed and not built*, not code that rotted. A comment
written in the intended tense and left in the indicative is indistinguishable from a
description of reality later. Claims naming an identifier are greppable and both were
caught that way; prose claims are not.

**Wrong if.** Someone had a lane-move branch in flight. Nothing in the tree suggests it.

**Depends on it.** Nothing.

---

## E1 — the inert arming target exists today; no affordance needs building

**Answered, nothing built,** per the brief.

**The question.** Is there a non-canvas element that can take a click inertly, so the
webview can gain keyboard focus without the canvas handler moving the camera?

**Answer: yes, and it already exists.** `webview/main.ts:2873` opens the pointerdown
handler with `if (e.target !== renderer.domElement) return;`. A pointerdown on
anything that is not the WebGL canvas never arms `navDown`, so it can reach neither
the subgroup-focus path nor `frameVisible()`. The viewer webview builds real DOM
beside the canvas — the selections panel, `webview/committed.ts:112,119,135` — so
clicking its empty area focuses the webview and does nothing else. The keydown
listener is on `window` (`main.ts` ~2937), so focus anywhere in that document routes
to it.

**Two caveats worth carrying into the build, if it happens.** A transient
`<input>` appears during rename (`committed.ts:303`) and focuses itself, so keys go
there while renaming — correct, but a gesture must not fire during it. And this only
answers *reachability*: the cost is still one click per terminal round-trip, because
opening the terminal takes focus away (`preserveFocus: false`).

**Consequence.** Both previously-named mitigations — flipping the terminal to
`preserveFocus: true`, and focus-on-hover — are unnecessary. Neither should be built.

**Depends on it.** The hold-semantics decision, which stays parked (see PARKED.md).

---

## D1 — every recorded op gains a forward face; `redo()` is REQUIRED · `6229785`

**Decided.** Widen `UndoOp` to `{ undo(); redo(); }` with `redo` mandatory, and give
all 16 record sites a forward closure.

**Weighed.** (i) `redo?()` optional — additive, no call site forced to change, and
rejected: an op without a forward face sits on the stack looking redoable and quietly
does nothing, which is the exact failure mode this feature must not have. (ii)
Required — chosen; the compiler then enumerates the sites instead of leaving the gap
to be found by a user. It found one in `sets.ts` I had missed and all five in
`main.ts`.

**Consequence worth noting.** `writeRepValues` is the single funnel every
representation writer reaches, so capturing the written values there gave the whole
colour/size/opacity/style/orientation grid a forward face in one edit.

**Wrong if.** Some op's forward closure is not the true inverse of its undo. The
byte-identity walk in `tests/sets.test.ts` is the guard; it compares a fingerprint at
every depth down and back up rather than only at the ends.

**Depends on it.** D-2, D-3.

---

## D2 — ONE invalidation point, reached by routing `endStroke` through `pushUndo` · `d9799cc`

**Decided.** Rather than hooking redo-invalidation at both `pushUndo` and
`endStroke`'s direct stack push, remove the second entrance: `endStroke` now pushes
through `pushUndo`.

**Weighed.** (i) Hook both sites — correct today, and rejected: it leaves two doors
into the stack, so the next person to add a push has to know to hook it too. That is
the two-lists shape this repo has paid for repeatedly. (ii) Route through `pushUndo`
— chosen. Safe because `strokeOps` is already null by then, so it takes the stack
branch. One door means the hook cannot be half-installed.

**Wrong if.** Routing changed stroke semantics. It does not — the composite is pushed
identically, and ~21 E2E `undoDepth` predicates plus the unit suite would fail loudly
on a granularity change. A test covers the compound-invalidation case specifically,
because that is precisely what the rejected option would have missed.

**Depends on it.** D-3.

---

## D3 — the cap is BYTES (64 MB) with an ENTRY floor (20) · `d9799cc`

**Decided.** Trim the undo stack by retained bytes, never below 20 entries, dropping
oldest first.

**Weighed.** (i) No cap — the status quo, ruled out by the brief and by arithmetic:
value-replay doubles what a representation op retains. (ii) A count cap (e.g. 100
entries) — simple and predictable, and rejected because it cannot bound memory here:
one full-system write retains `points × 3 × 4 × 2` bytes, so 100 entries is hundreds
of megabytes on a large scene and nothing on a small one. (iii) Bytes with an entry
floor — chosen: the floor is the quantity a person reasons about (how far back can I
go), the ceiling is the quantity that hurts. Light ops accumulate far past the floor.

**The numbers are arbitrary the way any budget is.** 64 MB is small beside the frame
cache the player already holds; 20 entries is more than the undo-a-few-times habit
this replaces. They exist to make the failure bounded, not to be exactly right.

**Wrong if.** Someone routinely does more than 20 full-scene writes and expects to
walk back through all of them. Then the floor is too low — and it is one constant.

---

## D4 — redo refuses at a provider boundary by DROPPING the future, with a reason · `d9799cc`

**Decided.** Declaring or recomputing a channel calls `model.dropRedo(reason)`, which
clears the walked-back future and keeps the reason so `Ctrl+Shift+Z` can say why.

**Weighed.** (i) Let redo cross it — rejected by the ruling and by the reasoning:
ops replay values, so replaying them over data replaced since would lay the same
writes on different numbers and report success. (ii) A barrier entry redo stops at,
leaving the future intact behind it — rejected: it keeps unreachable ops alive
holding buffers, and the "intact" future is exactly the thing that is no longer
valid. (iii) Drop the future and explain — chosen. Undo is untouched; only the
forward direction is refused.

**Why a declaration must do this at all**, which is the non-obvious part: a
declaration is not an op, records nothing, and would not otherwise clear the redo
stack — so without this, `undo → run a channel mod → redo` replays writes against
values that moved, silently. The refusal exists because the invalidation is invisible.

**Fence.** `sets.ts` stays domain-free: it exposes `dropRedo(reason: string)` and
knows nothing about what changed. The reason string is composed in `main.ts`.

**Wrong if.** The refusal proves too aggressive in practice — any channel run
anywhere kills the redo stack, including one unrelated to what was walked back. A
finer rule would need ops to record which channels they read; not built, and it is
the first thing I would revisit.

**Verified in the real viewer**, not only in unit tests: two writes → two undos
returning to baseline exactly → two redos byte-identical → a new op after an undo leaves
`redoDepth 0`. That exercises `writeRepValues`' after-capture, which the unit suite
cannot reach.

---

# Overnight part 2

## A2 — the lane is green; the eviction path it was meant to stress was never reached · `79f1522`

**Result.** Full lane green against the redo push: 49 scenarios, 993 checks, 0
failed, 21.0 min. All ~21 `undoDepth` predicates hold.

**The finding that matters more than the green.** The specific risk — eviction —
was *not exercised*. The lane's scenes are 6000 points, so one full-scene write
retains ~141 KB and crossing the 64 MB budget needs ~466 of them; nothing comes
close. Two things bound the exposure: no product code reads `undoDepth`/`canUndo` at
all (only E2E predicates do), and the trim touches only the undo stack while
undo/redo move ops between stacks without changing the total.

**Decided.** Pin the untested interaction at unit level rather than leave it to a
user on large data: survivors still undo/redo in the right order, and an evicted op
never runs in either direction.

**Wrong if.** Eviction interacts with something outside the two stacks. Nothing
suggests it does.

---

## B2 — ribbon thickness is 15% of width, proportional, square-edged · `2a44249`

**Decided.** A thin box cross-section, 8 base corners, thickness = 0.15 × half
width, ends open, square edges.

**Weighed.** (i) Absolute thickness — rejected: chunky on a thin band, invisible on
a wide one. (ii) Proportional — chosen; slenderness is constant across widths.
(iii) Bevelled edges — rejected: needs its own normals for a sliver you cannot see
at this ratio. (iv) Per-face normals via a 15th vertex attribute — **attempted and
reverted**, see below.

**Pixel audit.** tube 5296 → 5296, unbound ribbon 0 → 0, **bound ribbon 3087 →
3549 (+15%)**, tube-after-swap 5401 → 5401. Only the bound silhouette moved, and
upward, which is what thickness means.

**Two findings.** A 15th vertex attribute made the ribbon draw **zero pixels with
no error surfaced anywhere** — bind succeeded, attribute versions bumped, only the
pixels vanished. Bisecting with thickness 0 proved it was the geometry, not the
offset math. And my first edit landed in `edgeTubeShaders`: it opens with the
identical comment and `attribute vec2 aCorner`, so a single-replace on a
non-unique anchor hit the wrong shader — and S43 could not catch it, because it
exercises trace tubes rather than bonds.

**Wrong if.** 15% reads as too thin or too thick on real curves. It is one constant.

---

## C2 — the hold gesture: key `F`, refuse on no selection, newest on several · `74f0808`

**Decided.** `F` unmodified; a point in no committed selection refuses with a
message; a point in several resolves to the most recently created, with the name
shown during the dwell; the setting is workspace-scoped.

**Weighed.** (i) Silent no-op when nothing resolves — rejected: indistinguishable
from a broken key. (ii) Refuse loudly — chosen. (iii) Ambiguity by prompt or picker
— rejected as a second gesture stage; showing the resolved name during the dwell
gives the same safety for free.

**The finding.** The harness serves its own page, not `renderHtml`, so
`__VIEWER__.holdCommand` is undefined under test — the same shape as the plot CSP
bug. Rather than duplicate the default in the webview and the host,
`DEFAULT_HOLD_COMMAND` lives in `commands.ts` and the host imports it as its
`getConfiguration` fallback. Two spellings of one default fails silently: the
gesture would work in one context and not the other.

**Wrong if.** `F` collides with something a future panel wants. Nothing claims it now.

---

## D2 — the segment count is parked with a lean toward producer-supplied orientation

Written up in `PARKED.md`. The fork is orientation, not geometry: a subdivided
vertex is not a point, so either the producer supplies orientation at the subdivided
resolution or something interpolates a direction field — reviving the sign-ambiguity
walk, in the render loop. Lean: the producer emits both, no contract change.

**And the thing I would measure first:** how much visible faceting is segment count
versus the **miter limit clamp** at `dot(along, m) ≥ 0.25`. If it is mostly clamp,
subdivision is the wrong fix for the symptom.
