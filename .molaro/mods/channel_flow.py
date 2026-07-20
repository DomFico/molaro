# molaro-mod
# name: channel_flow
# kind: analysis
# produces: channel
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — a produced per-point-per-frame VECTOR channel, coherently seeded frame-to-frame

# THE TEMPLATE for `produces: channel`. Two things it is here to demonstrate,
# both first-class:
#
# 1. THE RETURN SHAPE. Return a dict declaring ONE per_point_per_frame channel:
#      {"name": str,
#       "values": [flat, frame-major floats],   # len = n_frames*n_points*components
#       "components": 1 | 3,                     # 3 = a VECTOR channel (default 1)
#       "min"?: float, "max"?: float}            # scalar-only range hint
#    Frame-major means: all points of frame 0, then all of frame 1, and so on;
#    within a point, a vector's `components` values are consecutive (x, y, z).
#    The values never ride the reply — the producer stores them and every
#    subsequent frame chunk carries the block, so the channel is bindable with
#    NO reload. Naming the channel names how the user will `bind` it.
#
# 2. FRAME-TO-FRAME COHERENCE — the part that is easy to get wrong. A produced
#    direction OWNS its coherence: the renderer draws exactly what you supply,
#    so a vector that flips sign between adjacent frames renders as a visible
#    one-frame twist (invisible on a scalar/colour channel, jarring on an
#    orientation). Compute each frame, then SEED it from the previous frame's
#    result — the correct case is the lazy case when you write it this way.


def _seed_coherent(vectors):
    """In place: make each frame's vectors point consistently with the frame
    before, by flipping any whose direction reversed (negative dot product).
    `vectors` is a list of frames; each frame is a list of (x, y, z) tuples.
    This is the whole discipline — a few lines, run once at the end."""
    for f in range(1, len(vectors)):
        prev, cur = vectors[f - 1], vectors[f]
        for p in range(len(cur)):
            a, b = prev[p], cur[p]
            if a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0.0:
                cur[p] = (-b[0], -b[1], -b[2])


def compute(data, target_indices):
    import math

    header = data.give_header()
    n, t = header.n_points, header.n_frames

    # Compute each frame INDEPENDENTLY first (the natural, wrong-on-its-own
    # way): an analytic direction whose sign wobbles frame to frame on purpose,
    # so the seeding step below has something real to fix. It means nothing and
    # must mean nothing — a channel is data, never appearance.
    per_frame = []
    for f in range(t):
        frame = []
        for p in range(n):
            a = 0.15 * f + 0.3 * p
            # cos(a) crosses zero as f advances → the x-component flips sign;
            # an un-seeded return would render that flip as a twist.
            frame.append((math.cos(a), math.sin(a), 0.5))
        per_frame.append(frame)

    # THE ONE STEP that makes it coherent. Delete it and the pipe will WARN
    # you (a count of sign inversions) — it never refuses, because coherence
    # is your responsibility, but it makes the breach loud instead of a
    # mystery twist in the viewer.
    _seed_coherent(per_frame)

    values = []
    for frame in per_frame:
        for x, y, z in frame:
            values.extend((x, y, z))

    return {"name": "flow_dir", "values": values, "components": 3}
