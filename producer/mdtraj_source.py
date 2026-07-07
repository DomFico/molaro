"""MdtrajSource — the real DataSource, reading MD trajectory files via mdtraj.

Translates a molecular-dynamics topology + trajectory into the *exact same*
contract the synthetic source satisfies (Header + FrameChunk). Everything
downstream — transport, playback, renderer — is unchanged and never learns this
is molecular data. All domain vocabulary is confined to this file and
``domain_rules.py``.

Frame access: the full coordinate set is loaded once and ranges are sliced from
it (fine for the benchmark corpus; genuinely huge real trajectories would want
out-of-core seeking reads — noted as a future optimization, not built here).

Requires mdtraj + numpy (the benchmark `mdbench` conda env). The synthetic
source has no such dependency; this one is only imported when a real dataset is
requested.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

import mdtraj as md

from contract.contract import (
    VERSION,
    BBox,
    FrameChunk,
    Header,
    Points,
)
from producer.domain_rules import CATEGORIES, classify_atom, trace_anchor_indices
from producer.source import DataSource

# Bonds longer than this (nm) are treated as periodic-boundary wrap artifacts
# (a bonded pair split across opposite box faces) and suppressed, so they don't
# draw a line clear across the scene. Well above any real covalent bond
# (max observed in the corpus: a disulfide at 0.208 nm) and far below a box
# crossing (several nm). See CONTRACT_FIT_AUDIT.md, hard case 2.
PBC_BOND_CUTOFF_NM = 0.3
# Frames sampled when deciding which bonds are cross-box (a wrap can appear in
# some frames and not others). Cheap and robust for corpus-scale data.
PBC_SAMPLE_FRAMES = 8


class MdtrajSource(DataSource):
    def __init__(
        self,
        topology_path: str,
        trajectory_path: Optional[str] = None,
        name: Optional[str] = None,
        ligand_residues: Sequence[str] = (),
    ) -> None:
        if not os.path.exists(topology_path):
            raise FileNotFoundError(f"topology not found: {topology_path}")
        self.name = name or os.path.splitext(os.path.basename(topology_path))[0]
        self.ligand_residues = list(ligand_residues)

        # mdtraj normalizes every container format's length unit to nm on read,
        # so positions and the emitted units are always nm — no hand conversion,
        # no 10x trap (CONTRACT_FIT_AUDIT.md, hard case 1).
        if trajectory_path:
            traj = md.load(trajectory_path, top=topology_path)
        else:
            traj = md.load(topology_path)
        top = md.load_topology(topology_path) if trajectory_path else traj.topology

        # Count consistency: topology atoms vs trajectory atoms must agree
        # (hard case 10) — reject loudly rather than render garbage.
        if traj.n_atoms != top.n_atoms:
            raise ValueError(
                f"atom-count mismatch: topology has {top.n_atoms}, "
                f"trajectory has {traj.n_atoms}"
            )

        self._topology = top
        self._xyz = np.ascontiguousarray(traj.xyz, dtype="<f4")  # (T, N, 3) nm, LE
        self.n_points = int(traj.n_atoms)
        self.n_frames = int(traj.n_frames)

        self._build_header_fields()

    # -- Header construction ---------------------------------------------------

    def _build_header_fields(self) -> None:
        top = self._topology
        n = self.n_points

        atom_type: List[str] = []
        category: List[int] = []
        subgroup_id: List[int] = [0] * n  # residue index per atom
        group_id: List[int] = [0] * n

        for atom in top.atoms:
            elem = atom.element.symbol if atom.element is not None else ""
            atom_type.append(elem or atom.name)
            res = atom.residue
            category.append(
                classify_atom(
                    res.name,
                    bool(res.is_protein),
                    bool(res.is_nucleic),
                    self.ligand_residues,
                )
            )
            subgroup_id[atom.index] = res.index

        # Top-level grouping: chain, with fallback to segment_id when chains are
        # blank/degenerate so grouping doesn't collapse (hard case 7). We use
        # segment only when it is strictly more informative than chain.
        group_id, group_labels = self._grouping()

        subgroup_labels: Dict[int, str] = {}
        for res in top.residues:
            subgroup_labels[res.index] = f"{res.name} {res.resSeq}"

        self.points = Points(
            type=atom_type,
            group_id=group_id,
            subgroup_id=subgroup_id,
            category=category,
        )
        self.groups = group_labels
        self.subgroups = subgroup_labels
        self.edges = self._edges()
        self.polylines = self._polylines(group_id)
        self.bbox = self._bbox()

    def _grouping(self) -> Tuple[List[int], Dict[int, str]]:
        top = self._topology
        n = self.n_points

        chain_labels = []
        for c in top.chains:
            cid = (getattr(c, "chain_id", "") or "").strip()
            chain_labels.append(cid if cid else str(c.index))
        n_distinct_chains = len({lbl for lbl in chain_labels})

        seg_of_atom = [(getattr(a, "segment_id", "") or "").strip() for a in top.atoms]
        distinct_segs = sorted({s for s in seg_of_atom if s})

        use_segments = len(distinct_segs) > max(1, n_distinct_chains)
        if use_segments:
            seg_index = {s: i for i, s in enumerate(distinct_segs)}
            group_id = [seg_index[seg_of_atom[i]] for i in range(n)]
            labels = {i: s for s, i in seg_index.items()}
            return group_id, labels

        group_id = [0] * n
        for atom in top.atoms:
            group_id[atom.index] = atom.residue.chain.index
        labels = {c.index: chain_labels[c.index] for c in top.chains}
        return group_id, labels

    def _edges(self) -> List[Tuple[int, int]]:
        top = self._topology
        if top.n_bonds == 0:
            # No explicit bonds: infer standard biopolymer connectivity. Yields
            # nothing for CG bead systems (no atomistic templates) — that graceful
            # empty result is correct (hard case 3/8), not an error.
            try:
                top.create_standard_bonds()
            except Exception:
                pass
        pairs = [(a.index, b.index) for a, b in top.bonds]
        if not pairs:
            return []
        pairs_arr = np.asarray(pairs, dtype=np.int64)

        # Suppress cross-box PBC bonds: any pair exceeding the cutoff in any
        # sampled frame (hard case 2).
        n_sample = min(self.n_frames, PBC_SAMPLE_FRAMES)
        idx = np.linspace(0, self.n_frames - 1, n_sample).astype(int)
        deltas = self._xyz[idx][:, pairs_arr[:, 0], :] - self._xyz[idx][:, pairs_arr[:, 1], :]
        max_len = np.sqrt((deltas ** 2).sum(axis=2)).max(axis=0)  # per bond
        keep = max_len <= PBC_BOND_CUTOFF_NM
        return [(int(i), int(j)) for (i, j), k in zip(pairs, keep) if k]

    def _polylines(self, group_id: Sequence[int]) -> List[List[int]]:
        """One backbone polyline per group (chain/segment), threading its
        residues' trace anchors in order. Groups with no anchors (CG beads,
        solvent, ligands) contribute nothing (hard cases 6, 8)."""
        top = self._topology
        # Collect, per residue, atom-name -> global index.
        polylines: List[List[int]] = []
        # Group residues by their group_id (via any atom), preserving order.
        residues_by_group: Dict[int, List] = {}
        for res in top.residues:
            g = group_id[next(res.atoms).index]
            residues_by_group.setdefault(g, []).append(res)

        for g in sorted(residues_by_group):
            anchors: List[int] = []
            for res in residues_by_group[g]:
                names = {a.name: a.index for a in res.atoms}
                anchor = trace_anchor_indices(
                    names, bool(res.is_protein), bool(res.is_nucleic)
                )
                if anchor is not None:
                    anchors.append(anchor)
            if len(anchors) >= 2:
                polylines.append(anchors)
        return polylines

    def _bbox(self) -> BBox:
        lo = self._xyz.reshape(-1, 3).min(axis=0)
        hi = self._xyz.reshape(-1, 3).max(axis=0)
        return BBox(min=tuple(float(v) for v in lo), max=tuple(float(v) for v in hi))

    # -- DataSource interface --------------------------------------------------

    def give_header(self) -> Header:
        return Header(
            version=VERSION,
            name=self.name,
            n_points=self.n_points,
            n_frames=self.n_frames,
            units="nm",
            bbox=self.bbox,
            points=self.points,
            categories=list(CATEGORIES),
            groups=self.groups,
            subgroups=self.subgroups,
            edges=self.edges,
            polylines=self.polylines,
            channels=[],  # deferred this increment
        )

    def give_frames(self, start: int, count: int) -> FrameChunk:
        if count < 1 or start < 0 or start + count > self.n_frames:
            raise ValueError(
                f"requested frames [{start}, {start + count}) outside "
                f"[0, {self.n_frames})"
            )
        block = self._xyz[start : start + count]  # (count, N, 3) contiguous LE f4
        return FrameChunk(
            start=start,
            count=count,
            positions=np.ascontiguousarray(block, dtype="<f4").tobytes(),
            channels={},
        )
