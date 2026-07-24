"""Corpus proof for the initial camera framing (the header bbox the camera aims at).

The camera (webview ``frameCamera``) targets the CENTRE of ``header.bbox``. On the
streaming path the bbox must therefore be taken in the SAME coordinate frame
``give_frames`` serves: when periodic-image centering is ON, ``give_frames`` serves
CENTERED coordinates, so a bbox taken over the RAW startup sweep aims the camera
off into a corner (raw frame ≠ served frame) and, when the solute wraps a
boundary, unions both periodic images and inflates the scene (too zoomed-out).

This test pins two properties, over the real producer path, per corpus system:

  1. FRAMING OFFSET — ``|header.bbox_centre − served_frame0_bbox_centre| / S`` is
     ≈0, where ``S`` is the max bbox side (the webview ``sceneExtent`` the camera
     distance and impostor scale share). It measures how far the camera's aim sits
     from the molecule it actually renders. BEFORE this fix it was ~0.50 for
     ``02_trpcage_atomistic`` and ~0.28 for ``09_nucleic_duplex`` (both ON, solute
     wraps a face) and ~0 for the centering-OFF controls; it must now be ≈0 for
     ALL of them, and stay ≈0 for OFF (raw == served there — nothing changed).

  2. PARITY — for a streamable ON system the streaming ``header.bbox`` equals the
     RESIDENT-path CENTERED bbox to the byte. The resident reference is a whole-
     trajectory ``md.load`` run through the SAME ``_center_on_solute`` the resident
     path uses, min/max'd exactly as ``_build_header_fields`` does. These two
     disagreed silently before the fix (streaming raw vs resident centered); this
     is the parity that was missing.

Additional guards: an ON system's bbox is NOT the raw all-frames bbox (the fix is
active, not vacuous), and an OFF system's bbox IS the raw all-frames bbox (the fix
never touches OFF).

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python -m tests.camera_framing_corpus
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import mdtraj as md  # noqa: E402

from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402

# ON systems (periodic-image centering active) and OFF controls. The two ON
# systems are the ones whose solute wraps a boundary — the worst-case misframing
# before the fix; the historical raw-bbox offsets are recorded for the record.
ON_SYSTEMS = ["02_trpcage_atomistic", "09_nucleic_duplex"]
OFF_SYSTEMS = ["10_tip4p_virtualsites", "06_membrane_complex"]  # streaming OFF, resident OFF
HISTORICAL_RAW_OFFSET = {"02_trpcage_atomistic": 0.50, "09_nucleic_duplex": 0.28}
# The exact path each control must take. A silent resident fallback on a streamable
# ON system would false-green the parity check (resident also builds a centered
# bbox → parity degrades to resident-vs-resident), so the path is PINNED, not just
# printed: tip4p is a seekable multi-frame DCD (streams), the membrane restart is a
# single frame (resident).
OFF_STREAMING = {"10_tip4p_virtualsites": True, "06_membrane_complex": False}

# The framing offset ceiling. The residual (all-frames bbox centre vs frame-0
# bbox centre — a real, tiny difference) is ≤~0.4% across the corpus; the pre-fix
# ON offsets were 50%/28%. 5% cleanly separates fixed from broken with >10x margin
# each way.
OFFSET_TOL = 0.05


def _center(lo, hi) -> np.ndarray:
    return (np.asarray(lo, dtype=float) + np.asarray(hi, dtype=float)) / 2.0


def _bbox_of(xyz_flat: np.ndarray):
    """Min/max of an (M,3) block as the header stores it: float32 reduction then
    Python float per component (mirrors ``_build_header_fields`` / ``_bbox``)."""
    f = np.ascontiguousarray(xyz_flat, dtype="<f4")
    lo = tuple(float(v) for v in f.min(axis=0))
    hi = tuple(float(v) for v in f.max(axis=0))
    return lo, hi


def _scene_S(bmin, bmax) -> float:
    """The webview ``sceneExtent`` scale: the max bbox side (floored at 1e-3)."""
    return float(max((np.asarray(bmax) - np.asarray(bmin)).max(), 1e-3))


def _framing_offset(src: MdtrajSource):
    """(offset, S) for a source: how far the camera's target (header bbox centre)
    sits from the served frame-0 centre, as a fraction of the scene scale S."""
    header = src.give_header()
    bmin = np.asarray(header.bbox.min, dtype=float)
    bmax = np.asarray(header.bbox.max, dtype=float)
    S = _scene_S(bmin, bmax)
    hdr_centre = _center(bmin, bmax)
    pos0 = np.frombuffer(src.give_frames(0, 1).positions, dtype="<f4").reshape(src.n_points, 3)
    f0_centre = _center(pos0.min(axis=0), pos0.max(axis=0))
    return float(np.linalg.norm(hdr_centre - f0_centre) / S), S


def _resident_centered_bbox(spec):
    """The RESIDENT-path CENTERED bbox: a whole-trajectory load run through the
    same ``_center_on_solute`` (a DIFFERENT code path from the streaming per-chunk
    hook), min/max'd exactly as ``_build_header_fields`` does. Returns (lo, hi)."""
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    full = md.load(spec["trajectory"], top=spec["topology"])
    src._center_on_solute(full)  # whole-trajectory centering, in place (no-op if OFF)
    lo, hi = _bbox_of(full.xyz.reshape(-1, 3))
    src.close()
    return lo, hi


