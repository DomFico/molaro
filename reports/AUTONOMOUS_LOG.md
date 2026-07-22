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
