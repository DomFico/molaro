"""Risk sink for COVALENT-BOND INFERENCE — the bonds a topology does not declare.

``_edges()`` used to infer connectivity only for a topology that declared ZERO
bonds, and only from mdtraj's residue TEMPLATES. Two measured consequences: every
nucleic backbone arrived 100% unlinked (mdtraj bonds protein C-N but never nucleic
O3'-P), and any file with SOME bonds got no inference at all, so a CONECT-less
ligand or lipid arrived as loose dust (the membrane's 482 DMPC lipids, 56,876
atoms). ``producer/bond_inference.py`` adds a second, additive pass.

The pass is easy to get plausibly wrong, so this file is built around one idea:
EVERY claim is either checked against an authoritative external file, or checked
by a TOPOLOGY invariant that a plausible-but-wrong implementation violates. A bond
count is not evidence — the unscoped global search this replaced matched the
authoritative CHARMM PSF exactly (82/82) and still destroyed the membrane.

  A. PSF EQUALITY — on BACD_ion, the inferred set must EQUAL
     (BACD_ion.psf bonds − BACD_ion.pdb bonds): 82 pairs, 0 false positives, 0
     misses, judged against a CHARMM force field's own bond list. The 4
     LANTHIONINE bridges are additionally named by residue+atom, because they are
     the hardest case in the corpus (S-C, 3-4 residues apart, so only the
     crosslink scope can reach them).

  B. GRAPH INTEGRITY — the check that refuted the global search. Counting bonds
     cannot tell a molecule from a fused blob, so the assertions are components
     and RINGS: ADP is 1 component with 29 bonds and 3 rings (adenine bicyclic +
     ribose furanose), TPO is 1/10/0, and the membrane's DMPC is 482 acyclic
     components with 56,394 bonds and ZERO cross-residue bonds. A false bond shows
     up as a ring or a fusion even when the count looks fine.

  C. CORPUS DELTA — the exact per-system +N table, measured THROUGH THE REAL
     PRODUCER (MdtrajSource, so the wiring is under test, not just the module),
     including the two systems whose "+0" is a correctness claim rather than a
     coincidence of scale: 07 coarse-grain martini (no atomistic templates, and
     inference must not invent bead bonds) and 10 TIP4P (virtual sites must stay
     bare). Also: the inferred block is APPENDED, so the pre-inference edge slots
     — which are header order for the renderer's per-edge attributes — do not
     move.

  D. MONATOMIC IONS STAY BARE — ZN, MG, NA, CL, SOD, CLA, POT, all present
     somewhere in the evidence base, must touch no inferred bond. A metal's
     coordination shell sits inside any covalent window, so this is the exclusion
     doing the work.

  E. A GENUINE GAP STAYS UNBONDED — a real missing residue must NOT be bridged.
     Built as a controlled experiment on 10GJ chain 9 (see that block: the "gap"
     in the original diagnosis turned out to be a modified residue that is
     PRESENT, so the test deletes it to make the gap real).

  F. "off" IS THE PRE-CHANGE PRODUCER — the regression escape hatch. Asserted two
     ways: the edge list equals the pre-change rule recomputed independently
     (declared bonds, in declared order, through the PBC cutoff), and the counts
     equal the numbers MEASURED on main before this branch existed.

  G. NEGATIVE CONTROL — the point of the whole file. The UNSCOPED global search is
     run and asserted to WRECK the membrane (fused/shredded DMPC, thousands of
     rings). Without this, every assertion above would pass just as happily with
     the scoping deleted, and the test net would prove nothing.

  H. ONE DEFAULT — the setting's enum/default in package.json must match the
     producer's MODES/DEFAULT_MODE. Two copies of a default is this project's
     most-paid-for defect class, so it is asserted rather than remembered.

  I. THE RULES THE CORPUS DOES NOT EXERCISE — the one-partner-per-hydrogen rule
     never fires on any real system here, and virtual-site exclusion is invisible
     when it works. Both are proven on purpose-built fixtures, with the
     counterfactual measured, so neither is untested code.

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \\
    /path/to/mdbench-python -m tests.bond_inference
"""
from __future__ import annotations

import collections
import json
import os
import re
import subprocess
import sys
import time
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import mdtraj as md  # noqa: E402

from producer.bond_inference import (  # noqa: E402
    DEFAULT_MODE,
    DENSE_RESIDUE_MAX_ATOMS,
    MODES,
    _atom_table,
    _intra_residue_candidates,
    infer_bonds,
    infer_bonds_unscoped,
)
from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.domain_rules import (  # noqa: E402
    COVALENT_BOND_SCALE,
    MIN_COVALENT_BOND_NM,
    covalent_radius_nm,
)
from producer.mdtraj_source import PBC_BOND_CUTOFF_NM, MdtrajSource  # noqa: E402

CORPUS = [
    "01_alanine_dipeptide", "02_trpcage_atomistic", "03_adk_psf_dcd",
    "04_ligand_custom_solvent", "05_macrocycle_disulfide", "06_membrane_complex",
    "07_coarse_grain_martini", "09_nucleic_duplex", "10_tip4p_virtualsites",
]

# Per-system inferred-bond count through the REAL producer, MEASURED 2026-07-27.
# (08_macrocycle_thioether has an empty files/ directory and no loadable topology,
# so it is absent here — noted rather than silently skipped.)
CORPUS_DELTA = {
    "01_alanine_dipeptide": 0, "02_trpcage_atomistic": 0, "03_adk_psf_dcd": 0,
    "04_ligand_custom_solvent": 0, "05_macrocycle_disulfide": 0,
    "06_membrane_complex": 123452, "07_coarse_grain_martini": 0,
    "09_nucleic_duplex": 24, "10_tip4p_virtualsites": 0,
}
# The same, in "nonsolvent" mode: identical everywhere except the membrane, where
# 67,058 of the 123,452 inferred bonds are water O-H (attributed by residue name:
# HOH 67,058 + DMPC 56,394 = 123,452).
CORPUS_DELTA_NONSOLVENT = dict(CORPUS_DELTA, **{"06_membrane_complex": 56394})
# The per-scope split, for the two systems that add anything. Named separately
# because the scopes answer different questions and a regression that moved bonds
# from one scope to another would leave the total unchanged.
CORPUS_SCOPES = {
    "06_membrane_complex": {"intra": 123452, "linkage": 0, "crosslink": 0},
    "09_nucleic_duplex": {"intra": 2, "linkage": 22, "crosslink": 0},
}
# Edge counts on `main`, BEFORE this branch — measured with
# `python -m tests.acceptance_corpus` at ec76b31. "off" must reproduce these.
PRE_CHANGE_EDGES = {
    "01_alanine_dipeptide": 867, "02_trpcage_atomistic": 3308, "03_adk_psf_dcd": 3365,
    "04_ligand_custom_solvent": 1921, "05_macrocycle_disulfide": 72,
    "06_membrane_complex": 50488, "07_coarse_grain_martini": 0,
    "09_nucleic_duplex": 13178, "10_tip4p_virtualsites": 1002,
}
# Monatomic ion residue names that actually occur in the evidence base, with where.
# Listed so a name that stops occurring (a corpus change) cannot leave block D
# quietly vacuous.
ION_RESIDUES_PRESENT = {
    "NA": "02_trpcage_atomistic", "CL": "02_trpcage_atomistic",
    "SOD": "BACD_ion.pdb", "CLA": "06_membrane_complex",
    "POT": "06_membrane_complex", "ZN": "AlphaFold cif", "MG": "AlphaFold cif",
}
# The 4 lanthionine bridges in BACD, from the authoritative PSF:
# (residue name, resSeq, atom) x2. 3-4 residues apart, so scope 2 cannot reach them.
LANTHIONINE_BRIDGES = [
    (("ABU", 42, "CB"), ("CYS", 46, "SG")),
    (("DALA", 52, "CB"), ("CYS", 56, "SG")),
    (("ABU", 58, "CB"), ("CYS", 61, "SG")),
    (("ABU", 62, "CB"), ("CYS", 65, "SG")),
]


# -- helpers -------------------------------------------------------------------


def _bench(*parts: str) -> str:
    return os.path.join(corpus_root(), *parts)


def _declared(top) -> set:
    return {(min(a.index, b.index), max(a.index, b.index)) for a, b in top.bonds}


def _load_static(path: str):
    """Load a structure file the way the producer's static path sees it: the
    template gate first (only when the topology declares nothing), then the
    coordinates of frame 0."""
    traj = md.load(path)
    top = traj.topology
    if top.n_bonds == 0:
        try:
            top.create_standard_bonds()
        except Exception:
            pass
    return traj, top


