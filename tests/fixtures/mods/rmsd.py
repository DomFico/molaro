# molaro-mod
# name: rmsd
# kind: analysis
# produces: per-frame-series
# author: molaro reference mods
# source: https://github.com/DomFico/molaro
# description: RMSD to the first frame (with superposition, nm) — a reference analysis
#
# Observable    : RMSD of each frame to frame 0, one value per frame.
# Units         : nanometers.
# Superposition : YES. Each frame is optimally superposed onto frame 0 over the
#                 target atoms before the deviation is measured (mdtraj's md.rmsd
#                 removes rigid-body rotation/translation by default). RMSD with
#                 vs without alignment are different numbers; the corpus reference
#                 (rmsd_to_frame0_mean) is the aligned one.
# Atom subset   : the SELECTION defines both the alignment set and the measured
#                 set (they are the same atoms) — matching the corpus, whose
#                 reference selects e.g. 'name CA' (adk), 'name P' (nucleic),
#                 'protein' (peptides), 'resname BNZ' (ligand). Here the selection
#                 is target_indices: pass the atoms you want RMSD over. Empty
#                 target = all atoms.
# Frame 0       : reference frame is the trajectory's first frame (frame=0).

import numpy as np
import mdtraj as md


def compute(data, target_indices):
    """One raw RMSD value per frame (nm), superposed to frame 0 over the target.

    Raw per-frame-series (the plot auto-scales). The corpus stores the MEAN of
    this series (rmsd_to_frame0_mean). Returns a list of length n_frames.
    """
    traj = data.trajectory
    if traj is None:
        raise RuntimeError("rmsd needs a trajectory-backed dataset (not the synthetic source)")

    idx = np.asarray(target_indices, dtype=int) if target_indices else None
    series = md.rmsd(traj, traj, frame=0, atom_indices=idx)  # superposes by default
    return [float(v) for v in series]
