"""Tests for open-from-file companion resolution (producer/file_resolve.py).

Covers the dependency-free paths (same-basename, single-candidate, no-candidate);
the multi-candidate atom-count path needs mdtraj and is verified against the real
corpus instead. Runs under plain python3:  python3 -m tests.test_file_resolve
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from producer.file_resolve import resolve_open_target  # noqa: E402


def _touch(path: str) -> str:
    with open(path, "w") as f:
        f.write("x")
    return path


def test_structure_opens_standalone() -> None:
    with tempfile.TemporaryDirectory() as d:
        pdb = _touch(os.path.join(d, "mol.pdb"))
        r = resolve_open_target(pdb)
        assert r == {"topology": pdb, "trajectory": None}, r


def test_trajectory_same_basename() -> None:
    with tempfile.TemporaryDirectory() as d:
        top = _touch(os.path.join(d, "run.pdb"))
        _touch(os.path.join(d, "run.gro"))  # lower priority; .pdb should win
        traj = _touch(os.path.join(d, "run.xtc"))
        r = resolve_open_target(traj)
        assert r["topology"] == top and r["trajectory"] == traj, r


def test_trajectory_single_topology_in_folder() -> None:
    # The common 'system.pdb' + 'traj.xtc' layout: one topology, use it.
    with tempfile.TemporaryDirectory() as d:
        top = _touch(os.path.join(d, "system.pdb"))
        traj = _touch(os.path.join(d, "traj.xtc"))
        r = resolve_open_target(traj)
        assert r["topology"] == top and r["trajectory"] == traj, r


def test_trajectory_no_topology_errors_clearly() -> None:
    with tempfile.TemporaryDirectory() as d:
        traj = _touch(os.path.join(d, "traj.xtc"))
        try:
            resolve_open_target(traj)
        except FileNotFoundError as e:
            assert "companion topology" in str(e), str(e)
            return
        raise AssertionError("expected FileNotFoundError for a companion-less trajectory")


def test_missing_file_errors() -> None:
    try:
        resolve_open_target("/no/such/file.xtc")
    except FileNotFoundError:
        return
    raise AssertionError("expected FileNotFoundError for a missing path")


def test_sole_topology_with_WRONG_atom_count_is_refused() -> None:
    """The cluster bug, pinned. A lone topology used to be accepted without any
    check, so one symlink in a directory silently turned a clear atom-count error
    into a WRONG load — measured on a user's machine, 30 trajectories rendered
    against the wrong topology. A readable trajectory whose only candidate
    disagrees must refuse, exactly as it does when several candidates disagree.
    """
    import numpy as np, mdtraj as md
    with tempfile.TemporaryDirectory() as d:
        # a REAL 5-atom trajectory (the mismatch is only detectable if it reads)
        top5 = md.Topology()
        ch = top5.add_chain(); res = top5.add_residue("ALA", ch)
        for i in range(5):
            top5.add_atom(f"C{i}", md.element.carbon, res)
        traj = os.path.join(d, "run.xtc")
        md.Trajectory(np.zeros((2, 5, 3), dtype=np.float32), top5).save_xtc(traj)

        # the ONLY topology beside it has 3 atoms — a genuine disagreement
        top3 = md.Topology()
        ch3 = top3.add_chain(); r3 = top3.add_residue("ALA", ch3)
        for i in range(3):
            top3.add_atom(f"C{i}", md.element.carbon, r3)
        wrong = os.path.join(d, "other.pdb")
        md.Trajectory(np.zeros((1, 3, 3), dtype=np.float32), top3).save_pdb(wrong)

        try:
            r = resolve_open_target(traj)
        except FileNotFoundError as e:
            assert "atom count" in str(e), str(e)
        else:
            raise AssertionError(f"accepted a topology with the wrong atom count: {r}")

        # ...and the SAME layout with a matching count still resolves
        right = os.path.join(d, "other5.pdb")
        md.Trajectory(np.zeros((1, 5, 3), dtype=np.float32), top5).save_pdb(right)
        os.remove(wrong)
        r = resolve_open_target(traj)
        assert r["topology"] == right, r


def main() -> None:
    # DISCOVERED, not listed. This used to be a hand-maintained list, and a test
    # added without also editing the list simply never ran — while the suite
    # cheerfully reported the old count as if it were coverage. That is the same
    # failure as any silent no-op: the number went up and meant nothing.
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    if not tests:
        raise SystemExit("no tests discovered — the discovery rule is broken")
    for t in tests:
        t()
        print(f"ok   {t.__name__}")
    print(f"\n{len(tests)} tests passed")


if __name__ == "__main__":
    main()
