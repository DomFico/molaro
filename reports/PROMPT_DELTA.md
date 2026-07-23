# PROMPT DELTA — a running accumulator for the next prompt pass

**Standing practice (adopt from now):** any increment that adds a USER-FACING
surface appends an entry here **in the same commit**. The next prompt pass is then
a merge of this file, not archaeology. This is the process fix for a gap that has
reopened six-plus times — the prompt drifting behind the shipped surfaces.

**The pattern that works (keep using it):** teach the SHAPE by pointing at a
template or worked example the model can be told to imitate — NOT by restating a
schema the model then reconstructs from memory and gets wrong. Inline the exact
return/invocation shape where a template can't be opened. (This is what fixed the
figure and channel prompt entries.)

The prompt itself is an ATTENDED artifact — this file only accumulates the delta.

---

## Since the last prompt pass

### `data.trajectory` is LAZY after streaming (Phase 2c / incr 50, prompt fix `d225c11`)
> **STATUS: CONSUMED 2026-07-23** — folded directly (not deferred): `claudeprompt.ts`
> line ~53 no longer says `data.trajectory` is "already loaded in memory".
- **What changed under the prompt:** Phase 2 streams seekable trajectories; `data.trajectory`
  is now materialized on FIRST access (full `md.load` + center, cached), not eagerly at
  construction. The old wording ("already loaded in memory") was a truthfulness drift.
- **Teach (done):** it is the real, full trajectory, materialized on first access; for a long
  trajectory loading every frame is a real one-time cost, so reach for it only when you need
  the coordinates. The `if data.trajectory is None:` fail-closed guidance is unchanged.
- **No API alternative for mods** — a mod that needs coordinates has only `data.trajectory`,
  so this is a cost note, not a "prefer X instead" redirect. Kept to one clause.

### `smooth` / `delay` — offset-axis temporal-position mods (commits a46165a, 00b0301)
> **STATUS: CONSUMED 2026-07-23** — now in claudeprompt.ts (the "## Moving positions over
> time — the `offset` axis" section: the mechanism `shown = raw + offset`, `smooth`/`delay`,
> and the produces:channel + requires-channel-macro authoring PAIR pointing at
> `.molaro/mods/{smoothing,smooth,delay_offset,delay}.py`; `offset` added to the bake/bind
> axes as a bind-only vector axis; a `bind all smoothing offset` worked example added to
> GRAMMAR_EXAMPLES). Guarded by claudebackend/prompt_examples tests. Do not re-teach.
- **Teach:** two commands mods on the NEW `offset` position axis (a bound `per_point_per_frame`
  3-vector channel displaces the drawn positions: `shown = raw + offset`). `smooth <region>
  ?window=N` smooths a region's motion (windowed average of positions over ±N frames; N is the
  level; `window=0` = off). `delay <region> ?frames=k` shows each point at its position from k
  frames earlier. Both bind a computed offset channel to the `offset` axis; both are undoable
  (one Ctrl+Z), per-region, re-runnable. **DISTINCT from a color/scalar mod** — these move
  POSITIONS, not appearance.
- **The pattern to teach for authoring MORE of these:** any position-valued temporal effect `T`
  is a mod producing a whole-system `per_point_per_frame` vector channel `offset = T(pos) − pos`
  (zero outside the target), bound to `offset`. So a new effect (predict, exaggerate, jitter…)
  is ONE `produces: channel` mod + a one-line `produces: commands` macro (`# requires-channel:`
  + `bind all <channel> offset`). **`bind all` is correct** because the channel is zero outside
  the region (and it avoids emitting a giant `#index` string — a commands mod only gets
  `target_indices`).
- **Point at:** `.molaro/mods/{smoothing,smooth,delay_offset,delay}.py`. **Gotchas to teach
  authors:** vectorize (cumsum / gather, NO per-frame Python loop → 5s `run_mod` timeout); the
  channel is WHOLE-SYSTEM (full `n_frames·n_points·3`, zero outside target — do NOT shrink it to
  the selection); a `# requires-channel:` consumer's params now forward to its provider for
  shared names (so `?window=`/`?frames=` reach the computation).

