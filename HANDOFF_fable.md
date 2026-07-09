# HANDOFF — Point Viewer (UI / interaction / rendering layers)

*Written 2026-07-08 against commit `ed790d1` (HEAD == origin/main). Everything
below was verified against the code as written. Audience: an engineer joining
cold, working on the TypeScript frontend. All claims cite files/symbols.*

---

## 1. Project overview

A **VS Code extension** that renders and lets a user interact with **large
time-series 3D point datasets**: N points whose positions change over T
frames, each point carrying a short `type` tag, a two-level grouping hierarchy
(`group` → `subgroup` → point), a `category` label from a small fixed set
(opaque strings), plus any number of named numeric **channels**. Connectivity
comes as **edges** (index pairs) and **polylines** (ordered index paths). What
the data *represents* is deliberately out of scope for this layer — the UI
consumes only abstract typed geometry through a neutral contract. The
reference data source for all development and testing is the **synthetic
producer** (`producer/synthetic.py`).

**Pipeline** (each hop is one process/context boundary):

```
producer (Python, child process)          extension host (Node)            webview (browser context)
serve.py — answers 2 requests    ⇄stdio⇄  src/broker.ts + framing.ts  ⇄postMessage⇄  webview/main.ts
  {header} / {frames,start,count}          length-framed byte relay            Transport (FIFO correlation)
```

- The producer answers exactly two logical requests — a JSON **Header** and
  binary **FrameChunk**s — strictly FIFO over length-framed stdio
  (`producer/serve.py`; stdout is protocol-only, all logging on stderr).
- The extension host (`src/extension.ts`) spawns the producer per panel and
  relays payloads verbatim; `src/broker.ts` owns the child process and
  cross-checks each outer frame length against the envelope's self-described
  size (`frameChunkEnvelopeSize`) as a desync detector.
- The webview does everything else: streaming playback, Three.js rendering,
  and the whole interaction/selection/panel system.

**Interaction model in one paragraph** (the thing most engineering effort went
into): there is **one pending selection** (the "target") built by direct
manipulation in the bottom panel tree and/or the 3D view (both surfaces feed
the *same* set, shown light green in both). A corner button **"Create
selection"** commits it into the top panel section as a named
`CommittedSelection`; committed selections are neutral-colored and are the
things you *operate on* — focus the camera, hide (whole or per-member),
rename, re-open for editing. Hiding is a property of committed selections
(no standalone hidden set), with **show-wins** precedence where selections
overlap. `Ctrl+Z` is a system-wide undo over state changes (never camera).
Bottom = build, top = operate, 3D = navigate + build.

---

## 2. File map

**Read-first (load-bearing)** files are marked ★.

### Neutral contract
| File | Purpose |
|---|---|
| ★ `contract/contract.ts` | Header/FrameChunk types, JSON header parsing, binary envelope decode (zero-copy `Float32Array` views), validation. Zero dependencies. |
| `contract/SPEC.md` | Wire-format spec (v0.1.0) the TS and Python sides both implement. |
| `contract/contract.py`, `contract/fixtures/` | Python twin + committed cross-language fixtures (touched only via tests). |

### Producer (synthetic only — see §7 for scope boundary)
| File | Purpose |
|---|---|
| `producer/source.py` | `DataSource` ABC: `give_header()` / `give_frames(start, count)`. |
| ★ `producer/synthetic.py` | Deterministic synthetic dataset for any N/T; positions are an analytic function of frame index (no materialization). Structured minority (categories `alpha`/`beta`/`gamma`) + a bulk majority (`solvent`, many tiny subgroups). Channels: `mass` (per_point), `time` (per_frame), `energy` (per_point_per_frame). |
| `producer/serve.py` | Long-lived stdio server; length-framed requests/responses, FIFO, `{"error":…}` JSON on invalid requests. |

### Extension host
| File | Purpose |
|---|---|
| `src/extension.ts` | `viewer.open` / `viewer.openFile` commands; creates the webview panel (CSP with nonce), spawns the broker, relays messages both ways. |
| `src/broker.ts` | `ProducerBroker`: child-process lifecycle, framed-stdio parsing, stderr logging, envelope-size cross-check. Deliberately vscode-free (tests drive it directly). |
| `src/framing.ts` | 4-byte-LE length framing (`FrameParser`, `frameMessage`). |

