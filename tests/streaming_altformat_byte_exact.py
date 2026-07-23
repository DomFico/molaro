"""Byte-exact gate for the producer streaming spine on the OTHER streamable
container formats — ``.trr`` and NetCDF (``.nc``/``.ncdf``/``.netcdf``).

The sibling ``tests/streaming_byte_exact.py`` proves per-chunk streaming is
BYTE-IDENTICAL to whole-trajectory centering, but only for the formats that
appear as a manifest ``trajectory.primary`` — in the corpus that is ``.xtc`` and
``.dcd``. Yet ``MdtrajSource._STREAMABLE_EXTS`` also seeks-and-reads ``.trr`` and
NetCDF at runtime (a user opening a ``.trr`` or ``.nc`` file hits the SAME
seek/read path), and those two formats were exercised by NEITHER byte-exact gate
nor the corpus gate. This closes that gap: it drives the SAME check matrix on the
corpus's on-disk ``.trr`` and ``.nc`` variants of representative systems, so the
seek path — not just the resident fallback — is proven byte-exact on every format
the producer will actually stream.

It reuses ``streaming_byte_exact.check_streaming_spec`` verbatim (ONE source of
truth for the check set: count=1 per-frame, count=7 boundary-crosser, count=T
whole, misaligned interior start, tail, re-seek determinism, plus the streaming
verdict-string pin), pointing it at each system's alternate-format trajectory —
resolved from the manifest's ``trajectory.formats`` map, alongside that system's
own primary topology. Every covered system is asserted to take the streaming
path (``_streaming is True``), so this tests the on-disk seek/read, not a
resident copy.

Coverage spans both centering branches on both alternate formats:
  * 01_alanine_dipeptide  (centering ON)  .trr + NetCDF
  * 02_trpcage_atomistic  (centering ON)  .trr + NetCDF
  * 03_adk_psf_dcd        (centering OFF) .trr + NetCDF  (raw-stream branch)

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python -m tests.streaming_altformat_byte_exact
"""
from __future__ import annotations

import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mdtraj as md  # noqa: E402

from producer.corpus import resolve_system  # noqa: E402
from tests.streaming_byte_exact import check_streaming_spec  # noqa: E402

# (system id, alternate-format extension). Both alternate streamable formats on
# both centering branches: alanine/trpcage center ON (non-vacuous byte-exact
# against a genuinely-centered golden), adk centers OFF (the raw-stream branch).
ALT_FORMAT_CASES = [
    ("01_alanine_dipeptide", ".trr"),
    ("01_alanine_dipeptide", ".nc"),
    ("02_trpcage_atomistic", ".trr"),
    ("02_trpcage_atomistic", ".nc"),
    ("03_adk_psf_dcd", ".trr"),
    ("03_adk_psf_dcd", ".nc"),
]


def altformat_spec(sid: str, ext: str):
    """Resolve a system, then swap its trajectory for the manifest's declared
    alternate-format file (keeping that system's own primary topology + ligand
    overrides). Returns a spec shaped exactly like ``resolve_system``'s output so
    ``check_streaming_spec`` consumes it unchanged."""
    base = resolve_system(sid)
    formats = base["manifest"]["trajectory"].get("formats", {})
    rel = formats.get(ext)
    if not rel:
        raise FileNotFoundError(
            f"{sid}: manifest declares no {ext} alternate format (has {sorted(formats)})"
        )
    traj = os.path.join(base["dir"], rel)
    if not os.path.exists(traj):
        raise FileNotFoundError(f"{sid}: declared {ext} file missing on disk: {traj}")
    spec = dict(base)
    spec["trajectory"] = traj
    spec["name"] = f"{sid}{ext}"
    return spec


def main() -> int:
    total_ok = True
    for sid, ext in ALT_FORMAT_CASES:
        label = f"{sid} [{ext}]"
        try:
            spec = altformat_spec(sid, ext)
            # Guard the file genuinely seeks-and-streams (multi-frame, seekable),
            # so this exercises the on-disk seek path, not the resident fallback.
            with md.open(spec["trajectory"]) as fh:
                if len(fh) < 2:
                    raise AssertionError(
                        f"{label}: only {len(fh)} frame(s) — would not stream"
                    )
            ok, checks = check_streaming_spec(spec)
        except Exception as exc:
            import traceback
            ok, checks = False, [("exception", False,
                                  f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
        total_ok = total_ok and ok
        print(f"[{'PASS' if ok else 'FAIL'}] {label:30s} (STREAM)")
        for clabel, cok, detail in checks:
            print(f"        {'ok  ' if cok else 'FAIL'} {clabel:38s} {detail}")

    print(f"\n{'ALL BYTE-EXACT' if total_ok else 'BYTE-EXACT FAILURES PRESENT'}")
    return 0 if total_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
