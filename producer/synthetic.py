"""SyntheticSource — a deterministic, structured synthetic dataset.

Generates a valid dataset for arbitrary N (points) and T (frames) behind the
DataSource interface. Positions are an analytic function of the frame index, so
any frame range can be produced on demand without ever materializing all T
frames — the same access pattern a real chunked data source will have.

Structure of the synthetic data (data only — nothing about appearance):
- Points split into two populations:
  - a *structured* minority organized into a small two-level hierarchy
    (point -> subgroup -> group), each subgroup a contiguous block on a ring;
    its points carry the categories "alpha"/"beta"/"gamma".
  - a *bulk* majority (category "solvent") scattered around the structure and
    chopped into many tiny subgroups — a stand-in for solvent/environment. This
    makes "solvent" a genuine high-cardinality (bulk) category: tens of
    thousands of points spread over thousands of subgroups, which is exactly the
    case the renderer's bulk-collapse and default-hide behavior must handle.
- Each point scatters around its subgroup center and oscillates sinusoidally
  with a per-point phase.
- Channels: "mass" (per_point), "time" (per_frame), "energy"
  (per_point_per_frame, shipped in every FrameChunk).
- Edges chain consecutive points within each subgroup; one polyline threads
  through the anchor point of every *structured* subgroup (the bulk population is
  deliberately left unthreaded so it never becomes a giant line).

For tiny N (below `_BULK_MIN_POINTS`) the bulk population is omitted and every
point is structured, so small shapes stay well-formed.
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

# "solvent" is the bulk (high-cardinality) category; its index is len-1.
_CATEGORIES = ["alpha", "beta", "gamma", "solvent"]
_STRUCTURED_CATEGORIES = 3  # alpha/beta/gamma; index 3 == solvent == bulk
_BULK_CATEGORY = 3
_AMPLITUDE = 0.5

# Below this many points, skip the bulk population entirely (keeps tiny shapes
# well-formed and avoids single-point subgroups dominating).
_BULK_MIN_POINTS = 200
# Fraction of points that go into the bulk (solvent-like) population.
_BULK_FRACTION = 0.8
# Target points per tiny bulk subgroup (a "solvent molecule").
_BULK_SUBGROUP_SIZE = 3


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

        rng = np.random.default_rng(seed)

        # -- decide the structured / bulk split ------------------------------
        n_sub_struct = min(self.n_groups * self.subgroups_per_group, n_points)
        if n_points >= _BULK_MIN_POINTS:
            # Structured minority; at least 2 points per structured subgroup so
            # every structured subgroup is a real (multi-point) block.
            n_struct = max(
                int(round((1.0 - _BULK_FRACTION) * n_points)),
                2 * n_sub_struct,
            )
            n_struct = min(n_struct, n_points)
        else:
            n_struct = n_points  # tiny dataset: everything is structured
        n_bulk = n_points - n_struct

        subgroup_id = np.empty(n_points, dtype=np.int64)
        group_id = np.empty(n_points, dtype=np.int64)
        category = np.empty(n_points, dtype=np.int64)

        # -- structured population: contiguous blocks -> subgroup -> group ----
        ps = np.arange(n_struct)
        struct_sub = (ps * n_sub_struct // max(n_struct, 1)).astype(np.int64)
        subgroup_id[:n_struct] = struct_sub
        group_id[:n_struct] = struct_sub * self.n_groups // n_sub_struct
        # Category tracks structure (per subgroup), not noise, so the non-bulk
        # tree has a meaningful category -> group -> subgroup shape.
        category[:n_struct] = struct_sub % _STRUCTURED_CATEGORIES

        # -- bulk population: many tiny subgroups under one bulk group --------
        n_bulk_sub = 0
        bulk_group_id = self.n_groups  # a dedicated group id for the bulk
        if n_bulk > 0:
            pb = np.arange(n_bulk)
            n_bulk_sub = int(math.ceil(n_bulk / _BULK_SUBGROUP_SIZE))
            bulk_sub = (pb // _BULK_SUBGROUP_SIZE).astype(np.int64)
            subgroup_id[n_struct:] = n_sub_struct + bulk_sub
            group_id[n_struct:] = bulk_group_id
            category[n_struct:] = _BULK_CATEGORY

        self.subgroup_id = subgroup_id
        self.group_id = group_id
        self.category = category
        self.n_subgroups = n_sub_struct + n_bulk_sub
        self.n_struct = n_struct
        self._n_sub_struct = n_sub_struct
        self._bulk_group_id = bulk_group_id if n_bulk > 0 else None

        # -- subgroup centers -------------------------------------------------
        # Structured subgroups: group centers on a ring, subgroups on smaller
        # rings within each group.
        g_angle = 2 * np.pi * np.arange(self.n_groups) / self.n_groups
        g_centers = np.stack(
            [10 * np.cos(g_angle), 10 * np.sin(g_angle), np.linspace(-2, 2, self.n_groups)],
            axis=1,
        )
        sg = np.arange(n_sub_struct)
        sg_angle = 2 * np.pi * (sg % self.subgroups_per_group) / self.subgroups_per_group
        struct_centers = g_centers[sg * self.n_groups // n_sub_struct] + np.stack(
            [3 * np.cos(sg_angle), 3 * np.sin(sg_angle), 0.3 * (sg % self.subgroups_per_group)],
            axis=1,
        )
        # Bulk subgroups: scattered through the volume enclosing the structure.
        if n_bulk_sub > 0:
            bulk_centers = rng.uniform(-14.0, 14.0, size=(n_bulk_sub, 3))
            sub_centers = np.concatenate([struct_centers, bulk_centers], axis=0)
        else:
            sub_centers = struct_centers

        scatter = rng.normal(scale=0.8, size=(n_points, 3))
        self.base = (sub_centers[self.subgroup_id] + scatter).astype(np.float32)
        self.phase = rng.uniform(0, 2 * np.pi, size=n_points).astype(np.float32)
        direction = rng.normal(size=(n_points, 3))
        direction /= np.linalg.norm(direction, axis=1, keepdims=True)
        self.direction = direction.astype(np.float32)

        self.mass = rng.uniform(0.5, 5.0, size=n_points).astype(np.float32)

        # First point of each subgroup is an "anchor"; the rest cycle through a
        # small spread of tracer types ("t0".."t3") so the leaf level carries
        # enough variety for type matching (literals, globs, trailing-int ranges).
        first_of_subgroup = np.zeros(n_points, dtype=bool)
        first_of_subgroup[np.unique(self.subgroup_id, return_index=True)[1]] = True
        self.point_type = [
            "anchor" if first_of_subgroup[p] else f"t{p % 4}" for p in range(n_points)
        ]
        # Polyline threads structured anchors only (never the bulk population).
        struct_first = first_of_subgroup.copy()
        struct_first[n_struct:] = False
        self.anchor_indices = [int(i) for i in np.flatnonzero(struct_first)]

    # -- DataSource interface -------------------------------------------------

    def give_header(self) -> Header:
        # Points are laid out so subgroup_id is non-decreasing (structured blocks
        # then bulk blocks), so consecutive same-subgroup points are the chain.
        sid = self.subgroup_id
        same = sid[:-1] == sid[1:]
        idx = np.flatnonzero(same)
        edges = [(int(a), int(a + 1)) for a in idx]
        polylines = [self.anchor_indices] if len(self.anchor_indices) >= 2 else []

        lo = self.base.min(axis=0) - _AMPLITUDE
        hi = self.base.max(axis=0) + _AMPLITUDE

        groups = {g: f"group-{g}" for g in range(self.n_groups)}
        if self._bulk_group_id is not None:
            groups[self._bulk_group_id] = "solvent-bath"
        subgroups = {}
        for s in range(self._n_sub_struct):
            subgroups[s] = f"subgroup-{s}"
        for s in range(self._n_sub_struct, self.n_subgroups):
            subgroups[s] = f"solvent-{s - self._n_sub_struct}"

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
            groups=groups,
            subgroups=subgroups,
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
