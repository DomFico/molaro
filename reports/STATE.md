# STATE — overnight run

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
