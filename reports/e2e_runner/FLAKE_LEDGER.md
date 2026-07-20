# FLAKE LEDGER — isolated-run tallies (record EVERY set, green or red)

Rule: docs/COMMAND_LAYER.md "Flake-triage rule". Denominator must grow on
every isolated set, not only on reds.

## S32 "focus flash registers — yellow@sphere=0" (probabilistic in isolation)
- pre-C2 era: 3 runs, 0 red (scratchpad-era logs)
- C-2 tree: 3 runs, 0 red (s32_iso_*)
- C-3 tree: 3 runs, 0 red (s32_c3_iso_*)
- O-1 tree: 3 runs, 1 red (s32_o1_iso_*) ← first isolated red → full bisect
- clean HEAD 1032622: 5 runs, 0 red (s32_head_*)
- O-1 tree, same window: 5 runs, 0 red (s32_o1b_*)
- **rolling: 22 runs, 1 red (~4.5%)**

## S23 "sentinel renders an error block" (scripted-stub sampling; 1st seen 2026-07-18)
- B-2 tree: 3 runs, 0 red (s23_b2_iso_*); in-lane red ×1 under load
- **rolling: 3 isolated runs, 0 red**

## S25 "the ⤷ line reports the draw" (fixed-sleep sampling; 1st seen 2026-07-19, figure tree)
- in-lane: 11-check cascade ×1 (whole draw sampled early under width-6 load)
- figure tree isolated: 5 runs, 0 red
- figure tree under 3-ballast load: 1 run, 1 red (the ⤷ sample only — the series DREW; sampling missed)
- clean HEAD under identical ballast: 1 run, 0 red (suggestive of bundle-size timing nudge; not proof — n=1 each)
- FIX (not characterization): the fixed sleeps became polls (waitFor the ⤷
  line, the S3/S45 precedent); hardened S25: standalone ALL PASS + under
  identical ballast 0 fails. S24's sibling fixed-sleep noted for the sweep.
- **rolling post-fix: 1 standalone + 1 under-load, 0 red**

## S9 "command flashes the mounted matching row" (fixed-sleep envelope; 1st seen 2026-07-19)
- in-lane (figure tree): 1 red ×1
- figure tree isolated: 5 runs, 3 red (60% — NOT ambient)
- clean HEAD isolated, same window: 5 runs, 1 red (pre-existing; the
  figure tree's larger bundle plausibly worsens the odds — n=5 each,
  directional not proof)
- ROOT CAUSE seen in the evidence: the check's own detail string once
  re-sampled 0 right after its condition sampled 100 — the 900ms envelope
  expired BETWEEN adjacent samples.
- FIX: sample the enveloped states IMMEDIATELY and ONCE after the command
  (the S3 rule). Post-fix: that check 7/7 green.
