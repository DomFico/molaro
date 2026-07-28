# molaro-mod
# name: hide_res
# kind: analysis
# produces: commands
# param: within number 0
# param: keep boolean false
# param: opacity number 0.0
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Hide a target's ATOMS AND ITS BONDS in one stroke — one Ctrl+Z puts it all back. Fades the points to opacity 0 and every edge with AT LEAST ONE endpoint in the target, which is the same rule the renderer itself uses for a hidden point ("edges drop when either endpoint hides"), so the bonds joining the target to its neighbours go too instead of dangling into nothing. Bare `hide_res`, with no target, hides EVERYTHING — the same "no target means all" rule `cartoon` uses — and `show_res` or one Ctrl+Z brings it back. This is a REPRESENTATION change, not the built-in `hide`: it writes opacity and creates NO selection, so hiding twenty residues one at a time leaves your selection list exactly as it was. The trace is deliberately untouched, so a cartoon keeps its ribbon while the side chains go — hide the atoms, keep the fold. `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named, whole residues at a time, and `?keep=true` brings the target itself along. THE DISTANCE IS IN THE SCENE'S COORDINATE UNITS — the same number the built-in `create_sele`/`hide` flags take, so one flag name means one thing everywhere; for an mdtraj-backed source that is nanometres, so a 5 A shell is `?within=0.5`.

# WHY THIS EXISTS WHEN `hide` ALREADY DOES SOMETHING SIMILAR.
#
# The built-in `hide` is the right tool for hiding a SELECTION: it flips a flag on
# a committed selection and the renderer drops those points, their edges and their
# trace segments together. But on a target that is NOT already committed — a path,
# a glob, a `#` range — `hide` COMMITS THE TARGET AS A NEW SELECTION first. Measured:
# two identical `hide #0-99` calls take the committed count 1 -> 3. Hiding residues
# one at a time as you read a structure therefore fills the selection list with
# selection_1, selection_2, … which is exactly the clutter you were not asking for.
#
# So this mod takes the other route: it writes OPACITY. Nothing is committed, the
# selection list is untouched, and the effect is a pure representation write that
# rides the ordinary undo stack.
#
# WHICH BOND VERB, AND WHY IT IS THE `of` ONE.
#
#   bondopacity   <target> — edges with BOTH endpoints in the target (contained)
#   bondopacityof <target> — edges with AT LEAST ONE endpoint (incident)
#
# `bondopacity` would hide a residue's internal bonds and leave its peptide bonds
# drawn, running from a visible neighbour to an atom that is no longer there. The
# renderer's own rule for a genuinely hidden point is incident — "edges drop when
# EITHER endpoint hides (so a hidden category also hides its edge hairball)" — so
# `bondopacityof` is what makes this look like hiding rather than like erasing.
#
# The cost is stated rather than hidden: a bond from a hidden atom to a VISIBLE
# neighbour also fades. That is the same one-hop reach the built-in has, and it is
# what you want — the alternative is a bond drawn to nowhere.

# EDIT ME — what "hidden" means. 0.0 is invisible; raise it for a ghost instead of
# a disappearance (0.08 reads as a faint outline over a solid scene).
HIDDEN_OPACITY = 0.0




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
    hits = cKDTree(xyz).query_ball_point(xyz[sel], distance)
    near = _residue_atoms(top, {int(j) for group in hits for j in group})
    own = _residue_atoms(top, sel)
    near = (near | own) if keep else (near - own)
    if not near:
        raise ValueError(
            f"?within={distance} found no residues within {distance} of the "
            f"target (measured at frame 0). Try a larger radius, or "
            f"?keep=true to keep the target itself."
        )
    return sorted(near)


def _index_expr(target_indices, n_points=None):
    """`target_indices` -> a `#` member expression, as COMPACT CONTIGUOUS RANGES.

    Indices, not label paths, on purpose: this acts on exactly the atoms the target
    resolved to. Going through `category.group.subgroup` would round a single-atom
    target up to its whole residue, which is a different command than the one the
    user typed. `#` takes ranges and comma lists (`#1-5,9,12-20`), so a residue is
    usually one or two terms and `all` collapses to a single range.
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
    # NO TARGET MEANS EVERYTHING, matching `cartoon` — type the verb and it acts on
    # the scene. This deliberately does NOT copy the built-in `hide`, which refuses
    # ("there is no hide everything") because a selection-model hide is a mode you
    # can get stuck in. Here it is one opacity write: Ctrl+Z reverses it in a single
    # stroke and `show_res` is the other way out, so the refusal was guarding
    # against nothing while costing the shortest useful command.
    # `?opacity` overrides the module default, so the same verb covers "gone"
    # (0), "ghost" (0.1-0.2 reads as a faint outline over a solid scene) and
    # anything between. Refused rather than clamped — a silently-ignored 5 would
    # look like the mod having no effect.
    try:
        opacity = float(params.get("opacity", HIDDEN_OPACITY))
    except (TypeError, ValueError):
        raise ValueError(f'hide_res: opacity must be a number, got "{params.get("opacity")}".')
    if not (0.0 <= opacity <= 1.0):
        raise ValueError(f"hide_res: opacity must be between 0 and 1, got {opacity}.")

    # `?within=N` retargets: act on the NEIGHBOURHOOD of what you named, not on it.
    # 0 (the default) means "the target itself" and costs nothing — no coordinates
    # are read and no KD-tree is built.
    try:
        within = float(params.get("within", 0.0))
    except (TypeError, ValueError):
        raise ValueError(f'hide_res: around must be a distance in scene coordinate units, got "{{params.get("around")}}".')
    if within < 0:
        raise ValueError(f"hide_res: around must be a positive distance in scene coordinate units, got {{around}}.")
    keep = params.get("keep", False)
    if not isinstance(keep, bool):
        raise ValueError(f'hide_res: scope must be "exclude" or "include", got "{{scope}}".')
    if within > 0:
        target_indices = _around(data, target_indices, within, keep)

    expr = _index_expr(target_indices, data.give_header().n_points)
    return [
        f"pointopacity {expr} {opacity}",
        f"bondopacityof {expr} {opacity}",
    ]
