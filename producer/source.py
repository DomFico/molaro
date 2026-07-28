"""DataSource — the interface every producer implements.

The renderer side only ever sees Header and FrameChunk messages; a real data
source later replaces SyntheticSource without touching the contract or the
renderer.

Also home to the DISPLAY FRAME CAP (``DEFAULT_MAX_FRAMES`` /
``stride_for_frame_cap``) — a property of the frame axis every DataSource serves,
kept here because it must be importable WITHOUT the molecular stack: ``serve.py``
needs the default for its ``--max-frames`` CLI default and imports
``mdtraj_source`` only lazily, so this is the one place the number lives.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional, Tuple

from contract.contract import FrameChunk, Header

# Display frame cap ------------------------------------------------------------
#
# How many frames the viewer SHOWS is a display decision, not whatever a file
# happens to contain. A trajectory longer than this cap is loaded with a STRIDE
# — one frame in ceil(T/cap) — so the served frame count stays bounded however
# long the run was. The header says so out loud (Header.provenance).
#
# WHY A CAP AT ALL, and why here rather than in each mod. The binding constraint
# is NOT read time: reading all 15000 frames x 12944 atoms of the owner's
# BACD_rep9.dcd through mdtraj takes 1.16 s (measured here, twice, identical —
# md.open + read in 500-frame chunks, warm page cache, 2331 MB off disk). The wall
# is a
# per_point_per_frame VECTOR channel, whose size the contract FIXES at
# n_frames * n_points * components * 4 B — for that trajectory
# 15000 * 12944 * 3 * 4 = 2 329 920 000 B = 2.33 GB, the size of the trajectory
# itself. It must be finite-checked element by element, cross the stdio wire and
# live in a webview Float32Array. No mod-side cleverness shrinks it, because the
# contract demands exactly that length. Capping the frame count removes the whole
# class of problem at once, for every present and future channel mod, instead of
# teaching each one to cope.
#
# WHY 500 (both halves measured, 2026-07-26):
#   * it makes that channel unremarkable — 500 * 12944 * 3 * 4 = 77 664 000 B
#     = 78 MB on the same system, 30x smaller;
#   * it leaves EVERY corpus system at stride 1, hence byte-identical. The corpus
#     frame counts are 150 (01_alanine), 150 (02_trpcage), 98 (03_adk), 120
#     (04_ligand), 150 (05_macrocycle), 1 (06_membrane), 1 (07_coarse_grain),
#     120 (09_nucleic), 100 (10_tip4p) — longest 150, which 500 clears by 3.3x.
# On BACD_rep9.dcd (15000 frames) this cap yields stride 30 and exactly 500
# frames.
DEFAULT_MAX_FRAMES = 500


def stride_for_frame_cap(n_file_frames: int, max_frames: Optional[int]) -> int:
    """The frame stride that keeps a trajectory under ``max_frames``.

    1 when the trajectory already fits, or when the cap is disabled (``None`` or
    ``<= 0`` — "load every frame"); otherwise ``ceil(n_file_frames/max_frames)``,
    the SMALLEST stride for which ``len(range(0, n_file_frames, stride))`` is
    ``<= max_frames``. That length is the served ``n_frames``; e.g. 15000 frames
    under a 500 cap gives stride 30 and exactly 500 served frames, and 15001
    gives stride 31 and 484.

    Stride 1 is returned as an ordinary value, not a special case: the callers
    then take their pre-existing unstrided code path, so an uncapped load is
    byte-identical to one with no frame cap in the code at all.
    """
    if not isinstance(n_file_frames, int) or n_file_frames < 1:
        raise ValueError(f"n_file_frames must be a positive int, got {n_file_frames!r}")
    if max_frames is None or max_frames <= 0:
        return 1
    if n_file_frames <= max_frames:
        return 1
    return -(-n_file_frames // max_frames)   # ceil division, ints only


class LabelView:
    """Read-only view of the viewer's OWN labels for each point, indexed in
    header order (aligned with ``target_indices`` and ``trajectory.xyz``
    columns — the same correspondence ``trajectory`` guarantees).

    ``labels[i]`` -> ``(category, group, subgroup)`` as the exact strings the
    viewer displays and the address grammar matches, e.g.
    ``("polymer", "A", "ASP 33")``. A ``produces: commands`` mod builds command
    strings, which name these labels; it must take the category/group/subgroup
    names from HERE rather than infer them (e.g. ``chr(65 + chain.index)``),
    which silently mismatches whenever the producer's labels don't line up with
    that guess — the grammar then nomatches and the mod colors nothing while
    reporting success.

    The fallbacks mirror the viewer's label resolution (webview/sets.ts) exactly
    so the string a mod addresses is the string the viewer matches.
    """

    __slots__ = ("_category", "_group_id", "_subgroup_id", "_categories",
                 "_groups", "_subgroups", "_n")

    def __init__(self, header: Header) -> None:
        pts = header.points
        self._category = pts.category
        self._group_id = pts.group_id
        self._subgroup_id = pts.subgroup_id
        self._categories = header.categories
        self._groups = header.groups
        self._subgroups = header.subgroups
        self._n = header.n_points

    def __len__(self) -> int:
        return self._n

    def __getitem__(self, i: int) -> Tuple[str, str, str]:
        cid = self._category[i]
        gid = self._group_id[i]
        sid = self._subgroup_id[i]
        category = (self._categories[cid] if 0 <= cid < len(self._categories)
                    else f"category {cid}")
        group = self._groups.get(gid, f"group {gid}")
        subgroup = self._subgroups.get(sid, f"subgroup {sid}")
        return (category, group, subgroup)


class EdgeView:
    """Read-only view of the connectivity the viewer actually DRAWS, indexed in
    header edge order — ``edges[e]`` -> ``(i, j)`` point indices.

    Why a mod needs this, and why ``data.trajectory.topology.bonds`` is not the
    same thing any more. Two passes build the header's edge list: the topology's
    own declared bonds, and covalent-radius inference for what the file leaves
    out (``producer/bond_inference.py``). Inference does NOT mutate the topology —
    that is deliberate, because mutating it would move the coordinates a mod and
    the wrapping grouping both read — so the two now DISAGREE, and by a lot: on
    the corpus membrane the topology declares 50,495 bonds while the viewer draws
    173,940. A mod that walks ``topology.bonds`` to reason about connectivity (a
    cartoon mod counting bonded hydrogens, say) would silently miss 71% of it and
    could not even detect that a divergence existed.

    This is the same shape of answer ``frame_stride``/``n_frames_in_file`` gave
    for the frame axis: expose BOTH truths and name which is which, rather than
    picking one. ``topology.bonds`` remains "what the file said"; ``data.edges``
    is "what is on screen", after inference and after the periodic-image cutoff
    that drops cross-box bonds.

    Lazy: it holds the header's own list and indexes into it, so asking for it
    costs nothing until a mod reads an element.
    """

    __slots__ = ("_edges",)

    def __init__(self, header: Header) -> None:
        self._edges = header.edges

    def __len__(self) -> int:
        return len(self._edges)

    def __getitem__(self, e: int) -> Tuple[int, int]:
        i, j = self._edges[e]
        return (int(i), int(j))

    def __iter__(self):
        for i, j in self._edges:
            yield (int(i), int(j))


class DataSource(ABC):
    """Answers the two logical protocol requests (SPEC.md)."""

    @abstractmethod
    def give_header(self) -> Header:
        """HeaderRequest -> Header: all constant metadata for the dataset."""

    @abstractmethod
    def give_frames(self, start: int, count: int) -> FrameChunk:
        """FrameChunkRequest -> FrameChunk for frames [start, start+count).

        Must hold: 0 <= start, count >= 1, start + count <= n_frames.
        """

    @property
    def trajectory(self):
        """The domain trajectory object a mod's ``compute(data, ...)`` may use,
        or ``None`` when the source has none (the synthetic source).

        This is the ONE domain-aware seam on the otherwise neutral source: a
        trajectory-backed source (``MdtrajSource``) overrides it to return its
        live ``mdtraj.Trajectory``; every other source reports ``None`` so a
        mod can fail closed on datasets it does not apply to. The neutral
        protocol (give_header / give_frames) never touches this, so exposing it
        changes nothing about how the dataset is transported, parsed, or
        rendered — see docs/COMMANDS.md for the mod-facing API.

        Index alignment guarantee: point index ``i`` in header order is atom
        index ``i`` in ``trajectory.topology`` and column ``i`` in
        ``trajectory.xyz`` (verified in tests/reference_mods_corpus.py).
        """
        return None

    @property
    def frame_stride(self) -> int:
        """How many of the source's own frames each SERVED frame steps over: 1
        when every frame is served, ``s`` when only every ``s``-th was loaded.

        Neutral information (every source has a frame axis), so it lives on the
        base and defaults to 1. A source that subsamples a long trajectory
        overrides it. Why a mod can need this: header ``n_frames``,
        ``give_frames`` and ``data.trajectory`` all agree on the SERVED frames, so
        a mod's arithmetic is self-consistent without it — but a mod that reports
        "measured over the trajectory", or that does its OWN frame subsampling on
        a cost budget, is composing on top of this one and should be able to say
        so. ``Header.provenance`` states the same fact for the user.
        """
        return 1

    @property
    def n_frames_in_file(self) -> int:
        """The frame count BEFORE any stride — what the file actually holds. Equal
        to the served ``n_frames`` whenever ``frame_stride`` is 1 (and for a
        source with no file at all, e.g. the synthetic one)."""
        return int(getattr(self, "n_frames", 0))

    @property
    def labels(self) -> LabelView:
        """The viewer's own labels for every point, indexed in header order —
        ``data.labels[i]`` -> ``(category, group, subgroup)`` (see LabelView).

        This is neutral information, not domain information: it comes from the
        header the producer already builds, so EVERY source has it (the
        synthetic source included), unlike ``trajectory``. Read-only — a mod
        consumes labels, it does not set them. Additive on the producer side;
        the neutral protocol (give_header / give_frames) is untouched.

        Cached on first access; headers are constant for a resident dataset.
        """
        view = getattr(self, "_label_view", None)
        if view is None:
            view = LabelView(self.give_header())
            # cache on the instance (base ABC has no __init__ to preallocate it)
            self._label_view = view
        return view

    def neighborhood(self, indices, distance, keep=False):
        """Points near ``indices``, grown to WHOLE SUBGROUPS. THE one implementation.

        WHY THIS IS HERE AND NOT COPIED INTO EACH MOD. It was pasted into three mods
        first, and the unit was wrong in all three at once — `?within=5` meant 5 A in
        a mod and 5 scene units in the built-in `create_sele`/`hide`, an 18x-211x
        difference the owner caught by looking at the screen. Four more mods wanted
        the same helper. Seven copies of a distance rule is a standing invitation to
        that bug, so there is now one copy and one unit.

        ``distance`` is in the SCENE'S COORDINATE UNITS — the same number the
        built-in flags take, deliberately, so one flag name means one thing. For an
        mdtraj-backed source that is nanometres.

        BYRES BY SUBGROUP, matching the neutral tier exactly: the viewer's own
        ``subgroup_id`` is the grouping, not the topology's residue table, so a mod
        and the built-in cannot disagree about what "whole" means. A radius through
        raw points cuts a subgroup in half, which reads as damage rather than as a
        neighbourhood.

        ``keep`` decides whether the named target comes along, applied at SUBGROUP
        grain too — excluding only the named points would strand the rest of their
        subgroup, which is the same half-a-subgroup artefact one level up.

        MEASURED AT FRAME 0, and that is a real limitation rather than an oversight:
        a mod is never told which frame is displayed (the run request carries code,
        target, parameters and nothing else). Correct for a static site, wrong for
        anything that diffuses; re-run after scrubbing to re-measure. The built-in
        flags DO measure at the displayed frame, so the two agree only at frame 0
        until that field exists.
        """
        import numpy as np

        traj = self.trajectory
        if traj is None:
            raise RuntimeError(
                "?within needs a coordinate-backed dataset; this source has none."
            )
        sel = sorted({int(i) for i in indices})
        if not sel:
            raise ValueError(
                "?within needs a target to be around — bare `?within` would mean "
                '"everything except everything". Name a selection or a region.'
            )
        if not (distance > 0):
            raise ValueError(
                f"?within must be a positive distance in scene units, got {distance}."
            )
        sub = self.give_header().points.subgroup_id
        xyz = np.asarray(traj.xyz[0], dtype=np.float64)

        try:
            from scipy.spatial import cKDTree
            hits = cKDTree(xyz).query_ball_point(xyz[sel], float(distance))
            near_pts = {int(j) for group in hits for j in group}
        except ImportError:                      # scipy is an mdtraj dependency, but
            d2 = float(distance) ** 2            # never make the fallback a surprise
            near_pts = {
                int(j) for j in range(len(sub))
                if ((xyz[j] - xyz[sel]) ** 2).sum(axis=1).min() <= d2
            }

        own_subs = {sub[i] for i in sel}
        near_subs = {sub[j] for j in near_pts}
        wanted = (near_subs | own_subs) if keep else (near_subs - own_subs)
        out = sorted(i for i in range(len(sub)) if sub[i] in wanted)
        if not out:
            raise ValueError(
                f"?within={distance} found nothing within {distance} scene units of "
                "the target (measured at frame 0). Try a larger radius, or "
                "?keep=true to keep the target itself."
            )
        return out

    @property
    def edges(self) -> EdgeView:
        """The connectivity the viewer DRAWS, in header edge order — see
        ``EdgeView`` for why this is not ``data.trajectory.topology.bonds``.

        Neutral information (every source has an edge list, the synthetic one
        included), so it lives on the base next to ``labels`` rather than on the
        one domain-aware subclass. Read-only, and cached on first access because
        headers are constant for a resident dataset."""
        view = getattr(self, "_edge_view", None)
        if view is None:
            view = EdgeView(self.give_header())
            self._edge_view = view
        return view
