# Molaro

A modular, agent-ready streaming 3D viewer and analysis environment for
molecular dynamics simulations — in VS Code, over SSH.

Built for **Built with Claude: Life Sciences** (Build track), a virtual hackathon
by Anthropic in partnership with Gladstone Institutes.

**Who it's for:** computational chemists and biophysicists running MD simulations
on remote HPC clusters, who need to triage trajectories in-editor without the
download-and-convert dance.

## Status (honest)

**Works today:**
- A **neutral streaming data contract** — positions, connectivity, grouping,
  labels, and numeric channels; zero appearance information — shared byte-for-byte
  between a Python producer and a TypeScript renderer.
- **Live transport + playback** — the extension host spawns the producer and
  relays a length-framed request/response protocol to a CSP-safe webview that
  streams and animates frames with prefetch and bounded backpressure (validated
  to a synthetic ceiling of ~250k points × 2,500 frames with flat memory).
- A **real mdtraj-backed data source** that reads actual MD trajectory files and
  maps them onto the same contract, **validated on 9 benchmark systems** spanning
  file formats and molecular edge cases (units, periodic wrapping, coarse-grained
  beads, virtual sites, membranes, nucleic/protein backbones).

**Direction being built:** an **agent-driven analysis and visualization layer** —
letting a Claude agent drive selection, styling, and analysis over the neutral
contract. This layer is *not wired up yet*; the contract was deliberately designed
to carry every number such a layer would need while staying appearance-free, so it
can be added without touching the producer or renderer.

Open source under the [MIT License](LICENSE).

---

## Architecture — a VS Code extension in two decoupled halves

Molaro visualizes large time-series 3D point datasets, built as two decoupled
halves:

- **Producer** (Python, `producer/`) — knows where the data comes from and how it
  is grouped and labeled. Serves it in a structured form.
- **Renderer** (TypeScript, `webview/`) — draws exactly what it's told and knows
  nothing about the data's origin.

The two halves communicate **only** through the typed contract in `contract/`.

**Increment 0** built that contract and proved both languages agree on the wire
format, byte for byte. **Increment 1** drew the first pixels: a CSP-safe webview
panel rendering frame 0 from fixture files, with camera orbit/zoom/pan.
**Increment 2** made the stream real: the webview talks to a **live producer
process** and gains **playback** — play/pause, a frame scrubber, and a
prefetching, bounded chunk cache. **Increment 3** (current) adds the **real data
source**: a `DataSource` that reads actual molecular-dynamics trajectory files
(via mdtraj) and emits the *exact same* contract — swapped in behind the existing
interface with **nothing downstream changed**. Transport, playback, and the
renderer never learn the data is molecular. Still the flat look, still no data
interaction and no channel-driven styling.

## Running the extension

```bash
cd viewer
npm install          # build tooling + three.js (bundled locally; nothing at runtime)
npm run build        # dist/extension.cjs + dist/webview/main.js
```

Then open the `viewer/` folder in VS Code and press **F5** (launch config
included), or run `code --extensionDevelopmentPath=$PWD`. In the Extension
Development Host, run **“Point Viewer: Open”**. The panel spawns the producer
(needs `python3` + numpy), streams the header and frame chunks, and the bottom
bar gives play/pause, a scrubber over all frames, and a live readout (frame,
display fps, cache MB/chunks, in-flight requests, stalls). Closing the panel
terminates the producer. Default dataset is N=20,000 / T=600; for other sizes:
`vscode.commands.executeCommand("viewer.open", { nPoints: 250000, nFrames: 2500 })`.
Producer stderr logs appear in the "Point Viewer Producer" output channel.

### Opening a real dataset (Increment 3)

The producer serves synthetic data by default; point it at real trajectory files
instead. mdtraj lives in a dedicated conda env, so real datasets spawn the
producer under an mdtraj-capable interpreter (set `VIEWER_PYTHON`, or pass
`pythonPath`):

