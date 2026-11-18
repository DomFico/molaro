# molaro-mod
# name: contacts
# kind: analysis
# produces: edges
# edge-group: contacts
# edge-overlay: true
# param: atoms hint heavy all backbone sidechain CA
# param: cutoff hint auto 0.4 0.8
# param: level choice auto atom residue
# param: restrict choice any within
# param: seqsep number 3
# param: min number 0
# param: live boolean true
# param: solvent boolean false
# param: color color orange
# param: dash number 0
# param: size number 0.3
# param: opacity number 0.8
# param: group string contacts
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Atom-atom contacts drawn as lines that appear and vanish as you scrub — every pair of chosen atoms closer than ?cutoff. `contacts <selection>` draws contacts involving the selection (?restrict=within: both ends in it); bare `contacts` covers the whole system. ?atoms=heavy (default) | all | backbone | sidechain | CA, or a comma list of atom names (CA,CB). ?cutoff=auto is 4 Å, or 8 Å for CA-only contacts. ?level=residue draws one line per contacting residue pair (CA to CA) instead of one per atom pair — the default for bare `contacts`, which would otherwise be thousands of lines; with a selection the default is atom level. ?seqsep=3 skips contacts between residues fewer than 3 apart on the same chain. ?min / ?live=false / ?solvent and ?color / ?dash / ?size / ?opacity / ?group as for `hbonds`. With `smooth` on, a contact shows when present in most of its smoothing window.

# WHAT A CONTACT IS: two chosen atoms within ?cutoff in a frame, excluding
#   * atoms of the same residue, and residues fewer than ?seqsep apart on the same
#     polymer chain (a contact map's usual |i-j| >= 3 — near neighbours along the
#     chain are always "in contact" and only add clutter);
#   * covalently bonded atoms and atoms two bonds apart (from `data.edges`, the
#     connectivity the viewer draws);
#   * water-water pairs (water joins only with ?solvent=true, and only where it
#     touches the rest).
# Distances are measured on the RAW frames; lines are drawn at the shown positions,
# so they follow `align` / `smooth`. With `smooth` on, the per-frame mask is
# smoothed over the same per-point window (majority), like `hbonds`.
#
# AN OVERLAY (`# edge-overlay: true`): commands aimed at atoms (`licorice`,
# `hide_res`, `colorbonds <atoms>`) do not restyle or fade these lines; style them
# with ?color/?dash/... or `colorbonds %contacts <c>`.
#
# SIZE GUARD. An all-atom contact set of a whole protein over a long trajectory is
# hundreds of thousands of lines; the run refuses (naming the fixes) when
# frames x pairs would exceed _MAX_CELLS, instead of hanging the viewer.

import numpy as np
from scipy.spatial import cKDTree

_WATER = {"HOH", "WAT", "SOL", "TIP3", "TIP4", "TIP5", "SPC", "T3P", "T4P"}
_BACKBONE = {"N", "CA", "C", "O", "OXT", "OT1", "OT2", "H", "HA", "HN", "H1", "H2", "H3"}
_MAX_CELLS = 4_000_000


def _fail(msg):
    raise ValueError(f"contacts: {msg}")


# ==== SMOOTH FOLLOW — shared by hbonds.py, sasa_field.py, ss_field.py; KEEP IDENTICAL ====
# A live layer whose VALUES change per frame (a mask, an area, a class) follows
# `smooth` by filtering those values over the same per-point window `smooth`
# applies to positions — never by measuring the smoothed (unphysical) positions.
# `_follow_record` remembers which windows a layer was computed for, so `smooth`
# can say when it is out of date.
def _follow_half(data, n):
    st = getattr(data, "_molaro_motion", None)
    if isinstance(st, dict) and st.get("shape", (None, None))[1] == n:
        return np.asarray(st["smooth_half"], dtype=np.int64)
    return np.zeros(n, dtype=np.int64)


def _follow_record(data, name, half):
    rec = getattr(data, "_molaro_follow", None)
    if not isinstance(rec, dict):
        rec = {}
    rec[name] = np.asarray(half, dtype=np.int64).tobytes()
    data._molaro_follow = rec


def _window_mean(x, w):
    """Centred moving mean of x (t, k) over half-width w per column (k,), clamped."""
    t = x.shape[0]
    out = np.array(x, dtype=np.float64)
    frames = np.arange(t)
    for hw in np.unique(w):
        if hw <= 0:
            continue
        cols = np.flatnonzero(w == hw)
        csum = np.concatenate([np.zeros((1, cols.size)), np.cumsum(x[:, cols], axis=0)], axis=0)
        lo = np.maximum(frames - hw, 0)
        hi = np.minimum(frames + hw, t - 1)
        out[:, cols] = (csum[hi + 1] - csum[lo]) / (hi - lo + 1)[:, None]
    return out
# ==== end SMOOTH FOLLOW ====


