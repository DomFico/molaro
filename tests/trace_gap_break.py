"""Correctness gate for the backbone-trace GAP BREAK.

A backbone trace polyline must not bridge a real chain discontinuity (missing /
unmodelled residues): one straight segment drawn across the gap asserts a
continuity that does not exist. ``MdtrajSource._polylines`` now splits a group's
anchor run into multiple polylines at each gap — a resSeq numbering jump
corroborated by a spatial gap (frame-0 anchor-anchor distance > TRACE_GAP_BREAK_NM).

This test proves, on the REAL producer path (``MdtrajSource`` built from the
corpus files), both halves of the change:

  * SPLIT where it must — ``5DZT.cif`` chain A has 5 crystallographic gaps
    (resSeq 161->178, 400->455, 772->787, 861->871, 885->897), so its single
    886-anchor trace becomes SIX polylines whose internal steps are all +1 (the
    bridging anchors are no longer adjacent within any polyline) and whose anchors
    are all preserved (886 across the six, none dropped);
  * NOT split where it must not — every CONTINUOUS system is byte-identical to
    the pre-fix "one polyline per group" behaviour, reconstructed here as the
    reference. This includes ``1b0c.cif`` (5 protein chains, no gaps),
    ``02_trpcage_atomistic``/``03_adk_psf_dcd`` (single protein chains), and
    crucially ``09_nucleic_duplex`` — nucleic P-P steps run to ~0.73 nm, which a
    naive 0.5 nm distance-only rule would falsely shred; requiring the resSeq
    jump keeps the two strands whole.
  * DROP a justified singleton — a synthetic chain whose middle anchor is
    isolated by a gap on both sides yields two polylines with that lone anchor
    (no segment of its own) dropped, per the len>=2 rule.

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python tests/trace_gap_break.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import mdtraj as md  # noqa: E402

from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.domain_rules import trace_anchor_indices  # noqa: E402
from producer.mdtraj_source import MdtrajSource, TRACE_GAP_BREAK_NM  # noqa: E402


# ---- helpers ----------------------------------------------------------------

def _resseq_of(src) -> dict:
    """global atom index -> residue resSeq, for reading a polyline's endpoints."""
    return {a.index: res.resSeq for res in src._topology.residues for a in res.atoms}


def _unsplit_reference(src) -> list:
    """The PRE-FIX polyline set: one polyline per group threading every trace
    anchor in residue order, len>=2 — no gap test. Continuous systems must match
    this exactly (the fix touches only genuinely gapped groups)."""
    top = src._topology
    group_id, _ = src._grouping()
    by_group: dict = {}
    for res in top.residues:
        g = group_id[next(res.atoms).index]
        by_group.setdefault(g, []).append(res)
    out = []
    for g in sorted(by_group):
        anchors = []
        for res in by_group[g]:
            names = {a.name: a.index for a in res.atoms}
            a = trace_anchor_indices(names, bool(res.is_protein), bool(res.is_nucleic))
            if a is not None:
                anchors.append(a)
        if len(anchors) >= 2:
            out.append(anchors)
    return out


def _cif_source(basename: str) -> MdtrajSource:
    return MdtrajSource(topology_path=os.path.join(corpus_root(), basename), name=basename)


def _corpus_source(sid: str) -> MdtrajSource:
    spec = resolve_system(sid)
    return MdtrajSource(
        topology_path=spec["topology"],
        trajectory_path=spec.get("trajectory"),
        name=spec["name"],
        ligand_residues=spec.get("ligand_residues", ()),
    )


# ---- checks -----------------------------------------------------------------

