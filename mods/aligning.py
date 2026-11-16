# molaro-mod
# name: aligning
# kind: analysis
# produces: channel
# channel: aligning
# param: ref hint first average mean last off
# param: fit hint target backbone CA heavy protein
# param: mode choice fit center
# param: weights choice equal mass
# param: apply choice all target
# param: iterations number 20
# description: The offset half of `align` — computes the superposition of every frame onto a reference and writes the COMBINED displacement (alignment, then any `smooth` on top) as a per-point-per-frame channel for the offset axis. Runs automatically when you invoke `align`; you rarely call it by hand.

# THE PROVIDER half of the align pair (same shape as smoothing under smooth).
#
# WHAT "ALIGNED" MEANS. For each frame t a rigid transform (R_t, c_t) is found
# that best superposes the FIT atoms of frame t onto the reference (weighted
# least squares, Kabsch, reflection-guarded). It is applied to the MOVED atoms:
# aligned = (x - c_t) @ R_t + c_ref.
#
# WHY THE CHANNEL IS A COMBINATION, not "the alignment".
#   The offset axis is last-bind-wins per point, so `align` and `smooth` each
#   binding their own displacement meant the second REPLACED the first — and the
#   old `smoothing` averaged RAW positions, so smoothing a tumbling trajectory
#   averaged a protein over many orientations into a jumble. The fix is one
#   picture with a fixed order, shown = smooth(align(raw)):
#     * the pure parts — alignment transforms and each point's smoothing window —
#       are remembered on the dataset handle (`data._molaro_motion`, the
#       MOTION STATE block below, identical in aligning.py and smoothing.py);
#     * every run of EITHER provider rebuilds the full combination from that
#       state and writes it to its own channel;
#     * the macros bind whichever channel holds the CURRENT combination (the
#       state's version counter says which), because the viewer skips a provider
#       whose target and parameters did not change — so after `smooth`, a repeat
#       `align` must bind `smoothing`'s channel, not its own stale one.
#   Raw coordinates are never touched: `unbind all offset` shows them again.
#
# REFERENCES (?ref=): first (default) | last | <k> (served frame index, negative
# counts from the end) | mean (the iterated average structure itself; no frame
# stays put) | average (the REAL frame closest to that average structure) |
# off (forget the alignment — of the target with ?apply=target, else all of it).
#
# FIT (?fit=): which atoms DEFINE the superposition — the target (default), or
# the target intersected with backbone / CA / heavy / protein / any one-token
# mdtraj selection. APPLY (?apply=): all (default, the whole system moves) or
# target (only the target moves; regions aligned separately keep their own
# transforms). MODE: fit (rotation + translation) or center (translation only).
# WEIGHTS: equal or mass.
#
# PRECISION. float64 for every centroid/covariance/SVD and for the time
# averages; the channel is stored float32.
#
# NOT DONE HERE: periodic unwrapping (the producer images the solute on load; a
# molecule still split across the box superposes badly and the reported RMSD
# shows it).

import numpy as np

_FIT_SHORTHANDS = {
    "backbone": "backbone",
    "ca": "name CA",
    "heavy": "not element H",
    "protein": "protein",
}


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


def _fail(msg):
    raise ValueError(f"aligning: {msg}")


def _kabsch(X, Y, w, rotate):
    """Best rigid superposition of every frame of X (T,F,3) onto Y (F,3).
    Returns R (T,3,3), cx (T,3), cy (3,) with aligned = (x - cx[t]) @ R[t] + cy."""
    cx = np.einsum("f,tfk->tk", w, X)
    cy = w @ Y
    T = X.shape[0]
    if not rotate:
        return np.broadcast_to(np.eye(3), (T, 3, 3)).copy(), cx, cy
    H = np.einsum("tfi,f,fj->tij", X - cx[:, None, :], w, Y - cy)
    U, _S, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(U @ Vt))
    d[d == 0] = 1.0
    D = np.zeros((T, 3, 3))
    D[:, 0, 0] = D[:, 1, 1] = 1.0
    D[:, 2, 2] = d
    return U @ D @ Vt, cx, cy


def _apply(X, R, cx, cy):
    return np.einsum("tfi,tij->tfj", X - cx[:, None, :], R) + cy


def _rmsd(A, B, w):
    return np.sqrt(np.einsum("f,tf->t", w, ((A - B) ** 2).sum(-1)))


