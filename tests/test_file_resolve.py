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


def main() -> None:
    tests = [
        test_structure_opens_standalone,
        test_trajectory_same_basename,
        test_trajectory_single_topology_in_folder,
        test_trajectory_no_topology_errors_clearly,
        test_missing_file_errors,
    ]
    for t in tests:
        t()
        print(f"ok   {t.__name__}")
    print(f"\n{len(tests)} tests passed")


if __name__ == "__main__":
    main()
