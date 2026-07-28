# molaro-mod
# name: frame_metric
# kind: analysis
# produces: per-frame-series
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — the first target point's distance from the origin, per frame

import struct


def compute(data, target_indices):
    """One raw value per frame: |position| of the first target point.

    Reads frames in small chunks off the resident dataset handle (positions
    are little-endian float32 bytes, frame-major). Raw values — the plot
    auto-scales; no normalization here.
    """
    header = data.give_header()
    n_frames = header.n_frames
    n_points = header.n_points
    p = target_indices[0] if target_indices else 0
    values = []
    start = 0
    step = 25
    while start < n_frames:
        count = min(step, n_frames - start)
        chunk = data.give_frames(start, count)
        for f in range(count):
            off = ((f * n_points) + p) * 3 * 4  # byte offset of point p in frame f
            x, y, z = struct.unpack_from("<3f", chunk.positions, off)
            values.append((x * x + y * y + z * z) ** 0.5)
        start += count
    return values
