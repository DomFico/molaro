# molaro-mod
# name: live_sasa
# kind: analysis
# produces: commands
# requires-channel: sasa_field
# param: palette string auto
# param: within number 0
# param: keep boolean false
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: ONE COMMAND that makes the backbone trace's colour FOLLOW THE TRAJECTORY by solvent accessibility — it binds the per-frame `sasa_field` channel to the trace's colour axis, and a bound axis re-derives on every frame flip, so a residue that buries itself darkens as it does. The provider runs automatically. It MATCHES its static twin `cartoon ?colorby=sasa`: both read through the same diverging blue-white-red ramp with HIGH = RED. It replaces the trace COLOUR and nothing else — no widths, no shapes, no orientation: run `cartoon` for the look, then this to animate the colour (it also stands alone; the trace draws as a tube by default). TARGET-SCOPED: `live_sasa polymer.A` animates that chain only. `?palette=<name>` overrides the ramp (`palettes` lists them). Colouring one target with this and another with `live_ss` puts two different quantities through one ramp in one picture, with nothing on screen to tell them apart.

# THE CONSUMER half of a provider/consumer pair: `# requires-channel:` makes the
# viewer run `sasa_field` FIRST and then this, so the user types one command. It is a
# separate mod from `cartoon` because a mod produces ONE thing and `cartoon` spends
# its channel slot on `ribbon_dir`.
#
# ONE QUANTITY PER MOD, which is why there is no `?colorby` here. A parameter that
# forwarded a choice to one shared channel would bind the OTHER quantity under the
# asked-for name, because a bare re-invocation does not re-run a provider. Switching
# to `live_ss` asks for a DIFFERENT channel, and a missing channel IS the re-run
# trigger; when it does not fire, `sasa_field` holds the only quantity its provider
# computes. Nothing left to guard, so nothing here guards it.
#
# THE HONEST LIMIT: sequencing is ordering, not atomicity. The channel declaration is
# append-only and not undoable; one Ctrl+Z reverses this mod's bind (the trace returns
# to whatever colour it last had), not the declaration.

import re
from collections import defaultdict

CHANNEL = "sasa_field"
AXIS = "tracecolor"
RANGE = ("0", "1")
# The ramp the STATIC twin reads through, so live and static are the same picture:
# cartoon's continuous schemes ramp blue -> white -> red with HIGH = red, which is
# `bluewhitered`'s reading (endpoint hexes pure blue/red against cartoon's
# #0053d6/#d60000).
DEFAULT_PALETTE = "bluewhitered"
# webview/palettes.ts PALETTE_NAME_RE, mirrored. Kept `string` rather than `choice`
# because the palette registry is open-ended and a hardcoded option list would go
# stale — but a value that cannot BE a name (one carrying a space) would shift the
# emitted bind's own grammar and be blamed on argument ORDER instead of the name.
_NAME_OK = re.compile(r"^[a-z][a-z0-9_-]*$")


def _ranges(nums):
    """Consecutive residue numbers as `a-b,c-d` — the grammar's range predicate.
    Always `a-b` even for one residue, so it is never read as a subgroup name."""
    out, start, prev = [], None, None
    for n in sorted(set(nums)):
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append((start, prev))
            start = prev = n
    if start is not None:
        out.append((start, prev))
    return ",".join(f"{a}-{b}" for a, b in out)


