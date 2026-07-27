"""Covalent-bond inference from coordinates — the GEOMETRY, none of the vocabulary.

WHY THIS EXISTS. ``mdtraj_source._edges()`` used to have an all-or-nothing gate:
if a topology declared ZERO bonds it called ``create_standard_bonds()``, and
otherwise it inferred nothing at all. Two failures follow from that, and both are
measured:

  * ``create_standard_bonds()`` is TEMPLATE-only — standard amino acids and
    nucleotides. It bonds protein C-N but never nucleic O3'-P, so a nucleic
    backbone arrives 100% unlinked (10GJ.cif: 291 of 1036 consecutive-residue
    links absent; the corpus duplex: 22 of 22).
  * the gate is all-or-nothing, so a topology with ANY bonds gets NO inference.
    A PDB whose HETATM records carry no CONECT leaves every ligand bare: the
    membrane system's 482 DMPC lipids (56,876 atoms) and an AlphaFold cif's ADP
    and phosphothreonine all arrive as loose dust.

WHAT THIS DOES. Additive, never subtractive: it proposes NEW ``(i, j)`` pairs and
the caller unions them with whatever the topology already declared. Nothing is
ever removed.

THREE SCOPES, AND WHY NOT ONE. The obvious implementation is a global KD-tree over
every atom, keeping every pair within its covalent window. That was built first,
and it MATCHED THE AUTHORITATIVE CHARMM PSF EXACTLY on the disulfide/lanthionine
system (82 of 82 bonds, no false positives). It is still wrong, and a topology
check — not a bond count — is what refuted it. MEASURED on the membrane's 482 DMPC
lipids (56,876 atoms), which must come out as 482 acyclic components:

    scoped (this module)      482 components, 56,394 bonds,     0 rings
    unscoped global search    742 components, 59,709 bonds, 3,575 rings
    unscoped, no H rule         3 components, 66,264 bonds, 9,391 rings
                                             (23,637 cross-residue false bonds)

The cause is that ``membrane.pdb`` genuinely contains 1,788 atom pairs closer than
0.05 nm — a real MD box has clashing inter-molecular contacts. So no distance
threshold separates "the same molecule" from "two molecules touching", and the
unscoped search both FUSES lipids (rings appear, and with the hydrogen rule off the
whole leaflet collapses to 3 blobs) and SHREDS them (742 > 482: a lipid hydrogen's
nearest neighbour turns out to be in a passing water, so the H detaches from its
own carbon). Tuning the threshold cannot fix either. The search is SCOPED by
chemistry instead, and cross-molecule fusion becomes impossible BY CONSTRUCTION:

  1. INTRA-RESIDUE — all pairs inside ONE residue record. A residue record is the
     smallest unit a file format guarantees is one molecule, so a bond found here
     cannot fuse two molecules.
  2. BACKBONE LINKAGE — between SEQUENCE-ADJACENT residues of one chain, and only
     for the named atom pairs in ``domain_rules.BACKBONE_LINKAGE_PAIRS``
     (C->N, O3'->P). Still distance-checked; the name pair is a second gate, not
     a replacement for the first.
  3. CROSSLINK — between residues that are NOT sequence-adjacent, and only where
     at least one endpoint is a chalcogen (``CROSSLINK_ELEMENTS``): disulfide,
     thioether, lanthionine. Solvent is excluded, so no water can ever be a
     crosslink endpoint.

That leaves ONE way for two residues to bond: a named backbone linkage between
neighbours, or a chalcogen crosslink. A water-water, water-lipid or lipid-lipid
false bond is unreachable — not unlikely, unreachable.

The scoping is load-bearing, so ``tests/bond_inference.py`` carries a NEGATIVE
CONTROL that runs the unscoped global search and asserts it DOES fuse DMPC. A
test net that passes whether or not the scoping exists would prove nothing.

FOUR MORE RULES, each earning its place:
  * a MONATOMIC residue (an ion: ZN, MG, NA, CL, SOD, CLA, POT) is excluded
    outright. A lone ion has no covalent bonds, and its coordination shell sits
    inside any covalent window.
  * a VIRTUAL SITE (element None, or a ``VIRTUAL_SITE_ELEMENTS`` symbol) is
    excluded. A TIP4P M-site is 0.015 nm from its oxygen.
  * H-H is never bonded.
  * a hydrogen keeps only its SINGLE NEAREST new partner. Hydrogen is monovalent.
    Stated honestly: on every system measured here this rule DROPS NOTHING — inside
    one residue record a hydrogen has exactly one heavy atom in range — so it is a
    guard against a case the evidence base does not contain, not a fix for a
    measured defect. It is nonetheless what stops the unscoped search from being
    even wronger (see the table above), and it is tested on a purpose-built
    fixture rather than left to be exercised by accident.

The vocabulary — radii, the linkage atom names, the crosslink elements — lives in
``domain_rules.py``, which declares itself the one place molecular vocabulary
lives. This module names no element and no atom name of its own; it is distance
arithmetic over arrays.

scipy's cKDTree is used, and is safe: scipy is a transitive mdtraj dependency, so
any interpreter that can import the real source can import this. It is imported
LAZILY (``_kdtree()``), because ``serve.py`` reads ``MODES``/``DEFAULT_MODE`` from
this module to build its CLI and a synthetic-only run must not pay 185 ms of
scipy import for a flag default it will never use.
"""
from __future__ import annotations

