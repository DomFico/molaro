# HANDOFF — The assistant tier: backend, security, system prompt, and the domain surface

**Audience**: an engineer taking over the **domain-aware** side of Molaro — the
real assistant backend, the producer's domain adapters, the system prompt, and
the science-correctness harness. Unlike the four `HANDOFF_fable_*` docs, this one
**may name atoms, trajectories, residues, elements, and mdtraj** — the fence
those docs keep is exactly the fence this document is on the other side of.

**Read `HANDOFF_fable_agent_mods.md` first.** It is the neutral tier this layer
sits on: the frozen panel↔backend message contract, the closed four-kind
typed-result union, the binding layer, the mod system (`produces`, the
`.molaro/mods/*.py` file format, `validateModValues`, `run_mod`, the `commands`
macro boundary), the plot tab, and every invariant that must survive a backend
swap. This doc does **not** repeat any of it. It describes only what is
domain-aware, and it treats everything in that doc as a frozen substrate it
drives — the same way the real backend drives the stub's contract.

> **The split is the point, and it is load-bearing.** Everything through the
> neutral tier was built by an agent that never knew what a molecule was, and
> that blindness is what made the stack general (the plot, the mod system, the
> typed-result contract are reusable for *any* time-series 3D point data). This
> document is where the domain lives, quarantined. Do not let a domain concept
> leak downward into the neutral tier — if a task seems to need one there, the
> task is on the wrong side of the fence.

---

## 1. What this tier is

The real assistant: a Claude Agent SDK conversation running in the extension
host, behind the panel contract the neutral tier froze, with a tool surface, a
security lockdown, an engineered system prompt, and a domain-aware producer that
gives a mod's `compute` a live trajectory and the viewer's own labels.

Five files own it:

