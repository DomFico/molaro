"""Measure everything tests/bond_inference.py will pin."""
from __future__ import annotations

import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mdtraj as md  # noqa: E402
import numpy as np  # noqa: E402

from producer.bond_inference import infer_bonds  # noqa: E402
from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402

SYSTEMS = ["01_alanine_dipeptide", "02_trpcage_atomistic", "03_adk_psf_dcd",
           "04_ligand_custom_solvent", "05_macrocycle_disulfide", "06_membrane_complex",
           "07_coarse_grain_martini", "09_nucleic_duplex", "10_tip4p_virtualsites"]

print("=== corpus delta THROUGH THE REAL PRODUCER (edges full vs off) ===")
for sid in SYSTEMS:
    spec = resolve_system(sid)
    off = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], infer_bonds="off")
    full = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                        spec["ligand_residues"], infer_bonds="full")
    ns = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                      spec["ligand_residues"], infer_bonds="nonsolvent")
    r = full.bond_inference
    prefix = [tuple(e) for e in full.edges][:len(off.edges)] == [tuple(e) for e in off.edges]
    print(f"  {sid:26s} off={len(off.edges):>6} full={len(full.edges):>6} "
          f"delta=+{len(full.edges)-len(off.edges):<6} nonsolvent=+{len(ns.edges)-len(off.edges):<6} "
          f"intra={r.intra} link={r.linkage} xlink={r.crosslink} "
          f"kept={full.inferred_edges_kept}/{r.added} prefix={prefix} "
          f"streaming={full._streaming}")
    for src in (off, full, ns):
        src.close()

print("\n=== ion residue names present (monatomic residues) ===")
names = {}
for sid in SYSTEMS:
    spec = resolve_system(sid)
    top = md.load_topology(spec["topology"])
    for res in top.residues:
        if res.n_atoms == 1:
            names.setdefault(res.name.upper(), set()).add(sid)
B = corpus_root()
for label, path in [("AF cif", f"{B}/fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif"),
                    ("BACD", f"{B}/BACD_ion.pdb"), ("10GJ", f"{B}/10GJ.cif")]:
    top = md.load_topology(path)
    for res in top.residues:
        if res.n_atoms == 1:
            names.setdefault(res.name.upper(), set()).add(label)
for k in sorted(names):
    print(f"  {k:8s} {sorted(names[k])}")

print("\n=== 10GJ: the genuine gap ===")
t = md.load(f"{B}/10GJ.cif")
top = t.topology
if top.n_bonds == 0:
    top.create_standard_bonds()
res_full = infer_bonds(top, t.xyz[0])
pairs = set(res_full.pairs)
declared = {(min(a.index, b.index), max(a.index, b.index)) for a, b in top.bonds}
gaps = []
for chain in top.chains:
    rs = list(chain.residues)
    for r1, r2 in zip(rs, rs[1:]):
        m1 = {a.name: a.index for a in r1.atoms}
        m2 = {a.name: a.index for a in r2.atoms}
        for tail, head in (("C", "N"), ("O3'", "P")):
            if tail in m1 and head in m2:
                i, j = m1[tail], m2[head]
                key = (min(i, j), max(i, j))
                if key in pairs or key in declared:
                    continue
                d = float(np.linalg.norm(t.xyz[0][i] - t.xyz[0][j]))
                gaps.append((chain.index, r1.name, r1.resSeq, r2.name, r2.resSeq, tail, head, d))
print(f"  inferred {res_full.added} (intra {res_full.intra} link {res_full.linkage} "
      f"xlink {res_full.crosslink});  residual unbonded adjacent links: {len(gaps)}")
for g in gaps:
    print(f"    chain {g[0]} {g[1]}{g[2]} {g[5]} -> {g[3]}{g[4]} {g[6]}  {g[7]:.3f} nm")

print("\n=== AF cif ===")
t = md.load(f"{B}/fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")
top = t.topology
if top.n_bonds == 0:
    top.create_standard_bonds()
r = infer_bonds(top, t.xyz[0])
by_res = {}
for i, j in r.pairs:
    ri, rj = top.atom(i).residue, top.atom(j).residue
    key = ri.name if ri.index == rj.index else f"{ri.name}~{rj.name}"
    by_res[key] = by_res.get(key, 0) + 1
print(f"  +{r.added} {by_res}")
for rn in ("ADP", "TPO", "ZN", "MG"):
    got = [res for res in top.residues if res.name.upper() == rn]
    for res in got:
        idx = {a.index for a in res.atoms}
        n = sum(1 for i, j in r.pairs if i in idx or j in idx)
        print(f"  {rn} resSeq={res.resSeq} n_atoms={res.n_atoms} inferred_touching={n}")

print("\n=== TIP4P M sites ===")
spec = resolve_system("10_tip4p_virtualsites")
t = md.load(spec["trajectory"], top=spec["topology"])
top = t.topology
mo = []
for res in top.residues:
    a = {x.name: x.index for x in res.atoms}
    mo.append(float(np.linalg.norm(t.xyz[0][a["M"]] - t.xyz[0][a["O"]])))
print(f"  M-O distance min {min(mo):.4f} max {max(mo):.4f} nm; "
      f"O-H covalent window (0.066+0.031)*1.2 = {(0.066+0.031)*1.2:.4f}; "
      f"VS default window (0.077+0.066)*1.2 = {(0.077+0.066)*1.2:.4f} nm")

print("\n=== martini bead spacing (why 07 is +0) ===")
spec = resolve_system("07_coarse_grain_martini")
t = md.load(spec["trajectory"], top=spec["topology"])
top = t.topology
best = 1e9
for res in top.residues:
    idx = [a.index for a in res.atoms]
    for a in range(len(idx)):
        for b in range(a + 1, len(idx)):
            best = min(best, float(np.linalg.norm(t.xyz[0][idx[a]] - t.xyz[0][idx[b]])))
print(f"  closest intra-residue bead pair {best:.4f} nm vs largest CG window "
      f"(0.084+0.084)*1.2 = {(0.084 + 0.084) * 1.2:.4f} nm")

print("\n=== BACD lanthionine bridges ===")
t = md.load(f"{B}/BACD_ion.pdb")
top = t.topology
r = infer_bonds(top, t.xyz[0])
for i, j in r.pairs:
    ai, aj = top.atom(i), top.atom(j)
    if ai.residue.index != aj.residue.index and abs(ai.residue.index - aj.residue.index) > 1:
        d = float(np.linalg.norm(t.xyz[0][i] - t.xyz[0][j]))
        print(f"  {ai.residue.name}{ai.residue.resSeq}.{ai.name} - "
              f"{aj.residue.name}{aj.residue.resSeq}.{aj.name}  {d:.4f} nm "
              f"(delta {aj.residue.resSeq - ai.residue.resSeq} residues)")
