# FABLE_FENCE.md — the domain-free lane's fence, audited

**What this is.** The "fable" lane works on the **neutral tier** with no knowledge of
what the tool is for. That fence has been held by convention and by briefs for weeks;
this is the first time it has been *audited* as a checkable list. It answers four
questions a person can rule on: what fable may touch, what it would cost to open a
denied path, what can never be fenced, and what domain vocabulary has already leaked
into the neutral tier.

**Propose, don't execute.** Nothing here renames, moves, or edits a file. The ranked
lists are the deliverable. Renaming identifiers in a working codebase carries pixel
and golden-reference risk (§4 prices it), so a person rules on the list first.

**What this does NOT cover.** It classifies paths by *substance*, not by reading every
line of every file — a file marked FABLE READ+WRITE may still contain a stray domain
comment (§4 hunts those in the files fable actually works in, but does not re-scan the
domain tier). It does not price the full test matrix of any proposed rename beyond the
named risk. It is a snapshot at commit `2b2b2e6`; new files inherit the nearest rule
but are not pre-classified. The domain-tier internals are deliberately described only
as far as needed to fence them — for their substance see `HANDOFF_opus.md`.

---

## 0. The rule, in one line

**Fable may see anything that moves neutral slots; it may never see anything whose
substance (not just naming) teaches what the data represents.**

The neutral vocabulary — the only nouns that may appear in fable's world:

> **point, group, subgroup, category, type (opaque token), index, frame, edge,
> polyline, channel, selection, target, instance, geometry pass, shape (point / edge /
> vertex → sphere / tube / ribbon), representation, color / size / opacity axis,
> command, address, mod, producer, viewer, host, webview, terminal, undo / redo.**

Forbidden nouns (each names the domain): *atom, bond¹, residue, chain², molecule,
protein, nucleic, peptide, backbone³, solvent, ligand, trajectory⁴, rmsd, rmsf, radius
of gyration / rg, mdtraj, MDAnalysis, adk, element³, CPK, ångström, DSSP, helix, sheet,
coil.*

- ¹ **`bond`** survives as a *user-facing verb family* (`colorbonds`, `bondsize`, …) —
  a deliberate retained product term; the neutral internal token is **`edge`** (§4.4).
