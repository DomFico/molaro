"""DataSource — the interface every producer implements.

The renderer side only ever sees Header and FrameChunk messages; a real data
source later replaces SyntheticSource without touching the contract or the
renderer.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Tuple

from contract.contract import FrameChunk, Header


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
