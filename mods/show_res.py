# molaro-mod
# name: show_res
# kind: analysis
# produces: commands
# param: within number 0
# param: keep boolean false
# param: opacity number 1.0
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Bring back a target's ATOMS AND ITS BONDS in one stroke — the other half of `hide_res`. Restores points and every edge with at least one endpoint in the target to full opacity. Bare `show_res`, with no target, restores the WHOLE system, which is the quick way out when you have hidden your way into a corner. Like `hide_res` this writes opacity and creates no selection, so it never touches your selection list; and it does not undo a built-in `hide` (that is a selection flag — use `show` for those). `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named, whole residues at a time, and `?keep=true` brings the target itself along. THE DISTANCE IS IN THE SCENE'S COORDINATE UNITS — the same number the built-in `create_sele`/`hide` flags take, so one flag name means one thing everywhere; for an mdtraj-backed source that is nanometres, so a 5 A shell is `?within=0.5`.

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
        raise ValueError(f'show_res: around must be a distance in scene coordinate units, got "{{params.get("around")}}".')
    if within < 0:
        raise ValueError(f"show_res: around must be a positive distance in scene coordinate units, got {{around}}.")
    keep = params.get("keep", False)
    if not isinstance(keep, bool):
        raise ValueError(f'show_res: scope must be "exclude" or "include", got "{{scope}}".')
    if within > 0:
        target_indices = data.neighborhood(target_indices, within, keep)

    expr = _index_expr(target_indices, data.give_header().n_points)
    return [
        f"pointopacity {expr} {opacity}",
        f"bondopacityof {expr} {opacity}",
    ]