### Webview — streaming & render substrate
| File | Purpose |
|---|---|
| ★ `webview/main.ts` (~1250 lines) | The composition root: scene build, shaders, camera, 3D gestures, panel wiring, playback loop, render bit-flips, test seam. Most changes land here. |
| `webview/transport.ts` | Request/response correlation over `postMessage` (FIFO queue, no ids on the wire); `rejectIfErrorPayload`. |
| `webview/playback.ts` | `StreamingPlayer`: wall-clock playhead (30 fps), 8-frame chunks, 2-chunk lookahead, ≤2 in flight, 256 MB LRU cache, stall-don't-skip, loops. Pure state, no DOM. |
| `webview/representation.ts` | `RepresentationLayer`: per-point base look — flat `color`/`size`/`visible` Float32 buffers the renderer reads. Deliberately minimal/replaceable. |
| `webview/geometry.ts` | Pure helpers: edge/polyline → flat segment indices, bbox. |
| `webview/picking.ts` | CPU picking: `pickPoint` (nearest visible point within a pixel threshold, O(N) per click), `selectionBounds` (centroid+radius for camera framing). `neighborSubgroups` exists but is currently unused by the UI. |
| `webview/hud.ts` | ★ Shared DOM skeleton + ALL layout/feedback CSS (`HUD_CSS`/`HUD_BODY`), used by BOTH the extension host and the test harness so they can't drift. |

### Webview — interaction / selection / panel
| File | Purpose |
|---|---|
| ★ `webview/sets.ts` | The whole selection state model: `Hierarchy`, `NodeSet`, `CommittedSelection`, `SelectionModel` (pending target, committed list, per-member hides, show-wins visibility, carving, undo stack). Pure — no DOM/Three. |
| ★ `webview/tree.ts` | The ONE shared row/gesture engine both panel sections render through: `mountTree` (full hierarchy, virtualized) and `mountEntryList` (flat entry rows); click/hold/trail recognition for BOTH mouse buttons, backtracking, fast-drag interpolation, scroll-during-hold, transient flash helpers. |
| `webview/classification.ts` | Pure tree model from the header (`buildTree`) + relative bulk-category heuristic (`bulkCategories`). |
| `webview/committed.ts` | Top panel section: committed-selection blocks (focus/hide/edit/rename/delete), flat member lists, structural-vs-soft rendering. |
| `webview/brackets.ts` | Bracket overlay in the bottom tree's gutter (pending green + committed neutral/purple), contiguous-run segmentation, layer sizing + scroll clamping. |
| `webview/virtuallist.ts` | Fixed-row-height virtual list (windowed absolute-positioned rows over a spacer; capture-phase scroll listener; `panelrelayout` re-window event). |

### Tests / harness (TypeScript, in scope)
| File | Purpose |
|---|---|
| `tests/bridge.ts` | Serves the REAL webview bundle over HTTP with an `acquireVsCodeApi` shim mapping postMessage→`fetch("/rpc")`, driving the real broker + producer. |
| ★ `tests/e2e_driver.ts` | CDP driver (Node built-in WebSocket, no puppeteer): spawns bridge + headless Chrome (SwiftShader), real mouse/wheel/key input, JS eval, PNG capture. |
| ★ `tests/redesign.ts` | The interaction E2E suite: 9 scenarios S0–S8, 149 checks, screenshots to `reports/redesign/`. THE regression suite for everything in §4. |
| `tests/sets.test.ts` | 27 unit tests for the state model (the fastest way to understand its semantics). |
| `tests/{contract,geometry,framing,playback,producer_protocol,classification,picking}.test.ts` | Unit suites for the substrate (63 tests total via `npm test`). |
| `tests/make_fixtures.py`, `tests/test_roundtrip.py` | Cross-language contract fixtures + Python round-trip check. |
| `tests/sidebar_spotcheck.ts`, `tests/make_openfile_fixtures.py`, `tests/test_file_resolve.py` | Real-data-adjacent utilities — not part of this layer's validation (see §7). |

