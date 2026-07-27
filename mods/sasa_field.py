# molaro-mod
# name: sasa_field
# kind: analysis
# produces: channel
# channel: sasa_field
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: The measurement half of `live_sasa` — it RUNS AUTOMATICALLY when you invoke that mod, so you rarely call it by hand. Each point carries its residue's Shrake-Rupley solvent-accessible area IN THE DISPLAYED FRAME, normalized over the whole run into 0..1 so a colour means the same thing at every frame. Burial is conformational, which is what makes this worth animating: a bound axis re-derives it on every frame flip. Occlusion is by the BIOPOLYMER only (a solvated system handed its water would bury its own solute), so lipids, ligands and ions bury nothing. Whole-system by the channel contract — a value for EVERY point on EVERY frame regardless of what you targeted — and a residue mdtraj scores as neither protein nor nucleic (water, an ion, a ligand) takes 0.0, the ramp's low end.

import time
import numpy as np
import mdtraj as md

# ONE QUANTITY, NO SELECTOR — deliberately no `?colorby`. A bare re-invocation does
# not re-run a provider (webview/main.ts: "the documented escape hatch"), so a
# parameter deciding what one channel MEANT would leave the OTHER quantity standing
# under the asked-for name. One quantity per channel instead: asking for `ss_field`
# asks for a DIFFERENT channel, and a missing channel IS the re-run trigger.
#
# NORMALIZED OVER THE WHOLE RUN, not per frame: a per-frame normalization would
# rescale the ramp on every flip, so a residue could change colour while its own
# area did not.
#
# ONE DISCLOSED HOLE: the scored set is mdtraj's protein/nucleic name tables, not
# the atom signature `cartoon` uses to decide what it DRAWS as nucleic, so a
# modified nucleotide those tables miss (10GJ's 8-oxoguanine) reads 0.0 rather
# than visibly unscored. Nothing reaches it here — 10GJ owns no trace vertex for
# it and has one frame, so it cannot be live at all.
UNSCORED = 0.0
# Shrake-Rupley runs on EVERY frame — a channel has no budgeted subsample to fall
# back on — so the cost is gated by MEASUREMENT, not a model: probe a few frames,
# scale, refuse with both numbers. A fitted constant would be the wrong instrument
# — re-measured over 758..21616 biopolymer atoms the log-log slope in atom count is
# 1.05, near-LINEAR rather than the quadratic a SASA cost is usually assumed to be,
# and the marginal cost per frame itself climbs with batch size (1.8 ms/frame at 8
# frames against 8.9 amortised over adk's 98).
#
# THE PROBE OVER-STATES, DELIBERATELY. Each shrake_rupley CALL pays a fixed setup
# the whole run pays once — re-measured on adk, ~130 ms against 8.9 ms per frame
# amortised — so a ONE-frame probe projects ~13 s for adk's 98 frames and would
# refuse the best demonstration in the corpus. The 8-frame probe projects ~1.8 s
# against this mod's real 0.88 s on that system, over-stating by about 2x.
# Over-stating is the safe direction: the alternative to a false refusal is the
# producer's 5 s SIGALRM killing the run mid-flight.
#
# AND THE PROBE'S FRAMES ARE THROWN AWAY, which is the non-obvious part, because
# mdtraj's shrake_rupley is only deterministic for a GIVEN call: its per-frame
# answer depends on how many frames the call covers (measured on adk — a residue's
# area moves by up to 0.0018 nm^2, 0.08% of this system's range, on 14 of the 98
# frames, between one 98-frame call and an 8+90 composite). Reusing the probe would
# leave a seam at frame 8 where the numbers switch batch — and recomputing is not
# even the dearer option: 0.88 s for the one call against 0.92 s for the composite,
# which pays that fixed setup twice.
SASA_BUDGET_S = 3.0
SASA_PROBE_FRAMES = 8


