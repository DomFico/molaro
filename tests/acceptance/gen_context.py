"""Derive the boot context fields from the REAL header, mirroring extension.ts,
so a cold run on a new system sees that system rather than adk's shape."""
import sys,os,json,warnings; warnings.filterwarnings("ignore")
V=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")); sys.path.insert(0,V); sys.path.insert(0,os.path.join(V,"tests"))
from producer.mdtraj_source import MdtrajSource
from contract.contract import header_to_json
from reference_mods_corpus import resolve_system
CAP=40
for key,sid in (("trpcage","02_trpcage_atomistic"),("nucleic","09_nucleic_duplex"),("adk","03_adk_psf_dcd")):
    sp=resolve_system(sid)
    s=MdtrajSource(sp["topology"],sp["trajectory"],sp["name"],sp["ligand_residues"])
    h=json.loads(header_to_json(s.give_header()))
    present=sorted({h["categories"][c] for c in h["points"]["category"]})
    groups=sorted(set(h["groups"].values()))
    kinds=sorted({v.split()[0] for v in h["subgroups"].values()})
    types=sorted({t for t in h["points"]["type"] if t})
    ctx={"system":key,"nAtoms":h["n_points"],"nFrames":h["n_frames"],
         "categories":present,"groups":groups[:CAP],"subgroupCount":len(h["subgroups"]),
         "subgroupKinds":kinds[:CAP],"subgroupKindsCapped":len(kinds)>CAP,
         "pointTypes":types[:CAP],"pointTypesCapped":len(types)>CAP,
         "targetExamples":["all"]+present,
         "provenance":h["provenance"]}
    open(os.path.join(os.path.dirname(__file__), "contexts", f"ctx_{key}.json"),"w").write(json.dumps(ctx,indent=1))
    print(f"  {key:<8} {ctx['nAtoms']:>6} atoms  cats={present}  groups={groups[:6]}  kinds={len(kinds)}  types={types[:8]}")
