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
from producer.domain_rules import (
    CAT_LIGAND,
    CAT_POLYMER,
    CATEGORIES,
    classify_atom,
    trace_anchor_indices,
)
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

# Periodic-image centering ----------------------------------------------------
#
# A solvated trajectory wraps its solute back into the primary box, so the
# molecule teleports from one face to the other mid-playback. Measured on the
# corpus trp cage: the solute's centre jumps up to 5.14 nm between adjacent
# frames in a 3.648 nm box — a full periodic-image crossing — and its centre
# visits the entire box. That is unusable for the primary case (most real
# trajectories are solvated), so this is corrected at load, automatically,
# whenever the trajectory carries unit-cell information.
#
# THE CORRECTION IS A PER-FRAME RIGID TRANSLATION of every atom, chosen so the
# solute's centroid stays where it was in frame 0. It is emphatically NOT
# mdtraj's image_molecules(): that re-wraps molecules into different periodic
# images, which moves absolute positions and inter-molecular distances. On the
# same trp cage, imaging changed 400 sampled pairwise distances by up to 5.74
# nm, moved whole-system Rg by 7.3e-2 nm and all-atom RMSF by 2.27 nm — 733x
# and 22000x the corpus's 1e-4 tolerance. A rigid translation changes NO
# relative geometry whatsoever, so every observable that depends only on
# relative geometry is invariant BY CONSTRUCTION rather than by coincidence:
# the same 400 distances moved by 9.5e-7 nm, which is float32 noise. Both
# corrections fix the display equally well (jump/frame max 0.0140 nm either
# way). Only one of them is free.
#
# ONE TRUTH: the shift is applied to the trajectory BEFORE `_xyz` is copied out
# of it, so the bytes give_frames streams and the `trajectory` mods analyse are
# the same coordinates. There is no displayed-vs-measured split.
#
# WHEN IT IS SKIPPED — always loudly, never silently:
#   - no unit-cell information (not a periodic system; drift may be real);
#   - no polymer or ligand to anchor on (a pure solvent or membrane box has no
#     solute to hold still, and pinning an arbitrary molecule would make
#     everything else swim);
#   - the anchor is SPLIT across a boundary — a bond inside it stretched past
#     the covalent cutoff, or an empty band wider than CENTER_GAP_NM through a
#     cloud that spans more than half the box. A rigid translation cannot make
#     a broken molecule whole; only re-imaging can, so this reports rather than
#     pretending. (Note what is NOT used: a bare size test, which would reject
#     the trp cage at 2.3 nm in a 3.65 nm box, and a molecule-count test, which
#     would reject the corpus duplex — 26 unbonded residues 4.4 nm apart and
#     entirely intact. Both were tried and both were wrong.)
#
# Superposition is deliberately NOT done here: removing the solute's rotation
# discards real tumbling, which changes what the data means, and that is a
# different decision from fixing a display artefact.
CENTER_SPLIT_TOLERANCE = 0.5  # a cloud smaller than this fraction of the box cannot straddle it
CENTER_GAP_NM = 1.0           # an empty band this wide inside the anchor means two images