def check_5dzt() -> tuple:
    """5DZT chain A: 6 polylines split at exactly the 5 gaps; no bridge adjacency;
    no anchor dropped."""
    checks = []
    src = _cif_source("5DZT.cif")
    pls = src.polylines
    rs = _resseq_of(src)

    ok = len(pls) == 6
    checks.append(("6 polylines (5 gaps -> 6 segments)", ok, f"got {len(pls)} (lens {[len(p) for p in pls]})"))

    bounds = [(rs[pls[i][-1]], rs[pls[i + 1][0]]) for i in range(len(pls) - 1)] if len(pls) == 6 else []
    want = [(161, 178), (400, 455), (772, 787), (861, 871), (885, 897)]
    checks.append(("split at the 5 crystallographic gaps", bounds == want, f"{bounds}"))

    # No bridging pair is adjacent within a polyline: every internal step is +1.
    bad = [(rs[a], rs[b]) for p in pls for a, b in zip(p, p[1:]) if rs[b] != rs[a] + 1]
    checks.append(("no bridging anchors adjacent within a polyline", not bad, f"violations={bad}"))

    # Compared with the pre-fix reference: same total anchors, only the 5 bridging
    # segments removed. 5DZT has no stranded singleton, so nothing is dropped.
    ref = _unsplit_reference(src)
    ref_total = sum(len(p) for p in ref)
    new_total = sum(len(p) for p in pls)
    checks.append(("no anchor dropped (886 preserved, none stranded)",
                   new_total == ref_total == 886, f"new={new_total} ref={ref_total}"))
    # Concatenation order is unchanged — only the bridges are cut out.
    checks.append(("anchor order preserved across the split",
                   [i for p in pls for i in p] == [i for p in ref for i in p],
                   "flattened split == flattened reference"))
    return all(c[1] for c in checks), checks


def check_continuous(sid: str, expect_lens: list, loader) -> tuple:
    """A gap-free system must be byte-identical to the pre-fix reference."""
    checks = []
    src = loader(sid)
    pls = src.polylines
    ref = _unsplit_reference(src)
    checks.append((f"polylines == pre-fix reference (no spurious split)",
                   pls == ref, f"got lens {[len(p) for p in pls]}, ref lens {[len(p) for p in ref]}"))
    checks.append((f"polyline lengths {expect_lens}",
                   sorted(len(p) for p in pls) == sorted(expect_lens),
                   f"got {sorted(len(p) for p in pls)}"))
    return all(c[1] for c in checks), checks


def check_singleton_drop() -> tuple:
    """A middle anchor isolated by a gap on both sides has no segment of its own
    and is dropped (len>=2 rule); the flanking pairs survive as two polylines."""
    checks = []
    top = md.Topology()
    chain = top.add_chain()
    resseqs = [1, 2, 50, 100, 101]                 # gaps 2->50 and 50->100
    coords = [(0, 0, 0), (0.38, 0, 0), (5.0, 0, 0), (10.0, 0, 0), (10.38, 0, 0)]  # nm
    for rsq in resseqs:
        res = top.add_residue("ALA", chain, resSeq=rsq)
        top.add_atom("CA", md.element.carbon, res)
    traj = md.Trajectory(np.array([coords], dtype=np.float32), top)
    with tempfile.TemporaryDirectory() as d:
        pdb = os.path.join(d, "singleton.pdb")
        traj.save_pdb(pdb)
        src = MdtrajSource(topology_path=pdb, name="singleton")
        pls = src.polylines
        rs = _resseq_of(src)
    lens = sorted(len(p) for p in pls)
    checks.append(("two surviving polylines", len(pls) == 2, f"got {len(pls)} (lens {lens})"))
    checks.append(("both are pairs (singleton dropped)", lens == [2, 2], f"{lens}"))
    kept = {rs[i] for p in pls for i in p}
    checks.append(("stranded resSeq-50 anchor dropped", 50 not in kept, f"kept resSeq {sorted(kept)}"))
    return all(c[1] for c in checks), checks


def main() -> int:
    total_ok = True
    blocks = [
        ("5DZT.cif chain A (SPLIT)", check_5dzt),
        ("1b0c.cif (UNCHANGED, 5 chains)", lambda: check_continuous("1b0c.cif", [56] * 5, _cif_source)),
        ("02_trpcage_atomistic (UNCHANGED)", lambda: check_continuous("02_trpcage_atomistic", [20], _corpus_source)),
        ("03_adk_psf_dcd (UNCHANGED)", lambda: check_continuous("03_adk_psf_dcd", [214], _corpus_source)),
        ("09_nucleic_duplex (UNCHANGED, P-P ~0.73nm)", lambda: check_continuous("09_nucleic_duplex", [12, 12], _corpus_source)),
        ("synthetic singleton (DROP)", check_singleton_drop),
    ]
    print(f"TRACE_GAP_BREAK_NM = {TRACE_GAP_BREAK_NM} nm\n")
    for label, fn in blocks:
        try:
            ok, checks = fn()
        except Exception as exc:
            import traceback
            ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {label}")
        for name, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {name:48s} {detail}")
    print(f"\n{'ALL TRACE-GAP CHECKS PASS' if total_ok else 'TRACE-GAP FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