def _graph(atom_indices, edges):
    """(components, edges_inside, rings) of the subgraph induced on
    ``atom_indices``. ``rings`` is the cycle rank E - V + C: 0 means every
    component is a tree, and any false bond that closes a loop makes it positive.
    """
    order = {a: k for k, a in enumerate(atom_indices)}
    parent = list(range(len(order)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    inside = 0
    for i, j in edges:
        if i in order and j in order:
            inside += 1
            a, b = find(order[i]), find(order[j])
            if a != b:
                parent[a] = b
    comps = len({find(k) for k in range(len(order))})
    return comps, inside, inside - len(order) + comps


def _residue_atom(top, name, res_seq, atom_name):
    for res in top.residues:
        if res.name.upper() == name.upper() and res.resSeq == res_seq:
            for atom in res.atoms:
                if atom.name == atom_name:
                    return atom.index
    return None


def _component_sizes(atom_indices, edges):
    """Sizes of the connected components induced on ``atom_indices``."""
    order = {a: k for k, a in enumerate(atom_indices)}
    parent = list(range(len(order)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, j in edges:
        if i in order and j in order:
            a, b = find(order[i]), find(order[j])
            if a != b:
                parent[a] = b
    sizes = collections.Counter(find(k) for k in range(len(order)))
    return sorted(sizes.values())


def _oversized_solvent_records(top) -> int:
    """Solvent residue RECORDS holding more than one physical molecule (>3 atoms).
    Not a defect of ours — PDB resSeq overflows at 9,999 and mdtraj merges what
    follows — but it is the reason "one record is one molecule" cannot be relied
    on, so it is counted rather than assumed away."""
    return sum(1 for r in top.residues
               if r.name.upper() in ("HOH", "WAT", "SOL", "TIP3") and r.n_atoms > 3)


# Maximum bonds an element can carry. Deliberately GENEROUS — hypervalent sulfur
# and phosphorus are real, and a formally charged nitrogen is four-coordinate — so
# a violation here is not a judgement call. Hydrogen is the load-bearing one: it
# is monovalent with no exceptions, and 24 divalent hydrogens shipped in the
# default mode while this file graded bond COUNTS instead of atom DEGREE.
MAX_DEGREE = {"H": 1, "C": 4, "N": 4, "O": 2, "F": 1, "CL": 1, "BR": 1, "I": 1}


def _degree_violations(top, edges):
    """Atoms whose degree exceeds MAX_DEGREE, as {"H>1": n, ...}.

    Counted over the WHOLE edge list — declared plus inferred — because that is
    what the renderer draws and what a chemist would look at. Files carry their
    own violations (membrane.pdb declares 7 four-coordinate nitrogens of its own),
    so the assertion that matters is the DIFFERENCE between modes: inference must
    introduce none.
    """
    degree = collections.Counter()
    for i, j in edges:
        degree[i] += 1
        degree[j] += 1
    out = collections.Counter()
    for atom in top.atoms:
        sym = (atom.element.symbol if atom.element is not None else "").upper()
        cap = MAX_DEGREE.get(sym)
        if cap is not None and degree[atom.index] > cap:
            out[f"{sym}>{cap}"] += 1
    return dict(out)


# -- A. PSF equality -----------------------------------------------------------


def check_psf_equality():
    """The only place in the corpus with an AUTHORITATIVE answer: BACD_ion.psf is a
    CHARMM force field's own bond list for the same coordinates as BACD_ion.pdb,
    and the PDB is missing 82 of them. Inference must find exactly those 82.

    (BACD_ion.psf is also why file_resolve's topology ranking matters — it ranks
    .pdb above .psf, so the viewer loads the INCOMPLETE file. That ranking is out
    of scope here; this block just uses the .psf as the grader.)
    """
    traj = md.load(_bench("BACD_ion.pdb"))
    top = traj.topology
    xyz = traj.xyz[0]
    pdb_pairs = _declared(top)
    psf_pairs = _declared(md.load_topology(_bench("BACD_ion.psf")))
    want = psf_pairs - pdb_pairs

    report = infer_bonds(top, xyz)
    got = set(report.pairs)
    false_pos = got - psf_pairs
    missed = want - got

    checks = [
        ("inferred set EQUALS psf - pdb", got == want,
         f"{len(got)} inferred vs {len(want)} PSF-only"),
        ("exactly 82 pairs", len(got) == 82 and len(want) == 82,
         f"inferred {len(got)}, PSF-only {len(want)}"),
        ("0 false positives (not in the PSF at all)", not false_pos,
         f"{len(false_pos)}" + (f" e.g. {sorted(false_pos)[:4]}" if false_pos else "")),
        ("0 misses", not missed,
         f"{len(missed)}" + (f" e.g. {sorted(missed)[:4]}" if missed else "")),
        ("no pair the PDB already declared is re-proposed", not (got & pdb_pairs),
         f"{len(got & pdb_pairs)} overlaps"),
        ("scope split", (report.intra, report.linkage, report.crosslink) == (71, 7, 4),
         f"intra {report.intra}, linkage {report.linkage}, crosslink {report.crosslink} "
         "(want 71/7/4)"),
    ]

    # The 4 lanthionine bridges, named. These are the reason scope 3 exists: S-C
    # across 3-4 residues, unreachable by templates and by the linkage scope.
    for (n1, s1, a1), (n2, s2, a2) in LANTHIONINE_BRIDGES:
        i = _residue_atom(top, n1, s1, a1)
        j = _residue_atom(top, n2, s2, a2)
        label = f"{n1}{s1}.{a1} - {n2}{s2}.{a2}"
        if i is None or j is None:
            checks.append((f"bridge {label} present", False, "atom not found in the topology"))
            continue
        key = (min(i, j), max(i, j))
        d = float(np.linalg.norm(xyz[i] - xyz[j]))
        checks.append((f"bridge {label} inferred", key in got,
                       f"{d:.4f} nm, delta {abs(s2 - s1)} residues, in PSF={key in psf_pairs}"))
    return all(ok for _, ok, _ in checks), checks


# -- B. graph integrity --------------------------------------------------------


def check_small_molecule_graph():
    """ADP and TPO out of an AlphaFold cif: both arrive bare (no CONECT equivalent
    for a HETATM), and both must come out as ONE molecule with the right ring
    count. The ring count is the discriminating assertion — a plausible bond count
    with one extra bond makes an extra ring."""
    traj, top = _load_static(
        _bench("fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")
    )
    report = infer_bonds(top, traj.xyz[0])
    edges = _declared(top) | set(report.pairs)
    checks = []
    for name, want in (("ADP", (1, 29, 3)), ("TPO", (1, 10, 0))):
        idx = [a.index for res in top.residues if res.name.upper() == name
               for a in res.atoms]
        got = _graph(idx, edges)
        checks.append((f"{name}: {want[0]} component / {want[1]} bonds / {want[2]} rings",
                       got == want, f"{len(idx)} atoms -> {got}"))
    checks.append(("total inferred on the AF cif == 40", report.added == 40,
                   f"{report.added} (intra {report.intra}, linkage {report.linkage}, "
                   f"crosslink {report.crosslink})"))
    return all(ok for _, ok, _ in checks), checks


def check_membrane_graph():
    """482 DMPC lipids. The assertion that refuted the global search: 482 acyclic
    components, 56,394 bonds, ZERO cross-residue bonds. A lipid is a tree — any
    ring at all means a false bond, and fewer than 482 components means two lipids
    were fused."""
    traj, top = _load_static(
        _bench("systems", "06_membrane_complex", "files", "membrane.pdb")
    )
    report = infer_bonds(top, traj.xyz[0])
    edges = _declared(top) | set(report.pairs)
    dmpc = [a.index for res in top.residues if res.name.upper() == "DMPC" for a in res.atoms]
    comps, inside, rings = _graph(dmpc, edges)
    residue_of = {a.index: a.residue.index for a in top.atoms}
    cross = sum(1 for i, j in report.pairs if residue_of[i] != residue_of[j])
    checks = [
        ("DMPC: 482 components", comps == 482, f"{comps} over {len(dmpc)} atoms"),
        ("DMPC: 56394 bonds", inside == 56394, f"{inside}"),
        ("DMPC: 0 rings (every lipid is a tree)", rings == 0, f"{rings}"),
        ("0 cross-residue inferred bonds anywhere in the membrane", cross == 0, f"{cross}"),
        ("total inferred == 123452", report.added == 123452, f"{report.added}"),
    ]

    # The merged-water record check. scope 1's justification is "a residue record
    # is one molecule", and on THIS file that is false: PDB resSeq overflow put ten
    # waters in one HOH record 3,725 times, so the intra scope really does run an
    # all-pairs search across ten distinct molecules for 54% of what it infers. The
    # record boundary cannot protect that; only the distance margin can. So the
    # protection is asserted where it can actually fail — on the SOLVENT
    # connected components, which must be exactly one 3-atom tree per water
    # whatever the records say. A widened window (a bigger SCALE, a bigger radius)
    # shows up here as a component larger than 3, and block B's DMPC assertions
    # cannot see it because a merged-record fusion is intra-record by construction.
    solvent = sorted(a.index for a in top.atoms
                     if a.residue.name.upper() in ("HOH", "WAT", "SOL", "TIP3"))
    scomps, sbonds, srings = _graph(solvent, edges)
    sizes = _component_sizes(solvent, edges)
    checks += [
        ("record boundaries are NOT the protection: 3,726 HOH records hold >3 atoms",
         _oversized_solvent_records(top) == 3726, f"{_oversized_solvent_records(top)}"),
        ("...yet every water is its own 3-atom tree: 47829 components, 95658 bonds, 0 rings",
         (scomps, sbonds, srings) == (47829, 95658, 0), f"{(scomps, sbonds, srings)}"),
        ("no solvent component is larger than one water molecule",
         set(sizes) == {3}, f"component-size histogram {dict(collections.Counter(sizes))}"),
    ]
    return all(ok for _, ok, _ in checks), checks


# -- C. corpus delta through the real producer ---------------------------------


def check_corpus_delta(sid: str):
    """Through MdtrajSource, so the WIRING is under test: the mode reaches
    _edges(), the inferred pairs survive the PBC filter, the report is recorded,
    and the inferred block is appended rather than interleaved."""
    spec = resolve_system(sid)
    built = {}
    for mode in ("off", "full", "nonsolvent"):
        built[mode] = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                                   spec["ligand_residues"], infer_bonds=mode)
    try:
        off, full, nons = built["off"], built["full"], built["nonsolvent"]
        report = full.bond_inference
        # Read through the MOD-FACING accessor (DataSource.edges -> EdgeView), so
        # this block also proves that surface reports the DRAWN set.
        off_edges = [tuple(e) for e in off.edges]
        full_edges = [tuple(e) for e in full.edges]
        nons_edges = [tuple(e) for e in nons.edges]
        delta = len(full_edges) - len(off_edges)
        delta_ns = len(nons_edges) - len(off_edges)
        checks = [
            (f"full: +{CORPUS_DELTA[sid]} edges", delta == CORPUS_DELTA[sid],
             f"{len(off_edges)} -> {len(full_edges)} (+{delta})"),
            (f"nonsolvent: +{CORPUS_DELTA_NONSOLVENT[sid]} edges",
             delta_ns == CORPUS_DELTA_NONSOLVENT[sid],
             f"{len(off_edges)} -> {len(nons_edges)} (+{delta_ns})"),
            ("every inferred pair survives the PBC cutoff here",
             full.inferred_edges_kept == report.added,
             f"{full.inferred_edges_kept} of {report.added} kept"),
            ("the report's count IS the edge delta", report.added == delta,
             f"report {report.added} vs edges +{delta}"),
            ("inferred pairs are APPENDED — pre-inference slots do not move",
             full_edges[: len(off_edges)] == off_edges,
             f"first {len(off_edges)} edges identical"),
            ("the inferred tail is sorted and holds i < j",
             all(i < j for i, j in full_edges[len(off_edges):])
             and full_edges[len(off_edges):] == sorted(full_edges[len(off_edges):]),
             f"{delta} appended"),
        ]
        if sid in CORPUS_SCOPES:
            want = CORPUS_SCOPES[sid]
            got = {"intra": report.intra, "linkage": report.linkage,
                   "crosslink": report.crosslink}
            checks.append((f"scope split {want}", got == want, f"{got}"))

        # VALENCE, on every system, in the mode that ships. This is the assertion
        # this file lacked: it graded bond SETS and COUNTS, so 24 chemically
        # impossible bonds (divalent hydrogens, pentavalent carbons, three-membered
        # C-C-H rings) passed every check while being PINNED by the membrane's
        # count. Stated as a DIFFERENCE against "off" because a file can declare
        # its own violations and inference must not be blamed for them —
        # membrane.pdb declares 7 four-coordinate nitrogens in both modes.
        viol_off = _degree_violations(off._topology, off_edges)
        viol_full = _degree_violations(full._topology, full_edges)
        viol_ns = _degree_violations(nons._topology, nons_edges)
        checks += [
            ("inference introduces NO impossible valence (full vs off)",
             viol_full == viol_off, f"off {viol_off} -> full {viol_full}"),
            ("...nor in nonsolvent mode",
             viol_ns == viol_off, f"off {viol_off} -> nonsolvent {viol_ns}"),
            ("no inferred bond is zero-length (a duplicated atom record)",
             _min_pair_length(full) >= 0.05 if report.added else True,
             f"shortest inferred pair {_min_pair_length(full):.4f} nm"
             if report.added else "nothing inferred"),
        ]
        # provenance discipline: a line only when something was added
        prov = [line for line in full.give_header().provenance
                if line.startswith("bond inference")]
        if CORPUS_DELTA[sid]:
            checks.append(("provenance names the counts", len(prov) == 1 and
                           str(report.intra) in prov[0] and str(report.added) in prov[0],
                           prov[0][:96] if prov else "MISSING"))
        else:
            checks.append(("provenance stays SILENT when nothing was added (byte-identity)",
                           not prov, prov[0][:96] if prov else "silent"))
        return all(ok for _, ok, _ in checks), checks
    finally:
        for src in built.values():
            src.close()


def _min_pair_length(src) -> float:
    """Shortest INFERRED pair on a built source, in nm, at the frame inference
    used. inf when nothing was inferred."""
    report = src.bond_inference
    if report is None or not report.pairs:
        return float("inf")
    xyz = src._representative_xyz()
    pairs = np.asarray(report.pairs, dtype=np.int64)
    return float(np.linalg.norm(xyz[pairs[:, 0]] - xyz[pairs[:, 1]], axis=1).min())


def check_graceful_empty_cases():
    """The two "+0" claims that are correctness, not scale — stated with the
    MEASURED margin, because one of them is thin.

    07 coarse-grain martini: mdtraj name-guesses the bead elements (BB -> boron,
    SC1 -> scandium), which are fiction, so inference has no business bonding them.
    It does not — but only by 0.00011 nm on one TRP bead pair. That is recorded
    here rather than presented as a guarantee: the CG "+0" is a measurement, not a
    property, and this check is what will notice when a radius change breaks it.

    10 TIP4P: the M virtual site sits 0.011-0.014 nm from its oxygen, deep inside
    any covalent window, so it is the EXCLUSION and nothing else that keeps it bare.
    The counterfactual is measured, so the exclusion cannot be silently deleted.
    """
    checks = []

    spec = resolve_system("07_coarse_grain_martini")
    traj = md.load(spec["trajectory"], top=spec["topology"])
    top, xyz = traj.topology, traj.xyz[0]
    report = infer_bonds(top, xyz)
    margins = []
    for res in top.residues:
        idx = [a.index for a in res.atoms]
        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                i, j = idx[a], idx[b]
                si = top.atom(i).element.symbol if top.atom(i).element else None
                sj = top.atom(j).element.symbol if top.atom(j).element else None
                d = float(np.linalg.norm(xyz[i] - xyz[j]))
                window = (covalent_radius_nm(si) + covalent_radius_nm(sj)) * COVALENT_BOND_SCALE
                margins.append((d - window, d, window, res.name, top.atom(i).name,
                                top.atom(j).name))
    margins.sort()
    tightest = margins[0]
    checks.append(("07 martini: 0 bonds inferred on CG beads", report.added == 0,
                   f"{report.added}"))
    checks.append(("07 martini: no bead pair is inside its window",
                   tightest[0] > 0,
                   f"tightest margin {tightest[0]:+.5f} nm "
                   f"({tightest[3]} {tightest[4]}-{tightest[5]}: d={tightest[1]:.4f} "
                   f"vs window {tightest[2]:.4f}) — THIN, see the docstring"))

    spec = resolve_system("10_tip4p_virtualsites")
    traj = md.load(spec["trajectory"], top=spec["topology"])
    top, xyz = traj.topology, traj.xyz[0]
    report = infer_bonds(top, xyz)
    vs_idx = {a.index for a in top.atoms
              if a.element is not None and a.element.symbol.upper() == "VS"}
    touching = sum(1 for i, j in report.pairs if i in vs_idx or j in vs_idx)
    mo = []
    for res in top.residues:
        by_name = {a.name: a.index for a in res.atoms}
        if "M" in by_name and "O" in by_name:
            mo.append(float(np.linalg.norm(xyz[by_name["M"]] - xyz[by_name["O"]])))
    window = (covalent_radius_nm("VS") + covalent_radius_nm("O")) * COVALENT_BOND_SCALE
    checks.append(("10 TIP4P: 0 bonds inferred", report.added == 0, f"{report.added}"))
    checks.append(("10 TIP4P: no inferred bond touches a virtual site", touching == 0,
                   f"{len(vs_idx)} VS atoms, {touching} bonds touch one"))
    checks.append(("10 TIP4P: COUNTERFACTUAL — every M-O pair WOULD be inside the window",
                   len(mo) == len(vs_idx) and max(mo) < window,
                   f"{len(mo)} M-O pairs, {min(mo):.4f}-{max(mo):.4f} nm vs window "
                   f"{window:.4f} nm -> {len(mo)} false bonds without the exclusion"))
    return all(ok for _, ok, _ in checks), checks


# -- D. monatomic ions stay bare -----------------------------------------------


def check_ions_bare():
    """A monatomic residue has no covalent bonds, and its coordination shell is
    inside any covalent window — so if the exclusion were missing every ion would
    sprout several bonds. Checked over the whole evidence base, and the specific
    names in ION_RESIDUES_PRESENT are asserted to still OCCUR, so this cannot go
    quietly vacuous."""
    sources = [
        ("02_trpcage_atomistic", resolve_system("02_trpcage_atomistic")["topology"]),
        ("09_nucleic_duplex", resolve_system("09_nucleic_duplex")["topology"]),
        ("06_membrane_complex", resolve_system("06_membrane_complex")["topology"]),
        ("BACD_ion.pdb", _bench("BACD_ion.pdb")),
        ("AlphaFold cif", _bench("fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")),
    ]
    checks = []
    seen_names = set()
    for label, path in sources:
        traj, top = _load_static(path)
        report = infer_bonds(top, traj.xyz[0])
        mono = {a.index for res in top.residues if res.n_atoms == 1 for a in res.atoms}
        names = {res.name.upper() for res in top.residues if res.n_atoms == 1}
        seen_names |= names
        touching = [(i, j) for i, j in report.pairs if i in mono or j in mono]
        checks.append((f"{label}: no inferred bond touches a monatomic residue",
                       not touching,
                       f"{len(mono)} monatomic atoms ({', '.join(sorted(names)) or 'none'}), "
                       f"{len(touching)} bonds touch one"))
    for name, where in sorted(ION_RESIDUES_PRESENT.items()):
        checks.append((f"ion {name} still occurs (in {where}) — the check is not vacuous",
                       name in seen_names, f"seen names {sorted(seen_names)}"))
    return all(ok for _, ok, _ in checks), checks


def check_monatomic_exclusion_is_load_bearing():
    """The corpus assertions above pass EVEN WITH THE MONATOMIC EXCLUSION DELETED.

    That is not an opinion — a mutation run removed ``res.n_atoms == 1`` from the
    exclusion and block D stayed green. The reason is that no corpus ion can reach
    a scope by any other route: scope 1 skips a residue with fewer than 2 atoms
    anyway, scope 2 needs a backbone atom NAME, and scope 3 needs a chalcogen. Every
    corpus ion (NA, CL, CLA, POT, SOD, ZN, MG) fails all three.

    So the exclusion IS reachable, just not by anything in the corpus, and this
    block builds the two cases that reach it. Each is a PAIR of fixtures with
    identical geometry and elements, differing ONLY in whether the ion's residue
    holds one atom or two — so the outcome difference isolates the exclusion.

      1. CROSSLINK path — a lone sulfide ion 0.20 nm from a cysteine SG. Both are
         chalcogens, 2 residues apart, well inside the 0.252 nm S-S window.
      2. LINKAGE path — a lone phosphate ion whose atom is named P, sitting in the
         same chain immediately after a residue with an O3'. That is exactly the
         named pair scope 2 looks for, at 0.15 nm.

    Without the exclusion both fixtures gain a bond that does not exist.
    """
    def crosslink_fixture(ion_is_monatomic: bool):
        top = md.Topology()
        chain = top.add_chain()
        cys = top.add_residue("CYS", chain)
        cb = top.add_atom("CB", md.element.carbon, cys)
        sg = top.add_atom("SG", md.element.sulfur, cys)
        filler = top.add_residue("GLY", chain)     # spacer: makes the ion NON-adjacent
        top.add_atom("CA", md.element.carbon, filler)
        top.add_atom("C", md.element.carbon, filler)
        ion = top.add_residue("S", chain)
        sd = top.add_atom("SD", md.element.sulfur, ion)
        coords = [[0.0, 0, 0], [0.18, 0, 0], [5.0, 0, 0], [5.5, 0, 0], [0.38, 0, 0]]
        if not ion_is_monatomic:
            top.add_atom("XX", md.element.carbon, ion)
            coords.append([0.38, 2.0, 0])           # far enough to add no other bond
        return top, np.asarray(coords, dtype=np.float32), (sg.index, sd.index), (cb.index, sg.index)

    def linkage_fixture(ion_is_monatomic: bool):
        top = md.Topology()
        chain = top.add_chain()
        nuc = top.add_residue("DA", chain)
        # C3' as well as O3': a ONE-atom nucleotide would itself be monatomic, and
        # the fixture must isolate the ION's exclusion, not trip over its own.
        c3 = top.add_atom("C3'", md.element.carbon, nuc)
        o3 = top.add_atom("O3'", md.element.oxygen, nuc)
        ion = top.add_residue("PO4", chain)
        p = top.add_atom("P", md.element.phosphorus, ion)
        coords = [[-0.14, 0, 0], [0.0, 0, 0], [0.15, 0, 0]]
        if not ion_is_monatomic:
            top.add_atom("XX", md.element.carbon, ion)
            coords.append([0.15, 2.0, 0])
        return (top, np.asarray(coords, dtype=np.float32), (o3.index, p.index),
                (c3.index, o3.index))

    checks = []
    for label, build, window in (
        ("crosslink", crosslink_fixture,
         2 * covalent_radius_nm("S") * COVALENT_BOND_SCALE),
        ("linkage", linkage_fixture,
         (covalent_radius_nm("O") + covalent_radius_nm("P")) * COVALENT_BOND_SCALE),
    ):
        top1, xyz1, key1, extra = build(True)
        top2, xyz2, key2, _ = build(False)
        got1 = set(infer_bonds(top1, xyz1).pairs)
        got2 = set(infer_bonds(top2, xyz2).pairs)
        d = float(np.linalg.norm(xyz1[key1[0]] - xyz1[key1[1]]))
        checks.append((f"{label}: a MONATOMIC ion is not bonded", key1 not in got1,
                       f"{d:.4f} nm vs window {window:.4f} nm; pairs {sorted(got1)}"))
        checks.append((f"{label}: COUNTERFACTUAL — the same atom in a 2-atom residue IS bonded",
                       key2 in got2,
                       f"pairs {sorted(got2)} — so the exclusion is what blocked it"))
        if extra is not None:
            checks.append((f"{label}: the fixture's own real bond is still found",
                           extra in got1, f"{extra} present={extra in got1}"))
    return all(ok for _, ok, _ in checks), checks


def check_pbc_filter_reaches_inferred_pairs():
    """An inferred pair must go through the SAME cross-box cutoff a declared one
    does. The corpus cannot show this: every inferred bond there is well under
    PBC_BOND_CUTOFF_NM (0.3 nm), so bypassing the filter for inferred pairs changes
    nothing — a mutation that did exactly that was NOT caught by any other block.

    It is reachable, though, because the covalent window is wider than the cutoff
    at the top of the table: two iodines bond up to
    (0.139 + 0.139) x 1.2 = 0.3336 nm. So the fixture is a single 2-atom residue of
    two iodines 0.31 nm apart, written to a real PDB and opened through the REAL
    producer: inference must PROPOSE the bond and the cutoff must then DROP it, so
    the edge list is empty and ``inferred_edges_kept`` says 0 of 1.
    """
    import tempfile

    top = md.Topology()
    res = top.add_residue("DII", top.add_chain())
    top.add_atom("I1", md.element.iodine, res)
    top.add_atom("I2", md.element.iodine, res)
    separation = 0.31
    xyz = np.array([[[0.0, 0, 0], [separation, 0, 0]]], dtype=np.float32)
    window = 2 * covalent_radius_nm("I") * COVALENT_BOND_SCALE

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "diiodine.pdb")
        md.Trajectory(xyz, top).save_pdb(path)
        src = MdtrajSource(path, None, "diiodine")
        try:
            report = src.bond_inference
            checks = [
                ("the fixture is inside the covalent window but past the PBC cutoff",
                 window > separation > PBC_BOND_CUTOFF_NM,
                 f"{separation} nm; window {window:.4f} nm; cutoff {PBC_BOND_CUTOFF_NM} nm"),
                ("inference PROPOSES the bond", report.added == 1, f"{report.added}"),
                ("the PBC cutoff DROPS it — inferred pairs are filtered like declared ones",
                 src.inferred_edges_kept == 0 and len(src.edges) == 0,
                 f"kept {src.inferred_edges_kept} of {report.added}, edges {list(src.edges)}"),
                ("provenance says a bond was suppressed",
                 any("suppressed as cross-box" in line for line in src.give_header().provenance),
                 "; ".join(src.give_header().provenance)[:140]),
            ]
        finally:
            src.close()
    return all(ok for _, ok, _ in checks), checks


# -- E. a genuine gap stays unbonded -------------------------------------------


def check_genuine_gap():
    """A REAL missing residue must not be bridged.

    The case comes from 10GJ chain 9, and the story is worth stating because the
    original diagnosis had it wrong. That diagnosis reported "1 residual break,
    chain 9 DA12 -> DA14, O3'-P = 0.775 nm, a GENUINELY MISSING RESIDUE". It is not
    missing: residue 13 of chain 9 is 8OG (8-oxoguanine, 23 atoms), a modified
    base that mdtraj reports as ``is_nucleic == False``, which is why a
    nucleic-only scan skipped it and measured DA12 -> DA14 across it. The cif
    itself already declares both links through 8OG13 (0.1607 and 0.1610 nm), so
    after inference 10GJ's nucleic backbone is 292/292 linked with no residual
    break anywhere.

    So the block asserts BOTH halves — the true one, and a genuine gap MADE genuine:

      1. as shipped: the two real links through 8OG13 are in the edge list, and the
         0.775 nm DA12 -> DA14 shortcut across it is NOT. That is adjacency scoping
         doing its job (non-adjacent residues are not linkage candidates).
      2. with 8OG13 DELETED — a controlled missing residue — DA12 and DA14 become
         sequence-ADJACENT with a named O3'/P pair, so they ARE a linkage candidate
         and only the DISTANCE test stands between them and a false 0.775 nm bond
         drawn straight through the hole. It must stay unbonded.
    """
    traj, top = _load_static(_bench("10GJ.cif"))
    xyz = traj.xyz[0]
    report = infer_bonds(top, xyz)
    edges = _declared(top) | set(report.pairs)

    chain9 = [c for c in top.chains if c.index == 9][0]
    by_seq = {res.resSeq: res for res in chain9.residues if res.resSeq in (12, 13, 14)}
    names = {seq: res.name for seq, res in by_seq.items()}
    atom = {seq: {a.name: a.index for a in res.atoms} for seq, res in by_seq.items()}
    shortcut = (min(atom[12]["O3'"], atom[14]["P"]), max(atom[12]["O3'"], atom[14]["P"]))
    d_shortcut = float(np.linalg.norm(xyz[atom[12]["O3'"]] - xyz[atom[14]["P"]]))
    real_links = [
        (min(atom[12]["O3'"], atom[13]["P"]), max(atom[12]["O3'"], atom[13]["P"])),
        (min(atom[13]["O3'"], atom[14]["P"]), max(atom[13]["O3'"], atom[14]["P"])),
    ]

    # every consecutive-residue pair in the file, after inference
    unlinked = 0
    for chain in top.chains:
        residues = list(chain.residues)
        for r1, r2 in zip(residues, residues[1:]):
            m1 = {a.name: a.index for a in r1.atoms}
            m2 = {a.name: a.index for a in r2.atoms}
            for tail, head in (("C", "N"), ("O3'", "P")):
                if tail in m1 and head in m2:
                    key = (min(m1[tail], m2[head]), max(m1[tail], m2[head]))
                    if key not in edges:
                        unlinked += 1

    checks = [
        ("chain 9 residue 13 is 8OG and is PRESENT (not a missing residue)",
         names.get(13, "").upper() == "8OG",
         f"resSeq 12/13/14 = {names}"),
        (f"the 0.775 nm DA12.O3' -> DA14.P shortcut is NOT an edge",
         shortcut not in edges, f"{d_shortcut:.4f} nm, in edges={shortcut in edges}"),
        ("the two REAL links through 8OG13 are edges",
         all(k in edges for k in real_links),
         ", ".join(f"{float(np.linalg.norm(xyz[i] - xyz[j])):.4f} nm" for i, j in real_links)),
        ("10GJ: 290 backbone links inferred, all linkage scope",
         (report.added, report.linkage) == (290, 290),
         f"added {report.added}, linkage {report.linkage}"),
        ("10GJ: no consecutive-residue named link left unlinked",
         unlinked == 0, f"{unlinked} unlinked"),
    ]

    # 2. the controlled experiment: delete 8OG13 and make the gap real.
    keep = [a.index for a in top.atoms if a.residue is not by_seq[13]]
    cut = traj.atom_slice(keep)
    cut_top = cut.topology
    cut_chain9 = [c for c in cut_top.chains if c.index == 9][0]
    cut_by_seq = {res.resSeq: res for res in cut_chain9.residues if res.resSeq in (12, 14)}
    residues = list(cut_chain9.residues)
    adjacent = any(r1 is cut_by_seq.get(12) and r2 is cut_by_seq.get(14)
                   for r1, r2 in zip(residues, residues[1:]))
    cut_atom = {seq: {a.name: a.index for a in res.atoms}
                for seq, res in cut_by_seq.items()}
    cut_report = infer_bonds(cut_top, cut.xyz[0])
    cut_edges = _declared(cut_top) | set(cut_report.pairs)
    cut_key = (min(cut_atom[12]["O3'"], cut_atom[14]["P"]),
               max(cut_atom[12]["O3'"], cut_atom[14]["P"]))
    cut_d = float(np.linalg.norm(cut.xyz[0][cut_atom[12]["O3'"]] - cut.xyz[0][cut_atom[14]["P"]]))
    window = (covalent_radius_nm("O") + covalent_radius_nm("P")) * COVALENT_BOND_SCALE
    # NOTHING at all may bridge the hole — not just the named O3'/P pair.
    side12 = {a.index for a in cut_by_seq[12].atoms}
    side14 = {a.index for a in cut_by_seq[14].atoms}
    bridges = [(i, j) for i, j in cut_edges
               if (i in side12 and j in side14) or (i in side14 and j in side12)]
    checks += [
        ("with 8OG13 deleted, DA12 and DA14 ARE sequence-adjacent (a real gap)",
         adjacent, f"adjacent={adjacent}"),
        ("the real 0.775 nm gap is still NOT bridged — only distance stops it",
         cut_key not in cut_edges,
         f"{cut_d:.4f} nm vs O-P window {window:.4f} nm, in edges={cut_key in cut_edges}"),
        ("NO edge whatsoever joins DA12 to DA14 across the hole", not bridges,
         f"{len(bridges)} bridging edges"),
        # The two links through 8OG13 were DECLARED by the cif, not inferred, so
        # deleting the residue costs 2 DECLARED bonds and 0 inferred ones. The
        # inferred count is therefore UNCHANGED — asserted, because the obvious
        # guess (that it drops by 2) is wrong and would hide a real regression.
        ("inference is unchanged by the deletion (the lost links were declared)",
         cut_report.added == report.added == 290,
         f"{cut_report.added} vs {report.added}"),
    ]
    return all(ok for _, ok, _ in checks), checks


# -- F. "off" is the pre-change producer ---------------------------------------


def check_off_is_pre_change(sid: str):
    """The regression escape hatch, proved rather than asserted.

    The reference is the PRE-CHANGE rule reimplemented here from first principles:
    take the topology's declared bonds IN DECLARED ORDER and drop any whose length
    exceeds PBC_BOND_CUTOFF_NM in any sampled frame. The only shared input is
    ``_edge_sample`` (the sampled frames), which this branch does not touch — so
    what is under test is exactly the code that changed.

    Order matters as much as membership: ``edges`` is a LIST and its index is the
    renderer's per-edge attribute slot, so "byte-identical" means the same pairs in
    the same order.
    """
    spec = resolve_system(sid)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], infer_bonds="off")
    try:
        top = src._topology
        declared = [(a.index, b.index) for a, b in top.bonds]
        if declared:
            arr = np.asarray(declared, dtype=np.int64)
            sample = src._edge_sample
            deltas = sample[:, arr[:, 0], :] - sample[:, arr[:, 1], :]
            longest = np.sqrt((deltas ** 2).sum(axis=2)).max(axis=0)
            reference = [(int(i), int(j)) for (i, j), k in
                         zip(declared, longest <= PBC_BOND_CUTOFF_NM) if k]
        else:
            reference = []
        checks = [
            ("off == the pre-change rule, same pairs in the same order",
             [tuple(e) for e in src.edges] == reference,
             f"{len(src.edges)} vs {len(reference)}"),
            (f"off edge count == the count measured on main ({PRE_CHANGE_EDGES[sid]})",
             len(src.edges) == PRE_CHANGE_EDGES[sid], f"{len(src.edges)}"),
            ("off infers nothing at all", src.bond_inference.added == 0
             and src.bond_inference.mode == "off", f"{src.bond_inference}"),
            ("off says so in provenance", any(line.startswith("bond inference: OFF")
                                              for line in src.give_header().provenance),
             "; ".join(src.give_header().provenance)[:110]),
        ]
        return all(ok for _, ok, _ in checks), checks
    finally:
        src.close()


