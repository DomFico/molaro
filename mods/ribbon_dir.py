# molaro-mod
# name: ribbon_dir
# kind: analysis
# produces: channel
# channel: ribbon_dir
# author: Molaro assistant
# description: The orientation half of `cartoon` — it RUNS AUTOMATICALLY when you invoke that mod (which declares `# requires-channel: ribbon_dir`), so you rarely call it by hand. It supplies the ribbon's cross-section direction as a UNIT vector per residue, broadcast to every atom of its residue: a PROTEIN residue supplies its carbonyl direction O(i)-C(i), a NUCLEIC residue supplies its base-plane normal. Both feed the same sign resolution — corrected along each chain on the first frame and then held per residue frame-to-frame — so the ribbon neither twists nor strobes. Whole-system by the channel contract: a value for EVERY point on EVERY frame regardless of what you targeted.

import numpy as np

# WHY A CHANNEL AT ALL: a ribbon is a flat strip, so every backbone vertex
# needs a direction saying which way the strip faces. The viewer takes that
# from a 3-wide channel bound to the `orientation` axis; with nothing bound
# the buffer is zero and every ribbon quad collapses to a line — the ribbon
# draws nothing. That is why the cartoon cannot be a single mod: one mod
# produces one thing, and this must be a channel while the cartoon's styling
# must be commands.
#
# WHAT VECTOR, PROTEIN: the carbonyl C=O direction, which lies in the peptide
# plane roughly perpendicular to the chain. It is the conventional choice, and it
# is what makes a helix read as a flat twisting ribbon rather than a straight
# strap. The renderer orthogonalizes against the backbone tangent itself, so
# only the direction matters here.
#
# WHAT VECTOR, NUCLEIC: the BASE-PLANE NORMAL, by the same argument one step
# removed. In an alpha helix the carbonyl points roughly ALONG the helix axis, so
# "across" is axial and the strip's face ends up tangent to the helix cylinder —
# that is what makes the classic helix ribbon read. A duplex's base planes are
# roughly perpendicular to its own axis, so their NORMAL is the axial direction
# and gives the nucleic backbone the same tape-on-the-cylinder face. The other
# candidate, C1'->N9/N1 (the glycosidic bond), is RADIAL, not axial: it would
# stand the strip on edge relative to the duplex and read as a spiral staircase.
#
# The normal is the least-variance direction of the residue's base ring, from a
# 3x3 covariance eigendecomposition per frame — not a cross product of three
# chosen atoms, so a purine (9 ring atoms) and a pyrimidine (6) take one code
# path and a modified base contributes every ring atom it has. The ring is found
# BY NAME in the numbering every nucleotide shares: N1/C2/N3/C4/C5/C6 is present
# in both purine and pyrimidine, and a purine adds N7/C8/N9. Sugar atoms are
# primed or starred (C1', C2*) and can never collide with those names, so no
# sugar atom reaches the plane fit; three ring atoms are required.
#
# eigh's eigenvector SIGN is arbitrary and may differ frame to frame. That is
# exactly the case the machinery below exists for, and it is why the nucleic arm
# feeds the SAME resolution rather than a private one.
#
# WHY UNIT VECTORS and not the raw nm difference: the producer's coherence
# check compares adjacent frames with a RAW dot product, flagging < 0 as a sign
# inversion and < 0.5 as a hard swing. A carbonyl bond is about 0.123 nm, so
# raw vectors dot to ~0.015 even when two frames agree perfectly — every pair
# trips the swing threshold on magnitude alone and the warning becomes noise
# that cannot distinguish a stable ribbon from a strobing one. Normalizing
# costs nothing (the renderer normalizes anyway) and makes the dot a true
# cosine, so the check reports what it is meant to report.
#
# TWO COHERENCE PROBLEMS, both real and both handled:
#   1. Along the chain — in a beta strand consecutive carbonyls point ~180
#      degrees apart. Taken literally the strip would flip face every residue.
#      On the FIRST frame we walk each chain in residue order and flip a
#      residue's vector when it opposes the previous residue's already-resolved
#      one, so the face turns smoothly. That walk fixes the convention once.
#   2. Across frames — the sign is arbitrary but must be the SAME arbitrary
#      choice every frame or the ribbon strobes between two equally valid
#      orientations during playback. Every later frame therefore resolves each
#      residue against ITS OWN previous-frame vector.
#
#      This is the part worth being careful about. The tempting version — redo
#      the along-chain walk each frame, seeded from the previous frame at the
#      chain head — looks equivalent and is not: the walk decides residue i's
#      sign from residue i-1 IN THAT FRAME, so wherever two neighbours are near
#      perpendicular (loops, termini) the decision is a coin flip that changes
#      with thermal motion, and one flipped decision inverts the entire rest of
#      the chain. Re-measured on adk: it flips 46% of the 214 backbone residues
#      on an average adjacent-frame pair, and at least one residue on every one
#      of the 97 pairs. Anchoring each residue to its own history instead makes
#      each decision local and independent — re-measured, zero inversions.
#
# Residues with NEITHER facing (water, ions, ligands) take the first frame's
# running reference and then hold it constant — they have no meaningful facing,
# and a frozen vector cannot contribute a false swing. Nothing here is specific to
# one system: chains, residues and atom names all come from the trajectory at
# run time.
#
# COST, and why the code below is shaped the way it is. This mod is whole-system
# on its OUTPUT (n_frames * n_points * 3 by the channel contract) but its INPUT
# is tiny: a facing needs two atoms of a peptide residue, or one base ring. The
# file that forced this pass is a 15000-frame 12944-atom membrane peptide —
# 4238 residues of which 4186 are water, 27 carry a peptide plane, and 54 atoms
# (0.42%) carry the whole answer. Three things therefore never touch the whole
# system. Every figure below is measured on that file, through the producer's own
# `run_mod`, with the trajectory already resident.
#
#   1. ATOMS ARE SLICED BEFORE THE float64 PROMOTION. `traj.xyz` is float32;
#      promoting all of it went 2.17 -> 4.34 GiB for data 99.6% of which was
#      never read. The needed-atom list is built from BOTH arms (peptide C/O and
#      nucleic ring) off the TOPOLOGY alone, before a single coordinate is read,
#      so the promotion is over 18.5 MiB instead of 4.34 GiB; the slice and the
#      promotion together now measure 0.010 s. Selecting then widening is
#      exactly the same float64 values as widening then selecting: float32 ->
#      float64 is lossless and a gather only copies.
#
#   2. THE PER-RESIDUE ARRAYS ARE AS WIDE AS THE FACING RESIDUES, NOT THE
#      SYSTEM. `raw` and the resolved vectors used to be (n_frames, n_residues,
#      3) float64 — 1.42 GiB each, 2.84 GiB together, for 27 useful residues out
#      of 4238. They are now (n_frames, n_facing, 3): 9.3 MiB each. The
#      frame-to-frame loop no longer copies a full-width row per frame either
#      (that was 1.53 GB of memcpy). This is a WIDTH change only: the old loop
#      wrote `cur = prev.copy()` and then overwrote exactly the facing rows, so
#      a non-facing residue held frame 0's value for every frame by induction —
#      that value is now stored once, in `first`, and read straight out during
#      the broadcast.
#
#   3. THE PER-POINT BROADCAST IS AN ARRAY OP, NOT A PYTHON LOOP. It used to be
#      `for t in range(n_frames): for res in atom_res_idx:` appending three
#      boxed floats — 194 million iterations building 582.5 million PyFloat
#      objects, which at 8 bytes of list slot plus a 24-byte float is 17.4 GiB
#      of transient on top of everything above. It never got there: on the full
#      15000 frames it raised MemoryError inside that loop after 60 s at 22.6
#      GiB resident, against a 32 GiB address-space cap. Where it does fit, it
#      is linear and slow — 3.09 s at 500 frames, 8.71 s at 1500, 29.63 s at
#      5000, i.e. ~169 frames/s, extrapolating to ~89 s for 15000 against the
#      producer's 5.0 s mod budget. The array version measures 0.057 / 0.172 /
#      0.321 s on those same three, and 0.97 s on all 15000 — 54x, 51x, 92x, and
#      a case the old code cannot complete at all. Bit-identical output at every
#      size that can be compared.
#
# WHAT IS DELIBERATELY *NOT* VECTORISED: the frame-to-frame sign recurrence
# below is still a Python loop over frames, because frame t's sign depends on
# frame t-1's — it is a genuine sequential scan. It CAN be written as a
# cumulative product of the raw adjacent-frame dots with a reset wherever a dot
# is exactly zero (a degenerate C/O overlap makes one), and that would be exactly
# equivalent, but it is the one piece of this file whose *values* are subtle and
# it is left alone on purpose. Narrowed to the facing residues it measures 0.046
# s over 15000 frames, which is not where the time was. What is left is the
# output write itself: of the 0.97 s, 0.82 s is filling 2.17 GiB and 0.08 s is
# the gather. That floor is the contract's, not this mod's — a per-point
# per-frame channel over 15000 frames IS 2.33 GB.
#
# WHY THE RETURN IS A float32 ndarray AND NOT A LIST: the producer stores this
# channel as little-endian float32 — `install_channel` does
# `np.ascontiguousarray(values, dtype="<f4")` — so an array that is already
# contiguous "<f4" is adopted with no copy, while a list costs ~32 bytes per
# element to box and then a full second array to unbox into. The stored bytes are
# identical either way: the old path made float64 Python floats and let
# `install_channel` round them to float32; this path rounds the same float64
# values to float32 once, itself. One rounding step, same direction, same result
# — checked by sha256 over the exact installed bytes, not by a tolerance, on
# seven real systems (adk, the nucleic duplex, the trp cage, 10GJ, 5DZT, 1b0c and
# the membrane), on six hand-built fixtures for the branches those systems
# cannot reach (nothing has a facing / a C and O at identical coordinates / a
# chain that leads with non-facing residues / a nucleotide BETWEEN peptide
# residues / opposing neighbours that swing / every atom facing), and on the
# 15000-frame file at 500, 1500 and 5000 frames. Also byte-identical through the
# real serve() loop: the frame chunk the viewer receives, and the coherence
# warning text, are unchanged.

