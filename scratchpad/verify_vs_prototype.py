"""producer/bond_inference vs THE REFERENCE PROTOTYPE — and where it deliberately
diverges from it.

This used to assert plain equality against a prototype loaded from a session-scoped
temp path, so it was both (a) unrunnable once that scratch was cleaned and (b)
wrong, because the shipped module has since diverged on purpose. Both are fixed:
the prototype is committed next door (scratchpad/reference_prototype.py, verbatim),
and the FOUR divergences are named and asserted rather than papered over.

  1. A HYDROGEN THE FILE ALREADY BONDED gains nothing. The prototype ranked new
     candidates against each other only, so a declared hydrogen could gain a
     SECOND partner: 24 divalent hydrogens, 24 pentavalent carbons and 24
     three-membered C-C-H rings on the corpus membrane, in the default mode.
  2. A MINIMUM BOND LENGTH. The covalent window has no lower bound, so a
     duplicated ATOM record (same name, same coordinates, no altloc) sat at
     distance 0.000 and got bonded to itself — a zero-length edge.
  3. BORON AND SILICON are out of the radii table: they earned zero edges
     anywhere, while boron widened the window on martini beads whose element is
     mdtraj's guess from the name "BB".

Divergences 1-2 REMOVE bonds and are asserted by shape below. Divergence 3 changes
nothing measurable on this evidence base, which is why it was safe.

There is also one RESTORATION, and it is worth naming because it runs the other
way. Scope 3 refuses a pair only when both atoms are in the SAME residue — which
is what the prototype did. The shipped module had tightened that to "residue
indices differ by more than 1", justified as "an i/i+1 pair is scope 2's
business"; since mdtraj numbers residues globally and the linkage scope iterates
per chain and name-gates to (C,N)/(O3',P), that made an inter-CHAIN disulfide and
a vicinal (i,i+1) disulfide reachable by NO scope. The prototype was right and the
implementation had drifted; the last fixture below is the regression test.

    <mdbench-python> scratchpad/verify_vs_prototype.py [path/to/prototype.py]
"""
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

PROTO = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "reference_prototype.py")
if not os.path.exists(PROTO):
    print(f"reference prototype not found at {PROTO}")
    raise SystemExit(2)
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


# The ONLY files on which the shipped module may differ from the prototype, and
# by exactly what. Anything else differing is a regression; a file listed here
# that stops differing means a rule was lost.
EXPECTED_DIVERGENCE = {
    # membrane: the 24 second-bonds the prototype handed to already-bonded
    # PRO hydrogens (rule 1). Nothing else moves. Listed under BOTH labels this
    # file reaches it by (the named pass and the corpus sweep).
    "membrane.pdb": {"mine_only": 0, "proto_only": 24},
    "06_membrane_complex": {"mine_only": 0, "proto_only": 24},
}


def cmp(label, top, xyz):
    mine = infer_bonds(top, xyz)
    theirs = set(proto.infer(top, xyz))
    mine_only = sorted(set(mine.pairs) - theirs)
    proto_only = sorted(theirs - set(mine.pairs))
    want = EXPECTED_DIVERGENCE.get(label, {"mine_only": 0, "proto_only": 0})
    as_designed = (len(mine_only) == want["mine_only"]
                   and len(proto_only) == want["proto_only"])
    verdict = "AS DESIGNED" if as_designed else "UNEXPECTED"
    print(f"  {label:<34} mine={mine.added:<7} proto={len(theirs):<7} {verdict:<11} "
          f"(mine-only {len(mine_only)}, proto-only {len(proto_only)}; want "
          f"{want['mine_only']}/{want['proto_only']}) "
          f"intra={mine.intra} link={mine.linkage} xlink={mine.crosslink} "
          f"hdrop={mine.hydrogen_candidates_dropped} {mine.elapsed_s:.2f}s")
    if not as_designed:
        print(f"      mine-only {mine_only[:6]}")
        print(f"      proto-only {proto_only[:6]}")
    return as_designed


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
ok &= (res.added == 123452 and xr == 0 and nc == 482 and ne == 56394 and rings == 0)
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

