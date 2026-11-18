# molaro-mod
# name: align
# kind: analysis
# produces: commands
# requires-channel: aligning
# param: ref hint first average mean last off
# param: fit hint target backbone CA heavy protein
# param: mode choice fit center
# param: weights choice equal mass
# param: apply choice all target
# param: iterations number 20
# description: Superpose every frame onto a reference so tumbling and drift disappear. `align <fit-target> ?ref=first|average|mean|last|<frame>|off` — first (default) is frame 0; average is the real frame closest to the average structure; mean is the average structure itself; off forgets the alignment. ?fit=backbone|CA|heavy|protein narrows the fit atoms within the target; ?apply=all (default) moves the whole system, ?apply=target only the target; ?mode=center removes translation only; ?weights=mass mass-weights the fit. COMBINES WITH `smooth` in either order: smoothing is applied to the aligned motion. Raw coordinates are untouched: `unbind all offset` shows them again.

# THE MACRO half of the align pair. `aligning` runs first (requires-channel) when
# its target or parameters changed; this binds the CURRENT combined motion
# channel to the offset axis and reports what was done.
#
# WHICH CHANNEL. `aligning` and `smoothing` both write the full combination
# smooth(align(raw)) from shared state on the dataset handle, and the state's
# version counter records which of them was computed last. The viewer does NOT
# re-run a provider whose target and parameters are unchanged, so a repeat
# `align` after a `smooth` finds `aligning` one step stale — binding it would
# drop the smoothing. Binding the current one is what keeps the two composable.

_MOTION_CHANNELS = ("aligning", "smoothing")


def _current_motion_channel(data, own):
    st = getattr(data, "_molaro_motion", None)
    if not isinstance(st, dict):
        return own, None
    cur = [c for c in _MOTION_CHANNELS
           if st["computed"].get(c) == st["version"] and data.channel(c) is not None]
    return (own if own in cur else (cur[0] if cur else own)), st


def _ribbon_note(data, st):
    """`refresh ribbon_dir` when cartoon ribbons were oriented for an older motion.
    Alignment rotates the frames, and a ribbon's facing is computed from the shown
    positions, so it must be recomputed. (Live SASA / SS / H-bonds do not depend
    on a rigid fit — they need nothing after `align`.)"""
    if st is None or data.channel("ribbon_dir") is None:
        return []
    if st["computed"].get("ribbon_dir") == st["version"]:
        return []
    return ["refresh ribbon_dir"]


def compute(data, target_indices, params):
    ch, st = _current_motion_channel(data, "aligning")
    cmds = [f"bind all {ch} offset"]
    rep = (st or {}).get("align_report")
    if rep is None:
        if str((params or {}).get("ref", "")).strip().lower() == "off":
            cmds.append("note align: alignment cleared" +
                        (" (smoothing kept)." if st is not None and st["smooth_half"].any() else "."))
        return cmds + _ribbon_note(data, st)

    what = "rotation + translation" if rep["mode"] == "fit" else "translation only"
    moved = "whole system" if rep["apply"] == "all" else "target only"
    cmds.append(f"note align: {rep['frames']} frames onto {rep['ref_text']}; fit on {rep['fit_n']} atoms "
                f"({rep['fit_label']}, {rep['weights']} weights), {what}, moving the {moved}.")
    s, u = rep["unit_scale"], rep["unit"]
    cmds.append(f"note align: fit RMSD to reference — median {rep['median'] * s:.2f}{u}, "
                f"max {rep['max'] * s:.2f}{u} at frame {rep['worst']}.")
    if st["smooth_half"].any():
        cmds.append(f"note align: smoothing kept on {int((st['smooth_half'] > 0).sum())} points, "
                    "applied after alignment.")
    return cmds + _ribbon_note(data, st)
