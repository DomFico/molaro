# STATE — overnight run (part 1)

Started from `b8a5eed`, tree clean and pushed. Everything below is committed and
pushed to `origin/main`; the tree is clean.

## Committed, in order

| item | hash | what |
|---|---|---|
| A | `66da9ba` | the P-3 note now fires on SUCCESS too — one Ctrl+Z covers only the consumer's half, and it says so |
| B | `9d5e1dc` | investigation: `commit()`'s live read is a **redo prerequisite, not a live defect**; the LIFO invariant it rests on is pinned with three tests |
| C | `909b575` + `e779c7e` | comment audit — two stale claims deleted (`lane` "(movable)", undo covering "bracket-lane moves"); the rest verified real |
| — | `e779c7e` | decision log, parked forks, audit report (`reports/` is gitignored — force-added) |
| D-1 | `6229785` | every recorded op has a forward face; `redo()` required so the compiler enumerates |
| D-2/3 | `d9799cc` | redo on Ctrl/Cmd+Shift+Z: stack, ONE invalidation point, byte cap, provider-boundary refusal, assertions, docs |

## Green

- **467 unit tests**, typecheck clean, at every commit.
- **Verified in the real viewer** (headless, synthetic producer): two writes → two
  undos return to the baseline fingerprint exactly → two redos are **byte-identical**
  → a new op after an undo leaves `redoDepth 0`. This is the part unit tests cannot
  reach, because `writeRepValues` lives in `main.ts`.
- E2E suite **not** run tonight — see below.

## The one decision I most want reviewed

**D4 — the provider-boundary refusal drops the whole walked-back future.** Any
channel declaration or recomputation kills the redo stack, including one unrelated to
what was walked back. That is deliberately blunt: ops replay values, and nothing
records *which* channels an op read, so a finer rule cannot be written without adding
that. The blunt version is safe and occasionally annoying; the alternative is a
silent wrong picture. If you want it finer, the change is to have ops record their
channel dependencies, and it is not small.

Second, smaller: **D-2 and D-3 share a hash.** Their edits interleave in `sets.ts`
and splitting them cleanly at that point would have been error-prone. Both are logged
as separate decisions against the one hash. It is the one place tonight where
one-decision-one-commit was not strictly honoured, and I would rather flag it than
have you find it.

## Not done, deliberately

- **The E2E suite was not run.** The redo work touches `sets.ts` and `main.ts`, and
  roughly 21 E2E predicates read `undoDepth`. The unit suite and a targeted headless
  check are green, but a full lane is the honest gate for a change this wide and it
  needs a clean machine and time. **Run `node tests/run_e2e.ts` before shipping.**
- **Item E built nothing**, per the brief. The answer: the inert arming target
  already exists — the viewer's pointerdown handler returns unless the target is the
  canvas, and the webview builds real DOM beside it. Both previously-named
  mitigations are unnecessary.
- Parked forks are in `reports/PARKED.md` with leans: hold-F semantics, a guard on
  pending-set mutation recording, and routing mod outcome lines to a non-terminal
  surface.

## Out of scope, untouched

Channel declarations remain append-only and non-undoable; the macro refusal is
unchanged; the hold-F gesture is unbuilt; nothing on the ship list was touched.


---

# STATE — overnight run, part 2

Started from `f024bb9`. Everything below is committed and pushed; tree clean.

## Committed

| item | hash | what |
|---|---|---|
| A | `79f1522` | **the gate: full lane GREEN** — 49 scenarios, 993 checks, 0 failed, 21.0 min — plus tests for the eviction path the lane cannot reach |
| B | `2a44249` | ribbon thin box cross-section, pixel-audited, screenshots at the miter camera |
| D | `816b1cb` | segment count parked with a lean (writeup only, nothing built) |
| C | `74f0808` | the hold gesture: template from settings, dwell-to-fire, target shown while dwelling |

## Green

- Full E2E lane green at the start; **S36 + S43 + S44 re-run green after the ribbon
  change** (43 checks); 469 unit tests and typecheck clean at every commit.