## S9 "bare view frames the visible scene" (fixed-sleep tween pose; surfaced by the above ×5)
- hardened-tree isolated: 1 red in 5 (dist sampled mid-tween; sleep(700))
- FIX: camSettled() poll (the scenario's own standing helper). Post-fix:
  3/3 green (both retrofits together).
- SYSTEMIC NOTE: third and fourth probe-family members surfaced this
  session (S25, S23 last week, S32 chronic) — the growing bundle squeezes
  every marginal fixed-sleep. THE SWEEP is the real fix and is queued
  next-session #2.

## S30 "the plot draws the Rg curve" (fixed 2500ms on a REAL producer round-trip; 1st seen 2026-07-19)
- in-lane (figure tree, lane 3): 2-check red ×1
- isolated: 3 runs, 0 red → family pattern
- FIX: poll for the async hand-off line (30s bound — real python compute).
  Post-fix: 3/3 green.

## S32 — bisect #3 + tally update (2026-07-19, figure tree)
- in-lane (lane 3): 1 red, chronic signature (yellow@sphere=0; ~9th)
- figure tree isolated: 5 runs, 2 red (identical signature both)
- clean HEAD, same window: 5 runs, 0 red (bisect #3 — trees NOT identical
  this time; with bisect #2's 5/5≡5/5 and S9's 3/5-vs-1/5, the picture is
  now consistently: the race is real on both trees and LARGER BUNDLES
  WORSEN THE ODDS. n stays small; direction is no longer ambiguous.)
- **rolling: 32 isolated runs, 3 red (~9% and climbing with bundle size)**
- CONSEQUENCE: the hold-the-envelope retrofit is no longer next-session
  hygiene — it is the FIRST item, before any further bundle growth.

## HARNESS CHAPTER (2026-07-19) — the family retrofit: in-page capture

RULING #1 EXECUTED. Item 1 built THE probe primitive as IN-PAGE CAPTURE:
`E2EDriver.samplePatch` (e2e_driver.ts) — locate → read-pixels → classify
(plus, in sweep mode, envelope-witnessing) runs inside ONE
Runtime.evaluate, so the unbounded CDP/compositor/encode hops sit AROUND
the bounded envelope instead of inside it. Envelope-hold was REJECTED as
the primitive (re-arming a pulse until sampled changes product behavior
under test); it stays the logged fallback for any probe in-page capture
cannot reach — none found this chapter.

Correctness rests on a consistency invariant, not timing: pulse uniforms
and the drawing buffer are written in the SAME render task and both
persist between renders (preserveDrawingBuffer via the harness's standing
screenshotMode boot flag), so every (strength, pixels) pair the sweep
reads is mutually consistent. Two primitive-level hazards found and fixed
while proving: (1) a 1s no-tick gap must CONTINUE the sweep, not end it —
the window clock is the sole bound; (2) drawImage from the SwiftShader
canvas forces a >1s GL readback stall, so reads are paid only for frames
that could satisfy the caller's strength gate (sweep.minStrength).

### Deliberate-break proof (can-still-fail, run twice, then reverted)
Break: the alpha term zeroed in BOTH overlay shaders (highlight + focus
flash) — uniforms keep rising, pixels never draw. All converted probes
red with the designed signature "envelope live, pixels absent"
(green@sphere=0 peak=1.00). FINDING — a FALSE GREEN KILLED: the break
exposed a pre-existing specificity gap in the flash check's variant-1
arm. A warm trace tube crosses the probe sphere's face under flat depth
and contributes a deterministic 149 classifier hits of its own (evidence
S32_v1_flash.png), so "yellow present at crest" was satisfiable WITHOUT
the flash — in the OLD probe too. Fixed by making the check DIFFERENTIAL:
baseline the patch at the same pose with the flash fully faded; assert
the crest ADDS >10 over it. Break rerun: red in BOTH variants — v1 reads
yellow@sphere=149 base=149 (the confound measured and subtracted
exactly). Shader reverted, dist rebuilt from clean source.

### Conversions (assertions preserved or strengthened, none weakened)
- S32 overlay big/small/gone: 6-phase captureB64 max → peak-witnessing
  sweep; NEW strength gates (>0.6) on all three including the ZERO
  assertion (zero at the witnessed peak dominates max-over-phases).
- S32 flash: confirm-then-capture race → sweep at the crest +
  differential baseline + peakFlash>0.5 gate on the counted frame.
- S27 pixel tail: CDP projection + sleep + screenshot while PLAYING (the
  moving-pose flavor) → samplePatch single mode, per-read re-projection,
  all 4 pixels of a 2×2 patch must classify (was 1 center pixel).
- S5 flash pair: fixed sleeps → in-page swell watch + poll-to-zero fade.
- S23 sentinel: fixed 250ms → poll for the persistent error block.
- S24 ⤷ lines (the ledgered S25 sibling): four fixed sleeps → polls; the
  conversion exposed two REAL precondition races the sleeps had masked
  (the approve button renders after the first ⤷ line; typeInto needs the
  turn ENDED, i.e. input re-enabled) — both now polled explicitly.
MORE surfaced by the chapter's OWN full-lane runs (peak parallel load —
the retrofit made the lane run S29 in-pool too, raising contention; each
successive lane squeezed the next-weakest fixed-sleep, exactly the ledger's
standing prediction). Rather than one-per-20min-lane whack-a-mole, swept
the whole fixed-sleep-then-sample-a-relay-state footprint across the
plot/claude/marker scenarios (S24, S25, S27 part 2, S28, S30, S45). All
converted, none weakened; each poll asserts the EXACT predicate its check
does (a narrower poll would return before the check's other conjuncts
held — a bug I hit and fixed, so every poll now mirrors its full check).
- S28 (scatter): fixed sleeps before bind lines, scatter draws, highlight
  moves, click-seeks → polls. Isolated 17/17.
