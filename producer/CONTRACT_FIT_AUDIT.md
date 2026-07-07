# Contract-Fit Audit — Increment 3 (HARD GATE)

Maps each of the 9 benchmark systems onto the existing contract's slots **on
paper + by direct mdtraj probe**, before building the real `DataSource`. The
contract is **not** changed; molecular concepts fill its neutral slots:

| Contract slot | Source (mdtraj) |
|---|---|
| point | atom |
| `type[]` | element symbol (fallback: atom name) |
| `group_id[]` | chain — **fallback to `segment_id` when chains are blank/degenerate** |
| `subgroup_id[]` | residue (global index) |
| `category[]` | 5-class {polymer, ligand, ion, solvent, unknown} via the corpus ladder (`_lib/composition.py`) |
| `edges[]` | bonds — **cross-box (PBC-wrapped) bonds suppressed** |
| `polylines[]` | backbone trace: protein `CA`; nucleic `P` (fallback `C4'`); none otherwise |
| `units` | `nm` (mdtraj normalizes every input format to nm) |
| `channels` | **deferred** — empty set this increment |

Probe interpreter: an mdtraj-capable Python (mdtraj 1.11.1).

## The one contract-shape question: is two-level grouping enough?

The brief flags the **membrane system (06)** as where a third independent
grouping axis (segment/section distinct from chain) could appear and not fit a
two-level (group → subgroup) hierarchy.

**Probe result — resolved, no misfit.** In `06`, mdtraj collapses all 222,227
atoms into a **single blank chain** (`chain_id = ' '`), while `segment_id`
carries the real top-level grouping: `PROA…PROG` (seven protein segments),
`DMPC` (lipids), `HOH` (water), `CLA`/`POT` (ions). So segment does not *compete*
with chain as a third axis — it **substitutes** for the degenerate chain as the
single top-level group. In every system that *has* real chains (`02`, `03`,
`09`), `segment_id` is blank or redundant with the single chain. Therefore
**group = chain, falling back to segment when chains are blank/degenerate**
represents every system with exactly two levels. **Two levels suffice; the
contract needs no change.**

## Per-system verdict

All counts/composition below were reproduced from the primary topology and
cross-checked against each `manifest.json`. Composition matches the manifest
exactly using the corpus classifier (`_lib/composition.py`) with a single
`ligand_overrides=["BNZ"]` for system 04.

| System | atoms | chains→group | residues | bonds (nonseq) | trace anchor | category composition | Verdict |
|---|---|---|---|---|---|---|---|
| 01 alanine_dipeptide | 1291 | 1 chain | 424 | 867 (0) | CA (protein) | solvent 1269, polymer 22 | **PASS** |
| 02 trpcage_atomistic | 4810 | 3 chains | 1528 | 3308 (0) | CA ×20 | solvent 4497, polymer 304, ion 9 | **PASS** |
| 03 adk_psf_dcd | 3341 | 1 chain (seg 4AKE) | 214 | 3365 (0) | CA ×214 | polymer 3341 | **PASS** |
| 04 ligand_custom_solvent | 2302 | 1 chain | 382 | 1921 (0) | none | ligand 16 (BNZ), unknown 2286 (MOH) | **PASS** |
| 05 macrocycle_disulfide | 72 | 1 chain | 8 | 72 (**1**) | CA ×6 | polymer 72 | **PASS** |
| 06 membrane_complex | 222227 | **blank → 11 segments** | 16502 | 50495 (**7 cross-box**) | CA | solvent 143487, unknown 56876, polymer 21616, ion 248 | **PASS** |
| 07 coarse_grain_martini | 46 | 1 chain | 20 | **0** | none (BB/SC beads) | polymer 46 | **PASS** |
| 09 nucleic_duplex | 19393 | 4 chains | 6273 | 13178 (0) | P ×22 (nucleic) | solvent 18579, polymer 758, ion 56 | **PASS** |
| 10 tip4p_virtualsites | 2004 | 1 chain | 501 | 1002 (0) | none | solvent 2004 (incl. 501 M-sites) | **PASS** |

## How each of the 10 known hard cases lands in a contract slot

1. **Unit scale (03).** mdtraj normalizes every container (CHARMM/NAMD DCD stores
   Å) to **nm** on read; probe shows max coord 2.56 nm (not 25.6). We emit
   `units="nm"` and positions straight from `traj.xyz` — no hand conversion, so
   no 10× trap. All manifests record `stored_units: nm`.
2. **PBC wrapping (06, solvated systems).** Bond-length probe: every non-membrane
   bond ≤ 0.21 nm; `06` has **7 bonds up to 8.59 nm** — wrapped pairs on opposite
   box faces. Policy: **suppress** any bond exceeding a 0.3 nm cutoff (checked
   over sampled frames). 0.3 nm keeps the disulfide (0.208 nm) and every real
   bond, drops only cross-box artifacts. → `edges[]`.
3. **Connectivity sourcing (all).** Bonds come from the topology; if a topology
   carries none, call `create_standard_bonds()`. `07` (CG) legitimately yields 0
   and must stay 0 (no atomistic templates for beads) — graceful, not an error.
4. **Classification → `category` (04, 06, 10).** Reuse the corpus's exact ladder:
   ligand override → solvent aliases → ion aliases → protein/nucleic → unknown.
5. **Aliases & inverse trap (04, 10).** Water aliases (`HOH/WAT/SOL/TIP*/…`)
   classify `10`'s `HOH` as solvent; the inverse — `04`'s methanol `MOH` is
   solvent-*looking* but **not** in the alias set, so it correctly lands in
   `unknown` (must-not-hide), while benzamide `BNZ` is tagged ligand by override.
6. **Trace selection (02 protein, 09 nucleic).** Protein → ordered `CA` per
   chain; nucleic → ordered `P` (fallback `C4'`). `09` has `P ×22`; `02` `CA ×20`.
7. **Blank grouping fallback (06).** Blank single chain → group by `segment_id`
   (11 groups) so grouping doesn't collapse. → `group_id[]`.
8. **No standard trace / bead systems (07).** No `CA`/`P` → **no polyline**
   (degrade gracefully, no error).
9. **Extra / massless points (10).** 501 TIP4P M-sites are ordinary points; they
   round-trip in positions and counts with no special-casing.
10. **Count consistency (03, 06).** Assert `topology.n_atoms` equals each frame's
    atom count; reject a mismatch loudly rather than render garbage.

## Gate verdict

**All 9 systems PASS with the existing contract unchanged.** The single
contract-shape risk (membrane third grouping axis) is resolved: segment
substitutes for a blank chain, so two levels are sufficient. Proceeding to build
the real `DataSource`.
