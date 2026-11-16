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
# description: The offset half of `smooth` — remembers a temporal MOVING AVERAGE over `smoothing` frames for the targeted points (VMD's trajectory-smoothing number: 5 averages 5 frames, 0 is off) and writes the COMBINED displacement for the offset axis: any `align` first, then the average over the aligned positions (shown = smooth(align(raw))). Runs automatically when you invoke `smooth`; you rarely call it by hand.

# THE PROVIDER half of the two-mod smoothing pair (like ribbon_dir under
# cartoon). `smooth` declares `# requires-channel: smoothing`, so `smooth
# <region>` runs THIS first and then binds the result to the offset axis.
#
# WHY IT NOW KNOWS ABOUT `align`. The offset axis is last-bind-wins per point, and
# this mod used to average RAW positions. After `align`, binding it threw the
# alignment away AND averaged a tumbling molecule over many orientations — a
# jumble. Now the pure parts (each point's window, and the alignment transforms
# `aligning` computed) are remembered on the dataset handle (the MOTION STATE
# block, identical in aligning.py), and every run writes the full combination
# smooth(align(raw)) - raw. Smoothing after alignment is the order that means
# something: an average of positions is only meaningful in a frame where the
# molecule is not tumbling.
#
# THE MATH is a boxcar (uniform) moving average over the time axis, CENTRED with
# half-width (smoothing-1)//2, the window CLAMPED at the ends (a shrinking,
# never wrapped or padded window), done as a prefix-sum difference in float64.
#
# IT ACCUMULATES BY REGION. Each point's window is remembered: `smooth @a` then
# `smooth @b` leaves both smoothed; re-running on the same region REPLACES its
# window (not additive — two averages summed is not an average), so
# `smooth @a ?smoothing=0` stops @a alone. An empty target means every point.
#
# `smoothing` is HOW MANY FRAMES ARE AVERAGED, not the half-width: an even count
# rounds DOWN to the nearest odd (4 -> 3) so the window stays symmetric; 0 and 1
# both mean off.

import numpy as np

# ==== MOTION STATE — shared by aligning.py and smoothing.py; KEEP IDENTICAL ====
# State lives on the resident dataset handle, so it lasts exactly as long as the
# channels it explains (a new dataset is a new handle: no state, no channels).
#   align_layers: list of (R (t,3,3), cx (t,3), cy (3,)) rigid transforms
#   align_layer:  (n,) int, which layer moves each point, -1 = not aligned
#   smooth_half:  (n,) int, half-width of each point's centred moving average
#   version:      bumped by every provider run; computed[ch] = version it saw
_MOTION_SCHEMA = 2


def _motion_state(data, t, n):
    st = getattr(data, "_molaro_motion", None)
    if not isinstance(st, dict) or st.get("schema") != _MOTION_SCHEMA or st.get("shape") != (t, n):
        st = {"schema": _MOTION_SCHEMA, "shape": (t, n), "version": 0, "computed": {},
              "align_layers": [], "align_layer": np.full(n, -1, dtype=np.int64),
              "smooth_half": np.zeros(n, dtype=np.int64), "align_report": None}
    return st


def _motion_commit(data, st, channel):
    st["version"] = int(st["version"]) + 1
    st["computed"][channel] = st["version"]
    data._molaro_motion = st


def _motion_prune(st):
    used = sorted(set(int(k) for k in np.unique(st["align_layer"]) if k >= 0))
    remap = np.full(len(st["align_layers"]) + 1, -1, dtype=np.int64)
    for new, old in enumerate(used):
        remap[old] = new
    st["align_layers"] = [st["align_layers"][k] for k in used]
    st["align_layer"] = remap[st["align_layer"]]


def _motion_compose(pos, st):
    """(t, n, 3) float32 offset = smooth(align(raw)) - raw, from the motion state.

    Point-chunked (smoothing needs each point's whole time axis), float64 inside.
    """
    t, n, _ = pos.shape
    out = np.zeros((t, n, 3), dtype="<f4")
    layer, half = st["align_layer"], st["smooth_half"]
    active = np.flatnonzero((layer >= 0) | (half > 0))
    step = max(1, int(2e7 // max(1, t * 3)))
    frames = np.arange(t)
    for a in range(0, active.size, step):
        idx = active[a:a + step]
        raw = pos[:, idx, :].astype(np.float64)
        p = raw.copy()
        for k, (R, cx, cy) in enumerate(st["align_layers"]):
            m = layer[idx] == k
            if m.any():
                p[:, m, :] = np.einsum("tfi,tij->tfj", raw[:, m, :] - cx[:, None, :], R) + cy
        for w in np.unique(half[idx]):
            if w <= 0:
                continue
            m = half[idx] == w
            csum = np.concatenate([np.zeros((1, int(m.sum()), 3)), np.cumsum(p[:, m, :], axis=0)], axis=0)
            lo = np.maximum(frames - w, 0)
            hi = np.minimum(frames + w, t - 1)
            p[:, m, :] = (csum[hi + 1] - csum[lo]) / (hi - lo + 1)[:, None, None]
        out[:, idx, :] = (p - raw).astype("<f4")
    return out
# ==== end MOTION STATE ====


def compute(data, target_indices, params):
    # `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named (whole
    # subgroups, scene units); `?keep=true` keeps the target itself. It lives in
    # the PROVIDER because the macro only binds `all` and never uses its target.
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
    n, t = int(header.n_points), int(header.n_frames)

    # NOT named `n` — that is the point count.
    frames_avg = max(0, int(round(_p.get("smoothing", 5))))
    window = max(0, (frames_avg - 1) // 2)

    old = _motion_state(data, t, n)
    st = dict(old, computed=dict(old["computed"]), align_layers=list(old["align_layers"]),
              align_layer=old["align_layer"].copy(), smooth_half=old["smooth_half"].copy())
    if target_indices:
        st["smooth_half"][np.asarray(target_indices, dtype=int)] = window
    else:
        st["smooth_half"][:] = window

    pos = np.frombuffer(data.give_frames(0, t).positions, dtype="<f4").reshape(t, n, 3)
    out = _motion_compose(pos, st)
    _motion_commit(data, st, "smoothing")
    # ndarray, components=3: install_channel stores it without boxing a list.
    return {"values": out, "components": 3}