# -- G. the negative control ---------------------------------------------------


def check_negative_control():
    """THE POINT OF THIS FILE. Every block above would pass just as happily with
    the scoping removed, so the scoping is measured directly: run the UNSCOPED
    global search on the membrane and assert it WRECKS the DMPC leaflet.

    MEASURED (2026-07-27), DMPC subgraph, 482 lipids / 56,876 atoms:
        scoped                  482 components, 56,394 bonds,     0 rings
        unscoped global search  670 components, 59,703 bonds, 3,497 rings

    Two different failures at once, and neither is fixable by moving a threshold:
      * FUSION — 3,497 rings, from bonds between atoms of different molecules that
        happen to touch. membrane.pdb genuinely holds 1,788 atom pairs closer than
        0.05 nm, so no distance cut separates "one molecule" from "two molecules
        in contact".
      * SHREDDING — 670 > 482 components, because a lipid hydrogen's nearest
        neighbour turns out to be in a passing water, so the one-partner rule hands
        the H to the water and it detaches from its own carbon.

    (The original diagnosis recorded ~70 components here rather than 670. 670 is
    what this repository's unscoped path measures. The difference is almost
    certainly whether the hydrogen rule was applied globally — a variant with the
    rule off collapses DMPC to 3 components with 8,979 rings, which is worse still.
    All are catastrophic; the assertion below is on the property, with the measured
    numbers pinned. The control shares _window_survivors with the real scopes, so
    the ONLY difference between the two rows is the scoping — which is what a
    control has to isolate. When the hydrogen rule learned to consult declared
    bonds and the minimum bond length arrived, this row moved 742/59,709/3,575 ->
    670/59,703/3,497 for exactly that reason, and it is re-measured here rather
    than left stale.)
    """
    traj, top = _load_static(
        _bench("systems", "06_membrane_complex", "files", "membrane.pdb")
    )
    xyz = traj.xyz[0]
    declared = _declared(top)
    dmpc = [a.index for res in top.residues if res.name.upper() == "DMPC" for a in res.atoms]

    scoped = infer_bonds(top, xyz)
    scoped_graph = _graph(dmpc, declared | set(scoped.pairs))
    unscoped = infer_bonds_unscoped(top, xyz)
    unscoped_graph = _graph(dmpc, declared | set(unscoped))

    residue_of = {a.index: a.residue.index for a in top.atoms}
    unscoped_cross = sum(1 for i, j in unscoped if residue_of[i] != residue_of[j])
    close = len(_close_pairs(xyz, 0.05))

    comps_u, bonds_u, rings_u = unscoped_graph
    checks = [
        ("scoped DMPC is intact (the control's control)",
         scoped_graph == (482, 56394, 0), f"{scoped_graph}"),
        ("UNSCOPED DMPC is NOT 482 acyclic components — the scoping is load-bearing",
         unscoped_graph != (482, 56394, 0), f"{unscoped_graph}"),
        ("UNSCOPED introduces rings (molecules fused)", rings_u > 1000, f"{rings_u} rings"),
        ("UNSCOPED also shreds lipids (components != 482)", comps_u != 482, f"{comps_u}"),
        ("UNSCOPED makes cross-residue bonds; scoped makes none",
         unscoped_cross > 10000 and not any(residue_of[i] != residue_of[j]
                                            for i, j in scoped.pairs),
         f"unscoped {unscoped_cross} cross-residue, scoped 0"),
        ("pinned measurement: unscoped == 670 comps / 59703 bonds / 3497 rings",
         unscoped_graph == (670, 59703, 3497), f"{unscoped_graph}"),
        ("WHY no threshold works: membrane.pdb holds 1788 atom pairs under 0.05 nm",
         close == 1788, f"{close} pairs closer than 0.05 nm"),
    ]
    return all(ok for _, ok, _ in checks), checks


