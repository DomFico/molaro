# molaro-mod
# name: hide_res
# kind: analysis
# produces: commands
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Hide a target's ATOMS AND ITS BONDS in one stroke — one Ctrl+Z puts it all back. Fades the points to opacity 0 and every edge with AT LEAST ONE endpoint in the target, which is the same rule the renderer itself uses for a hidden point ("edges drop when either endpoint hides"), so the bonds joining the target to its neighbours go too instead of dangling into nothing. Use `show_res` to bring it back. This is a REPRESENTATION change, not the built-in `hide`: it writes opacity and creates NO selection, so hiding twenty residues one at a time leaves your selection list exactly as it was. The trace is deliberately untouched, so a cartoon keeps its ribbon while the side chains go — hide the atoms, keep the fold.

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


def _index_expr(target_indices):
    """`target_indices` -> a `#` member expression, as COMPACT CONTIGUOUS RANGES.

    Indices, not label paths, on purpose: this acts on exactly the atoms the target
    resolved to. Going through `category.group.subgroup` would round a single-atom
    target up to its whole residue, which is a different command than the one the
    user typed. `#` takes ranges and comma lists (`#1-5,9,12-20`), so a residue is
    usually one or two terms and `all` collapses to a single range.
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
    # An EMPTY target means the whole system (the mod contract), and "hide
    # everything" is not a thing worth doing by accident — the built-in `hide`
    # refuses it in the same words for the same reason. `show_res` deliberately
    # DOES accept it, because "put everything back" is the useful half.
    expr = _index_expr(target_indices)
    if expr is None:
        raise ValueError(
            "hide_res needs a target — there is no \"hide everything\". "
            "Name what to hide (a residue, a chain, a selection); "
            "`show_res` with no target is the one that means everything."
        )
    return [
        f"pointopacity {expr} {HIDDEN_OPACITY}",
        f"bondopacityof {expr} {HIDDEN_OPACITY}",
    ]
