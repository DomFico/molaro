# molaro-mod
# name: show_res
# kind: analysis
# produces: commands
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Bring back a target's ATOMS AND ITS BONDS in one stroke — the other half of `hide_res`. Restores points and every edge with at least one endpoint in the target to full opacity. Bare `show_res`, with no target, restores the WHOLE system, which is the quick way out when you have hidden your way into a corner. Like `hide_res` this writes opacity and creates no selection, so it never touches your selection list; and it does not undo a built-in `hide` (that is a selection flag — use `show` for those).

# THE ASYMMETRY WITH hide_res IS DELIBERATE.
#
# `hide_res` refuses an empty (whole-system) target, matching the built-in `hide`'s
# own refusal — "there is no hide everything" — because hiding the entire scene by
# accident is a bad five seconds. `show_res` ACCEPTS it, because "put everything
# back" is the useful half of that pair and is the natural thing to type when you
# have faded more than you meant to.
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


def _index_expr(target_indices):
    """`target_indices` -> a `#` member expression, as COMPACT CONTIGUOUS RANGES.

    Kept identical to `hide_res`'s helper on purpose: the two mods must agree about
    what a target MEANS, or showing would not exactly undo hiding. Indices rather
    than label paths, so a single-atom target is not rounded up to its residue.
    """
    idx = sorted({int(i) for i in target_indices})
    if not idx:
        return None
    parts, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i == prev + 1:
            prev = i
            continue
        parts.append(f"{start}-{prev}" if prev > start else f"{start}")
        start = prev = i
    parts.append(f"{start}-{prev}" if prev > start else f"{start}")
    return "#" + ",".join(parts)


def compute(data, target_indices, params=None):
    # Empty target = the whole system (the mod contract). `all` is the grammar's
    # own keyword for that and is cheaper than emitting a range covering every
    # point, so a bare `show_res` is two short commands however large the system is.
    expr = _index_expr(target_indices) or "all"
    return [
        f"pointopacity {expr} {SHOWN_OPACITY}",
        f"bondopacityof {expr} {SHOWN_OPACITY}",
    ]
