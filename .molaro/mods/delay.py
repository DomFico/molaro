# molaro-mod
# name: delay
# kind: analysis
# produces: commands
# requires-channel: delay_offset
# param: frames number 5
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: One command to make a region trail its own past — a temporal LAG over the positions. `delay <region> ?frames=N` shows each targeted point where it was N frames earlier (higher N = a longer lag; N=0 is a no-op). Runs the `delay_offset` provider on the region, then binds it to the offset axis. Undoable in one step; re-run with a new lag or region to change it.

# THE MACRO half of the two-mod delay pair — the SECOND consumer of the offset
# axis, on the SAME rail as `smooth`/`smoothing`, with NO engine change. That is
# the whole point of it existing: a new position effect is a new pair of mods,
# not a new foundation.
#
# ONE INVOCATION. `# requires-channel: delay_offset` means the viewer runs the
# `delay_offset` provider FIRST (declaring the offset channel for the region and
# the chosen lag), and only then runs this mod, which binds that channel to the
# offset axis. So `delay <region>` is the whole thing — you do not bind by hand.
#
# HOW THE LEVEL REACHES THE COMPUTATION. `delay` and `delay_offset` both declare
# `# param: frames`. When the provider is auto-run for this consumer, the
# consumer's parameter values are forwarded to the provider for any name it also
# declares — so `delay region ?frames=8` computes an 8-frame lag, not the
# default. (This mod does not itself read `frames`; it declares it only so the
# invocation accepts it and it forwards.)
#
# WHY BIND `all`. `delay_offset` is a whole-system channel that is ZERO outside
# the region it was told to delay, so binding it over `all` displaces exactly
# that region (every other point gets a zero offset and stays put). Binding `all`
# also avoids emitting a giant `#index` target string for a large region.
#
# THE HONEST LIMIT: sequencing is ordering, not atomicity. The provider's
# channel declaration is append-only and not undoable; one Ctrl+Z reverses this
# mod's bind (the offset zeroes, positions snap back to raw), not the
# declaration. Re-running `delay` recomputes the channel in place and re-binds.


def compute(data, target_indices, params):
    # A `produces: commands` mod: bind the (already-computed) delay channel to
    # the offset axis. `delay_offset` is guaranteed present — its provider ran
    # first via requires-channel — and is zero outside the delayed region, so
    # `all` is the correct, economical target.
    return ["bind all delay_offset offset"]
