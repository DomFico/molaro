# HANDOFF — The assistant tier: panel, typed results, plot, and mods

**Audience**: a TypeScript engineer joining cold, with no prior context on
this project and no knowledge of any application domain. None is needed —
and keeping it that way is this tier's load-bearing constraint (see the
warning below). Everything operates on the same abstract, neutral tree the
lower layers use — **category → group → subgroup → point**, where levels
1–3 carry opaque label strings, each point carries an opaque **type** token
and a unique integer **index**, positions change over **frames**, and
connectivity is **edges** and **polylines**. A "selection" is a set of
points. A "target" is an address expression that resolves to one.

> **⚠ Domain interpretation is out of scope — do not infer it.** This tier
> moves NUMBERS between surfaces: per-point scalars, per-frame series,
> (x, y) pairs. Nothing in its code, tests, or docs says what any number
> *means*, and nothing may. The layer's correctness never depends on
> knowing what the data represents — that is a designed property, recorded
> throughout this doc, and it is what made the tier buildable by an agent
> with no domain knowledge. The complete working vocabulary is the neutral
> tree above plus the synthetic labels (`alpha.group-0`, `#0-99`, `t1`,
> `solvent`, `example_tool_a`, `example_series`, `index_ramp`). If an
> explanation seems to need a domain word, the explanation is wrong.

**Read this first, then the canonical companions:**

- [`docs/COMMANDS.md`](docs/COMMANDS.md) — user-facing behavior. This
  tier's canonical sections: "`/claude` — the conversation panel" (incl.
  typed results and the layout controls), "Analysis mods — Python compute
  in the producer", and "Listing the registry: `mods`".
- `HANDOFF_fable_viewer_UI.md`, `HANDOFF_fable_terminal_grammar.md`,
  `HANDOFF_fable_scalar_channel.md` — the three layers underneath
  (selection/panel substrate; grammar/registry/terminal; the
  representation verbs and buffers). This tier CALLS all three and forks
  none of them. Read whichever you need for the substrate; this doc is the
  fourth in that series and does not repeat them.

---

## 1. What this tier is

Everything above the scalar-channel layer: the surfaces through which an
**assistant** (today: a scripted stub; see §13) drives the viewer, plus the
machinery that makes its outputs durable and visible.

Five pieces, built in dependency order, each filling a seam a prior layer
reserved:

1. **The conversation panel** (`/claude`) — a chat surface inside the
   terminal webview with a frozen two-way message contract and an
   approve-before-run gate on tool calls. Fills nothing below; creates the
   assistant boundary.
2. **Typed results** — `tool-result` events carry an optional payload from
   a CLOSED four-kind union; a **binding layer** turns each kind into a
   visible change on the existing rails. Fills the scalar-channel layer's
   reserved "future scalar source" seam (its `applyColorScalars` was
   designed for exactly this).
3. **The plot tab** — a third editor webview drawing ONE active item (a
   per-frame line series or an (x, y) scatter), playhead-synced both ways.
4. **The split layout** — the panel/terminal arrangement is user-controlled
   (resize/flip/swap) and persisted; the project's first persistence.
5. **Mods** — the recipe registry generalized: mods are tagged
   `representation` (JS, webview) or `analysis` (PYTHON, executed in the
   producer against the resident dataset), declare what they `produce`,
   route through the same binding layer, and persist as readable files
   under `.molaro/mods/`. Fills the recipe layer's reserved
   registry-serialization seam.

The founding rule, inherited and extended: **this tier reuses the rails
below it and never re-implements them.** Targets resolve through the ONE
resolver `view` uses; representation writes go through the ONE writer
discipline; commands run through the ONE registry path. A local copy of
any of those is a bug even if byte-identical today.

---

## 2. Architecture — four surfaces, one relay

The extension host owns THREE webviews per session plus the producer child
process, and relays between them (webviews cannot talk directly):

```
                         extension host (src/extension.ts)
                        ┌──────────────────────────────────┐
 viewer webview  ◀──────┤ verbatim type-routed relay        ├──────▶ terminal webview
 (main.js:               │ + plotHost (webview/plothost.ts, │        (terminal.js:
  scene, resolver,       │   PURE — shared with the harness)│         command log + input,
  writers, runCommand,   │ + claudeStub (webview/           │         conversation panel,
  claude-bind dispatch)  │   claudestub.ts, PURE — ditto)   │         split layout)
                        │ + .molaro/mods loader             │
                        └───────────┬──────────┬───────────┘
                                    │          │
                          plot webview      producer (python,
                          (plot.js: SVG,    stdio, FIFO: header /
                          one active item)  frames / run_mod)
```

Message families over the relay (all flat JSON; the host routes by `type`):

- command layer (pre-existing): `command`/`complete` →viewer,
  `commandResult`/`completeResult` →terminal.
- panel↔backend (the FROZEN contract, §3): events →terminal, commands
  →stub. Lifecycle glue: `claude-ready` (terminal boot → host creates the
  stub).
- binding: `claude-bind` (terminal→viewer, EXCEPT plot kinds which the
  host's plotHost consumes first; also viewer→host for mod-produced plot
  items), `claude-bind-result` (→terminal, the ⤷ outcome line).
- plot: `viewerInfo` (one-shot frame count, viewer→host), `frameChanged`
  (viewer→host→plot), `plotSeries`/`plotScatter`/`plotFrame` (host→plot),
  `plotSeek` (plot→host) → `seekFrame` (host→viewer), `plot-ready`
  (plot boot → host re-pushes the held item).
- mods: `modsLoaded` (host→viewer, on the viewer's `viewerInfo` boot
  signal), `run_mod` (viewer→producer through the existing `toProducer`
  transport).

**The purity/sharing pattern that makes this testable**: host-side LOGIC
lives in pure, vscode-free modules — `plothost.ts` (route/validate/hold/
re-push) and `claudestub.ts` (the scripted backend) — instantiated by the
real host in production and by the harness's in-page loopback glue in
tests, so the identical code runs at an emulated boundary. The bridge shim
(`tests/bridge.ts`) loops the relay types back into the single harness
page and mirrors the host's mod push; `window.__TERMINAL_HARNESS__` gates
the glue in `terminal.ts`. This is the established pattern (the shim has
emulated the command relay since the terminal shipped) — extend it, don't
fork it.

---

## 3. The conversation panel (`/claude`)