Not in scope / not documented here: `producer/mdtraj_source.py`,
`producer/domain_rules.py`, `producer/file_resolve.py`,
`producer/CONTRACT_FIT_AUDIT.md`, `tests/acceptance_corpus.py`, the sibling
`benchmark_systems/` and `md-viewer/` directories, and `README.md` (framed in
application-domain terms). I have not read these beyond noticing they exist.

---

## 3. The data contract (what the UI consumes)

Defined in `contract/contract.ts` + `contract/SPEC.md` (v0.1.0). Two messages:

**Header** (JSON, fetched once):
```ts
interface Header {
  version: string; name: string;
  n_points: number; n_frames: number;
  units: string; bbox: {min:[x,y,z], max:[x,y,z]} | null;
  points: {                       // columnar, every array length n_points
    type: string[];               // short per-point tag (display only)
    group_id: number[]; subgroup_id: number[];
    category: number[];           // index into `categories`
  };
  categories: string[];           // small fixed set of opaque labels
  groups: Record<string,string>;  // id (decimal string) → label
  subgroups: Record<string,string>;
  edges: [number, number][];      // index pairs → line segments
  polylines: number[][];          // ordered index paths → chained segments
  channels: Channel[];            // {name, scope, dtype:"float32", min?, max?, data?}
}
```
Validation (`validateHeader`) enforces, among other things, that a subgroup
belongs to exactly one group — so category → group → subgroup → point is a
strict tree. `Hierarchy` (sets.ts) depends on this.

**FrameChunk** (binary envelope, fetched by range `{start, count}`):
`"PCFC"` magic + envelope version + JSON descriptor + 4-byte-aligned float32
blocks. Block 0 is always positions (`count * n_points * 3`, frame-major);
one additional block per `per_point_per_frame` channel. `decodeFrameChunk`
returns **zero-copy** `Float32Array` views into the received buffer (LE only —
it refuses big-endian platforms). `positionIndex`/`channelIndex` are the
index helpers.

Channel scopes: `per_point` (length-N data in the header), `per_frame`
(length-T in the header), `per_point_per_frame` (shipped in every chunk).
**The UI currently renders no channel data** — channels flow through
transport/validation but nothing reads their values for looks (see §7).

Contract, transport, playback protocol, and producer wire format are
**frozen** — treat them as an external API.

---

## 4. How the current system behaves (verified at `ed790d1`)

### 4.1 Layout

`hud.ts` defines: a top status bar; a middle row of dockable panel + drag
divider + 3D canvas (`#app`); a bottom playback bar (play/pause, scrubber,
stats readout). The panel docks to any edge by dragging its grip
(`setupPanelDocking` in main.ts), resizes via the divider, collapses to a
reopen tab; docked top/bottom the content reflows horizontally. Inside the
panel: `#selections` (top section) then `#tree-host` (bottom tree). Two
buttons float in the canvas corner (`#viewer-actions`): **Clear** (two-step
inline confirm — first click arms "sure?" for 3 s) and **Create selection**
(reads **"Done"** during edit mode). There is no instruction/hint text (was
removed deliberately).

### 4.2 Bottom section — the build tree

`mountTree` renders category → group → subgroup → point. Category/group rows
are plain DOM; each group's subgroup/point list is a `VirtualList` (flat
fixed-height item model; drilling a subgroup splices its point rows in).
Category and group rows are **position: sticky** (top 0 / 18 px) so collapse
carets stay reachable when scrolled deep. Expandable carets have an enlarged
20 px hit box (`.caret.exp`) so near-misses expand instead of selecting.

Gestures (`TreeGestures` wiring in main.ts):
- **Left-click** a row → `SelectionModel.toggleInTarget(entry)` — toggles the
  entry in the pending target at the row's own level. Clicking a row that is
  *covered by a coarser entry* **carves** (see §5).
