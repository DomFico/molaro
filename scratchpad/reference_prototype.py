"""THE REFERENCE PROTOTYPE — the design producer/bond_inference.py was built from.

Committed VERBATIM, and committed at all because the parity script next door
(verify_vs_prototype.py) used to load it from a session-scoped temp path. Evidence
with an ephemeral dependency stops being evidence the moment the scratch is
cleaned: "my implementation reproduces the validated design" would have become
permanently unfalsifiable. It is 6 KB.

This is a HISTORICAL artefact, not a spec. It is deliberately NOT kept in sync,
and the shipped module has since diverged from it in four measured ways —
verify_vs_prototype.py names each one and asserts the divergence rather than
asserting equality. Do not "fix" this file to match; that would destroy the only
record of what the numbers in the original brief were produced by.

The one edit made on commit is the sys.path line below, which pointed at an
absolute checkout.
"""
import sys, os, glob, time, collections
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import numpy as np, mdtraj as md
from scipy.spatial import cKDTree
from producer.domain_rules import SOLVENT_RESIDUES
R={"H":0.031,"C":0.076,"N":0.071,"O":0.066,"P":0.107,"S":0.105,"F":0.057,
   "CL":0.102,"BR":0.120,"I":0.139,"SE":0.120,"B":0.084,"SI":0.111}
DEF=0.077; SCALE=1.2
LINKS=[("C","N"),("O3'","P"),("O3*","P")]
XLINK={"S","SE"}

def infer(top,xyz,xlink=True):
    n=top.n_atoms; sym=[]; excl=np.zeros(n,bool)
    for a in top.atoms:
        s=(a.element.symbol if a.element is not None else "C").upper(); sym.append(s)
        if a.residue.n_atoms==1 or a.element is None or s=="VS": excl[a.index]=True
    rad=np.array([R.get(s,DEF) for s in sym]); is_h=np.array([s=="H" for s in sym])
    have={(min(a.index,b.index),max(a.index,b.index)) for a,b in top.bonds}
    cand=[]
    for res in top.residues:                       # scope 1: intra-residue
        idx=np.array([a.index for a in res.atoms]); idx=idx[~excl[idx]]
        if len(idx)<2: continue
        sub=xyz[idx]
        if len(idx)>200:
            pr=cKDTree(sub).query_pairs(2*float(rad[idx].max())*SCALE,output_type="ndarray")
            if len(pr)==0: continue
            gi,gj=idx[pr[:,0]],idx[pr[:,1]]
        else:
            a_,b_=np.triu_indices(len(idx),1); gi,gj=idx[a_],idx[b_]
        d=np.linalg.norm(xyz[gi]-xyz[gj],axis=1)
        ok=(d<=(rad[gi]+rad[gj])*SCALE)&~(is_h[gi]&is_h[gj])
        cand.extend(zip(gi[ok].tolist(),gj[ok].tolist(),d[ok].tolist()))
    for ch in top.chains:                          # scope 2: adjacent backbone linkage
        rs=list(ch.residues)
        for r1,r2 in zip(rs,rs[1:]):
            m1={a.name:a.index for a in r1.atoms}; m2={a.name:a.index for a in r2.atoms}
            for t,h in LINKS:
                if t in m1 and h in m2:
                    i,j=m1[t],m2[h]
                    if excl[i] or excl[j]: continue
                    d=float(np.linalg.norm(xyz[i]-xyz[j]))
                    if d<=(rad[i]+rad[j])*SCALE: cand.append((i,j,d))
    if xlink:                                      # scope 3: S/Se crosslinks
        keep=lambda a: (not excl[a.index] and a.residue.name.upper() not in SOLVENT_RESIDUES)
        sidx=[a.index for a in top.atoms if sym[a.index] in XLINK and keep(a)]
        heavy=np.array([a.index for a in top.atoms if not is_h[a.index] and keep(a)])
        if sidx and len(heavy):
            tr=cKDTree(xyz[heavy]); rmax=(0.105+max(R.values()))*SCALE
            for i in sidx:
                for k in tr.query_ball_point(xyz[i],rmax):
                    j=int(heavy[k])
                    if j==i or top.atom(i).residue.index==top.atom(j).residue.index: continue
                    d=float(np.linalg.norm(xyz[i]-xyz[j]))
                    if d<=(rad[i]+rad[j])*SCALE: cand.append((min(i,j),max(i,j),d))
    hbest={}; out=[]
    for i,j,d in cand:
        k=(min(i,j),max(i,j))
        if k in have: continue
        h=i if is_h[i] else (j if is_h[j] else None)
        if h is None: out.append(k)
        elif h not in hbest or d<hbest[h][0]: hbest[h]=(d,k)
    out.extend(v[1] for v in hbest.values())
    return sorted(set(out))

