# molaro-mod
# name: show_res
# kind: analysis
# produces: commands
# param: within number 0
# param: keep boolean false
# param: opacity number 1.0
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Bring back a target's ATOMS AND ITS BONDS in one stroke — the other half of `hide_res`. Restores points and every edge with at least one endpoint in the target to full opacity. Bare `show_res`, with no target, restores the WHOLE system, which is the quick way out when you have hidden your way into a corner. Like `hide_res` this writes opacity and creates no selection, so it never touches your selection list; and it does not undo a built-in `hide` (that is a selection flag — use `show` for those).

# NO TARGET MEANS EVERYTHING, in both directions.
#
# `hide_res` and `show_res` follow the same rule `cartoon` does: type the verb with
# no target and it acts on the whole scene. They were briefly asymmetric — hide_res
# refused an empty target, copying the built-in `hide`'s "there is no hide
# everything" — but that refusal is only earned by a selection-model hide, which is
# a mode you can get stuck in. These write OPACITY: one Ctrl+Z reverses it and the
# sibling verb is the other way out, so refusing bought nothing and cost the
# shortest useful command.
#
# WHAT THIS DOES NOT DO, so it is not mistaken for a general "unhide".
#
# It restores OPACITY. The built-in `hide` sets a HIDDEN FLAG on a committed
# selection, which is a different mechanism — a point hidden that way stays hidden
# no matter what opacity says, because hidden wins. If something will not come back
# with `show_res`, it was hidden with `hide`, and `show` is the verb for it.
#
# It also restores to FULL opacity rather than to whatever the point had before.
# A mod cannot read the current representation — it is handed coordinates and a
# target, never colours, sizes or opacities — so there is nothing to put back and
# no way to know there was anything else. Ctrl+Z is the exact revert; this is the
# blunt one, and saying so here is cheaper than a surprise.

# EDIT ME — what "shown" means. 1.0 is the viewer's own default point opacity
# (webview/representation.ts DEFAULT_OPACITY), so this returns things to the state
# a freshly loaded scene has.
SHOWN_OPACITY = 1.0


# Angstrom -> nanometre. The viewer's coordinates are nm (mdtraj's unit); `?around`
# is stated in ANGSTROM because that is what a structural biologist types.
ANGSTROM_NM = 0.1


def _residue_atoms(top, indices):
    """Every atom of every residue that any of `indices` belongs to (`byres`)."""
    residues = {top.atom(int(i)).residue.index for i in indices}
    return {a.index for r in residues for a in top.residue(r).atoms}


def _around(data, target_indices, distance, keep=False):
    """Atoms near the target, WHOLE RESIDUES AT A TIME.

    A radius through raw atoms cuts residues in half — you get the two side-chain
    carbons that happen to fall inside 5 A and not the rest of the ring, which reads
    as damage rather than as a neighbourhood. So the shell is expanded with `byres`:
    a residue with ANY atom in range comes in ENTIRELY. That is what PyMOL's
    `byres (all within 5 of sel)` does and what people mean by "around".

    `scope` decides whether the thing you named comes along, and it is applied at
    RESIDUE grain too — otherwise excluding "the target atoms" would leave the rest
    of the target's own residue behind, which is the same half-a-residue artefact
    one level up:
      exclude (default) — the neighbourhood WITHOUT the target's own residues.
      include           — the neighbourhood AND the target's residues, whole.

    MEASURED AT FRAME 0, which is a real limitation rather than an oversight: a mod
    is never told which frame is displayed (the run_mod request carries code, target,
    params and nothing else — reports/PARKED.md P9). Correct for a binding site,
    wrong for anything that diffuses. Re-run after scrubbing to re-measure.
    """
    import numpy as np
    from scipy.spatial import cKDTree

    traj = data.trajectory
    if traj is None:
        raise RuntimeError(
            "?around needs a trajectory-backed dataset with coordinates and a "
            "topology; the synthetic source has neither."
        )
    sel = sorted({int(i) for i in target_indices})
    if not sel:
        raise ValueError(
            "?around needs a target to be around — bare `?around` would mean "
            '"everything except everything". Name a selection, a residue or a chain.'
        )
    top = traj.topology
    xyz = np.asarray(traj.xyz[0], dtype=np.float64)
    hits = cKDTree(xyz).query_ball_point(xyz[sel], distance * ANGSTROM_NM)
    near = _residue_atoms(top, {int(j) for group in hits for j in group})
    own = _residue_atoms(top, sel)
    near = (near | own) if keep else (near - own)
    if not near:
        raise ValueError(
            f"?within={distance} found no residues within {distance} A of the "
            f"target (measured at frame 0). Try a larger radius, or "
            f"?keep=true to keep the target itself."
        )
    return sorted(near)


