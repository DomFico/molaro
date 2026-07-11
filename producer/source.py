"""DataSource — the interface every producer implements.

The renderer side only ever sees Header and FrameChunk messages; a real data
source later replaces SyntheticSource without touching the contract or the
renderer.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from contract.contract import FrameChunk, Header


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
