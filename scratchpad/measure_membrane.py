"""Cold-open cost of the 222k-atom membrane through the REAL producer path.

Usage:  <mdbench-python> scratchpad/measure_membrane.py [full|nonsolvent|off]

Reports wall time to build the source (parse + centering + header fields),
the inference time alone when the source exposes it, the final edge count and
peak RSS (ru_maxrss, KiB -> MiB). One process per run so RSS is honest.
"""
from __future__ import annotations

import os
import resource
import sys
import time
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from producer.corpus import resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else None

spec = resolve_system("06_membrane_complex")
top = spec["topology"]
traj = os.path.join(spec["dir"], "files/membrane.dcd")

kwargs = {}
if mode is not None:
    kwargs["infer_bonds"] = mode

t0 = time.perf_counter()
src = MdtrajSource(top, traj, spec["name"], spec["ligand_residues"], **kwargs)
t1 = time.perf_counter()
header = src.give_header()
t2 = time.perf_counter()

from contract.contract import header_to_json  # noqa: E402

t3 = time.perf_counter()
wire = header_to_json(header).encode("utf-8")
t4 = time.perf_counter()

rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
report = getattr(src, "bond_inference", None)
print(f"  header JSON      {len(wire) / 1e6:7.3f} MB  (serialize {t4 - t3:.3f} s)")
print(f"mode={mode!r}")
print(f"  build_source     {t1 - t0:7.3f} s")
print(f"  give_header      {t2 - t1:7.3f} s")
print(f"  n_points         {header.n_points}")
print(f"  n_frames         {header.n_frames}")
print(f"  edges            {len(header.edges)}")
print(f"  polylines        {len(header.polylines)}")
print(f"  peak RSS         {rss:8.1f} MiB")
if report is not None:
    print(f"  inference        {report.elapsed_s:7.3f} s  "
          f"added={report.added} intra={report.intra} linkage={report.linkage} "
          f"crosslink={report.crosslink} hdrop={report.hydrogen_candidates_dropped} "
          f"kept_after_pbc={src.inferred_edges_kept}")
for line in header.provenance:
    print(f"  provenance: {line}")