def compute(data, target_indices, params):
    p = params or {}
    traj = data.trajectory
    if traj is None:
        _fail("contacts need atom names and residues, and this source has none (data.trajectory is None).")
    top = traj.topology
    t, n = int(traj.n_frames), int(top.n_atoms)
    atoms = list(top.atoms)

    spec = str(p.get("atoms", "heavy")).strip()
    level = p.get("level", "auto")
    if level == "auto":
        # bare = the whole system: one line per atom pair would be thousands of
        # lines, so the overview is residue-level; a selection is atom-level
        level = "residue" if not target_indices else "atom"
    restrict = p.get("restrict", "any")
    solvent = bool(p.get("solvent", False))
    live = bool(p.get("live", True))
    try:
        seqsep = int(round(float(p.get("seqsep", 3))))
    except (TypeError, ValueError):
        _fail(f'?seqsep must be a whole number, got "{p.get("seqsep")}".')
    min_occ = float(p.get("min", 0.0))
    if not 0 <= min_occ <= 1:
        _fail(f"?min is a fraction of frames between 0 and 1, got {min_occ}.")

    # ---- which atoms take part
    is_h = np.array([(a.element is not None and a.element.symbol == "H") for a in atoms])
    is_wat = np.array([a.residue.name in _WATER for a in atoms])
    names = np.array([a.name for a in atoms])
    key = spec.lower()
    if key == "heavy":
        chosen = ~is_h
    elif key == "all":
        chosen = np.ones(n, dtype=bool)
    elif key == "backbone":
        chosen = np.array([a.residue.is_protein and a.name in _BACKBONE for a in atoms]) & ~is_h
    elif key == "sidechain":
        chosen = np.array([a.residue.is_protein and a.name not in _BACKBONE for a in atoms]) & ~is_h
    else:
        wanted = {x.strip() for x in spec.split(",") if x.strip()}
        chosen = np.isin(names, list(wanted))
        if not chosen.any():
            _fail(f'?atoms={spec} matches no atom names in this system (e.g. CA, CB, NZ — names are case-sensitive).')
    if not solvent:
        chosen &= ~is_wat

    cut = str(p.get("cutoff", "auto")).strip().lower()
    if cut == "auto":
        cutoff = 0.8 if key == "ca" else 0.4
    else:
        try:
            cutoff = float(cut)
        except ValueError:
            _fail(f'?cutoff is a distance in nm (0.4 = 4 Å) or auto, got "{cut}".')
    if not 0 < cutoff <= 1.5:
        _fail(f"?cutoff must be between 0 and 1.5 nm, got {cutoff}.")

    in_target = np.ones(n, dtype=bool) if not target_indices else np.zeros(n, dtype=bool)
    if target_indices:
        in_target[np.asarray(target_indices, dtype=int)] = True
    query = np.flatnonzero(chosen & in_target & ~is_wat)
    partner = np.flatnonzero(chosen & (in_target if restrict == "within" else True))
    if query.size == 0:
        _fail("no chosen atoms in the target — widen the target or change ?atoms.")

    # ---- exclusions: same residue, near in sequence, 1-2 and 1-3 bonded
    res = np.fromiter((a.residue.index for a in atoms), dtype=np.int64, count=n)
    chain = np.fromiter((a.residue.chain.index for a in atoms), dtype=np.int64, count=n)
    poly = np.array([(a.residue.is_protein or a.residue.is_nucleic) for a in atoms])
    nbr = [set() for _ in range(n)]
    for i, j in data.edges:
        nbr[i].add(j); nbr[j].add(i)
    close = [s | set().union(*(nbr[k] for k in s)) if s else set() for s in nbr]

    def excluded(a, b):
        if res[a] == res[b]:
            return True
        if poly[a] and poly[b] and chain[a] == chain[b] and abs(res[a] - res[b]) < seqsep:
            return True
        return b in close[a]

    # ---- residue level: one line per residue pair, CA to CA (else the residue's
    # first chosen atom) — folded DURING the search so the size guard counts lines
    anchor = None
    if level == "residue":
        anchor = {}
        for a in atoms:
            r = a.residue.index
            if a.name == "CA":
                anchor[r] = a.index
            elif r not in anchor and chosen[a.index]:
                anchor[r] = a.index

    # ---- per-frame search
    hits = {}
    for f in range(t):
        X = traj.xyz[f]
        found = cKDTree(X[query]).query_ball_tree(cKDTree(X[partner]), cutoff)
        for u, js in enumerate(found):
            a = int(query[u])
            for v in js:
                b = int(partner[v])
                if b <= a and in_target[b] and not is_wat[b]:
                    continue                    # b is also a query atom: count the pair once (a < b)
                if excluded(a, b):
                    continue
                if anchor is not None:
                    a2, b2 = anchor.get(res[a], a), anchor.get(res[b], b)
                    if a2 == b2:
                        continue
                    hits.setdefault((a2, b2) if a2 < b2 else (b2, a2), set()).add(f)
                else:
                    hits.setdefault((a, b) if a < b else (b, a), set()).add(f)
        if len(hits) * t > _MAX_CELLS:
            _fail(f"more than {_MAX_CELLS // t:,} distinct contacts already by frame {f} of {t} — too many "
                  "lines to draw. Narrow it: a smaller selection, ?atoms=CA, ?level=residue, "
                  "?restrict=within, a shorter ?cutoff, or ?min=0.5.")

    pairs = sorted(hits)
    mask = np.zeros((t, len(pairs)), dtype=np.float64)
    for k, pr in enumerate(pairs):
        mask[sorted(hits[pr]), k] = 1.0
    occ = mask.mean(axis=0) if pairs else np.zeros(0)
    keep = (occ >= min_occ - 1e-12) & (occ > 0)
    pairs = [pr for pr, kk in zip(pairs, keep) if kk]
    mask = mask[:, keep]

    half = _follow_half(data, n)
    group = str(p.get("group", "contacts")) or "contacts"
    if not live:
        return [list(pr) for pr in pairs]
    _follow_record(data, f"%{group}", half)
    if pairs and half.any():
        pa = np.asarray(pairs)
        w = np.maximum(half[pa[:, 0]], half[pa[:, 1]])
        mask = (_window_mean(mask, w) >= 0.5).astype(np.float64)
    return {"pairs": [list(pr) for pr in pairs], "visibility": mask}
