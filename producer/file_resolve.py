"""Resolve an on-disk file path to a (topology, trajectory) pair to open.

This is the file-open entry point's companion-resolution step (Increment 4.6),
kept in the data-source layer — file-type knowledge belongs here, never in the
renderer. It answers one question: given a path a user opened, what does
MdtrajSource need to read it?

- A **standalone structure** file (carries its own topology + coordinates, e.g.
  ``.pdb``/``.gro``) opens on its own — topology = the file, no trajectory.
- A **trajectory** file (coordinates only, e.g. ``.xtc``/``.dcd``) needs a
  companion topology. We resolve it in three cheap steps, most specific first:
    1. **same basename** beside it (``run.xtc`` -> ``run.pdb``);
    2. else, if the folder holds exactly **one** topology file, use it (the
       common ``system.pdb`` + ``traj.xtc`` layout);
    3. else, disambiguate multiple candidates by **atom count** — the topology
       whose atom count matches the trajectory's (reads a single frame, cheap).
  If nothing resolves we raise a clear error naming what was tried — never crash
  or render garbage.

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
            raise FileNotFoundError(_no_companion_message(path))
        return {"topology": companion, "trajectory": path}

    # Structure formats (and unknown extensions) open standalone. If an unknown
    # format really needs a topology, mdtraj raises its own clear error on load.
    return {"topology": path, "trajectory": None}


def _find_companion(traj_path: str) -> Optional[str]:
    directory = os.path.dirname(os.path.abspath(traj_path))
    stem, _ = _stem_ext(traj_path)

    # 1. exact same-basename sibling (priority by TOPOLOGY_EXTS order).
    for ext in TOPOLOGY_EXTS:
        candidate = os.path.join(directory, stem + ext)
        if os.path.exists(candidate):
            return candidate

    # 2/3. other topology files in the folder: one is unambiguous; several are
    # disambiguated by matching the trajectory's atom count.
    candidates = _topology_candidates(directory, traj_path)
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    return _match_by_atom_count(traj_path, candidates)


def _topology_candidates(directory: str, traj_path: str) -> List[str]:
    """Topology files in `directory` (excluding the trajectory), ordered by
    TOPOLOGY_EXTS priority then name for determinism."""
    traj_abs = os.path.abspath(traj_path)
    found: List[str] = []
    try:
        entries = sorted(os.listdir(directory))
    except OSError:
        return []
    for name in entries:
        full = os.path.join(directory, name)
        if os.path.abspath(full) == traj_abs or not os.path.isfile(full):
            continue
        _, ext = _stem_ext(name)
        if ext in TOPOLOGY_EXTS:
            found.append(full)
    found.sort(key=lambda p: (TOPOLOGY_EXTS.index(_stem_ext(p)[1]), p))
    return found


def _match_by_atom_count(traj_path: str, candidates: List[str]) -> Optional[str]:
    """Pick the candidate topology whose atom count matches the trajectory's.
    Reads a single trajectory frame (cheap even for huge trajectories)."""
    import mdtraj as md  # lazy: only when we must disambiguate

    try:
        with md.open(traj_path) as f:
            result = f.read(n_frames=1)
        xyz = result[0] if isinstance(result, tuple) else result
        n_traj = int(xyz.shape[1])
    except Exception:
        return None  # can't read atom count -> fall through to a clear error

    matches: List[str] = []
    for cand in candidates:
        try:
            if md.load_topology(cand).n_atoms == n_traj:
                matches.append(cand)
        except Exception:
            continue
    return matches[0] if matches else None  # candidates already priority-ordered


def _no_companion_message(traj_path: str) -> str:
    directory = os.path.dirname(os.path.abspath(traj_path)) or "."
    stem, _ = _stem_ext(traj_path)
    candidates = _topology_candidates(directory, traj_path)
    base = os.path.basename(traj_path)
    if candidates:
        names = ", ".join(os.path.basename(c) for c in candidates)
        return (
            f"trajectory {base!r} needs a companion topology, and topology files "
            f"were found beside it ({names}) but none matched by basename or by "
            f"atom count. Open the correct topology file directly instead."
        )
    tried = "|".join(e.lstrip(".") for e in TOPOLOGY_EXTS)
    return (
        f"trajectory {base!r} needs a companion topology to read, but none was "
        f"found beside it. Looked for '{stem}.({tried})' in {directory}. Put a "
        f"topology file next to it, or open the topology file directly."
    )