- **Left-drag** → paint. Direction decided at stroke start: starting on a
  selected/covered row **removes** along the path, otherwise adds. Dragging
  **back** reverts only what this stroke changed (`strokeTouched` in main.ts).
  One undo unit per stroke (`beginStroke`/`endStroke`).
- **Right-click** → camera focus on that entry (yellow transient flash on the
  row + in 3D). **Right-drag** → focus the union of the dragged rows; trails
  hold a yellow color until release and shorten when dragged back.
- Trails interpolate between pointer samples at half-row steps (`walkRows`),
  so fast drags skip nothing; **wheel-scrolling while holding extends the
  trail** from the scroll delta (rows sliding under the stationary pointer
  join in crossing order — `processScroll` in tree.ts).

Row visuals: `.sel-covered` = static light-green background (covered by the
target); `.sel-partial` = a thin green edge tick on ancestors of target
entries. Brackets (below) mirror the same coverage in the gutter.

### 4.3 Top section — committed selections

`mountCommitted` renders one block per `CommittedSelection`: header row
(caret, name, point count + hidden counts, `edit`/`✎`/`✕` controls) and a
collapsible body that is a **flat** `mountEntryList` of the stored entries at
their own level — no ancestor hierarchy, no expansion — sorted into the
hierarchy's traversal order (`Hierarchy.compareEntries`), never insertion
order. Rendering is split:
structural changes (ids/names/member counts/edit mode) rebuild; hidden-state
changes update **in place** (`softUpdate`) so feedback animations survive.
Member-list scroll positions are preserved across rebuilds.

Gestures:
- **Left-click** a member row → camera focus (yellow flash; row flashes too).
  Left-click the *name* → focus the whole selection. **Left-hold** (400 ms)
  → frame the whole selection. **Left-drag** → frame the union of dragged
  rows (yellow holds until release; backtracking shortens).
- **Right-click** a member row → toggle that member's individual hide
  (`hiddenPart`); the persistent purple state appearing/disappearing IS the
  feedback (no overlay flash — deliberately, so un-hiding never looks
  *brighter*). **Right-drag** → hide (or un-hide, if started on a hidden row)
  row by row as the pointer crosses, revertible by dragging back, one undo
  unit. **Right-click the header/anywhere else in the block** → toggle the
  whole selection's hidden flag (header flashes purple).
- **edit** → `beginEdit(id)`: the committed set becomes the current target
  (green everywhere), bottom/3D manipulations mutate it, member rows grow a
  `✕`, the corner button reads "Done". While editing, the member list is
  **fixed-height (160 px, scrolling)** so adds/removes never shift the tree
  below mid-gesture, and **the camera is parked** — focus actions still pulse
  but never move the view. `Escape` or "Done" exits (edits persist; each was
  individually undoable).
- **✎ / double-click name** → inline rename (unique names enforced;
  `Escape`/blur cancels, `Enter` applies). **✕** → delete.

### 4.4 3D viewer

Camera: `TrackballControls` (free 360°, gentle inertia), eased tweens for
programmatic moves (`animateCameraTo`; controls disabled during a tween).
Selection granularity is **explicit** — there is no zoom-dependent switching:

- **Left-drag** orbit, **right-drag** pan, **wheel** dolly (unchanged
  navigation).
- **Plain left-click on a point** → focus its subgroup: camera frames it +
  yellow pulse. Never selects.
- **Plain left-click on empty space** → zoom out to frame **what is visible**
  (`frameVisible`: bounds of currently visible points; falls back to the
  whole-scene `resetCamera` when nothing is hidden). Parked during edit mode.
- **Ctrl+left-click** → toggle the picked point's **subgroup** in the target;
  **Ctrl+right-click** → toggle the **point** itself. Ctrl+drag **paints**
  (add-only) at the button's granularity. A capture-phase pointerdown on
  `#app` disables TrackballControls before its own handler runs, so Ctrl
  gestures never orbit. Ctrl-clicking an already-covered node carves/removes.
- Picking is CPU-side (`pickAt` → `picking.ts pickPoint`), nearest *visible*
  point within `PICK_PIXEL_THRESHOLD = 12` px; click-vs-drag is
  `CLICK_MOVE_THRESHOLD = 5` px.