# The three behavioural divergences, asserted directly on fixtures the corpus
# cannot supply — so this file states them rather than only tolerating them.
print("\n### the deliberate divergences, on purpose-built fixtures")
top_h = md.Topology()
res_h = top_h.add_residue("PRO", top_h.add_chain())
cg = top_h.add_atom("CG", md.element.carbon, res_h)
cd = top_h.add_atom("CD", md.element.carbon, res_h)
hg = top_h.add_atom("HG2", md.element.hydrogen, res_h)
xyz_h = np.array([[0.0, 0, 0], [0.1481, 0, 0], [0.073294, 0.084023, 0]])
top_h.add_bond(cg, hg)
mine_h = {p for p in infer_bonds(top_h, xyz_h).pairs if hg.index in p}
proto_h = {p for p in proto.infer(top_h, xyz_h) if hg.index in p}
print(f"  1. already-bonded H: mine {sorted(mine_h)} vs prototype {sorted(proto_h)}")
ok &= not mine_h and len(proto_h) == 1

top_d = md.Topology()
res_d = top_d.add_residue("GLY", top_d.add_chain())
for name, el in (("N", md.element.nitrogen), ("CA", md.element.carbon),
                 ("CA", md.element.carbon), ("C", md.element.carbon)):
    top_d.add_atom(name, el, res_d)
xyz_d = np.array([[0.0, 0, 0], [0.145, 0, 0], [0.145, 0, 0], [0.290, 0, 0]])
zero_mine = [p for p in infer_bonds(top_d, xyz_d).pairs
             if np.linalg.norm(xyz_d[p[0]] - xyz_d[p[1]]) < 1e-9]
zero_proto = [p for p in proto.infer(top_d, xyz_d)
              if np.linalg.norm(xyz_d[p[0]] - xyz_d[p[1]]) < 1e-9]
print(f"  2. duplicated ATOM record: mine {zero_mine} vs prototype {zero_proto} "
      f"(zero-length edges)")
ok &= not zero_mine and len(zero_proto) == 1

# two chains, one CYS each, SG facing SG at the MEASURED disulfide length
# (0.20417 nm, from 1b0c chain 4 CYS14.SG-CYS38.SG). Global residue indices 0 and
# 1, which is exactly what the prototype's index gate refused.
SS = 0.20417
top_s = md.Topology()
chain_a = top_s.add_chain()
res_a = top_s.add_residue("CYS", chain_a)
chain_b = top_s.add_chain()
res_b = top_s.add_residue("CYS", chain_b)
for r, names in ((res_a, ("N", "CA", "CB", "SG")), (res_b, ("N", "CA", "CB", "SG"))):
    for nm in names:
        top_s.add_atom(nm, {"N": md.element.nitrogen, "CA": md.element.carbon,
                            "CB": md.element.carbon, "SG": md.element.sulfur}[nm], r)
sg_a = 0.331
sg_b = sg_a + SS
xyz_s = np.array([
    [0.0, 0.0, 0.0], [0.145, 0.0, 0.0], [0.145, 0.150, 0.0], [0.145, sg_a, 0.0],
    [0.0, sg_b + 0.331, 0.0], [0.145, sg_b + 0.331, 0.0],
    [0.145, sg_b + 0.181, 0.0], [0.145, sg_b, 0.0],
])
d_ss = float(np.linalg.norm(xyz_s[3] - xyz_s[7]))
mine_ss = (3, 7) in set(infer_bonds(top_s, xyz_s).pairs)
proto_ss = (3, 7) in set(proto.infer(top_s, xyz_s))
print(f"  RESTORED: inter-chain S-S at {d_ss * 10:.4f} A: "
      f"mine={'FOUND' if mine_ss else 'MISSED'} vs prototype="
      f"{'FOUND' if proto_ss else 'MISSED'} (both must FIND it; the shipped "
      f"residue-index gate at e004bc6 MISSED it)")
ok &= mine_ss and proto_ss

print(f"\n{'PARITY HOLDS, DIVERGENCES ARE THE DESIGNED ONES' if ok else 'UNEXPECTED DIVERGENCE'}")
raise SystemExit(0 if ok else 1)