In the examples below, `$MDTRAJ_PYTHON` is the path to an interpreter with
mdtraj installed (e.g. a conda env: `.../envs/mdbench/bin/python`) and
`$CORPUS` is the path to a local checkout of the benchmark corpus (an external
test asset, not shipped with this repo).

```js
// A benchmark corpus system by id:
vscode.commands.executeCommand("viewer.open", {
  system: "09_nucleic_duplex",
  pythonPath: "$MDTRAJ_PYTHON",
});
// Or an explicit topology (+ optional trajectory) path:
vscode.commands.executeCommand("viewer.open", {
  topology: "/path/system.pdb", trajectory: "/path/traj.xtc",
  ligandResidues: ["BNZ"], pythonPath: "$MDTRAJ_PYTHON",
});
```

## Increment 3 design: the real data source

The real source (`producer/mdtraj_source.py`) is a **translation only** — it maps
molecular concepts onto the contract's existing neutral slots and emits nothing
molecular downstream. The contract is unchanged.

| Contract slot | From (mdtraj) |
|---|---|
| point | atom |
| `type[]` | element symbol (fallback atom name) |
| `group_id[]` | chain — falls back to `segment_id` when chains are blank/degenerate |
| `subgroup_id[]` | residue |
| `category[]` | 5-class {polymer, ligand, ion, solvent, unknown} |
| `edges[]` | bonds (cross-box PBC bonds suppressed) |
| `polylines[]` | backbone traces (protein `CA`; nucleic `P`→`C4'`; else none) |
| `units` | `nm` (mdtraj normalizes every format) |
| `channels` | deferred — empty this increment |