def _close_pairs(xyz, radius):
    from scipy.spatial import cKDTree

    return cKDTree(xyz).query_pairs(radius, output_type="ndarray")


# -- H. one default, not two ---------------------------------------------------


def check_one_default():
    """``molaro.viewer.inferBonds`` spells the mode list and the default out in
    package.json (a settings UI needs a real enum), so that list exists TWICE.
    Two copies of one truth is the defect class this project has paid for most, so
    the copies are compared here rather than trusted."""
    manifest = json.load(open(os.path.join(os.path.dirname(__file__), "..", "package.json")))
    prop = manifest["contributes"]["configuration"]["properties"]["molaro.viewer.inferBonds"]
    checks = [
        ("package.json enum == producer MODES", tuple(prop["enum"]) == tuple(MODES),
         f"{prop['enum']} vs {list(MODES)}"),
        ("package.json default == producer DEFAULT_MODE", prop["default"] == DEFAULT_MODE,
         f"{prop['default']!r} vs {DEFAULT_MODE!r}"),
        ("one enumDescription per mode", len(prop.get("enumDescriptions", [])) == len(MODES),
         f"{len(prop.get('enumDescriptions', []))}"),
    ]
    # THIRD copy: the host validates the setting before forwarding it, because a
    # typo'd value used to reach argparse and stop the producer starting at all —
    # so a one-character mistake in settings.json bricked opening ANY dataset. The
    # host cannot import Python, so it holds its own list; that list is read here.
    ext = open(os.path.join(os.path.dirname(__file__), "..", "src", "extension.ts")).read()
    m = re.search(r"const INFER_BONDS_MODES = \[(.*?)\];", ext, re.S)
    host_modes = tuple(re.findall(r'"([^"]+)"', m.group(1))) if m else ()
    checks.append(("src/extension.ts INFER_BONDS_MODES == producer MODES",
                   host_modes == tuple(MODES), f"{list(host_modes)} vs {list(MODES)}"))
    return all(ok for _, ok, _ in checks), checks


