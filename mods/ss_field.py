# molaro-mod
# name: ss_field
# kind: analysis
# produces: channel
# channel: ss_field
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: The measurement half of `live_ss` — it RUNS AUTOMATICALLY when you invoke that mod, so you rarely call it by hand. Each point carries its residue's secondary structure IN THE DISPLAYED FRAME as one of three fixed values (coil 0.0, sheet 0.5, helix 1.0 — never anything between them, so a ramp shows three colours and interpolates nothing). DSSP reads hydrogen bonds off the current coordinates and reclassifies as the structure moves, which is what makes this worth animating: a bound axis re-derives it on every frame flip. PROTEIN ONLY — DSSP classifies the peptide backbone and there is no DSSP for a nucleic acid, so a nucleic or coarse-grained residue takes 0.0. Whole-system by the channel contract: a value for EVERY point on EVERY frame regardless of what you targeted.

import numpy as np
import mdtraj as md

# ONE QUANTITY, NO SELECTOR — deliberately no `?colorby`. A bare re-invocation does
# not re-run a provider (webview/main.ts: "the documented escape hatch"), so a
# parameter deciding what one channel MEANT would leave the OTHER quantity standing
# under the asked-for name. One quantity per channel instead: asking for `sasa_field`
# asks for a DIFFERENT channel, and a missing channel IS the re-run trigger.
#
# CHEAP, unlike its sibling: re-measured, the whole DSSP pass over adk's 98 frames
# costs 23 ms — 0.2 ms/frame at 3341 protein atoms against Shrake-Rupley's 8.9 —
# so this needs no cost gate.
#
# A CATEGORICAL SCHEME THROUGH A CONTINUOUS RAMP, said plainly because it is the
# one thing here a reader could take the wrong way. Three classes on a scalar
# pushed through `bluewhitered` give coil blue, sheet white, helix red — NOT
# PyMOL's cbss red/yellow/green that `cartoon ?colorby=ss` uses. It ships rather
# than being refused because the ramp is never sampled BETWEEN the three values,
# so no intermediate colour appears and nothing is interpolated. The ordering
# coil < sheet < helix is a display convention (it matches cartoon's own SS_SHADE
# lightness ordering), not a claim that a helix is more than a strand.
#
# FIXED VALUES, not a normalization: the ramp's ends must mean coil and helix on
# every system, or a mostly-helical protein and a mostly-coiled one would use
# different colours for the same class.
SS_SCALAR = {"H": 1.0, "E": 0.5}     # everything else (C, and DSSP's NA) -> 0.0
# What an unscored residue takes: the low end, which therefore COLLIDES with coil
# — deliberately, because the alternative is spending part of the ramp on "not
# applicable". `live_ss` refuses a target with no protein in it at all, but a
# MIXED target's nucleic residues do come out coil-blue.
UNSCORED = 0.0


# ==== SMOOTH FOLLOW — shared by hbonds.py, sasa_field.py, ss_field.py; KEEP IDENTICAL ====
# A live layer whose VALUES change per frame (a mask, an area, a class) follows
# `smooth` by filtering those values over the same per-point window `smooth`
# applies to positions — never by measuring the smoothed (unphysical) positions.
# `_follow_record` remembers which windows a layer was computed for, so `smooth`
# can say when it is out of date.
def _follow_half(data, n):
    st = getattr(data, "_molaro_motion", None)
    if isinstance(st, dict) and st.get("shape", (None, None))[1] == n:
        return np.asarray(st["smooth_half"], dtype=np.int64)
    return np.zeros(n, dtype=np.int64)


def _follow_record(data, name, half):
    rec = getattr(data, "_molaro_follow", None)
    if not isinstance(rec, dict):
        rec = {}
    rec[name] = np.asarray(half, dtype=np.int64).tobytes()
    data._molaro_follow = rec


def _window_mean(x, w):
    """Centred moving mean of x (t, k) over half-width w per column (k,), clamped."""
    t = x.shape[0]
    out = np.array(x, dtype=np.float64)
    frames = np.arange(t)
    for hw in np.unique(w):
        if hw <= 0:
            continue
        cols = np.flatnonzero(w == hw)
        csum = np.concatenate([np.zeros((1, cols.size)), np.cumsum(x[:, cols], axis=0)], axis=0)
        lo = np.maximum(frames - hw, 0)
        hi = np.minimum(frames + hw, t - 1)
        out[:, cols] = (csum[hi + 1] - csum[lo]) / (hi - lo + 1)[:, None]
    return out
