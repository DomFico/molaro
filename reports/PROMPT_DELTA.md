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