import time
from collections import Counter
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

import numpy as np

from producer.domain_rules import (
    BACKBONE_LINKAGE_PAIRS,
    COVALENT_BOND_SCALE,
    CROSSLINK_ELEMENTS,
    LINKAGE_ATOM_NAMES,
    SOLVENT_RESIDUES,
    VIRTUAL_SITE_ELEMENTS,
    covalent_radius_nm,
    max_covalent_radius_nm,
    max_crosslink_radius_nm,
)

# The three inference modes, and the default.
#
#   "full"       every scope, every residue — the default, because the failure
#                this fixes is the common case (a PDB with no CONECT records).
#   "nonsolvent" every scope, but solvent residues are excluded entirely. The
#                escape hatch for cost: on the membrane the solvent is 67,082 of
#                the 123,476 inferred bonds, and water O-H is the connectivity a
#                user is least likely to be looking at.
#   "off"        infer nothing. The REGRESSION escape hatch: the edge list is then
#                byte-identical to the pre-inference producer, which is provable
#                and is proven (tests/bond_inference.py block F).
MODES: Tuple[str, ...] = ("full", "nonsolvent", "off")
DEFAULT_MODE = "full"

# Above this many atoms, a residue's intra-residue pairs come from a KD-tree
# rather than a dense upper triangle. A dense triu is O(k^2) in both time and
# MEMORY: at k = 56,876 (what one residue record would hold if a whole membrane
# leaflet were merged into one) that is 1.6 billion pairs. The threshold sits well
# above every real residue (the largest in the corpus is a 118-atom DMPC lipid and
# the largest merged water record is ~30 atoms) so the common path is the cheap
# dense one, and above it the cost degrades to O(k log k).
DENSE_RESIDUE_MAX_ATOMS = 200

# Scope labels, for attribution in the report (and thence in Header.provenance).
SCOPE_INTRA = "intra"
SCOPE_LINKAGE = "linkage"
SCOPE_CROSSLINK = "crosslink"


def _kdtree(points):
    """scipy's cKDTree, imported on first use (see the module note on why)."""
    from scipy.spatial import cKDTree

    return cKDTree(points)


class InferredBonds(NamedTuple):
    """What inference proposed, and which scope proposed it.

    ``pairs`` is sorted, deduplicated, ``i < j``, and contains no pair the
    topology already declared. The per-scope counts sum to ``len(pairs)`` — each
    surviving pair is attributed to exactly one scope (the first that proposed
    it, in scope order).
    """

    mode: str
    pairs: List[Tuple[int, int]]
    intra: int
    linkage: int
    crosslink: int
    # Candidate bonds discarded by the one-partner-per-hydrogen rule. Not an
    # error — evidence the rule fired.
    hydrogen_candidates_dropped: int
    elapsed_s: float

    @property
    def added(self) -> int:
        return len(self.pairs)


