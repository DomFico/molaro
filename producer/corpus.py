"""Resolve a benchmark-corpus system id to its topology/trajectory files.

Convenience for pointing the real source at the acceptance corpus. A generic
real dataset does not need this — it uses --dataset/--trajectory directly. Kept
separate from ``mdtraj_source.py`` so the source itself has no notion of the
corpus.

Corpus location defaults to the sibling ``benchmark_systems`` tree and can be
overridden with the ``VIEWER_CORPUS_ROOT`` environment variable.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict

_DEFAULT_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "benchmark_systems")
)

# Per-system ligand residue overrides. The reference viewer has no reliable
# name-based ligand table, so a custom small molecule is opt-in per system
# (mirrors the corpus's ligand_overrides). Only system 04 needs one.
LIGAND_OVERRIDES: Dict[str, list] = {
    "04_ligand_custom_solvent": ["BNZ"],
}


def corpus_root() -> str:
    return os.environ.get("VIEWER_CORPUS_ROOT", _DEFAULT_ROOT)


def _system_dir(system: str) -> str:
    """Accept a full path, a full id (04_ligand_custom_solvent), or a numeric
    prefix (04) and return the system directory."""
    if os.path.isdir(system) and os.path.exists(os.path.join(system, "manifest.json")):
        return system
    systems_dir = os.path.join(corpus_root(), "systems")
    candidate = os.path.join(systems_dir, system)
    if os.path.isdir(candidate):
        return candidate
    prefix = system.split("_", 1)[0]
    for name in sorted(os.listdir(systems_dir)):
        if name == system or name.split("_", 1)[0] == prefix:
            return os.path.join(systems_dir, name)
    raise FileNotFoundError(f"corpus system not found: {system!r} (root {corpus_root()})")


def _assert_references_agree(sdir: str, sid: str, manifest: Dict[str, Any]) -> None:
    """Every system stores its reference observables TWICE — in manifest.json
    (``reference_observables``) and in reference_values.json. ``build.py`` writes
    both, and the corpus test reads only the manifest.

    That is two lists that must agree, with the read one not being the one a
    person would naturally edit — the defect class this project has now paid for
    four times, sitting in the tree whose whole job is to make the correctness
    claim checkable. Remembering to write both is a person remembering, one
    refactor away from failing. So it is asserted at load instead: any
    divergence stops the corpus with both values named, rather than letting a
    test quietly grade against a stale number.
    """
    rv_path = os.path.join(sdir, "reference_values.json")
    if not os.path.exists(rv_path):
        return                              # not every system carries the file
    stored = json.load(open(rv_path))
    declared = manifest.get("reference_observables", {})
    for name in sorted(set(declared) & set(stored)):
        a, b = declared[name].get("value"), stored[name].get("value")
        if isinstance(a, (int, float)) and isinstance(b, (int, float)) and a != b:
            raise ValueError(
                f"{sid}: reference '{name}' disagrees between manifest.json "
                f"({a!r}) and reference_values.json ({b!r}). These must be written "
                "together — see scripts/rederive_rg_references.py."
            )


def resolve_system(system: str) -> Dict[str, Any]:
    """Return {name, topology, trajectory, ligand_residues, manifest} for a
    system, resolving the manifest's primary topology + trajectory to abs paths."""
    sdir = _system_dir(system)
    manifest = json.load(open(os.path.join(sdir, "manifest.json")))
    sid = manifest["id"]
    _assert_references_agree(sdir, sid, manifest)
    topology = os.path.join(sdir, manifest["topology"]["primary"])
    traj_primary = manifest["trajectory"]["primary"]
    trajectory = os.path.join(sdir, traj_primary) if traj_primary else None
    return {
        "name": sid,
        "topology": topology,
        "trajectory": trajectory,
        "ligand_residues": LIGAND_OVERRIDES.get(sid, []),
        "manifest": manifest,
        "dir": sdir,
    }