`webview/claudemodel.ts` (contract + transcript reducer, pure),
`webview/claudepanel.ts` (the transcript renderer, DOM),
`webview/claudelayout.ts` (the split layout, DOM + pure model),
`webview/claudestub.ts` (the backend stub), wiring in
`webview/terminal.ts`.

`/claude` is a **terminal-local intercept** exactly like `clear` (it never
reaches viewer state; a registry stub exists only so `help /claude`
answers). It toggles the panel; the panel has its OWN input — two input
surfaces, one relay. The transcript survives toggles (state lives in the
reducer, not the DOM).

### 3.1 The frozen message contract

Everything in the panel is a renderer over these two sets. THE CONTRACT IS
FROZEN — the backend behind it is swappable (§13) with nothing in the
panel changing.

Backend → panel (events):

```ts
{ type: "auth-status",       state: "connected" | "disconnected", hint?: string }
{ type: "assistant-text",    delta: string }                    // append to the open turn
{ type: "tool-proposed",     callId: string, toolName: string, argsPreview: string }
{ type: "approval-required", callId: string, toolName: string, preview: string }
{ type: "tool-result",       callId: string, ok: boolean, summary: string,
                             result?: TypedResult }             // §4
{ type: "turn-complete" }                                       // re-enables the input
{ type: "error",             message: string }
```

Panel → backend (commands):

```ts
{ type: "user-message",      text: string }
{ type: "approval-decision", callId: string, decision: "approve" | "deny" }
{ type: "cancel" }
```

`parseClaudeEvent` / `parseClaudeCommand` are the single unknown→typed
seam, called by BOTH hosts; the sets are disjoint from each other and from
the command-relay types. `summary` is a display string the transcript
prints; any scene effect comes only from `result`. A malformed `result`
never poisons its event (summary still renders; the raw payload is
forwarded and errors at the binding gate).

### 3.2 Transcript semantics (the reducer)

`TranscriptState` = items (user turns / assistant turns / error items) +
`busy` + latest auth + a callId→ToolBlock index. Deltas concatenate into
the OPEN assistant turn; `turn-complete` closes it and re-enables the
input (a later delta starts a NEW turn, never reopens). `tool-proposed`
appends a block under the open turn; `approval-required` puts live
approve/deny buttons on that block (`markDecision` records the click so
re-renders keep them disabled — the backend's `tool-result` lands
separately, ok-styled or error-styled); `setBindOutcome` attaches the
binding's ⤷ line (transport-fed, like markDecision — NOT a contract
event). `error` renders an error item and does NOT end the turn (the stub
always follows with `turn-complete`). `auth-status` drives a display-only
status line — an indicator dot plus hint text, no credential anything.
`cancel` is live while busy.

### 3.3 The stub backend — the swap point

`webview/claudestub.ts`, banner-labeled `STUB — replaced by the real
backend`. Pure and vscode-free like `src/broker.ts`, so the extension host
instantiates it at the REAL backend's boundary (per terminal, on the
terminal's `claude-ready` signal — see §9 on why the signal exists) and
the harness runs the identical module in-page. Options: `auth`/`authHint`
(both states testable), `delayMs` (default 40), `frameCount?: () => number`
(supplied by the host from `plotHost.nFrames()` so scripted series are
genuinely length-T).

Script per `user-message`: three streamed deltas → one AUTO-APPROVED tool
(`example_tool_a`, result carries 100 color scalars over `#0-99` —
point-index targets are dataset-independent, which matters because the
host-side stub cannot know N) → one GATED tool (`example_tool_b`, approve
→ `{kind:"command", command:"create_sele alpha.group-0"}` so approval
literally gates a scene change; deny → `ok:false`, no result) →
`turn-complete`. Sentinel words route alternate single-tool turns:
`trigger-error`, `scalar-size` (#100-149), `scalar-opacity` (#150-199),
`series-demo` (length-T raw sine), `series-mismatch` (7 values),
`scatter-demo` (40-point loop with `frames`), `scatter-static` (no
frames), `scatter-mismatch` (unequal x/y), `mismatch-demo` (5 scalars for
10 points). `cancel` clears the timers and ends the turn. callIds
(`call-N`) are unique across turns.

### 3.4 The split layout — the project's first persistence

`webview/claudelayout.ts`. The state object and its pure geometry:

```ts
LayoutState = { open: boolean, orientation: "stacked" | "side",
                order: "claude-first" | "terminal-first", ratio: number }
DEFAULT_LAYOUT = { open: false, orientation: "stacked", order: "claude-first", ratio: 0.6 }
```

`ratio` is the FIRST pane's share, clamped to `[0.15, 0.85]` (symmetric,
so the swap rule below always lands in bounds). `layoutGeometry(state)` is
pure → flex direction, CSS `order`, fractional flex-grow shares — each
share computed STRAIGHT from the ratio (`1-(1-r)` drifts in floating
point; a unit test caught it). The DOM applier keeps `.collapsed` as the
open/close mechanism, which is why every pre-existing panel assertion
survived the refactor. **Swap** (`⇄`): order flips AND `ratio → 1-ratio`,
so each pane keeps its size while positions exchange (asserted to the
pixel). **Flip** (`⤢`): orientation flips, ratio and order preserved. The
divider drags with the viewer panel's exact pointer-capture pattern; both
panes carry `min-width: 0` (flex-ROW children refuse to shrink without
it — the extreme-ratio break).

