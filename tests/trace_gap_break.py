"""Correctness gate for the backbone-trace GAP BREAK.

A backbone trace polyline must not bridge a real chain discontinuity (missing /
unmodelled residues): one straight segment drawn across the gap asserts a
continuity that does not exist. ``MdtrajSource._polylines`` now splits a group's
anchor run into multiple polylines wherever a SPATIAL gap sits between
consecutive residues — their frame-0 anchor-anchor distance exceeds
``TRACE_GAP_BREAK_NM`` (1.0 nm).

Why distance ALONE and not a resSeq numbering test: a renumbered / MD-prepped
file routinely drops residues WITHOUT leaving a numbering jump, and that
renumbered gap is the exact false-bridge this fix targets — a resSeq-primary
rule would miss it (the ``consecutive-resSeq-but-FAR`` case below). Conversely a
resSeq jump whose anchors are still bonded (insertion codes, engineered
renumbering) is NOT a gap and must not split (the ``non-consecutive-but-CLOSE``
case). A continuous backbone anchor step is covalently bounded (<=0.73 nm,
nucleic P-P being the measured max), so >1.0 nm is unambiguously a break.

This test proves, on the REAL producer path, every arm of the rule:
  * SPLIT where it must — 5DZT.cif chain A (5 crystallographic gaps -> 6
    polylines), plus the fabricated consecutive-resSeq-but-FAR gap the previous
    resSeq-AND rule missed;
  * NOT split where it must not — every gap-free corpus system is byte-identical
    to the pre-fix "one polyline per group" reference (1b0c, trpcage, adk, the
    nucleic duplex whose P-P runs ~0.73 nm, and the 8-protein membrane which is
    already grouped one-protein-per-group so nothing bridges), plus the
    fabricated non-consecutive-resSeq-but-CLOSE (insertion-code-like) pair;
  * DROP a justified singleton (len>=2 rule);
  * be STABLE across the coordinate frame — the gap distance is
    centering-invariant on real ON-centered data (09), and resident vs streaming
    split identically on a gapped structure.

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


def _ca_traj(resseqs, coords_per_frame) -> md.Trajectory:
    """A CA-only poly-ALA trajectory: one chain, one CA per residue at the given
    resSeqs, coordinates (F, len(resseqs), 3) in nm. is_protein=True so CA is the
    trace anchor."""
    top = md.Topology()
    chain = top.add_chain()
    for rsq in resseqs:
        res = top.add_residue("ALA", chain, resSeq=int(rsq))
        top.add_atom("CA", md.element.carbon, res)
    return md.Trajectory(np.asarray(coords_per_frame, dtype=np.float32), top)


def _single_frame_source(tmp, resseqs, coords) -> MdtrajSource:
    """Resident single-frame source from a fabricated CA-only structure."""
    pdb = os.path.join(tmp, "syn.pdb")
    _ca_traj(resseqs, [coords]).save_pdb(pdb)
    return MdtrajSource(topology_path=pdb, name="syn")


# ---- checks -----------------------------------------------------------------

def check_5dzt() -> tuple:
    checks = []
    src = _cif_source("5DZT.cif")
    pls = src.polylines
    rs = _resseq_of(src)

    checks.append(("6 polylines (5 gaps -> 6 segments)", len(pls) == 6,
                   f"got {len(pls)} (lens {[len(p) for p in pls]})"))
    bounds = [(rs[pls[i][-1]], rs[pls[i + 1][0]]) for i in range(len(pls) - 1)] if len(pls) == 6 else []
    want = [(161, 178), (400, 455), (772, 787), (861, 871), (885, 897)]
    checks.append(("split at the 5 crystallographic gaps", bounds == want, f"{bounds}"))
    bad = [(rs[a], rs[b]) for p in pls for a, b in zip(p, p[1:]) if rs[b] != rs[a] + 1]
    checks.append(("no bridging anchors adjacent within a polyline", not bad, f"violations={bad}"))
    ref = _unsplit_reference(src)
    new_total, ref_total = sum(len(p) for p in pls), sum(len(p) for p in ref)
    checks.append(("no anchor dropped (886 preserved, none stranded)",
                   new_total == ref_total == 886, f"new={new_total} ref={ref_total}"))
    checks.append(("anchor order preserved across the split",
                   [i for p in pls for i in p] == [i for p in ref for i in p],
                   "flattened split == flattened reference"))
    return all(c[1] for c in checks), checks


def check_continuous(expect_lens: list, loader) -> tuple:
    """A gap-free system must be byte-identical to the pre-fix reference."""
    checks = []
    src = loader()
    pls = src.polylines
    ref = _unsplit_reference(src)
    checks.append(("polylines == pre-fix reference (no spurious split)",
                   pls == ref, f"got lens {[len(p) for p in pls]}, ref lens {[len(p) for p in ref]}"))
    checks.append((f"polyline lengths {expect_lens}",
                   sorted(len(p) for p in pls) == sorted(expect_lens),
                   f"got {sorted(len(p) for p in pls)}"))
    return all(c[1] for c in checks), checks


def check_consecutive_far() -> tuple:
    """ADVERSARIAL (the class resSeq-AND missed): anchors numbered 1..4 with a
    >1.0 nm jump between the CONSECUTIVELY-numbered residues 2 and 3 — a
    renumbered real gap. Distance-only MUST split it."""
    checks = []
    with tempfile.TemporaryDirectory() as tmp:
        coords = [(0, 0, 0), (0.38, 0, 0), (3.38, 0, 0), (3.76, 0, 0)]  # gap 2->3 is 3.0 nm
        src = _single_frame_source(tmp, [1, 2, 3, 4], coords)
        pls = src.polylines
        rs = _resseq_of(src)
    lens = sorted(len(p) for p in pls)
    seqs = sorted(rs[a] for p in pls for a in p)
    checks.append(("resSeq is consecutive 1..4 (no numbering jump)", seqs == [1, 2, 3, 4], f"loaded resSeq {seqs}"))
    checks.append(("SPLITS on distance despite consecutive numbering", len(pls) == 2, f"got {len(pls)}"))
    checks.append(("into [1,2] and [3,4]",
                   lens == [2, 2] and len(pls) == 2 and {rs[pls[0][0]], rs[pls[0][-1]]} == {1, 2},
                   f"lens {lens}"))
    return all(c[1] for c in checks), checks


def check_nonconsec_close() -> tuple:
    """ADVERSARIAL (must-not-split): a resSeq NUMBERING jump (2 -> 5) whose anchors
    are still bonded (~0.38 nm apart) — insertion-code-like renumbering, NOT a
    gap. Distance-only must NOT split it (a resSeq-jump rule wrongly would)."""
    checks = []
    with tempfile.TemporaryDirectory() as tmp:
        coords = [(0, 0, 0), (0.38, 0, 0), (0.76, 0, 0), (1.14, 0, 0)]  # every step ~0.38 nm
        src = _single_frame_source(tmp, [1, 2, 5, 6], coords)
        pls = src.polylines
        rs = _resseq_of(src)
    seqs = sorted(rs[a] for p in pls for a in p)
    has_jump = any(b != a + 1 for a, b in zip(seqs, seqs[1:]))
    checks.append(("a resSeq numbering jump IS present (2->5)", has_jump, f"resSeq {seqs}"))
    checks.append(("does NOT split (anchors bonded ~0.38 nm)", len(pls) == 1, f"got {len(pls)} polylines"))
    checks.append(("all 4 anchors in one polyline", len(pls) == 1 and len(pls[0]) == 4,
                   f"lens {[len(p) for p in pls]}"))
    return all(c[1] for c in checks), checks


def check_singleton_drop() -> tuple:
    """A middle anchor isolated by a spatial gap on both sides has no segment of
    its own and is dropped (len>=2 rule); the flanking pairs survive."""
    checks = []
    with tempfile.TemporaryDirectory() as tmp:
        coords = [(0, 0, 0), (0.38, 0, 0), (5.0, 0, 0), (10.0, 0, 0), (10.38, 0, 0)]
        src = _single_frame_source(tmp, [1, 2, 50, 100, 101], coords)
        pls = src.polylines
        rs = _resseq_of(src)
    lens = sorted(len(p) for p in pls)
    checks.append(("two surviving polylines", len(pls) == 2, f"got {len(pls)} (lens {lens})"))
    checks.append(("both are pairs (singleton dropped)", lens == [2, 2], f"{lens}"))
    kept = {rs[i] for p in pls for i in p}
    checks.append(("stranded middle anchor dropped", 50 not in kept, f"kept resSeq {sorted(kept)}"))
    return all(c[1] for c in checks), checks


def check_centering_invariance() -> tuple:
    """The gap distance is centering-INVARIANT: on 09_nucleic_duplex (centering ON,
    streaming), consecutive within-strand anchor distances computed on the RAW
    frame-0 (_scan_frame0, what the streaming split reads) equal those on the
    CENTERED served frame-0 (give_frames) — so the split cannot be a wrapping
    artefact."""
    checks = []
    src = _corpus_source("09_nucleic_duplex")
    checks.append(("system is centering-ON and streaming",
                   src._streaming and src.centering.startswith("on"),
                   f"streaming={src._streaming} centering={src.centering[:24]!r}"))
    raw = src._scan_frame0                                             # (N,3) raw
    served = np.frombuffer(src.give_frames(0, 1).positions, dtype="<f4").reshape(-1, 3)  # centered
    max_dd = 0.0
    for poly in src.polylines:                                        # per strand
        for a, b in zip(poly, poly[1:]):
            d_raw = float(np.linalg.norm(raw[a] - raw[b]))
            d_srv = float(np.linalg.norm(served[a] - served[b]))
            max_dd = max(max_dd, abs(d_raw - d_srv))
    checks.append(("raw vs centered anchor-step distance identical (<1e-5 nm)",
                   max_dd < 1e-5, f"max |delta dist| = {max_dd:.2e} nm"))
    return all(c[1] for c in checks), checks


def check_resident_streaming_parity() -> tuple:
    """The streaming distance path splits a real gap identically to the resident
    path. A 3-frame CA-only structure with a >1.0 nm gap (consecutive resSeq 2->3)
    loaded as DCD (streaming) and as multi-model PDB (resident) must yield the
    same polylines, and must split."""
    checks = []
    base = np.array([(0, 0, 0), (0.38, 0, 0), (3.38, 0, 0), (3.76, 0, 0)], dtype=np.float32)
    frames = np.stack([base, base + 0.01, base - 0.01])               # (3,4,3), frame 0 has the gap
    traj = _ca_traj([1, 2, 3, 4], frames)
    with tempfile.TemporaryDirectory() as tmp:
        top_pdb = os.path.join(tmp, "top.pdb")
        dcd = os.path.join(tmp, "traj.dcd")
        multi_pdb = os.path.join(tmp, "multi.pdb")
        traj[0].save_pdb(top_pdb)
        traj.save_dcd(dcd)
        traj.save_pdb(multi_pdb)                                      # multi-model -> resident
        s_stream = MdtrajSource(topology_path=top_pdb, trajectory_path=dcd, name="stream")
        s_resident = MdtrajSource(topology_path=top_pdb, trajectory_path=multi_pdb, name="resident")
        p_stream, p_resident = s_stream.polylines, s_resident.polylines
        streaming = s_stream._streaming
        resident = not s_resident._streaming
    checks.append(("streaming path taken for the DCD (T>=2)", streaming, f"_streaming={streaming}"))
    checks.append(("resident path taken for the multi-model PDB", resident, f"resident={resident}"))
    checks.append(("streaming split the gap (2 polylines)", len(p_stream) == 2, f"got {len(p_stream)}"))
    checks.append(("resident split identically", p_stream == p_resident,
                   f"stream lens {[len(p) for p in p_stream]} vs resident {[len(p) for p in p_resident]}"))
    return all(c[1] for c in checks), checks


def main() -> int:
    total_ok = True
    blocks = [
        ("5DZT.cif chain A (SPLIT, 5 gaps)", check_5dzt),
        ("consecutive-resSeq-but-FAR (SPLIT — resSeq-AND missed this)", check_consecutive_far),
        ("non-consecutive-resSeq-but-CLOSE (NO split — insertion code)", check_nonconsec_close),
        ("1b0c.cif (UNCHANGED, 5 chains)", lambda: check_continuous([56] * 5, lambda: _cif_source("1b0c.cif"))),
        ("02_trpcage_atomistic (UNCHANGED)", lambda: check_continuous([20], lambda: _corpus_source("02_trpcage_atomistic"))),
        ("03_adk_psf_dcd (UNCHANGED)", lambda: check_continuous([214], lambda: _corpus_source("03_adk_psf_dcd"))),
        ("09_nucleic_duplex (UNCHANGED, P-P ~0.73nm)", lambda: check_continuous([12, 12], lambda: _corpus_source("09_nucleic_duplex"))),
        ("06_membrane_complex (UNCHANGED, 8 proteins already grouped apart)",
         lambda: check_continuous([184] * 8, lambda: _corpus_source("06_membrane_complex"))),
        ("synthetic singleton (DROP)", check_singleton_drop),
        ("centering-invariance of the gap distance (09, ON)", check_centering_invariance),
        ("resident vs streaming split parity at a real gap", check_resident_streaming_parity),
    ]
    print(f"TRACE_GAP_BREAK_NM = {TRACE_GAP_BREAK_NM} nm  (rule: split iff frame-0 anchor-anchor dist > threshold)\n")
    for label, fn in blocks:
        try:
            ok, checks = fn()
        except Exception as exc:
            import traceback
            ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {label}")
        for name, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {name:52s} {detail}")
    print(f"\n{'ALL TRACE-GAP CHECKS PASS' if total_ok else 'TRACE-GAP FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