### 4.5 Keys

Global `keydown` (ignored while typing in inputs): **Escape** exits edit mode,
else clears the pending target (undoable). **Ctrl/Cmd+Z** undoes one state
change. There is **no redo**.

### 4.6 Rendering of state

Three-then-two extra draw passes share ONE position attribute (`buildScene`):

1. Base points: shader reads `RepresentationLayer` buffers; `aVisible < 0.5`
   collapses/discards the vertex.
2. Edges + polylines: one indexed `LineSegments` each; `rebuildLines()`
   re-trims draw ranges to segments whose **both** endpoints are visible.
3. Pending-target overlay (`highlightMaterial`): flat light-mint discs
   (`SELECTION_COLOR = 0xbfffe4`) over targeted & visible points; `uStrength`
   breathes on the CPU each frame (period `GREEN_PULSE_PERIOD_MS = 1600`).
   Committed selections have **no** persistent viewport color.
4. Focus flash (`focusFlashMaterial`): one-shot light-yellow pulse
   (`FOCUS_COLOR = 0xffe9a8`, `FOCUS_FLASH_MS = 900`) over the last-focused
   region; reads `aSel` and **blends 50 % toward the selection mint on
   selected points** so a flash over green never hard-swaps color.

**Hidden wins visually**: both overlays gate on `aVisible`, so a hidden point
never shows green/yellow even if targeted/focused.

The single state→pixels function is `refreshPoints(points)` in main.ts: for
exactly the affected indices it recomputes `selArray[p] =
model.targetContains(p)` and `visible[p] = !model.isPointHidden(p)`, flags
attribute uploads, and rebuilds lines only if visibility actually changed.
Every model mutator returns the affected point indices to feed it.

### 4.7 Panel feedback motion (one standard)

All row/header feedback is a single `background-color` transition (320 ms
ease) — **no keyframe animations**. Consequences (all deliberate):
- Rows that mount already-stateful (scroll back into view, expand a subtree)
  render their color **statically** — no entrance replay.
- Removing a state fades out through the same motion (reverse).
- A color landing on an already-colored row cross-fades; explicit blend
  combos exist for yellow⊕green, purple⊕green, yellow⊕purple (hud.ts).
- Transient flashes are timed classes (`flashRow`, 480 ms hold then removal);
  trail holds (`-hold` classes) persist until release. Cascade order:
  transient rules first, persistent states above them, blends last — so a
  state change is never masked by a passing flash.
- Purple = hidden (member rows `.hidden-entry-row`, block/label styling);
  green = selected; yellow = camera focus. Purple uses the same alphas and
  timing as the others (this took several passes to get right — see git log).

### 4.8 Brackets

`mountBrackets` draws non-interactive vertical spans in the bottom tree's
30 px gutter (`BRACKET_GUTTER_PX`), inside the tree host so they scroll with
content. One green (pulsing opacity) bracket set for the pending target; one
neutral (purple when hidden) set per committed selection, on auto-assigned
lanes (5 px each, `MAX_BRACKET_LANES = 4`; names on hover via `title`).
Spans cover only **visible rows at or below the entries' level**
(`coversEntry`; ancestors never carry brackets — collapsed regions show no
bracket) and split into one segment per **contiguous** run, so carving a hole
visibly breaks the bracket. The layer re-measures with itself zeroed first
(sizing feedback-loop fix) and clamps `#sidebar-content.scrollTop` back into
range when content shrinks.

### 4.9 Visibility semantics (SHOW WINS)

`SelectionModel.isPointHidden(p)`: a point is hidden **iff** at least one
committed selection hides it (whole `hidden` flag, or the point is in its
`hiddenPart`) **and no visible committed selection covers it**. Points covered
by no selection are visible. Consequences: a selection committed inside a
hidden region shows through; an older fine-grained visible selection survives
hiding a newer broad one; per-member hides work while only their own selection
covers the points. Trade-off (accepted deliberately): hiding a selection whose
points are entirely covered by another *visible* selection has no visual
effect until that coverer is hidden too.