Persistence: the webview state API (`getState`/`setState`, optional —
absent in older harnesses), own key `claudeLayout`, merge-preserving other
keys (the viewer's panel-dock precedent). `parseLayout` falls back PER
FIELD; a throwing state API is swallowed — bad persisted state can never
break the panel. **Layout ONLY persists**: transcript, plot items, and
scene state deliberately do not. `retainContextWhenHidden` covers
tab-away; the state API covers reloads. The harness shim backs
getState/setState with sessionStorage (survives same-tab reload for the
E2E restore; dies with the browser, so reused chrome profiles can't leak
state across runs).

---

## 4. The typed-result contract — the closed four-kind union

`webview/claudemodel.ts`. Verbatim:

```ts
type TypedResult =
  | { kind: "per-point-scalar", target: string,
      axis: "color" | "size" | "opacity", scalars: number[] }
  | { kind: "command",          command: string }
  | { kind: "per-frame-series", label: string, values: number[] }
  | { kind: "scatter",          label: string, x: number[], y: number[],
      xLabel?: string, yLabel?: string, frames?: number[] }
```

| kind | value semantics | destination | validation |
|---|---|---|---|
| `per-point-scalar` | **normalized `[0,1]`** — whatever produced them owns normalization; the binding maps `[0,1]` → visual and NEVER interprets magnitude | the per-element write rails (§5) | `scalars.length` == the resolved point count of `target` (header order: `scalars[i]` ↔ the i-th resolved point), else NOTHING is written |
| `command` | a command string | the exact `runCommand` a typed terminal command hits | the verb's own errors; undo comes from the verb |
| `per-frame-series` | **raw** — the plot auto-scales, never normalizes | the plot tab, as a line | `values.length` == the frame count, else nothing draws |
| `scatter` | **raw** (x, y) pairs; both axes auto-scale independently | the plot tab, as dots | equal-length non-empty finite `x`/`y`; `frames` (optional — the sync hook) same length, integer in-range frame indices; else nothing draws |

`parseTypedResult` is THE closed-union gate — structural validity
(lengths, finiteness, field types) lives there; range checks that need
runtime knowledge (frame count) live at the consuming route. An unknown
`kind` is an error, never a guess. **The union is closed at four** — that
closure is what lets every consumer switch exhaustively (parsing,
dispatch, plot routing, mod `produces`, docs) with no silent fallthrough;
widening it means touching every closure point listed in §10's file map,
deliberately.

The normalized-vs-raw split is a designed property, not an accident:
per-point scalars become *visual parameters* (a colormap input, a size
fraction), so the producer of the values owns their meaning and this layer
maps a unit interval; series/scatter are *readouts*, so the plot shows the
real numbers and scales the view instead. Neither path knows what the
numbers mean. Keep it that way.

---

## 5. The binding layer — a typed result becomes a visible change

`webview/claudebind.ts` (viewer-side dispatch) + `webview/plothost.ts`
(host-side plot route) + the forwarding glue in `terminal.ts` / `main.ts`
/ `src/extension.ts`.

**Routing** (the cross-webview pattern): a `tool-result` lands in the
TERMINAL webview, but the rails live elsewhere, so the terminal forwards
the RAW payload as `{type:"claude-bind", callId, result}` and the outcome
returns as `{type:"claude-bind-result", callId, ok, message}` → the ⤷
line on the call's tool block. The host routes by RAW `kind` string:

- plot kinds (`per-frame-series`, `scatter`) → consumed by
  `plotHost.handleTerminalMessage` BEFORE the viewer relay. Checking the
  RAW kind (not the parsed result) is deliberate: a malformed plot payload
  fails CLOSED on the plot route with a proper message (`malformed scatter
  payload — not drawn`) instead of parsing null and leaking to the
  viewer's generic error. The viewer's own claude-bind handler carries the
  matching raw-kind guard and stays silent on plot kinds.
- everything else → relayed to the VIEWER, where `bindTypedResult(ctx,
  runCommand, raw)` dispatches:
  - `per-point-scalar` → `resolveTargetPoints` (view's exact header-order
    resolution — exported from `commands.ts` for exactly this) → the
    per-element writer discipline the recipes ride: color through
    `applyColorScalars` + the built-in colormap, size through
    `ctx.sizePointsEach` mapping `t → t×BIND_SIZE_MAX` (6 = 2× base — a
    FIXED visual range, never an interpretation), opacity through
    `ctx.opacityPointsEach` as identity (`[0,1]` IS its range). Capture-
    prior + `recordOp` = ONE undo stroke; LWW; own buffer; GPU sync via
    the writer's onWrite — a typed-result change undoes in one Ctrl+Z
    exactly like a hand-typed verb.
  - `command` → `runCommand(result.command)` — the identical function
    typed terminal commands hit; undo is the verb's own.
  - plot kinds → a defensive error branch ("routed to the plot panel"),
    unreachable in practice.

**Fail-closed, no-partial-write, everywhere**: a count mismatch, an
unknown kind, a nomatch target, out-of-range frames — each binds NOTHING,
pushes NOTHING, and reports why. There is no partial application anywhere
in this tier.

---

## 6. The plot tab

`webview/plotmodel.ts` (pure math) + `webview/plothud.ts` (skeleton/CSS,
shared with the harness) + `webview/plot.ts` (the page) +
`webview/plothost.ts` (host orchestration) + the panel plumbing in
`src/extension.ts` (`viewerPlot`, create-on-demand beside the others).

**One active item** — a line series or a scatter; a new result of either
kind replaces it in place. **The host holds the item** (plus the last
frame and the frame count) and re-pushes on the page's `plot-ready`
signal, so close→reopen restores the plot with NO webview retention —
state lives host-side by design (cheaper than retention, and the reload
path is exercised constantly instead of never).

Rendering is hand-drawn SVG on a FIXED viewBox (`PLOT_W=800`,
`PLOT_H=300`, margins `{left:44, right:10, top:12, bottom:20}`): fixed
coordinates make drawn content deterministic and assertable at any panel
size, and **no charting dependency** keeps the bundle self-contained and
the output inspectable (this project asserts on the drawn `points` /
`cx`/`cy` attributes — a canvas or a library would bury them).

The pure model (`plotmodel.ts`) — one mapping shared by render, marker,
and hit test, so they cannot disagree:

- `seriesScale(values)` → raw `{min, max}` (the readout shows REAL values;
  drawing falls back to a unit span on a flat axis — no divide-by-zero).
- `frameToX(frame, nFrames)` / `xToFrame(x, nFrames)` — the line's
  frame-index axis, mutually inverse, clamped.
- `valueToX(v, scale)` / `valueToY(v, scale)` — the scatter's two scaled
  axes.
- `nearestPoint(vx, vy, xs, ys, xScale, yScale)` — the scatter hit test:
  nearest dot within `SCATTER_HIT_TOLERANCE = 14` viewBox units, else -1.

**Frame sync, both directions**: the viewer's `displayFrame` — the ONE
point where a frame becomes displayed (playback and scrubbing both funnel
through it) — posts `frameChanged`; the host forwards `plotFrame`. Never
polling. A series shows the playhead as a vertical marker at
`frameToX(frame)`; a synced scatter (has `frames`) toggles `.current` on
the matching dot(s) instead. Clicks go back as `plotSeek` → the host →
`seekFrame` → `player.seek(frame)`, the exact setter the scrubber drives:
a series seeks the frame under the click's x; a synced scatter seeks the
NEAREST dot's frame; a frames-less scatter does nothing (a static picture
is legitimate — not everything has a frame axis). One seek channel; do
not add a second.