- S25/S30 (marker relay): seek → frameChanged → plotFrame → marker was
  sampled once across a fixed sleep; now polled for the marker to REACH
  the target position. STRENGTHENED: S30's live-marker check proves a
  second DISTINCT position (705→728 px, not "0→0"), S25 lands the exact px.
- S27 part 2 / S28 python mods: fixed 2500ms on a REAL producer round-trip
  → poll the hand-off line + the plot draw (the S30 rg rule).
- S45 (figure): an 8000ms OUTLIER bind-line wait (sibling class uses
  15000) with NO catch → a timeout CRASHED the scenario (0/0 checks).
  JUDGMENT CALL AT THE RULE'S EDGE, logged: matched the bound to its
  proven sibling (an under-specified outlier reconciled, not "widen to
  be safe") AND added catch-fall-through so a slow load yields an
  assertable red with detail, never a crash. Plus the marker/relay/swap
  sleeps → full-predicate polls. Isolated 18/18.
- THE UNIFYING ROOT CAUSE (worth recording): in the claude scenarios,
  each `typeInto(claude-input, …)` needs the PREVIOUS turn ENDED (input
  re-enabled) or it types into a disabled input and never fires — the
  S24 lesson. A poll for a bind LINE returns before the turn ends, so
  every claude-input poll that precedes a NEXT typeInto now also requires
  `!claude-input.disabled`. Two isolated regressions during the sweep
  traced to exactly this; the fix is uniform.
- THE GESTURE-EFFECT family (S1, S2, S3, S9 — a distinct class from
  sampling): under CPU saturation a synthetic gesture's EFFECT can fail
  to register — a right-drag pick that fires NO pulse (flashPoll peak=0,
  an honest zero, not a sampling miss), or a focus/zoom TWEEN that hasn't
  reached its target when a fixed sleep samples it. Two disciplines: (a)
  poll for the EFFECT not the clock — `camMovedFrom(d, from)` for "the
  camera moved", direct distance/framing polls for zoom-in/out/fit (S3);
  (b) RETRY the gesture until its effect appears (bounded, the S32
  re-trigger pattern) for the right-drag picks (S1, S9 ×3) whose single
  synthetic drag can land on nothing. Re-picking the same rows is
  idempotent for focus, so retries are safe. Camera NEGATIVES ("focus
  does NOT move while editing") keep a fixed settle — a poll is the wrong
  tool for a negative. This class is why the width-6 pool kept surfacing
  one member per lane: the sampling was fixed, but gesture DELIVERY under
  saturation is a separate surface.
- S30 POOL STARVATION (the residual, ruled): even with 30s relay polls,
  S30 keeps failing its plot-draw IN THE POOL (hand-off line present, but
  "no series" — the plot never renders) while passing 8/8 ALONE. It is
  the SOLE real-mdtraj scenario: a 3341-atom adk trajectory, the heaviest
  producer AND heaviest chrome (3D stream + plot render together). The
  stub plot scenarios (S25/S28/S45) render fine under identical width-6
  load, so the plot PATH is sound — this is CPU starvation of the heavy
  scenario, not a product race. Fix = the runner's existing EXCLUSIVE
  mechanism (S30 runs ALONE after the pool, the slot S29 just vacated).
  No assertion touched; S30 runs in full. The 30s relay polls stay (they
  are correct for the real-work class regardless).
- S23 GATE BUTTONS + S30 real-producer relay (a later lane): S23 lost the
  race clicking a transient gate button (.cl-deny) after a fixed
  sleep(700) — the gate is reached on the stub's own cadence. Converted
  every S23 gate interaction (approve/deny/cancel + their result relays)
  to poll for the button/result before acting. S30 (real mdtraj, the
  slowest scenario, chronically load-flaky — same failure in the
  pre-conversion baseline) timed out its 15s plot-draw poll under peak
  load: the plot render is downstream of the SAME real-producer pipeline
  the hand-off waits 30s for, so raised the plot-draw + marker polls to
  that real-work class (30s) and converted rmsf's fixed 2000ms + the undo
  settle to polls. Bound-raise logged as matching the operation class,
  not blanket widening: the assertion is unchanged, the poll only lets a
  genuinely-slow-under-load correct render finish. A comprehensive scan
  afterward found ZERO remaining fixed-sleep-then-touch-a-transient sites
  across the claude/plot scenarios — the family is fully converted.
- THE FLASH-PULSE cluster (S1, S2, S9): a later lane failed S9's "manual
  pick pulses 2 points — flash=0" — a bounded ~900ms pulse read through a
  fixed sleep(150) + one flashCount() hop, missed when the gesture's CDP
  events arrive late under load. Swept ALL positive flashCount()===N
  checks (S9 ×9, S1 ×3, S2 ×1) to a shared module helper `flashPoll(d,
  pred)` that polls the count IN-PAGE until it satisfies the predicate,
  returning the observed peak for the detail — the same assertion caught
  anywhere in the window. The pulse jumps straight to its value and holds
  (never transits an intermediate count), so an exact-count poll is
  sound. NEGATIVES (f === 0, "hidden points don't glow") deliberately
  KEPT as read-once-after-settle — polling-until-zero would pass on the
  stable initial zero and defeat the "no pulse fires" intent. This
  corrects an earlier mischaracterization in this ledger: S1/S2 were
  called "immediate-and-once" but are in fact sleep-then-read, hence
  family. (S1's sleep(600) stays for the CAMERA tween; flashPoll keeps
  watching past it.)
- S32 startup INFRA flake (not a probe red): a lane saw S32 fail 0/0 with
  "chrome CDP did not come up" at peak pool load (chrome cold-start beyond
  the driver poll) — and a separate lane died at launch because a cleanup
  `pkill -f "…headless…"` SIGTERMs ITS OWN command line (exit 144). Both
  are harness-operational, distinct from the probe family; kill stray
  chromes by PID, clear stale /tmp/cdp-* dirs, re-run.
DECLINED, with reasons (not weakened): S7 sticky rows and S26 layout
rects sample PERSISTENT states behind settle sleeps — staleness risk,
not envelope loss; the defect doesn't match. S1/S2/S10 flashCount reads
are one-hop immediate-and-once (the S3 rule) and stay. Steady-state
pixel pins (redCount/patchCounts through captureB64 + settle-frames)
keep their form: nothing bounded expires under them.

### Tallies (every run, green or red — denominator grows on all)
- pre-retrofit rolling: 32 isolated runs, 3 red (~9%), bundle-coupled.
- post-retrofit S32 isolated, SAME tree/condition that gave 2/5 red:
  run 0 (pre-hardening primitive) green; hardened runs 1–5: 5/5 green,
  flash attempts=1 every run, margins 900 vs base+10 (was >10 absolute
  through a race), sweep frames 46–80, witnessed peaks 0.62–1.00.
- deliberate-break runs: 2 runs, red both (5 and 7 FAILURES) — by design.
- post-revert singles: S5 13/13, S23 all green, S24 ALL PASS (after the
  two precondition polls), S27 all green (pixel pins 4/4 both).
- **rolling post-retrofit: 6 isolated S32 runs, 0 red**

## HARNESS CHAPTER item 2 — S29 structural data-loss fix (same session)
S29 now copies the shipped mods into mkdtemp and points the bridge there
via E2E_MODS_DIR — ONE const in bridge.ts covers both the scan and the
unlink surface, so no code path in the whole run can name the real
.molaro/mods. The finally-restore is gone because there is nothing to
restore; a standing check asserts the real directory's sha256 manifest is
byte-identical after the scenario. ABORT PROOF (executed, logged):
SIGKILL landed after the rm-all `y` — the leftover temp dir held 0 of
its 9 files (the deletion really ran; the finally never did), the real
directory byte-identical, git-clean. S29 leaves the runner's EXCLUSIVE
set: the reason for exclusivity no longer exists.

## RULED (2026-07-19, owner) — the S32 reclassification and the order it dictates
S32 is not a bad probe: it is a probe whose margin SHRINKS AS THE PRODUCT
GROWS (bisect #3: HEAD 5/5 vs figure tree 2/5, same window; four new
family flakes in one session; ~9% and climbing). The triage tax scales
with the thing being built. Therefore, MEASURED-URGENT, not preference:
1. hold-the-envelope retrofit FIRST next session, before ANY bundle
   growth — and if the mechanism generalizes, apply it ACROSS THE FAMILY
   (S32's pixel probes, the flash/pose/hand-off samples), not one at a
   time;
2. then the PROMPT PASS: six shipped capabilities are invisible to the
   assistant (bake/bind/unbind/bindings + style* + shape + figure) — the
   prompt teaches all six surfaces and points at the figure TEMPLATE
   (.molaro/mods/figure_metric.py), not the schema;
3. then B-3, the mod→channel pipe (P-7's in-band-announce lean).