### 4.10 Startup defaults

Nothing is hidden at startup. For each **bulk** category (relative heuristic
in `classification.ts`: ≥30 % of all points ∧ avg subgroup ≤12 points ∧
absolute floors) `model.seed(label, [category entry])` creates a pre-made
**visible** committed selection named by the category's own label — so hiding
the environment is one right-click. Seeds are initial state, not undoable.
With the default synthetic dataset (`--n-points 6000`), `solvent` (4 800 pts,
1 600 subgroups) is the one bulk category.

### 4.11 Playback

`StreamingPlayer` + the display loop in main.ts: single-frame datasets
(`n_frames <= 1`) disable the controls; otherwise play/pause + a two-way-bound
scrubber (`userScrubbing` guard). Positions stream zero-copy: the display loop
points the shared position attribute at a subarray of the cached chunk.

---

## 5. State model & key data structures (`webview/sets.ts`)

```
Entry            { level: "category"|"group"|"subgroup"|"point", id: number }
Hierarchy        built once from the Header: byCategory/byGroup/bySubgroup maps,
                 subgroupOfPoint, ancestorsOfSubgroup, pathOf(entry) (ancestors+self),
                 pointsOf(entry), childrenOf(entry), labels.
NodeSet          ONE set of entries + a reference-counted resolved point set:
                 countArr[p] = number of entries covering p; covered iff > 0.
                 Mutators (add/remove/toggle/addMany/clear) return the affected
                 point indices; onChange() for UI.
CommittedSelection { id, name (unique), set: NodeSet, hidden: boolean,
                 hiddenPart: NodeSet (individually hidden members ⊆ set),
                 lane: number (bracket lane) }
SelectionModel   pendingSet + committedList + editingId + undoStack.
```

Key `SelectionModel` semantics (all unit-tested in `tests/sets.test.ts`):

- **`target`** = the edited selection's set when `editing`, else the pending
  set. All build gestures (`toggleInTarget`/`addToTarget`/`removeFromTarget`)
  write to it and are undoable.
- **Carving**: `removeFromTarget(e)` on a node that is not an entry but is
  covered by ancestor entries replaces every covering ancestor with its
  complement down to `e`'s level (`carveFromTarget`, using
  `Hierarchy.childrenOf`) — one composite undo op. `toggleInTarget` routes
  covered rows to removal, so "click a covered row" always means unselect.
- **Strokes**: `beginStroke()`/`endStroke()` coalesce the ops between them
  into ONE undo entry (used by every drag).
- **`commit()`**: moves the pending `NodeSet` wholesale into a new
  `CommittedSelection` (auto-name = smallest free `selection_N` — numbering
  restarts when names are freed) and swaps in a fresh pending set. Undo swaps
  the ORIGINAL set object back so earlier undo ops still bind to it.
- **Edit mode**: `beginEdit`/`endEdit` redirect `target`; mode switches are
  NOT undoable (the edits inside are). Pending content is kept aside and
  restored on exit. Removing a member also drops its `hiddenPart` entry in
  the same undo op.
- **Hides**: `setHidden(id, …)` (whole), `setEntryHidden(id, e, …)` /
  `toggleEntryHidden` (member; only members can be part-hidden),
  `setEntriesHidden` (batch, one stroke). Visibility precedence in
  `isPointHidden` — see §4.9.
- **Undo** (`undo()`): pops one `UndoOp`, whose closure reverts state and
  returns affected point indices. Everything user-visible is covered except
  camera moves and edit-mode toggles.
- Row-coverage queries used by decoration/brackets: `coversEntry(set, e)`
  (self-or-ancestor in set), `targetCoversEntry`, `touchKeys(set)` (path keys
  of all entries — drives `.sel-partial`).

**Input → state → render flow**: gesture (tree.ts engine or 3D handlers) →
`SelectionModel` mutator → affected point indices → `refreshPoints` flips
`selArray`/`visible` bits → attribute re-upload next frame; in parallel
`model.onChange` → `bottomTree.refresh()` (row classes), `committed.render()`
(structural-or-soft), `brackets.schedule()` (rAF re-layout), commit/clear
button state.