### `background <color>` — the scene background (commit 8fa3ce1)
> **STATUS: CONSUMED 2026-07-23** — now in claudeprompt.ts as a "Targetless scene commands"
> paragraph in the grammar reference (literal color, exactly one token, quiet error on a bare
> or extra token, and the explicit contrast with the per-point-scalar red→magenta colormap).
> TARGETLESS decision made: taught in PROSE with an inline example, kept OUT of
> GRAMMAR_EXAMPLES (whose invariant is every-target-resolves) — guarded by a new
> prompt_examples test asserting no targetless command sneaks into the resolved list. Do not
> re-teach.
- **Teach:** `background <color>` sets the viewer's scene background to a literal color —
  a CSS name (`background steelblue`) or hex (`background #101820`). It is **targetless**
  (exactly one color token, no address) — unlike the point/edge/trace color verbs, it
  styles the whole scene, so it takes no target; a bare `background` or a second token is a
  quiet error. It is a `run_command` **manipulation** (grammar), not a mod, and undoes in
  one Ctrl+Z. Because it takes a **literal** color token (the same `parseColor` the color
  verbs use), the assistant **can** pick a specific named color here — this is NOT the
  per-point-scalar colormap (that remains the single red→magenta ramp); the two must not be
  conflated in the prompt.
- **Point at:** the worked example `background #101820` (or a named color). **Nuance for the
  attended pass:** `prompt_examples.test.ts` resolves every `GRAMMAR_EXAMPLES` entry against
  the address resolver — a targetless command has no address to resolve, so either the
  example harness needs a targetless case or `background` is taught in prose with an inline
  example rather than added to the resolved-examples list. Decide at the attended pass.

### Mod parameters (P-1, commit 78836ee)
> **STATUS: CONSUMED 2026-07-23** — already in claudeprompt.ts (the "## Parameters — one mod,
> reused with different settings" section: `# param:` header, required vs defaulted, the third
> `compute(data, target_indices, params)` arg, and "get_context lists each mod's parameters …
> read them there, never guess"). write_mod's `params` field is guarded by claudebackend
> tests. Confirmed present this pass; do not re-teach.
- **Teach:** a mod may declare parameters in its header, `# param: <name> <type>
  [<default>]` (type ∈ number | string | boolean). Invoke with
  `<mod> <target> ?key=value ?key2=value2` — the separator is a reserved `?`
  sigil (NOT `=`, which can appear in a legal target); values may hold spaces.
  A parameter with a default is optional; one without is required. `compute` then
  takes a third arg: `compute(data, target_indices, params)` and reads
  `params["name"]`. `get_context` lists each mod's params/types/defaults — read
  them there, never guess. The approval preview shows the EFFECTIVE values
  (defaults filled), so the human approves what runs.
- **Point at, don't restate:** the shipped `param_scale.py` (a numeric `gamma`
  ramp) and now `figure_metric.py` (`dpi`+`bins`) / `xy_metric.py` (`x_label`+
  `y_label`) as worked examples of number and string params.
- **The load-bearing gotcha to teach authors:** use `def compute(data,
  target_indices, params=None)` and read `params or {}` — a mod that is also run
  on the raw producer path (a direct `run_mod`, no webview default-filling) breaks
  otherwise. This is the pattern the reference mods now follow.

### Static channel name (P-2, commit 9ef9c42)
> **STATUS: CONSUMED 2026-07-23** — already in claudeprompt.ts (channel section: name declared
> in the header `# channel: <name>`, return carries data only — no `name` in the return,
> guarded by the `doesNotMatch(/"name": "<channel name>"/)` assertion). Confirmed present this
> pass; do not re-teach.
- **Teach:** a `produces: channel` mod declares its channel NAME in the header,
  `# channel: <name>` (a single token). The return carries ONLY data
  `{values, components, min?, max?}` — do NOT put a `name` in the return (it is
  refused). `get_context` advertises which mods declare which channels.
- **Point at:** the updated `channel_flow.py` (header declares `flow_dir`, return
  is name-free).

### requires-channel sequencing (P-3, commit cf13b91)
> **STATUS: CONSUMED 2026-07-23** — already in claudeprompt.ts (the "## Requiring a channel —
> one invocation instead of two" section: `# requires-channel:`, provider runs first, ONE
> LEVEL only, and the honest "sequencing is not atomicity" limit). Reinforced this pass by the
> offset-axis authoring pattern, which uses a requires-channel macro. Do not re-teach.
- **Teach:** a mod may declare `# requires-channel: <name>`; on invocation its
  provider (the `# channel:` mod) runs FIRST — one invocation instead of two.
  ONE LEVEL only (a missing/ambiguous/deeper provider is refused, naming the
  channel). **The honest limit to teach:** sequencing is NOT atomicity — if the
  provider runs and the consumer fails, the channel stays declared (append-only,
  not undoable). `get_context` shows which mods require which channels.