- Gesture verified in the real viewer: dwell showed the resolved command, firing
  reported its outcome, `undoDepth` unchanged for a camera-only template, move-off
  cancelled.

## The one decision I most want reviewed

**The ribbon shades with one normal for the whole box, not per face.** Per-face
normals are the better picture — the edges would catch light as edges — but they
need a 15th vertex attribute, and adding one made the ribbon draw **zero pixels with
nothing reporting an error anywhere**. At 15% of the width the edges are a sliver, so
the compromise is cheap; but if edge shading matters, the route is fewer attributes
elsewhere rather than a 15th, and that is a real piece of work.

## Not done

- The full lane was **not** re-run after Items B and C. The ribbon-touching
  scenarios were (S36/S43/S44, green) and the gesture adds a key handler no
  scenario exercises, but a full lane before shipping remains the honest gate.
- The gesture has **no E2E scenario**. It was verified with a one-off driver, which
  is weaker than a pinned scenario and will not catch a regression.

## Carried forward

`reports/PARKED.md` now holds four items: hold-gesture *semantics* (superseded —
C shipped the ruled version), the pending-mutation guard, mod outcome-line routing,
and the ribbon segment count.

---

# STATE — close the gaps (2026-07-22)

From `005ffd9`. All committed and pushed; tree clean.

| item | hash | what |
|---|---|---|
| A | `71de524` | **the gate: lane green** — 990/3, both failures documented flakes cleared 2/2 in isolation |
| C | `b010de3` | attribute-budget guard — **and the correction that my ceiling diagnosis was wrong** |
| D | `5944320` | **coverage is fine**: S34 pins the bond shader; preambles named so the anchor trap cannot recur |
| B | `ab5bbe6` | S49 pins the hold gesture, 14/14 |

## Green
469 unit tests + typecheck at every commit; S49 14/14; S34+S43 42/42 after the
preamble change; full lane green at session start.

## The one decision I most want reviewed
**The attribute budget is the measured 14, not the driver's 16.** The brief assumed
the ceiling was the driver's; it is not, and a guard written that way would not have
fired. 14 is empirical on this driver — the message says so — but if it is wrong
elsewhere the guard either nags or misses. It is one constant.

## Not done
- **The full lane has not run since B, C and D landed.** S34/S43/S49 were run
  individually and are green, and C's guard is init-only — but that is reasoning
  about coverage, which is the exact thing this session showed failing. **Run the
  lane before shipping.**
- The status line the budget guard writes is immediately overwritten by the header
  line; `console.error` and the exposed result carry it. Cosmetic, unfixed.

---

# STATE — the lane, and sizing the ribbon chapter (2026-07-22)

From `f6e869c`. Committed and pushed; tree clean. **The lane ran before this was
written**, per the practice adopted this session.

| item | hash | what |
|---|---|---|
| A | `bad0c1e` | **lane green — 1000 checks, 0 assertion failures**; the lane-before-STATE practice recorded at the top of the ledger |
| B+C | (this commit) | `reports/RIBBON_SIZING.md` — both investigations, read-only, nothing built |

## The answer this session existed to produce

**Per-face normals: an afternoon.** A slot can be freed at no precision cost, and
that it converts into a usable one is measured, not assumed.

**Removing the faceting: a chapter — and not the one that was parked.** It is neither
the clamp (0.000% of junctions reach it; disabling it moves 0.2% of pixels) nor the
segment count (linear subdivision leaves the worst corner *exactly* unchanged). It is
whether the drawn backbone may stop being the supplied one. That is a ruling.

## The one thing I most want reviewed

**The parked lean was wrong and I had believed it.** "Subdivide in the producer —
still a linear copy, just of more vertices" is precisely the operation that does
nothing here, and it survived because the median turn angle improves to 0° under it
while the maximum does not move at all. Worth checking my reasoning in
`RIBBON_SIZING.md`, because retiring a plan is as consequential as adopting one.

## Not done, deliberately
Nothing was built. No subdivision, no per-face normals, no attribute merge — all
three are out of scope by the brief and the last two are attended decisions now that
they are priced.