def _raw_allframes_bbox(spec):
    """The RAW all-frames bbox (pre-centering) — what the buggy streaming path
    shipped, and what an OFF system legitimately ships."""
    full = md.load(spec["trajectory"], top=spec["topology"])
    return _bbox_of(full.xyz.reshape(-1, 3))


def check_on_system(sid: str):
    checks = []
    spec = resolve_system(sid)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    header = src.give_header()

    on = src.centering.startswith("on")
    checks.append(("verdict is ON", on, f"{src.centering[:34]!r}"))

    # streaming path executed (NOT a silent resident fallback) — otherwise the
    # parity below degrades to resident-vs-resident and false-greens.
    checks.append(("streaming path (not a silent resident fallback)",
                   src._streaming is True, f"_streaming={src._streaming}"))

    # 1. framing offset ≈ 0 (was HISTORICAL_RAW_OFFSET before the fix)
    offset, S = _framing_offset(src)
    was = HISTORICAL_RAW_OFFSET.get(sid, float("nan"))
    checks.append((
        "framing offset ≈ 0",
        offset < OFFSET_TOL,
        f"offset={offset*100:.2f}% (was ~{was*100:.0f}%)  S={S:.3f}  tol={OFFSET_TOL*100:.0f}%",
    ))

    # 2. streaming header.bbox == resident-path CENTERED bbox (byte-exact)
    hdr_lo = tuple(float(v) for v in header.bbox.min)
    hdr_hi = tuple(float(v) for v in header.bbox.max)
    res_lo, res_hi = _resident_centered_bbox(spec)
    parity = (hdr_lo == res_lo and hdr_hi == res_hi)
    dlo = float(np.max(np.abs(np.asarray(hdr_lo) - np.asarray(res_lo))))
    dhi = float(np.max(np.abs(np.asarray(hdr_hi) - np.asarray(res_hi))))
    checks.append((
        "streaming bbox == resident centered bbox (byte-exact)",
        parity, f"Δlo={dlo:.2e} Δhi={dhi:.2e}",
    ))

    # guard: the fix is active, not vacuous — the ON bbox is NOT the raw bbox
    raw_lo, raw_hi = _raw_allframes_bbox(spec)
    not_raw = (hdr_lo != raw_lo or hdr_hi != raw_hi)
    raw_S = _scene_S(raw_lo, raw_hi)
    checks.append((
        "ON bbox differs from the raw all-frames bbox (fix is active)",
        not_raw, f"centered S={S:.3f} vs raw S={raw_S:.3f} (raw inflated {raw_S/S:.2f}x)",
    ))

    src.close()
    return all(ok for _, ok, _ in checks), checks


def check_off_system(sid: str):
    checks = []
    spec = resolve_system(sid)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    header = src.give_header()

    off = src.centering.startswith("off")
    checks.append(("verdict is OFF", off, f"{src.centering[:34]!r}"))

    # pin the transport path (streaming vs resident) so a regression that flips it
    # is caught — tip4p must stream, the membrane restart must stay resident.
    expected_stream = OFF_STREAMING[sid]
    checks.append((f"transport path is {'STREAM' if expected_stream else 'RESIDENT'} (pinned)",
                   src._streaming is expected_stream,
                   f"_streaming={src._streaming} expected={expected_stream}"))

    # framing offset stays ≈ 0 (raw == served, already correct)
    offset, S = _framing_offset(src)
    checks.append(("framing offset stays ≈ 0", offset < OFFSET_TOL,
                   f"offset={offset*100:.2f}%  S={S:.3f}"))

    # guard: an OFF system's bbox IS the raw all-frames bbox (fix never touches OFF)
    hdr_lo = tuple(float(v) for v in header.bbox.min)
    hdr_hi = tuple(float(v) for v in header.bbox.max)
    raw_lo, raw_hi = _raw_allframes_bbox(spec)
    is_raw = (hdr_lo == raw_lo and hdr_hi == raw_hi)
    checks.append(("OFF bbox == raw all-frames bbox (untouched)", is_raw,
                   f"stream={getattr(src, '_streaming', '?')}"))

    src.close()
    return all(ok for _, ok, _ in checks), checks


