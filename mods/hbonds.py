# molaro-mod
# name: hbonds
# kind: analysis
# produces: edges
# edge-group: hbonds
# edge-overlay: true
# param: type hint auto backbone sidechain all
# param: restrict choice any within
# param: cutoff number 0.35
# param: min number 0
# param: live boolean true
# param: solvent boolean false
# param: color color yellow
# param: dash number 0.6
# param: size number 0.5
# param: opacity number 1
# param: group string hbonds
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Hydrogen bonds drawn as dashed lines that FORM AND BREAK as you scrub. `hbonds` alone draws the BACKBONE network (N-H···O=C, DSSP's own energy criterion — the secondary-structure H-bonds); `hbonds <selection>` draws every H-bond involving the selection, side chains included. ?type=backbone|sidechain|all overrides that; ?restrict=any (default: one partner in the selection) or within (both). ?min=0.3 keeps only bonds present in at least 30% of frames; ?live=false then draws that set on every frame. ?color, ?dash (0 = solid), ?size and ?opacity style the lines; ?group=<name> keeps a second set. Works without hydrogens. With `smooth` on, a bond shows when present in most of its smoothing window, so it does not flicker faster than the motion.

# WHAT COUNTS AS AN H-BOND — two criteria, each the standard one for its case,
# both working on HEAVY ATOMS so a hydrogen-free model (BioEmu, AlphaFold,
# crystal structures) gets the same answer as an all-atom MD frame.
#
# 1. BACKBONE-BACKBONE: the Kabsch-Sander electrostatic energy DSSP assigns
#    secondary structure from,
#        E = 0.084 * 332 * (1/r_ON + 1/r_CH - 1/r_OH - 1/r_CN)   kcal/mol, r in Å
#    with the amide H placed 1.0 Å from N along the previous residue's O->C
#    direction (DSSP's own placement), bonded when E < -0.5. Proline has no amide
#    H; a chain's first residue has no previous carbonyl to place one from. The
#    line is drawn N···O. Checked against mdtraj.kabsch_sander.
#
# 2. ANYTHING INVOLVING A SIDE CHAIN, WATER OR LIGAND: donor-acceptor heavy-atom
#    distance <= ?cutoff (0.35 nm = 3.5 Å) AND neither partner "behind" its own
#    bonded neighbour: every angle X-D···A and D···A-Y (X, Y covalently bonded to
#    D, A) >= 90°. Donor/acceptor roles come from the standard amino-acid table
#    below; an atom of a residue the table does not know (a ligand) counts as
#    both if it is N or O — permissive on purpose, stated here.
#
# Bonded neighbours come from `data.edges` (what the viewer DRAWS), not
# topology.bonds, which can be empty for a ligand (MODS.md §2).
#
# LIVE. The return is the UNION of pairs that ever bond plus a per-frame 0/1
# mask, so the lines appear and vanish with the displayed frame. Detection always
# reads the RAW (physical) coordinates; the lines are drawn at the shown positions
# (they follow `align` / `smooth` because the edge pass reads the offset-combined
# positions). With `smooth` on, the mask is smoothed with the same per-point
# window — a pair's window is the larger of its two atoms' — and a bond shows
# when present in at least half of it.
#
# SOLVENT (?solvent=true): water joins only where it bonds the solute — water-water
# contacts are not drawn.
#
# NOT DONE: periodic images (the producer images the solute to the box centre on
# load; a contact straddling the box edge is missed).

import numpy as np
from scipy.spatial import cKDTree

# Amino-acid side-chain donors / acceptors (heavy atoms). Backbone N / O are
# handled separately. His ring nitrogens are both (tautomer unknown).
_SC_DONORS = {
    "SER": {"OG"}, "THR": {"OG1"}, "TYR": {"OH"}, "ASN": {"ND2"}, "GLN": {"NE2"},
    "LYS": {"NZ"}, "ARG": {"NE", "NH1", "NH2"}, "HIS": {"ND1", "NE2"}, "HID": {"ND1"},
    "HIE": {"NE2"}, "HIP": {"ND1", "NE2"}, "HSD": {"ND1"}, "HSE": {"NE2"}, "HSP": {"ND1", "NE2"},
    "TRP": {"NE1"}, "CYS": {"SG"},
}
_SC_ACCEPTORS = {
    "SER": {"OG"}, "THR": {"OG1"}, "TYR": {"OH"}, "ASN": {"OD1"}, "GLN": {"OE1"},
    "ASP": {"OD1", "OD2"}, "GLU": {"OE1", "OE2"}, "HIS": {"ND1", "NE2"}, "HID": {"NE2"},
    "HIE": {"ND1"}, "HSD": {"NE2"}, "HSE": {"ND1"}, "MET": {"SD"},
}
_BACKBONE = {"N", "O", "OXT", "OT1", "OT2"}
_WATER = {"HOH", "WAT", "SOL", "TIP3", "TIP4", "TIP5", "SPC", "T3P", "T4P"}
_DSSP_K = 0.084 * 332.0 * 0.1          # kcal/mol·nm  (the 0.1 converts 1/Å to 1/nm)


def _fail(msg):
    raise ValueError(f"hbonds: {msg}")


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


def _angles_ok(xyz, a, b, nbrs_a, nbrs_b):
    """All X-a···b and a···b-Y angles >= 90°, i.e. (X - a)·(b - a) <= 0, etc."""
    ab = xyz[b] - xyz[a]
    for x in nbrs_a:
        if np.dot(xyz[x] - xyz[a], ab) > 0:
            return False
    for y in nbrs_b:
        if np.dot(xyz[y] - xyz[b], -ab) > 0:
            return False
    return True


def compute(data, target_indices, params):
    p = params or {}
    traj = data.trajectory
    if traj is None:
        _fail("H-bonds need chemistry (atom names, residues), and this source has none "
              "(data.trajectory is None).")
    top = traj.topology
    t, n = int(traj.n_frames), int(top.n_atoms)

    kind = str(p.get("type", "auto")).strip().lower()
    if kind == "auto":
        kind = "backbone" if not target_indices else "all"
    if kind not in ("backbone", "sidechain", "all"):
        _fail(f'?type must be auto, backbone, sidechain or all, got "{kind}".')
    restrict = p.get("restrict", "any")
    cutoff = float(p.get("cutoff", 0.35))
    if not 0 < cutoff <= 0.6:
        _fail(f"?cutoff is a donor-acceptor distance in nm (0.35 = 3.5 Å); got {cutoff}.")
    min_occ = float(p.get("min", 0.0))
    if not 0 <= min_occ <= 1:
        _fail(f"?min is a fraction of frames between 0 and 1, got {min_occ}.")
    live = bool(p.get("live", True))
    solvent = bool(p.get("solvent", False))

    in_target = np.ones(n, dtype=bool) if not target_indices else np.zeros(n, dtype=bool)
    if target_indices:
        in_target[np.asarray(target_indices, dtype=int)] = True

    def keep_pair(a, b):
        return (in_target[a] and in_target[b]) if restrict == "within" else (in_target[a] or in_target[b])

    xyz = traj.xyz                                   # (t, n, 3) float32, nm, RAW
    atoms = list(top.atoms)
    hits = {}                                        # (a, b) -> list of frames

    # ---------------------------------------------------------- 1. backbone (DSSP)
    if kind in ("backbone", "all"):
        don_N, don_prevC, don_prevO, acc_C, acc_O, don_res, acc_res = [], [], [], [], [], [], []
        don_prev_res = []
        for chain in top.chains:
            prev, prev_res = None, None
            for res in chain.residues:
                names = {a.name: a.index for a in res.atoms}
                if not res.is_protein or not {"N", "C", "O"} <= names.keys():
                    prev, prev_res = None, None
                    continue
                acc_C.append(names["C"]); acc_O.append(names["O"]); acc_res.append(res.index)
                if prev is not None and res.name != "PRO":
                    don_N.append(names["N"]); don_prevC.append(prev["C"]); don_prevO.append(prev["O"])
                    don_res.append(res.index); don_prev_res.append(prev_res)
                prev, prev_res = names, res.index
        if don_N and acc_O:
            don_N, don_prevC, don_prevO = map(np.asarray, (don_N, don_prevC, don_prevO))
            acc_C, acc_O = np.asarray(acc_C), np.asarray(acc_O)
            don_res, acc_res = np.asarray(don_res), np.asarray(acc_res)
            don_prev_res = np.asarray(don_prev_res)
            for f in range(t):
                X = xyz[f].astype(np.float64)
                N = X[don_N]
                co = X[don_prevC] - X[don_prevO]
                H = N + 0.1 * co / np.linalg.norm(co, axis=1)[:, None]
                # E < -0.5 needs r_ON well under 0.52 nm; prune with a KD-tree first
                pairs = cKDTree(N).query_ball_tree(cKDTree(X[acc_O]), 0.52)
                for di, accs in enumerate(pairs):
                    if not accs:
                        continue
                    accs = np.asarray(accs)
                    # not its own residue, and not the previous one — whose C=O placed
                    # the H, so that 'bond' is an artefact of the construction (DSSP
                    # excludes it too)
                    accs = accs[(acc_res[accs] != don_res[di]) & (acc_res[accs] != don_prev_res[di])]
                    if accs.size == 0:
                        continue
                    O, C = X[acc_O[accs]], X[acc_C[accs]]
                    e = _DSSP_K * (1 / np.linalg.norm(O - N[di], axis=1) + 1 / np.linalg.norm(C - H[di], axis=1)
                                   - 1 / np.linalg.norm(O - H[di], axis=1) - 1 / np.linalg.norm(C - N[di], axis=1))
                    for k in accs[e < -0.5]:
                        a, b = int(don_N[di]), int(acc_O[k])
                        if keep_pair(a, b):
                            hits.setdefault((a, b), []).append(f)

    # ------------------------------------------ 2. side chain / water / ligand (geometric)
    if kind in ("sidechain", "all"):
        donor = np.zeros(n, dtype=bool)
        accep = np.zeros(n, dtype=bool)
        backbone = np.zeros(n, dtype=bool)
        for a in atoms:
            res, el = a.residue, (a.element.symbol if a.element is not None else "")
            if res.name in _WATER:
                if solvent and el == "O":
                    donor[a.index] = accep[a.index] = True
                continue
            if res.is_protein:
                if a.name in _BACKBONE:
                    backbone[a.index] = True
                    if a.name == "N" and res.name != "PRO":
                        donor[a.index] = True
                    elif a.name != "N":
                        accep[a.index] = True
                    continue
                donor[a.index] = a.name in _SC_DONORS.get(res.name, ())
                accep[a.index] = a.name in _SC_ACCEPTORS.get(res.name, ())
            elif el in ("N", "O") and not (res.is_protein or res.name in _WATER):
                donor[a.index] = accep[a.index] = True     # ligand / unknown: permissive
        polar = np.flatnonzero(donor | accep)
        water = np.zeros(n, dtype=bool)
        if solvent:
            water[[a.index for a in atoms if a.residue.name in _WATER]] = True
        # Search FROM the non-water polar atoms only: water-water contacts are never
        # enumerated (a whole box of them is noise, and enumerating them cost ~20 s
        # on a 4,000-water system); water still shows where it bridges to the solute.
        query = polar[~water[polar]]
        if query.size:
            nbrs = {int(i): [] for i in polar}
            for i, j in data.edges:
                if i in nbrs:
                    nbrs[i].append(j)
                if j in nbrs:
                    nbrs[j].append(i)
            res_of = np.fromiter((a.residue.index for a in atoms), dtype=np.int64, count=n)
            for f in range(t):
                X = xyz[f].astype(np.float64)
                found = cKDTree(X[query]).query_ball_tree(cKDTree(X[polar]), cutoff)
                for u, partners in enumerate(found):
                    a = int(query[u])
                    for v in partners:
                        b = int(polar[v])
                        if not water[b] and b <= a:
                            continue                  # solute-solute pair: count it once (a < b)
                        if res_of[a] == res_of[b]:
                            continue
                        if backbone[a] and backbone[b]:
                            continue                  # backbone-backbone is DSSP's job
                        if not ((donor[a] and accep[b]) or (donor[b] and accep[a])):
                            continue
                        if b in nbrs[a] or not keep_pair(a, b):
                            continue
                        if not _angles_ok(X, a, b, nbrs[a], nbrs[b]):
                            continue
                        key = (a, b) if a < b else (b, a)
                        hits.setdefault(key, []).append(f)

    # ------------------------------------------------------------- assemble
    pairs = sorted(hits)
    mask = np.zeros((t, len(pairs)), dtype=np.float64)
    for k, key in enumerate(pairs):
        mask[hits[key], k] = 1.0
    occ = mask.mean(axis=0) if pairs else np.zeros(0)
    keep = occ >= min_occ - 1e-12
    if min_occ > 0:
        keep &= occ > 0
    pairs = [pr for pr, kk in zip(pairs, keep) if kk]
    mask = mask[:, keep]

    half = _follow_half(data, n)
    group = str(p.get("group", "hbonds")) or "hbonds"
    if not live:
        return [list(pr) for pr in pairs]             # every kept bond, every frame
    _follow_record(data, f"%{group}", half)      # a live mask follows `smooth`
    if pairs and half.any():
        pa = np.asarray(pairs)
        w = np.maximum(half[pa[:, 0]], half[pa[:, 1]])
        mask = (_window_mean(mask, w) >= 0.5).astype(np.float64)
    return {"pairs": [list(pr) for pr in pairs], "visibility": mask}
