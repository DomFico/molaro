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
    unscoped global search    670 components, 59,703 bonds, 3,497 rings
    unscoped, no H rule         3 components, 65,852 bonds, 8,979 rings
                                             (22,610 cross-residue false bonds)

The cause is that ``membrane.pdb`` genuinely contains 1,788 atom pairs closer than
0.05 nm — a real MD box has clashing inter-molecular contacts. So no distance
threshold separates "the same molecule" from "two molecules touching", and the
unscoped search both FUSES lipids (rings appear, and with the hydrogen rule off the
whole leaflet collapses to 3 blobs) and SHREDS them (670 > 482: a lipid hydrogen's
nearest neighbour turns out to be in a passing water, so the H detaches from its
own carbon). Tuning the threshold cannot fix either. The search is SCOPED by
chemistry instead, and cross-molecule fusion becomes impossible BY CONSTRUCTION:

  1. INTRA-RESIDUE — all pairs inside ONE residue record.
  2. BACKBONE LINKAGE — between SEQUENCE-ADJACENT residues of one chain, and only
     for the named atom pairs in ``domain_rules.BACKBONE_LINKAGE_PAIRS``
     (C->N, O3'->P). Still distance-checked; the name pair is a second gate, not
     a replacement for the first.
  3. CROSSLINK — between two DIFFERENT residues, and only where at least one
     endpoint is a chalcogen (``CROSSLINK_ELEMENTS``): disulfide, thioether,
     lanthionine. Solvent is excluded, so no water can ever be a crosslink
     endpoint.

That leaves ONE way for two residues to bond: a named backbone linkage between
neighbours, or a chalcogen crosslink. A water-water, water-lipid or lipid-lipid
false bond needs a chalcogen that solvent and lipid do not have, or a backbone
atom name they do not carry.

WHAT SCOPE 1 DOES AND DOES NOT GUARANTEE — stated precisely, because the loose
version of this claim is false on the very file this module exists to fix. The
intuition is "a residue record is one molecule, so an intra-record bond cannot
fuse two molecules". That is a FILE-FORMAT convention, not an invariant, and
``membrane.pdb`` breaks it: PDB resSeq overflows at 9,999, so mdtraj merges 47,829
waters into 14,300 HOH records — 3,726 of those records hold TEN water molecules
each (MEASURED: the record-size histogram for HOH is {3: 10574, 15: 1, 30: 3725}).
Scope 1 therefore does run an all-pairs search across ten distinct molecules on
54% of the bonds it infers here. Nothing fuses, and that is MEASURED, not assumed:
the tightest cross-molecule non-H-H pair inside one merged record is H...O at
0.1628 nm against a 0.1164 nm window (+40%) and O...O at 0.2543 nm against 0.1584
(+61%), and the final graph contains 0 cross-molecule water bonds. So on merged
records the protection is a DISTANCE MARGIN, and any future change to
``COVALENT_BOND_SCALE`` or ``COVALENT_RADII_NM`` must re-measure it — which
``tests/bond_inference.py`` block B now does, by asserting the solvent
connected-component sizes rather than trusting the record boundary.

The scoping is load-bearing, so ``tests/bond_inference.py`` carries a NEGATIVE
CONTROL that runs the unscoped global search and asserts it DOES fuse DMPC. A
test net that passes whether or not the scoping exists would prove nothing.

FIVE MORE RULES, each earning its place:
  * a MONATOMIC residue (an ion: ZN, MG, NA, CL, SOD, CLA, POT) is excluded
    outright. A lone ion has no covalent bonds, and its coordination shell sits
    inside any covalent window.
  * a VIRTUAL SITE (element None, or a ``VIRTUAL_SITE_ELEMENTS`` symbol) is
    excluded. A TIP4P M-site is 0.015 nm from its oxygen.
  * H-H is never bonded.
  * a pair shorter than ``MIN_COVALENT_BOND_NM`` is never bonded. The covalent
    window has an upper bound and no lower one, so a DUPLICATED atom record —
    same name, same coordinates, no altloc — sits at distance 0.000 and satisfies
    it trivially, and inference emitted a zero-length edge. MEASURED on a
    5-atom fixture with one duplicated CA: 3 inferred bonds, 1 of them (1, 2) at
    0.000 nm.
  * a hydrogen ends up with exactly ONE bond. Hydrogen is monovalent, so among the
    NEW candidates touching a given hydrogen only the nearest survives — AND a
    hydrogen the topology ALREADY bonded gets no inferred bond at all, because
    inference is additive and cannot take the declared one away. That second half
    was missing and was not hypothetical: 20 PRO.HG2 and 4 PRO.HB3 on the corpus
    membrane are declared bonded to CG/CB at ~0.1115 nm and sit ~0.1108-0.1255 nm
    from a SECOND ring carbon, inside the 0.1284 nm C-H window, so inference gave
    them a second partner — 24 divalent hydrogens, 24 pentavalent carbons and 24
    three-membered C-C-H rings, in the shipped default mode. Over-bonding is the
    fail-UNSAFE direction, so the rule is now stated over the union of declared
    and proposed bonds, and ``tests/bond_inference.py`` grades atom DEGREE on
    every real system rather than pinning a bond count that could contain them.

The vocabulary — radii, the linkage atom names, the crosslink elements, the bond
length floor — lives in ``domain_rules.py``, which declares itself the one place
molecular vocabulary lives. This module names no element and no atom name of its
own; it is distance arithmetic over arrays.

COST is proportional to ATOMS, not to residue records. That is a deliberate
property with a history: the first implementation looped over residues in Python
with per-residue numpy calls, which cost ~16 us per RECORD, and the only large
system available to measure it (``membrane.pdb``) has an accidentally MERGED
residue table — so it flattered itself. Rebuilding the same 222,227 atoms with one
record per water (50,031 records, what any normally-numbered file gives) took the
same inference from 0.658 s to 1.148 s for an IDENTICAL set of bonds. Scope 1 is
now vectorised by BUCKETING residues by size and computing every same-size
record's pair table in one array operation, so there is no per-record Python at
all: the same pair of topologies now measures 0.364 s and 0.377 s (1.04x, from
1.73x), and the membrane as filed went 0.658 s -> 0.364 s on the way, for
+18.6 MiB of peak memory against the old +7.7 MiB (see INTRA_PAIR_CHUNK).
``tests/bond_inference.py`` block K asserts BOTH — a loose absolute ceiling and
the RATIO between those two topologies — which is the assertion the original
lacked entirely: a 10x repeat of the intra distance computation used to leave all
175 checks green.

scipy's cKDTree is used only where an array pass cannot bound itself — a residue
record over ``DENSE_RESIDUE_MAX_ATOMS`` atoms, or a crosslink search too large to
brute-force — and is safe there: scipy is a transitive mdtraj dependency, so any
interpreter that can import the real source can import this. It is imported LAZILY
(``_kdtree()``); the laziness now buys something real, because the common case
reaches neither path and never pays the ~0.14 s + ~25 MiB scipy import at all.
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
    MIN_COVALENT_BOND_NM,
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
#                escape hatch for cost: MEASURED on the membrane, the solvent is
#                67,058 of the 123,452 inferred bonds (attributed by residue
#                name: HOH 67,058 + DMPC 56,394), and water O-H is the
#                connectivity a user is least likely to be looking at.
#   "off"        infer nothing. The REGRESSION escape hatch: the edge list is then
#                byte-identical to the pre-inference producer, which is provable
#                and is proven (tests/bond_inference.py block F).
MODES: Tuple[str, ...] = ("full", "nonsolvent", "off")
DEFAULT_MODE = "full"

# Above this many atoms, a residue's intra-residue pairs come from a KD-tree
# rather than a dense upper triangle. A dense triu is O(k^2) in both time and
# MEMORY: at k = 56,876 (what one residue record would hold if a whole membrane
# leaflet were merged into one) that is 1.6 billion pairs.
#
# The value is MEASURED at the crossover of the two paths AS THIS MODULE RUNS
# THEM, on the record shapes real files contain — which is not the same as timing
# one residue at a time against a synthetic chain. Two things move the crossover:
# the dense path is BUCKETED, so all M records of size k share ONE array pass,
# while the KD path builds M separate trees in a Python loop (~30 us per record);
# and a real residue is a compact blob, not a chain, so a KD query returns a
# roughly constant number of neighbours per atom while a dense triu returns
# k^2/2. Sweeping this constant over the whole intra scope (MEASURED, best of 3):
#
#                            membrane.pdb        membrane_frame0.pdb
#     threshold  4              147 ms                118 ms
#     threshold 24              125 ms                100 ms   <- fastest
#     threshold 32              178 ms                 95 ms
#     threshold 100             181 ms                 95 ms
#     threshold 400/inf         361 ms               1551 ms
#
# 64 rather than the 125 ms optimum, and deliberately: the threshold is set from a
# CENSUS of what real files hold, not from the timing sweep alone, because the
# other thing this branch decides is whether scipy gets imported at all. Largest
# residue record, MEASURED across the whole evidence base:
#
#     ordinary records    01: 10 | 04: 16 | 02/03/BACD: 24 (TRP/ARG) | 10GJ: 23
#                         AF cif: 27 (ADP) | 09 duplex: 34 (a DG nucleotide + H)
#     the next class up   membrane.pdb: 118 (a DMPC lipid)
#                         membrane_frame0.pdb: 300 (a merged HOH block, x372)
#
# There is a clean gap between 34 and 118, and 64 sits in it. Every ordinary file
# therefore stays on the array path and never reaches ``_kdtree``, so it never
# pays scipy's ~0.14 s + ~25 MiB import — which is the whole value of the lazy
# import. (The membrane does pay it; on a 222,227-atom system 0.14 s is noise.)
# The timing sweep says 64 costs ~4 ms against 32 and ~57 ms against the 24
# optimum on membrane.pdb, and nothing at all on membrane_frame0.pdb. Above the
# threshold the KD path wins decisively, and the branch is reachable from real
# data rather than only from a fixture: membrane_frame0.pdb's 300-atom records
# cost 1551 ms dense against 95 ms KD.
DENSE_RESIDUE_MAX_ATOMS = 64

# Peak-memory bound on the bucketed dense pass: at most this many candidate pairs
# are materialised at once, so one bucket of many large records is chunked instead
# of allocating its whole pair table. The exact test below builds three (chunk, 3)
# float64 arrays (the two gathers and their difference), so the transient is
# ~72 bytes per pair.
#
# MEASURED on the 222,227-atom membrane, peak RSS attributable to inference and
# best-of-3 wall time — the value is set from the knee, not from a round number:
#
#     chunk 2 000 000    +111.6 MiB    0.741 s
#     chunk   500 000     +26.4 MiB    0.683 s
#     chunk   250 000     +18.3 MiB    0.675 s
#     chunk   125 000        —         0.702 s
#
# Bigger chunks buy nothing (the arrays are already far past any cache) and cost
# a lot: the pre-bucketing per-record implementation held +7.7 MiB, so an
# unbounded chunk would have been a 15x peak-memory regression traded for no time.
INTRA_PAIR_CHUNK = 250_000

# The crosslink scope compares |seeds| chalcogens against |heavy| eligible heavy
# atoms. Below this many pair comparisons it does so with a chunked array pass,
# which is both faster than building a KD-tree and — the point — does not import
# scipy at all. MEASURED: every system in the evidence base lands here (the
# largest is the membrane at 20 x ~26k = ~520k), so a real protein no longer pays
# ~0.14 s and ~25 MiB to import scipy for a scope that adds nothing.
CROSSLINK_BRUTE_MAX_PAIRS = 4_000_000
# Seeds per chunk are chosen so a chunk holds at most this many comparisons.
CROSSLINK_CHUNK_PAIRS = 1_000_000

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
    residue_of = np.zeros(n, dtype=np.int64)
    radius = np.empty(n, dtype=np.float64)

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
    )