class MdtrajSource(DataSource):
    def __init__(
        self,
        topology_path: str,
        trajectory_path: Optional[str] = None,
        name: Optional[str] = None,
        ligand_residues: Sequence[str] = (),
        center: bool = True,
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
        # Periodic-image centering, BEFORE _xyz is copied out of the trajectory
        # — that ordering is what makes the streamed bytes and the mod-facing
        # `trajectory` the same coordinates (see the note at the top of this
        # module). `centering` records what happened, either way.
        self.centering = self._center_on_solute(traj) if center else "off (caller disabled centering)"
        self._xyz = np.ascontiguousarray(traj.xyz, dtype="<f4")  # (T, N, 3) nm, LE
        self.n_points = int(traj.n_atoms)
        self.n_frames = int(traj.n_frames)

        # Retain the live trajectory so mods can use mdtraj's own analyses
        # (Rg, RMSD, RMSF, …) directly. Its atom order is the header's point
        # order (both derive from `topology_path`), and traj.xyz equals the
        # bytes give_frames emits — both asserted in the corpus test. Exposed
        # read-only via the `trajectory` property; nm throughout (see class
        # docstring — mdtraj normalizes every container to nm on read).
        self._trajectory = traj

        self._build_header_fields()

    # -- Periodic-image centering ---------------------------------------------

    def _center_on_solute(self, traj) -> str:
        """Hold the solute still across periodic-image wraps. Mutates ``traj``.

        Returns a one-line description of what was done or why it was skipped —
        never None, so the caller always has something to say out loud.
        """
        if traj.unitcell_lengths is None:
            return "off (no unit-cell information — not a periodic system)"
        if traj.n_frames < 2:
            return "off (single frame — nothing can wrap)"

        anchor = self._solute_indices()
        if anchor.size == 0:
            return "off (no polymer or ligand to anchor on — nothing to hold still)"

        xyz = traj.xyz  # (T, N, 3) float32, nm
        sub = xyz[:, anchor, :]

        why = self._anchor_is_split(traj, anchor)
        if why:
            return f"off ({why}, which a rigid translation cannot repair)"

        centroid = sub.mean(axis=1)                                        # (T, 3)
        shift = (centroid[0] - centroid).astype(np.float32)                # (T, 3)
        traj.xyz = xyz + shift[:, None, :]

        moved = float(np.linalg.norm(shift, axis=1).max())
        jump_before = float(np.linalg.norm(np.diff(centroid, axis=0), axis=1).max())
        after = traj.xyz[:, anchor, :].mean(axis=1)
        jump_after = float(np.linalg.norm(np.diff(after, axis=0), axis=1).max())
        return (
            f"on ({anchor.size} solute atoms held still; largest per-frame shift "
            f"{moved:.2f} nm; solute jump/frame {jump_before:.2f} → {jump_after:.3f} nm). "
            "Rigid translation only — every interatomic distance is unchanged."
        )

    def _anchor_is_split(self, traj, anchor: np.ndarray) -> Optional[str]:
        """Is the anchor scattered across periodic images? Reason, or None.

        Two distinct failure modes, and a size test detects NEITHER — a compact
        protein legitimately spans more than half a tight solvation box (the
        corpus trp cage is 2.3 nm in a 3.65 nm box and is never broken), and a
        nucleic duplex is genuinely 4.3 nm long. So test what actually breaks:

        1. A molecule torn across a face shows up as an over-long BOND — the
           same signal PBC_BOND_CUTOFF_NM already suppresses edges with, reused
           here rather than given a second definition.
        2. An anchor whose pieces are not bonded to each other (a duplex, a
           complex, or any topology missing inter-residue bonds) can sit whole
           but in different images, stretching no bond at all. What gives THAT
           away is an empty band: project onto each axis and a split cloud has
           a large gap in the middle, while an intact one is dense throughout
           and has its only real gap outside itself. Counting molecules and
           measuring how far apart they sit does NOT work — the corpus duplex
           decomposes into 26 unbonded residues 4.4 nm apart in a 5.8 nm box
           and is nonetheless perfectly intact (largest internal gap 0.13 nm).
        """
        members = set(int(i) for i in anchor)

        pairs = [
            (a.index, b.index)
            for a, b in traj.topology.bonds
            if a.index in members and b.index in members
        ]
        if pairs:
            ij = np.asarray(pairs)
            d = np.linalg.norm(traj.xyz[:, ij[:, 0], :] - traj.xyz[:, ij[:, 1], :], axis=2)
            worst = float(d.max())
            if worst > PBC_BOND_CUTOFF_NM:
                frame = int(np.unravel_index(int(np.argmax(d)), d.shape)[0])
                return (
                    f"a bond inside the anchor measures {worst:.2f} nm in frame {frame}, "
                    f"far beyond the {PBC_BOND_CUTOFF_NM} nm covalent cutoff — the molecule "
                    "is torn across a periodic boundary"
                )

        sub = traj.xyz[:, sorted(members), :]
        for frame in range(traj.n_frames):
            box = traj.unitcell_lengths[frame]
            for axis in range(3):
                v = np.sort(sub[frame, :, axis])
                extent = float(v[-1] - v[0])
                if extent <= box[axis] * CENTER_SPLIT_TOLERANCE:
                    continue                       # too compact to straddle anything
                gap = float(np.diff(v).max()) if v.size > 1 else 0.0
                if gap > CENTER_GAP_NM:
                    return (
                        f"the anchor has a {gap:.2f} nm empty band along axis {axis} in frame "
                        f"{frame} while spanning {extent:.2f} nm of a {box[axis]:.2f} nm box — "
                        "it is sitting in two periodic images"
                    )
        return None

    def _solute_indices(self) -> np.ndarray:
        """Atoms of the polymer, or the ligand when there is no polymer.

        Reuses the producer's own classification rather than inventing a second
        notion of "the interesting molecule" — `select("protein")` is not enough
        (it returns nothing on 3 of the 9 corpus systems, nucleic ones included).
        """
        for wanted in (CAT_POLYMER, CAT_LIGAND):
            idx = [
                atom.index
                for atom in self._topology.atoms
                if classify_atom(
                    atom.residue.name,
                    bool(atom.residue.is_protein),
                    bool(atom.residue.is_nucleic),
                    self.ligand_residues,
                )
                == wanted
            ]
            if idx:
                return np.asarray(idx, dtype=int)
        return np.asarray([], dtype=int)

    @property
    def trajectory(self):
        """The live ``mdtraj.Trajectory`` backing this source (nm, frame-major).

        Point index ``i`` == atom index ``i`` in ``trajectory.topology`` ==
        column ``i`` in ``trajectory.xyz`` — so a mod given ``target_indices``
        in header order can slice the trajectory with those same indices. See
        the mod-facing API in docs/COMMANDS.md.
        """
        return self._trajectory

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
            # Say what was done to the coordinates, every time — including when
            # nothing was. A mod analysing this trajectory sees exactly these
            # coordinates, so the assistant must be able to read what they are.
            provenance=[f"periodic-image centering: {self.centering}"],
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
