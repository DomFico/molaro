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
# description: One command to make a region's motion read smoothly instead of jittery — a temporal moving average over the positions. `smooth <region> ?smoothing=N` replaces each targeted point's shown position with the mean of its own positions over N frames — the same number VMD's trajectory-smoothing control shows. 5 averages 5 frames; higher is smoother; 0 is off. An even N rounds down to the nearest odd, because a centred average over an even count cannot be symmetric. Runs the `smoothing` provider on the region, then binds it to the offset axis. RE-RUNNING REPLACES, IT DOES NOT ADD: `smooth @a` then `smooth @b` leaves only @b smoothed. To smooth both, name both in ONE command — `smooth @a + @b` — because the address grammar unions with `+`. Undoable in one step.

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
# WHY A SECOND RUN REPLACES THE FIRST, and why that is not a choice this mod made.
#
# `smoothing` is ONE channel — one column of values — and a provider run REPLACES
# it. So `smooth @a` then `smooth @b` ends with @a's offsets zeroed and only @b
# moving. Measured: A alone moves 19 points, B alone moves 12 and A has stopped,
# `A + B` in one command moves 31 and covers both.
#
# Accumulating would mean adding to what is already there, and a mod CANNOT read
# an existing channel: `give_header()` reports `channels=[]`, so a provider has no
# way to see what a previous run smoothed. There is nothing to add onto. Until a
# mod can read channel values back, "smooth this as well" has exactly one spelling,
# and it is the union: `smooth @a + @b`.
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
    # `?within`/`?keep` are DECLARED here so the invocation accepts them and the
    # sequencer forwards them to `smoothing` — which is where they act. This mod
    # never reads them: it binds `all`, and the provider's mask is what scopes the
    # effect. Doing the expansion here computed the right set and discarded it.

    # A `produces: commands` mod: bind the (already-computed) smoothing channel
    # to the offset axis. `smoothing` is guaranteed present — its provider ran
    # first via requires-channel — and is zero outside the smoothed region, so
    # `all` is the correct, economical target.
    return ["bind all smoothing offset"]
