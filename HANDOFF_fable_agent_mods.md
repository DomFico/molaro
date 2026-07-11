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
                produces: "per-point-scalar" | "per-frame-series" | "scatter",
                axis?: "color"|"size"|"opacity",   // required iff per-point-scalar
                code: string }                     // PYTHON, executed in the producer
```

`produces` is **the routing key**: an analysis mod's validated output is
packaged as a `TypedResult` of the declared kind and handed to §5's
binding layer VERBATIM — no new binding, no new renderer. `command` is
deliberately NOT a `produces` value (a mod that emits a command string is
a macro — out of scope, decided, don't add it). `origin` gained
`"workspace"`; it is ASSIGNED by the loader, never read from a file.
`author`/`source`/`description` remain display-only opaque strings —
nothing fetches or resolves them.

`mods` lists everything, grouped by origin:
`name — representation · point-color · by … · …` /
`name — analysis · per-point-scalar → color · by …` /
`name — analysis · scatter · by …`.

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
path a later authoring step uses; there are no edit/delete commands.
**Mods are the only thing persisted by this feature.** Built-ins
(`rainbow`) stay code-registered. `.molaro/**` is excluded from the VSIX —
it is user-workspace data, not extension content; the repo ships three
examples (`index_ramp`, `frame_metric`, `xy_metric`) that appear when this
repository itself is the open workspace.

### 7.3 The Python compute contract

```python
def compute(data, target_indices):
    """
    data           — the dataset handle already RESIDENT in the producer
                     (data.give_header().n_frames / .n_points;
                      data.give_frames(start, count) — positions are
                      frame-major little-endian float32 BYTES; decode with
                      struct.unpack_from, see the shipped examples)
    target_indices — list[int]: the resolved point set in HEADER ORDER
                     (empty list = the whole dataset, by contract)
    returns        — list[float]  (per-point-scalar: one per target index,
                                   each in [0,1] — the mod owns its own
                                   normalization;
                                   per-frame-series: one per frame, raw)
                  — OR, produces: scatter ONLY, the one widened shape:
                     {"x": [...], "y": [...], "frames": [...]?,
                      "xLabel": str?, "yLabel": str?}
    """
```

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

---

## 8. The invariants — rules a change must not break

1. **Fail-closed, no-partial-write, everywhere.** Every path from a typed
   result or a mod return to a visible change validates first and applies
   all-or-nothing. Error paths are byte- and depth-identical no-ops.
2. **The typed-result union is CLOSED at four**, and `produces` at three.
   An unknown kind errors; nothing guesses. Widening either means visiting
   every closure point (§10) in one change.
3. **The panel↔backend contract is frozen.** The backend swaps behind it
   (§13); the panel never grows backend-specific behavior.
4. **This tier reuses the rails, never re-implements them**: resolution =
   the exported `resolveTargetPoints` (view's loop); representation writes
   = the per-element writers (one `recordOp` stroke, LWW, own buffer, GPU
   sync in the writer); commands = `runCommand`. One undo stack, ever.
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
10. **Only the bare forms create/destroy**: mods load at startup and save
    through `saveWorkspaceMod`; there is no edit/delete surface. Files
    cannot shadow built-in verbs.

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
| ★ `webview/recipes.ts` | The `Mod` union (`Recipe`/`AnalysisMod`), the registry, the mod FILE format (`parseModFile`/`serializeMod`, `MOD_FILE_MAGIC`), and `validateModValues` — the fail-closed gate. Shared by webview, host, bridge, tests. |
| `webview/commands.ts` | This tier's additions only: `makeAnalysisModHandler`, the `mods` listing's kind·produces display, `/claude`'s registry stub, ctx members (`colorPointsEach`, `sizePointsEach`, `opacityPointsEach`, `runAnalysisMod`), `resolveTargetPoints` exported. |
| `webview/main.ts` | Wiring: the claude-bind handler + raw-kind guard, `runAnalysisMod` (round-trip → validate → route → `asyncLine`), `installMods`, `viewerInfo`/`frameChanged` emission, `seekFrame`, the per-element writer closures. |
| `webview/terminal.ts`, `webview/terminalhud.ts` | The `/claude` intercept, event routing to the panel, bind forwarding, the split skeleton (`#term-stack`/`#claude-root`/`#claude-divider`/`#term-root`), the harness glue (`__TERMINAL_HARNESS__`: stub + plotHost in-page). |
| `src/extension.ts` | The plot panel (`viewerPlot`), plotHost + stub instantiation (on ready signals), relay routes (`claude-bind`/`claude-bind-result`, viewer-posted plot binds), the `.molaro/mods` loader (skip-and-warn) + `saveWorkspaceMod`, `modsLoaded` push. |
| `src/broker.ts`, `webview/transport.ts` | `run_mod` added to the request unions (protocol plumbing only). |
| ★ `producer/serve.py` | The `run_mod` branch: exec + `compute(source, indices)` + the SIGALRM timeout + `{values}|{error, traceback}` replies (list and scatter-dict shapes). |
| `.molaro/mods/{index_ramp,frame_metric,xy_metric}.py` | The three shipped synthetic example mods (scalar→color, series, scatter). |
| `tests/bridge.ts` | The harness page: loopback type list, sessionStorage state shim, `__HARNESS_MODS__` (real files + the `broken_ramp` fail-closed fixture), the plot surface under the terminal stack. |
| `tests/claude.test.ts`, `tests/plot.test.ts`, `tests/claudelayout.test.ts` | This tier's unit suites (contract, reducer, stub; plot model + plothost; layout model + persistence). |
| `tests/commands.test.ts`, `tests/recipes.test.ts`, `tests/producer_protocol.test.ts` | This tier's blocks inside shared suites (bind dispatch + mod verbs; file format + validation matrices; the `run_mod` protocol incl. the live timeout). |
| ★ `tests/redesign.ts` S23–S28 | The E2E suite for this tier (§11). |

---

## 11. Build, run, test, package

Everything runs from the repo root (`viewer/`). Node 22 executes
TypeScript natively — erasable-only syntax. **⚠ Rebuild before E2E** (the
harness loads `dist/` bundles):

```
npm run typecheck                 # tsc --noEmit, everything incl. tests
npm test                          # 13 unit suites, node --test
npm run build                     # esbuild → dist/ (main, terminal, plot)
node tests/redesign.ts            # E2E, headless Chrome/CDP (S0–S28)
node tests/redesign.ts S24 S28    # any subset
node tests/terminal_smoke.ts      # the terminal/panel surface over the loopback relay
python3 -m tests.test_roundtrip   # producer wire round-trip
npm run package                   # → viewer-0.1.0.vsix
code --install-extension viewer-0.1.0.vsix --force
```

At the time of writing: **257 unit / 680 E2E / 105 smoke**, all green
(counts drift; the shapes below are the durable part). This tier's
scenarios — each runnable alone, all on the harness's synthetic N=6000,
T=150 dataset:

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
producer-side data adapters, real-dataset tests
(`tests/acceptance_corpus.py`), the sibling directories
(`benchmark_systems/`, `md-viewer/`), and `README.md` (domain-framed;
link-only). All validation in this tier was synthetic-only
(`producer/synthetic.py`). No sandboxing layer (decided: user-approved
code, timeout + validation only). No fifth result kind, no charting
library, no overlaid plot items, no mod parameters beyond the target, no
network anywhere — `source`/`author` stay display-only strings. And per
the top of this doc: no domain interpretation, anywhere, ever.

---

## 13. The next direction — the swap seam, described neutrally

Exactly one reserved seam remains, and it was built to be swapped:
**`webview/claudestub.ts` is a placeholder for a real assistant backend.**

The swap point's shape, all of which already exists and none of which
changes: the backend is created by the extension host on the terminal's
`claude-ready` signal, receives the frozen panel→backend commands
(`user-message` / `approval-decision` / `cancel`), emits the frozen
backend→panel events (§3.1) over the same relay, and gets host-supplied
context through its options (today: `frameCount()`). Everything a backend
can DO is already expressible: stream text, propose tools, gate them on
approval, and attach typed results that the binding layer routes — plus
authoring **mod files** through the existing save path
(`saveWorkspaceMod` serializes an `AnalysisMod` to `.molaro/mods/`,
where the startup scan and the own-verb registration already make it
runnable and `mods` already attributes it).

What the real backend computes, how it is prompted, and what its tools
are named is deliberately NOT this document's business — the panel, the
contract, the binding, the plot, and the mod system are all indifferent
to it, and a future agent on this tier needs only the guarantee that the
contract and the fences above hold on both sides of the swap. Do not
design past the seam: no credential flows, no network plumbing, no
contract extensions "for the real backend" — when it arrives, it speaks
the contract that is already frozen, or the swap has failed.