The gesture engine itself (`createRowEngine` in tree.ts) is worth reading
once: per-button "arms" with a 5 px drag threshold and 400 ms hold timer,
ordered trails with backtrack-pop, `walkRows` pointer interpolation,
scroll-delta trail extension, hold-class relinking when virtualized rows
re-mount mid-gesture, and `flashRow` (timed transient classes).

---

## 6. Run, build, test

Environment: Node 22 (native TS execution — **erasable syntax only**: no
enums, no ctor parameter properties), Python 3.9+ with numpy for the
producer, `google-chrome` + `DISPLAY` for E2E. Everything below runs from
`viewer/`.

```bash
npm run build        # esbuild: dist/extension.cjs + dist/webview/main.js
npm run typecheck    # tsc --noEmit  (also: npx tsc --noEmit)
npm test             # 63 unit tests via node --test (8 suites, see package.json)
python3 -m tests.test_roundtrip   # cross-language contract fixtures (5 checks)
```

**Run the extension**: F5 in VS Code (extension dev host), or package+install:
`npx @vscode/vsce package && code --install-extension viewer-0.1.0.vsix
--force`, then "Point Viewer: Open" (defaults: synthetic N=20 000, T=600;
args `{nPoints, nFrames, seed}` via `viewer.open`).

**Headless E2E / screenshot validation** (the important one):

```bash
npm run build && node tests/redesign.ts          # all scenarios S0–S8
node tests/redesign.ts S3 S8                     # subset
```

`redesign.ts` spawns `bridge.ts` (real broker + real synthetic producer behind
HTTP, `acquireVsCodeApi` shim, `test:true` seam flag) and headless Chrome with
SwiftShader (`--enable-unsafe-swiftshader --use-angle=swiftshader` — required
for the 3D canvas to composite), drives real CDP input (mouse, right-button,
Ctrl modifiers = `2`, wheel, keys), asserts against the DOM and the test seam,
and writes PNGs to `reports/redesign/` (gitignored). 149 checks currently, all
green. Scenario map: S0 startup/seeding, S1 bottom build+carve+focus, S2
commit/top-section/edit/rename, S3 3D gestures+visible-framing, S4
undo/escape, S5 pulses/hidden-wins/brackets, S6 docking, S7 sticky
ancestors+scroll-paint, S8 split brackets/member-hide/clear/precedence.

**Test seam**: when the harness sets `window.__VIEWER__.test`, main.ts exposes
`window.__viewer` = `{camera, controls, player, rep, hierarchy, model,
actions, refreshPoints, focusPoints, focusEntry, zoomToPoints, resetCamera,
applyResize, setPlaying, panel, debug}` where `debug` has `selCount()`,
`visibleCount()`, `flashCount()`, `pulse()`, `pick(x,y)`,
`projectPoint(idx)`, `visibleBounds()`. The production extension never sets
the flag.

E2E gotchas learned the hard way (encoded in the suite):
- Row rects go stale whenever the top section changes height — **always
  re-query row coordinates after any layout-affecting action**.
- The green **commit button sits inside `#app`**, so canvas pixel checks crop
  below y+60 (see `greenCount` in redesign.ts); the greenish classifier for
  the light-mint tint is `g > r+25 && g >= b`.
- Ctrl+right-clicking a point already covered by the target **carves** —
  probe an uncovered point (via `debug.pick(x,y) === p`) when the test wants
  a plain add.
- CDP synthesizes no keyboard events for mouse modifiers; the app's
  Ctrl-detection is pointer-event-based (`e.ctrlKey` + capture-phase
  disable), which is why `modifiers: 2` works.

---

## 7. Known issues, rough edges, deliberate boundaries

**Deliberately not built / out of scope for this layer**
- **Channels are plumbed but unused**: no UI reads channel values for color/
  size/anything. `representation.ts` is a stub base look (uniform white,
  size 3) explicitly designed to be replaced by a richer styling layer later.
