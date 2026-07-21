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

### Mod parameters (P-1, commit 78836ee)
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
- **Teach:** a `produces: channel` mod declares its channel NAME in the header,
  `# channel: <name>` (a single token). The return carries ONLY data
  `{values, components, min?, max?}` — do NOT put a `name` in the return (it is
  refused). `get_context` advertises which mods declare which channels.
- **Point at:** the updated `channel_flow.py` (header declares `flow_dir`, return
  is name-free).

### requires-channel sequencing (P-3, commit cf13b91)
- **Teach:** a mod may declare `# requires-channel: <name>`; on invocation its
  provider (the `# channel:` mod) runs FIRST — one invocation instead of two.
  ONE LEVEL only (a missing/ambiguous/deeper provider is refused, naming the
  channel). **The honest limit to teach:** sequencing is NOT atomicity — if the
  provider runs and the consumer fails, the channel stays declared (append-only,
  not undoable). `get_context` shows which mods require which channels.
- **Point at:** the shipped `setup_flow.py` (requires `flow_dir`, then binds it).

### write_mod authoring fields (P-1/P-2/P-3)
- **Teach:** `write_mod` gained `params`, `channel`, and `requiresChannel` fields
  so the assistant can author parameterized / channel / requiring mods. The
  approval preview names the declared channel and required channel; a malformed
  one is re-parsed and reported precisely, not "not loaded".

### Figure resolution (Item C, commit c3651c8; extraction parked)
- **Teach (once the extraction fork resolves):** `figure_metric` takes `dpi`
  (default 100) — pass `?dpi=200` for higher resolution. The figure has a 2 MiB
  size cap; if exceeded the refusal says to lower the dpi (now a real knob).
- **Not yet teachable:** how to SAVE the figure to disk — parked (see
  reports/PARKED.md Item C); revisit when the extraction path is decided.

_(The ribbon bend miter, Item B, is a renderer change — no prompt surface.)_

---

## From the cold acceptance test (reports/ACCEPTANCE_COLD.md, 2026-07-21)

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
4. **Parameters need no change from this test** — taught, but none of the three
   requests implied a tunable, so they went unexercised. Re-measure on a request
   that does.

What already lands and should NOT be disturbed: the inline channel return shape
(P-2 `{values, components}`, no `name` — correct in every mod), the frame-to-frame
coherence pattern (present in every vector channel mod), the float64 and
`trajectory is None` correctness rules, `bind` vs `bake` for motion, and the
dependency order (bind orientation before the ribbon swap).