# -- I. the rules the corpus does not exercise ---------------------------------


def check_hydrogen_rule():
    """The one-partner-per-hydrogen rule fires on NO real system measured here
    (inside one residue record a hydrogen has exactly one heavy neighbour), so it
    would otherwise be untested code shipped on an argument. Proved on a fixture
    built for it: one residue, H within covalent range of BOTH a carbon and an
    oxygen, C nearer.

    The counterfactual is asserted too — the candidate generator really does
    produce both pairs — so this cannot pass by the fixture being wrong."""
    top = md.Topology()
    chain = top.add_chain()
    res = top.add_residue("LIG", chain)
    c = top.add_atom("C", md.element.carbon, res)
    h = top.add_atom("H", md.element.hydrogen, res)
    o = top.add_atom("O", md.element.oxygen, res)
    xyz = np.array([[0.0, 0, 0], [0.105, 0, 0], [0.217, 0, 0]], dtype=np.float32)

    table = _atom_table(top, DEFAULT_MODE)
    candidates = list(_intra_residue_candidates(xyz, table))
    report = infer_bonds(top, xyz)
    pairs = set(report.pairs)
    ci, hi, oi = c.index, h.index, o.index
    checks = [
        ("COUNTERFACTUAL: the H is in range of BOTH C and O", len(candidates) == 2,
         f"{[(i, j, round(d, 4)) for i, j, d, _ in candidates]}"),
        ("only the NEAREST partner survives", pairs == {(ci, hi)},
         f"{sorted(pairs)} (want [(C,H)] = [{(ci, hi)}])"),
        ("the far candidate is counted as dropped, not silently lost",
         report.hydrogen_candidates_dropped == 1,
         f"{report.hydrogen_candidates_dropped}"),
        ("C-O itself is out of range, so nothing else joins them",
         (ci, oi) not in pairs,
         f"C-O {float(np.linalg.norm(xyz[ci] - xyz[oi])):.4f} nm vs window "
         f"{(covalent_radius_nm('C') + covalent_radius_nm('O')) * COVALENT_BOND_SCALE:.4f}"),
    ]

    # H-H is never bonded, however close two hydrogens sit.
    top2 = md.Topology()
    res2 = top2.add_residue("LIG", top2.add_chain())
    h1 = top2.add_atom("H1", md.element.hydrogen, res2)
    h2 = top2.add_atom("H2", md.element.hydrogen, res2)
    xyz2 = np.array([[0.0, 0, 0], [0.05, 0, 0]], dtype=np.float32)
    got2 = infer_bonds(top2, xyz2)
    checks.append(("H-H is never bonded even at 0.05 nm", got2.added == 0,
                   f"{got2.added} bonds; window would be "
                   f"{2 * covalent_radius_nm('H') * COVALENT_BOND_SCALE:.4f} nm"))

    # AN ALREADY-BONDED HYDROGEN. The rule above ranks NEW candidates against each
    # other; it used to never consult the topology's DECLARED bonds, so a hydrogen
    # the file had already bonded gained a SECOND one. That is not hypothetical —
    # it shipped 24 times on the corpus membrane (block C's valence check is the
    # real-data half of this) — and it could not be reached by the fixture above,
    # which calls md.Topology() and never add_bond(). Geometry lifted from the
    # measured case: PRO.HG2 declared bonded to CG at 0.1115 nm and 0.1125 nm from
    # CD, inside the 0.1284 nm C-H window.
    top3 = md.Topology()
    res3 = top3.add_residue("PRO", top3.add_chain())
    cg = top3.add_atom("CG", md.element.carbon, res3)
    cd = top3.add_atom("CD", md.element.carbon, res3)
    hg2 = top3.add_atom("HG2", md.element.hydrogen, res3)
    xyz3 = np.array([[0.0, 0, 0], [0.1481, 0, 0], [0.073294, 0.084023, 0]],
                    dtype=np.float64)
    d_cg = float(np.linalg.norm(xyz3[cg.index] - xyz3[hg2.index]))
    d_cd = float(np.linalg.norm(xyz3[cd.index] - xyz3[hg2.index]))
    window_ch = (covalent_radius_nm("C") + covalent_radius_nm("H")) * COVALENT_BOND_SCALE
    free = infer_bonds(top3, xyz3)                 # nothing declared yet
    top3.add_bond(cg, hg2)                         # ...now the file declares CG-HG2
    bound = infer_bonds(top3, xyz3)
    checks += [
        ("COUNTERFACTUAL: with NOTHING declared the H really is in range of both",
         (cg.index, hg2.index) in set(free.pairs) and len(free.pairs) >= 1
         and d_cg <= window_ch and d_cd <= window_ch,
         f"CG-H {d_cg:.4f} nm, CD-H {d_cd:.4f} nm, window {window_ch:.4f} nm; "
         f"free inference proposed {sorted(free.pairs)}"),
        ("a hydrogen the topology ALREADY bonded gains NOTHING",
         not any(hg2.index in pair for pair in bound.pairs),
         f"{sorted(bound.pairs)}"),
        ("...and the refusal is COUNTED, not silent",
         bound.hydrogen_candidates_dropped >= 1,
         f"hydrogen_candidates_dropped={bound.hydrogen_candidates_dropped}"),
        ("the declared bond itself is never re-proposed (additive only)",
         (cg.index, hg2.index) not in set(bound.pairs), f"{sorted(bound.pairs)}"),
    ]

    # A DUPLICATED ATOM RECORD. The covalent window has an upper bound and no lower
    # one, so two records for the same physical atom (a hand-edited or concatenated
    # PDB; mdtraj only de-duplicates alternate positions when label_alt_id is set)
    # sit at distance 0.000, satisfy it trivially, and used to produce a
    # ZERO-LENGTH edge. Same layout as the measured case: N, CA, CA(dup), C, O.
    top4 = md.Topology()
    res4 = top4.add_residue("GLY", top4.add_chain())
    top4.add_atom("N", md.element.nitrogen, res4)
    top4.add_atom("CA", md.element.carbon, res4)
    top4.add_atom("CA", md.element.carbon, res4)      # the duplicate, no altloc
    top4.add_atom("C", md.element.carbon, res4)
    top4.add_atom("O", md.element.oxygen, res4)
    xyz4 = np.array([[0.0, 0, 0], [0.145, 0, 0], [0.145, 0, 0],
                     [0.290, 0, 0], [0.290, 0.123, 0]], dtype=np.float64)
    dup = infer_bonds(top4, xyz4)
    zero = [(i, j) for i, j in dup.pairs
            if float(np.linalg.norm(xyz4[i] - xyz4[j])) < 1e-9]
    checks += [
        ("a duplicated atom record is NOT bonded to itself", zero == [], f"{zero}"),
        ("COUNTERFACTUAL: the duplicate is real and the rest of the residue still bonds",
         top4.n_atoms == 5 and len(dup.pairs) >= 3, f"{sorted(dup.pairs)}"),
        ("the floor rejects only coincident records, not short real bonds",
         all(float(np.linalg.norm(xyz4[i] - xyz4[j])) >= MIN_COVALENT_BOND_NM
             for i, j in dup.pairs), f"{sorted(dup.pairs)}"),
    ]
    return all(ok for _, ok, _ in checks), checks