- ² **`chain`** is allowed in its English/graphics senses (a dependency chain, a
  polyline's chain-end); forbidden only as the molecular chain.
- ³ **`backbone`, `element`** are allowed only in graphics/DOM senses if they ever
  arise; as molecular terms they are forbidden. (`backbone` currently has zero hits.)
- ⁴ **`trajectory`** is allowed only as "a frame range / a path through frames"; as the
  MD trajectory object it is forbidden.
- **Kept neutral on purpose:** `ribbon`, `tube`, `trace`, `polyline` are generic 3-D
  graphics primitives (an extruded flat band, an extruded tube, a vertex path). They
  are load-bearing identifiers and are **not** domain leaks.

**The stop-and-report trigger:** if a task fable is given seems to require any forbidden
noun to reason about correctly — not just to name a file — fable **stops and reports**
rather than guessing. That is the signal the task is on the wrong side of the fence and
needs a translated brief (§5).

---

## 1. The allow/deny list (checkable)

Three classes: **[RW]** fable may read and write · **[RO]** neutral in substance but a
reference a lane should not edit (contract, manifests, generated docs) · **[NEVER]**
domain-laden in substance; fable must not open it.

### `contract/` — the neutral data contract
| path | class | reason |
|---|---|---|
| `contract/SPEC.md`, `contract.ts`, `contract.py`, `__init__.py` | **RO** | authoritative neutral contract ("data, never appearance"); the waist of the hourglass — reference, don't edit |
| `contract/fixtures/*` (`chunk*.bin`, `*header*.json`, `*delta*.json`, `expected*.json`) | **RO** | synthetic protocol fixtures — but see §4 (the `solvent` label leak) |

### `webview/` — the renderer, grammar, selection, plot, chat-UI shell
| path | class | reason |
|---|---|---|
| `address.ts`, `commands.ts`, `recipes.ts`, `channelmap.ts`, `committed.ts`, `sets.ts`, `brackets.ts` | **RW** | grammar, mod *format*/registry, selection sets, channel normalization, undo/redo — all abstract |
| `geometry.ts`, `shaders.ts`, `representation.ts`, `picking.ts`, `playback.ts` | **RW** | geometry/WebGL/picking/playback (see §4 for stray domain comments in `shaders.ts`) |
| `tree.ts`, `virtuallist.ts`, `hud.ts`, `styles.ts`, `main.ts`, `terminal.ts`, `terminalhud.ts`, `prompt.ts` | **RW** | tree/gesture engine, renderer wiring, terminal UI, the terminal input gate (`prompt.ts` is NOT the assistant prompt) |
| `plot.ts`, `plothost.ts`, `plothud.ts`, `plotmodel.ts` | **RW** | neutral plotting (a "trajectory" here is only a frame range) |
| `claudemodel.ts`, `claudepanel.ts`, `claudelayout.ts`, `claudebind.ts`, `claudestub.ts` | **RW** | the chat-UI **shell** + pure typed-result binding — confirmed neutral (frozen panel↔backend contract, `example_tool_a/b`, `#index` targets) |
| `classification.ts` | **RW** | substance is abstract category-cardinality math — but its comments leak domain (§4.1) |
| `transport.ts` | **RW** | neutral request/response correlation |

### `src/` — the extension host + the assistant boundary
| path | class | reason |
|---|---|---|
| `broker.ts`, `framing.ts`, `webviewcsp.ts`, `hostmessages.ts`, `modfile.ts` | **RW** | framed stdio, length-prefix framing, CSP builder, terminal→viewer relay routing, the `.molaro/mods/*.py` writer/backup *mechanism* |
| `claudeauth.ts` | **RW (borderline)** | generic Anthropic API-key / SecretStorage flow; no molecular vocab. Names "Molaro"/assistant but teaches nothing about the domain |
| `claudebackend.ts` | **RW (borderline)** | neutral SDK↔panel message mapping; teaches nothing domain — but it *imports* the domain prompt/tools, which stay hidden. See §2 (the seam) |
| `claudetools.ts` | **NEVER** | the security fence is neutral, but the *tool descriptions* (`get_context`/`SceneContext`) are substantively molecular ("residue names", "atom elements C/N/O") — prompt-equivalent text |
| `claudeprompt.ts` | **NEVER** | the assistant's system prompt — explicitly molecular (RMSD, nm, residue names). The domain artifact |
| `extension.ts` | **NEVER (borderline — see §2)** | ~80% neutral host skeleton, but it *wires* the mdtraj source, `--ligand-residue` CLI args, and *builds* the residue/atom-element vocabulary for `get_context` |

### `producer/` — split at the domain boundary
| path | class | reason |
|---|---|---|
| `source.py` | **RO** | the neutral `DataSource` interface (Header/FrameChunk) |
| `serve.py`, `synthetic.py`, `__init__.py` | **RW** | neutral stdio loop; the synthetic source (`alpha`/`beta`/`gamma`, nothing about appearance) |
| `domain_rules.py` | **NEVER** | "the ONE place molecular vocabulary lives" (§3.1) |
| `mdtraj_source.py`, `corpus.py`, `file_resolve.py`, `CONTRACT_FIT_AUDIT.md` | **NEVER** | real trajectory reader, benchmark-corpus resolver, molecular file formats, corpus-fit audit |

### `tests/`
| path | class | reason |
|---|---|---|
| neutral unit suites: `address`, `bindings`, `channelmap`, `channel_mirror`, `claude`, `claudelayout`, `commands`, `contract`, `framing`, `geometry`, `hostmessages`, `modfile`, `picking`, `playback`, `plot`, `prompt`, `recipes`, `sets`, `styles`, `tool_surface`, `webviewcsp`, `producer_protocol` `.test.ts`; `test_mod_params_serve.py`, `test_produced_channel_serve.py`, `test_roundtrip.py`, `make_fixtures.py`, `make_webview_fixture.py` | **RW** | neutral (spot-check `commands.test.ts` / `contract.test.ts` — §4.6/§4 for stray labels) |
| E2E harness: `e2e_driver.ts`, `run_e2e.ts`, `redesign.ts`, `ribbon_shots.ts`, `terminal_smoke.ts`, `impostor_bench.ts` | **RW** | the neutral harness — but `redesign.ts` S30 is a whole domain scenario (§4) and `bridge.ts` has an mdtraj branch |
| `bridge.ts` | **RW (borderline)** | neutral driver with a real-mdtraj-source branch + comments (§4.4) |
| `acceptance/` (`cold.ts`, `gen_context.py`, `run_mod_real.py`, `contexts/ctx_*.json`), `acceptance_corpus.py`, `reference_mods_corpus.py` | **NEVER** | domain acceptance tests + real-system fixtures (adk, trp-cage, nucleic) + reference-value corpus |
| `claudebackend.test.ts`, `get_context.test.ts`, `prompt_examples.test.ts`, `classification.test.ts`, `test_channel_delta.py`, `test_figure_roundtrip.py`, `test_file_resolve.py`, `make_openfile_fixtures.py`, `sidebar_spotcheck.ts` | **NEVER** | embed molecular fixtures / assert protein/residue semantics / generate `.pdb`/`.xtc` / corpus-driven |

### docs, scripts, media, manifests, artifacts
| path | class | reason |
|---|---|---|
| `docs/COMMANDS.md`, `docs/COMMAND_LAYER.md` | **RO** | neutral, explicitly "domain-agnostic" grammar docs |
| `scripts/package-all.sh`, `scripts/hooks/commit-msg` | **RO** | neutral build/git tooling |
| `scripts/rederive_rg_references.py` | **NEVER** | re-derives Rg corpus references via mdtraj |
| `media/fixtures/*` | **RO** | synthetic protocol fixtures |
| `package.json`, `package-lock.json`, `tsconfig.json` | **RO** | manifests (carry the "Molaro" brand + assistant config; don't edit) |
| `.gitignore`, `.vscodeignore`, `LICENSE`, `.vscode/launch.json`, `.vscode/tasks.json` | **RO** | neutral repo/editor config |
| `README.md` | **NEVER** | "Molaro … molecular dynamics simulations" — domain framing throughout |
| `node_modules/` | **RO** | third-party (incl. the Agent SDK) — never edit |
| `dist/`, `viewer-0.1.0-*.vsix` | **NEVER** | compiled from the prompt/tools; the packaged domain extension |
| `reports/` (whole tree) | **NEVER** | the domain-aware development record (ACCEPTANCE_COLD, PROMPT_DELTA, STATE, corpus logs, prompt evolution). *Exceptions in substance only* — `RIBBON_SIZING.md`, `redesign/*.png`, `e2e_runner/FLAKE_LEDGER.md`, `ALPHA_SPLIT.md` are pure geometry/harness — but they live among domain material, so keep the whole tree denied and translate what fable needs (§5) |

### top-level handoff docs
| path | class | reason |
|---|---|---|
| `HANDOFF_fable.md`, `HANDOFF_fable_agent_mods.md`, `HANDOFF_fable_terminal_grammar.md`, `HANDOFF_fable_scalar_channel.md`, `HANDOFF_fable_viewer_UI.md` | **RO** | fable's own cold-start briefs — read them; spot-check for the `solvent` leak (§4) |
| `HANDOFF_opus.md`, `HANDOFF_opus_agent_mods.md`, `HANDOFF_chat*.md` | **NEVER** | the domain-aware and advisory lane docs — they exist to hold what fable must not see |

---

## 2. Denied paths fable plausibly needs — the unlock cost, ranked by value ÷ cost

Some denied files are domain-laden only where they touch the domain; the rest is neutral
substance fable would benefit from. For each: what leaks, what a neutral version looks
like, what it costs.

| rank | path | why fable wants it | what specifically leaks | neutral version | cost / risk |
|---|---|---|---|---|---|
| **1 (best ratio)** | `src/extension.ts` | it is the **host skeleton** — webview creation, relay routes, the `.molaro` loader, the plot panel — 80% neutral wiring fable extends constantly | the mdtraj source wiring, `OpenArgs.{topology,trajectory,ligandResidues}`, emitted `--trajectory`/`--ligand-residue` producer flags, `get_context`'s residue/element vocabulary builder, and comments (`mdbench`, `ASP 33`, `C/N/O`) | **extract the domain wiring** into a `src/domainsource.ts` (or fold it behind the producer boundary), leaving a neutral host skeleton fable can own; rename the wire identifiers as in §4.3 | **Medium-high.** One real refactor: the CLI flags cross the host↔producer wire, so a coordinated producer change + `producer_protocol`/`extension` test updates. No pixels move. High value because it converts the single most-wanted denied file into RW. |
| **2** | `src/claudetools.ts` | the **security lockdown** (`toolPolicy`, `DISALLOWED_TOOLS`, `EXPECTED_TOOL_SURFACE`, gating) is neutral and is exactly the kind of invariant fable reasons about | only the *tool descriptions* (`get_context`/`SceneContext` prose: "molecular system", "residue names", "atom elements") are domain | split the file: `claudetools.ts` (neutral surface/policy/gating) + `claudetooldescs.ts` (the domain-worded tool schemas) — fable sees the first | **Low-medium.** A file split + import fix; the descriptions are strings, no wire change, no pixels. Tests (`tool_surface.test.ts`) are already neutral and would follow the split. |
| **3** | `webview/classification.ts` comments | fable already owns the file (RW); only its doc-comments are denied-flavored | `protein/solvent/lipid-tail/membrane/residue` in the header comment (identifiers are clean) | recast in generic terms — "bulk category / repeating small units / a large structured category vs. background scatter" | **Trivial.** Comment-only; zero code/pixel/test risk. Already RW — this is just cleanup. |
| **4** | `producer/mdtraj_source.py` (the *transport half*) | fable owns `serve.py`/`synthetic.py`; the `DataSource` **plumbing** in the mdtraj source (chunk assembly, framing) is neutral and parallels code fable maintains | the substance — PBC centering, connectivity inference, backbone-anchor selection — is irreducibly domain (§3.5) | none worth attempting: the neutral plumbing is small and already lives in `source.py` (RO); the rest is §3 | **Not worth it.** The extractable neutral part is already exposed via `source.py`. Leave denied. |
| **5** | `reports/RIBBON_SIZING.md`, `reports/ALPHA_SPLIT.md`, `e2e_runner/FLAKE_LEDGER.md` | pure geometry/harness records fable would benefit from | nothing in substance — they sit in a denied tree next to domain material | move the handful of genuinely-neutral reports to a `reports/neutral/` subtree fable may read | **Low, but low value.** The content is already reachable via the memory store and the fresh lane docs; not worth a reorg. |

**Not on this list, deliberately:** `claudeprompt.ts`, `domain_rules.py`, the reference
mods, the corpus, the acceptance suite — those are §3 (cannot be fenced), not "denied
files with a neutral core."

---

## 3. What genuinely cannot be fenced (domain in substance, not naming)

Renaming `polymer`→`groupA` leaves every one of these still wrong or still meaningless.
Name them and stop trying.

1. **`producer/domain_rules.py` — the vocabulary itself.** `SOLVENT_RESIDUES` /
   `ION_RESIDUES` (HOH, WAT, TIP3P, NA⁺…), the protein/nucleic→polymer ladder, the trace
   anchors (protein threads through Cα, nucleic through P then C4′). Knowing water is
   "HOH" and that a backbone traces the α-carbon *is* the field. No rename supplies it.
2. **The reference mods `rg.py` / `rmsd.py` / `rmsf.py`.** They compute molecular
   observables; the conventions baked in (mass-weight, reduce in float64 because
   `md.compute_rg` drifts ~1e-3 nm in float32, superpose on the set you measure, min-max
   per selection) *are* the domain expertise.
3. **The corpus reference *values*** (`reference_values.json` / manifest observables:
   `rg_mean = 1.8265495320 nm`, cross-verified by two engines to ~1e-5 nm). These floats
   are physical measurements of specific molecules; the entire correctness claim is "the
   mod reproduces this measured number."
4. **`tests/reference_mods_corpus.py`.** Its substance — per-system RMSD selections
   (`name CA`, `name P`), MDAnalysis as a second physics engine, the 1e-4 nm tolerance
   argument — is MD reasoning.
5. **`mdtraj_source.py` periodic-image centering + connectivity inference.** PBC wrap
   correction (rigid translation vs `image_molecules`, split-anchor detection), covalent
   bond inference, backbone polyline construction — graduate-level MD physics; only the
   *output* is neutral.
6. **`claudeprompt.ts` correctness rules + worked examples.** Rules 1–6 *teach the model
   the domain* (float64, nm, CA-for-protein / P-for-nucleic, CPK-by-element, the RMSF-on-
   solvent trap); the examples encode chemistry ("acidic residues" = `ASP*,GLU*`).
7. **The acceptance suite (`tests/acceptance/`).** Requests are domain-shaped ("color the
   acidic residues", "color by how floppy they are" = RMSF); grading knows those mappings
   and that RMSF on a solvated system must target the solute, not water. The `ctx_*.json`
   are real MD headers.

The line: `serve.py`, `claudetools.ts`'s policy/gating, the command grammar, the
`contract/` format, and the neutral example mods (`index_ramp`, `frame_metric`,
`xy_metric`, `channel_flow`, `setup_flow`, `color_ab`, `param_scale`, `figure_metric`)
are domain-free — they move neutral slots or compute synthetic quantities. Any molecular
flavor there is cosmetic and belongs to §4, not §3.

---

## 4. Leaks currently in the neutral tier (propose neutral replacements; execute nothing)

The neutral tier is **not clean.** A leak is domain vocabulary in an identifier, comment,
string, or fixture label inside a file fable reads/writes. Ranked by value ÷ cost.

### 4.1 `webview/classification.ts` doc-comments — HIGH value / trivial cost
Lines 7–14, 21–34: "a protein with a few hundred residues", "solvent/water/lipid-tail
environments", "a 143k-atom membrane solvent", "its residues average ~8–15 atoms each",
"a 46-bead coarse-grained model". Identifiers are clean (`category`/`group`/`bulk`).
→ Recast generically ("a large structured category among background scatter; repeating
small units of ~8–15 members"). **Comment-only, zero risk. Best ratio in the tier.**

### 4.2 `webview/shaders.ts` depth-note comments — HIGH value / trivial cost
Lines ~99–104: "the same atoms at the same alpha", "Measured on **adk** (3341 atoms …)",
"a faded **bond** still hid the trace"; lines 477/548 "a thin **coil** and a wide
**helix**". `adk` is a canonical MD test system — a direct fingerprint.
→ "measured on a 3341-point sample", "the same points", "a faded edge still hid the
trace", "a thin band and a wide band". **Comment-only, zero risk.**

### 4.3 `src/extension.ts` — HIGH value / MIXED cost (worst leak; partly load-bearing)
Comments: "Real mdtraj source", "the mdbench conda env", "atom element symbols — C/N/O/…",
'The residue vocabulary … ("ASP 33" → "ASP")'. **Structural:** `OpenArgs.{topology,
trajectory,ligandResidues}` and emitted producer flags `--trajectory`, `--ligand-residue`.
→ comments → "real data source / benchmark interpreter / per-point type symbols";
identifiers → `topology`→`schemaPath`, `trajectory`→`framesPath`,
`ligandResidues`→`highlightSubgroups`; flags `--trajectory`→`--frames`,
`--ligand-residue`→`--highlight-group`. **Comments free; the flags/identifiers cross the
host↔producer wire → coordinated producer change + `producer_protocol`/`extension` test
churn. No pixels.** Do the comments now; stage the wire renames with §2 rank 1. *(This
file is [NEVER] until that refactor; the leak is catalogued so the refactor is scoped.)*

### 4.4 the `bond*` verb family — MEDIUM value / HIGH cost (deliberate, user-facing)
`channelmap.ts:39–42`, `commands.ts` (dozens: `bondcolor/bondsize/bondopacity…`, help
text, `EDGE_AXES`), `main.ts`, `representation.ts`. `channelmap.ts` *self-documents* it:
"Edge axis tokens say 'bond' because that is the verb family's established vocabulary" —
internals already use the neutral **`edge`**; only the user-facing verb kept `bond`.
→ `bond*`→`edge*` across the command surface. **Very high cost** — user-facing verbs,
help/usage strings, the model's tool prompt, and multiple suites (`recipes`,
`tool_surface`, `sets`, ~105 hits in `redesign.ts`). **Treat as a product decision, not a
quick fix.** Flagged, not recommended.

### 4.5 `contract/fixtures/header.json` — MEDIUM value / MEDIUM cost (the one fixture tell)
Deliberately neutralized (`name:"synthetic"`, `units:"meters"`, types `anchor/t0…`,
`group-N`, `subgroup-N`) **except the `solvent` family**: categories `["alpha","beta",
"gamma","solvent"]`, group `"solvent-bath"`, 80 `"solvent-0…79"`. "solvent"/"solvent-bath"
is unmistakable MD; it also retro-poisons `alpha/beta/gamma` (they read as α-helix/β-sheet
next to it). **Confirmed: there is NO pixel/image baseline in the harness** (screenshots
are written, never diffed) — so renaming moves *textual golden strings only*, never a
pixel baseline. But `solvent` is load-bearing across ~100+ assertions in `redesign.ts`
(`"solvent" — 4800 points`, sidebar `/solvent/` lookups), plus `expected.json` and
`address.test.ts` aliases. → `solvent`→`bulk`/`background`, `solvent-bath`→`bulk-pool`,
`solvent-N`→`bulk-N`, matching the `group-N`/`subgroup-N` style. **Wide but mechanical;
no baseline risk.** This is also the leak that reached the *fable doc's own vocabulary*
(DRIFT_AUDIT), so it is worth doing.

### 4.6 cheap self-contained fixes — LOW-MEDIUM value / trivial cost
- `tests/classification.test.ts:82–104` — protein-in-water test data (`["solvent",
  "polymer"]`, "3-atom waters", "200 residues") → `["background","cluster"]` + generic
  comments. Self-contained unit test, no golden dependency. *(But this file is [NEVER] by
  §1 because it asserts protein/residue semantics — the neutral fix would also neutralize
  those assertions; flag for the domain lane.)*
- `tests/shaders.test.ts:206–207` — "the SAME atoms … (adk: …)" comment → "points". Trivial.
- `tests/bridge.ts:76–77`, `tests/run_e2e.ts:18` — "mdtraj"/"mdbench" comments →
  "real-producer / producer-capable interpreter". Trivial.
- `tests/commands.test.ts:1986` — a `dssp` macro name + `polymer.C.*`/`polymer.D.*`; no
  assertion depends on the literals → `m2` / `root.C.*`. Trivial.
- `tests/contract.test.ts:259` — `name:"backbone orientation"` used only as "a name with a
  space" → "primary orientation". Trivial.

### 4.7 not leaks — recorded so they are not re-flagged
`ribbon`/`tube`/`trace`/`polyline` (generic primitives); `chain` (dependency chain / chain-
end); `ca`/`cb` (category-accumulator / colorA-B variables, **not** Cα/Cβ); `atomic`/
`atomicity` (transactional). **Clean (zero hits):** `rmsd`, `rmsf`, `gyration`, `angstrom`,
`CPK`, `peptide`, `nucleic`, `amino`, `DNA`/`RNA`, `dihedral`/`torsion`, element symbols,
`strand`/`sheet`, `backbone` — the domain tier holds these as intended. **S30 in
`redesign.ts`** is a whole domain scenario by design (real adk, `--system 03_adk`, a
hardcoded `/home/dom/miniforge3/…` path); it is [NEVER] as a scenario even though the
harness around it is fable's — at minimum the hardcoded path should be env-only.

---

## 5. The designed path for when fable needs something it cannot see

This is how the fence has actually worked, stated as the design, not a workaround.

**The mechanism.** A domain problem is **translated into a neutral brief by the advisory
lane** before it reaches fable. Fable receives the neutral statement — never the domain
one. The advisory lane owns the Rosetta stone (it knows category≈molecule-class,
subgroup≈residue, edge≈bond, a per-point-per-frame channel≈an animated per-atom
quantity); its job is to strip the domain and hand fable a task stated entirely in §0's
allowed nouns.

**What a well-formed translated brief looks like:**
- States the task in neutral nouns only. *Not* "make the RMSF coloring update as the
  trajectory plays"; instead "a per-point-per-frame channel bound to the color axis must
  re-read its per-frame values as the frame changes, with an `N×T` memory bound of X."
- Carries the *shape* of any external fact fable needs as a neutral parameter — a length,
  a count, a tolerance, a byte budget — never the domain reason for it. *Not* "float32
  drifts 1.7e-3 nm past the 1e-4 corpus gate"; instead "reduce this accumulation in the
  wider float type; a downstream check requires ≤ 1e-4 absolute error."
- Names the neutral invariant the change must keep (fail-closed, closed union, slot ≡
  header order, one undo stroke), not the domain motivation.
- Points at a neutral fixture (`synthetic.py`, the `#index` targets), never a real system.

**What fable does when a task appears to need domain knowledge: STOP AND REPORT.** Not
guess. The tells that a task has crossed the fence: it can't be stated without a forbidden
noun (§0); it asks fable to decide *what a number means* rather than move it; it wants a
new *kind* of visual, a grammar change, a binding change, or a union widening (those are
neutral-tier *decisions*, not patches); or it references a real dataset, the prompt, a mod's
science, or a reference value. Fable's correct move is to report "this needs a fact I'm
fenced from — please translate it," and the advisory lane either supplies the neutral
brief or rules that the task belongs to the domain lane. A guess here is how the two
silent-failure classes (a wrong-but-well-formed address; a wrong number reported as
success) enter the neutral tier — the fence exists precisely to keep them out.

**Is the fence testable?** Yes: the property "a reader of `HANDOFF_fable.md` cannot tell
what field the tool serves" is checkable, and §4 is the list of places the *codebase*
currently fails it. The doc can hold the fence even while the code has the §4 leaks —
the doc names neutral concepts and points at neutral fixtures; the leaks are in comments
and one fixture label a reader of the doc never sees.