| File | Stake |
|---|---|
| ★ `src/claudebackend.ts` | The live backend: a streaming `query()` loop, `mapSdkMessage` (SDK message → the frozen `ClaudeEvent`s), the `canUseTool` approval gate, `interrupt()`, and `probeRuntimeToolSurface` (the surface test's driver). Fills `claudestub.ts`'s swap point. |
| ★ `src/claudetools.ts` | The FIVE MCP tools, the hardened `Options` (`buildAgentOptions`), `toolPolicy` (the deny-by-default allow-list), `TOOL_NAMES`/`GATED_TOOLS`/`EXPECTED_TOOL_SURFACE`, `DISALLOWED_TOOLS`, `SceneContext`. The security fence lives here. |
| ★ `src/claudeprompt.ts` | The system prompt — an engineered artifact (§6). `buildSystemPrompt`, `renderContext`, `GRAMMAR_EXAMPLES` (guarded), the grammar reference. |
| `src/claudeauth.ts` | API-key resolution (SecretStorage → env → native input box). Nothing else touches credentials. |
| `producer/mdtraj_source.py`, `producer/source.py`, `producer/corpus.py`, `producer/domain_rules.py` | The domain producer: mdtraj loading, classification, `data.trajectory`, `data.labels` (`LabelView`), the corpus resolver. This is the ~2-file domain quarantine. |

The backend is created by the host **only when `molaro.assistant.useStub` is
false** (the default). With it true, the neutral tier's scripted stub runs
instead — and it is what every neutral test still exercises. The stub is not
dead code; it is the contract's executable specification and the test double.

---

## 2. The backend — Claude Agent SDK behind the frozen contract

**`@anthropic-ai/claude-agent-sdk` `^0.3.207`** (pin it; the SDK's surface and
semantics move — see §5). It runs **in the extension host process**, not a
subprocess and not the webview: custom tools register as an **in-process MCP
server** (`createSdkMcpServer`), so a tool call is a function call inside Node,
never HTTP.

`createClaudeBackend(post, deps)` returns an object speaking the neutral tier's
**frozen** panel contract — it emits exactly the `ClaudeEvent`s the panel
already renders and consumes exactly the panel's commands. The mapping is pure
and tested (`mapSdkMessage`): SDK stream deltas → `assistant-text`; a `tool_use`
block → `tool-proposed`; `canUseTool` firing → `approval-required`; a tool
result → `tool-result` (with the typed payload the binding routes); the run
ending → `turn-complete`. `cancel` → `query.interrupt()` then `turn-complete`.
**The contract did not change to accommodate the real backend** — that was the
whole test of the stub design, and it passed. If you find yourself wanting to
add an event "for the real backend," stop: the swap has failed the moment the
contract must widen.

`deps` (`BackendDeps extends ToolDeps`) inject every host capability the tools
need — `getContext`, `writeMod`, `deleteMod`, `runMod`, `runCommand`,
`analysisModNames` — so `claudetools.ts` stays pure and unit-testable (the tests
invoke the tool handlers directly with mock deps).

---

## 3. Auth — API key only, and why

`src/claudeauth.ts`. Resolution order, no prompting until forced:
**SecretStorage** (`molaro.anthropicApiKey`) → the **`ANTHROPIC_API_KEY`**
environment variable → a **native VS Code password input box**, whose answer is
stored in SecretStorage. The key reaches the SDK subprocess only through
`env.ANTHROPIC_API_KEY`; it is never logged, echoed to the webview, or persisted
anywhere else.

**It is NOT the user's claude.ai / Claude Code login, and that is a policy
constraint, not an oversight.** Molaro is a *distributed extension* — a
third-party product built on the Agent SDK. Anthropic's policy prohibits such
products from authenticating with an end user's claude.ai / Claude Code
subscription login; they must use API-key billing. An **earlier strategic plan
assumed the opposite** ("ride the user's local Claude Code session, no webview
sign-in") and it had to be reversed. Record the reason so it is not
re-litigated: the appealing "just use their existing login" path is closed by
policy, full stop.

---

## 4. Platform — a native binary, no pure-JS fallback

The Agent SDK requires a **platform-native binary**; there is **no pure-JS
fallback**. On a platform whose binary is absent, `query()` cannot start.

Two consequences, both load-bearing:

1. **The backend fails LOUDLY, through the contract.** A missing runtime is
   caught (the early failure modes — including `query()` throwing at
   construction — are handled inside the try, with a `started` flag so an
   unhandled rejection can't hang the turn), surfaced as an `error` event and an
   `auth-status: disconnected` with a hint. It never fails silent and never
   half-starts.
2. **Packaging is per-platform.** `npm run package` runs
   `scripts/package-all.sh`, which builds **platform-targeted VSIXs**:
   `viewer-0.1.0-linux-x64.vsix` (~86 MB, **ships the binary — the assistant
   works**) and `viewer-0.1.0-{darwin-x64,darwin-arm64,win32-x64}.vsix` (~7.9 MB
   each, **exclude the binary** — everything but the assistant works, and the
   assistant reports its own absence). The binary is excluded per-target via a
   temporary `.vscodeignore` glob during the build. **`npm run package` can no
   longer emit a bare unsuffixed `viewer-0.1.0.vsix`** — a stale bare one once
   got reinstalled instead of a fresh build and masked two briefs' work; the
   ambiguity is designed out.

---

## 5. The security model — write this as if it's the most important section, because it is

The assistant runs real Claude with tools, in the user's editor, able to write
and delete files. The entire trust story is: **nothing destructive or
Python-executing happens without the human seeing it and clicking approve.** The
mechanism is layered, and several layers exist because the SDK's defaults are
**not** what they appear to be.

### 5.1 The invariant

**Destructive operations are never ungated.** Not "there are exactly N tools" —
that framing broke twice. The rule is about *gating*, and it decides everything
below.

### 5.2 The five tools

| tool | gate | what it does |
|---|---|---|
| `get_context` | none (read-only) | The live scene shape (§7): system id, N/T, categories/groups, **point-type vocabulary**, **subgroup kinds**, the base look, committed selections, registered mods. Call before acting; never guess. |
| `run_command` | none (undoable) | One grammar command (selections, hide/show, constant styling). **Refuses `rm` and any analysis-mod invocation at the tool boundary** (`blockedCommandReason`) — it is the ungated path, so it must be closed to destruction and to Python execution. |
| `write_mod` | **GATED** | Writes a `.molaro/mods/<name>.py`. **The approval preview is the complete Python source** — nothing is saved unseen. |
| `run_mod` | **GATED** | Runs a mod; the typed result binds to the viewer; a failure returns the Python traceback verbatim for self-correction. |
| `delete_mod` | **GATED** | Deletes a workspace mod file and unregisters it. Deletes ONLY scanned workspace mods (built-ins, unknown names, and path-traversal strings are absent from the scan's path-map and refused *by construction* — the same `modPaths` discipline `rm` uses, shared as `resolveModDeletion`). |

`delete_mod` being gated is *why it is allowed to delete at all*: the approval
block names the mod and file, and nothing happens without a click. The ungated
paths (`run_command`, and the `commands`-macro execution boundary in the neutral
tier) stay closed to `rm` and to mod invocation — **because a mod's Python
generates command strings at run time, the refusal lives at the execution
boundary, not in the prompt and not only at the tool schema.** A human reading a
mod file, or an approval preview, never saw the string the Python later
assembles.

### 5.3 The SDK's counterintuitive semantics — these are the finding, record them

Every one of these cost a hardening pass. A future agent adding an SDK feature
must assume the defaults are wrong until proven otherwise.

- **`allowedTools` only auto-APPROVES — it does not restrict the surface.**
  Listing your tools there does not hide the others; it just skips their
  approval. The surface is restricted by `disallowedTools` (a broad by-name
  belt, currently ~39 entries) plus the equality test below.
- **`settingSources: []` does NOT stop ambient MCP discovery.** It stops loading
  the user's `.claude` settings, but MCP servers are discovered separately.
  **`strictMcpConfig: true`** is what drops ambient servers.
- **The un-hardened runtime surface leaked ~19 SDK tools** (Bash/Edit/Read, plus
  managed-agent orchestration tools — Task/Cron/Workflow/Skill/ToolSearch) **AND
  the user's ambient claude.ai MCP connectors — Gmail, Drive, Calendar.** State
  this plainly: without the lockdown, the assistant could read the user's email.
  That is the reason the lockdown exists and why it is asserted, not assumed.
- **`AskUserQuestion` is not a tool.** It rides a separate `request_user_dialog`
  channel, so `init.tools` can be exactly right while the model can still open a
  dialog. The defenses: the SDK **fails closed on dialogs** when no
  `onUserDialog`/`dialogKinds` is set (we set none), AND **`toolPolicy` is a
  deny-by-default allow-list** at `canUseTool` — anything that is not exactly one
  of our five is denied there, even if it bypassed the deny-list and the init
  surface entirely.
- **The perimeter is every channel the SDK can reach out on — not just
  "tools."** Tools, dialogs, MCP servers, elicitations. When you add an SDK
  capability, ask what *other* channel it opens and close it explicitly.

### 5.4 The guarantee is a test, not a list

`tests/tool_surface.test.ts` spawns the SDK with the **real hardened options** (a
fake key; the `init` message is local, no network) via `probeRuntimeToolSurface`
and asserts the runtime tool surface **EQUALS** exactly our five and that only
the `molaro` MCP server is present. A deny-list only catches names someone
thought to write down; this equality **fails the moment anything else appears** —
a sixth tool, a new SDK built-in, or a regressed config. `TOOL_NAMES` is the
single source the expected set derives from, so the tool count and the assertion
cannot drift (the "two lists that must agree" rule from the neutral doc, applied
here).

---

## 6. The system prompt is an engineered artifact — every rule earns its place

`src/claudeprompt.ts`. This is **ours, not an agent's**, and it is the highest-
leverage file in the tier: it is what makes a general model author *correct*
mdtraj analyses. Every rule exists because something went wrong once. Record each
with its reason so none is "simplified" away:

- **Reduce in float64.** `md.compute_rg` accumulates in float32 and drifts
  **~1.7e-3 nm on a 3,341-atom system** — an order of magnitude past the corpus's
  **1e-4 nm** gate. The naive one-liner *fails the correctness bar*. Cast to
  float64 and reduce yourself.
- **Units are nanometers.** mdtraj works in nm; state units in the header;
  convert explicitly if asked for Ångström.
- **RMSD is selection-driven.** Superpose on the same atom set you measure; take
  it from `target_indices` when given, else choose and *say so*.
- **Say what you computed.** The atom set, units, reference frame, normalization.
  An observable without its convention is not a result.
- **`run_command` for manipulation; a mod for computing.** The prompt once said
  *"prefer writing a mod over any other approach,"* and that single line caused a
  **mod-for-everything pathology** — the model wrapping a one-line `hide` in a
  Python file. The current guidance draws the line: the grammar manipulates; a
  mod computes.
- **The colormap fact.** A `per-point-scalar` color axis maps through **one
  built-in hue ramp (red→magenta)** — you **cannot pick named colors with a
  scalar**. For specific colors, use `colorpoints`/`colorbonds` (a command or a
  `commands` mod). The model guessed wrong on this in a live session.
- **A mod outlives the system it was written on.** `get_context` describes only
  the *currently loaded* system; **never hardcode its vocabulary** (elements,
  residue names, chains) into a saved mod. Derive the set at run time from
  `data.trajectory`/`data.labels` and handle the unanticipated. (A CPK mod that
  froze `adk`'s `C/N/O/H/S` left every phosphorus atom in a nucleic system
  silently uncolored — success reported.)
- **Respect `target_indices`.** Build addresses that intersect the target;
  address `all` only for genuinely whole-system mods, and say so.

**The prompt cannot rot silently.** `tests/prompt_examples.test.ts` resolves
**every** worked `run_command` example the prompt teaches against the *real*
address resolver — a prompt that teaches a command whose target matches nothing
fails the build. The examples are rendered into the prompt from the guarded
`GRAMMAR_EXAMPLES` list, so prose and tested data cannot diverge.

`get_context` (assembled host-side in `extension.ts::assembleContext`, nothing
hardcoded) advertises only what actually resolves: **present categories only**
(empty domain categories excluded), the residue-name **subgroup kinds**
(`<group>.<kind>*`), the **point-type vocabulary** (`*.*.*.C` — enabling compact
element addressing instead of a 5,919-character index list), and the base look —
each guarded by `tests/get_context.test.ts` so no advertised token can resolve to
nothing.

---

## 7. The domain surface — the producer, the trajectory, and the correctness harness

### 7.1 The trajectory API inside `compute`

`producer/mdtraj_source.py` gives a mod's `compute(data, target_indices)` two
domain accessors on the resident handle:

- **`data.trajectory`** — the live **`mdtraj.Trajectory`** backing the loaded
  system (not a copy). Full mdtraj is available (`traj.xyz` in nm, `traj.topology`
  with `.select(...)`, `md.rmsd`/`md.rmsf`/`md.compute_rg`, numpy). It is **`None`
  on the synthetic source** — a domain mod MUST check `if data.trajectory is
  None:` and fail closed. (`data.labels` is the neutral accessor, described in the
  neutral doc; it is present on *every* source.)
- **The index-alignment guarantee — VERIFIED, never assumed.** Header point `i`
  == `traj.topology` atom `i` == frame-byte column `i`. This is what lets
  `target_indices` (header order) index the trajectory directly. It is checked
  per system in `tests/reference_mods_corpus.py` (`np.allclose(pos, traj.xyz,
  atol=1e-6)`), **across all 9 corpus systems**. *Why it must be verified:* a
  misalignment computes perfectly real numbers for the **wrong atoms** — nothing
  throws, nothing looks broken, and the plot draws a plausible wrong curve. It is
  the single most dangerous silent failure in the tier.

### 7.2 What the labels mean (the domain reading of the neutral tree)

On a molecular system the neutral four-level tree reads as: **category** =
`polymer`/`solvent`/`ion`/`ligand` (from `domain_rules.classify_atom`); **group**
= the chain (or segid when chains are degenerate); **subgroup** = the residue
(label = `name + resSeq`, e.g. `ASP 33`); **point** = the atom, whose **`type`
is its element symbol** (`atom.element.symbol`, fallback to atom name).

Two facts this buys, and they are the difference between a usable and an unusable
assistant:

- **Point type == element** makes `*.*.*.C` address every carbon — a 24-character
  command vs. a per-atom `#index` list that blew the MCP token limit at 57 KB.
- **Subgroup label == residue** makes `polymer.A.ASP*` address every aspartate
  directly.

### 7.3 The benchmark corpus is the correctness harness

`benchmark_systems/` (read-only) holds 9 systems (`01_alanine` … `10_tip4p`) with
**two-engine (mdtraj + MDAnalysis) reference values**. `tests/reference_mods_corpus.py`
runs a mod against the corpus and compares to those references at **1e-4 nm
absolute** tolerance; `--mods-dir` / `--mod` / `--system` make it targetable at a
specific mod. It resolves the corpus root from `VIEWER_CORPUS_ROOT`.

The shipped **reference mods** (in `.molaro/mods/`, credited `molaro reference
mods`), each with its convention documented in its own header:

- **`rg`** — radius of gyration per frame, **mass-weighted**, **float64** (it *is*
  the reference computation, not a looser approximation — `md.compute_rg`'s
  float32 would fail the gate). `per-frame-series`.
- **`rmsd`** — RMSD to frame 0, **superposed** over the target, nm.
  `per-frame-series`.
- **`rmsf`** — per-atom fluctuation, superposed to its own first frame,
  **min-max normalized to [0,1]**. `per-point-scalar → color`.

**The central claim, with its provenance:** an **assistant-generated** Rg mod
(authored through `write_mod`, credited "Molaro assistant") matched the two-engine
reference to **Δ 1.56e-08 nm** — four orders of magnitude inside the 1e-4 gate.
That number is the project's differentiator: *verifiable* AI-authored analysis. It
came from the model following the float64 rule in this prompt; it is not a fixed
fixture, it is a result of the system working, so record it with that provenance
rather than as a stored constant.

### 7.4 Environment — the one trap that will cost you an hour

mdtraj / MDAnalysis live **only** in the `mdbench` conda environment. **pyenv
shims shadow conda on this machine**, so a bare `python`/`python3` is the wrong
interpreter. `VIEWER_PYTHON` (which the extension passes to the producer, and the
tests read) must be an **absolute** interpreter path —
`/home/dom/miniforge3/envs/mdbench/bin/python`. A mod that imports mdtraj fails
with a `ModuleNotFoundError` that the producer reports actionably (pointing at
`VIEWER_PYTHON`), not a bare traceback — that error path is deliberate.

### 7.5 One `.molaro` root

`.molaro/mods/` resolves against the **workspace root** (one rule; the extension
agrees). When this repository is the open workspace, `viewer/.molaro/mods/` holds
the shipped reference and example mods. **`.molaro/**` is excluded from the
VSIX** — it is workspace data, not extension content.

---

## 8. Fences — what this tier guards, and the one reserved seam

**Guard the neutral tier.** It is complete and correct, and this tier's job is to
drive it, not to change it. Specifically, treat as fixed and **stop-and-report if
a task seems to need otherwise**:

- **The typed-result union stays closed at four.** A new *kind* of visual is not a
  prompt tweak; it is a neutral-tier decision touching every closure point.
- **The grammar is sufficient.** Address economy (labels/types over index lists)
  is a *prompt* fix, not a grammar change.
- **The binding layer and the undo model are correct.** A mod's output is
  uninterpreted numbers to the neutral tier; keep it that way.

**Do not "clean up" the deliberate stubs and seams:** the scripted stub behind
`molaro.assistant.useStub` (it is the test double, not dead code), the
display-only `author`/`source` mod fields (never fetched), the no-sandbox
decision (user-approved code + timeout + validation is the model, on purpose).

**The one reserved capability gap — describe it, do not design it here:**
**`per-point-series`** — a per-atom value that varies per frame (animated
coloring: RMSF-over-time, a per-atom quantity sweeping with the playhead). It
would be a fifth result kind, and its cost is the reason it is deferred: **`N × T`
floats** resident (thousands of atoms × hundreds of frames), a memory and
transport budget the current four kinds never spend. It is a genuine design
problem — the streaming shape, the memory bound, the binding, the plot/scrub
interaction — and it belongs to a **decision made with Dom**, opened as a design
conversation, not started as a patch from either tier.

---

## 9. Build, run, test — the domain-aware commands

Everything runs from `viewer/`. The neutral commands (`npm run typecheck`,
`npm test`, `npm run build`, `node tests/redesign.ts`, `node
tests/terminal_smoke.ts`) are in the neutral doc. The domain additions:

```
# the real backend needs a key; the tool-surface test uses a fake one (offline)
node --test tests/tool_surface.test.ts     # surface == exactly five, only molaro MCP
node --test tests/claudebackend.test.ts     # tools, gating, previews, prompt content
node --test tests/get_context.test.ts       # every advertised token resolves

# the E2E scenario that needs the science env (real dataset):
VIEWER_PYTHON=/abs/path/to/mdbench/python node tests/redesign.ts S30

# the correctness harness (mdbench interpreter, corpus root):
VIEWER_CORPUS_ROOT=/abs/benchmark_systems \
  /abs/mdbench/bin/python tests/reference_mods_corpus.py            # all reference mods, 9 systems
  ... tests/reference_mods_corpus.py --mod rg --system 03_adk       # one mod, one system
  ... tests/reference_mods_corpus.py --mods-dir /abs/some/.molaro/mods   # an assistant's output

npm run package     # scripts/package-all.sh → per-platform VSIXs (§4), no bare .vsix
```

**No live model run has ever been done in CI** — there is no `ANTHROPIC_API_KEY`
on the build machine. The surface test uses a fake key (the `init` handshake is
local); everything model-behavioral is asserted through the stub, the prompt-
content tests, and hand-run corpus checks. When you *do* have a key, the honest
end-to-end is: load `03_adk`, ask for Rg, approve the mod, watch the curve draw
and the playhead sweep it, and confirm the value against the corpus reference.

---

## 10. The forward path, in one paragraph

The architecture is done and the fence held: a general neutral stack a
domain-blind agent built, with a domain-aware assistant plugged in behind an
unchanged contract, authoring credited, readable, re-runnable mdtraj analyses that
match a two-engine reference to 1e-8. What remains is not structural. It is:
polish the prompt against real sessions (every rule in §6 came from one); keep the
security equality test honest as the SDK moves; and, when it is wanted and decided
with Dom, the `per-point-series` chapter (§8) — the animated-coloring capability,
whose only hard part is the `N × T` budget. Everything else is content on a form
that is fixed.
