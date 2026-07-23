# molaro-mod
# name: smooth
# kind: analysis
# produces: commands
# requires-channel: smoothing
# param: window number 3
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: One command to make a region's motion read smoothly instead of jittery — a temporal moving average over the positions. `smooth <region> ?window=N` replaces each targeted point's shown position with the mean of its positions over ±N frames (higher N = smoother; N=0 is a no-op). Runs the `smoothing` provider on the region, then binds it to the offset axis. Undoable in one step; re-run with a new window or region to change it.

# THE MACRO half of the two-mod smoothing pair (like cartoon over ribbon_dir).
#
# ONE INVOCATION. `# requires-channel: smoothing` means the viewer runs the
# `smoothing` provider FIRST (declaring the offset channel for the region and
# the chosen window), and only then runs this mod, which binds that channel to
# the offset axis. So `smooth <region>` is the whole thing — you do not bind by
# hand.
#
# HOW THE LEVEL REACHES THE COMPUTATION. `smooth` and `smoothing` both declare
# `# param: window`. When the provider is auto-run for this consumer, the
# consumer's parameter values are forwarded to the provider for any name it also
# declares — so `smooth region ?window=7` computes a ±7-frame average, not the
# default. (This mod does not itself read `window`; it declares it only so the
# invocation accepts it and it forwards.)
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


def compute(data, target_indices, params):
    # A `produces: commands` mod: bind the (already-computed) smoothing channel
    # to the offset axis. `smoothing` is guaranteed present — its provider ran
    # first via requires-channel — and is zero outside the smoothed region, so
    # `all` is the correct, economical target.
    return ["bind all smoothing offset"]
