# Changelog

All notable changes to Molaro. This project follows [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **`ghost <frames> [opacity x]`** — draws the current representation again at other frames,
  translucent, around the solid copy (align, smooth, cartoon orientation and live colours apply
  per ghost). `ghost off` clears; undoable.
- **`ensemble`** (new mod) — picks the ghost frames: `?pick=spread` (frames as far apart as
  possible by RMSD, default), `extremes`, `even`; `?n`, `?opacity`, `?fit`.

## [0.1.2] — 2026-11-17

### Fixed

- **Undo of a re-run edges mod.** Running `contacts`/`hbonds` (or any `produces: edges` mod) again — with new options, after a `refresh`, or after its first run was undone — is now one Ctrl+Z step that restores the lines exactly as they were before, removing them if they were not showing. Previously the re-run recorded nothing, so Ctrl+Z only reverted its colour and the lines stayed.

### Mods

- **`hbonds`** (new): hydrogen bonds as dashed lines that form and break as you scrub.
  Bare `hbonds` draws the backbone network (N-H···O=C by DSSP's Kabsch-Sander energy,
  matching `mdtraj.kabsch_sander` frame for frame); `hbonds <selection>` draws every
  H-bond involving the selection, side chains included (heavy-atom distance + angle, so
  hydrogen-free models work). `?type`, `?restrict=any|within`, `?min` (occupancy),
  `?live=false`, `?solvent`, and `?color` / `?dash` / `?size` / `?opacity` / `?group`.
- **`contacts`** (new): atom contacts within a cutoff, live per frame like `hbonds`.
  `?atoms=heavy|all|backbone|sidechain|CA` or names (`CA,CB`), `?cutoff=auto` (4 Å; 8 Å
  for CA), `?level=residue` (one CA–CA line per residue pair — the default when bare),
  `?seqsep`, `?restrict`, `?min`, `?live`, `?solvent`, style and `?group`. Refuses a request
  too large to draw, naming how to narrow it.
- **`align` / `smooth` keep derived layers current.** They emit `refresh` for exactly the
  layers they made stale — cartoon ribbons (`ribbon_dir`), `live_sasa` / `live_ss`, and
  H-bond / contact groups — so a ribbon no longer faces raw coordinates under `smooth`.
- **Live layers follow `smooth`.** `sasa_field`, `ss_field` and `hbonds` filter their
  per-frame values over each point's smoothing window (mean for SASA, most common class
  for SS, majority for an H-bond), measured on the raw frames. `smooth` names the layers
  that need re-running. Without smoothing, both fields are byte-identical to before.
- **`align`** (new, with its provider `aligning`): superpose every frame onto a
  reference — `?ref=first|average|mean|last|<frame>|off`, where `average` is the real
  frame closest to the average structure and `mean` the average structure itself.
  `?fit=backbone|CA|heavy|protein|<selection>` narrows the fit atoms within the target,
  `?apply=all|target` chooses what moves, `?mode=center` removes translation only, and
  `?weights=mass` mass-weights the fit. Prints the reference used and the fit RMSD.
- **`align` and `smooth` compose, in either order.** `smoothing` used to average RAW
  positions and replace any other offset on the points it bound, so smoothing an aligned
  trajectory dropped the alignment and averaged a tumbling molecule into a jumble. Both
  providers now write one combined picture, shown = smooth(align(raw)), from motion state
  remembered on the dataset handle, and both macros bind whichever channel is current.
  With no alignment, `smoothing` is byte-identical to before.
- **`ribbon_dir` orients from the shown positions**, so cartoon ribbons follow `align` /
  `smooth` instead of twisting; the macros say when to run `ribbon_dir` to refresh them.

### Viewer

- **Annotation overlays.** `# edge-overlay: true` marks an edges mod's group as an overlay:
  point-targeted bond verbs (what `licorice` and `hide_res` emit) no longer restyle or fade
  it; `%group` targets still do. `hbonds` and `contacts` are overlays.
- **`refresh <channel> | %group`** re-runs the producer of a derived layer with its last
  target and options.
- **Bare invocation** of `channel` and `edges` mods (no target = the whole system).
- **An `edges` mod can style its own group.** Declared `color` / `size` / `dash` /
  `opacity` parameters are applied to the authored `%group` in the same undo stroke.

## [0.1.0] — first public release

Molaro streams large molecular dynamics trajectories into a GPU-rendered VS Code
webview, drives them with a text command grammar, and lets you extend it with small
Python **mods** that run next to your data rather than on your laptop.

### Viewing

- **Streaming producer.** Trajectories are read out-of-core, chunk by chunk, for
  `.dcd` / `.xtc` / `.trr` / `.nc` and friends — the file is never loaded whole. A
  222,000-atom membrane system opens without exhausting memory.
- **GPU representations.** Ray-traced sphere impostors, instanced bond tubes with
  analytically trimmed junctions, backbone traces, and smooth Catmull-Rom ribbons.
- **A representation grid.** Colour, size and opacity across points, bonds
  (contained and incident) and traces — twelve verbs from one template, so the axes
  can never disagree about what a target reaches.
- **Periodic-boundary handling** that holds a solute still across image wraps by
  rigid translation, recorded in `Header.provenance`.

### Commands

- A domain-agnostic address grammar (`category.group.subgroup.type`, globs, ranges,
  index lists, named selections, unions) shared by every verb.
- Argument-aware tab completion for every slot.
- System-wide undo/redo, where one command is one stroke.
- Proximity selection: `?within` / `?keep` on `create_sele` and `hide`, in the
  scene's coordinate units.
- `note <text>` — prints a line and changes nothing, so a mod can explain itself.

### Mods

- Seven `produces` kinds: `commands`, `channel`, `edges`, `per-point-scalar`,
  `per-frame-series`, `scatter`, `figure`.
- Declared parameters (`number`, `string`, `boolean`, `color`, `choice`, `hint`),
  channel dependencies that auto-run their provider, and hot reload on save.
- Eleven mods ship built in, including `cartoon`, `licorice`, `hide_res`/`show_res`
  and `smooth`.

### Assistant

- An in-editor assistant backed by the Claude Agent SDK, with a hardened tool
  surface and an approval gate on anything that writes.

### Correctness notes

- **Covalent bond inference** for what a file leaves out — CONECT-less ligands and
  lipids, nucleic `O3'–P` backbones, cyclic peptide closures, glycosidic and
  isopeptide links — scoped by chemistry rather than by distance, because an
  unscoped search provably fuses a lipid membrane.
- **Trace anchors derived from the atoms present**, gated on polymer linkage, so a
  modified residue joins its chain while a free ligand carrying the same atoms does
  not.
- Reference values are graded against a two-engine (mdtraj + MDAnalysis) corpus.

### Known limitations

- The Python producer needs `numpy`, and `mdtraj >= 1.11` for real trajectories.
  mdtraj 1.10 is **not** supported — its `Residue.is_nucleic` raises rather than
  answering.
- Set `molaro.pythonPath` to choose the interpreter. On a remote host, prefer the
  setting over environment variables: VS Code's server daemon is long-lived and
  extension hosts inherit its environment, not your shell's.
- A window reload can leave a viewer tab that must be reopened.