# ==== end SMOOTH FOLLOW ====


def _window_mode(x, w):
    """Most common value of x (t, k) in each column's centred window of half-width
    w (k,) — ties go to the frame's own value. For a CLASS field (coil/sheet/helix
    as 0/0.5/1) a mean would invent in-between values that are no class at all."""
    out = np.array(x, dtype=np.float64)
    cols = np.flatnonzero(w > 0)
    if cols.size == 0:
        return out
    sub = out[:, cols]
    classes = np.unique(sub)
    score = np.stack([_window_mean((sub == c).astype(np.float64), w[cols]) + 1e-6 * (sub == c)
                      for c in classes])
    out[:, cols] = classes[np.argmax(score, axis=0)]
    return out


def compute(data, target_indices, params=None):
    traj = data.trajectory
    if traj is None:
        raise ValueError(
            "ss_field needs coordinates to classify per frame, and this source has "
            "no trajectory (data.trajectory is None) — the synthetic source has no "
            "chemistry at all, so there is no secondary structure here to follow."
        )
    top = traj.topology
    n_frames = int(traj.n_frames)
    if n_frames < 2:
        raise ValueError(
            f"ss_field: this dataset has {n_frames} frame, so there is no trajectory "
            "for a live colouring to follow — a bound channel re-derives on every "
            "frame FLIP and nothing ever flips here. Use `cartoon ?colorby=ss` for "
            "the static picture."
        )
    protein_atoms = top.select("protein")
    if len(protein_atoms) == 0:
        raise ValueError(
            "ss_field: DSSP assigns secondary structure from the PEPTIDE backbone's "
            "hydrogen bonds and this system has no protein residues, so there is "
            "nothing for it to classify. A nucleic acid has no DSSP at all — for a "
            "live nucleic colouring use `live_sasa`, which scores a nucleic "
            "backbone too."
        )
    # THE DSSP INDEXING TRAP, the same one `cartoon` documents: compute_dssp returns
    # one column per PROTEIN residue, not per topology residue, so a water or ligand
    # between two protein residues shifts every assignment past it. Slice to protein
    # first, then map columns back through that slice's own residue order.
    dssp = md.compute_dssp(traj.atom_slice(protein_atoms), simplified=True)
    protein_residues = [r.index for r in top.residues if r.is_protein]
    if len(protein_residues) != dssp.shape[1]:
        raise RuntimeError(
            f"ss_field: DSSP returned {dssp.shape[1]} columns for "
            f"{len(protein_residues)} protein residues — the indexing assumption "
            "this mod relies on does not hold for this system."
        )
    field = np.full((n_frames, top.n_residues), UNSCORED, dtype=np.float64)
    for col, ridx in enumerate(protein_residues):
        field[:, ridx] = [SS_SCALAR.get(c, 0.0) for c in dssp[:, col]]

    # BROADCAST per-residue -> per-POINT (every atom inherits its residue's value),
    # and WHOLE-SYSTEM: target_indices does not shrink a channel — the producer's
    # length check is against n_frames * n_points, so emitting only the target's
    # atoms is refused. WHERE the values apply is decided later by the bind.
    atom_res = np.fromiter((a.residue.index for a in top.atoms),
                           dtype=np.int64, count=top.n_atoms)
    values = field[:, atom_res]
    # FOLLOW `smooth`: each point takes the most common class over the same window
    # `smooth` applies to its position (classified on the raw frames, as DSSP
    # must be), so the colour does not flicker faster than the motion.
    half = _follow_half(data, values.shape[1])
    if half.any():
        values = _window_mode(values, half)
    _follow_record(data, "ss_field", half)
    values = np.ascontiguousarray(values, dtype="<f4")
    # min/max are the FIXED class scale, so the bind's range never has to be fitted.
    return {"values": values, "components": 1, "min": 0.0, "max": 1.0}
