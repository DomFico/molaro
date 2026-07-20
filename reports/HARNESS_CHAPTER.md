# HARNESS CHAPTER — report (2026-07-19)

Make the suite trustworthy before the tool gets driven hard. Governing
rule honored: every change here preserves or STRENGTHENS what its check
proves. Where a fix sat near the rule's edge it is named as such below.

## The primitive chosen, and why

**IN-PAGE CAPTURE** (`E2EDriver.samplePatch`, tests/e2e_driver.ts). The
family defect is "a bounded envelope sampled through unbounded hops": a
pulse/flash/pose lives for a fixed window, and sampling it via
`captureB64` puts a CDP round-trip + compositor + PNG-encode INSIDE that
window — latency that grows with bundle size (the measured motive:
FLAKE_LEDGER bisect #3, HEAD 5/5 vs figure-tree 2/5, same window).

`samplePatch` does locate → read-pixels → classify (and, in sweep mode,
envelope-witnessing) inside ONE `Runtime.evaluate`, so the unbounded hops
sit AROUND the envelope, never inside it. It reads the live WebGL canvas
directly (`drawImage` into a 2d canvas) — available because the harness
already boots every page with `screenshotMode: true`
(→ `preserveDrawingBuffer`); zero product change.

**Envelope-hold was REJECTED** as the primitive: re-arming a product
pulse until sampled changes product behavior under test (invariant 2) and
subtly alters what is measured. It remains the logged fallback for any
probe in-page capture cannot reach — none was found this chapter.

The sweep's correctness rests on a CONSISTENCY invariant, not on tick
timing: the pulse uniform and the drawing buffer are written in the SAME
render task and both persist between renders, so every (strength, pixels)
pair the sweep reads describes one real frame. Two hazards found while
building it and fixed: (1) a 1s no-tick gap must CONTINUE the sweep (the
window clock is the sole bound); (2) `drawImage` off SwiftShader forces a
>1s GL readback stall, so reads are paid only for frames that can satisfy
the caller's strength gate (`sweep.minStrength`) — the sweep rides the
pulse's rise at full tick rate instead of stalling on every ascent.

## Per converted probe: evidence it can STILL FAIL

Deliberate break: the alpha term zeroed in BOTH overlay shaders (uniforms
keep rising, pixels never draw). Run twice.

- S32 overlay big / small / gone, and S32 flash: ALL red under the break
  with the designed signature "envelope live, pixels absent"
  (green@sphere=0 peak=1.00; yellow@sphere goes to base under the break).
- **A false-green was caught and killed by the break itself.** Under
  variant 1's flat depth a warm trace tube crosses the probe sphere's
  face, contributing a deterministic ~149 classifier hits of its own
  (evidence S32_v1_flash.png) — so "yellow present at crest" was
  satisfiable WITHOUT the flash, in the OLD probe too. Fixed by making
  the check DIFFERENTIAL: baseline the patch at the same pose with the
  flash faded, assert the crest ADDS >10 over it. Break rerun: red in
  BOTH variants, v1 reading yellow=149 base=149 (the confound measured
  and subtracted exactly).
- S28/S30/S45/S25/S23/S9/S1/S2 (surfaced across this chapter's own full
  lanes): each was observed RED under peak parallel load before
  conversion (S28 `[]`, S30 "no series"/"0→0", S45 crash, S25 marker 64
  vs 644, S23 deny-click miss, S9 flash=0) — load-real can-fail evidence,
  not synthetic. It took ten full-lane runs: the family surfaces one member per
  loaded run, so after S30's second appearance I ran a comprehensive scan
  that now finds ZERO fixed-sleep-then-touch-a-transient sites remaining.

The lanes surfaced the family one member at a time (the ledger's standing
prediction — the growing bundle squeezes the next-weakest fixed sleep),
so I swept the whole fixed-sleep-then-sample-a-relay-state footprint
across the plot/claude/marker scenarios rather than patch one per
20-minute lane. Every converted poll asserts the EXACT predicate its
check does (a narrower poll returns before the check's other conjuncts
hold — a bug I hit and corrected, so each poll now mirrors its full
check). The unifying root cause: each `typeInto(claude-input, …)` needs
the PREVIOUS turn ended (input re-enabled) or it fires into a disabled
input — the S24 lesson, now applied uniformly.

A SECOND, distinct class surfaced once sampling was fixed: **gesture
EFFECT** under CPU saturation. A synthetic right-drag pick can land on
nothing and fire no pulse (flashPoll honestly reports peak=0); a
focus/zoom tween can still be mid-flight when a fixed sleep samples it.
Two disciplines answer it — poll for the effect (`camMovedFrom`, direct
distance/framing polls in S3) and RETRY the gesture until its effect
appears (the S32 pattern, for the right-drag picks in S1/S9, idempotent
re-picks). This is why the pool kept surfacing one member per lane even
after the sampling sweep: gesture delivery is a separate surface from
gesture sampling.

Shader reverted after both break runs; dist rebuilt from clean source;
full lane byte-identical on the pixel pins.

## S32 tally at the loaded condition, before / after

- Before: rolling 35 isolated runs, 3 red (~8.6%, climbing with bundle
  size; tally corrected by the post-chapter review) — SAME tree/condition
  that gave 2/5.
- After (hardened primitive), same condition: **5/5 isolated runs green**,
  flash `attempts=1` every run, margins 900 vs base+10 (was >10 absolute
  through a race), sweep frames 46–80, witnessed peaks 0.62–1.00. Plus
  the full lane's own S32: 34/34.

## The flash-pulse cluster (S1, S2, S9) and a corrected call

A later lane failed S9's "manual pick pulses 2 points — flash=0": the
bounded ~900ms focus pulse read through a fixed sleep + one flashCount()
hop, missed when a gesture's CDP events land late under load. Swept every
positive `flashCount() === N` check (S9 ×9, S1 ×3, S2 ×1) to a shared
`flashPoll(d, pred)` module helper that polls the count in-page until the
predicate holds and reports the observed peak — the same assertion caught
anywhere in the window. This CORRECTS a call in an earlier draft of this
report: I had listed S1/S2 flash reads as "immediate-and-once, already
correct." They are not — they are sleep-then-read, and therefore family.
Flagging the reversal rather than quietly fixing it.

## Corrections from the post-chapter review (2026-07-20)

An adversarial multi-agent review of the five commits found and fixed:
one governing-rule violation (S3's two NEGATIVE checks lost their >=600ms
post-click window when the settle was deleted — restored); an
unsatisfiable wait predicate in S24 (the first turn HOLDS at the approval
gate, so its input-enabled conjunct burned the full timeout every run —
removed for that wait only); a missing `seen` field on S32's flash
initializer (a TypeError-instead-of-red on total starvation, and the one
`npm run typecheck` error in the repo — typecheck is now part of the
gate); poll predicates widened to mirror their full checks (S3 fit
distance, S23 approve/deny turn-end); catches added to the four remaining
bare in-scenario waitFors; the S24 scalar-size sleep the sweep missed;
the driver now recreates its deterministic chrome user-data-dirs fresh
per launch (kills the stale-SingletonLock cause at the root and caps /tmp
accumulation); and the doc corrections in this file. Also for the record:
commit 6687ce5's message omits S3 from its converted-scenario list — the
S3 conversions are part of that commit.

## Two calls at the rule's edge (named, not buried)

The governing rule forbids "extending a timeout to be safe." Two fixes
raise a synchronizer bound; I judge neither to weaken its assertion (the
`check` after re-asserts the full claim — a longer poll only lets a
genuinely-slow-under-load CORRECT result finish; a wrong result still
fails), but both sit close enough to the line to name:

- **S45**: the figure bind-line wait was an 8000ms OUTLIER against its
  identical-class siblings (series/scatter bind lines) at 15000, and with
  no catch a timeout CRASHED the scenario. Reconciled to the sibling
  value and made a timeout an assertable red, not a crash.
- **S30**: the plot-draw and marker polls (15000) time out under peak
  load because they are downstream of a REAL producer round-trip the
  hand-off already waits 30000 for. Raised to that same real-work class.

If you read either as weakening, they are the first two things to revert;
the underlying checks are unchanged and would simply go red sooner.

## Declined rather than weakened

- S7 sticky rows, S26 layout rects: sample PERSISTENT states behind
  settle sleeps — the risk is staleness, not envelope loss; the
  primitive's defect does not match, so converting would be motion
  without meaning.
- The flash-pulse NEGATIVES (f === 0, "hidden points don't glow"): kept
  as read-once-after-settle. Polling-until-zero would pass on the stable
  initial zero and defeat the "no pulse fires" intent — a poll is the
  wrong tool for a negative.
- Steady-state pixel pins (redCount/patchCounts via captureB64 +
  settle-frames): nothing bounded expires under them; form kept.

## The one flake that was NOT a fixed sleep (S30, ruled as scheduling)

S30 kept failing its plot-draw in the full pool even after 30s relay
polls — hand-off line present, but the plot never rendered ("no series").
It passes 8/8 alone. Diagnosis: S30 is the SOLE real-mdtraj scenario (a
3341-atom trajectory — the heaviest producer and the heaviest chrome,
streaming into the 3D viewer while also rendering the plot). The stub
plot scenarios (S25/S28/S45) render fine under identical width-6 load, so
the plot PATH is sound; this is CPU starvation of the heavy scenario, not
a product race — which is why it is a harness-scheduling fix and not a
"stop and report" product finding. Fix: the runner's existing EXCLUSIVE
mechanism (S30 runs alone after the pool — the slot S29 vacated). No
assertion changes; S30 runs in full. I considered and disfavored a
product plot-ready race precisely because the stub plot path survives the
same pool load.

## The S29 abort-path proof

S29 now copies the shipped mods into an mkdtemp directory and points the
bridge there via `E2E_MODS_DIR` — ONE const in bridge.ts is both its scan
and its unlink surface, so no code path in the whole run can name the
real `.molaro/mods`. The finally-restore is gone (nothing to restore); a
standing check asserts the real directory's per-file sha256 manifest is
byte-identical after the scenario.

ABORT PROOF, executed: a SIGKILL landed after the `rm all` `y` was
submitted (deletion in flight). Result — the leftover temp dir held 0 of
its 9 files (the deletion really ran; the finally never did), the real
`.molaro/mods` manifest byte-identical, `git status` clean. The old
snapshot-and-finally form protected only a clean exit; this protects an
abort structurally. S29 also LEAVES the runner's EXCLUSIVE set — and in
the same commit S30 takes the vacated slot for its own (scheduling)
reason, so the set was never empty in committed history.

## Rolling-baseline numbers

- S32: pre 32/3 red → post 6/0 red at the same loaded condition.
- Family conversions verified isolated green: S5 12/12, S23, S24 (after
  two real precondition races its sleeps had masked), S25, S27 (pixel
  pins 4/4), S28 16/16, S30 (real adk, marker 705→728), S45 17/17.
- Unit suite: 409/409. Full parallel lane: green (see
  reports/e2e_runner/harness_chapter_lane10.log — 956 checks, 0 failed,
  ALL PASS; note the lane logs are machine-local (reports/ is gitignored;
  this report and FLAKE_LEDGER.md are the tracked record)).

## Item 3 housekeeping

- S44 asymmetry comment: verified already committed (dbb193b) — the
  sphere-wins/ribbon-wins asymmetry is named, with "tighten this ratio
  first if a ribbon-side defect appears." No behavior change needed.
- HANDOFF_fable_assistant.md: resolved with `git rm` (its content remains
  at fadd704) — the tree ends genuinely clean, no standing deletion
  riding every commit.

## For the B-3 lane (queued next, not started here)

A prompt pass would need to teach that a produced channel, once it
exists, is bound through the SAME machinery as the fixture channels — no
new surface for the assistant beyond "a mod can now declare one." Noted
per that brief's §6; not acted on here.
