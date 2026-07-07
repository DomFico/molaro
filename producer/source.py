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