def check_big_residue_and_modes():
    """Two more guards.

    THE KD-TREE BRANCH: a residue over DENSE_RESIDUE_MAX_ATOMS must not take the
    dense upper triangle (which is O(k^2) in MEMORY). The branch is unreachable on
    the corpus — the largest real residue is a 118-atom lipid — so it is exercised
    on a synthetic chain of 400 atoms and asserted to agree, pair for pair, with
    what the dense path produces for the same geometry.

    MODE VALIDATION: an unknown mode must raise at both boundaries. A typo in a
    setting must not silently disable the fix.
    """
    n = 400
    top = md.Topology()
    res = top.add_residue("BIG", top.add_chain())
    for i in range(n):
        top.add_atom(f"C{i}", md.element.carbon, res)
    xyz = np.zeros((n, 3), dtype=np.float32)
    xyz[:, 0] = np.arange(n) * 0.15          # a chain, each atom bonded to its neighbours
    kd = infer_bonds(top, xyz)               # n > threshold -> KD-tree path

    small = md.Topology()
    res_s = small.add_residue("BIG", small.add_chain())
    for i in range(DENSE_RESIDUE_MAX_ATOMS):
        small.add_atom(f"C{i}", md.element.carbon, res_s)
    xyz_s = np.zeros((DENSE_RESIDUE_MAX_ATOMS, 3), dtype=np.float32)
    xyz_s[:, 0] = np.arange(DENSE_RESIDUE_MAX_ATOMS) * 0.15
    dense = infer_bonds(small, xyz_s)        # exactly at the threshold -> dense path

    checks = [
        (f"a {n}-atom residue takes the KD-tree path and finds the chain",
         kd.pairs == [(i, i + 1) for i in range(n - 1)],
         f"{kd.added} bonds (want {n - 1})"),
        ("the dense path agrees on the same geometry",
         dense.pairs == [(i, i + 1) for i in range(DENSE_RESIDUE_MAX_ATOMS - 1)],
         f"{dense.added} bonds (want {DENSE_RESIDUE_MAX_ATOMS - 1})"),
        ("KD-tree and dense results are the same rule",
         kd.pairs[: DENSE_RESIDUE_MAX_ATOMS - 1] == dense.pairs, "prefix identical"),
    ]

    raised = []
    try:
        infer_bonds(top, xyz, "fUlL")
    except ValueError as exc:
        raised.append(str(exc))
    checks.append(("infer_bonds rejects an unknown mode", len(raised) == 1,
                   raised[0] if raised else "NO EXCEPTION"))

    spec = resolve_system("05_macrocycle_disulfide")
    src_raised = None
    try:
        MdtrajSource(spec["topology"], spec["trajectory"], infer_bonds="maybe")
    except ValueError as exc:
        src_raised = str(exc)
    checks.append(("MdtrajSource rejects an unknown mode BEFORE reading the file",
                   src_raised is not None, src_raised or "NO EXCEPTION"))
    return all(ok for _, ok, _ in checks), checks


# -- runner --------------------------------------------------------------------



# -- J. what the scopes REACH, and what they provably do not -------------------


def _synthetic(chain_specs):
    """Build a topology + coordinates from
    ``[[(resname, [(atom_name, element_symbol, (x, y, z)), ...]), ...], ...]``
    — one inner list per CHAIN. Used for the bond classes no corpus file has."""
    top = md.Topology()
    coords = []
    handles = {}
    for residues in chain_specs:
        chain = top.add_chain()
        for res_name, atoms in residues:
            res = top.add_residue(res_name, chain)
            for atom_name, symbol, pos in atoms:
                atom = top.add_atom(atom_name, md.element.get_by_symbol(symbol), res)
                handles[(res.index, atom_name)] = atom.index
                coords.append(pos)
    return top, np.array(coords, dtype=np.float64), handles


def _cys(origin):
    """N-CA-CB-SG, SG at origin + (0, 0.331, 0)."""
    x, y, z = origin
    return [("N", "N", (x, y, z)), ("CA", "C", (x + 0.145, y, z)),
            ("CB", "C", (x + 0.145, y + 0.150, z)),
            ("SG", "S", (x + 0.145, y + 0.331, z))]


def _cys_facing(origin, gap):
    """A second CYS whose SG sits ``gap`` nm beyond the first one's SG."""
    x, y, z = origin
    sg_y = y + 0.331 + gap
    return [("N", "N", (x, sg_y + 0.331, z)), ("CA", "C", (x + 0.145, sg_y + 0.331, z)),
            ("CB", "C", (x + 0.145, sg_y + 0.181, z)),
            ("SG", "S", (x + 0.145, sg_y, z))]


# A real disulfide, MEASURED on 1b0c chain 4 CYS14.SG-CYS38.SG: 0.20417 nm.
SS_BOND_NM = 0.20417


def check_crosslink_reach():
    """Scope 3 used to refuse any pair whose residue INDEX differed by 1, on the
    stated ground that "an i/i+1 pair is scope 2's business". Both halves of that
    were false, and a fixture shows it in one line each:

      * mdtraj numbers residues GLOBALLY while scope 2 iterates
        ``for chain in topology.chains``. So a disulfide joining the LAST residue
        of one chain to the FIRST of the next differs by 1 in index and was
        reachable by no scope at all. The control is the identical geometry with
        one spacer residue in between, which was found — so the index gate, and
        nothing else, was the cause.
      * scope 2 name-gates to (C, N)/(O3', P), so it could never have caught an
        S-S anyway. A VICINAL disulfide (residues i and i+1 of one chain — the
        acetylcholine-receptor alpha Cys192-Cys193 motif) was therefore lost too.

    The replacement gate is "not the SAME residue", which is genuinely scope 1's
    business. What keeps the scope honest is the chalcogen requirement plus the
    covalent window, not index arithmetic — and the corpus agrees: this change
    adds ZERO bonds to every system in block C.
    """
    a, b = _cys((0.0, 0.0, 0.0)), _cys_facing((0.0, 0.0, 0.0), SS_BOND_NM)
    spacer = [("GLY", [("N", "N", (2.0, 0, 0)), ("CA", "C", (2.145, 0, 0)),
                       ("C", "C", (2.297, 0, 0)), ("O", "O", (2.297, 0.123, 0))])]
    checks = []

    def probe(label, spec, want_pair, expect):
        top, xyz, h = _synthetic(spec)
        got = infer_bonds(top, xyz, DEFAULT_MODE)
        pairs = set(got.pairs)
        found = tuple(sorted(want_pair)) in pairs
        checks.append((label, found is expect,
                       f"{'found' if found else 'MISSED'} "
                       f"(intra {got.intra} linkage {got.linkage} crosslink {got.crosslink})"))
        return got

    # the fixture's own geometry, asserted so a mis-built fixture cannot pass
    top0, xyz0, _ = _synthetic([[("CYS", a)], [("CYS", b)]])
    d = float(np.linalg.norm(xyz0[3] - xyz0[7]))
    checks.append(("FIXTURE: the two SG atoms are a real disulfide apart",
                   abs(d - SS_BOND_NM) < 1e-4, f"{d * 10:.4f} A vs 2.0417 A"))

    probe("inter-chain S-S: chain-A-last <-> chain-B-first is FOUND",
          [[("CYS", a)], [("CYS", b)]], (3, 7), True)
    probe("CONTROL: the same S-S with a spacer residue was always found",
          [[("CYS", a)], spacer, [("CYS", b)]], (3, 11), True)
    probe("vicinal S-S: residues i and i+1 of ONE chain is FOUND",
          [[("CYS", a), ("CYS", b)]], (3, 7), True)

    # ...and the scope that claims it is the one that made it.
    top1, xyz1, _ = _synthetic([[("CYS", a)], [("CYS", b)]])
    rep1 = infer_bonds(top1, xyz1, DEFAULT_MODE)
    checks.append(("...attributed to the CROSSLINK scope, not smuggled in elsewhere",
                   rep1.crosslink == 1 and rep1.linkage == 0,
                   f"intra {rep1.intra} linkage {rep1.linkage} crosslink {rep1.crosslink}"))

    # a same-residue S-C stays scope 1's, so the widened gate did not duplicate it
    same = [("CYS", a)]
    top2, xyz2, _ = _synthetic([same])
    rep2 = infer_bonds(top2, xyz2, DEFAULT_MODE)
    checks.append(("a SAME-residue S-C is still scope 1's, never scope 3's",
                   rep2.crosslink == 0 and rep2.intra == len(rep2.pairs),
                   f"intra {rep2.intra} crosslink {rep2.crosslink}"))
    return all(ok for _, ok, _ in checks), checks


def check_named_coverage_gaps():
    """The cross-residue covalent classes that carry NO chalcogen and are not a
    sequence-adjacent backbone pair.

    THIS BLOCK CHANGED SIDES. It used to assert all four as MISSED — a coverage
    gap held honest by a red line if a future scope ever reached one. Scope 4 (the
    named-linkage table) and the scope-2 chain WRAP are that future scope, so each
    is now asserted CAUGHT, and attributed to the scope that claims it so a bond
    cannot be smuggled in by the wrong gate.

    What stays missed is asserted too, and deliberately: metal coordination is not
    a covalent bond, and PyMOL and VMD both leave it undrawn.
    """
    checks = []

    def probe(label, spec, want_pair, want_scope=None):
        """want_scope None = assert MISSED; a scope name = assert FOUND and
        attributed to that scope."""
        top, xyz, _ = _synthetic(spec)
        got = infer_bonds(top, xyz, DEFAULT_MODE)
        key = tuple(sorted(want_pair))
        found = key in set(got.pairs)
        d = float(np.linalg.norm(xyz[key[0]] - xyz[key[1]]))
        if want_scope is None:
            checks.append((label, not found,
                           f"target at {d * 10:.3f} A -> "
                           f"{'FOUND (the docs are now wrong)' if found else 'missed, as documented'}"))
            return
        # attribution: exactly one scope may claim it, and it must be the right one
        counts = {"intra": got.intra, "linkage": got.linkage,
                  "crosslink": got.crosslink, "named": got.named}
        checks.append((label, found and counts[want_scope] >= 1,
                       f"target at {d * 10:.3f} A -> "
                       f"{'found' if found else 'MISSED (the fix regressed)'}, "
                       f"scopes {counts}"))

    gly = lambda x: [("N", "N", (x, 0, 0)), ("CA", "C", (x + 0.145, 0, 0)),
                     ("C", "C", (x + 0.297, 0, 0)), ("O", "O", (x + 0.297, 0.123, 0))]
    # head-to-tail cyclic peptide: last residue's C to first residue's N (0.133 nm)
    probe("head-to-tail cyclic peptide (last C -> first N) IS inferred (the scope-2 WRAP)",
          [[("GLY", [("N", "N", (0.0, 0, 0)), ("CA", "C", (0.145, 0, 0))]),
            ("GLY", gly(0.4)),
            ("GLY", [("N", "N", (0.9, 0, 0)), ("CA", "C", (1.045, 0, 0)),
                     ("C", "C", (0.133, 0, 0))])]], (0, 8), "linkage")
    # N-glycan: ASN.ND2 - NAG.C1 (0.1441 nm), two non-adjacent residues, no chalcogen
    probe("N-glycan link ASN.ND2 - NAG.C1 IS inferred (scope 4)",
          [[("ASN", [("CB", "C", (0.0, 0, 0)), ("CG", "C", (0.152, 0, 0)),
                     ("ND2", "N", (0.152, 0.133, 0))]),
            ("GLY", gly(2.0)),
            ("NAG", [("C1", "C", (0.152, 0.2771, 0)), ("O5", "O", (0.152, 0.4211, 0))])]],
          (2, 7), "named")
    # isopeptide: LYS.NZ - GLY.C (0.133 nm)
    probe("isopeptide LYS.NZ - GLY.C (ubiquitin/SUMO) IS inferred (scope 4)",
          [[("LYS", [("CE", "C", (0.0, 0, 0)), ("NZ", "N", (0.148, 0, 0))]),
            ("ALA", gly(2.0)),
            ("GLY", [("C", "C", (0.281, 0, 0)), ("O", "O", (0.281, 0.123, 0))])]],
          (1, 6), "named")
    # covalent ligand through a non-chalcogen: SER.OG - LIG.C1 (0.1432 nm)
    probe("a covalent ligand bonded through O (SER.OG - C1) IS inferred (scope 4)",
          [[("SER", [("CB", "C", (0.0, 0, 0)), ("OG", "O", (0.143, 0, 0))]),
            ("ALA", gly(2.0)),
            ("LIG", [("C1", "C", (0.2862, 0, 0)), ("C2", "C", (0.4382, 0, 0))])]],
          (1, 6), "named")
    # metal-organic: a heme iron inside its own porphyrin (Fe-N 0.204 nm)
    hem = [("FE", "Fe", (0.0, 0, 0))]
    for k, (dx, dy) in enumerate(((0.204, 0.0), (-0.204, 0.0), (0.0, 0.204), (0.0, -0.204))):
        hem.append((f"N{k}", "N", (dx, dy, 0.0)))
    top_h, xyz_h, _ = _synthetic([[("HEM", hem)]])
    rep_h = infer_bonds(top_h, xyz_h, DEFAULT_MODE)
    fe_bonds = [p for p in rep_h.pairs if 0 in p]
    window_fe = (covalent_radius_nm("FE") + covalent_radius_nm("N")) * COVALENT_BOND_SCALE
    checks.append(("a heme Fe stays UNBONDED inside its own porphyrin",
                   fe_bonds == [],
                   f"Fe-N 0.2040 nm vs window {window_fe:.4f} nm (metals are not in "
                   f"COVALENT_RADII_NM) -> {len(fe_bonds)} Fe bonds"))

    # ...and the flip side of the metals decision: an ION never sprouts a shell.
    checks.append(("...which is the SAME decision that keeps ion coordination shells bare",
                   covalent_radius_nm("ZN") == covalent_radius_nm("__nosuchelement__"),
                   "every metal falls back to COVALENT_RADIUS_DEFAULT_NM"))

    # -- THE NEGATIVE CONTROL for scope 4 -------------------------------------
    # Everything above would pass just as happily if scope 4 were a plain
    # non-adjacent distance search — which is the exact implementation that fused
    # the membrane. So: the SAME geometry at the SAME distance, with atom names
    # the table does not pair, must stay UNBONDED. If this goes green while the
    # probes above also go green, the name gate is load-bearing; if it goes red,
    # scope 4 has quietly become a distance rule and the DMPC block is next.
    probe("a cross-residue pair at bonding distance whose NAMES are not paired stays UNBONDED",
          [[("ALA", [("CB", "C", (0.0, 0, 0)), ("CG2", "C", (0.148, 0, 0))]),
            ("ALA", gly(2.0)),
            ("LIG", [("C9", "C", (0.281, 0, 0)), ("C8", "C", (0.281, 0.123, 0))])]],
          (1, 6))
    # and the mirror: ONE name from the table is not enough — a pair is a PAIR.
    probe("...and one paired name against an unpaired partner is still UNBONDED",
          [[("LYS", [("CE", "C", (0.0, 0, 0)), ("NZ", "N", (0.148, 0, 0))]),
            ("ALA", gly(2.0)),
            ("LIG", [("C9", "C", (0.281, 0, 0)), ("C8", "C", (0.281, 0.123, 0))])]],
          (1, 6))
    return all(ok for _, ok, _ in checks), checks