- **Point at:** the shipped `setup_flow.py` (requires `flow_dir`, then binds it).

### write_mod authoring fields (P-1/P-2/P-3)
> **STATUS: CONSUMED 2026-07-23** — a TOOL-SCHEMA capability, not prompt prose: `write_mod`'s
> `params`/`channel`/`requiresChannel` fields and their approval-preview naming are guarded by
> claudebackend tests ("write_mod can author a PARAMETERIZED mod", "P-2 … names the declared
> channel"). The prompt teaches the header lines the assistant declares (`# param:`,
> `# channel:`, `# requires-channel:`); write_mod carries them. Do not re-teach.
- **Teach:** `write_mod` gained `params`, `channel`, and `requiresChannel` fields
  so the assistant can author parameterized / channel / requiring mods. The
  approval preview names the declared channel and required channel; a malformed
  one is re-parsed and reported precisely, not "not loaded".

### Figure resolution (Item C, commit c3651c8; extraction parked)
> **STATUS: CONSUMED 2026-07-23 (the dpi knob) — the SAVE/extraction half remains PARKED.**
> claudeprompt.ts's figure section now states a `figure` mod can declare a `dpi` parameter and
> to lower it if a run is refused as too large (the size cap); the generic Parameters section +
> get_context's advertised `figure_metric [params: dpi…]` do the rest (cold R5 confirmed it
> lands). NOT folded: how to SAVE a figure to disk — still parked (reports/PARKED.md Item C).
- **Teach (once the extraction fork resolves):** `figure_metric` takes `dpi`
  (default 100) — pass `?dpi=200` for higher resolution. The figure has a 2 MiB
  size cap; if exceeded the refusal says to lower the dpi (now a real knob).
- **Not yet teachable:** how to SAVE the figure to disk — parked (see
  reports/PARKED.md Item C); revisit when the extraction path is decided.

### Vector channels should be returned as UNIT vectors (found in real use, 2026-07-21)
> **STATUS: CONSUMED 2026-07-23** — folded into the channel section's coherence paragraph: "a
> direction channel … should be returned as UNIT vectors — the renderer normalizes anyway, and
> the producer's coherence check dots adjacent frames RAW, so a short vector (mdtraj's native
> nm, e.g. a ~0.12 nm C=O) trips a false 'hard swing' on magnitude alone", kept alongside the
> already-present sign-flip / seed-from-previous-frame guidance. Scoped to DIRECTION channels
> (offset/displacement channels are legitimately non-unit). Guarded by a claudebackend test.
> Do not re-teach.

- **Teach (where the vector-channel return shape is taught):** normalize a
  direction channel before returning it. The producer's frame-to-frame coherence
  check compares adjacent frames with a **raw dot product** — `< 0` is reported as a
  sign inversion, `< 0.5` as a hard swing (`producer/serve.py:91-95`). Those
  thresholds assume unit-ish vectors. A carbonyl C=O vector in mdtraj's native nm is
  ~0.123 long, so two frames that agree *perfectly* dot to ~0.015 and trip the swing
  threshold on magnitude alone: authoring `ribbon_dir` against real adk produced
  `176699 hard swing(s)` covering literally every adjacent-frame pair, which makes
  the warning unable to distinguish a stable ribbon from a strobing one. Normalizing
  is free — the renderer normalizes anyway — and turns the dot into a true cosine.
  Same run: 176699 swings -> 88.
- **Teach alongside it — how to hold a direction's sign steady across frames.** The
  intuitive method is wrong in a way that looks right: re-walking the chain each
  frame (flipping residue i against residue i-1, seeded at the chain head from the
  previous frame) makes each sign decision depend on a *neighbour in that frame*, so
  wherever two neighbours are near perpendicular the decision is a coin flip that
  thermal motion re-rolls, and one flipped decision inverts the whole rest of the
  chain. Measured on adk: sign inversions on **45%** of adjacent-frame pairs
  (147378 / 324077). The fix is to resolve each element against **its own previous
  frame** — local, independent decisions — using the along-chain walk only on frame
  0 to establish the convention once. Same run: 147378 inversions -> **0**.
