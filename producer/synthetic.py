"""SyntheticSource — a deterministic, structured synthetic dataset.

Generates a valid dataset for arbitrary N (points) and T (frames) behind the
DataSource interface. Positions are an analytic function of the frame index, so
any frame range can be produced on demand without ever materializing all T
frames — the same access pattern a real chunked data source will have.

Structure of the synthetic data (data only — nothing about appearance):
- Points are split into contiguous subgroups; subgroups are grouped into
  top-level groups (two-level hierarchy: point -> subgroup -> group).
- Each group sits on a ring around the origin; each subgroup is offset within
  its group; each point scatters around its subgroup center and oscillates
  sinusoidally with a per-point phase.
- Channels: "mass" (per_point), "time" (per_frame), "energy"
  (per_point_per_frame, shipped in every FrameChunk).
- Edges chain consecutive points within each subgroup; one polyline threads
  through the first point of every subgroup.
"""
from __future__ import annotations

import math

import numpy as np

from contract.contract import (
    VERSION,
    BBox,
    Channel,
    ContractError,
    FrameChunk,
    Header,
    Points,
)
from producer.source import DataSource

_CATEGORIES = ["alpha", "beta", "gamma"]
_AMPLITUDE = 0.5


class SyntheticSource(DataSource):
    def __init__(
        self,
        n_points: int,
        n_frames: int,
        seed: int = 0,
        n_groups: int = 3,
        subgroups_per_group: int = 4,
    ) -> None:
        if n_points < 1 or n_frames < 1:
            raise ValueError("n_points and n_frames must be >= 1")
        self.n_points = n_points
        self.n_frames = n_frames
        self.n_groups = max(1, min(n_groups, n_points))
        self.subgroups_per_group = max(1, subgroups_per_group)
        n_subgroups = min(self.n_groups * self.subgroups_per_group, n_points)
        self.n_subgroups = n_subgroups

        rng = np.random.default_rng(seed)
        p = np.arange(n_points)
        # Contiguous blocks of points per subgroup; subgroup -> group by division.
        self.subgroup_id = (p * n_subgroups // n_points).astype(np.int64)
        self.group_id = self.subgroup_id * self.n_groups // n_subgroups

        # Group centers on a ring, subgroup centers on smaller rings within.
        g_angle = 2 * np.pi * np.arange(self.n_groups) / self.n_groups
        g_centers = np.stack(
            [10 * np.cos(g_angle), 10 * np.sin(g_angle), np.linspace(-2, 2, self.n_groups)],
            axis=1,
        )
        sg = np.arange(n_subgroups)
        sg_angle = 2 * np.pi * (sg % self.subgroups_per_group) / self.subgroups_per_group
        sg_centers = g_centers[sg * self.n_groups // n_subgroups] + np.stack(
            [3 * np.cos(sg_angle), 3 * np.sin(sg_angle), 0.3 * sg],
            axis=1,
        )

        scatter = rng.normal(scale=0.8, size=(n_points, 3))
        self.base = (sg_centers[self.subgroup_id] + scatter).astype(np.float32)
        self.phase = rng.uniform(0, 2 * np.pi, size=n_points).astype(np.float32)
        # Unit-ish direction of oscillation per point.
        direction = rng.normal(size=(n_points, 3))
        direction /= np.linalg.norm(direction, axis=1, keepdims=True)
        self.direction = direction.astype(np.float32)

        self.mass = rng.uniform(0.5, 5.0, size=n_points).astype(np.float32)
        self.category = rng.integers(0, len(_CATEGORIES), size=n_points)

        # First point of each subgroup is an "anchor", the rest are "tracers".
        first_of_subgroup = np.zeros(n_points, dtype=bool)
        first_of_subgroup[np.unique(self.subgroup_id, return_index=True)[1]] = True
        self.point_type = ["anchor" if a else "tracer" for a in first_of_subgroup]
        self.anchor_indices = [int(i) for i in np.flatnonzero(first_of_subgroup)]

    # -- DataSource interface -------------------------------------------------

    def give_header(self) -> Header:
        edges = []
        for s in range(self.n_subgroups):
            members = np.flatnonzero(self.subgroup_id == s)
            for a, b in zip(members[:-1], members[1:]):
                edges.append((int(a), int(b)))
        polylines = [self.anchor_indices] if len(self.anchor_indices) >= 2 else []

        lo = self.base.min(axis=0) - _AMPLITUDE
        hi = self.base.max(axis=0) + _AMPLITUDE

        return Header(
            version=VERSION,
            name="synthetic",
            n_points=self.n_points,
            n_frames=self.n_frames,
            units="meters",
            bbox=BBox(min=tuple(float(v) for v in lo), max=tuple(float(v) for v in hi)),
            points=Points(
                type=list(self.point_type),
                group_id=[int(g) for g in self.group_id],
                subgroup_id=[int(s) for s in self.subgroup_id],
                category=[int(c) for c in self.category],
            ),
            categories=list(_CATEGORIES),
            groups={g: f"group-{g}" for g in range(self.n_groups)},
            subgroups={s: f"subgroup-{s}" for s in range(self.n_subgroups)},
            edges=edges,
            polylines=polylines,
            channels=[
                Channel(
                    name="mass",
                    scope="per_point",
                    min=float(self.mass.min()),
                    max=float(self.mass.max()),
                    data=[float(m) for m in self.mass],
                ),
                Channel(
                    name="time",
                    scope="per_frame",
                    min=0.0,
                    max=float(self._time(self.n_frames - 1)),
                    data=[float(self._time(f)) for f in range(self.n_frames)],
                ),
                Channel(name="energy", scope="per_point_per_frame", min=0.0),
            ],
        )

    def give_frames(self, start: int, count: int) -> FrameChunk:
        if count < 1 or start < 0 or start + count > self.n_frames:
            raise ContractError(
                f"requested frames [{start}, {start + count}) outside [0, {self.n_frames})"
            )
        # '<f4' pins little-endian float32 regardless of host byte order.
        positions = np.empty((count, self.n_points, 3), dtype="<f4")
        energy = np.empty((count, self.n_points), dtype="<f4")
        for k in range(count):
            f = start + k
            theta = self._omega() * f + self.phase
            offset = _AMPLITUDE * np.sin(theta)[:, None] * self.direction
            positions[k] = self.base + offset.astype(np.float32)
            # Kinetic energy of the oscillation: 0.5 * m * v^2.
            speed = _AMPLITUDE * self._omega() * np.cos(theta)
            energy[k] = (0.5 * self.mass * speed * speed).astype(np.float32)
        return FrameChunk(
            start=start,
            count=count,
            positions=positions.tobytes(),
            channels={"energy": energy.tobytes()},
        )

    # -- internals -------------------------------------------------------------

    def _omega(self) -> float:
        """Angular step per frame: two full oscillations over the dataset."""
        return 2.0 * math.pi * 2.0 / self.n_frames

    @staticmethod
    def _time(frame: int) -> float:
        return frame * (1.0 / 30.0)
