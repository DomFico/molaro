"""Re-derive the whole-system `rg_mean` reference for the CENTERED corpus systems.

WHY THIS EXISTS: the producer transforms coordinates at load — it holds the solute
still across periodic-image wraps and re-images the loose molecules around it (see
producer/mdtraj_source.py). Whole-box observables therefore describe different
coordinates than the file on disk, and the stored references had to move with them.
Solute observables did NOT move (measured: the solute is displaced by a pure rigid
translation, spread below one float32 ULP), so `rmsd_to_frame0_mean` and the
dihedral references are untouched and are NOT rewritten here.

THREE RULES THIS SCRIPT EXISTS TO KEEP:

1. BOTH ENGINES, AGREEMENT RE-ASSERTED. A single-engine re-derivation would quietly
   turn the corpus into a self-consistency check. mdtraj and MDAnalysis each compute
   Rg with their own implementation and `_reconcile` re-checks agreement; the stored
   value is their mean and is marked unverified if they disagree.

2. READ WHAT THE VIEWER GETS. Both engines are fed `src._xyz`, the exact block
   `give_frames` streams — not an independently re-wrapped copy. Two wrapping
   implementations that must agree is the defect class this corpus exists to catch.
   The engines stay independent; only the input is deliberately shared. The cost,
   stated plainly: the original oracle had two independent FILE READERS, which could
   catch a unit or endianness bug in either. For `rg_mean` that specific check is
   now gone, because the served array necessarily comes from one reader. The RMSD
   and dihedral references still read the files independently.

3. WRITE BOTH FILES. Each system stores its observables TWICE — manifest.json
   (`reference_observables`, what tests/reference_mods_corpus.py actually reads) and
   reference_values.json. build.py writes both; so must this, or they silently
   disagree.

The corpus tree is not version-controlled, which is why this script is: the numbers
on disk are reproducible from it.

Usage:  python scripts/rederive_rg_references.py [--apply]
"""
import sys,os,json,warnings; warnings.filterwarnings("ignore")
import numpy as np, mdtraj as md, MDAnalysis as mda
V="/home/dom/Desktop/claude_hackathon/viewer"; B="/home/dom/Desktop/claude_hackathon/benchmark_systems"
sys.path.insert(0,V); sys.path.insert(0,os.path.join(V,"tests")); sys.path.insert(0,B)
from producer.mdtraj_source import MdtrajSource
from reference_mods_corpus import SYSTEMS, resolve_system
sys.path.insert(0, os.path.join(B,"_lib"))
from reference_values import canonical_masses, _mdtraj_rg, _mda_rg, _reconcile

APPLY = "--apply" in sys.argv
for sid in SYSTEMS:
    sp=resolve_system(sid)
    src=MdtrajSource(sp["topology"],sp["trajectory"],sp["name"],sp["ligand_residues"])
    if not src.centering.startswith("on"): continue
    served = np.asarray(src._xyz, dtype=np.float32)          # EXACTLY what is streamed
    assert np.array_equal(served, np.ascontiguousarray(src.trajectory.xyz, dtype="<f4")), "one truth broken"

    # engine A: mdtraj, over the served coordinates
    tA = md.Trajectory(served.copy(), src.trajectory.topology)
    masses = canonical_masses(tA)
    # engine B: MDAnalysis, independently read topology, positions replaced by served
    u = mda.Universe(sp["topology"], sp["trajectory"])
    served_A = served * 10.0                                  # nm -> Angstrom
    class _Served:
        def __init__(self, u, xyz): self.u=u; self.xyz=xyz
    frames=[]
    for i, ts in enumerate(u.trajectory):
        ts.positions = served_A[i]
        frames.append(ts.positions.copy())
    u.trajectory[0]
    # feed MDA a memory reader over the served positions so its own loop sees them
    from MDAnalysis.coordinates.memory import MemoryReader
    u2 = mda.Universe(sp["topology"], np.asarray(frames), format=MemoryReader, order="fac")
    a = _mdtraj_rg(tA, masses); b = _mda_rg(u2, masses)
    obs = _reconcile("rg_mean","nm",a,b,1e-5,
        note="mass-weighted; both engines fed canonical_masses(); computed over the PRODUCER-SERVED "
             "coordinates (periodic-image centered, loose molecules re-imaged around the solute)")
    path=os.path.join(B,"systems",sid,"reference_values.json")
    old=json.load(open(path))["rg_mean"]["value"]
    print(f"{sid:<28} old={old:.10f}  new={obs.value:.10f}  Δ={abs(old-obs.value):.3e}")
    print(f"{'':<28} mdtraj={a:.10f}  MDAnalysis={b:.10f}  |Δengines|={abs(a-b):.2e}  agree={obs.agree}")
    if APPLY:
        entry={"value":obs.value,"unit":"nm","engines":["mdtraj","MDAnalysis"],
               "engine_values":{"mdtraj":a,"MDAnalysis":b},"agree_within":1e-5,
               "agree":obs.agree,"verified":obs.verified,"note":obs.note}
        mpath=os.path.join(B,"systems",sid,"manifest.json")
        mj=json.load(open(mpath)); mj["reference_observables"]["rg_mean"]=entry
        json.dump(mj, open(mpath,"w"), indent=1)
        d=json.load(open(path))
        d["rg_mean"]=entry
        json.dump(d, open(path,"w"), indent=1)
        print(f"{'':<28} WRITTEN to manifest.json AND reference_values.json")