All molecular vocabulary is confined to `producer/mdtraj_source.py` +
`producer/domain_rules.py`. The classification aliases/ladder and trace anchors in
`domain_rules.py` are **vendored verbatim** from the benchmark corpus's proven
definitions (`_lib/composition.py` and the reference viewer's trace rule); the
acceptance harness asserts our per-atom classifier equals the corpus's
`classify_composition` on all 9 systems, so they cannot silently drift.

**Ten known hard cases** (only real data triggers them) and where each is handled
are catalogued in [`producer/CONTRACT_FIT_AUDIT.md`](producer/CONTRACT_FIT_AUDIT.md),
the Phase-1 contract-fit audit. Headlines: mdtraj normalizes CHARMM/NAMD Å to nm
(no 10× trap); a 0.3 nm bond cutoff suppresses only genuine cross-box wraps
(kept: a 0.208 nm disulfide; dropped: 7 membrane bonds up to 8.6 nm); methanol
(`MOH`) is *not* hidden as common solvent while water aliases are; CG bead systems
with no `CA`/`P` degrade to no trace; and the membrane's blank chain falls back to
`segment_id` grouping — which also settled the one contract-shape question (two
grouping levels suffice; segment substitutes for a blank chain rather than adding
a third axis).

Frame access loads the full coordinate set once and slices ranges from it — fine
for the corpus (modest frames; the one 222k-atom system has a single frame).
Out-of-core seeking reads for genuinely huge real trajectories are noted as a
future optimization, not built.

### Corpus acceptance (the definition of done)

`tests/acceptance_corpus.py` runs the real source on all 9 benchmark systems,
validates each Header + FrameChunk against the contract, and cross-checks point
counts and category composition against each `manifest.json` (plus grouping and
connectivity against the authoritative mdtraj topology). Run it with the
mdtraj env and the corpus root:

```bash
VIEWER_CORPUS_ROOT=$CORPUS \
  $MDTRAJ_PYTHON -m tests.acceptance_corpus
```

**Result: 9/9 PASS.** Each system's contract output validates, matches its
manifest, and renders in the viewer (headless screenshots via the bridge below
confirmed the 19,393-atom DNA duplex playing at 30 fps and the 222,227-atom
membrane single frame — both with clean consoles, no cross-scene PBC lines).

| System | N | T | edges | polylines | hard case it retires |
|---|---|---|---|---|---|
| 01 alanine_dipeptide | 1,291 | 150 | 867 | 0 | baseline solvated |
| 02 trpcage_atomistic | 4,810 | 150 | 3,308 | 1 | protein CA trace |
| 03 adk_psf_dcd | 3,341 | 98 | 3,365 | 1 | Å→nm unit normalization |
| 04 ligand_custom_solvent | 2,302 | 120 | 1,921 | 0 | ligand tag + methanol not-hidden |
| 05 macrocycle_disulfide | 72 | 150 | 72 | 1 | non-sequential ring bond kept |
| 06 membrane_complex | 222,227 | 1 | 50,488 | 8 | blank-chain→segment, PBC suppress, huge N |
| 07 coarse_grain_martini | 46 | 1 | 0 | 0 | CG beads: no trace, graceful |
| 09 nucleic_duplex | 19,393 | 120 | 13,178 | 2 | nucleic P trace, multi-chain |
| 10 tip4p_virtualsites | 2,004 | 100 | 1,002 | 0 | massless virtual sites round-trip |

To watch one play end-to-end (real broker + real mdtraj producer, no VS Code):

```bash
VIEWER_CORPUS_ROOT=$CORPUS node tests/bridge.ts \
  --port 8940 --system 09_nucleic_duplex \
  --python $MDTRAJ_PYTHON
# then open http://127.0.0.1:8940/
```

## Increment 2 design: transport + playback

**Three participants, two hops.** The webview can only postMessage; the
extension host is the broker that spawns the producer and owns its stdio; the
producer is a long-lived Python process. A frame request flows
webview → postMessage → host → stdin → producer → stdout → host → postMessage →
webview.

**Framing.** Every pipe message (both directions) is a 4-byte little-endian
length prefix + payload ([src/framing.ts](src/framing.ts) reassembles messages
across arbitrary stream splits; property-tested at every split point). Requests
are small JSON (`{"type":"header"}`, `{"type":"frames","start":s,"count":c}`);
responses are the Header JSON or a FrameChunk envelope, strictly FIFO. The
envelope is self-describing, so the broker cross-checks the outer frame length
against the envelope's computed size — a cheap desync detector. **Producer
stdout is protocol-only**: all logging goes to stderr, and `serve.py` rebinds
`sys.stdout` to stderr after capturing the protocol channel so even a stray
`print()` can't corrupt the stream. The host relays payloads to the webview as
typed arrays (VS Code's binary postMessage path, not JSON); the webview
correlates responses to requests by FIFO order ([webview/transport.ts](webview/transport.ts)).

**Playback + backpressure** ([webview/playback.ts](webview/playback.ts), all
bounds explicit): the playhead advances on a wall clock at 30 fps (constant),
requesting 8-frame chunks with a 2-chunk lookahead window, at most 2 requests in
flight, into an LRU cache capped at 256 MB (window chunks are never evicted). If
the next frame's chunk isn't cached the playhead **stalls** — holds the current
frame with the clock frozen (no time debt) until the chunk arrives; it never
skips missing data and never grows a queue. A slow render loop advances at most
4 frames per tick (wall-clock rate, bounded catch-up). Playback loops at the end;
the prefetch window wraps with it. Each displayed frame is swapped into the one
existing position `BufferAttribute` as a zero-copy subarray view over the
received chunk bytes — no per-frame allocation; edge/polyline geometries share
that same attribute by index.

**Verified** (headlessly; clicking inside a dev host isn't scriptable):
25 Node tests + 5 Python tests cover framing splits, playback bounds/stall/LRU,
and a live-producer integration (pipelined FIFO, error replies, stdout purity,
crash surfacing, dispose kills the process). End-to-end, the real webview bundle
ran in headless Chrome behind a strict nonce'd CSP against a bridge reusing the
real broker + real producer ([tests/bridge.ts](tests/bridge.ts)): at N=5,000 it
played at a sustained 30 fps with zero stalls; at the design ceiling
(**N=250,000, T=2,500**, 32 MB per chunk) it advanced 2,339 frames at 30 fps
with **zero stalls**, cache pinned at exactly 8 chunks/256 MB through 287
evictions, in-flight ≤ 2, JS heap oscillating with GC but not climbing, and the
producer's RSS flat at 291 MB across the entire session. Screenshots confirm
real pixels at both scales; consoles were free of CSP violations and errors.

## The contract in one paragraph

A dataset is N points whose 3D positions change over T frames. The producer sends
one **Header** (JSON: counts, columnar per-point attributes, two-level grouping,
categories, edges/polylines connectivity, and declared numeric channels), then
answers requests for contiguous frame ranges with **FrameChunk**s (a small JSON
descriptor plus raw little-endian float32 blocks: positions, and one block per
declared `per_point_per_frame` channel). Positions are never JSON — at the design
scale (N ≈ 250,000, T ≈ 2,500) they must go almost directly to the GPU.

**Data, never appearance.** The contract carries facts and numbers only — no
colors, sizes, or styles. Named numeric channels (`per_point`, `per_frame`,
`per_point_per_frame`) are the open-ended slot a future styling layer maps to
visual properties without the producer ever knowing.

[`contract/SPEC.md`](contract/SPEC.md) is the authoritative spec, including the
exact binary byte layout. `contract/contract.py` and `contract/contract.ts`
implement it — types, (de)serialization, and validation — with zero dependencies
on producer or renderer code.

## Layout

```
contract/    SPEC.md, contract.py, contract.ts, fixtures/   ← single source of truth
producer/    source.py (DataSource interface), synthetic.py (generator),
             mdtraj_source.py (REAL source: MD files → contract),
             domain_rules.py (vendored classification/trace rules),
             corpus.py (benchmark-system resolver),
             serve.py (long-lived stdio server, stdout = protocol only),
             CONTRACT_FIT_AUDIT.md (Phase-1 audit of all 9 systems)
src/         extension.ts (command, panel, CSP), broker.ts (spawn/relay/lifecycle),
             framing.ts (length-prefix stream parser)
webview/     main.ts (Three.js renderer + controls), transport.ts (FIFO correlation),
             playback.ts (playhead/prefetch/bounded cache), geometry.ts (pure prep)
media/       fixtures/ — Increment 1 fixture files (kept for tests; not the data path)
tests/       Python: test_roundtrip.py, make_fixtures.py, make_webview_fixture.py
             TS: contract/geometry/framing/playback/producer_protocol tests,
             bridge.ts (headless E2E harness: real broker + producer, no VS Code)
dist/        build output (generated)
```

`SyntheticSource` implements the same `DataSource` interface a real data source
will implement later, so sources can be swapped without touching the contract or
the renderer.

## Running the tests

Requirements: Python 3.9+ with numpy (producer only — the contract itself is
stdlib), Node ≥ 22.18 (runs the TypeScript tests natively — the npm install is
only for building the extension).

```bash
cd viewer

# 1. Python round-trip: produce → serialize → deserialize → validate → equal
python3 -m tests.test_roundtrip        # (or: pytest tests/)

# 2. Regenerate the cross-language fixtures (header.json, chunk.bin, expected.json)
python3 -m tests.make_fixtures

# 3. All TypeScript tests: contract fixtures, geometry, framing splits,
#    playback bounds/stall/LRU, and the live-producer protocol integration.
npm test
```

Step 2 only needs re-running when the producer or spec changes; the fixtures in
`contract/fixtures/` are the committed handshake between the two test suites.

To watch the streaming stack end-to-end without VS Code (used for the scale
stress): `node tests/bridge.ts --port 8940 --n-points 250000 --n-frames 2500`,
then open `http://127.0.0.1:8940/` in a browser — the page autoplays and logs
`[viewer-stats]` lines (cache bytes, in-flight, stalls, heap) every 2 s while
the bridge logs the producer's RSS.
