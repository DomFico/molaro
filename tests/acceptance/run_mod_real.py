"""Run ONE mod through the REAL producer on REAL adk; print the reply JSON.
Usage: real_runmod.py <codefile> [channel_name]   (target = whole system)
Used by the cold driver's REAL_PRODUCER mode so a values-LENGTH refusal reaches
the assistant exactly as it would live.
"""
from __future__ import annotations
import io, json, os, struct, sys

VIEWER = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, VIEWER)
sys.path.insert(0, os.path.join(VIEWER, "tests"))
from producer.serve import serve  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402
from reference_mods_corpus import resolve_system  # noqa: E402

code = open(sys.argv[1], encoding="utf-8").read()
chan = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
_SYS = {"trpcage": "02_trpcage_atomistic", "nucleic": "09_nucleic_duplex", "adk": "03_adk_psf_dcd"}
spec = resolve_system(_SYS.get(os.environ.get("COLD_SYSTEM", "adk"), os.environ.get("COLD_SYSTEM", "03_adk_psf_dcd")))
src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
req = {"type": "run_mod", "code": code, "target_indices": [], "timeout_s": 300}
if chan:
    req["channel_name"] = chan
b = json.dumps(req).encode("utf-8")
stdin, stdout = io.BytesIO(struct.pack("<I", len(b)) + b), io.BytesIO()
serve(src, stdin, stdout)
stdout.seek(0)
(n,) = struct.unpack("<I", stdout.read(4))
print(stdout.read(n).decode("utf-8"))
