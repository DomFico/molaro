# molaro-mod
# name: delay_offset
# kind: analysis
# produces: channel
# channel: delay_offset
# param: frames number 5
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: The offset half of `delay` — a per-point-per-frame DISPLACEMENT that, bound to the offset axis, shows each point where it WAS `frames` frames earlier (shown = raw + offset = position from `frames` frames ago). Higher `frames` = a longer lag. Runs automatically when you invoke `delay`; you rarely call it by hand.

# THE PROVIDER half of the two-mod delay pair — the SECOND consumer of the
# offset axis, built to the identical rail as `smoothing`/`smooth`, with NO
# engine change. It produces a `per_point_per_frame` VECTOR channel; `delay` (a
# `produces: commands` macro) declares `# requires-channel: delay_offset`, so
# running `delay <region>` runs THIS first and then binds the result to the
# offset axis — one invocation, not two.
#
# WHY A CHANNEL AT ALL. The offset axis draws `shown = raw + offset`, taking the
# offset from a 3-wide channel bound to it. To place a point where it was `k`
# frames ago we supply, per point per frame, the vector FROM its raw position at
# frame t TO its raw position at frame t-k: offset[t] = raw[t-k] - raw[t], so
# shown[t] = raw[t] + offset[t] = raw[t-k]. With nothing bound the offset buffer
# is zero and every point sits at its raw position (no delay) — which is why the
# delay must be a channel, and why one mod cannot both compute it and bind it (a
# mod produces one thing).
#
# THE MATH IS PURE SIGNAL PROCESSING — a temporal shift (a lag / gather) of a
# position signal along the time axis. It says nothing about what the points are.
#
# WHOLE-SYSTEM CHANNEL, TARGETED EFFORT. A channel's length is always the whole
# system (n_frames * n_points * 3); `target_indices` only chooses WHICH points
# are worth delaying. Points outside the target get a ZERO offset (they stay at
# their raw position), so binding the channel over `all` displaces exactly the
# targeted region and leaves everything else untouched. An empty target (a bare
# `delay`) delays every point.
#
# EDGE POLICY (documented, not incidental). Frame t shows raw[t-k]. When t-k < 0
# (the first `frames` frames, for which there is no earlier position) we HOLD the
# EARLIEST available frame: the source index is CLAMPED to 0, so offset[t] =
# raw[0] - raw[t] and shown[t] = raw[0]. No wrap, no pad — the region simply sits
# at its starting position until enough history exists, then the lag takes over.
# frames = 0 is the identity (t-0 = t, so every offset is exactly zero).
#
# VECTORIZED. The lag is a single fancy-index GATHER along the time axis (the
# clamped source indices pick whole frames at once), O(T*N) with no Python
# per-frame loop, so a full trajectory stays well under the run_mod timeout even
# at scale. The offset is returned as a numpy array (not a boxed Python list) to
# keep the full-size N*T*3 block cheap in memory.

import numpy as np


def compute(data, target_indices, params):
    header = data.give_header()
    n, t = header.n_points, header.n_frames

    # `frames` is the lag. It arrives from `delay`'s own `?frames=` (forwarded to
    # this provider) or falls back to the declared default. Whole frames; clamp
    # negatives to 0 (identity) so a stray value never raises.
    k = int(round(params["frames"]))
    if k < 0:
        k = 0

    # Positions over EVERY frame, source-agnostic: give_frames is the neutral
    # protocol both the synthetic and the real source answer, so this reads raw
    # positions the same way regardless of what backs the dataset. frame-major
    # (t, n, 3) little-endian float32; the subtraction is done in float64 so the
    # difference of two float32 positions is formed exactly before it is stored.
    chunk = data.give_frames(0, t)
    pos = np.frombuffer(chunk.positions, dtype="<f4").reshape(t, n, 3).astype(np.float64)

    # The lag as a whole-frame gather: frame t reads frame t-k, clamped to 0 at
    # the start so the earliest position is held while there is no history yet.
    src = np.clip(np.arange(t) - k, 0, t - 1)   # (t,) source frame per frame
    delayed = pos[src]                          # (t, n, 3) raw[t-k] (or raw[0])

    # The displacement that carries each point from raw[t] onto raw[t-k].
    offset = delayed - pos  # (t, n, 3); shown = raw + offset = raw[t-k]

    # Zero the offset OUTSIDE the target: same whole-system length, effort only
    # where asked. An empty target means the whole system (no masking).
    if target_indices:
        keep = np.zeros(n, dtype=bool)
        keep[np.asarray(target_indices, dtype=int)] = True
        offset[:, ~keep, :] = 0.0

    # Return the ndarray directly (components=3). install_channel accepts a numpy
    # array and stores it without boxing an N*T*3 Python list.
    return {"values": np.ascontiguousarray(offset, dtype="<f4"), "components": 3}