- No redo (`Ctrl+Shift+Z`) — undo only, by decision.
- `picking.ts neighborSubgroups` is dead code kept for a future feature.
- The domain data-source adapter files, real-dataset tests
  (`tests/acceptance_corpus.py`), and sibling directories are **out of scope**
  — I have not read them; all validation this cycle was synthetic-only, and
  the corpus suite has NOT been run against the redesigned UI.
- `README.md` is written in application-domain terms and was intentionally
  neither used nor updated.

**Rough edges I know about**
- **Show-wins trade-off**: hiding a selection fully covered by another
  *visible* selection changes nothing on screen (its label still turns
  purple). Inherent to the precedence rule; flagged to the owner, accepted.
- **Carving a huge coarse entry materializes its complement**: carving one
  subgroup out of a selected bulk category creates ~1 599 subgroup entries;
  the model handles it, but the top section renders that flat member list
  without virtualization (`mountEntryList` is plain DOM) — a committed
  selection with thousands of entries will make its expanded body slow.
- **Bracket lanes cap at 4** (`MAX_BRACKET_LANES`); >4 overlapping selections
  reuse lanes (visual collision). Lanes are auto-assigned only (dragging was
  removed on request).
- Per-point entries from heavy Ctrl+right painting accumulate one entry per
  point; fine at current scales, no aggregation.
- `pickAt` is O(N) per click — fine at N≈250 k per the original budget; a
  GPU pick or spatial index is the known next step if it ever hurts.
- The `.sel-body` fixed height in edit mode is a constant 160 px (mostly
  empty for small selections) — deliberate, for layout stability.
- Playback stats readout only updates for multi-frame datasets; static
  datasets show a fixed label.

**Fixed-but-worth-knowing history** (so you don't re-break them): the bracket
layer must be sized with itself zeroed first (`layout()` in brackets.ts) or
collapsed trees strand blank scroll space; tree expanders must dispatch
`panelrelayout` or virtual lists keep stale windows; the top section must
soft-update hidden state in place or feedback animations die mid-render;
`.tree-label` must flex or trailing row controls drift under mid-row clicks.

---

## 8. Conventions & gotchas

- **Node-22-native TypeScript everywhere** (tests run `.ts` directly via
  `node --test`): erasable-only syntax — no enums, no parameter properties,
  type-only imports where possible. The webview bundle is built by esbuild.
- **Purity layering is strict**: `sets.ts`, `classification.ts`,
  `picking.ts`, `geometry.ts`, `playback.ts`, `contract.ts` have no DOM/Three
  imports and are unit-tested in Node. DOM lives in `tree.ts`,
  `committed.ts`, `brackets.ts`, `virtuallist.ts`, `hud.ts`; Three.js only in
  `main.ts`. Keep it that way.
- **All state mutations flow through `SelectionModel` and return affected
  point indices**; the only place indices become pixels is
  `refreshPoints` in main.ts. If you add a mutator, return the indices and
  push an `UndoOp` (or use strokes), or undo will silently miss it.
- **`hud.ts` is shared by the extension host AND the test bridge** — change
  DOM/CSS there only, never fork it, or the harness diverges from production.
- **Feedback motion**: never add keyframe animations to rows; add state
  classes and let the shared 320 ms background-color transition move them
  (see §4.7 cascade-order rules — transients before states before blends).
- **CSP**: the webview is `default-src 'none'` with nonced script/style —
  no external resources, no inline handlers.
- Producer protocol invariant: **stdout is bytes-only**; `serve.py` rebinds
  `sys.stdout` to stderr after capture so stray prints can't corrupt framing.
- The 5 px click-vs-drag threshold and the 20 px caret hit boxes are load-
  bearing UX decisions (jitter-proof clicks); don't shrink them casually.
- Evidence discipline: `reports/` is **gitignored** on purpose — the tests
  are the durable proof; PNGs are regenerated output. Commit messages carry
  the behavioral changelog; the git log from `09449db` (redesign base) to
  HEAD reads as a design history of the interaction model.
- Repo root is `viewer/` itself (`github.com/DomFico/molaro`, branch `main`);
  the parent folder and its sibling directories are not part of the repo.