def _index_expr(target_indices, n_points=None):
    """`target_indices` -> a `#` member expression, as COMPACT CONTIGUOUS RANGES.

    Kept identical to `hide_res`'s helper on purpose: the two mods must agree about
    what a target MEANS, or showing would not exactly undo hiding. Indices rather
    than label paths, so a single-atom target is not rounded up to its residue.
    """
    idx = sorted({int(i) for i in target_indices})
    if not idx:
        return "all"
    # A target that covers the whole system IS `all`, and saying so keeps the
    # emitted command short: `hide_res all` on adk was a literal `#0-3340`.
    if n_points is not None and len(idx) == int(n_points):
        return "all"
    parts, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i == prev + 1:
            prev = i
            continue
        parts.append(f"{start}-{prev}" if prev > start else f"{start}")
        start = prev = i
    parts.append(f"{start}-{prev}" if prev > start else f"{start}")
    # `#` on EVERY part, not once at the front. The grammar reads a `#` list as
    # `#12-18,#40` and refuses `#12-18,40` with 'expected "#" to start each index
    # in the list'. This was wrong from the start and stayed hidden because every
    # target tried until now collapsed to ONE contiguous range, where the two forms
    # are identical; `?around` is the first thing that yields disjoint ranges.
    return ",".join(f"#{part}" for part in parts)


def compute(data, target_indices, params=None):
    params = params or {}   # a RAW caller passes none; the viewer always fills defaults
    # Empty target = the whole system (the mod contract). `all` is the grammar's
    # own keyword for that and is cheaper than emitting a range covering every
    # point, so a bare `show_res` is two short commands however large the system is.
    # `?opacity` overrides the module default, so the same verb covers "gone"
    # (0), "ghost" (0.1-0.2 reads as a faint outline over a solid scene) and
    # anything between. Refused rather than clamped — a silently-ignored 5 would
    # look like the mod having no effect.
    try:
        opacity = float(params.get("opacity", SHOWN_OPACITY))
    except (TypeError, ValueError):
        raise ValueError(f'show_res: opacity must be a number, got "{params.get("opacity")}".')
    if not (0.0 <= opacity <= 1.0):
        raise ValueError(f"show_res: opacity must be between 0 and 1, got {opacity}.")

    # `?within=N` retargets: act on the NEIGHBOURHOOD of what you named, not on it.
    # 0 (the default) means "the target itself" and costs nothing — no coordinates
    # are read and no KD-tree is built.
    try:
        within = float(params.get("within", 0.0))
    except (TypeError, ValueError):
        raise ValueError(f'show_res: around must be a number of angstroms, got "{{params.get("around")}}".')
    if within < 0:
        raise ValueError(f"show_res: around must be a positive distance in angstroms, got {{around}}.")
    keep = params.get("keep", False)
    if not isinstance(keep, bool):
        raise ValueError(f'show_res: scope must be "exclude" or "include", got "{{scope}}".')
    if within > 0:
        target_indices = _around(data, target_indices, within, keep)

    expr = _index_expr(target_indices, data.give_header().n_points)
    return [
        f"pointopacity {expr} {opacity}",
        f"bondopacityof {expr} {opacity}",
    ]
