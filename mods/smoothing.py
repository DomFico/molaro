# molaro-mod
# name: smoothing
# kind: analysis
# produces: channel
# channel: smoothing
# param: smoothing number 5
# param: within number 0
# param: keep boolean false
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: The offset half of `smooth` — a per-point-per-frame DISPLACEMENT that, bound to the offset axis, replaces each point's shown position with a temporal MOVING AVERAGE of its own positions over `smoothing` frames (VMD's trajectory-smoothing number: 5 averages 5 frames, 0 is off) (shown = raw + offset = windowed mean). Higher = smoother. Runs automatically when you invoke `smooth`; you rarely call it by hand.

# THE PROVIDER half of the two-mod smoothing pair (like ribbon_dir under
# cartoon). It produces a `per_point_per_frame` VECTOR channel; `smooth` (a
# `produces: commands` macro) declares `# requires-channel: smoothing`, so
# running `smooth <region>` runs THIS first and then binds the result to the
# offset axis — one invocation, not two.
#
# WHY A CHANNEL AT ALL. The offset axis draws `shown = raw + offset`, taking the
# offset from a 3-wide channel bound to it. To move a point onto its own
# windowed-mean position we supply, per point per frame, the vector FROM the raw
# position TO that mean: offset = windowed_mean(position) - position. With
# nothing bound the offset buffer is zero and every point sits at its raw
# position (no smoothing) — which is why smoothing must be a channel, and why
# one mod cannot both compute it and bind it (a mod produces one thing).
#
# THE MATH IS PURE SIGNAL PROCESSING — a boxcar (uniform) moving average over
# the time axis of a position signal. It says nothing about what the points are.
#
# WHOLE-SYSTEM CHANNEL, TARGETED EFFORT. A channel's length is always the whole
# system (n_frames * n_points * 3); `target_indices` only chooses WHICH points
# are worth smoothing. Points outside the target get a ZERO offset (they stay at
# their raw position), so binding the channel over `all` displaces exactly the
# targeted region and leaves everything else untouched. An empty target (a bare
# `smooth`) smooths every point.
#
# EDGE POLICY. The window is CENTERED with half-width `window`: frame t averages
# frames [t-window, t+window]. Near the ends that range is CLAMPED to
# [0, n_frames-1] and the average is taken over the frames that exist — a valid
# partial (shrinking) window at t < window and t > n_frames-1-window, never a
# wrap and never a pad. window = 0 is the identity (each frame averages only
# itself, so every offset is zero).
#
# VECTORIZED. The windowed mean is a prefix-sum (cumsum) difference, O(T*N) with
# no Python per-frame loop, so a full trajectory stays well under the run_mod
# timeout even at scale. The offset is returned as a numpy array (not a boxed
# Python list) to keep the full-size N*T*3 block cheap in memory.

import numpy as np


def compute(data, target_indices, params):
    # `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named, whole
    # subgroups at a time; `?keep=true` brings the target itself along. Distance is
    # in the SCENE'S COORDINATE UNITS (producer/source.py `neighborhood` — one
    # implementation, one unit, shared with the built-in create_sele/hide flags).
    #
    # IT LIVES IN THE PROVIDER, not in `smooth`. The sequencer runs this mod FIRST
    # and `smooth` afterwards, and `smooth` only emits `bind all` — it never uses
    # its own target. So an expansion done there computed the right neighbourhood
    # and then threw it away: the channel had already been built from the
    # un-expanded target and everything moved. The mask below is what actually
    # scopes the effect, so the expansion has to happen before it.
    _p = params or {}
    try:
        _within = float(_p.get("within", 0.0))
    except (TypeError, ValueError):
        raise ValueError(f'smoothing: within must be a distance in scene units, got "{_p.get("within")}".')
    if _within < 0:
        raise ValueError(f"smoothing: within must be a positive distance, got {_within}.")
    _keep = _p.get("keep", False)
    if not isinstance(_keep, bool):
        raise ValueError(f'smoothing: keep must be true or false, got "{_keep}".')
    if _within > 0:
        target_indices = data.neighborhood(target_indices, _within, _keep)

    header = data.give_header()
    n, t = header.n_points, header.n_frames

    # `window` is the level. It arrives from `smooth`'s own `?window=` (forwarded
    # to this provider) or falls back to the declared default. Half-width in
    # frames; clamp negatives to 0 (identity) so a stray value never raises.
    # `smoothing` is HOW MANY FRAMES ARE AVERAGED — the number VMD's trajectory
    # smoothing slider shows — not the half-width. Internally the mean needs a
    # half-width, so n frames becomes ±(n-1)//2, i.e. an even n rounds DOWN to the
    # nearest odd (4 -> 3 frames). A centred average over an even count would have
    # to lean one frame to the past or the future; rounding down is the choice that
    # keeps it symmetric, and it is stated rather than silently applied.
    # 0 and 1 both mean OFF (a 1-frame average is the identity).
    # NOT named `n` — that is the point count a few lines down, and reusing it
    # reshaped the position buffer to zero atoms.
    frames_avg = int(round(params["smoothing"]))
    if frames_avg < 0:
        frames_avg = 0
    window = max(0, (frames_avg - 1) // 2)

    # Positions over EVERY frame, source-agnostic: give_frames is the neutral
    # protocol both the synthetic and the real source answer, so this reads raw
    # positions the same way regardless of what backs the dataset. frame-major
    # (t, n, 3) little-endian float32; reduce in float64 (a long cumsum in
    # float32 cancels catastrophically).
    chunk = data.give_frames(0, t)
    pos = np.frombuffer(chunk.positions, dtype="<f4").reshape(t, n, 3).astype(np.float64)

    # Centered moving average with a clamped (shrinking) window at the ends,
    # done as a prefix-sum difference. csum[k] = sum of frames [0, k); the sum
    # over the inclusive window [lo, hi] is csum[hi+1] - csum[lo].
    csum = np.concatenate([np.zeros((1, n, 3)), np.cumsum(pos, axis=0)], axis=0)
    frames = np.arange(t)
    lo = np.maximum(frames - window, 0)
    hi = np.minimum(frames + window, t - 1)
    counts = (hi - lo + 1).astype(np.float64)
    smoothed = (csum[hi + 1] - csum[lo]) / counts[:, None, None]

    # The displacement that carries each point from raw onto its windowed mean.
    offset = smoothed - pos  # (t, n, 3); shown = raw + offset = smoothed

    # Zero the offset OUTSIDE the target: same whole-system length, effort only
    # where asked. An empty target means the whole system (no masking).
    if target_indices:
        keep = np.zeros(n, dtype=bool)
        keep[np.asarray(target_indices, dtype=int)] = True
        offset[:, ~keep, :] = 0.0

    # Return the ndarray directly (components=3). install_channel accepts a numpy
    # array and stores it without boxing an N*T*3 Python list.
    return {"values": np.ascontiguousarray(offset, dtype="<f4"), "components": 3}