def compute(data, target_indices, params=None):
    # `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named, whole
    # subgroups at a time; `?keep=true` brings the target itself along. The distance
    # is in the SCENE'S COORDINATE UNITS — one implementation, one unit, shared with
    # the built-in `create_sele`/`hide` flags (producer/source.py `neighborhood`).
    # 0 (the default) means "the target itself" and costs nothing.
    _p = params or {}
    try:
        _within = float(_p.get("within", 0.0))
    except (TypeError, ValueError):
        raise ValueError(f'live_sasa: within must be a distance in scene units, got "{_p.get("within")}".')
    if _within < 0:
        raise ValueError(f"live_sasa: within must be a positive distance, got {_within}.")
    _keep = _p.get("keep", False)
    if not isinstance(_keep, bool):
        raise ValueError(f'live_sasa: keep must be true or false, got "{_keep}".')
    if _within > 0:
        target_indices = data.neighborhood(target_indices, _within, _keep)

    # `params` is None for a RAW caller; the viewer always forwards the complete
    # effective set with every declared default filled in.
    params = params or {}
    palette = str(params.get("palette", "auto")).strip()
    if palette.lower() in ("", "auto"):
        palette = DEFAULT_PALETTE
    elif not _NAME_OK.match(palette):
        raise ValueError(
            f"live_sasa: ?palette={palette!r} is not a palette NAME — a name is "
            "lowercase letters, digits, `_` and `-`, starting with a letter. Run "
            "`palettes` for the registered ramps, or drop the parameter for the "
            f"default ({DEFAULT_PALETTE})."
        )
    traj = data.trajectory
    if traj is None:
        raise ValueError(
            "live_sasa needs coordinates that change with the frame, and this source "
            "has no trajectory (data.trajectory is None). The synthetic source has "
            "no chemistry at all — there is no solvent accessibility here to follow."
        )
    n_frames = int(traj.n_frames)
    if n_frames < 2:
        raise ValueError(
            f"live_sasa: this dataset has {n_frames} frame, so there is nothing for "
            "the colouring to follow — a bound channel re-derives on every frame FLIP "
            "and nothing ever flips here. Use `cartoon ?colorby=sasa` for the static "
            "picture."
        )
    top = traj.topology
    header = data.give_header()

    # A residue is coloured only if it owns a TRACE VERTEX: a bind over a residue the
    # producer threaded into no polyline would match nothing while this reported
    # success.
    anchor_res = {top.atom(v).residue.index for poly in header.polylines for v in poly}
    if target_indices:
        anchor_res &= {top.atom(i).residue.index
                       for i in target_indices if 0 <= i < top.n_atoms}
    if not anchor_res:
        raise ValueError(
            "live_sasa colours the backbone TRACE, and nothing in this target draws "
            f"one: the producer drew {len(header.polylines)} polyline(s) over this "
            "system and no residue in scope owns a vertex on any of them. A residue "
            "with no trace anchor, a stretch too short to draw a line through, and a "
            "coarse-grained bead model all land here."
        )
    # Address each residue through the viewer's own labels, so this works whatever the
    # chains are called: the trailing integer of a subgroup label ("ASP 33" -> 33) is
    # what the range predicate matches. Same disclosed hole as `cartoon` — two drawn
    # residues in one chain carrying the SAME number collapse into one.
    res_key = {}
    for atom in top.atoms:
        ridx = atom.residue.index
        if ridx in res_key or ridx not in anchor_res or atom.index >= len(data.labels):
            continue
        category, group, subgroup = data.labels[atom.index]
        try:
            res_key[ridx] = (category, group, int(str(subgroup).split()[-1]))
        except (ValueError, IndexError):
            continue                                       # no trailing number; skip
    if not res_key:
        raise ValueError(
            "live_sasa: could not address any residue through data.labels — no "
            "subgroup label of a drawn residue carried a trailing residue number, "
            "which is what the grammar's range predicate matches."
        )
    # ONE bind per (category, group), over exactly the residues in scope. A bound
    # colour axis re-derives from the channel on every frame flip — that is the whole
    # mechanism, and the reason the field is a channel and this a command.
    buckets = defaultdict(list)
    for ridx in sorted(res_key):
        category, group, num = res_key[ridx]
        buckets[(category, group)].append(num)
    lo, hi = RANGE
    return [f"bind {category}.{group}.{_ranges(buckets[(category, group)])} "
            f"{CHANNEL} {AXIS} {lo} {hi} ?palette={palette}"
            for category, group in sorted(buckets)]