def compute(data, target_indices, params):
    p = params or {}
    header = data.give_header()
    n, t = int(header.n_points), int(header.n_frames)
    if t < 1 or n < 1:
        _fail("the dataset has no frames or no points.")

    mode = p.get("mode", "fit")
    weights = p.get("weights", "equal")
    apply_to = p.get("apply", "all")
    ref = str(p.get("ref", "first")).strip()
    fit = str(p.get("fit", "target")).strip()
    try:
        iterations = int(round(float(p.get("iterations", 20))))
    except (TypeError, ValueError):
        _fail(f'iterations must be a whole number, got "{p.get("iterations")}".')
    if iterations < 1:
        _fail(f"iterations must be at least 1, got {iterations}.")

    target = np.arange(n) if not target_indices else np.asarray(sorted(set(target_indices)), dtype=int)
    move = np.arange(n) if apply_to == "all" else target

    # Work on a COPY of the state and commit only after everything succeeded, so
    # a failing run leaves the remembered picture exactly as it was.
    old = _motion_state(data, t, n)
    st = dict(old, computed=dict(old["computed"]), align_layers=list(old["align_layers"]),
              align_layer=old["align_layer"].copy(), smooth_half=old["smooth_half"].copy())

    chunk = data.give_frames(0, t)
    pos = np.frombuffer(chunk.positions, dtype="<f4").reshape(t, n, 3)

    if ref.lower() == "off":
        st["align_layer"][move] = -1
        _motion_prune(st)
        st["align_report"] = None
        out = _motion_compose(pos, st)
        _motion_commit(data, st, "aligning")
        return {"values": out, "components": 3}

    # ---- fit set: target ∩ optional topology selection
    traj = data.trajectory
    if fit.lower() in ("", "target"):
        fit_idx, fit_label = target, "the target"
    else:
        if traj is None:
            _fail(f"?fit={fit} needs a real topology, but this source has none (data.trajectory is None). "
                  "Use the address grammar to target the fit atoms instead.")
        query = _FIT_SHORTHANDS.get(fit.lower(), fit)
        try:
            sel = traj.topology.select(query)
        except Exception as exc:  # mdtraj raises several types for a bad query
            _fail(f'?fit={fit} is not a valid mdtraj selection ("{query}"): {exc}')
        fit_idx = np.intersect1d(sel, target)
        fit_label = f'"{query}" in the target'
        if fit_idx.size == 0:
            _fail(f'?fit={fit} ("{query}") matches no atoms inside the target. '
                  "Widen the target, or pick a different ?fit.")
    rotate = mode == "fit"
    if rotate and fit_idx.size < 3:
        _fail(f"a rotational fit needs at least 3 fit atoms, got {fit_idx.size}. "
              "Widen the target/?fit, or use ?mode=center for translation only.")

    # ---- weights
    if weights == "mass":
        if traj is None:
            _fail("?weights=mass needs a real topology (data.trajectory is None); use ?weights=equal.")
        atoms = list(traj.topology.atoms)
        w = np.array([(atoms[i].element.mass if atoms[i].element is not None else 0.0) for i in fit_idx],
                     dtype=np.float64)
        if not np.isfinite(w).all() or w.sum() <= 0:
            _fail("the fit atoms have no usable masses; use ?weights=equal.")
    else:
        w = np.ones(fit_idx.size, dtype=np.float64)
    w = w / w.sum()

    X = pos[:, fit_idx, :].astype(np.float64)

    # ---- reference
    def frame_index(token):
        key = token.lower()
        if key == "first":
            return 0
        if key == "last":
            return t - 1
        try:
            k = int(token)
        except ValueError:
            _fail(f'?ref must be first, last, average, mean, off or a frame index, got "{token}".')
        if k < 0:
            k += t
        if not 0 <= k < t:
            _fail(f"?ref={token} is outside the served frames 0..{t - 1}.")
        return k

    ref_frame = None
    if ref.lower() in ("mean", "average"):
        Y = X[0].copy()
        for _ in range(iterations):
            R, cx, cy = _kabsch(X, Y, w, rotate)
            mean = _apply(X, R, cx, cy).mean(axis=0)
            moved_by = float(np.sqrt(w @ ((mean - Y) ** 2).sum(-1)))
            Y = mean
            if moved_by < 1e-6:          # nm; well under float32 coordinate noise
                break
        if ref.lower() == "average":
            R, cx, cy = _kabsch(X, Y, w, rotate)
            ref_frame = int(np.argmin(_rmsd(_apply(X, R, cx, cy), Y, w)))
            Y = X[ref_frame].copy()
    else:
        ref_frame = frame_index(ref)
        Y = X[ref_frame].copy()

    R, cx, cy = _kabsch(X, Y, w, rotate)
    rms = _rmsd(_apply(X, R, cx, cy), Y, w)

    # ---- commit into the state: the moved points get this transform
    st["align_layers"].append((R, cx, cy))
    st["align_layer"][move] = len(st["align_layers"]) - 1
    _motion_prune(st)

    others = rms if ref_frame is None else np.delete(rms, ref_frame)
    if ref_frame is None:
        ref_text = "the average structure (not a real frame)"
    else:
        how = {"first": "first", "last": "last", "average": "closest to the average structure"}.get(ref.lower(), "requested")
        ref_text = f"frame {ref_frame} ({how})"
    st["align_report"] = {
        "frames": t, "ref_text": ref_text, "fit_n": int(fit_idx.size), "fit_label": fit_label,
        "weights": weights, "mode": mode, "apply": apply_to,
        "median": float(np.median(others)) if others.size else 0.0,
        "max": float(rms.max()), "worst": int(np.argmax(rms)),
        "unit_scale": 10.0 if traj is not None else 1.0,
        "unit": " Å" if traj is not None else " scene units",
    }

    out = _motion_compose(pos, st)
    _motion_commit(data, st, "aligning")
    return {"values": out, "components": 3}
