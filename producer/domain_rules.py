"""Molecular-domain classification and trace rules.

This is the ONE place molecular vocabulary lives. The rules here are vendored
verbatim from the benchmark corpus's proven definitions so the viewer stays
self-contained (the corpus is test data, not a runtime dependency):

- Alias sets + the 5-class ladder mirror
  ``benchmark_systems/_lib/composition.py`` (``classify_composition``). A test
  (tests/domain_rules_test) asserts this module's per-atom counts equal that
  function's counts on all 9 corpus systems, so the two cannot silently drift.
- Trace anchors mirror the reference viewer's documented backbone-trace rule:
  protein backbones thread through ``CA``; nucleic backbones through ``P`` with
  ``C4'`` as a fallback anchor; anything else (CG beads, solvent) has no trace.

Nothing here leaks past the producer: it emits only neutral contract slots
(category indices, polyline index lists).
"""
from __future__ import annotations

from typing import List, Optional, Sequence

# The 5 neutral categories, in a fixed order. category[] indexes into this.
CATEGORIES: List[str] = ["polymer", "ligand", "ion", "solvent", "unknown"]
CAT_POLYMER, CAT_LIGAND, CAT_ION, CAT_SOLVENT, CAT_UNKNOWN = range(5)

# Residue-name aliases — copied from _lib/composition.py (keep in sync; the
# equivalence test guards against drift). The solvent set is the reference
# viewer's common-solvent alias set; a solvent-LOOKING residue NOT in this set
# (e.g. methanol MOH) intentionally falls through to "unknown" and must not be
# hidden.
SOLVENT_RESIDUES = {
    "HOH", "WAT", "SOL", "H2O", "TIP", "TIP3", "TIP3P", "TIP4", "TIP4P",
    "TIP5", "SPC", "SPCE", "T3P", "T4P",
}
ION_RESIDUES = {
    "NA", "NA+", "CL", "CL-", "K", "K+", "MG", "CA", "CA2", "ZN", "FE", "CU",
    "MN", "CO", "NI", "CD", "BR", "I", "LI", "RB", "CS", "SOD", "CLA", "POT",
    "MG2", "ZN2", "CAL",
}

# Nucleic backbone-trace fallback order (after P).
NUCLEIC_TRACE_FALLBACKS = ("C4'", "C4*")


def classify_atom(
    residue_name: str,
    is_protein: bool,
    is_nucleic: bool,
    ligand_residues: Sequence[str] = (),
) -> int:
    """Return the category index for one atom, using the corpus ladder:
    ligand override → solvent alias → ion alias → protein/nucleic → unknown."""
    rn = residue_name.upper()
    if rn in {s.upper() for s in ligand_residues}:
        return CAT_LIGAND
    if rn in SOLVENT_RESIDUES:
        return CAT_SOLVENT
    if rn in ION_RESIDUES:
        return CAT_ION
    if is_protein or is_nucleic:
        return CAT_POLYMER
    return CAT_UNKNOWN


def trace_anchor_indices(
    residue_atoms_by_name: "dict[str, int]",
    is_protein: bool,
    is_nucleic: bool,
) -> Optional[int]:
    """Pick one anchor atom index for a residue's contribution to a backbone
    trace, or None if this residue contributes no trace point.

    ``residue_atoms_by_name`` maps atom name -> global atom index within the
    residue. Protein residues anchor on CA; nucleic on P then C4'; everything
    else (CG beads, solvent, ligands) has no anchor -> trace degrades to nothing.
    """
    if is_protein:
        return residue_atoms_by_name.get("CA")
    if is_nucleic:
        if "P" in residue_atoms_by_name:
            return residue_atoms_by_name["P"]
        for alt in NUCLEIC_TRACE_FALLBACKS:
            if alt in residue_atoms_by_name:
                return residue_atoms_by_name[alt]
        return None
    return None
