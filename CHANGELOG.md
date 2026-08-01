# Changelog

All notable changes to Molaro. This project follows [semantic versioning](https://semver.org/).

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
