# The cold acceptance suite

Does the *prompt* make the right rung obvious? Each run is a **fresh conversation**
with the real `buildSystemPrompt` and real `buildToolDefs`, given one verbatim user
request and no hints. What is being measured is the assistant's unaided choice —
which tool, which target, which kind of mod — not whether it can be steered to a
good answer.

## Running it

```sh
KEYFILE=~/.secret/anthropic OUTDIR=/tmp/cold COLD_SYSTEM=trpcage \
REAL_PRODUCER=1 PYBIN=/path/to/python-with-mdtraj \
ONLY=R6 RUN=a node tests/acceptance/cold.ts
```

- `KEYFILE` — a path to a file holding an API key. Deliberately never an argument or
  a literal: transcripts and reports from this suite get committed, and a key must
  not be able to reach them by accident. Shred the file afterwards.
- `COLD_SYSTEM` — `adk` (default), `trpcage`, or `nucleic`.
- `REAL_PRODUCER=1` — execute authored mods through the REAL producer on the REAL
  system via `run_mod_real.py`, so a length or dtype refusal reaches the assistant
  exactly as it would live. Needs `PYBIN` pointing at a python with mdtraj
  (on this machine, the `mdbench` conda env — call it by absolute path, pyenv
  shadows conda).
- `COLD_MODS_DIR` — override the advertised mod inventory. This is the A/B knob:
  point it at a copy with one description changed and you can measure whether that
  description is what moved the behaviour.

## The fixtures, and why there is more than one

**An acceptance suite inherits its fixture's blind spots.** Eight requests passing on
adk said nothing about solvent, periodic boundaries, or multi-molecule fitting,
because adk has none of them. The instinct on finding a gap is to write more
requests; the cheaper and larger win is usually another *system*.

| `COLD_SYSTEM` | corpus system | what only it can show |
|---|---|---|
| `adk` | 03_adk_psf_dcd | 3341 atoms, **100% polymer**, single chain, no unit cell |
| `trpcage` | 02_trpcage_atomistic | 4810 atoms, **6.3% polymer**, solvated, centered+wrapped |
| `nucleic` | 09_nucleic_duplex | 19393 atoms, **4 chains**, non-protein, solvated |

Each system's boot context is DERIVED from that system's own header by
`gen_context.py` (which mirrors `extension.ts`) into `contexts/ctx_<name>.json`.
Regenerate with `PYBIN gen_context.py`. A run that showed adk's categories over
another system's atom count would be testing a system that does not exist.

## What it has found

See `reports/ACCEPTANCE_COLD.md` for the full record. The result that shows what the
suite is for: on the solvated trp cage, `rmsf`'s advertised description decided the
outcome — pre-edit the assistant chose `target: all` 3/3 (which spends the whole
colour ramp on water and renders the protein flat), post-edit `target: polymer` 3/3.
One variable, a control, a result.
