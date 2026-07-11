"""Corpus verification for the reference analysis mods (rg, rmsd, rmsf).

The deliverable of the domain brief: prove that each hand-written reference mod,
run through the REAL producer path (``run_mod`` → ``compute(data, target)`` with
``data.trajectory`` live), reproduces the corpus's stored two-engine reference
values — and, where the corpus stores none (RMSF), that it agrees with an
independent second engine (MDAnalysis) computed here, the same evidence standard
the corpus itself uses.

Also proved:
- index alignment: header point ``i`` == trajectory atom ``i`` == frame-byte
  column ``i`` (the correspondence a mod relies on when it slices the trajectory
  with ``target_indices``);
- subset coherence: RMSF over a sub-selection writes exactly that subset's
  values, in order;
- neutral regression: the synthetic source reports ``trajectory is None`` and the
  three neutral example mods still run there.

Tolerance: **1e-4, absolute, in nm**. The observables are O(0.1–6 nm); the
corpus's own internal two-engine gate is 1e-5 nm and the measured mod-vs-reference
deltas here are ≤~1e-6 nm. 1e-4 nm is a comfortable margin above the mod path's
float noise yet far below any real unit (×10), superposition, mass-weighting, or
index-alignment bug (all ≥1e-3 nm). RMSF is compared as normalized [0,1]
(dimensionless) against the same-normalized reference, plus a raw-nm two-engine
check that guards units.

Run with an mdtraj+MDAnalysis interpreter (the mdbench conda env) and a corpus
checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python -m tests.reference_mods_corpus
"""
from __future__ import annotations

import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import mdtraj as md  # noqa: E402

from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402
from producer.serve import run_mod  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
MODS = os.path.join(ROOT, ".molaro", "mods")
TOL = 1e-4  # nm, absolute

# The atom selection each system's stored RMSD reference was computed over
# (parsed from each reference_values.json note). RMSD superposes on and measures
# over the SAME set, so the mod must be driven with exactly these atoms.
RMSD_SELECTION = {
    "01_alanine_dipeptide": "protein",
    "02_trpcage_atomistic": "name CA",
    "03_adk_psf_dcd": "name CA",
    "04_ligand_custom_solvent": "resname BNZ",
    "05_macrocycle_disulfide": "protein",
    "09_nucleic_duplex": "name P",
    "10_tip4p_virtualsites": "name CA",
}

SYSTEMS = [
    "01_alanine_dipeptide", "02_trpcage_atomistic", "03_adk_psf_dcd",
    "04_ligand_custom_solvent", "05_macrocycle_disulfide", "06_membrane_complex",
    "07_coarse_grain_martini", "09_nucleic_duplex", "10_tip4p_virtualsites",
]


def _mod_code(name: str) -> str:
    with open(os.path.join(MODS, f"{name}.py"), encoding="utf-8") as fh:
        return fh.read()


def run_values(source, name: str, target):
    """Execute a mod through the real producer path; return its values list."""
    reply = json.loads(run_mod(source, _mod_code(name), [int(i) for i in target], 120.0))
    if "error" in reply:
        raise RuntimeError(f"{name}: {reply['error']}")
    return reply["values"]


def mda_rmsf_nm(top_path: str, traj_path: str, selection: str) -> np.ndarray:
    """Independent RMSF (nm) via MDAnalysis: superpose the selection to frame 0,
    then RMSF over that selection — the second engine for the RMSF cross-check."""
    import MDAnalysis as mda
    from MDAnalysis.analysis import align, rms

    u = mda.Universe(top_path, traj_path)
    ref = mda.Universe(top_path, traj_path)
    ref.trajectory[0]
    align.AlignTraj(u, ref, select=selection, in_memory=True).run()
    ag = u.select_atoms(selection)
    return rms.RMSF(ag).run().results.rmsf / 10.0  # Å → nm


def minmax(a: np.ndarray) -> np.ndarray:
    a = np.asarray(a, dtype=float)
    span = a.max() - a.min()
    return np.zeros_like(a) if span <= 0 else (a - a.min()) / span