def check_no_wrappable_groups(source_sid: str = "02_trpcage_atomistic"):
    """Genuinely exercise the ON-WITHOUT-WRAPPABLE-GROUPS branch — the shift-only
    centered-bbox path lifted out of the ``if groups:`` guard, plus the
    ``RuntimeError`` fail-safe — which NO corpus system reaches (every ON corpus
    system has loose solvent groups: 02_trpcage=1508, 09_nucleic=water).

    Construction: strip an ON system down to just its SOLUTE atoms while KEEPING
    the unit cell, so the anchor is the whole system and ``_wrappable_groups`` is
    empty (a solute-only-in-a-box). Materialise it to a temp DCD (+ PDB topology)
    and drive it through the REAL streaming producer. The solute's coordinates are
    unchanged, so it still wraps a boundary (verdict ON) but has nothing to wrap
    around it (no groups) — the exact hole the lifted branch fills."""
    checks = []
    spec = resolve_system(source_sid)
    src0 = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    anchor = src0._solute_indices()
    src0.close()

    full = md.load(spec["trajectory"], top=spec["topology"])
    sliced = full.atom_slice(anchor)  # keeps unitcell_lengths per frame
    checks.append(("stripped to solute-only, unit cell kept",
                   sliced.n_atoms == int(anchor.size) and sliced.unitcell_lengths is not None,
                   f"nA={sliced.n_atoms} nF={sliced.n_frames} unitcell={sliced.unitcell_lengths is not None}"))

    tmpdir = tempfile.mkdtemp(prefix="molaro_nogroups_")
    try:
        top_path = os.path.join(tmpdir, "solute.pdb")
        traj_path = os.path.join(tmpdir, "solute.dcd")
        sliced[0].save_pdb(top_path)
        sliced.save_dcd(traj_path)

        # Construction must NOT raise: the RuntimeError guard fires only if an ON
        # verdict yielded no centered bbox — precisely the hole this branch closes.
        try:
            src = MdtrajSource(top_path, traj_path, "solute_only_in_box")
            guard_ok, guard_detail = True, "constructed (ON-no-bbox guard did NOT fire)"
        except RuntimeError as exc:
            src, guard_ok, guard_detail = None, False, f"RuntimeError fired: {exc}"
        checks.append(("construction succeeds (RuntimeError fail-safe did NOT fire)", guard_ok, guard_detail))
        if src is None:
            return False, checks

        checks.append(("verdict is ON", src.centering.startswith("on"), f"{src.centering[:40]!r}"))
        n_groups = len(src._center_wrappable_groups)
        checks.append(("wrappable groups is EMPTY (the untested branch)", n_groups == 0, f"groups={n_groups}"))
        checks.append(("streaming path", src._streaming is True, f"_streaming={src._streaming}"))
        checks.append(("centered bbox is finite (shift-only branch produced it)",
                       bool(np.all(np.isfinite(src._bbox_lo)) and np.all(np.isfinite(src._bbox_hi))),
                       f"lo={tuple(round(float(v), 3) for v in src._bbox_lo)}"))

        # Parity: streaming centered bbox == resident centered bbox (shift-only,
        # no wrap) — byte-exact, the same property the corpus ON systems assert.
        header = src.give_header()
        hdr_lo = tuple(float(v) for v in header.bbox.min)
        hdr_hi = tuple(float(v) for v in header.bbox.max)
        res_lo, res_hi = _resident_centered_bbox(
            {"topology": top_path, "trajectory": traj_path,
             "name": "solute_only_ref", "ligand_residues": []})
        parity = (hdr_lo == res_lo and hdr_hi == res_hi)
        dlo = float(np.max(np.abs(np.asarray(hdr_lo) - np.asarray(res_lo))))
        dhi = float(np.max(np.abs(np.asarray(hdr_hi) - np.asarray(res_hi))))
        checks.append(("streaming bbox == resident centered bbox (shift-only, byte-exact)",
                       parity, f"Δlo={dlo:.2e} Δhi={dhi:.2e}"))

        # And the whole point: the camera now frames it (offset ≈ 0).
        offset, S = _framing_offset(src)
        checks.append(("framing offset ≈ 0", offset < OFFSET_TOL, f"offset={offset*100:.2f}% S={S:.3f}"))
        src.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return all(ok for _, ok, _ in checks), checks


def main() -> int:
    print(f"corpus root: {corpus_root()}   framing offset tol: {OFFSET_TOL*100:.0f}%\n")
    total_ok = True

    print("--- ON systems (centering active; solute wraps → worst-case misframing before fix) ---")
    for sid in ON_SYSTEMS:
        try:
            ok, checks = check_on_system(sid)
        except Exception as exc:
            import traceback
            ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {sid}")
        for label, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {label:52s} {detail}")

    print("\n--- OFF controls (raw == served; must be untouched) ---")
    for sid in OFF_SYSTEMS:
        try:
            ok, checks = check_off_system(sid)
        except Exception as exc:
            import traceback
            ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {sid}")
        for label, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {label:52s} {detail}")

    print("\n--- ON-without-wrappable-groups (solute-only-in-a-box; no corpus system hits it) ---")
    try:
        ok, checks = check_no_wrappable_groups()
    except Exception as exc:
        import traceback
        ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
    total_ok = total_ok and ok
    print(f"[{'PASS' if ok else 'FAIL'}] solute-only trpcage (stripped)")
    for label, cok, detail in checks:
        print(f"        {'ok  ' if cok else 'FAIL'} {label:52s} {detail}")

    print(f"\n{'ALL PASS' if total_ok else 'FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
