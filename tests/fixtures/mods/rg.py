# molaro-mod
# name: rg
# kind: analysis
# produces: per-frame-series
# author: molaro reference mods
# source: https://github.com/DomFico/molaro
# description: radius of gyration per frame (mass-weighted, nm) — a reference analysis
#
# Observable : radius of gyration, one value per frame.
# Units      : nanometers (mdtraj works in nm; no hand conversion).
# Convention : MASS-WEIGHTED about the mass-weighted centroid. Masses come from
#              the element table (mdtraj's own), with a uniform-mass fallback for
#              fully element-less systems (e.g. coarse-grained beads), where Rg
#              degrades to the geometric radius — matching the corpus reference
#              (benchmark_systems/_lib/reference_values.py::canonical_masses).
# Reduction  : float64. mdtraj's md.compute_rg accumulates in float32, which on a
#              multi-thousand-atom system drifts ~1e-3 nm from the reference — too
#              far for the 1e-4 corpus gate. The corpus's own reference reduces in
#              float64 for exactly this reason; this mod matches it, so it IS the
#              reference computation rather than a looser approximation.
# Target     : whole system by default (target_indices empty). A non-empty
#              target restricts Rg to those atoms (a valid sub-Rg; the corpus
#              rg_mean reference is the whole-system value).

import numpy as np


def compute(data, target_indices):
    """One raw Rg value per frame (nm), mass-weighted, over the target atoms.

    The plot auto-scales the curve; per-frame-series values are raw (no
    normalization). Returns a list of length n_frames.
    """
    traj = data.trajectory
    if traj is None:
        raise RuntimeError("rg needs a trajectory-backed dataset (not the synthetic source)")

    t = traj if not target_indices else traj.atom_slice(np.asarray(target_indices, dtype=int))

    masses = np.array(
        [a.element.mass if a.element is not None else 0.0 for a in t.topology.atoms],
        dtype=np.float64,
    )
    if masses.sum() <= 0.0:  # element-less system → geometric Rg (uniform masses)
        masses = np.ones_like(masses)
    w = masses / masses.sum()

    xyz = t.xyz.astype(np.float64)                       # (n_frames, n_sel, 3), nm
    com = np.einsum("a,fac->fc", w, xyz)                 # mass-weighted centroid per frame
    disp = xyz - com[:, None, :]
    rg = np.sqrt(np.einsum("a,fa->f", w, np.einsum("fac,fac->fa", disp, disp)))
    return [float(v) for v in rg]
