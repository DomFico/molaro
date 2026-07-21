# molaro-mod
# name: xy_metric
# kind: analysis
# produces: scatter
# param: x_label string dist_a
# param: y_label string dist_b
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — two per-frame quantities plotted against each other; axis labels are tunable

import struct


def compute(data, target_indices, params=None):
    """A scatter with the frame sync hook: x = |position| of the first
    target point, y = |position| of the second, one (x, y) per frame.

    Returns the scatter dict {x, y, frames, xLabel, yLabel} — raw values,
    the plot auto-scales both axes.

    Parameters (P-1): `x_label` / `y_label` (STRING) name the two axes — the
    thing a user re-labels for their own plot; values may contain spaces
    (`?x_label=distance to origin`). `params=None` keeps the raw 2-arg producer
    path (the corpus) behaving exactly as before.
    """
    p = params or {}
    x_label = p.get("x_label", "dist_a")
    y_label = p.get("y_label", "dist_b")
    header = data.give_header()
    n_frames = header.n_frames
    n_points = header.n_points
    a = target_indices[0] if len(target_indices) > 0 else 0
    b = target_indices[1] if len(target_indices) > 1 else a
    xs, ys = [], []

    def norm(chunk, f, p):
        off = ((f * n_points) + p) * 3 * 4
        x, y, z = struct.unpack_from("<3f", chunk.positions, off)
        return (x * x + y * y + z * z) ** 0.5

    start = 0
    step = 25
    while start < n_frames:
        count = min(step, n_frames - start)
        chunk = data.give_frames(start, count)
        for f in range(count):
            xs.append(norm(chunk, f, a))
            ys.append(norm(chunk, f, b))
        start += count
    return {
        "x": xs,
        "y": ys,
        "frames": list(range(n_frames)),
        "xLabel": x_label,
        "yLabel": y_label,
    }
