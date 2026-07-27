"""Does producer/bond_inference reproduce the reference prototype's numbers?"""
from __future__ import annotations

import glob
import importlib.util
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mdtraj as md  # noqa: E402
import numpy as np  # noqa: E402

from producer.bond_inference import infer_bonds, infer_bonds_unscoped  # noqa: E402

PROTO = ("/tmp/claude-1000/-home-dom-Desktop-claude-hackathon/"
         "16c04223-1c07-4e53-b12b-7db7d46630ef/scratchpad/final.py")
spec = importlib.util.spec_from_file_location("proto", PROTO)
proto = importlib.util.module_from_spec(spec)
sys.modules["proto"] = proto
spec.loader.exec_module(proto)

B = "/home/dom/Desktop/claude_hackathon/benchmark_systems"


def components(atoms, edges):
    order = {a: k for k, a in enumerate(atoms)}
    parent = list(range(len(atoms)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    n_edges = 0
    for i, j in edges:
        if i in order and j in order:
            n_edges += 1
            a, b = find(order[i]), find(order[j])
            if a != b:
                parent[a] = b
    n_comp = len({find(k) for k in range(len(atoms))})
    return n_comp, n_edges, n_edges - len(atoms) + n_comp


def cmp(label, top, xyz):
    mine = infer_bonds(top, xyz)
    theirs = set(proto.infer(top, xyz))
    same = set(mine.pairs) == theirs
    print(f"  {label:<34} mine={mine.added:<7} proto={len(theirs):<7} SAME={same} "
          f"intra={mine.intra} link={mine.linkage} xlink={mine.crosslink} "
          f"hdrop={mine.hydrogen_candidates_dropped} {mine.elapsed_s:.2f}s")
    if not same:
        print(f"      mine-only {sorted(set(mine.pairs) - theirs)[:6]}")
        print(f"      proto-only {sorted(theirs - set(mine.pairs))[:6]}")
    return same


ok = True
print("### BACD vs authoritative PSF")
t = md.load(f"{B}/BACD_ion.pdb")
top = t.topology
pdb_pairs = {(min(a.index, b.index), max(a.index, b.index)) for a, b in top.bonds}
psf_pairs = {(min(a.index, b.index), max(a.index, b.index))
             for a, b in md.load_topology(f"{B}/BACD_ion.psf").bonds}
res = infer_bonds(top, t.xyz[0])
extra = psf_pairs - pdb_pairs
print(f"  inferred={res.added} PSF-only={len(extra)} EQUAL={set(res.pairs) == extra} "
      f"falsepos={len(set(res.pairs) - psf_pairs)} miss={len(extra - set(res.pairs))} "
      f"intra={res.intra} link={res.linkage} xlink={res.crosslink}")
ok &= set(res.pairs) == extra and res.added == 82
ok &= cmp("BACD_ion.pdb", top, t.xyz[0])

print("\n### membrane")
t = md.load(f"{B}/systems/06_membrane_complex/files/membrane.pdb")
top = t.topology
t0 = time.perf_counter()
res = infer_bonds(top, t.xyz[0])
el = time.perf_counter() - t0
base = {(min(a.index, b.index), max(a.index, b.index)) for a, b in top.bonds}
dmpc = [a.index for a in top.atoms if a.residue.name == "DMPC"]
nc, ne, rings = components(dmpc, base | set(res.pairs))
xr = sum(1 for i, j in res.pairs if top.atom(i).residue.index != top.atom(j).residue.index)
print(f"  +{res.added} in {el:.2f}s (infer {res.elapsed_s:.2f}s) cross-residue={xr} "
      f"edges {len(base)} -> {len(base) + res.added}")
print(f"  DMPC: {nc} comp (want 482) {ne} bonds (want 56394) {rings} rings (want 0)")
ok &= (res.added == 123476 and xr == 0 and nc == 482 and ne == 56394 and rings == 0)
ok &= cmp("membrane.pdb", top, t.xyz[0])
res_ns = infer_bonds(top, t.xyz[0], "nonsolvent")
print(f"  nonsolvent: +{res_ns.added} (intra={res_ns.intra} link={res_ns.linkage} "
      f"xlink={res_ns.crosslink}) in {res_ns.elapsed_s:.2f}s")
print(f"  off:        +{infer_bonds(top, t.xyz[0], 'off').added}")
print("  --- NEGATIVE CONTROL: unscoped global search ---")
t0 = time.perf_counter()
un = infer_bonds_unscoped(top, t.xyz[0])
nc_u, ne_u, rings_u = components(dmpc, base | set(un))
print(f"  unscoped +{len(un)} in {time.perf_counter()-t0:.1f}s -> DMPC {nc_u} comp, "
      f"{ne_u} bonds, {rings_u} rings")

print("\n### crystal / AF structures")
for label, path in [("10GJ.cif", f"{B}/10GJ.cif"),
                    ("09 system.pdb", f"{B}/systems/09_nucleic_duplex/files/system.pdb"),
                    ("AF cif", f"{B}/fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")]:
    t = md.load(path)
    top = t.topology
    if top.n_bonds == 0:
        top.create_standard_bonds()
    ok &= cmp(label, top, t.xyz[0])

print("\n### corpus")
for d in sorted(glob.glob(f"{B}/systems/*")):
    cands = [p for e in (".pdb", ".gro") for p in sorted(glob.glob(f"{d}/files/*{e}"))]
    if not cands:
        print(f"  {os.path.basename(d):<26} (no .pdb/.gro — empty files/)")
        continue
    t = md.load(cands[0])
    top = t.topology
    if top.n_bonds == 0:
        try:
            top.create_standard_bonds()
        except Exception:
            pass
    ok &= cmp(os.path.basename(d), top, t.xyz[0])

print(f"\n{'ALL MATCH PROTOTYPE' if ok else 'DIVERGENCE'}")
raise SystemExit(0 if ok else 1)
