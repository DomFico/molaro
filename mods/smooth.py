# molaro-mod
# name: smooth
# kind: analysis
# produces: commands
# requires-channel: smoothing
# param: smoothing number 5
# param: within number 0
# param: keep boolean false
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: One command to make a region's motion read smoothly instead of jittery — a temporal moving average over the positions. `smooth <region> ?smoothing=N` replaces each targeted point's shown position with the mean of its own positions over N frames — the same number VMD's trajectory-smoothing control shows. 5 averages 5 frames; higher is smoother; 0 is off. An even N rounds down to the nearest odd, because a centred average over an even count cannot be symmetric. Runs the `smoothing` provider on the region, then binds it to the offset axis. COMBINES WITH `align` in either order: the average is taken over the aligned positions, so a tumbling trajectory smooths cleanly. IT ACCUMULATES BY REGION: `smooth @a` then `smooth @b` leaves BOTH smoothed, because a region you do not name keeps the smoothing it already had. Re-running on the SAME region replaces that region's smoothing (so `smooth @a ?smoothing=0` stops @a alone, and `smooth all ?smoothing=0` stops everything). Undoable in one step.

# THE MACRO half of the two-mod smoothing pair (like cartoon over ribbon_dir).
#
# ONE INVOCATION. `# requires-channel: smoothing` means the viewer runs the
# `smoothing` provider FIRST (declaring the offset channel for the region and
# the chosen window), and only then runs this mod, which binds that channel to
# the offset axis. So `smooth <region>` is the whole thing — you do not bind by
# hand.
#
# HOW THE LEVEL REACHES THE COMPUTATION. `smooth` and `smoothing` both declare
# `# param: smoothing`. When the provider is auto-run for this consumer, the
# consumer's parameter values are forwarded to the provider for any name it also
# declares — so `smooth region ?smoothing=7` computes a 7-frame average, not the
# default. (This mod does not itself read `smoothing`; it declares it only so the
# invocation accepts it and it forwards.)
#
# WHY A SECOND RUN NO LONGER STOPS THE FIRST.
#
# `smoothing` is ONE channel — one column of values — and a provider run rewrites
# the whole column. It used to zero every point it was not asked about, so
# `smooth @a` then `smooth @b` ended with @a's offsets gone and only @b moving
# (measured: A alone 19 points, B afterwards 12 with A stopped). That was not a
# choice: a mod could not READ a channel, so a provider had no way to see what a
# previous run had smoothed, and nothing to preserve.
#
# `data.channel("smoothing")` is that read, and the provider now starts from the
# column as it stands and overwrites only the rows its target names. So
# `smooth @a` then `smooth @b` leaves both smoothed, and `smooth @a + @b` — still
# the way to say "these, at this level, in one step" — remains equivalent for a
# first run. Re-running on the SAME region replaces that region (it is not
# additive: an offset is a position, and two averages summed is not an average),
# which makes `?smoothing=0` a targeted OFF switch.
#
# WHY BIND `all`. `smoothing` is a whole-system channel that is ZERO outside the
# region it was told to smooth, so binding it over `all` displaces exactly that
# region (every other point gets a zero offset and stays put). Binding `all`
# also avoids emitting a giant `#index` target string for a large region.
#
# THE HONEST LIMIT: sequencing is ordering, not atomicity. The provider's
# channel declaration is append-only and not undoable; one Ctrl+Z reverses this
# mod's bind (the offset zeroes, positions snap back to raw), not the
# declaration. Re-running `smooth` recomputes the channel in place and re-binds.


_MOTION_CHANNELS = ("aligning", "smoothing")


def _current_motion_channel(data, own):
    st = getattr(data, "_molaro_motion", None)
    if not isinstance(st, dict):
        return own, None
    cur = [c for c in _MOTION_CHANNELS
           if st["computed"].get(c) == st["version"] and data.channel(c) is not None]
    return (own if own in cur else (cur[0] if cur else own)), st


def compute(data, target_indices, params):
    # `?within`/`?keep` are DECLARED here so the invocation accepts them and the
    # sequencer forwards them to `smoothing` — which is where they act.
    #
    # WHICH CHANNEL. `smoothing` and `aligning` both write the full combination
    # smooth(align(raw)) from shared state; the state's version says which was
    # computed last. The viewer skips the provider when target and parameters are
    # unchanged, so a repeat `smooth` after an `align` must bind `aligning`'s
    # (current) channel, not its own stale one — or the alignment would vanish.
    ch, st = _current_motion_channel(data, "smoothing")
    cmds = [f"bind all {ch} offset"]
    if st is not None:
        n_s = int((st["smooth_half"] > 0).sum())
        n_a = int((st["align_layer"] >= 0).sum())
        cmds.append(f"note smooth: {n_s} points smoothed" +
                    (f", on top of the alignment of {n_a} points." if n_a else "."))
        if data.channel("ribbon_dir") is not None and st["computed"].get("ribbon_dir") != st["version"]:
            cmds.append("note cartoon ribbons were oriented for the previous motion — run `ribbon_dir` to "
                        "re-orient them (tube style needs nothing).")
    return cmds
