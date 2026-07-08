"""Resolve an on-disk file path to a (topology, trajectory) pair to open.

This is the file-open entry point's companion-resolution step (Increment 4.6),
kept in the data-source layer — file-type knowledge belongs here, never in the
renderer. It answers one question: given a path a user opened, what does
MdtrajSource need to read it?

- A **standalone structure** file (carries its own topology + coordinates, e.g.
  ``.pdb``/``.gro``) opens on its own — topology = the file, no trajectory.
- A **trajectory** file (coordinates only, e.g. ``.xtc``/``.dcd``) needs a
  companion topology. We resolve it with a **thin sibling-by-basename match**:
  the same stem beside it with an expected topology extension. If none is found
  we raise a clear error naming what is missing — never crash or render garbage.

Whether the result is presented as a static single frame or an animated
trajectory is decided downstream by the frame count, not here.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional

# Formats mdtraj can load standalone (they carry their own topology).
STRUCTURE_EXTS = {
    ".pdb", ".pdb.gz", ".gro", ".mol2", ".cif", ".pdbx",
    ".h5", ".lh5", ".hoomdxml", ".arc", ".sdf",
}
# Coordinate-only trajectory formats that REQUIRE a companion topology.
TRAJECTORY_EXTS = {
    ".xtc", ".trr", ".dcd", ".nc", ".netcdf", ".ncdf", ".binpos",
    ".mdcrd", ".crd", ".trj", ".dtr", ".lammpstrj", ".xyz", ".tng",
}
# Candidate companion topology extensions, in resolution priority order.
TOPOLOGY_EXTS: List[str] = [
    ".pdb", ".gro", ".prmtop", ".parm7", ".psf", ".top", ".mol2", ".cif", ".h5",
]

_DOUBLE_EXTS = (".pdb.gz",)


def _stem_ext(path: str) -> tuple:
    """(stem, lowercased-extension) handling a couple of double extensions."""
    name = os.path.basename(path)
    low = name.lower()
    for dbl in _DOUBLE_EXTS:
        if low.endswith(dbl):
            return name[: -len(dbl)], dbl
    stem, ext = os.path.splitext(name)
    return stem, ext.lower()


def resolve_open_target(path: str) -> Dict[str, Optional[str]]:
    """Return {'topology': str, 'trajectory': str|None} for a file to open."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"file not found: {path}")
    _, ext = _stem_ext(path)

    if ext in TRAJECTORY_EXTS:
        companion = _find_companion(path)
        if companion is None:
            stem, _ = _stem_ext(path)
            where = os.path.dirname(os.path.abspath(path)) or "."
            tried = "|".join(e.lstrip(".") for e in TOPOLOGY_EXTS)
            raise FileNotFoundError(
                f"trajectory {os.path.basename(path)!r} needs a companion topology "
                f"to read, but none was found beside it. Looked for "
                f"'{stem}.({tried})' in {where}. Rename the topology to match the "
                f"trajectory's basename, or open the topology file directly."
            )
        return {"topology": companion, "trajectory": path}

    # Structure formats (and unknown extensions) open standalone. If an unknown
    # format really needs a topology, mdtraj raises its own clear error on load.
    return {"topology": path, "trajectory": None}


def _find_companion(traj_path: str) -> Optional[str]:
    directory = os.path.dirname(os.path.abspath(traj_path))
    stem, _ = _stem_ext(traj_path)
    for ext in TOPOLOGY_EXTS:
        candidate = os.path.join(directory, stem + ext)
        if os.path.exists(candidate):
            return candidate
    return None