# The nucleobase ring, in the numbering every nucleotide shares (see WHAT VECTOR,
# NUCLEIC above). Names only — no element check, because a modified base can put
# any element on a ring position.
_BASE_RING = frozenset(("N1", "C2", "N3", "C4", "C5", "C6", "N7", "C8", "N9"))
# Three points define a plane; fewer cannot.
_MIN_RING_ATOMS = 3
# WHICH residues get a base plane: only ones that ARE nucleotides, by ATOM SIGNATURE
# — the sugar's two main-chain carbons plus at least one phosphodiester link atom, in
# both the primed and the starred spelling, with the ELEMENT checked so a name alone
# cannot vouch for an atom. `cartoon` runs the same signature plus a BOND belt
# (consecutive signature atoms bonded to each other), which would need a whole-topology
# adjacency map; the belt is dropped here deliberately, because this test decides only
# which VECTOR a residue is handed, never what is drawn, so a false positive costs a
# facing nobody reads. The tighter test that decides what is DRAWN lives in `cartoon`.
# It matters that the test is this narrow. Cholesterol carries C2/C4/C5/C6, so a
# bare ring-name test would hand a membrane's sterols a "base plane" and let a
# floppy one raise a coherence warning about a ribbon that does not exist.
# WHAT THE NUCLEIC ARM CHANGES ON A PROTEIN SYSTEM, measured rather than claimed:
# nothing on adk, 1b0c, the trp cage, the membrane or the ligand system — the
# channel is byte-identical there. On 5DZT it moves 23 of 7435 points, which is
# exactly the bound AMP: a free nucleotide monomer, which now gets its real base
# plane instead of the frozen running reference. It draws nothing either way, since
# it owns no trace vertex — so no monomer gate is worth the spatial hash it needs.
_SUGAR_PAIRS = ((("C4'", "C"), ("C3'", "C")), (("C4*", "C"), ("C3*", "C")))
_LINK_ATOMS = (("P", "P"), ("O3'", "O"), ("O5'", "O"), ("O3*", "O"), ("O5*", "O"))

