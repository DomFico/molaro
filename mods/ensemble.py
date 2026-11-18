# molaro-mod
# name: ensemble
# kind: analysis
# produces: commands
# param: n number 8
# param: pick hint spread extremes even
# param: opacity number 0.15
# param: fit hint CA backbone heavy target
# description: Show the spread of the ensemble as faint "ghost" copies around the solid structure. Picks frames that differ most from each other (RMSD on the fit atoms) and draws them translucent with your current representation. `ensemble <fit-target> ?n=8 ?opacity=0.15 ?pick=spread|extremes|even ?fit=CA|backbone|heavy|target`. spread (default) = frames as far apart as possible; extremes = the frames furthest from the average; even = evenly spaced. Many faint ghosts (?n=16 ?opacity=0.06) read as a blur, a few stronger ones (?n=4 ?opacity=0.3) as snapshots. Run `align` first if the molecule tumbles or drifts. `ghost off` removes them; `ghost <frames>` sets them by hand.

# THE FRAME PICKER for the viewer's built-in `ghost` verb (webview/ghosts.ts).
# This mod only CHOOSES frames; the viewer draws them, at whatever the current
# representation is, through the same per-frame path as playback (so align,
# smooth, cartoon orientation and live colours apply to every ghost).
#
# DISTANCES. The fit atoms of every frame are superposed onto their mean
# (iterated), then the frame-to-frame RMSD matrix is taken in that common
# frame. That is the spread a viewer sees once the trajectory is aligned.

import numpy as np

_FIT_SHORTHANDS = {
    "backbone": "backbone",
    "ca": "name CA",
    "heavy": "not element H",
    "protein": "protein",
}
_MAX_GHOSTS = 32   # the viewer's limit (ghosts.ts GHOST_MAX)


def _fail(msg):
    raise ValueError(f"ensemble: {msg}")


def _superpose_to_mean(X, iterations=4):
    """Superpose every frame of X (T,F,3) onto the evolving mean structure."""
    A = X - X.mean(axis=1, keepdims=True)
    ref = A[0]
    for _ in range(iterations):
        H = np.einsum("tfi,fj->tij", A, ref)
        U, _S, Vt = np.linalg.svd(H)
        d = np.sign(np.linalg.det(U @ Vt))
        d[d == 0] = 1.0
        D = np.zeros_like(H)
        D[:, 0, 0] = D[:, 1, 1] = 1.0
        D[:, 2, 2] = d
        A = np.einsum("tfi,tij->tfj", A, U @ D @ Vt)
        ref = A.mean(axis=0)
    return A, ref


def _pairwise_rmsd(A):
    T, F = A.shape[:2]
    flat = A.reshape(T, F * 3)
    sq = (flat ** 2).sum(1)
    d2 = (sq[:, None] + sq[None, :] - 2.0 * flat @ flat.T) / F
    return np.sqrt(np.clip(d2, 0.0, None))


def compute(data, target_indices, params):
    p = params or {}
    header = data.give_header()
    n_pts, T = int(header.n_points), int(header.n_frames)
    if T < 2:
        _fail("this is a single-frame structure — there is no ensemble to show.")

    try:
        n = int(round(float(p.get("n", 8))))
    except (TypeError, ValueError):
        _fail(f'n must be a whole number, got "{p.get("n")}".')
    if n < 1:
        _fail(f"n must be at least 1, got {n}.")
    n = min(n, _MAX_GHOSTS, T - 1)
    try:
        opacity = float(p.get("opacity", 0.15))
    except (TypeError, ValueError):
        _fail(f'opacity must be a number, got "{p.get("opacity")}".')
    if not 0.0 < opacity < 1.0:
        _fail(f"opacity must be between 0 and 1 (exclusive), got {opacity}.")
    pick = str(p.get("pick", "spread")).strip().lower()
    if pick not in ("spread", "extremes", "even"):
        _fail(f'pick must be spread, extremes or even, got "{pick}".')
    fit = str(p.get("fit", "CA")).strip()

    target = np.arange(n_pts) if not target_indices else np.asarray(sorted(set(target_indices)), dtype=int)
    traj = data.trajectory
    notes = []
    if fit.lower() in ("", "target") or traj is None:
        fit_idx, fit_label = target, "the target"
        if traj is None and fit.lower() not in ("", "target"):
            notes.append(f"?fit={fit} needs a topology; fitted on the whole target instead.")
    else:
        query = _FIT_SHORTHANDS.get(fit.lower(), fit)
        try:
            sel = traj.topology.select(query)
        except Exception as exc:  # mdtraj raises several types for a bad query
            _fail(f'?fit={fit} is not a valid mdtraj selection ("{query}"): {exc}')
        fit_idx = np.intersect1d(sel, target)
        fit_label = f"{fit} atoms"
        if fit_idx.size == 0:
            fit_idx, fit_label = target, "the target"
            notes.append(f'?fit={fit} matches nothing in the target; fitted on the whole target instead.')
    if fit_idx.size < 3:
        _fail(f"needs at least 3 fit atoms, got {fit_idx.size}. Widen the target or change ?fit.")

    chunk = data.give_frames(0, T)
    pos = np.frombuffer(chunk.positions, dtype="<f4").reshape(T, n_pts, 3)
    X = pos[:, fit_idx, :].astype(np.float64)
    A, mean = _superpose_to_mean(X)
    D = _pairwise_rmsd(A)
    medoid = int(np.argmin(D.sum(1)))

    if pick == "spread":
        chosen, mind = [], D[medoid].copy()
        mind[medoid] = -1.0
        for _ in range(n):
            k = int(np.argmax(mind))
            if mind[k] <= 0:
                break
            chosen.append(k)
            mind = np.minimum(mind, D[k])
            mind[chosen] = -1.0
            mind[medoid] = -1.0
        how = "as far apart as possible"
    elif pick == "extremes":
        to_mean = np.sqrt(((A - mean) ** 2).sum(-1).mean(-1))
        order = [int(f) for f in np.argsort(-to_mean) if int(f) != medoid]
        chosen = order[:n]
        how = "furthest from the average structure"
    else:
        chosen = sorted({int(round(x)) for x in np.linspace(0, T - 1, n)})
        how = "evenly spaced"
    chosen = sorted(set(chosen))
    if not chosen:
        _fail("every frame is identical on the fit atoms — there is no spread to show.")

    s, unit = (10.0, " Å") if traj is not None else (1.0, " units")
    r = D[medoid, chosen] * s
    cmds = [f"ghost {' '.join(str(f) for f in chosen)} opacity {opacity:g}"]
    cmds.append(f"note ensemble: {len(chosen)} ghost frames {how} (RMSD on {fit_idx.size} {fit_label}); "
                f"{r.min():.1f}–{r.max():.1f}{unit} from the most representative frame, {medoid}.")
    st = getattr(data, "_molaro_motion", None)
    aligned = isinstance(st, dict) and len(st.get("align_layers", [])) > 0
    if not aligned:
        notes.append("ghosts are drawn as the frames are shown — if the molecule drifts or tumbles, "
                     "run `align` (e.g. `align all ?fit=CA`) so they line up.")
    cmds += [f"note ensemble: {x}" for x in notes]
    return cmds