def check_boron_silicon_absent():
    """B and SI were in COVALENT_RADII_NM and earned ZERO edges on every system in
    the evidence base, while boron measurably widened the window on the one system
    whose atoms have no real elements at all: mdtraj name-guesses martini backbone
    beads called "BB" as boron. 07's "+0" then survived by 0.13 pm.

    Removing them is only safe if real boron/silicon chemistry still lands inside
    the DEFAULT radius's window, so that is measured here rather than asserted.
    Si-C is the one genuine loss and is named as such."""
    d = covalent_radius_nm("__default__")
    checks = [("B is not in the radii table", covalent_radius_nm("B") == d, "default"),
              ("SI is not in the radii table", covalent_radius_nm("SI") == d, "default")]
    for label, real_nm, other, reachable in (
        ("B-O (boronic acid)", 0.136, "O", True),
        ("B-C", 0.158, "C", True),
        ("B-N", 0.144, "N", True),
        ("SI-O (siloxane)", 0.163, "O", True),
        ("SI-C", 0.187, "C", False),
    ):
        window = (d + covalent_radius_nm(other)) * COVALENT_BOND_SCALE
        got = real_nm <= window
        checks.append((f"{label} {'still reachable' if reachable else 'is the ACCEPTED loss'} "
                       f"with the default radius",
                       got is reachable,
                       f"real {real_nm:.3f} nm vs window {window:.4f} nm -> "
                       f"{'reachable' if got else 'missed'}"))

    # the martini system, where boron was doing harm: the tightest intra-residue
    # pair must stay OUTSIDE the window, and the margin is reported because it is thin.
    spec = resolve_system("07_coarse_grain_martini")
    traj, top = _load_static(spec["topology"])
    xyz = traj.xyz[0]
    worst = None
    for res in top.residues:
        idx = [a.index for a in res.atoms]
        for m in range(len(idx)):
            for n in range(m + 1, len(idx)):
                i, j = idx[m], idx[n]
                dist = float(np.linalg.norm(xyz[i] - xyz[j]))
                si = top.atom(i).element.symbol if top.atom(i).element else ""
                sj = top.atom(j).element.symbol if top.atom(j).element else ""
                w = (covalent_radius_nm(si) + covalent_radius_nm(sj)) * COVALENT_BOND_SCALE
                if worst is None or dist - w < worst[0]:
                    worst = (dist - w, dist, w,
                             f"{res.name}.{top.atom(i).name}({si})-{top.atom(j).name}({sj})")
    margin, dist, window, who = worst
    checks.append(("martini: the tightest intra-residue pair is still OUTSIDE its window",
                   margin > 0,
                   f"margin {margin * 1000:+.4f} pm ({who}: d={dist * 1000:.3f} pm vs "
                   f"window {window * 1000:.3f} pm)"))
    checks.append(("...and with boron in the table that window would have been 8.4 pm wider",
                   abs((0.084 - covalent_radius_nm("__default__")) * COVALENT_BOND_SCALE
                       * 1000 - 8.4) < 0.2,
                   "0.084 nm (Cordero B) vs 0.077 nm default"))
    return all(ok for _, ok, _ in checks), checks


# -- K. cost, which nothing in this file used to constrain ---------------------


def _split_merged_waters(top):
    """Rebuild a topology with ONE residue record per water molecule.

    ``membrane.pdb`` is the only large system available to measure inference cost
    on, and its resSeq overflowed: mdtraj merged 47,829 waters into 14,300 HOH
    records. That is the FLATTERING case for a per-record implementation, so
    measuring only it is how a per-record cost stays invisible. This produces the
    same atoms, the same coordinates, the same elements and the same declared
    bonds with 50,031 records instead of 16,502 — what any PDB under 99,999
    residues, any .gro, or any prmtop would have given.
    """
    new = md.Topology()
    for chain in top.chains:
        nc = new.add_chain()
        for res in chain.residues:
            atoms = list(res.atoms)
            if res.name.upper() in ("HOH", "WAT", "SOL", "TIP3") and len(atoms) > 3:
                for s in range(0, len(atoms), 3):
                    nr = new.add_residue(res.name, nc, resSeq=res.resSeq)
                    for a in atoms[s:s + 3]:
                        new.add_atom(a.name, a.element, nr)
            else:
                nr = new.add_residue(res.name, nc, resSeq=res.resSeq)
                for a in atoms:
                    new.add_atom(a.name, a.element, nr)
    seq = list(new.atoms)
    for a, b in top.bonds:
        new.add_bond(seq[a.index], seq[b.index])
    return new


# Cost ceilings. Deliberately loose — a wall clock on a shared machine is not a
# benchmark — but not vacuous either: MEASURED at 0.44 s for the 222,227-atom
# membrane, so 4 s catches the ~10x class of regression (the exact mutation that
# used to leave this file ALL PASS: a 10x repeat of the intra distance
# computation took inference 1.08 s -> 2.87 s and nothing went red). The RATIO is
# the assertion that actually pins the defect, and it needs no absolute number.
MEMBRANE_INFER_CEILING_S = 4.0
# Cost must scale with ATOMS, not with residue records. Before the bucketed
# rewrite this ratio was 1.73 (0.671 s -> 1.159 s for identical bonds); it is now
# 0.9. 1.25 leaves room for machine noise and still fails the per-record class.
RECORD_SCALING_MAX_RATIO = 1.25


def check_cost():
    """Nothing in the 175 checks this file used to hold constrained COST, so a
    pure 2.7x slowdown of inference passed ALL green. Two things are asserted:

      * a loose absolute ceiling, which catches gross regressions;
      * the RATIO between the as-filed membrane and the same 222,227 atoms with
        one residue record per water. That ratio is the actual defect: inference
        used to loop over residues in Python and cost ~16 us per RECORD, so the
        only file big enough to measure it understated a normally-numbered box of
        the same size by 74%. A ratio assertion needs no absolute number and no
        assumption about the machine.

    Best-of-3 on both, back to back in ONE process, so machine load cannot
    explain a difference between them.
    """
    traj, top = _load_static(
        _bench("systems", "06_membrane_complex", "files", "membrane.pdb")
    )
    xyz = traj.xyz[0]
    split = _split_merged_waters(top)

    def best(t):
        runs = []
        for _ in range(3):
            started = time.perf_counter()
            report = infer_bonds(t, xyz, DEFAULT_MODE)
            runs.append(time.perf_counter() - started)
        return min(runs), report

    filed_s, filed = best(top)
    split_s, split_report = best(split)
    ratio = split_s / max(filed_s, 1e-9)
    checks = [
        ("FIXTURE: the rebuild is the same atoms, elements and bonds",
         split.n_atoms == top.n_atoms and split.n_bonds == top.n_bonds
         and [a.element for a in split.atoms] == [a.element for a in top.atoms],
         f"{top.n_atoms} atoms, {top.n_bonds} bonds"),
        ("FIXTURE: ...with 3x the residue records",
         split.n_residues > 3 * 10 ** 4 and split.n_residues > 2 * top.n_residues,
         f"{top.n_residues} records as filed -> {split.n_residues} rebuilt"),
        ("record count does not change WHICH bonds are found",
         sorted(split_report.pairs) == sorted(filed.pairs),
         f"{filed.added} vs {split_report.added}"),
        (f"membrane inference under {MEMBRANE_INFER_CEILING_S}s",
         filed_s < MEMBRANE_INFER_CEILING_S, f"{filed_s:.3f}s for {top.n_atoms} atoms"),
        (f"cost scales with ATOMS not RECORDS (ratio < {RECORD_SCALING_MAX_RATIO})",
         ratio < RECORD_SCALING_MAX_RATIO,
         f"as-filed {filed_s:.3f}s ({top.n_residues} records) -> "
         f"rebuilt {split_s:.3f}s ({split.n_residues} records) = {ratio:.2f}x"),
    ]
    return all(ok for _, ok, _ in checks), checks