def compute(data, target_indices, params=None):
    traj = data.trajectory
    if traj is None:
        raise ValueError(
            "sasa_field needs coordinates to measure burial per frame, and this "
            "source has no trajectory (data.trajectory is None) — the synthetic "
            "source has no chemistry at all, so there is no solvent accessibility "
            "here to follow."
        )
    top = traj.topology
    n_frames = int(traj.n_frames)
    if n_frames < 2:
        raise ValueError(
            f"sasa_field: this dataset has {n_frames} frame, so there is no "
            "trajectory for a live colouring to follow — a bound channel re-derives "
            "on every frame FLIP and nothing ever flips here. "
            "Use `cartoon ?colorby=sasa` for the static picture."
        )
    polymer = [r.index for r in top.residues if r.is_protein or r.is_nucleic]
    if not polymer:
        raise ValueError(
            "sasa_field: solvent accessibility is computed on the biopolymer "
            "(protein and nucleic residues) and this topology holds none that "
            "mdtraj recognises."
        )
    sel = np.asarray([a.index for r in polymer for a in top.residue(r).atoms], dtype=int)
    sub = traj.atom_slice(sel)
    if sub.topology.n_residues != len(polymer):
        raise RuntimeError(
            "sasa_field: slicing to the biopolymer produced "
            f"{sub.topology.n_residues} residues for {len(polymer)} selected — the "
            "residue mapping this mod relies on does not hold here."
        )
    probe_k = min(n_frames, SASA_PROBE_FRAMES)
    t0 = time.time()
    md.shrake_rupley(sub[0:probe_k], mode="residue")      # timed, then DISCARDED
    probe_s = max(time.time() - t0, 1e-6)
    projected = probe_s / probe_k * n_frames
    if projected > SASA_BUDGET_S:
        raise ValueError(
            "sasa_field: a LIVE field needs Shrake-Rupley on every frame, and "
            f"{probe_k} frame(s) of this system's {len(sel)} biopolymer atoms took "
            f"{probe_s:.2f} s here, so {n_frames} frames project to about "
            f"{projected:.0f} s, over this mod's {SASA_BUDGET_S:g} s ceiling — which "
            "sits below the producer's 5 s SIGALRM so the run is refused rather than "
            "killed mid-flight. Measured on this machine, not "
            "estimated from a formula, and deliberately on the high side (a probe "
            "pays a fixed per-call setup the whole run pays once, so the projection "
            "over-states by roughly 2x). Use `live_ss` for a live field on this "
            "system, or `cartoon ?colorby=sasa` for the static picture, which "
            "subsamples frames on a cost budget precisely because it is allowed to."
        )
    area = md.shrake_rupley(sub, mode="residue")          # ONE call, no seam
    field = np.full((n_frames, top.n_residues), np.nan, dtype=np.float64)
    field[:, np.asarray(polymer, dtype=int)] = area          # (n_frames, n_polymer)
    lo, hi = float(np.nanmin(area)), float(np.nanmax(area))
    if not (hi - lo > 0.0):
        raise ValueError(
            "sasa_field: every scored residue has the same area "
            f"({lo:g} nm^2) on every frame, so there is no gradient to follow and a "
            "flat colour reported as a measurement is not an answer."
        )
    field = (field - lo) / (hi - lo)
    field = np.where(np.isfinite(field), field, UNSCORED)

    # BROADCAST per-residue -> per-POINT (every atom inherits its residue's value),
    # and WHOLE-SYSTEM: target_indices does not shrink a channel — the producer's
    # length check is against n_frames * n_points, so emitting only the target's
    # atoms is refused. WHERE the values apply is decided later by the bind.
    atom_res = np.fromiter((a.residue.index for a in top.atoms),
                           dtype=np.int64, count=top.n_atoms)
    values = np.ascontiguousarray(field[:, atom_res], dtype="<f4")
    return {"values": values, "components": 1, "min": 0.0, "max": 1.0}