def comp(atoms,edges):
    idx={a:k for k,a in enumerate(atoms)}; par=list(range(len(atoms)))
    def f(x):
        while par[x]!=x: par[x]=par[par[x]]; x=par[x]
        return x
    ne=0
    for i,j in edges:
        if i in idx and j in idx:
            ne+=1; A,Bb=f(idx[i]),f(idx[j])
            if A!=Bb: par[A]=Bb
    nc=len({f(k) for k in range(len(atoms))}); return nc,ne,ne-len(atoms)+nc

if __name__=="__main__":
    B="/home/dom/Desktop/claude_hackathon/benchmark_systems"
    print("### PROOF 1: BACD vs authoritative CHARMM PSF")
    t=md.load(f"{B}/BACD_ion.pdb"); top=t.topology
    pdbp={(min(a.index,b.index),max(a.index,b.index)) for a,b in top.bonds}
    psfp={(min(a.index,b.index),max(a.index,b.index)) for a,b in md.load_topology(f"{B}/BACD_ion.psf").bonds}
    inf=set(infer(top,t.xyz[0])); extra=psfp-pdbp
    print(f"  inferred={len(inf)} PSF-only={len(extra)} EQUAL={inf==extra} "
          f"falsepos={len(inf-psfp)} miss={len(extra-inf)}")
    print("\n### PROOF 2: membrane integrity + cost")
    t=md.load(f"{B}/systems/06_membrane_complex/files/membrane.pdb"); top=t.topology
    t0=time.time(); new=infer(top,t.xyz[0]); el=time.time()-t0
    base={(min(a.index,b.index),max(a.index,b.index)) for a,b in top.bonds}
    dm=[a.index for a in top.atoms if a.residue.name=="DMPC"]
    nc,ne,rings=comp(dm,base|set(new))
    xr=sum(1 for i,j in new if top.atom(i).residue.index!=top.atom(j).residue.index)
    print(f"  +{len(new)} bonds in {el:.2f}s  cross-residue={xr}  total edges {len(base)} -> {len(base)+len(new)}")
    print(f"  DMPC: {nc} comp (want 482), {ne} bonds (want 56394), {rings} rings (want 0)")
    print("\n### PROOF 3: user's 4 systems + full corpus regression")
    for label,path in [("10GJ.cif",f"{B}/10GJ.cif"),
                       ("09 nucleic",f"{B}/systems/09_nucleic_duplex/files/system.pdb"),
                       ("AF cif",f"{B}/fold_halm2_hala2_adp_mg_zn_thr42_seed_1_model_1.cif")]:
        t=md.load(path); top=t.topology
        if top.n_bonds==0: top.create_standard_bonds()
        new=infer(top,t.xyz[0]); k=collections.Counter()
        for i,j in new:
            ri,rj=top.atom(i).residue,top.atom(j).residue
            k["intra "+ri.name if ri.index==rj.index else "LINK/XLINK"]+=1
        print(f"  {label:<12} +{len(new):<6} {k.most_common(4)}")
    for d in sorted(glob.glob(f"{B}/systems/*")):
        c=[p for e in (".pdb",".gro") for p in sorted(glob.glob(f"{d}/files/*{e}"))]
        if not c: continue
        t=md.load(c[0]); top=t.topology
        if top.n_bonds==0:
            try: top.create_standard_bonds()
            except Exception: pass
        n_x=len(infer(top,t.xyz[0],True)); n_n=len(infer(top,t.xyz[0],False))
        print(f"  {os.path.basename(d):<26} +{n_x:<7} (crosslink scope contributes {n_x-n_n})")