class _AtomTable(NamedTuple):
    """Per-atom arrays the scopes share, built in ONE pass over the topology."""

    symbol: List[str]
    radius: np.ndarray            # (N,) float64, nm
    is_hydrogen: np.ndarray       # (N,) bool
    excluded: np.ndarray          # (N,) bool — never a bond endpoint
    residue_of: np.ndarray        # (N,) int32 — residue index per atom
    is_solvent: np.ndarray        # (N,) bool — residue name in SOLVENT_RESIDUES
    atoms_by_residue: List[List[int]]


def infer_bonds(topology, xyz, mode: str = DEFAULT_MODE) -> InferredBonds:
    """Propose NEW bonds for ``topology`` at coordinates ``xyz`` ((N, 3), nm).

    Pure: reads the topology, never mutates it. The returned pairs are sorted,
    deduplicated, ``i < j``, and disjoint from ``topology.bonds``.

    ``mode`` is one of ``MODES``; an unknown mode raises rather than silently
    falling back, because a typo'd setting must not quietly disable a fix.
    """
    if mode not in MODES:
        raise ValueError(f"unknown bond-inference mode {mode!r} (expected one of {MODES})")
    started = time.perf_counter()
    if mode == "off":
        return InferredBonds(mode, [], 0, 0, 0, 0, 0.0)

    xyz = np.asarray(xyz)
    if xyz.ndim != 2 or xyz.shape[1] != 3:
        raise ValueError(f"xyz must be (N, 3); got {xyz.shape}")
    if xyz.shape[0] != topology.n_atoms:
        raise ValueError(
            f"xyz has {xyz.shape[0]} atoms, topology has {topology.n_atoms}"
        )

    table = _atom_table(topology, mode)
    existing = _existing_pairs(topology)

    # (i, j, distance, scope) candidates, in scope order.
    candidates: List[Tuple[int, int, float, str]] = []
    candidates.extend(_intra_residue_candidates(xyz, table))
    candidates.extend(_linkage_candidates(topology, xyz, table))
    candidates.extend(_crosslink_candidates(xyz, table))

    pairs, scope_of, dropped = _resolve(candidates, existing, table)
    counts = Counter(scope_of[p] for p in pairs)
    return InferredBonds(
        mode=mode,
        pairs=pairs,
        intra=counts[SCOPE_INTRA],
        linkage=counts[SCOPE_LINKAGE],
        crosslink=counts[SCOPE_CROSSLINK],
        hydrogen_candidates_dropped=dropped,
        elapsed_s=time.perf_counter() - started,
    )


# -- shared per-atom table -----------------------------------------------------


def _atom_table(topology, mode: str) -> _AtomTable:
    n = topology.n_atoms
    symbol: List[str] = []
    excluded = np.zeros(n, dtype=bool)
    is_hydrogen = np.zeros(n, dtype=bool)
    is_solvent = np.zeros(n, dtype=bool)
    residue_of = np.zeros(n, dtype=np.int32)
    radius = np.empty(n, dtype=np.float64)
    atoms_by_residue: List[List[int]] = [[] for _ in range(topology.n_residues)]

    solvent_mode = mode == "nonsolvent"
    for atom in topology.atoms:
        i = atom.index
        element = atom.element
        sym = (element.symbol if element is not None else "").upper()
        symbol.append(sym)
        radius[i] = covalent_radius_nm(sym)
        is_hydrogen[i] = sym == "H"
        res = atom.residue
        residue_of[i] = res.index
        atoms_by_residue[res.index].append(i)
        solvent = res.name.upper() in SOLVENT_RESIDUES
        is_solvent[i] = solvent
        # A lone ion has no covalent bonds; a virtual site has no chemistry;
        # an atom with no element at all cannot be given a radius honestly.
        if (
            res.n_atoms == 1
            or element is None
            or sym in VIRTUAL_SITE_ELEMENTS
            or (solvent_mode and solvent)
        ):
            excluded[i] = True

    return _AtomTable(
        symbol=symbol,
        radius=radius,
        is_hydrogen=is_hydrogen,
        excluded=excluded,
        residue_of=residue_of,
        is_solvent=is_solvent,
        atoms_by_residue=atoms_by_residue,
    )


