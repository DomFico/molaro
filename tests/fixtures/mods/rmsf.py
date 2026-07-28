# molaro-mod
# name: rmsf
# kind: analysis
# produces: per-point-scalar
# axis: color
# author: molaro reference mods
# source: https://github.com/DomFico/molaro
# description: per-atom RMS fluctuation, normalized to [0,1] for color — a reference analysis. ON A SOLVATED SYSTEM, TARGET THE SOLUTE, not `all`: both the superposition and the [0,1] normalization are taken over whatever you target, so `all` fits on the solvent and normalizes against water. Measured on a 6%-protein trp cage, `rmsf all` crushes every protein atom into the bottom 0.106 of the ramp (a flat-looking protein) and shifts its ranking (Spearman 0.87 vs the solute-targeted answer).
#
# Observable    : per-atom root-mean-square fluctuation (RMSF) about the mean
#                 position — one value PER TARGET ATOM, in target order.
# Raw units     : nanometers (before normalization).
# Superposition : the target-atom sub-trajectory is superposed to its own first
#                 frame, then each atom's fluctuation about its mean position is
#                 measured (mdtraj's md.rmsf). Alignment set == measured set,
#                 mirroring the rmsd reference's selection convention, so an RMSF
#                 over a subset is self-contained and coherent.
# THE TARGET IS LOAD-BEARING, and adk cannot show you why: it is 100% polymer, so
#                 `rmsf all` and `rmsf <protein>` agree exactly there (max Δ 0.0000).
#                 On the solvated trp cage — 304 protein atoms among 4810 — they do
#                 not. TWO things go wrong at once, and the smaller one is the one
#                 people name:
#                   * NORMALIZATION swamping (the visible failure): water is the most
#                     mobile thing present, so min-max over `all` maps every protein
#                     atom into 0.000–0.106. The protein renders flat, and nothing
#                     reports an error.
#                   * SUPERPOSITION contamination: md.rmsf superposes over the set it
#                     is given, so `all` fits on 4506 waters and the protein's
#                     fluctuation is measured against a solvent-dominated frame —
#                     Spearman 0.87 against the solute-targeted ranking, not 1.00.
#                 Both dissolve by targeting the solute. This mod does not silently
#                 "fix" it by fitting on the solute while measuring everything: that
#                 would break the alignment-set == measured-set invariant below, which
#                 is what makes a subset RMSF self-contained.
#
# Normalization : min-max over the returned atoms → the LEAST mobile target atom
#                 maps to 0.0 and the MOST mobile to 1.0. This is the mod's own
#                 choice of what "high" means: relative mobility WITHIN the
#                 selection, so the same physical fluctuation reads brighter in a
#                 rigid selection than in a floppy one. (An absolute scale would
#                 need a fixed nm ceiling; relative is the honest default for a
#                 color ramp and keeps the per-point contract's [0,1] exactly.)
#                 If every atom fluctuates equally (span 0), all map to 0.0.
# Contract      : per-point-scalar → returns len(target_indices) floats in [0,1],
#                 in the SAME order as target_indices (header order), so value k
#                 colors point target_indices[k]. Empty target = all atoms.

import numpy as np
import mdtraj as md


def compute(data, target_indices):
    """One [0,1] fluctuation value per target atom, in target order (per-point).

    Returns a list of length len(target_indices) (or n_atoms when empty).
    """
    traj = data.trajectory
    if traj is None:
        raise RuntimeError("rmsf needs a trajectory-backed dataset (not the synthetic source)")

    idx = list(target_indices) if target_indices else list(range(traj.n_atoms))
    sub = traj.atom_slice(np.asarray(idx, dtype=int))
    rmsf_nm = md.rmsf(sub, sub, frame=0)  # nm, one per target atom, in target order

    lo = float(rmsf_nm.min())
    span = float(rmsf_nm.max()) - lo
    if span <= 0.0:
        return [0.0] * len(idx)
    return [float((v - lo) / span) for v in rmsf_nm]
