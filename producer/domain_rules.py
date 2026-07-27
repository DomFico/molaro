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
- The bond-inference vocabulary (covalent radii, the backbone linkage atom-name
  pairs, the crosslink element set) lives here too, for the same reason: those
  are chemistry, not geometry. ``producer/bond_inference.py`` holds the KD-tree /
  distance machinery and imports its vocabulary from here, so the geometry module
  names no element and no atom name of its own.

Nothing here leaks past the producer: it emits only neutral contract slots
(category indices, polyline index lists, ``[i, j]`` edges).
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

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

# -- Bond-inference vocabulary -------------------------------------------------
#
# Covalent radii, Cordero et al. (2008) "Covalent radii revisited", converted
# from Å to nm and keyed by UPPERCASE element symbol. A pair is a candidate bond
# when its distance is within ``(r_i + r_j) * COVALENT_BOND_SCALE``.
#
# The table is deliberately restricted to the elements that make COVALENT bonds
# in biomolecular systems. Metals are ABSENT on purpose, and their absence is
# load-bearing rather than an oversight: a metal in this table would carry a
# Cordero radius of 0.12-0.20 nm, and a metal's coordination shell sits well
# inside the resulting window, so every ion would sprout four to six "bonds" that
# are not covalent bonds. A monatomic ion residue is excluded from inference
# outright (see bond_inference), and a metal sitting INSIDE a multi-atom residue
# record falls back to ``COVALENT_RADIUS_DEFAULT_NM`` — small enough that its
# coordination shell is not drawn as connectivity. Add a metal here only with a
# measurement that shows what it starts bonding to.
COVALENT_RADII_NM: Dict[str, float] = {
    "H": 0.031,
    "B": 0.084,
    "C": 0.076,
    "N": 0.071,
    "O": 0.066,
    "F": 0.057,
    "SI": 0.111,
    "P": 0.107,
    "S": 0.105,
    "CL": 0.102,
    "SE": 0.120,
    "BR": 0.120,
    "I": 0.139,
}
# Radius used for an element the table does not name (carbon-like, conservative).
COVALENT_RADIUS_DEFAULT_NM = 0.077
# Tolerance on the radius sum. 1.2 is the long-standing convention for
# covalent-bond detection from coordinates; it accepts a stretched bond in an
# unminimised structure without reaching the next shell (a 1-4 pair, an H-bond).
COVALENT_BOND_SCALE = 1.2

# BACKBONE LINKAGE: the only atom-name pairs allowed to bond ACROSS two
# sequence-adjacent residues of one chain, written (tail atom in residue i, head
# atom in residue i+1). Protein C->N is what mdtraj's own templates already
# supply; nucleic O3'->P is the one they never do, which is why a nucleic
# backbone arrives 100% unlinked. ``O3*`` is the PDB v2 spelling of ``O3'``.
BACKBONE_LINKAGE_PAIRS: Tuple[Tuple[str, str], ...] = (
    ("C", "N"),
    ("O3'", "P"),
    ("O3*", "P"),
)
# Every atom name that appears in a linkage pair — the only names the linkage
# scope needs to look up on a residue.
LINKAGE_ATOM_NAMES = frozenset(name for pair in BACKBONE_LINKAGE_PAIRS for name in pair)

# CROSSLINK: bonds between residues that are NOT sequence-adjacent exist in real
# structures, but only for a short list of chemistries — disulfide (S-S),
# thioether and lanthionine (S-C). Requiring one endpoint to be a chalcogen is
# what keeps this scope from becoming a general distance search.
CROSSLINK_ELEMENTS = frozenset({"S", "SE"})

# Virtual / dummy sites carry no chemistry and must never be bonded: a TIP4P
# M-site sits ~0.015 nm from its oxygen, so any distance rule would bond it.
# mdtraj gives them the element symbol ``VS`` (MEASURED on the corpus TIP4P
# system: 501 atoms named M, element symbol VS, name "virtual_site"); a topology
# that carries no element at all arrives as ``element is None``, which the
# inference excludes separately. Kept to what is measured — a symbol added on
# a guess (``D`` is deuterium in real files) would silently drop real bonds.
VIRTUAL_SITE_ELEMENTS = frozenset({"VS"})


def covalent_radius_nm(symbol: Optional[str]) -> float:
    """Covalent radius (nm) for an element symbol, case-insensitive, with the
    conservative default for anything unnamed (including None)."""
    if not symbol:
        return COVALENT_RADIUS_DEFAULT_NM
    return COVALENT_RADII_NM.get(symbol.upper(), COVALENT_RADIUS_DEFAULT_NM)


def max_covalent_radius_nm() -> float:
    """Largest radius in the table — the bound a neighbour search needs."""
    return max(COVALENT_RADII_NM.values())


def max_crosslink_radius_nm() -> float:
    """Largest radius among the crosslink elements. With
    ``max_covalent_radius_nm`` this bounds the crosslink neighbour search:
    no crosslink candidate can be farther than
    ``(this + max_covalent_radius_nm()) * COVALENT_BOND_SCALE``."""
    return max(covalent_radius_nm(sym) for sym in CROSSLINK_ELEMENTS)


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