def _existing_pairs(topology) -> Set[Tuple[int, int]]:
    """Every bond the topology already declares, normalised to ``i < j``."""
    return {
        (a.index, b.index) if a.index < b.index else (b.index, a.index)
        for a, b in topology.bonds
    }


# -- scope 1: intra-residue ----------------------------------------------------


def _intra_residue_candidates(xyz, table: _AtomTable):
    """All pairs inside one residue record within covalent range.

    Small residues take a dense upper triangle; a residue over
    ``DENSE_RESIDUE_MAX_ATOMS`` takes a KD-tree, queried at the residue's own
    upper bound ``2 * max_radius * SCALE`` (a strict superset of every pair's own
    window, so the exact per-pair test below decides, not the query radius).
    """
    radius, is_h, excluded = table.radius, table.is_hydrogen, table.excluded
    for members in table.atoms_by_residue:
        if len(members) < 2:
            continue
        idx = np.asarray(members, dtype=np.int64)
        idx = idx[~excluded[idx]]
        if len(idx) < 2:
            continue
        if len(idx) > DENSE_RESIDUE_MAX_ATOMS:
            reach = 2.0 * float(radius[idx].max()) * COVALENT_BOND_SCALE
            local = _kdtree(xyz[idx]).query_pairs(reach, output_type="ndarray")
            if len(local) == 0:
                continue
            gi, gj = idx[local[:, 0]], idx[local[:, 1]]
        else:
            a, b = np.triu_indices(len(idx), 1)
            gi, gj = idx[a], idx[b]
        d = np.linalg.norm(xyz[gi] - xyz[gj], axis=1)
        keep = (d <= (radius[gi] + radius[gj]) * COVALENT_BOND_SCALE) & ~(
            is_h[gi] & is_h[gj]
        )
        for i, j, dist in zip(gi[keep].tolist(), gj[keep].tolist(), d[keep].tolist()):
            yield (i, j, dist, SCOPE_INTRA)


# -- scope 2: backbone linkage between sequence-adjacent residues --------------


def _linkage_candidates(topology, xyz, table: _AtomTable):
    """Named linkage pairs between residue i and residue i+1 of one chain.

    Only ``LINKAGE_ATOM_NAMES`` are looked up, so the per-residue name map holds
    at most a handful of entries however large the residue is; and the map for
    residue i+1 is reused as the map for residue i on the next step, so each
    residue is scanned once.
    """
    radius, excluded = table.radius, table.excluded
    for chain in topology.chains:
        previous: Optional[Dict[str, int]] = None
        for residue in chain.residues:
            current = {
                atom.name: atom.index
                for atom in residue.atoms
                if atom.name in LINKAGE_ATOM_NAMES
            }
            if previous:
                for tail, head in BACKBONE_LINKAGE_PAIRS:
                    if tail in previous and head in current:
                        i, j = previous[tail], current[head]
                        if excluded[i] or excluded[j]:
                            continue
                        dist = float(np.linalg.norm(xyz[i] - xyz[j]))
                        if dist <= (radius[i] + radius[j]) * COVALENT_BOND_SCALE:
                            yield (i, j, dist, SCOPE_LINKAGE)
            previous = current


# -- scope 3: chalcogen crosslinks between non-adjacent residues ---------------