Nuance recorded so nobody "fixes" it: on data where the (x, y) trail
self-overlaps, clicking a dot may seek a DIFFERENT frame whose point sits
at (nearly) the same position — nearest-wins is the rule, and the
semantic guarantee is "the seeked frame's point is at the clicked spot",
not "the dot index you aimed at". The E2E asserts exactly that.

---

## 7. The mod system

`webview/recipes.ts` (the union, the file format, the validation gate) +
`producer/serve.py` (the exec bridge) + the loader/save in
`src/extension.ts` + invocation wiring in `webview/commands.ts` /
`webview/main.ts`.

### 7.1 The tagged union

```ts
type Mod = Recipe | AnalysisMod            // shared: name, origin, author?, source?, description?

Recipe      = { kind: "representation", axis: "point-color",
                compute(points): number[], colormap(t): [r,g,b] }   // JS, webview (rainbow)
AnalysisMod = { kind: "analysis",
                produces: ModProduces,             // see MOD_PRODUCES below
                axis?: ModAxis,                    // required iff per-point-scalar
                code: string }                     // PYTHON, executed in the producer
```

`produces` is **the routing key**. It is now **single-sourced** — two
`readonly const` arrays in `recipes.ts` are the ONE definition every
consumer derives from (the type, the file parser/validator, the mods
display, and — in the domain tier — the authoring tool's schema):

```ts
export const MOD_PRODUCES = ["per-point-scalar", "per-frame-series", "scatter", "commands"] as const;
export const MOD_AXES     = ["color", "size", "opacity"] as const;
```

For the first three, an analysis mod's validated output is packaged as a
`TypedResult` of that kind and handed to §5's binding layer VERBATIM — no
new binding, no new renderer. **`commands` is the reversal of an earlier
decision** (this doc once said "a mod that emits a command string is a
macro — out of scope, don't add it"): a `commands` mod returns a
`list[str]` run through the command path (§7.6). It is handled at the
**mod-run boundary**, NOT as a `TypedResult` — so **the typed-result union
is still closed at four**; `produces` is four while `TypedResult` is a
different four (`commands` in, `command` out). Do not conflate them.

`origin` gained `"workspace"`; it is ASSIGNED by the loader, never read
from a file. `author`/`source`/`description` remain display-only opaque
strings — nothing fetches or resolves them.

`mods` lists everything, grouped by origin, rendering `produces`
generically (`name — analysis · commands · by …`), so a new `produces`
value shows up with no display change.

### 7.2 The file format (`.molaro/mods/*.py`)

One plain Python file per mod: the `# molaro-mod` magic first line,
`# key: value` header comments (name / kind / produces / axis? / author? /
source? / description?), then the source. Chosen over JSON-with-escaped-
code because the whole value of these files is that **a human reads the
code before running it** — they diff, review, and syntax-highlight as
Python. `parseModFile(text, origin)` / `serializeMod(mod)` round-trip it
(pure, in `recipes.ts`, shared by the host loader, the bridge, and the
tests). Names must match `/^[a-z][a-z0-9_-]*$/`. Representation mods have
no file form (their compute is JS) — `serializeMod` refuses them.

Lifecycle: the host scans `<workspace>/.molaro/mods/*.py` at panel
creation; each malformed file is SKIPPED with a warning to the output
channel — one bad mod can never break startup or the registry. Parsed
mods ship to the viewer as ONE `modsLoaded` message on the viewer's
`viewerInfo` boot signal (§9's ready-signal pattern); the viewer registers
each in the mod registry AND as its own verb — a name colliding with an
existing command is skipped with a reported line, so **a file can never
shadow a built-in**. `saveWorkspaceMod(mod)` (extension.ts) is the write
path an authoring step uses. **`rm <mod>` is the delete surface** (added
after this was first written): a y/n-confirmed terminal verb that unlinks a
workspace mod file and deregisters it. It resolves the file to delete ONLY
through the scan's path-map (`modPaths`, name→scanned path), NEVER a path
built from the name — so it can touch nothing outside `.molaro/mods` and
refuses built-ins by construction; disk-first, then unregister the
successes; it is NOT undoable (a disk operation is outside the undo model).
Host and viewer reconcile through an explicit result message so registry
and disk cannot disagree. **Mods are the only thing persisted by this
feature.** Built-ins (`rainbow`) stay code-registered. `.molaro/**` is
excluded from the VSIX — it is user-workspace data, not extension content;
the repo ships neutral examples (`index_ramp` scalar→color, `frame_metric`
series, `xy_metric` scatter, `color_ab` a `commands` macro over synthetic
labels) that appear when this repository is the open workspace. (The same
`.molaro/mods/` directory also holds the domain tier's reference mods,
which THIS doc does not describe — see `HANDOFF_fable_assistant.md`.)

### 7.3 The Python compute contract

```python
def compute(data, target_indices):
    """
    data           — the dataset handle already RESIDENT in the producer
                     (data.give_header().n_frames / .n_points;
                      data.give_frames(start, count) — positions are
                      frame-major little-endian float32 BYTES; decode with
                      struct.unpack_from, see the shipped examples;
                      data.labels — the label view, below)
    target_indices — list[int]: the resolved point set in HEADER ORDER
                     (empty list = the whole dataset, by contract)
    returns        — list[float]  (per-point-scalar: one per target index,
                                   each in [0,1] — the mod owns its own
                                   normalization;
                                   per-frame-series: one per frame, raw)
                  — OR, produces: scatter ONLY, the one widened shape:
                     {"x": [...], "y": [...], "frames": [...]?,
                      "xLabel": str?, "yLabel": str?}
                  — OR, produces: commands ONLY: list[str] (§7.6)
    """
```

**`data.labels` — the label vocabulary on the mod-facing handle.**
`data.labels[i]` → `(category_label, group_label, subgroup_label)` for
point index `i`, header-order indexed (same correspondence as
`target_indices` and the frame-byte columns). It is a **read-only view**
built from the header the producer already sends; it is **neutral
information** — the opaque tree labels, nothing about what they mean — and
so it is present on the **synthetic source too**, not just real datasets
(unlike the domain tier's data handle, which this tier does not describe).
The fallbacks it returns mirror the viewer's own label resolution
(`sets.ts`), so a label a mod reads is byte-for-byte the label the grammar
matches.

*Why it exists:* a `commands` mod (§7.6) builds command STRINGS, and a
command string names the grammar's vocabulary (`alpha.group-0.subgroup-3`).
Without `data.labels` a mod would have to *guess* those labels from raw
indices or some inferred scheme, which is right where it was written and
wrong elsewhere — and, because **a nomatch is not an error** (§8), a wrong-
but-well-formed address writes nothing and reports SUCCESS. `data.labels` is
how a mod speaks the real vocabulary instead of guessing it.

### 7.4 The exec bridge (`run_mod`)

A third request beside `header`/`frames` on the existing FIFO stdio
protocol: `{"type":"run_mod", "code", "target_indices", "timeout_s"?}` →
`{"values": [...]|{...}}` or `{"error": str, "traceback"?: str}`. FIFO
stays 1:1 — every request gets exactly one response, so the transport's
no-ids correlation holds.

Execution: `exec` the code into a fresh namespace, call
`compute(source, target_indices)` where `source` IS the resident
DataSource — no re-load, no per-invocation process. **The timeout is
SIGALRM/`setitimer`** (default `DEFAULT_MOD_TIMEOUT_S = 5.0`): `serve()`
runs in the main thread, so the alarm raises INSIDE the running compute
and genuinely ABORTS it — a thread-based timeout could only abandon a
runaway loop, which would keep burning the process. The producer answers
the timeout error and keeps serving (pinned by the protocol test against
a real `while True: pass`). **There is deliberately NO sandbox**: mods are
user-approved code (the approval gate is upstream); the protections are
structured errors WITH tracebacks, the timeout, and fail-closed
validation. Accepted consequence of the single FIFO process: frame
streaming queues behind a running compute, bounded by the timeout.

**Async verbs on a sync command layer, with zero new machinery**: the
terminal prints EVERY `commandResult` regardless of id, so an analysis
verb returns `running <mod> on N points…` synchronously and the outcome
arrives as a follow-up `{type:"commandResult", id:-1, status, message}`
line (`asyncLine` in main.ts). Resolution happens BEFORE the round-trip
(nomatch/parse errors never reach the producer).

### 7.5 The fail-closed validation gate

`validateModValues(values, {produces, targetCount, frameCount})` in
`recipes.ts` — the SINGLE gate between the producer's reply and any
binding, and the most-tested function in the tier:

- flat kinds: a list of finite numbers of the EXACT expected length (one
  per target index / one per frame), `[0,1]` for per-point scalars;
- scatter: a dict with equal-length non-empty finite `x`/`y`; `frames`,
  if present, same length and integer in-range;
- anything else — wrong type, wrong length, non-finite, out-of-range, a
  producer-side exception or timeout — binds NOTHING and reports why
  (traceback text included). Never a partial write.
- `commands`: a flat list of NON-EMPTY strings → `{ok, commands}` (§7.6).

### 7.6 `produces: commands` — the macro mod

A `commands` mod's `compute` returns a `list[str]`, each an ordinary
command string; the batch runs through **the exact command path a typed
terminal command hits**. This is the "save a look/an action as a
re-runnable artifact" capability — and because it is Python with the
resident handle, it can **compute first, then emit commands** (derive a
per-point quantity, then emit the verbs that act on it). It is NOT a
`TypedResult`; it is handled at the mod-run boundary (`runCommandMacro` in
`commands.ts`, pure + unit-tested), so the typed-result union stays closed.

The execution boundary is the whole design, in order:

1. **Refusals — the RUNTIME guarantee, not the prompt and not the file.**
   `commandMacroRefusal` refuses `rm` and any mod-invocation (a verb in the
   registry's mod names — no recursion). This is the load-bearing point: a
   mod's Python **generates strings at run time**, so whatever a human read
   in the file (or an approval preview) is NOT the protection — the string
   `"rm all"` can be assembled from pieces the reader never saw. The refusal
   must live where the string is about to RUN.
2. **All-or-nothing pre-validation via the no-op-write context.** Before
   ANY command runs, every string is parsed and resolved against a
   **validation `CommandContext` whose ~20 write methods are overridden to
   no-ops while its reads stay real** (resolution, `@name` existence, name
   collisions). A parse/usage error in the third string runs ZERO commands,
   not two. (A `nomatch` is not an error here — a dependent command that
   references a not-yet-created `@name` still validates.)
3. **One undo stroke.** The whole batch runs inside one
   `beginStroke`/`endStroke` pair (§8), so one Ctrl+Z reverses the entire
   macro.
4. **All-nomatch is LOUD.** If EVERY command nomatches, the summary reports
   that nothing matched and nothing was written (the existing `nomatch`
   status, not a cheerful `ok`) — the silent-success trap for a mod that
   addressed a vocabulary that isn't there. A *partial* nomatch stays a
   normal `ok`.

The producer side is trivial: `run_mod` passes a `list[str]` return through
as `{values}` (before the numeric checks), and the client re-validates
against the declared `produces`.

---

## 8. The invariants — rules a change must not break

1. **Fail-closed, no-partial-write, everywhere.** Every path from a typed
   result or a mod return to a visible change validates first and applies
   all-or-nothing. Error paths are byte- and depth-identical no-ops.
2. **The typed-result union is CLOSED at four**, and `produces` at FOUR
   (`per-point-scalar` / `per-frame-series` / `scatter` / `commands`).
   `commands` is NOT a typed-result member — it runs at the mod boundary,
   so the union closure is untouched. An unknown kind errors; nothing
   guesses. Widening either means visiting every closure point (§10) in one
   change, and both sets derive from a single source (`MOD_PRODUCES` / the
   `TypedResult` union), never two hand-synced lists (see the defect-class
   rule below).
3. **The panel↔backend contract is frozen.** The backend swaps behind it
   (§13); the panel never grows backend-specific behavior.
4. **This tier reuses the rails, never re-implements them**: resolution =
   the exported `resolveTargetPoints` (view's loop); representation writes
   = the per-element writers (one `recordOp` stroke, LWW, own buffer, GPU
   sync in the writer); commands = `runCommand`. One undo stack, ever.
   `beginStroke`/`endStroke` gained a **reentrant depth counter** (in
   `sets.ts`): nested strokes coalesce, so a `commands` macro whose
   individual verbs each stroke still collapses to ONE undo entry.
   Backward-compatible — a balanced outer pair behaves exactly as before.
5. **The line-series plot path is fixed.** The scatter generalization left
   it byte-identical (its unit tests are untouched); future plot work must
   keep both item types' existing behavior.
6. **Index alignment is VERIFIED, never assumed.** `scalars[i]` binds to
   the i-th point of the target in header order, and the producer's
   `target_indices` use the same contract indices. A misalignment here
   colors the WRONG elements with no error anywhere — which is why the
   E2E audits the changed-buffer set against the resolver's set exactly,
   and why any change touching index flow must keep that audit green.
7. **Values are not interpreted.** Scalars are a unit interval mapped to
   visuals; series/scatter are raw and auto-scaled. No normalization,
   clamping-with-meaning, or unit awareness may creep into this tier.
8. **One active plot item; the host holds it.** Restore is a re-push on
   `plot-ready`, never webview retention, and restore touches no undo.
9. **Layout is the only panel persistence**, per-field fault-tolerant.
   Transcript/plot/scene state must not gain persistence casually.
10. **Mod create/destroy is disk-confined.** Mods load at startup, save
    through `saveWorkspaceMod`, and delete through `rm` — which resolves the
    file ONLY through the scan's path-map, never a name-derived path, so it
    can touch nothing outside `.molaro/mods` and refuses built-ins. Files
    cannot shadow built-in verbs. Deletion is not undoable.
11. **The recurring defect class: "two lists that must agree."** It has
    bitten this project three times — a tool deny-list vs. the real runtime
    surface; a system-prompt vs. the real grammar; a tool schema vs. the mod
    system's `produces`. Each time the bug was a second copy of a contract
    that drifted from the first. **The durable fix is ALWAYS a single source
    or an equality assertion that fails the moment one side changes — never
    a careful hand-sync.** Apply this to any new duplicated contract:
    `MOD_PRODUCES`/`MOD_AXES` are the pattern (one `const`, everything
    derives; a test asserts the derived-elsewhere copy equals it).
12. **The silent-failure class: "a nomatch is not an error."** Resolving an
    address to nothing is correct grammar discipline (an empty result is
    legitimate), but it means a **wrong-but-well-formed** address writes
    nothing and reports success. Anything that GENERATES addresses (a
    `commands` mod, a future generator) must check them against reality, not
    assume them — hence `data.labels`, and hence all-nomatch being loud.

---

## 9. Hard-won specifics — read before touching anything here

Each cost a debugging round or a screenshot review. In rough order of
recurrence risk:

- **The `[hidden]` trap, BOTH flavors.** An element with an explicit CSS
  `display` ignores the UA's `[hidden]` rule (`#plot-empty`,
  display:flex — kept rendering over the plot while `.hidden === true`).
  Worse: **SVG elements never get the UA `[hidden]` rule at all** — the
  series marker kept rendering over the scatter with the attribute set
  and every property-level check green. Both were caught ONLY by
  screenshot review. Rules: every `hidden` use on an SVG element (and any
  element with explicit display) needs an explicit
  `[hidden] { display: none }` override, and **layout/visibility
  assertions check `getComputedStyle(...).display`, never the property.
  Review the screenshots — that is what they are for.**
- **The pixel-assertion fixture.** Sampling a point sprite's center pixel
  can be polluted by the 1px edge/polyline passes crossing it. Fixture
  recipe (used by every pixel proof since it bit): fade the target's
  edges and the trace to opacity 0, hide the bulk selection, enlarge the
  two probe points (`pointsize #N 12`), `projectPoint` for coordinates,
  then sample. Also: pixel proofs can only run on the `"/"` route — the
  terminal stack overlays the canvas on `"/terminal"`.
- **The ready-signal lifecycle pattern.** A webview that hasn't finished
  loading silently DROPS posted messages. Anything the host emits at a
  webview's birth must wait for the page's own announcement:
  `claude-ready` → create the stub (its opening `auth-status` was lost
  before this), `plot-ready` → re-push the held item, `viewerInfo` →
  ship `modsLoaded`. If you add a host→webview push at creation time,
  give it a ready signal.
- **The relay-drop trap — the harness can be MORE capable than
  production.** `rm`'s y/n answer travels terminal→host→viewer, but the
  host's relay list did not forward `confirm-answer`, so the confirmed
  delete was dropped on the floor: **every `rm` was silently broken in real
  VS Code while the E2E stayed green** — the in-page harness loops relay
  types back into one page, so it delivered the answer itself and masked the
  dead relay. Lesson with teeth: a green E2E on the loopback harness does
  NOT prove a host relay route exists; when a message must cross the
  terminal↔viewer boundary in production, confirm the host actually
  forwards its `type` (the forward-list is now a single tested predicate,
  `relaysTerminalMessageToViewer`), and probe cross-webview paths in a real
  workbench, not only the harness.
- **The sync-command/async-compute pattern.** The command layer is
  synchronous; producer round-trips are not. The follow-up-`commandResult`
  (id -1) pattern is the whole solution — do not add a parallel async
  channel or make handlers async.
- **Raw-kind routing at the plot boundary.** Route plot-bound claude-binds
  by the RAW `kind` string, not the parsed result — otherwise malformed
  plot payloads parse to null and leak into the viewer's generic error
  path instead of failing closed on the plot route.
- **Self-overlapping scatters.** Nearest-point seek may legitimately land
  on a different frame at the same (x, y). Assert the semantic guarantee
  (seeked point at the clicked spot), not dot-index identity; only
  synthetic non-overlapping fixtures may pin exact indices.
- **The stub cannot know the dataset.** Host-side scripted payloads use
  dataset-independent `#index` targets (`#0-99`) and the `frameCount()`
  closure; anything length-T must come from those, never a constant.
- **Uncached-chunk seeks in E2E** need ~800ms — a seek outside the
  autoplayed range triggers a chunk fetch before the frame flips.
- **Persistence in the harness is sessionStorage**, deliberately: it
  survives same-tab `d.navigate()` reloads (the restore assertion) but
  dies with the browser, so reused `/tmp/cdp-<port>` chrome profiles
  cannot leak state across runs.
- **Working directory**: every command in this repo runs from `viewer/`
  (the repo root). A stray `npm`/`node` from the parent directory fails
  with confusing enoent/module errors.

---

## 10. Where everything lives

| File | This tier's stake |
|---|---|
| ★ `webview/claudemodel.ts` | The frozen panel↔backend contract + `parseClaudeEvent`/`parseClaudeCommand`; `TypedResult` (the four-kind union) + `parseTypedResult`; the transcript reducer (`applyEvent`, `addUserMessage`, `markDecision`, `setBindOutcome`). Pure. |
| `webview/claudepanel.ts` | The transcript renderer ONLY (blocks, ⤷ lines, buttons-from-state, status line). Visibility belongs to the layout. |
| `webview/claudelayout.ts` | `LayoutState` + pure `layoutGeometry` + `parseLayout`/`saveLayout`/`loadLayout` + the DOM controller (divider drag, ⤢/⇄/✕, persistence). |
| ★ `webview/claudestub.ts` | THE STUB BACKEND — the swap point (§13). Pure; shared host/harness. |
| ★ `webview/claudebind.ts` | The viewer-side binding dispatch (`bindTypedResult`, `BIND_SIZE_MAX`). |
| ★ `webview/plothost.ts` | Host orchestration, pure + shared: raw-kind interception, validation, the ONE held item, re-push, seek/frame routing, `nFrames()`. |
| `webview/plotmodel.ts` | The pure plot math: scales, `frameToX`/`xToFrame`, `valueToX`/`valueToY`, `pointsFor`, `nearestPoint`, the fixed viewBox constants. |
| `webview/plot.ts`, `webview/plothud.ts` | The plot page (dumb renderer of `plotSeries`/`plotScatter`/`plotFrame`; click→`plotSeek`; `plot-ready`) and its shared skeleton/CSS. |
| ★ `webview/recipes.ts` | The `Mod` union (`Recipe`/`AnalysisMod`), `MOD_PRODUCES`/`MOD_AXES` (the single-source consts), the registry, the mod FILE format (`parseModFile`/`serializeMod`, `MOD_FILE_MAGIC`), and `validateModValues` (incl. the `commands` branch) — the fail-closed gate. Shared by webview, host, bridge, tests. |
| ★ `webview/commands.ts` | `makeAnalysisModHandler`, the `mods` listing's kind·produces display, `/claude`'s registry stub, ctx members (`…Each`, `runAnalysisMod`), `resolveTargetPoints` exported — AND the macro boundary: `runCommandMacro` + `commandMacroRefusal` (pure, §7.6). |
| `webview/main.ts` | Wiring: the claude-bind handler + raw-kind guard, `runAnalysisMod` (round-trip → validate → route → `asyncLine`), `runCommandMod` + the no-op-write validation context, `installMods`, `viewerInfo`/`frameChanged` emission, `seekFrame`, the per-element writer closures. |
| `webview/sets.ts` | (Lower tier, called not forked) — but the **reentrant `beginStroke`/`endStroke` depth counter** (§8) lives here; a macro coalesces to one undo entry through it. |
| `webview/terminal.ts`, `webview/terminalhud.ts` | The `/claude` intercept, event routing to the panel, bind forwarding, the split skeleton, the harness glue (`__TERMINAL_HARNESS__`: stub + plotHost in-page). |
| `src/extension.ts` | The plot panel (`viewerPlot`), plotHost + backend instantiation (on ready signals), relay routes, the `.molaro/mods` loader (skip-and-warn) + `saveWorkspaceMod`, the `rm` delete host action (`modPaths` path-map + reconcile), `modsLoaded` push. |
| `src/hostmessages.ts` | Pure host predicates: `relaysTerminalMessageToViewer` (the terminal→viewer forward-list — the `rm` relay-bug fix, §9) and `resolveModDeletion` (the shared path-map delete discipline). |
| `src/broker.ts`, `webview/transport.ts` | `run_mod` added to the request unions (protocol plumbing only). |
| ★ `producer/serve.py` | The `run_mod` branch: exec + `compute(source, indices)` + the SIGALRM timeout + `{values}|{error, traceback}` replies (list, scatter-dict, and `list[str]` command shapes). |
| ★ `producer/source.py` | The mod-facing `DataSource` — the `labels` accessor (`LabelView`, §7.3) built from the header; neutral, present on the synthetic source. (A domain-only accessor also lives on this base class; it is the domain tier's, not described here.) |
| `.molaro/mods/{index_ramp,frame_metric,xy_metric,color_ab}.py` | The shipped synthetic example mods (scalar→color, series, scatter, `commands` macro). |
| `tests/bridge.ts` | The harness page: loopback type list (incl. `confirm-answer`), sessionStorage state shim, `__HARNESS_MODS__` (real files + the `broken_ramp` fail-closed fixture), the plot surface under the terminal stack. |
| `tests/claude.test.ts`, `tests/plot.test.ts`, `tests/claudelayout.test.ts` | This tier's unit suites (contract, reducer, stub; plot model + plothost; layout model + persistence). |
| `tests/commands.test.ts`, `tests/recipes.test.ts`, `tests/producer_protocol.test.ts`, `tests/hostmessages.test.ts` | This tier's blocks inside shared suites (bind dispatch + mod verbs + `runCommandMacro`; file format + validation + `MOD_PRODUCES` equality; the `run_mod` protocol; the relay-forward + delete-discipline predicates). |
| ★ `tests/redesign.ts` S23–S29, S31 | The neutral E2E scenarios for this tier (§11); S30 is the domain tier's. |

---

## 11. Build, run, test, package

Everything runs from the repo root (`viewer/`). Node 22 executes
TypeScript natively — erasable-only syntax. **⚠ Rebuild before E2E** (the
harness loads `dist/` bundles):

```
npm run typecheck                 # tsc --noEmit, everything incl. tests
npm test                          # the unit suites, node --test
npm run build                     # esbuild → dist/ (main, terminal, plot)
node tests/redesign.ts            # E2E, headless Chrome/CDP (S0–S31)
node tests/redesign.ts S24 S31    # any subset
node tests/terminal_smoke.ts      # the terminal/panel surface over the loopback relay
python3 -m tests.test_roundtrip   # producer wire round-trip
npm run package                   # → bash scripts/package-all.sh (below)
```

`npm run package` no longer emits a single ambiguous bare `.vsix` — it runs
`scripts/package-all.sh`, producing **platform-targeted** VSIXs
(`viewer-0.1.0-<platform>.vsix`). This is a domain-tier concern (the reason
is the assistant's platform-native binary; see
`HANDOFF_fable_assistant.md`), recorded here only because it changes the
package command. A stale bare `.vsix` once masked two briefs' worth of
work by being reinstalled instead of the fresh build — never leave one
around.

At the time of writing: **~322 unit / ~712 E2E (S0–S31) / 105 smoke**, all
green (counts drift; the shapes below are the durable part). This tier's
neutral scenarios — each runnable alone, on the harness's synthetic dataset
(S30 additionally runs against a real dataset via `VIEWER_PYTHON`, a domain
concern):

- **S23** — the panel shell: split/focus, streaming, the approval gate
  (approve/deny), the sentinel error, cancel, both auth states, both
  collapse affordances, transcript-preserved toggles.
- **S24** — typed results, two parts: `"/"` route (injected `claude-bind`
  + a `window.__binds` collector — exact header-order write audit,
  one-stroke undo, the size/opacity mappings, command→selection+undo,
  every no-write error path, THE PIXEL PROOF) and `"/terminal"` (the full
  stub→panel→viewer pipe with ⤷ outcome lines).
- **S25** — the plot tab: draw, one-vertex-per-frame, raw readout, the
  marker at/moving with the frame, click-to-seek, the mismatch no-draw,
  the `plot-ready` re-push restore.
- **S26** — the split layout: default 60/40, divider drag + clamping,
  usable-at-extremes (computed styles), flip, swap-keeps-sizes, a REAL
  reload restoring the exact layout (and proving the transcript did not
  persist), collapse/reopen.
- **S27** — mods: the workspace listing, `index_ramp` end-to-end (INDEX
  ALIGNMENT audit, colormap ends, one-stroke undo, pixel proof), the
  `broken_ramp` fail-closed no-write, `frame_metric` computing in Python
  across every frame and drawing with a live playhead.
- **S28** — scatter: synced draw + moving highlight + exact-index seek on
  the synthetic loop, the static and malformed paths, replacement both
  ways (series⇄scatter), and the `xy_metric` Python mod with the
  overlap-tolerant seek assertion.
- **S29** — `rm`: deleting a workspace mod, y/n-confirmed, the fail-safe
  (a non-`y` answer cancels), the registry/disk reconcile, and that the
  deletion is NOT undoable.
- **S30** — the domain tier's real-dataset reference-mod check (runs only
  with `VIEWER_PYTHON` pointing at an interpreter that has the domain
  packages). Listed for range completeness; its content is domain and
  lives in `HANDOFF_fable_assistant.md`.
- **S31** — `produces: commands`: the synthetic `color_ab` macro runs two
  colorbonds as ONE undo stroke (depth-counter proof), and one Ctrl+Z
  reverses the whole macro.

The smoke (`terminal_smoke.ts`) remains the only automated coverage of
the terminal SURFACE (typing, history, Tab, `/claude` toggling, a scripted
round-trip, the `mods` listing through the real relay). The
real-workbench VSIX probe recipe (documented in the scalar-channel
handoff's lifecycle section) applies unchanged when a change touches
panel lifecycle.

---

## 12. Scope and fences — the next agent inherits these

**This tier owns**: everything in §10's file map — the panel modules, the
typed-result contract and binding, the plot tab, the layout, the mod
system including the producer's `run_mod` branch, this tier's test files
and scenario range, its sections of `docs/COMMANDS.md`, and the
`.molaro/mods` examples.

**Frozen — treat as external API, call and never fork**: the contract/
transport/playback wire (except the `run_mod` request this tier added,
now part of that frozen surface), the address grammar and resolver, the
command registry mechanics, the selection model, the representation
buffers and writer discipline. Resolution parity with `view` is a
founding rule.

**The producer boundary, precisely**: this tier added the `run_mod`
request/response and the code-execution path in `producer/serve.py` —
that plumbing is in scope. **How the dataset is loaded, parsed, or
classified is NOT**, and never will be from this tier: its correctness
must never depend on what the data represents. The `data` handle a mod
receives is opaque here — mods themselves may do whatever their approved
code does, but THIS TIER treats their outputs as uninterpreted numbers,
validates shape only, and maps them to visuals. That indifference is why
the boundary exists and why it held.

**Out of scope — not read, not described, do not widen the fence**: the
producer-side data adapters, the real-dataset correctness harness
(`tests/reference_mods_corpus.py`), the sibling directories
(`benchmark_systems/`, `md-viewer/`), and `README.md` (domain-framed;
link-only) — all of which belong to the domain tier
(`HANDOFF_fable_assistant.md`). All validation in this tier was
synthetic-only (`producer/synthetic.py`). No sandboxing layer (decided:
user-approved code, timeout + validation only). No fifth result kind, no
charting library, no overlaid plot items, no mod parameters beyond the
target, no network anywhere — `source`/`author` stay display-only strings.
And per the top of this doc: no domain interpretation, anywhere, ever.

---

## 13. The swap seam — now filled, and why nothing here changed

The one reserved seam of this tier — **`webview/claudestub.ts` as a
placeholder for a real assistant backend** — **has since been filled.** A
real backend now sits at that boundary in production; the stub remains
behind the `molaro.assistant.useStub` setting and is what every neutral
test in this doc still runs against. The important fact for THIS tier is
what did *not* change: the panel contract, the binding, the plot, the mod
system, and every §8 invariant hold on both sides of the swap, exactly as
designed. The fence held — the stub swapped out and nothing above it moved.

The swap point's shape, unchanged: the backend is created by the host on
the terminal's `claude-ready` signal, receives the frozen panel→backend
commands, emits the frozen backend→panel events (§3.1), and gets
host-supplied context through its options. Everything a backend can DO is
still exactly what the stub could: stream text, propose tools, gate them on
approval, attach typed results the binding routes, and author/delete mod
files through the existing save/`rm` paths.

**What the real backend is — its model, its prompt, its tools, its auth,
its security model, and everything domain-aware — is deliberately NOT this
document's business, and must never leak into it.** That is a separate,
domain-aware document: **`HANDOFF_fable_assistant.md`**. This tier stays
blind to it by design; a future neutral agent extends this tier while
remaining as domain-free as its author. If a change here seems to *need* a
fact about the real backend, the change is on the wrong side of the fence.

**Still reserved, still not designed here:** the neutral tier is now the
thing to GUARD. The typed-result union stays closed at four, the grammar is
sufficient, the binding and undo model are correct. The one known
capability gap — a per-point value that varies per frame (a fifth
result kind, with an `N × T` memory cost) — is described in the domain doc
and must not be designed from this tier. If a task seems to require
changing the union, the grammar, the binding, or the undo model, **stop and
report** — that is the signal that it belongs to a decision, not a patch.