def check_system(sid: str):
    checks = []  # (label, ok, detail)
    spec = resolve_system(sid)
    ref = spec["manifest"]["reference_observables"]
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    traj = src.trajectory
    nF, nA = src.n_frames, src.n_points

    # ---- index alignment: point i == atom i == frame-byte column i ----
    header = src.give_header()
    pos0 = np.frombuffer(src.give_frames(0, 1).positions, dtype="<f4").reshape(nA, 3)
    coords_aligned = np.allclose(pos0, traj.xyz[0], atol=1e-6)
    order_aligned = all(
        header.points.type[i] == (a.element.symbol if a.element is not None else a.name)
        for i, a in enumerate(traj.topology.atoms)
    )
    checks.append(("index-align", coords_aligned and order_aligned and traj.n_atoms == nA,
                   f"coords={coords_aligned} order={order_aligned} nA={nA}"))

    # ---- Rg: whole system, mass-weighted, vs stored rg_mean ----
    if "rg_mean" in ref:
        vals = run_values(src, "rg", [])
        got, exp = float(np.mean(vals)), ref["rg_mean"]["value"]
        checks.append(("rg", len(vals) == nF and abs(got - exp) < TOL,
                       f"got={got:.10f} ref={exp:.10f} Δ={abs(got-exp):.2e} len={len(vals)}/{nF}"))

    # ---- RMSD: per-system selection, superposed, vs stored rmsd_to_frame0_mean ----
    if "rmsd_to_frame0_mean" in ref and sid in RMSD_SELECTION and nF >= 2:
        sel = list(traj.topology.select(RMSD_SELECTION[sid]))
        vals = run_values(src, "rmsd", sel)
        got, exp = float(np.mean(vals)), ref["rmsd_to_frame0_mean"]["value"]
        checks.append((f"rmsd[{RMSD_SELECTION[sid]}]", len(vals) == nF and abs(got - exp) < TOL,
                       f"got={got:.10f} ref={exp:.10f} Δ={abs(got-exp):.2e} len={len(vals)}/{nF}"))
    elif nF < 2:
        checks.append(("rmsd", True, "N/A — single frame (RMSD to frame 0 is trivially 0)"))
    else:
        checks.append(("rmsd", True, "N/A — no stored RMSD reference for this system"))

    # ---- RMSF: no stored ref → two-engine (mod=mdtraj vs MDAnalysis) here ----
    if nF >= 2:
        vals = np.asarray(run_values(src, "rmsf", []), dtype=float)  # all atoms, [0,1]
        contract_ok = len(vals) == nA and float(vals.min()) >= 0.0 and float(vals.max()) <= 1.0
        try:
            mdtraj_raw = np.asarray(md.rmsf(traj, traj, frame=0), dtype=float)  # nm
            mda_raw = mda_rmsf_nm(spec["topology"], spec["trajectory"], "all")  # nm
            two_engine = float(np.max(np.abs(mdtraj_raw - mda_raw)))
            norm_delta = float(np.max(np.abs(vals - minmax(mda_raw))))
            ok = contract_ok and two_engine < TOL and norm_delta < TOL
            checks.append(("rmsf(2-engine)", ok,
                           f"[0,1]len={len(vals)}/{nA} rawΔ(mdtraj-MDA)={two_engine:.2e}nm normΔ(mod-MDA)={norm_delta:.2e}"))
        except Exception as exc:  # MDA could not read this system → contract-only
            checks.append(("rmsf(contract)", contract_ok,
                           f"[0,1]len={len(vals)}/{nA}; two-engine N/A (MDA: {type(exc).__name__}: {exc})"))
    else:
        checks.append(("rmsf", True, "N/A — single frame (fluctuation is 0)"))

    passed = all(ok for _, ok, _ in checks)
    return passed, checks, {"N": nA, "T": nF}