def _crosslink_candidates(xyz, table: _AtomTable):
    """Bonds between residues that are NOT sequence-adjacent, where at least one
    endpoint is a crosslink element (S/Se). Solvent is excluded on both sides —
    a water can never be a crosslink endpoint — as are hydrogens on the partner
    side (a crosslink is a heavy-atom bond).

    Sequence adjacency is judged on the residue INDEX, which is mdtraj's file
    order: an ``i``/``i+1`` pair is scope 2's business and reaching it here would
    duplicate that scope's named-pair gate with a bare distance test.
    """
    radius, is_h, excluded = table.radius, table.is_hydrogen, table.excluded
    residue_of = table.residue_of
    eligible = ~excluded & ~table.is_solvent
    symbols = table.symbol

    seeds = [
        i for i in range(len(symbols)) if symbols[i] in CROSSLINK_ELEMENTS and eligible[i]
    ]
    if not seeds:
        return
    heavy = np.flatnonzero(eligible & ~is_h)
    if heavy.size == 0:
        return

    tree = _kdtree(xyz[heavy])
    # Bound: no crosslink candidate can be farther than the largest chalcogen
    # radius plus the largest radius in the table, scaled. Derived from the
    # vocabulary rather than hardcoded, so adding an element cannot leave the
    # search radius behind.
    reach = (max_crosslink_radius_nm() + max_covalent_radius_nm()) * COVALENT_BOND_SCALE
    for i in seeds:
        ri = residue_of[i]
        for k in tree.query_ball_point(xyz[i], reach):
            j = int(heavy[k])
            if j == i or abs(int(residue_of[j]) - int(ri)) <= 1:
                continue
            dist = float(np.linalg.norm(xyz[i] - xyz[j]))
            if dist <= (radius[i] + radius[j]) * COVALENT_BOND_SCALE:
                lo, hi = (i, j) if i < j else (j, i)
                yield (lo, hi, dist, SCOPE_CROSSLINK)


# -- dedupe, the hydrogen rule, and scope attribution --------------------------


def _resolve(candidates, existing: Set[Tuple[int, int]], table: _AtomTable):
    """Turn candidates into the final sorted pair list.

    Drops anything the topology already declares (ADDITIVE ONLY — an existing
    bond is never removed and never re-proposed), then applies the one-partner
    rule: among the NEW candidates touching a given hydrogen, only the nearest
    survives. Ties break toward the first candidate seen, which is scope order.
    """
    is_h = table.is_hydrogen
    chosen: Dict[Tuple[int, int], str] = {}
    best_for_hydrogen: Dict[int, Tuple[float, Tuple[int, int], str]] = {}
    hydrogen_candidates = 0

    for i, j, dist, scope in candidates:
        key = (i, j) if i < j else (j, i)
        if key in existing:
            continue
        h = i if is_h[i] else (j if is_h[j] else None)
        if h is None:
            chosen.setdefault(key, scope)
            continue
        hydrogen_candidates += 1
        previous = best_for_hydrogen.get(h)
        if previous is None or dist < previous[0]:
            best_for_hydrogen[h] = (dist, key, scope)

    for _dist, key, scope in best_for_hydrogen.values():
        chosen.setdefault(key, scope)

    dropped = hydrogen_candidates - len(best_for_hydrogen)
    return sorted(chosen), chosen, dropped


# -- the negative control's counterpart ----------------------------------------


def infer_bonds_unscoped(topology, xyz) -> List[Tuple[int, int]]:
    """The WRONG implementation, kept on purpose: one global KD-tree over every
    eligible atom, no residue scoping at all.

    This is here so ``tests/bond_inference.py`` can MEASURE what the scoping
    prevents instead of asserting it in prose. Run on the membrane it fuses the
    DMPC leaflet into a few dozen ringed blobs. It is never called by the
    producer; ``_edges()`` reaches only ``infer_bonds``.
    """
    xyz = np.asarray(xyz)
    table = _atom_table(topology, DEFAULT_MODE)
    existing = _existing_pairs(topology)
    radius, is_h, excluded = table.radius, table.is_hydrogen, table.excluded

    idx = np.flatnonzero(~excluded)
    reach = 2.0 * max_covalent_radius_nm() * COVALENT_BOND_SCALE
    local = _kdtree(xyz[idx]).query_pairs(reach, output_type="ndarray")
    if len(local) == 0:
        return []
    gi, gj = idx[local[:, 0]], idx[local[:, 1]]
    d = np.linalg.norm(xyz[gi] - xyz[gj], axis=1)
    keep = (d <= (radius[gi] + radius[gj]) * COVALENT_BOND_SCALE) & ~(is_h[gi] & is_h[gj])
    candidates = [
        (i, j, dist, SCOPE_INTRA)
        for i, j, dist in zip(gi[keep].tolist(), gj[keep].tolist(), d[keep].tolist())
    ]
    pairs, _scope_of, _dropped = _resolve(candidates, existing, table)
    return pairs