# The per-point broadcast's gather is done in frame BLOCKS so its transient stays
# bounded no matter how big the trajectory is: a whole-trajectory gather would
# allocate a second copy the size of the output (2.2 GiB on the 15000-frame file).
# ~8M float32 elements is a 32 MB transient and, at 15000 frames, ~30 blocks —
# a Python loop short enough to not register.
_GATHER_BLOCK_ELEMS = 8_000_000


def _has_named(by_name, sig):
    """True when every (name, element) in `sig` is present. An atom carrying no
    element at all passes the element half — the topology is not second-guessed."""
    for nm, sym in sig:
        a = by_name.get(nm)
        if a is None:
            return False
        e = a.element
        got = (e.symbol or "").strip().upper() if e is not None else ""
        if got and got != sym:
            return False
    return True


def _is_nucleotide(residue):
    by = {}
    for a in residue.atoms:
        by.setdefault(a.name, a)
    if not any(_has_named(by, (link,)) for link in _LINK_ATOMS):
        return False
    return any(_has_named(by, pair) for pair in _SUGAR_PAIRS)


def compute(data, target_indices, params=None):
    if data.trajectory is None:
        raise ValueError(
            "ribbon_dir needs coordinates to read the backbone geometry, but this "
            "source has no trajectory (data.trajectory is None)."
        )

    traj = data.trajectory
    top = traj.topology
    n_frames = traj.n_frames
    n_res = top.n_residues
    n_points = int(top.n_atoms)

    # Backbone C and O of each residue, by name, or None where absent; and the
    # base-ring atoms of each residue, for the nucleic arm.
    res_C = {}
    res_O = {}
    res_ring = {}
    for res in top.residues:
        c_idx = o_idx = None
        ring = []
        for atom in res.atoms:
            if atom.name == "C":
                c_idx = atom.index
            elif atom.name == "O":
                o_idx = atom.index
            if atom.name in _BASE_RING:
                ring.append(atom.index)
        res_C[res.index] = c_idx
        res_O[res.index] = o_idx
        res_ring[res.index] = (ring if len(ring) >= _MIN_RING_ATOMS
                               and _is_nucleotide(res) else [])

    default_vec = np.array([1.0, 0.0, 0.0])

    # WHO HAS A FACING, decided from the TOPOLOGY ALONE and before any coordinate
    # is touched — that ordering is what lets the atom slice below happen before
    # the float64 promotion. The peptide arm claims first; the NUCLEIC arm takes
    # the base-plane normal for every residue it did not claim. From there down
    # there is ONE set of residues-that-have-a-facing and one sign resolution over
    # it, exactly as before.
    has_bb = np.zeros(n_res, dtype=bool)
    pep_res = [i for i in range(n_res) if res_C[i] is not None and res_O[i] is not None]
    has_bb[pep_res] = True
    nuc_res = [i for i in range(n_res) if not has_bb[i] and res_ring[i]]
    has_bb[nuc_res] = True
    bb_res = sorted(pep_res + nuc_res)

    if not bb_res:
        raise ValueError(
            "ribbon_dir found nothing to orient a ribbon along: not one residue "
            "carries both a backbone C and O atom (a peptide plane), and not one "
            "is a nucleotide carrying at least "
            f"{_MIN_RING_ATOMS} nucleobase ring atoms (N1/C2/N3/C4/C5/C6, plus "
            "N7/C8/N9 on a purine). A ribbon needs a facing; `cartoon "
            "?style=tube` needs none."
        )

    # Residue index -> its COLUMN in the narrow per-facing-residue arrays below,
    # ascending by residue index (so column order is `bb_res` order). -1 for a
    # residue with no facing, which owns no column and is never looked up.
    col = np.full(n_res, -1, dtype=np.intp)
    col[bb_res] = np.arange(len(bb_res), dtype=np.intp)

    # THE ATOM SLICE (cost note 1 in the header): the union of both arms' atoms,
    # then float64. mdtraj stores float32 and float32 subtraction of nearby
    # coordinates loses digits that matter once the result is used as a
    # direction, so the promotion must happen before any differencing — but only
    # over the atoms that get differenced.
    needed = set()
    for i in pep_res:
        needed.add(res_C[i])
        needed.add(res_O[i])
    for i in nuc_res:
        needed.update(res_ring[i])
    needed = np.asarray(sorted(needed), dtype=np.intp)
    xyz = traj.xyz[:, needed, :].astype(np.float64)
    # global atom index -> its column in `xyz`
    loc = np.full(n_points, -1, dtype=np.intp)
    loc[needed] = np.arange(needed.size, dtype=np.intp)

    # Raw facing per FACING residue per frame, normalized to unit length.
    raw = np.empty((n_frames, len(bb_res), 3), dtype=np.float64)
    if pep_res:
        c_arr = loc[np.asarray([res_C[i] for i in pep_res], dtype=np.intp)]
        o_arr = loc[np.asarray([res_O[i] for i in pep_res], dtype=np.intp)]
        d = xyz[:, o_arr, :] - xyz[:, c_arr, :]
        norms = np.linalg.norm(d, axis=2, keepdims=True)
        norms[norms < 1e-12] = 1.0                          # degenerate C/O overlap
        raw[:, col[pep_res], :] = d / norms
    for i in nuc_res:
        pts = xyz[:, loc[np.asarray(res_ring[i], dtype=np.intp)], :]
        centred = pts - pts.mean(axis=1, keepdims=True)
        cov = np.einsum("tka,tkb->tab", centred, centred)   # (n_frames, 3, 3)
        # eigh returns ASCENDING eigenvalues, so column 0 is the least-variance
        # direction — the plane normal. Its sign is arbitrary; see the header.
        nrm = np.linalg.eigh(cov)[1][:, :, 0]
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        ln[ln < 1e-12] = 1.0                                # degenerate ring
        raw[:, col[i], :] = nrm / ln

    # --- frame 0: the along-chain walk, which fixes the sign convention once ---
    # Full-width (one row per residue, 3 doubles) because a residue with NO
    # facing gets its one and only value here — the running reference at the
    # moment the walk passed it — and holds it for every frame.
    first = np.empty((n_res, 3), dtype=np.float64)
    raw0 = raw[0]
    for chain in top.chains:
        prev_vec = None
        for res in chain.residues:
            i = res.index
            if has_bb[i]:
                rv = raw0[col[i]]
                vec = -rv if (prev_vec is not None and np.dot(rv, prev_vec) < 0) else rv
                prev_vec = vec
            else:
                vec = prev_vec.copy() if prev_vec is not None else default_vec.copy()
            first[i] = vec

    # --- later frames: each residue resolved against ITS OWN previous frame ---
    # Over the FACING residues only. A non-facing residue's row was previously
    # carried forward by `cur = prev.copy()` every frame and never written again,
    # so it equalled `first[i]` on every frame; it is read from `first` directly
    # in the broadcast below instead of being copied n_frames times.
    resolved = np.empty((n_frames, len(bb_res), 3), dtype=np.float64)
    resolved[0] = first[np.asarray(bb_res, dtype=np.intp)]
    for t in range(1, n_frames):
        prev = resolved[t - 1]
        rv = raw[t]                                         # (n_facing, 3)
        flip = (rv * prev).sum(axis=1) < 0.0
        resolved[t] = np.where(flip[:, None], -rv, rv)

    # BROADCAST: the channel is per-POINT, but a carbonyl is per-RESIDUE. Every
    # atom inherits its own residue's vector — one value per atom per frame, or
    # the length check refuses the return.
    #
    # AND IT IS WHOLE-SYSTEM: target_indices does NOT shrink a channel. The
    # length check is against every point in the system
    # (n_frames * n_points * components), so emitting only the target's atoms is
    # refused — `cartoon @selection_1` on a 296-point selection returned
    # 98*296*3 = 87024 where 98*3341*3 = 982254 was required. A channel is a
    # column of data over the whole system; WHERE it applies is decided later by
    # the `bind` target, not here. So we ignore target_indices deliberately.
    #
    # For this channel that is also what you want: `shape traces ribbon` is
    # scene-level, so every trace becomes a ribbon whether or not it was in the
    # selection. If orientation existed only over the selection, every OTHER
    # backbone would turn into a ribbon with a zero facing vector and collapse
    # out of sight.
    #
    # TWO writes into the returned array, in this order (cost note 3):
    #
    #   1. EVERY atom is filled with frame 0's value for its residue. For an
    #      atom of a NON-FACING residue that is already its value on every
    #      frame, and the write is one CONTIGUOUS (n_points, 3) block broadcast
    #      down the frame axis. That ordering is the whole trick: scattering
    #      only the non-facing columns instead — the obvious way, since they are
    #      the ones that need it — writes the same number of bytes through a
    #      12583-of-12944-column fancy index, and measured 2.07 s where this
    #      contiguous broadcast measures 0.82 s on the 15000-frame file. Skipped
    #      entirely when every atom has a facing, since step 2 then covers the
    #      whole array (and step 2 then writes a contiguous destination too).
    #   2. An atom of a FACING residue is overwritten with its residue's column
    #      of `resolved`, cast to float32 FIRST so the gather's transient is
    #      float32 and the float64 -> float32 rounding happens exactly once.
    atom_res = np.fromiter((atom.residue.index for atom in top.atoms),
                           dtype=np.intp, count=n_points)
    moving_atoms = np.flatnonzero(has_bb[atom_res])
    whole = moving_atoms.size == n_points       # nothing to freeze; step 2 fills all

    out = np.empty((n_frames, n_points, 3), dtype="<f4")
    if not whole:
        out[...] = first[atom_res].astype("<f4")
    if moving_atoms.size:
        cols = col[atom_res[moving_atoms]]
        res32 = resolved.astype("<f4")
        step = max(1, _GATHER_BLOCK_ELEMS // (moving_atoms.size * 3))
        for s in range(0, n_frames, step):
            e = min(s + step, n_frames)
            block = res32[s:e][:, cols, :]
            # a contiguous destination when the gather covers every atom
            if whole:
                out[s:e] = block
            else:
                out[s:e, moving_atoms, :] = block

    # No "name" in the return — the `# channel:` header above is the single
    # source of the channel's name, and a name here is refused. No min/max
    # either: a range is meaningless for a vector axis, which is consumed raw.
    return {"values": out, "components": 3}