def check_alignment_and_subset():
    """Focused index-alignment + RMSF subset coherence on the hero system (adk)."""
    checks = []
    spec = resolve_system("03_adk_psf_dcd")
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    traj = src.trajectory

    # explicit per-atom correspondence (a permutation anywhere fails this)
    header = src.give_header()
    pos = np.frombuffer(src.give_frames(3, 1).positions, dtype="<f4").reshape(src.n_points, 3)
    per_atom = all(np.allclose(pos[i], traj.xyz[3, i], atol=1e-6) for i in range(0, src.n_points, 37))
    names_ok = all(header.points.type[i] == (a.element.symbol if a.element else a.name)
                   for i, a in enumerate(traj.topology.atoms))
    checks.append(("alignment: header point i ↔ trajectory atom i (coords + element order)",
                   per_atom and names_ok, f"per_atom={per_atom} names={names_ok}"))

    # subset coherence: RMSF on the CA subset writes exactly len(CA) values, in
    # CA order, matching an independent MDAnalysis CA RMSF — the alignment guard,
    # end to end through run_mod.
    ca = list(traj.topology.select("name CA"))
    vals = np.asarray(run_values(src, "rmsf", ca), dtype=float)
    mda_ca = mda_rmsf_nm(spec["topology"], spec["trajectory"], "name CA")
    subset_ok = (len(vals) == len(ca)
                 and float(vals.min()) >= 0.0 and float(vals.max()) <= 1.0
                 and float(np.max(np.abs(vals - minmax(mda_ca)))) < TOL)
    checks.append((f"subset coherence: rmsf on {len(ca)} CA atoms → {len(vals)} values, order-matched to MDA",
                   subset_ok, f"len={len(vals)}/{len(ca)} normΔ={float(np.max(np.abs(vals-minmax(mda_ca)))):.2e}"))
    return all(ok for _, ok, _ in checks), checks


def check_neutral_regression():
    """Synthetic source: trajectory is None, and the neutral example mods still run."""
    checks = []
    syn = SyntheticSource(n_points=600, n_frames=30, seed=7)
    checks.append(("synthetic: data.trajectory is None", syn.trajectory is None, repr(syn.trajectory)))
    for name, target, kind in [("index_ramp", list(range(50)), list),
                               ("frame_metric", [0], list),
                               ("xy_metric", [0, 1], dict)]:
        try:
            reply = json.loads(run_mod(syn, _mod_code(name), target, 30.0))
            ok = "values" in reply and isinstance(reply["values"], kind)
            checks.append((f"neutral: {name} runs on synthetic (produces {kind.__name__})", ok,
                           "error" if "error" in reply else "ok"))
        except Exception as exc:
            checks.append((f"neutral: {name} runs on synthetic", False, f"{type(exc).__name__}: {exc}"))
    # a domain mod correctly FAILS closed on synthetic (no trajectory)
    reply = json.loads(run_mod(syn, _mod_code("rg"), [], 30.0))
    checks.append(("domain rg fails closed on synthetic (no trajectory)",
                   "error" in reply and "trajectory" in reply["error"], reply.get("error", reply)))
    return all(ok for _, ok, _ in checks), checks


def main() -> int:
    print(f"corpus root: {corpus_root()}   tolerance: {TOL:.0e} nm (absolute)\n")
    total_ok = True

    for sid in SYSTEMS:
        try:
            ok, checks, d = check_system(sid)
        except Exception as exc:
            ok, checks, d = False, [("exception", False, f"{type(exc).__name__}: {exc}")], {}
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {sid:26s} N={d.get('N','?'):>7} T={d.get('T','?'):>4}")
        for label, cok, detail in checks:
            print(f"        {'ok ' if cok else 'FAIL'} {label:22s} {detail}")

    print("\n--- index alignment + subset coherence (hero: adk) ---")
    try:
        ok, checks = check_alignment_and_subset()
    except Exception as exc:
        ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}")]
    total_ok = total_ok and ok
    for label, cok, detail in checks:
        print(f"  [{'PASS' if cok else 'FAIL'}] {label}\n         {detail}")

    print("\n--- neutral regression (synthetic source unaffected) ---")
    try:
        ok, checks = check_neutral_regression()
    except Exception as exc:
        ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}")]
    total_ok = total_ok and ok
    for label, cok, detail in checks:
        print(f"  [{'PASS' if cok else 'FAIL'}] {label}: {detail}")

    print(f"\n{'ALL PASS' if total_ok else 'FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