def check_no_scipy_for_ordinary_files():
    """scipy is imported LAZILY, and that laziness has to buy something. It used
    to buy nothing for real data: the crosslink scope built a KD-tree whenever a
    file held ANY sulfur — i.e. essentially every protein — so a 72-atom
    macrocycle paid ~0.14 s and ~25 MiB to import scipy for a scope that added
    zero bonds. Both paths that need scipy are now bounded away from ordinary
    files: the crosslink scope brute-forces below CROSSLINK_BRUTE_MAX_PAIRS, and
    the intra scope only reaches _kdtree for a residue record over
    DENSE_RESIDUE_MAX_ATOMS atoms.

    Run in a SUBPROCESS because sys.modules is process-global and every other
    block in this file has already imported scipy.
    """
    probe = (
        "import sys, warnings, os; warnings.filterwarnings('ignore');"
        "sys.path.insert(0, %r);"
        "import numpy as np, mdtraj as md;"
        "from producer.bond_inference import infer_bonds;"
        "t = md.load(%r);"
        "r = infer_bonds(t.topology, t.xyz[0].astype(np.float64), 'full');"
        "print(r.added, 'scipy' if 'scipy.spatial' in sys.modules else 'noscipy')"
    )
    root = os.path.join(os.path.dirname(__file__), "..")
    checks = []
    for label, sid, want_scipy in (
        ("05_macrocycle_disulfide (2 S atoms, 0 bonds added)", "05_macrocycle_disulfide", False),
        ("03_adk_psf_dcd (7 S atoms, 0 bonds added)", "03_adk_psf_dcd", False),
        ("09_nucleic_duplex (34-atom records, 24 bonds added)", "09_nucleic_duplex", False),
        ("02_trpcage_atomistic", "02_trpcage_atomistic", False),
        ("04_ligand_custom_solvent", "04_ligand_custom_solvent", False),
    ):
        spec = resolve_system(sid)
        out = subprocess.run([sys.executable, "-c", probe % (root, spec["topology"])],
                             capture_output=True, text=True)
        tail = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else out.stderr[-200:]
        got_scipy = tail.split()[-1] == "scipy" if tail.split() else True
        checks.append((f"{label}: scipy is NOT imported", got_scipy is want_scipy, tail))
    # ...and the branch that DOES need it still works (the 300-atom records in
    # membrane_frame0.pdb are real, not a fixture).
    big = _bench("systems", "06_membrane_complex", "files", "membrane_frame0.pdb")
    if os.path.exists(big):
        top = md.load_topology(big)
        largest = max(r.n_atoms for r in top.residues)
        checks.append(("a real file DOES contain records over DENSE_RESIDUE_MAX_ATOMS",
                       largest > DENSE_RESIDUE_MAX_ATOMS,
                       f"membrane_frame0.pdb largest record = {largest} atoms "
                       f"(threshold {DENSE_RESIDUE_MAX_ATOMS})"))
    return all(ok for _, ok, _ in checks), checks


# -- L. the four complaint files, THROUGH THE REAL PRODUCER --------------------


def _source_for(path, trajectory=None, mode=DEFAULT_MODE):
    return MdtrajSource(path, trajectory, os.path.basename(path), [], infer_bonds=mode)


def check_complaint_files_through_producer():
    """Blocks A, B and E grade the four files the brief complains about by calling
    infer_bonds() on a bare md.load() topology. That skips everything the producer
    does around it: file_resolve, centering, _representative_xyz(), the PBC filter
    and header serialization. So the complaints were graded OUTSIDE the thing that
    ships. This block runs the same four files through MdtrajSource and asserts the
    complaint is fixed IN THE HEADER.

    Complaint 1 also has a second half the rest of this file never names: the
    brief says "Also DC.HO5' terminal H is bare". It is fixed, but block C's
    "09_nucleic_duplex: intra=2" would pass just as happily if those two bonds
    landed on two entirely different atoms — so the two hydrogens are named.
    """
    checks = []

    # -- complaint 1: nucleic backbone + the terminal HO5'
    spec = resolve_system("09_nucleic_duplex")
    off = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], infer_bonds="off")
    full = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                        spec["ligand_residues"], infer_bonds="full")
    try:
        h_off, h_full = off.give_header(), full.give_header()
        deg_off, deg_full = collections.Counter(), collections.Counter()
        for i, j in h_off.edges:
            deg_off[i] += 1
            deg_off[j] += 1
        for i, j in h_full.edges:
            deg_full[i] += 1
            deg_full[j] += 1
        top = full._topology
        links = _consecutive_o3p_links(top, h_full.edges)
        links_off = _consecutive_o3p_links(top, h_off.edges)
        ho5 = [a.index for a in top.atoms if a.name in ("HO5'", "HO5*")]
        checks += [
            ("09 duplex: O3'-P backbone links 0 -> 22 in the HEADER",
             (links_off, links) == (0, 22), f"off {links_off} -> full {links}"),
            ("09 duplex: the 2 terminal HO5' hydrogens go bare -> bonded",
             len(ho5) == 2 and all(deg_off[i] == 0 for i in ho5)
             and all(deg_full[i] == 1 for i in ho5),
             f"HO5' atoms {ho5}: degree "
             f"{[deg_off[i] for i in ho5]} -> {[deg_full[i] for i in ho5]}"),
            ("09 duplex: no bare hydrogen is left anywhere",
             sum(1 for a in top.atoms
                 if a.element is not None and a.element.symbol == "H"
                 and deg_full[a.index] == 0) == 0,
             f"{sum(1 for a in top.atoms if a.element is not None and a.element.symbol == 'H' and deg_off[a.index] == 0)}"
             f" bare hydrogens with inference off"),
        ]
    finally:
        off.close()
        full.close()

    # -- complaint 2: the AlphaFold cif — ADP and TPO bare, ZN/MG correctly bare
    af = _bench("fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")
    src = _source_for(af)
    src_off = _source_for(af, mode="off")
    try:
        header, header_off = src.give_header(), src_off.give_header()
        top = src._topology
        edges = {(min(i, j), max(i, j)) for i, j in header.edges}
        for name, want in (("ADP", (1, 29, 3)), ("TPO", (1, 10, 0))):
            idx = [a.index for r in top.residues if r.name.upper() == name for a in r.atoms]
            checks.append((f"AF cif through the producer: {name} -> {want}",
                           _graph(idx, edges) == want, f"{len(idx)} atoms -> {_graph(idx, edges)}"))
        ions = [a.index for r in top.residues if r.name.upper() in ("ZN", "MG")
                for a in r.atoms]
        checks += [
            (f"AF cif: header edges {len(header_off.edges)} -> {len(header.edges)}",
             len(header.edges) - len(header_off.edges) == 40,
             f"+{len(header.edges) - len(header_off.edges)}"),
            ("AF cif: ZN and MG stay bare in the HEADER",
             not any(i in ions or j in ions for i, j in header.edges), f"{len(ions)} ion atoms"),
        ]
    finally:
        src.close()
        src_off.close()

    # -- complaint 3: the membrane, and complaint 4: BACD (an authoritative PSF)
    spec = resolve_system("06_membrane_complex")
    memb = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                        spec["ligand_residues"], infer_bonds="full")
    try:
        header = memb.give_header()
        top = memb._topology
        deg = collections.Counter()
        for i, j in header.edges:
            deg[i] += 1
            deg[j] += 1
        dmpc = [a.index for r in top.residues if r.name.upper() == "DMPC" for a in r.atoms]
        bare = sum(1 for i in dmpc if deg[i] == 0)
        checks += [
            ("membrane: 0 of the 56,876 DMPC atoms are left unbonded in the HEADER",
             bare == 0 and len(dmpc) == 56876, f"{bare} bare of {len(dmpc)}"),
            ("membrane: the header carries the bond-inference provenance line",
             any(line.startswith("bond inference") for line in header.provenance),
             next((line[:80] for line in header.provenance
                   if line.startswith("bond inference")), "MISSING")),
        ]
    finally:
        memb.close()

    bacd_pdb, bacd_psf = _bench("BACD_ion.pdb"), _bench("BACD_ion.psf")
    if os.path.exists(bacd_pdb) and os.path.exists(bacd_psf):
        src = _source_for(bacd_pdb)
        try:
            header = src.give_header()
            psf = md.load_topology(bacd_psf)
            want = {(min(a.index, b.index), max(a.index, b.index)) for a, b in psf.bonds}
            got = {(min(i, j), max(i, j)) for i, j in header.edges}
            checks.append(("BACD through the producer: header.edges EQUALS the authoritative PSF",
                           got == want, f"{len(got)} edges vs {len(want)} PSF bonds; "
                                        f"missing {len(want - got)}, extra {len(got - want)}"))
        finally:
            src.close()
    return all(ok for _, ok, _ in checks), checks


def _consecutive_o3p_links(top, edges):
    """Bonds joining residue i's O3' to residue i+1's P, within one chain."""
    pairs = {(min(i, j), max(i, j)) for i, j in edges}
    found = 0
    for chain in top.chains:
        residues = list(chain.residues)
        for a, b in zip(residues, residues[1:]):
            o3 = next((x.index for x in a.atoms if x.name in ("O3'", "O3*")), None)
            p = next((x.index for x in b.atoms if x.name == "P"), None)
            if o3 is not None and p is not None and (min(o3, p), max(o3, p)) in pairs:
                found += 1
    return found

def _run(label, fn, *args):
    try:
        ok, checks = fn(*args)
    except Exception as exc:
        import traceback
        ok, checks = False, [("exception", False,
                              f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
    print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    for name, cok, detail in checks:
        print(f"        {'ok  ' if cok else 'FAIL'} {name:64s} {detail}")
    return ok


def main() -> int:
    print(f"corpus root: {corpus_root()}   modes: {MODES}   default: {DEFAULT_MODE}\n")
    total = True

    print("--- A. PSF equality: the inferred set vs a CHARMM force field's own bonds ---")
    total &= _run("BACD_ion.pdb vs BACD_ion.psf", check_psf_equality)

    print("\n--- B. graph integrity: components and RINGS, not bond counts ---")
    total &= _run("AlphaFold cif: ADP + TPO", check_small_molecule_graph)
    total &= _run("membrane: 482 DMPC lipids", check_membrane_graph)

    print("\n--- C. corpus delta, through the real producer ---")
    for sid in CORPUS:
        total &= _run(sid, check_corpus_delta, sid)
    total &= _run("the two '+0' claims that are correctness, not scale",
                  check_graceful_empty_cases)
    print("        note 08_macrocycle_thioether has an EMPTY files/ directory — "
          "no topology to load, so it is absent from this table by inspection")

    print("\n--- D. monatomic ions stay bare ---")
    total &= _run("ZN MG NA CL SOD CLA POT", check_ions_bare)
    total &= _run("the exclusion is LOAD-BEARING (fixtures the corpus cannot supply)",
                  check_monatomic_exclusion_is_load_bearing)
    total &= _run("an inferred pair goes through the SAME cross-box cutoff",
                  check_pbc_filter_reaches_inferred_pairs)

    print("\n--- E. a genuine missing residue is never bridged ---")
    total &= _run("10GJ chain 9: the 0.775 nm gap", check_genuine_gap)

    print("\n--- F. 'off' reproduces the pre-change producer, pair for pair ---")
    for sid in CORPUS:
        total &= _run(sid, check_off_is_pre_change, sid)

    print("\n--- G. NEGATIVE CONTROL: the unscoped search wrecks the membrane ---")
    total &= _run("unscoped global search vs DMPC", check_negative_control)

    print("\n--- H. the setting's mode list and the producer's cannot drift ---")
    total &= _run("package.json vs bond_inference.MODES", check_one_default)

    print("\n--- I. the rules no real system here exercises ---")
    total &= _run("one partner per hydrogen; never H-H", check_hydrogen_rule)
    total &= _run("the KD-tree branch; mode validation", check_big_residue_and_modes)

    print("\n--- J. what the scopes reach, and what they provably do not ---")
    total &= _run("chain-boundary and vicinal crosslinks", check_crosslink_reach)
    total &= _run("the NAMED coverage gaps stay gaps", check_named_coverage_gaps)
    total &= _run("boron/silicon absent from the radii table", check_boron_silicon_absent)

    print("\n--- K. cost, which nothing here used to constrain ---")
    total &= _run("cost scales with atoms, not residue records", check_cost)
    total &= _run("an ordinary file never imports scipy", check_no_scipy_for_ordinary_files)

    print("\n--- L. the four complaint files, through the REAL producer ---")
    total &= _run("nucleic backbone, HO5', ADP/TPO, DMPC, BACD vs its PSF",
                  check_complaint_files_through_producer)

    print(f"\n{'ALL PASS' if total else 'FAILURES PRESENT'}")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())
