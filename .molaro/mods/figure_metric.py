# molaro-mod
# name: figure_metric
# kind: analysis
# produces: figure
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — a rendered two-panel figure with a live playhead on the frames panel

def _figure_reply(fig, frames_axes):
    """THE TEMPLATE: emit the figure reply MECHANICALLY from the figure
    object — never hand-compute the metadata (a wrong bbox or xlim means a
    plausible-looking, silently misaligned playhead).

    fig          the matplotlib Figure, fully laid out (call it LAST)
    frames_axes  the set of Axes whose x IS the frame index
    """
    import io
    import base64
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=100)
    w = int(round(fig.get_size_inches()[0] * fig.dpi))
    h = int(round(fig.get_size_inches()[1] * fig.dpi))
    return {
        "png": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": w,
        "height": h,
        "axes": [
            {
                "bbox": [float(v) for v in ax.get_position().bounds],
                "xlim": [float(v) for v in ax.get_xlim()],
                "x_is_frames": ax in frames_axes,
            }
            for ax in fig.axes
        ],
    }


def compute(data, target_indices):
    """A two-panel figure: TOP = a per-frame quantity (mean |position| of
    the target) — its x is frames, so the playhead rides it and clicking
    seeks; BOTTOM = a histogram of the same values — a static panel, no
    playhead. Any matplotlib figure works; only _figure_reply matters.
    """
    import struct
    import matplotlib
    matplotlib.use("Agg")  # never a display; the producer renders headless
    import matplotlib.pyplot as plt

    header = data.give_header()
    n_frames = header.n_frames
    n_points = header.n_points
    targets = list(target_indices) if target_indices else [0]

    values = []
    chunk = None
    for f in range(n_frames):
        if chunk is None or f >= chunk.start + chunk.count:
            chunk = data.give_frames(f, min(64, n_frames - f))
        total = 0.0
        for p in targets:
            off = (((f - chunk.start) * n_points) + p) * 3 * 4
            x, y, z = struct.unpack_from("<3f", chunk.positions, off)
            total += (x * x + y * y + z * z) ** 0.5
        values.append(total / len(targets))

    fig, (top, bottom) = plt.subplots(2, 1, figsize=(6.4, 4.0))
    top.plot(range(n_frames), values)
    top.set_xlim(0, n_frames - 1)
    top.set_xlabel("frame")
    top.set_ylabel("mean |position|")
    bottom.hist(values, bins=24)
    bottom.set_xlabel("mean |position|")
    bottom.set_ylabel("count")
    fig.tight_layout()
    reply = _figure_reply(fig, frames_axes={top})
    plt.close(fig)
    return reply
