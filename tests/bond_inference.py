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
import sys
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
from producer.domain_rules import COVALENT_BOND_SCALE, covalent_radius_nm  # noqa: E402
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
    "06_membrane_complex": 123476, "07_coarse_grain_martini": 0,
    "09_nucleic_duplex": 24, "10_tip4p_virtualsites": 0,
}
# The same, in "nonsolvent" mode: identical everywhere except the membrane, where
# 67,058 of the 123,476 inferred bonds are water O-H.
CORPUS_DELTA_NONSOLVENT = dict(CORPUS_DELTA, **{"06_membrane_complex": 56418})
# The per-scope split, for the two systems that add anything. Named separately
# because the scopes answer different questions and a regression that moved bonds
# from one scope to another would leave the total unchanged.
CORPUS_SCOPES = {
    "06_membrane_complex": {"intra": 123476, "linkage": 0, "crosslink": 0},
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
        ("total inferred == 123476", report.added == 123476, f"{report.added}"),
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
        delta = len(full.edges) - len(off.edges)
        delta_ns = len(nons.edges) - len(off.edges)
        checks = [
            (f"full: +{CORPUS_DELTA[sid]} edges", delta == CORPUS_DELTA[sid],
             f"{len(off.edges)} -> {len(full.edges)} (+{delta})"),
            (f"nonsolvent: +{CORPUS_DELTA_NONSOLVENT[sid]} edges",
             delta_ns == CORPUS_DELTA_NONSOLVENT[sid],
             f"{len(off.edges)} -> {len(nons.edges)} (+{delta_ns})"),
            ("every inferred pair survives the PBC cutoff here",
             full.inferred_edges_kept == report.added,
             f"{full.inferred_edges_kept} of {report.added} kept"),
            ("the report's count IS the edge delta", report.added == delta,
             f"report {report.added} vs edges +{delta}"),
            ("inferred pairs are APPENDED — pre-inference slots do not move",
             full.edges[: len(off.edges)] == off.edges,
             f"first {len(off.edges)} edges identical"),
            ("the inferred tail is sorted and holds i < j",
             all(i < j for i, j in full.edges[len(off.edges):])
             and full.edges[len(off.edges):] == sorted(full.edges[len(off.edges):]),
             f"{delta} appended"),
        ]
        if sid in CORPUS_SCOPES:
            want = CORPUS_SCOPES[sid]
            got = {"intra": report.intra, "linkage": report.linkage,
                   "crosslink": report.crosslink}
            checks.append((f"scope split {want}", got == want, f"{got}"))
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
                 src.inferred_edges_kept == 0 and src.edges == [],
                 f"kept {src.inferred_edges_kept} of {report.added}, edges {src.edges}"),
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
             src.edges == reference,
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
        unscoped global search  742 components, 59,709 bonds, 3,575 rings

    Two different failures at once, and neither is fixable by moving a threshold:
      * FUSION — 3,575 rings, from bonds between atoms of different molecules that
        happen to touch. membrane.pdb genuinely holds 1,788 atom pairs closer than
        0.05 nm, so no distance cut separates "one molecule" from "two molecules
        in contact".
      * SHREDDING — 742 > 482 components, because a lipid hydrogen's nearest
        neighbour turns out to be in a passing water, so the one-partner rule hands
        the H to the water and it detaches from its own carbon.

    (The original diagnosis recorded ~70 components here rather than 742. 742 is
    what this repository's unscoped path measures; the ring count, 3,575, agrees
    exactly. The difference is almost certainly whether the hydrogen rule was
    applied globally — a variant with the rule off collapses DMPC to 3 components
    with 9,391 rings, which is worse still. All three are catastrophic; the
    assertion below is on the property, with the measured numbers pinned.)
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
        ("pinned measurement: unscoped == 742 comps / 59709 bonds / 3575 rings",
         unscoped_graph == (742, 59709, 3575), f"{unscoped_graph}"),
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

    print(f"\n{'ALL PASS' if total else 'FAILURES PRESENT'}")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())