def _existing_pairs(topology) -> Set[Tuple[int, int]]:
    """Every bond the topology already declares, normalised to ``i < j``."""
    return {
        (a.index, b.index) if a.index < b.index else (b.index, a.index)
        for a, b in topology.bonds
    }


# -- scope 1: intra-residue ----------------------------------------------------


def _window_survivors(xyz, table: _AtomTable, gi: np.ndarray, gj: np.ndarray):
    """THE covalent test, shared by every scope so none can drift from another.

    Keeps a pair when its distance is inside ``(r_i + r_j) * SCALE``, is not below
    ``MIN_COVALENT_BOND_NM`` (a duplicated atom record is not a bond), and is not
    H-H. Returns the surviving ``(i, j, distance)`` arrays.
    """
    radius, is_h = table.radius, table.is_hydrogen
    d = np.linalg.norm(xyz[gi] - xyz[gj], axis=1)
    keep = (
        (d <= (radius[gi] + radius[gj]) * COVALENT_BOND_SCALE)
        & (d >= MIN_COVALENT_BOND_NM)
        & ~(is_h[gi] & is_h[gj])
    )
    return gi[keep], gj[keep], d[keep]


def _residue_blocks(table: _AtomTable):
    """Eligible atoms grouped into equal-size residue records, without touching
    Python once per residue.

    Yields ``(k, block)`` where ``block`` is an ``(M, k)`` int array: M residue
    records that each hold exactly k eligible atoms. Bucketing by size is what
    lets one array operation serve every record of that size — the alternative,
    a Python loop with per-residue numpy calls, costs ~16 us per RECORD and made
    inference 74% more expensive on a topology with one record per water than on
    the same atoms with waters merged (see the module note on cost).
    """
    atoms = np.flatnonzero(~table.excluded)
    if atoms.size < 2:
        return
    res = table.residue_of[atoms]
    if res.size > 1 and not bool((res[1:] >= res[:-1]).all()):
        order = np.argsort(res, kind="stable")
        atoms, res = atoms[order], res[order]
    # Run boundaries in the (now sorted) residue-index column.
    starts = np.flatnonzero(np.concatenate(([True], res[1:] != res[:-1])))
    counts = np.diff(np.concatenate((starts, [res.size])))
    for k in np.unique(counts).tolist():
        if k < 2:
            continue
        st = starts[counts == k]
        offsets = np.arange(k, dtype=np.int64)
        if k > DENSE_RESIDUE_MAX_ATOMS:
            # One record at a time: a dense pair table this wide is O(k^2) MEMORY.
            for s0 in st.tolist():
                yield k, atoms[s0 : s0 + k][None, :]
            continue
        per_row = (k * (k - 1)) // 2
        step = max(1, INTRA_PAIR_CHUNK // per_row)
        for s in range(0, st.size, step):
            yield k, atoms[st[s : s + step, None] + offsets[None, :]]


def _intra_residue_candidates(xyz, table: _AtomTable):
    """All pairs inside one residue record within covalent range.

    Records of the same size are processed as ONE array (see ``_residue_blocks``);
    a record over ``DENSE_RESIDUE_MAX_ATOMS`` falls back to a KD-tree queried at
    that record's own upper bound ``2 * max_radius * SCALE`` — a strict superset
    of every pair's own window, so ``_window_survivors`` decides, not the query
    radius.
    """
    radius = table.radius
    for k, block in _residue_blocks(table):
        if k > DENSE_RESIDUE_MAX_ATOMS:
            idx = block[0]
            reach = 2.0 * float(radius[idx].max()) * COVALENT_BOND_SCALE
            local = _kdtree(xyz[idx]).query_pairs(reach, output_type="ndarray")
            if len(local) == 0:
                continue
            gi, gj = idx[local[:, 0]], idx[local[:, 1]]
        else:
            a, b = np.triu_indices(k, 1)
            gi, gj = block[:, a].ravel(), block[:, b].ravel()
        gi, gj, d = _window_survivors(xyz, table, gi, gj)
        for i, j, dist in zip(gi.tolist(), gj.tolist(), d.tolist()):
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
                        if (
                            MIN_COVALENT_BOND_NM
                            <= dist
                            <= (radius[i] + radius[j]) * COVALENT_BOND_SCALE
                        ):
                            yield (i, j, dist, SCOPE_LINKAGE)
            previous = current


# -- scope 3: chalcogen crosslinks between non-adjacent residues ---------------


def _crosslink_candidates(xyz, table: _AtomTable):
    """Bonds between two DIFFERENT residues where at least one endpoint is a
    crosslink element (S/Se). Solvent is excluded on both sides — a water can
    never be a crosslink endpoint — as are hydrogens on the partner side (a
    crosslink is a heavy-atom bond).

    The only residue pair this scope refuses is a residue with ITSELF, which is
    scope 1's business. It used to also refuse residues whose INDEX differed by 1,
    justified as "an i/i+1 pair is scope 2's business" — and that was wrong twice.
    Scope 2 iterates ``for chain in topology.chains`` and cannot cross a chain
    boundary, while mdtraj numbers residues GLOBALLY, so a disulfide joining the
    last residue of one chain to the first of the next differs by 1 in index and
    was reachable by NO scope: MEASURED on a two-chain fixture, an S-S at the real
    0.2042 nm was MISSED, while the identical geometry with one spacer residue
    between was FOUND. Scope 2 also name-gates to (C, N)/(O3', P), so it could
    never have caught an S-S anyway — which is what made a VICINAL disulfide
    (residues i and i+1 of one chain, e.g. the acetylcholine-receptor alpha
    Cys192-Cys193 motif) unreachable too. The chalcogen requirement plus the
    covalent window is what keeps this scope honest, not the index arithmetic.
    """
    is_h, excluded = table.is_hydrogen, table.excluded
    residue_of = table.residue_of
    eligible = ~excluded & ~table.is_solvent
    symbols = table.symbol

    seeds = np.array(
        [i for i in range(len(symbols)) if symbols[i] in CROSSLINK_ELEMENTS and eligible[i]],
        dtype=np.int64,
    )
    if seeds.size == 0:
        return
    heavy = np.flatnonzero(eligible & ~is_h)
    if heavy.size == 0:
        return

    if seeds.size * heavy.size <= CROSSLINK_BRUTE_MAX_PAIRS:
        # Array pass, chunked over seeds. No reach prefilter is needed: the exact
        # per-pair window in _window_survivors is what decides, and a prefilter
        # can only ever be a superset of it.
        step = max(1, CROSSLINK_CHUNK_PAIRS // heavy.size)
        for s in range(0, seeds.size, step):
            chunk = seeds[s : s + step]
            gi = np.repeat(chunk, heavy.size)
            gj = np.tile(heavy, chunk.size)
            gi, gj, d = _window_survivors(xyz, table, gi, gj)
            same = residue_of[gi] == residue_of[gj]
            for i, j, dist in zip(gi[~same].tolist(), gj[~same].tolist(), d[~same].tolist()):
                lo, hi = (i, j) if i < j else (j, i)
                yield (lo, hi, dist, SCOPE_CROSSLINK)
        return

    tree = _kdtree(xyz[heavy])
    # Bound: no crosslink candidate can be farther than the largest chalcogen
    # radius plus the largest radius in the table, scaled. Derived from the
    # vocabulary rather than hardcoded, so adding an element cannot leave the
    # search radius behind.
    reach = (max_crosslink_radius_nm() + max_covalent_radius_nm()) * COVALENT_BOND_SCALE
    for i in seeds.tolist():
        ri = int(residue_of[i])
        neighbours = tree.query_ball_point(xyz[i], reach)
        if not neighbours:
            continue
        gj = heavy[np.asarray(neighbours, dtype=np.int64)]
        gj = gj[residue_of[gj] != ri]
        if gj.size == 0:
            continue
        gi, gj, d = _window_survivors(xyz, table, np.full(gj.size, i, dtype=np.int64), gj)
        for a, j, dist in zip(gi.tolist(), gj.tolist(), d.tolist()):
            lo, hi = (a, j) if a < j else (j, a)
            yield (lo, hi, dist, SCOPE_CROSSLINK)


# -- dedupe, the hydrogen rule, and scope attribution --------------------------


def _resolve(candidates, existing: Set[Tuple[int, int]], table: _AtomTable):
    """Turn candidates into the final sorted pair list.

    Drops anything the topology already declares (ADDITIVE ONLY — an existing
    bond is never removed and never re-proposed), then enforces that a hydrogen
    ends with exactly ONE bond.

    That rule is stated over the union of DECLARED and proposed bonds, not over
    the proposals alone. Testing only the proposals was a real defect, not a
    theoretical one: a hydrogen the file already bonded had its declared pair
    removed by the ``key in existing`` line ABOVE the bookkeeping, so the rule
    never learned the hydrogen was taken and handed it a second partner. On the
    corpus membrane that shipped 24 divalent hydrogens, 24 pentavalent carbons and
    24 three-membered C-C-H rings in the default mode. Since inference cannot
    remove the declared bond, the only additive answer is to propose nothing for
    that hydrogen.

    Among the NEW candidates for a FREE hydrogen the nearest survives. Ties break
    on ``(distance, pair)``, which makes the outcome independent of the order the
    scopes happen to enumerate candidates in — the intra scope buckets residues by
    size rather than walking them in index order, so "first seen" was no longer a
    property anyone could reason about.
    """
    is_h = table.is_hydrogen
    chosen: Dict[Tuple[int, int], str] = {}
    best_for_hydrogen: Dict[int, Tuple[float, Tuple[int, int], str]] = {}
    hydrogen_candidates = 0

    # Hydrogens the topology already bonded. Built as an array pass because
    # `existing` is the whole declared bond list (50k pairs on the membrane).
    if existing:
        ends = np.fromiter(
            (i for pair in existing for i in pair), dtype=np.int64, count=2 * len(existing)
        )
        taken_hydrogens = set(ends[is_h[ends]].tolist())
    else:
        taken_hydrogens: Set[int] = set()

    for i, j, dist, scope in candidates:
        key = (i, j) if i < j else (j, i)
        if key in existing:
            continue
        h = i if is_h[i] else (j if is_h[j] else None)
        if h is None:
            chosen.setdefault(key, scope)
            continue
        hydrogen_candidates += 1
        if h in taken_hydrogens:
            continue  # already monovalent by the file's own account
        previous = best_for_hydrogen.get(h)
        if previous is None or (dist, key) < (previous[0], previous[1]):
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
    prevents instead of asserting it in prose. Run on the membrane it takes the
    DMPC leaflet from 482 acyclic components / 0 rings to 742 components with
    3,575 rings — fusing molecules that touch AND detaching hydrogens onto
    passing waters (see the table at the top of this module). It is never called
    by the producer; ``_edges()`` reaches only ``infer_bonds``.
    """
    xyz = np.asarray(xyz)
    table = _atom_table(topology, DEFAULT_MODE)
    existing = _existing_pairs(topology)
    excluded = table.excluded

    idx = np.flatnonzero(~excluded)
    reach = 2.0 * max_covalent_radius_nm() * COVALENT_BOND_SCALE
    local = _kdtree(xyz[idx]).query_pairs(reach, output_type="ndarray")
    if len(local) == 0:
        return []
    gi, gj = idx[local[:, 0]], idx[local[:, 1]]
    # Same window test as the real scopes, so the ONLY difference between this
    # and infer_bonds is the scoping — which is what the control has to isolate.
    gi, gj, d = _window_survivors(xyz, table, gi, gj)
    candidates = [
        (i, j, dist, SCOPE_INTRA)
        for i, j, dist in zip(gi.tolist(), gj.tolist(), d.tolist())
    ]
    pairs, _scope_of, _dropped = _resolve(candidates, existing, table)
    return pairs