- **Point at:** the workspace mod `.molaro/mods/ribbon_dir.py`, which documents both
  traps at the point of composition.

### A channel is WHOLE-SYSTEM — `target_indices` does not shrink it (found in real use, 2026-07-21)
> **STATUS: CONSUMED 2026-07-23** — folded into the channel section as an explicit paragraph
> ("A channel spans the WHOLE SYSTEM, not the target … the ONE place Rule 6 does NOT mean
> 'shrink the output'; where it applies is decided by the bind/bake target; use target_indices
> only to choose what to compute, filling the rest with a neutral value; a partial channel is
> refused and would be wrong even if allowed — a scene-level shape swap reads every element").
> Distinct from the per-residue BROADCAST trap (already in the prompt). Guarded by a
> claudebackend test. Do not re-teach.

- **The conflict to resolve in the prompt, not leave to inference.** Rule #6 tells a
  mod author to respect `target_indices`. The channel length check requires
  `n_frames * n_points * components` over **every point in the system**. Those two
  rules point opposite ways for a `produces: channel` mod, and the author who obeys
  Rule #6 gets refused: running the hand-written `ribbon_dir` on a 296-point
  selection returned `98*296*3 = 87024` where `98*3341*3 = 982254` was required.
  Note this is a DIFFERENT refusal from the per-residue one the cold test found —
  same error message, wrong axis. Teach the distinction: a channel is a **column of
  data over the whole system**; *where it applies* is decided later by the `bind`
  target, not by the mod. So a channel mod emits full length and may use
  `target_indices` only to choose what to spend effort computing (filling the rest
  with a neutral value).
- **The second-order reason, worth one line:** shape swaps are scene-level. If an
  orientation channel existed only over the selection, `shape traces ribbon` would
  still turn EVERY trace into a ribbon, and the unselected ones would have a zero
  facing vector and collapse out of sight. A partial channel is not just refused —
  it would be wrong if it were allowed.
- **Point at:** `.molaro/mods/ribbon_dir.py`, which now documents this at the return.

### A per-point-scalar's ramp is normalized over the TARGET — so `all` spends the range on solvent (found in real use, 2026-07-21)
> **STATUS: CONSUMED 2026-07-23** — folded into the per-point-scalar section as the general
> rule at the point the target is chosen: "The [0,1] ramp is min-maxed over whatever was
> TARGETED … when the request is about the MOLECULE, target the molecule (polymer, a chain, a
> residue range), NOT `all` … on a solvated box any per-atom quantity over `all` spends its
> whole range on the most extreme component — almost always the water — and the molecule comes
> out uniformly flat, silently … (Rule 3's selection-driven RMSD is the superposition case of
> this same rule)". rmsf.py's own description already carries it (the A/B-verified seat).
> Guarded by claudebackend tests. Do not re-teach.

- **THE GENERAL RULE, and it is not about RMSF.** A `per-point-scalar` mod returns
  values in `[0,1]`, min-maxed **over whatever was targeted** — that is the CONTRACT,
  not any one mod's choice. So *any* colour-by-computed-quantity invoked with
  `target: all` on a solvated box spends its entire dynamic range on whichever
  component holds the extremes, and in a water box that is almost always the water.
  Displacement, velocity, exposure, fluctuation, anything: **the molecule comes out
  flat, every time, silently, with no error.** The existing "RMSD is selection-driven
  — superpose on the same atom set you measure" rule is a SPECIAL CASE of this, not
  the general statement.
- **The rule to state:** when the request is about the MOLECULE — how it moves, how
  exposed it is, how anything varies across it — target the molecule (`polymer`, a
  chain, a residue range), not `all`. `all` is right only when the whole system IS
  the molecule.
- **RMSF is the worked example, because two things fail there at once** and the
  measurement separates them:
  - **Normalization swamping (the visible failure, and the one nobody names).** The
    `[0,1]` ramp is min-maxed over whatever is targeted. Water is the most mobile
    thing in the box, so on the corpus trp cage — 304 protein atoms among 4810 —
    `rmsf all` maps every protein atom into **0.000–0.106**. The user asked to see
    floppiness and gets a uniformly flat protein.
  - **Superposition contamination.** `md.rmsf` superposes over the set it is handed,
    so `all` fits on 4506 waters and measures the protein against a solvent-dominated
    frame: **Spearman 0.87** against the solute-targeted answer, not 1.00.
- **Why this was never caught:** every cold-acceptance run to date used adk, which is
  100% polymer with no solvent and no unit cell. There `rmsf all` and
  `rmsf <protein>` agree to **0.0000** — the defect is structurally invisible. R6
  ("color the atoms by how floppy they are") reached for `run_mod{rmsf, target: all}`
  2/2 and was scored a pass. On a solvated system that same choice is wrong.
- **Point at:** `.molaro/mods/rmsf.py`, whose description and header now state this
  where a mod author or the assistant will read it.
- **MEASURED, not merely reasoned.** Cold A/B on the solvated trp cage, one variable:
  with the pre-edit description the assistant chose `target: all` **3/3**; with the
  description stating the rule it chose `target: polymer` **3/3**. So the trap is
  real AND a description-level correction defeats it. That is evidence the prompt
  rule will land too — and evidence for the general technique: put the correction
  where the CHOICE is made (the advertised description), not where the failure
  shows up.
- **Suite gap this exposes, worth fixing separately:** an entire defect class —
  solvent, periodic boundaries, multi-molecule fitting — cannot appear in an
  adk-only acceptance suite. One solvated system (trp cage) covers it.

_(The ribbon bend miter, Item B, is a renderer change — no prompt surface.)_

---

## From the cold acceptance test (reports/ACCEPTANCE_COLD.md, 2026-07-21)

> **STATUS: CONSUMED 2026-07-21** — all four items below were acted on in the
> attended prompt pass (commit below). Items 1–3 are now IN `claudeprompt.ts` and
> guarded in `tests/claudebackend.test.ts` Part C; item 4 was a no-change finding.
> Re-tested cold, 6 sessions, real producer: R3's per-residue defect 0/2 (was 4/4),
> R1/R2 no regression. **Do not re-teach these.** Kept for provenance only.

Eight cold sessions (3 requests, no hints). R1 (commands) and R2 (channel+bind)
passed 2/2 and R2's mods were ACCEPTED by the real producer on real adk. R3 (the
full cartoon path) reached the right rung 3/4 but its first mod was refused every
time. What the prompt would need, in priority order:

1. **A per-point granularity warning for channel mods — the top finding.** Every
   mod-writing R3 run produced a per-RESIDUE array (214) for a per-POINT channel
   (3341 atoms) and was refused: `values must be a flat frame-major list of length
   n_frames*n_points*components (98*3341*3 = 982254), got 62916`. The length
   formula IS already in the prompt and did not prevent it — the domain framing
   ("backbone direction") invites a per-residue answer. Teach the BROADCAST where
   the channel return shape is taught: *a channel is per-POINT; a quantity that is
   naturally per-residue/per-chain must be broadcast to every atom of it.* Point at
   the corrected shape (each atom inherits its residue's vector), not the formula.
2. **Connect the user-word "cartoon" to the ribbon shape.** One run in four
   approximated a cartoon by fattening and colouring the TUBE trace and never
   reached for `ribbon`, though get_context's Shapes section lists it. Name the
   mapping in the ladder: a cartoon/ribbon backbone is `shape traces ribbon`, which
   needs a vector channel bound to `orientation` FIRST.
3. **Soften "call get_context before anything" to "re-read it when you need
   CURRENT state."** It is correctly skipped when the boot context already answers
   the question (R1, 2/2), so the absolute phrasing is routinely not followed; what
   matters is re-reading after something has been declared.
4. **Parameters need no change — and are now VERIFIED reachable.** None of R1–R4
   implied a tunable, so they went unexercised. R5 ("Give me that two-panel figure
   at print resolution", 2/2) is the direct probe and passes: it read the advertised
   `figure_metric [params: dpi:number=100, bins:number=24]`, reached for the
   EXISTING mod rather than writing one, and mapped "print resolution" onto
   `parameters: {dpi: 300}` without being told the parameter's name. The P-1
   teaching works when a request actually needs it.

What already lands and should NOT be disturbed: the inline channel return shape
(P-2 `{values, components}`, no `name` — correct in every mod), the frame-to-frame
coherence pattern (present in every vector channel mod), the float64 and
`trajectory is None` correctness rules, `bind` vs `bake` for motion, and the
dependency order (bind orientation before the ribbon swap).
