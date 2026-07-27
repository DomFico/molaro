"""Risk sink for the DISPLAY FRAME CAP — a long trajectory loads with a STRIDE.

The producer serves ``n_frames = len(range(0, file_frames, stride))`` instead of
whatever the file holds, so a per_point_per_frame channel (whose size the contract
FIXES at n_frames*n_points*components*4 B) stays bounded however long the run was.
This test is the gate for the two things that can go wrong with that:

  A. THE RULE — ``stride_for_frame_cap`` is pure and its table is pinned, including
     every corpus frame count (all must map to stride 1, which is what makes the
     cap inert on the corpus) and the owner's 15000-frame case.

  B. INERT AT CORPUS SCALE — for every seekable corpus system, a source built with
     the DEFAULT cap and one built with NO cap agree on the serialized HEADER
     BYTES (bbox, edges, polylines, provenance — everything) and on the whole
     coordinate stream, byte for byte. That is the additive-change standard: at
     stride 1 nothing changed, header included.

  C. THE MAPPING — header frame i IS file frame i*stride. Forced strides (2 and 7)
     on real corpus systems must serve bytes IDENTICAL to whole-trajectory
     centering of the same subsampled frames — the reference is
     ``_center_on_solute(md.load(...)[::s])``, a DIFFERENT code path (all frames
     at once, definitional ``[::s]`` slicing) from the per-chunk strided seek under
     test — across chunkings count=1 / 7 / T and a misaligned interior + tail
     chunk. Also pins ``md.load(..., stride=s) == md.load(...)[::s]``, the
     assumption the mod-facing ``trajectory`` property rests on.

  D. ONE FRAME AXIS — the silent-mismatch class this project cares most about: the
     header's ``n_frames``, the frame stream and ``data.trajectory`` must all mean
     the same strided set. Asserted directly (counts equal AND the trajectory's
     coordinates byte-equal to the streamed ones), plus the ``frame_stride`` /
     ``n_frames_in_file`` surface and the provenance disclosure.

  E. COMPOSED SUBSAMPLING — a mod that subsamples FURTHER on a cost budget (the
     corpus of workspace mods has several) must land on real frames. Every 5th
     frame of ``data.trajectory`` must equal file frame k*5*stride, and nothing a
     mod can read must be numbered in the FILE's frame numbering.

  F. THE RESIDENT PATH — a non-seekable multi-frame container (multi-model PDB) has
     no seek to remap, so it strides by slicing the loaded block; that path is
     checked separately, along with "a single-frame input never strides".

Run with the mdbench interpreter + a corpus checkout:
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdbench-python -m tests.frame_stride
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

from contract.contract import header_to_json  # noqa: E402
from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402
from producer.source import DEFAULT_MAX_FRAMES, stride_for_frame_cap  # noqa: E402

# The seekable multi-frame corpus systems (the ones that stream). The resident
# ones are covered by block F's own fixture.
STREAMING_SYSTEMS = [
    "01_alanine_dipeptide", "02_trpcage_atomistic", "03_adk_psf_dcd",
    "04_ligand_custom_solvent", "05_macrocycle_disulfide", "09_nucleic_duplex",
    "10_tip4p_virtualsites",
]
# Every corpus system's frame count, MEASURED 2026-07-26 (`len(md.open(traj))`,
# or 1 for the single-frame restart/snapshot). Pinned here because the choice of
# DEFAULT_MAX_FRAMES rests on them: the cap is only inert if it clears all of them.
CORPUS_FRAME_COUNTS = {
    "01_alanine_dipeptide": 150, "02_trpcage_atomistic": 150, "03_adk_psf_dcd": 98,
    "04_ligand_custom_solvent": 120, "05_macrocycle_disulfide": 150,
    "06_membrane_complex": 1, "07_coarse_grain_martini": 1,
    "09_nucleic_duplex": 120, "10_tip4p_virtualsites": 100,
}
# Strides forced in block C: 2 (the smallest real stride) and 7 (coprime with every
# corpus frame count, so the served count is a ceil and the last file frame is not
# the last frame of the file — the off-by-one trap).
FORCED_STRIDES = (2, 7)


# -- A. the pure rule ----------------------------------------------------------

def check_rule():
    checks = []
    cases = [
        # (file_frames, cap, expected stride, why)
        (15000, 500, 30, "the owner's BACD_rep9.dcd under the default cap"),
        (15001, 500, 31, "ceil, not floor — 30 would serve 501 > cap"),
        (1000, 500, 2, "exactly 2x the cap"),
        (501, 500, 2, "one frame over"),
        (500, 500, 1, "exactly at the cap — no stride"),
        (1, 500, 1, "a single frame"),
        (15000, 0, 1, "cap disabled with 0 — every frame"),
        (15000, -1, 1, "cap disabled with a negative"),
        (15000, None, 1, "cap disabled with None"),
    ]
    for n, cap, want, why in cases:
        got = stride_for_frame_cap(n, cap)
        checks.append((f"stride({n}, cap={cap}) == {want}", got == want, f"got {got} — {why}"))

    # the served count must never exceed the cap, and must be the largest such
    # (i.e. stride-1 would overflow) — swept, not spot-checked.
    bad = []
    for n in list(range(1, 400)) + [499, 500, 501, 999, 1000, 1001, 14999, 15000, 15001, 100000]:
        for cap in (1, 2, 7, 100, 500, 501):
            s = stride_for_frame_cap(n, cap)
            served = len(range(0, n, s))
            if served > cap or (s > 1 and len(range(0, n, s - 1)) <= cap):
                bad.append((n, cap, s, served))
    checks.append(("served count <= cap and stride is the smallest such (swept)",
                   not bad, f"{len(bad)} violations" + (f" e.g. {bad[:3]}" if bad else "")))

    # THE reason 500 was chosen: no corpus system strides.
    strides = {sid: stride_for_frame_cap(T, DEFAULT_MAX_FRAMES)
               for sid, T in CORPUS_FRAME_COUNTS.items()}
    checks.append((f"no corpus system strides at the default cap ({DEFAULT_MAX_FRAMES})",
                   set(strides.values()) == {1},
                   f"longest corpus trajectory {max(CORPUS_FRAME_COUNTS.values())} frames; "
                   f"strides {sorted(set(strides.values()))}"))
    return all(ok for _, ok, _ in checks), checks


# -- B. inert at corpus scale (byte-identity, header included) -----------------

def check_inert(sid: str):
    """Default cap vs NO cap on a real corpus system: identical header BYTES and
    identical coordinate stream. This is the additive-change standard."""
    spec = resolve_system(sid)
    capped = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                          spec["ligand_residues"])                     # default cap
    uncapped = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                            spec["ligand_residues"], max_frames=0)     # no cap at all
    checks = []
    T = capped.n_frames
    checks.append(("measured frame count matches the pinned table",
                   T == CORPUS_FRAME_COUNTS[sid], f"T={T} pinned={CORPUS_FRAME_COUNTS[sid]}"))
    checks.append(("stride is 1 under the default cap", capped.frame_stride == 1,
                   f"stride={capped.frame_stride} cap={DEFAULT_MAX_FRAMES}"))
    checks.append(("n_frames_in_file == n_frames at stride 1",
                   capped.n_frames_in_file == T, f"{capped.n_frames_in_file} vs {T}"))
    checks.append(("frame counts agree with the uncapped source",
                   uncapped.n_frames == T, f"{uncapped.n_frames} vs {T}"))
    hj_capped = header_to_json(capped.give_header())
    hj_uncapped = header_to_json(uncapped.give_header())
    checks.append(("serialized header is byte-identical to no-cap",
                   hj_capped == hj_uncapped,
                   f"{len(hj_capped)} vs {len(hj_uncapped)} chars"))
    checks.append(("provenance carries NO frame-sampling line at stride 1",
                   not any("frame sampling" in p for p in capped.give_header().provenance),
                   f"{len(capped.give_header().provenance)} line(s)"))
    a = b"".join(capped.give_frames(i, 1).positions for i in range(T))
    b = b"".join(uncapped.give_frames(i, 1).positions for i in range(T))
    checks.append(("whole coordinate stream byte-identical to no-cap", a == b,
                   f"{len(a)} bytes"))
    capped.close()
    uncapped.close()
    return all(ok for _, ok, _ in checks), checks


# -- C. the mapping: header frame i == file frame i*stride ---------------------

def _golden_strided(spec, stride: int, ref_src: MdtrajSource):
    """The reference: EVERY stride-th frame of a whole-trajectory load, centered by
    the whole-trajectory ``_center_on_solute`` (a no-op for a centering-OFF system).
    ``[::stride]`` is the definition of the mapping under test, and the centering is
    a different code path from the per-chunk hook."""
    full = md.load(spec["trajectory"], top=spec["topology"])
    sub = full[::stride]
    verdict = ref_src._center_on_solute(sub)
    return np.ascontiguousarray(sub.xyz, dtype="<f4"), verdict


def check_mapping(sid: str, stride: int):
    spec = resolve_system(sid)
    T_file = CORPUS_FRAME_COUNTS[sid]
    # a cap that forces exactly this stride: ceil(T/stride) served frames
    cap = -(-T_file // stride)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], max_frames=cap)
    checks = []
    T = src.n_frames
    checks.append((f"cap {cap} forces stride {stride}", src.frame_stride == stride,
                   f"stride={src.frame_stride} T={T} of {src.n_frames_in_file}"))
    checks.append(("served count == len(range(0, file_frames, stride))",
                   T == len(range(0, T_file, stride)), f"{T} vs {len(range(0, T_file, stride))}"))
    checks.append(("streaming path taken", src._streaming is True, f"_streaming={src._streaming}"))

    gold, gold_verdict = _golden_strided(spec, stride, src)
    checks.append(("centering verdict == whole-trajectory verdict on the same frames",
                   src.centering == gold_verdict, f"{src.centering[:38]!r}"))
    gold_bytes = gold.tobytes()

    # count = 1 — every served frame on its own
    got = b"".join(src.give_frames(i, 1).positions for i in range(T))
    checks.append(("count=1 (per-frame) == golden", got == gold_bytes,
                   f"{len(got)} vs {len(gold_bytes)} bytes"))
    # count = 7 — a chunk size that crosses boundaries and does not divide T
    parts, start = [], 0
    while start < T:
        c = min(7, T - start)
        parts.append(src.give_frames(start, c).positions)
        start += c
    checks.append(("count=7 (boundary-crosser) == golden", b"".join(parts) == gold_bytes,
                   f"chunks of 7 over T={T}"))
    # count = T — one request
    whole = src.give_frames(0, T).positions
    checks.append(("count=T (whole) == golden", whole == gold_bytes, f"T={T}"))
    # misaligned interior + tail: a chunk that never contains frame 0 still lands
    # on the global centering target AND on the right file frames.
    fb = src.n_points * 3 * 4
    i0, c0 = 3, min(5, T - 3)
    checks.append((f"misaligned start={i0} count={c0} == golden",
                   src.give_frames(i0, c0).positions == gold_bytes[i0 * fb:(i0 + c0) * fb], ""))
    tc = min(3, T)
    ts = T - tc
    checks.append((f"tail start={ts} count={tc} == golden (last file frame {(T - 1) * stride})",
                   src.give_frames(ts, tc).positions == gold_bytes[ts * fb:(ts + tc) * fb], ""))

    # the assumption the mod-facing `trajectory` property rests on: mdtraj's own
    # `stride=` load is the same frames as definitional `[::stride]` slicing.
    a = np.ascontiguousarray(md.load(spec["trajectory"], top=spec["topology"],
                                     stride=stride).xyz, dtype="<f4")
    b = np.ascontiguousarray(md.load(spec["trajectory"], top=spec["topology"]).xyz,
                             dtype="<f4")[::stride]
    checks.append(("md.load(stride=s) == md.load()[::s] (byte-exact)",
                   a.tobytes() == b.tobytes(), f"{a.shape} vs {b.shape}"))
    src.close()
    return all(ok for _, ok, _ in checks), checks


# -- D. one frame axis: header == stream == data.trajectory --------------------

def check_one_frame_axis(sid: str, stride: int = 7):
    spec = resolve_system(sid)
    T_file = CORPUS_FRAME_COUNTS[sid]
    cap = -(-T_file // stride)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], max_frames=cap)
    header = src.give_header()
    checks = []
    traj = src.trajectory                       # lazily materialised, STRIDED
    checks.append(("header.n_frames == data.trajectory.n_frames",
                   header.n_frames == traj.n_frames,
                   f"header={header.n_frames} trajectory={traj.n_frames} "
                   f"(file {src.n_frames_in_file}, stride {src.frame_stride})"))
    checks.append(("header.n_points == data.trajectory.n_atoms",
                   header.n_points == traj.n_atoms, f"{header.n_points} vs {traj.n_atoms}"))
    streamed = src.give_frames(0, header.n_frames).positions
    checks.append(("data.trajectory coordinates == the streamed bytes (ONE TRUTH)",
                   np.ascontiguousarray(traj.xyz, dtype="<f4").tobytes() == streamed,
                   f"{len(streamed)} bytes"))
    checks.append(("frame_stride / n_frames_in_file report truthfully",
                   src.frame_stride == stride and src.n_frames_in_file == T_file,
                   f"stride={src.frame_stride} file={src.n_frames_in_file}"))
    prov = [p for p in header.provenance if p.startswith("frame sampling:")]
    named = bool(prov) and str(stride) in prov[0] and str(T_file) in prov[0] \
        and str(header.n_frames) in prov[0]
    checks.append(("provenance names the stride, the served count and the TRUE count",
                   named, prov[0] if prov else "NO frame-sampling line"))
    src.close()
    return all(ok for _, ok, _ in checks), checks


# -- E. a mod's own subsampling composes on top --------------------------------

def check_composed_subsampling(sid: str = "02_trpcage_atomistic", stride: int = 7,
                               mod_every: int = 5):
    """A mod that subsamples further (a cost budget) is subsampling the SERVED set.
    Its every-``mod_every``-th frame must be real frames — file frame
    k*mod_every*stride — and nothing it can read is numbered in the file's frames."""
    spec = resolve_system(sid)
    T_file = CORPUS_FRAME_COUNTS[sid]
    cap = -(-T_file // stride)
    src = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                       spec["ligand_residues"], max_frames=cap)
    header = src.give_header()
    checks = []

    # what the mod sees
    traj = src.trajectory
    n = header.n_frames
    picked = list(range(0, n, mod_every))                 # the mod's own subsample
    sub = np.ascontiguousarray(traj.xyz[::mod_every], dtype="<f4")
    checks.append(("the mod's frame arithmetic is well defined (len == n_frames)",
                   len(traj) == n, f"len(trajectory)={len(traj)} n_frames={n}"))

    # the reference, in FILE frame numbering: file frame k*mod_every*stride
    full = md.load(spec["trajectory"], top=spec["topology"])
    strided = full[::stride]
    src._center_on_solute(strided)                        # same centering, all frames
    want = np.ascontiguousarray(strided.xyz[picked], dtype="<f4")
    file_frames = [k * stride for k in picked]
    checks.append((f"every {mod_every}th SERVED frame == file frames {file_frames[:4]}…",
                   sub.tobytes() == want.tobytes(),
                   f"{len(picked)} frames of {n} served / {T_file} in the file; "
                   f"last file frame {file_frames[-1]}"))
    # the composition, stated EXACTLY: striding by s and then taking every m-th is
    # one frame in s*m of the file — the same set as striding by s*m directly.
    # (ceil(ceil(T/s)/m) == ceil(T/(s*m)) for positive integers, so the counts match
    # too; asserted rather than asserted-in-a-comment.)
    checks.append((f"composition: stride {stride} then every {mod_every}th "
                   f"== 1 frame in {stride * mod_every} of the file, exactly",
                   file_frames == list(range(0, T_file, stride * mod_every)),
                   f"{len(picked)} frames span file 0..{file_frames[-1]}; "
                   f"direct stride {stride * mod_every} would give "
                   f"{len(range(0, T_file, stride * mod_every))}"))
    # nothing a mod reads is in FILE numbering: n_frames, len(trajectory) and the
    # frame stream are all the served count; the file count is reachable ONLY via
    # the explicitly-named surfaces.
    served_counts = {header.n_frames, len(traj),
                     len(src.give_frames(0, n).positions) // (src.n_points * 3 * 4)}
    checks.append(("no mod-visible count is the FILE's frame count",
                   served_counts == {n} and n != T_file,
                   f"served counts {served_counts}, file {T_file}"))
    src.close()
    return all(ok for _, ok, _ in checks), checks


# -- F. the resident path (non-seekable) + single frame -------------------------

def check_resident(sid: str = "02_trpcage_atomistic", stride: int = 8):
    """A multi-model PDB cannot be seeked, so the resident path strides by slicing
    the loaded block. Built from a real corpus system's SOLUTE atoms (small enough
    to write as text, still carrying a unit cell)."""
    checks = []
    spec = resolve_system(sid)
    probe = MdtrajSource(spec["topology"], spec["trajectory"], spec["name"],
                         spec["ligand_residues"])
    anchor = probe._solute_indices()
    probe.close()
    full = md.load(spec["trajectory"], top=spec["topology"]).atom_slice(anchor)
    T_file = full.n_frames
    cap = -(-T_file // stride)

    with tempfile.TemporaryDirectory(prefix="molaro_stride_") as tmp:
        top_pdb = os.path.join(tmp, "top.pdb")
        multi_pdb = os.path.join(tmp, "multi.pdb")
        full[0].save_pdb(top_pdb)
        full.save_pdb(multi_pdb)                          # multi-model -> resident

        src = MdtrajSource(topology_path=top_pdb, trajectory_path=multi_pdb,
                           name="resident_strided", max_frames=cap)
        checks.append(("resident path taken (multi-model PDB is not seekable)",
                       src._streaming is False, f"_streaming={src._streaming}"))
        checks.append((f"cap {cap} forces stride {stride}", src.frame_stride == stride,
                       f"stride={src.frame_stride}"))
        checks.append(("served count == len(range(0, file_frames, stride))",
                       src.n_frames == len(range(0, T_file, stride)),
                       f"{src.n_frames} of {src.n_frames_in_file} (file has {T_file})"))
        # the served block IS the strided one, and _xyz is the served truth
        got = src.give_frames(0, src.n_frames).positions
        checks.append(("give_frames == resident _xyz (path unchanged)",
                       got == np.ascontiguousarray(src._xyz, dtype="<f4").tobytes(),
                       f"{len(got)} bytes"))
        ref = md.load(multi_pdb, top=top_pdb)[::stride]
        src._center_on_solute(ref)
        checks.append(("served bytes == centered every-stride-th frame (golden)",
                       got == np.ascontiguousarray(ref.xyz, dtype="<f4").tobytes(), ""))
        checks.append(("data.trajectory is the SAME strided set",
                       src.trajectory.n_frames == src.n_frames,
                       f"{src.trajectory.n_frames} vs {src.n_frames}"))
        prov = [p for p in src.give_header().provenance if p.startswith("frame sampling:")]
        checks.append(("provenance discloses the resident stride too", bool(prov),
                       prov[0][:96] if prov else "MISSING"))

        # and the common resident case — one frame — never strides
        one = MdtrajSource(topology_path=top_pdb, name="single", max_frames=1)
        checks.append(("a single-frame input never strides (even at cap 1)",
                       one.frame_stride == 1 and one.n_frames == 1,
                       f"stride={one.frame_stride} n_frames={one.n_frames}"))
        checks.append(("a single-frame input carries no frame-sampling line",
                       not any("frame sampling" in p for p in one.give_header().provenance), ""))
    return all(ok for _, ok, _ in checks), checks


def _run(label, fn, *args):
    try:
        ok, checks = fn(*args)
    except Exception as exc:
        import traceback
        ok, checks = False, [("exception", False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}")]
    print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    for name, cok, detail in checks:
        print(f"        {'ok  ' if cok else 'FAIL'} {name:62s} {detail}")
    return ok


def main() -> int:
    print(f"corpus root: {corpus_root()}   DEFAULT_MAX_FRAMES: {DEFAULT_MAX_FRAMES}\n")
    total = True

    print("--- A. the rule (pure) ---")
    total &= _run("stride_for_frame_cap", check_rule)

    print("\n--- B. inert at corpus scale: default cap == NO cap, header bytes included ---")
    for sid in STREAMING_SYSTEMS:
        total &= _run(sid, check_inert, sid)

    print("\n--- C. the mapping: header frame i == file frame i*stride ---")
    for sid in STREAMING_SYSTEMS:
        for s in FORCED_STRIDES:
            total &= _run(f"{sid} @ stride {s}", check_mapping, sid, s)

    print("\n--- D. one frame axis: header == stream == data.trajectory ---")
    for sid in ("02_trpcage_atomistic", "03_adk_psf_dcd", "09_nucleic_duplex"):
        total &= _run(sid, check_one_frame_axis, sid)

    print("\n--- E. a mod's own subsampling composes on top of the stride ---")
    total &= _run("trpcage: stride 7 then every 5th", check_composed_subsampling)

    print("\n--- F. the resident path (non-seekable) + single frame ---")
    total &= _run("multi-model PDB @ stride 8", check_resident)

    print(f"\n{'ALL PASS' if total else 'FAILURES PRESENT'}")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())
