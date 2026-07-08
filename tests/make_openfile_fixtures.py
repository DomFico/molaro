"""Generate small fixtures for the open-from-file tests (Increment 4.6).

Emits, into an output directory:
  - structure.pdb        a standalone single-frame structure (opens static)
  - pair.pdb + pair.xtc  a same-stem topology + multi-frame trajectory
                         (companion resolution + playback)
  - orphan/orphan.dcd    a trajectory with NO sibling topology (clear-error case)

Needs mdtraj (the mdbench conda env). Run:
  <mdbench-python> tests/make_openfile_fixtures.py <out_dir>
"""
from __future__ import annotations

import os
import sys

import numpy as np

import mdtraj as md
from mdtraj.core.element import carbon, hydrogen, nitrogen, oxygen


def _build() -> md.Trajectory:
    """A tiny system: a few ALA residues (protein) + some HOH (solvent)."""
    rng = np.random.default_rng(7)
    top = md.Topology()
    xyz = []

    prot = top.add_chain()
    for i in range(4):
        res = top.add_residue("ALA", prot)
        base = np.array([i * 0.38, 0.0, 0.0], dtype=np.float64)
        for name, elem, off in [
            ("N", nitrogen, [0.0, 0.0, 0.0]),
            ("CA", carbon, [0.15, 0.0, 0.0]),
            ("C", carbon, [0.30, 0.0, 0.0]),
            ("O", oxygen, [0.30, 0.12, 0.0]),
            ("CB", carbon, [0.15, 0.15, 0.0]),
        ]:
            top.add_atom(name, elem, res)
            xyz.append(base + off)

    water = top.add_chain()
    for _ in range(30):
        res = top.add_residue("HOH", water)
        base = rng.uniform(-1.0, 1.0, size=3)
        top.add_atom("O", oxygen, res); xyz.append(base)
        top.add_atom("H1", hydrogen, res); xyz.append(base + [0.01, 0.0, 0.0])
        top.add_atom("H2", hydrogen, res); xyz.append(base + [0.0, 0.01, 0.0])

    coords = np.asarray(xyz, dtype=np.float32).reshape(1, -1, 3)
    return md.Trajectory(coords, top)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    base = _build()

    # Standalone single-frame structure.
    base.save_pdb(os.path.join(out, "structure.pdb"))

    # Multi-frame trajectory + same-stem companion topology.
    rng = np.random.default_rng(1)
    frames = 15
    jitter = rng.normal(scale=0.02, size=(frames,) + base.xyz.shape[1:]).astype(np.float32)
    traj = md.Trajectory(base.xyz + jitter, base.topology)
    base.save_pdb(os.path.join(out, "pair.pdb"))
    traj.save_xtc(os.path.join(out, "pair.xtc"))

    # Orphan trajectory alone in a directory (no companion topology to find).
    orphan_dir = os.path.join(out, "orphan")
    os.makedirs(orphan_dir, exist_ok=True)
    traj.save_dcd(os.path.join(orphan_dir, "orphan.dcd"))

    print(
        f"fixtures in {out}: structure.pdb (1 frame), pair.pdb+pair.xtc "
        f"({frames} frames), orphan/orphan.dcd (no companion)"
    )


if __name__ == "__main__":
    main()
