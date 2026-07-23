"""Byte-exact gate for the Phase 2a streaming spine.

The decisive check of the producer-streaming refactor: for every SEEKABLE corpus
system, the RAW coordinates ``MdtrajSource.give_frames`` streams from disk must be
BYTE-IDENTICAL (not merely allclose) to the RAW whole-trajectory ``md.load`` — for
every chunking that matters:

  * count = 1              every frame requested on its own
  * count = 7              a chunk size that crosses frame boundaries and does not divide T
  * count = T              the whole trajectory in one request
  * a misaligned start     an odd offset + odd length, and a tail chunk

Because Phase 2a serves the streamed coordinates RAW (no periodic-image centering —
that is Phase 2b), the reference is a plain ``md.load`` with no transform. The
resident systems (single-frame / non-seekable, e.g. the membrane restart and the CG
snapshot) are asserted to take the resident path and to serve their in-RAM ``_xyz``
byte-for-byte — unchanged from before.

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python -m tests.streaming_byte_exact
"""
from __future__ import annotations

import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import mdtraj as md  # noqa: E402

from producer.corpus import resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402

# Every corpus system that has a trajectory. The seekable, multi-frame ones must
# stream; the single-frame / non-seekable ones must stay resident.
SYSTEMS = [
    "01_alanine_dipeptide", "02_trpcage_atomistic", "03_adk_psf_dcd",
    "04_ligand_custom_solvent", "05_macrocycle_disulfide", "06_membrane_complex",
    "07_coarse_grain_martini", "09_nucleic_duplex", "10_tip4p_virtualsites",
]


def _raw_bytes(full_xyz: np.ndarray, start: int, count: int) -> bytes:
    block = np.ascontiguousarray(full_xyz[start : start + count], dtype="<f4")
    return block.tobytes()


def _streamed_bytes(src: MdtrajSource, start: int, count: int) -> bytes:
    return src.give_frames(start, count).positions


def check_streaming_system(sid: str):
    """Return (passed, [(label, ok, detail)]) for one seekable system."""
    spec = resolve_system(sid)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    T = src.n_frames

    # RAW reference: a plain whole-trajectory load, no transform, LE float32.
    full = md.load(spec["trajectory"], top=spec["topology"])
    raw = np.ascontiguousarray(full.xyz, dtype="<f4")

    checks = []
    checks.append(("takes streaming path", src._streaming is True, f"_streaming={src._streaming}"))

    # count = 1 — every frame on its own, concatenated in order.
    got = b"".join(_streamed_bytes(src, i, 1) for i in range(T))
    checks.append(("count=1 (per-frame)", got == raw.tobytes(), f"{len(got)} vs {raw.nbytes} bytes"))

    # count = 7 — a boundary-crossing chunk size that does not divide T.
    parts = []
    start = 0
    while start < T:
        c = min(7, T - start)
        parts.append(_streamed_bytes(src, start, c))
        start += c
    checks.append(("count=7 (boundary-crosser)", b"".join(parts) == raw.tobytes(),
                   f"chunks of 7 over T={T}"))

    # count = T — the whole trajectory in one request.
    whole = _streamed_bytes(src, 0, T)
    checks.append(("count=T (whole)", whole == raw.tobytes(), f"T={T} in one chunk"))

    # misaligned starts — an odd interior offset + odd length, and a tail chunk.
    interior_start, interior_count = 3, min(5, T - 3)
    ok_interior = _streamed_bytes(src, interior_start, interior_count) == _raw_bytes(raw, interior_start, interior_count)
    checks.append((f"misaligned start={interior_start} count={interior_count}", ok_interior, ""))

    tail_count = min(3, T)
    tail_start = T - tail_count
    ok_tail = _streamed_bytes(src, tail_start, tail_count) == _raw_bytes(raw, tail_start, tail_count)
    checks.append((f"tail start={tail_start} count={tail_count}", ok_tail, ""))

    # re-seek determinism — the same frame served in two different chunkings must
    # be byte-identical (proves seek-every-time has no residual state, decision D7).
    single = _streamed_bytes(src, 5, 1) if T > 5 else _streamed_bytes(src, 0, 1)
    idx = 5 if T > 5 else 0
    frame_bytes = src.n_points * 3 * 4
    within = whole[idx * frame_bytes:(idx + 1) * frame_bytes]
    checks.append(("re-seek determinism (frame in two chunkings)", single == within, f"frame {idx}"))

    src.close()
    return all(ok for _, ok, _ in checks), checks


def check_resident_system(sid: str):
    """A single-frame / non-seekable system must NOT stream, and give_frames must
    serve its in-RAM _xyz byte-for-byte (resident path unchanged)."""
    spec = resolve_system(sid)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"])
    T = src.n_frames
    checks = [("takes resident path", src._streaming is False, f"_streaming={src._streaming}")]
    got = _streamed_bytes(src, 0, T)
    want = np.ascontiguousarray(src._xyz, dtype="<f4").tobytes()
    checks.append(("give_frames == resident _xyz", got == want, f"T={T}"))
    return all(ok for _, ok, _ in checks), checks


def main() -> int:
    total_ok = True
    for sid in SYSTEMS:
        spec = resolve_system(sid)
        # decide expected path the same way the source does
        ext = os.path.splitext(spec["trajectory"])[1].lower() if spec["trajectory"] else ""
        streamable = ext in {".dcd", ".xtc", ".trr", ".nc", ".ncdf", ".netcdf"}
        # single-frame seekables still go resident — probe frame count cheaply
        try:
            if streamable:
                with md.open(spec["trajectory"]) as fh:
                    streamable = len(fh) >= 2
        except Exception:
            streamable = False
        try:
            if streamable:
                ok, checks = check_streaming_system(sid)
                kind = "STREAM"
            else:
                ok, checks = check_resident_system(sid)
                kind = "RESIDENT"
        except Exception as exc:
            import traceback
            ok, checks, kind = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")], "?"
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {sid:26s} ({kind})")
        for label, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {label:38s} {detail}")

    print(f"\n{'ALL BYTE-EXACT' if total_ok else 'BYTE-EXACT FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
