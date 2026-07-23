"""MdtrajSource — the real DataSource, reading MD trajectory files via mdtraj.

Translates a molecular-dynamics topology + trajectory into the *exact same*
contract the synthetic source satisfies (Header + FrameChunk). Everything
downstream — transport, playback, renderer — is unchanged and never learns this
is molecular data. All domain vocabulary is confined to this file and
``domain_rules.py``.

Frame access (Phase 2a — streaming spine). A seekable multi-frame trajectory
(DCD/XTC/TRR/NetCDF) is opened ONCE (``md.open``) and kept open for the source's
lifetime; ``give_frames(start, count)`` ``seek``s and ``read_as_traj``s exactly
that range from disk, so the coordinate block is never held resident for the
stream. The header's frame-derived fields (bbox, the edge PBC sample) are built
by ONE out-of-core startup sweep over the same handle rather than from a full
in-RAM copy. Non-seekable or single-frame inputs (PDB/GRO/single-frame restart/
multi-model) keep the resident ``md.load`` path unchanged.

Phase 2b centers the STREAMED coordinates per chunk (``_apply_centering`` at the
``give_frames`` hook), BYTE-IDENTICALLY to whole-trajectory centering, so the
solute never jumps at a chunk boundary and ``give_frames`` output ==
``trajectory.xyz`` == ONE TRUTH again (2a's interim display-raw/measure-centered
split is re-merged). It reuses the inputs this file prepares at load
(``_center_centroid0``/``_center_anchor``/``_center_wrappable_groups``) and
respects the GLOBAL split verdict ``self.centering`` (decided once over all
frames) — a centering-OFF system still streams raw exactly as 2a did.

Two things are still resident, both cleared in 2c: (1) the header's bbox is built
from the RAW startup sweep (a display-only sample; the edge PBC sample is
centering-invariant because centering preserves every bonded pair's distance);
(2) a CENTERED copy is exposed as ``trajectory``/``_xyz`` for the analysis mods
(``rg``/``rmsd``/``rmsf``/``smoothing``). 2c makes ``trajectory`` lazy, moves the
split-decision into the startup sweep, drops ``_xyz``, and realizes the memory win.

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

# Trajectory container formats mdtraj can SEEK, so give_frames can read a range
# from disk without a resident copy: DCD/NetCDF are O(1) frame arithmetic; XTC/
# TRR are O(1) after a frame-offset index, which the startup sweep builds as a
# side effect of reading through the file once (decision D6). Anything else
# (PDB/GRO/single-frame restart/multi-model) takes the resident md.load path
# (decision D3). Extensions match mdtraj's own lowercased dispatch.
_STREAMABLE_EXTS = {".dcd", ".xtc", ".trr", ".nc", ".ncdf", ".netcdf"}
# Frames read per chunk during the one-pass startup sweep (≤1 chunk resident).
SCAN_CHUNK_FRAMES = 64

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
# ONE TRUTH (Phases 0–1, and again from 2b): the shift is applied to the
# coordinates BEFORE they are emitted, so the bytes give_frames streams and the
# `trajectory` mods analyse are the same coordinates. In the resident path the
# shift is applied in-place to `traj` before `_xyz` is copied out; in the
# streaming path `_apply_centering` applies the identical arithmetic to each
# chunk at the give_frames hook (byte-exact — see that method). Phase 2a was the
# single deliberate exception (streamed display raw while `trajectory` stayed
# centered); 2b closes it.
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
        #
        # The topology alone fixes every per-point/grouping/edge/polyline field
        # of the header (decision D1) — no frames needed — so it is loaded once,
        # standalone, and the frame path is chosen separately below.
        self._topology = md.load_topology(topology_path) if trajectory_path else None
        self._traj_path = trajectory_path
        self._handle = None

        # Decide streaming vs resident (decision D3). Stream ONLY a seekable,
        # multi-frame trajectory; a single frame (T=1 restart or CG snapshot) or
        # a non-seekable container loads resident and is served exactly as before.
        ext = os.path.splitext(trajectory_path)[1].lower() if trajectory_path else ""
        handle = None
        if trajectory_path and ext in _STREAMABLE_EXTS:
            handle = md.open(trajectory_path)          # persistent, source lifetime
            n_frames = int(len(handle))                # O(1); builds XTC/TRR offsets (D6)
            if n_frames < 2:
                handle.close()                          # single frame → resident
                handle = None

        if handle is not None:
            self._streaming = True
            self._handle = handle
            self.n_frames = int(len(handle))
            self.n_points = int(self._topology.n_atoms)
            self._build_streaming(topology_path)
        else:
            self._streaming = False
            self._build_resident(topology_path, trajectory_path, center)

    # -- Build paths -----------------------------------------------------------

    def _build_resident(
        self, topology_path: str, trajectory_path: Optional[str], center: bool
    ) -> None:
        """The original in-RAM path: load every frame, center, slice from _xyz.

        Unchanged behaviour — this is what a non-seekable or single-frame input
        (PDB/GRO/restart/CG snapshot, e.g. the corpus membrane and CG systems)
        takes, so those datasets are byte-for-byte identical to before.
        """
        if trajectory_path:
            traj = md.load(trajectory_path, top=topology_path)
        else:
            traj = md.load(topology_path)
        top = self._topology if self._topology is not None else traj.topology
        self._topology = top

        # Count consistency: topology atoms vs trajectory atoms must agree
        # (hard case 10) — reject loudly rather than render garbage.
        if traj.n_atoms != top.n_atoms:
            raise ValueError(
                f"atom-count mismatch: topology has {top.n_atoms}, "
                f"trajectory has {traj.n_atoms}"
            )

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

        self._prepare_center_inputs(self._xyz[0])
        self._build_header_fields()

    def _build_streaming(self, topology_path: str) -> None:
        """The Phase 2a spine: header from a one-pass out-of-core sweep, frames
        streamed on demand; a resident CENTERED copy kept only for the mods.

        Order: load the resident copy FIRST (it is also the atom-count gate and
        the mod-facing `trajectory`), THEN sweep the handle out-of-core for the
        raw header fields. The two coordinate views are the 2a display/measure
        split — see the module docstring.
        """
        # (1) resident CENTERED copy for the mods (2a crutch; 2c makes it lazy).
        #     Doubles as the atom-count consistency gate before we stream.
        traj = md.load(self._traj_path, top=topology_path)
        if traj.n_atoms != self.n_points:
            raise ValueError(
                f"atom-count mismatch: topology has {self.n_points}, "
                f"trajectory has {traj.n_atoms}"
            )
        self.centering = self._center_on_solute(traj)
        self._xyz = np.ascontiguousarray(traj.xyz, dtype="<f4")
        self._trajectory = traj

        # (2) ONE out-of-core sweep over the RAW streamed coordinates for the
        #     header's frame-derived fields (raw bbox + edge PBC sample). This
        #     is the path 2c keeps after the resident copy above is dropped.
        self._startup_scan()

        # (3) 2b centering inputs, prepared now (NOT applied in 2a). centroid0 is
        #     taken from the RAW frame 0 the scan captured, so it lives in the
        #     same coordinate frame give_frames streams.
        self._prepare_center_inputs(self._scan_frame0)

        # (4) header (topology fields + the scan's raw bbox/edges).
        self._build_header_fields()

    def _startup_scan(self) -> None:
        """ONE streaming sweep over the RAW coordinates via the persistent handle
        (decision D1), ≤1 chunk resident. Reads every frame once and accumulates
        the header's frame-derived fields plus the raw frame 0 that Phase 2b
        needs for the centering target. Populates:

          self._bbox_lo / self._bbox_hi   raw running min/max over all points+frames
          self._edge_sample               (S, N, 3) raw coords at the PBC sample frames
          self._scan_frame0               (N, 3) raw frame-0 coords (2b centroid input)
        """
        handle = self._handle
        n = self.n_points
        T = self.n_frames

        # Same PBC edge-sample frames the resident path uses (linspace over T).
        n_sample = min(T, PBC_SAMPLE_FRAMES)
        sample_idx = np.linspace(0, T - 1, n_sample).astype(int)
        wanted = set(int(i) for i in sample_idx)
        sample_pos: Dict[int, np.ndarray] = {}

        lo = np.full(3, np.inf, dtype=np.float64)
        hi = np.full(3, -np.inf, dtype=np.float64)
        frame0: Optional[np.ndarray] = None

        handle.seek(0)
        start = 0
        while start < T:
            count = min(SCAN_CHUNK_FRAMES, T - start)
            chunk = handle.read_as_traj(self._topology, n_frames=count)
            xyz = np.ascontiguousarray(chunk.xyz, dtype="<f4")   # (c, N, 3) raw, LE
            c = xyz.shape[0]
            if c == 0:
                break                                            # defensive: short read
            if xyz.shape[1] != n:
                raise ValueError(
                    f"atom-count mismatch: topology has {n}, "
                    f"trajectory frame has {xyz.shape[1]}"
                )
            flat = xyz.reshape(-1, 3)
            lo = np.minimum(lo, flat.min(axis=0))
            hi = np.maximum(hi, flat.max(axis=0))
            for gi in wanted:
                if start <= gi < start + c:
                    sample_pos[gi] = xyz[gi - start].copy()
            if start == 0:
                frame0 = xyz[0].copy()
            start += c

        self._bbox_lo = lo
        self._bbox_hi = hi
        self._edge_sample = np.stack(
            [sample_pos[int(gi)] for gi in sample_idx], axis=0
        ).astype("<f4")
        self._scan_frame0 = frame0

    def _prepare_center_inputs(self, frame0_xyz: np.ndarray) -> None:
        """Stash the inputs Phase 2b's ``_apply_centering`` will consume — the
        solute anchor, its raw frame-0 centroid (the translation target), and the
        loose-molecule groups to re-image around it. The split DECISION is global
        (``_center_on_solute`` already ran ``_anchor_is_split`` over ALL frames of
        the resident copy and recorded the verdict in ``self.centering``). Cheap,
        topology-only apart from the one frame-0 read; NOT applied in 2a."""
        anchor = self._solute_indices()
        self._center_anchor = anchor
        self._center_centroid0 = (
            np.asarray(frame0_xyz)[anchor].mean(axis=0).astype("<f4")
            if anchor.size else None
        )
        groups = self._wrappable_groups(anchor) if anchor.size else []
        self._center_wrappable_groups = groups
        # Flat atom index list + per-atom owning-group id, concatenated ONCE the
        # exact way _wrap_loose_molecules builds them per call, so the streaming
        # hook's per-chunk re-image can skip the union-find/group rebuild (which
        # cost ~15 ms/frame on the nucleic system) yet stay byte-identical to it.
        self._center_flat = (
            np.concatenate(groups) if groups else np.asarray([], dtype=int)
        )
        self._center_owner = (
            np.concatenate([np.full(len(g), i) for i, g in enumerate(groups)])
            if groups else np.asarray([], dtype=int)
        )

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

        wrapped = self._wrap_loose_molecules(traj, anchor)
        return (
            f"on ({anchor.size} solute atoms held still; largest per-frame shift "
            f"{moved:.2f} nm; solute jump/frame {jump_before:.2f} → {jump_after:.3f} nm); "
            f"{wrapped}"
        )

    def _wrap_loose_molecules(self, traj, anchor: np.ndarray) -> str:
        """Wrap everything that is not the anchor into the box around it.

        Holding the solute still is only half the job. The solute and the
        solvent have DIFFERENT wrap discontinuities, so no single rigid
        translation removes both: pinning the solute transfers its jump to
        everything else, and on the corpus trp cage 99.4% of water atoms moved
        more than 1 nm on exactly the 14 frames where the solute crossed a face.
        So the loose molecules are re-imaged around the solute afterwards.

        This DOES move absolute positions — that is unavoidable and it is the
        point. Solute observables are untouched (measured at 1e-8); whole-box
        ones move, and for all-atom RMSF that movement is an artefact leaving,
        not a convention changing: a water that hops a periodic image reports
        enormous fluctuation it does not have.

        GROUPING is by connected components of (bonds ∪ residue membership),
        not by mdtraj's find_molecules alone. Bonds alone are not enough — a
        topology missing inter-residue bonds decomposes into loose residues (the
        corpus duplex becomes 26), and a residue whose bonds are absent entirely
        would be torn atom from atom. Folding residue membership in makes a
        residue the smallest indivisible unit, so nothing is ever split.
        """
        groups = self._wrappable_groups(anchor)
        if not groups:
            return "no loose molecules to wrap"

        xyz = traj.xyz
        box = traj.unitcell_lengths                                   # (T, 3)
        centre = xyz[:, anchor, :].mean(axis=1)                       # (T, 3)

        flat = np.concatenate(groups)
        owner = np.concatenate([np.full(len(g), i) for i, g in enumerate(groups)])
        cents = np.empty((traj.n_frames, len(groups), 3), dtype=np.float32)
        for i, g in enumerate(groups):
            cents[:, i, :] = xyz[:, g, :].mean(axis=1)

        before = self._max_bond_length(traj)
        image = np.round((cents - centre[:, None, :]) / box[:, None, :])
        xyz[:, flat, :] -= (image[:, owner, :] * box[:, None, :]).astype(np.float32)
        traj.xyz = xyz
        after = self._max_bond_length(traj)

        # Wrapping whole groups cannot stretch a bond — every bond lies inside
        # one group by construction. Assert it rather than trust it: if this
        # ever fires, the grouping is wrong and the geometry is being damaged.
        if after > max(before, PBC_BOND_CUTOFF_NM) + 1e-4:
            raise RuntimeError(
                f"wrapping loose molecules stretched a bond to {after:.3f} nm "
                f"(was {before:.3f} nm) — the grouping tore a molecule apart"
            )
        return f"{len(groups)} loose molecules re-imaged around it"

    def _apply_centering(self, chunk_traj) -> None:
        """Phase 2b: center a streamed chunk EXACTLY as the resident
        ``_center_on_solute``/``_wrap_loose_molecules`` center the whole
        trajectory, so per-chunk output is BYTE-IDENTICAL to whole-trajectory
        centering and the solute never jumps at a chunk boundary. Mutates
        ``chunk_traj`` in place; a NO-OP when the GLOBAL verdict ``self.centering``
        (decided once over all frames — R1) is OFF, so an off system streams raw
        exactly as Phase 2a did.

        Byte-exactness is by CONSTRUCTION, not coincidence (R3): every step
        mirrors the resident path's dtype flow atom-for-atom, and a per-frame
        reduction is independent of how many frames surround it —

          * the solute is pinned to the GLOBAL frame-0 centroid
            ``self._center_centroid0`` (proven byte-equal to the resident
            ``centroid[0]``), NOT the chunk's own frame 0, so a chunk that never
            contains frame 0 still lands on the same target;
          * the shift is ``(centroid0 - chunk_centroid).astype(f4)`` added as
            ``xyz + shift[:, None, :]`` — the same expression, precision and
            rounding ``_center_on_solute`` uses;
          * the loose-molecule re-image reuses the SAME arithmetic as
            ``_wrap_loose_molecules`` — ``round((group_centroid - solute_centroid)
            / box)``, subtract ``image·box`` — on the SHIFTED coordinates, with
            ``box`` from this chunk's own ``unitcell_lengths`` and the group
            layout (``_center_flat``/``_center_owner``) precomputed at load.

        ``_wrap_loose_molecules``'s tear-detection assertion is NOT re-run per
        chunk: the grouping is topology-only (identical here), and the resident
        copy already asserted no tear over EVERY frame at load while this reads
        the same frames from the same file. (2c, which drops the resident copy,
        must move that one-time check into the startup sweep.)
        """
        if not self.centering.startswith("on"):
            return                              # global verdict OFF → stream raw (R1)
        anchor = self._center_anchor
        xyz = chunk_traj.xyz                     # (c, N, 3) float32, nm
        sub = xyz[:, anchor, :]
        centroid = sub.mean(axis=1)              # (c, 3) float32
        shift = (self._center_centroid0 - centroid).astype(np.float32)
        xyz = xyz + shift[:, None, :]            # float32 + float32 → float32

        groups = self._center_wrappable_groups
        if groups:
            flat, owner = self._center_flat, self._center_owner
            box = chunk_traj.unitcell_lengths    # (c, 3) float32
            centre = xyz[:, anchor, :].mean(axis=1)          # from SHIFTED xyz
            cents = np.empty((chunk_traj.n_frames, len(groups), 3), dtype=np.float32)
            for i, g in enumerate(groups):
                cents[:, i, :] = xyz[:, g, :].mean(axis=1)
            image = np.round((cents - centre[:, None, :]) / box[:, None, :])
            xyz[:, flat, :] -= (image[:, owner, :] * box[:, None, :]).astype(np.float32)
        chunk_traj.xyz = xyz

    def _wrappable_groups(self, anchor: np.ndarray) -> List[np.ndarray]:
        """Connected components of (bonds ∪ residues) that hold no anchor atom."""
        top = self._topology
        parent = list(range(top.n_residues))

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in top.bonds:
            ra, rb = find(a.residue.index), find(b.residue.index)
            if ra != rb:
                parent[ra] = rb

        held = {top.atom(int(i)).residue.index for i in anchor}
        by_root: Dict[int, List[int]] = {}
        for res in top.residues:
            by_root.setdefault(find(res.index), []).append(res.index)

        groups: List[np.ndarray] = []
        for members in by_root.values():
            if any(r in held for r in members):
                continue                                   # part of the anchor
            idx = [a.index for r in members for a in top.residue(r).atoms]
            if idx:
                groups.append(np.asarray(idx, dtype=int))
        return groups

    @staticmethod
    def _max_bond_length(traj) -> float:
        pairs = [(a.index, b.index) for a, b in traj.topology.bonds]
        if not pairs:
            return 0.0
        ij = np.asarray(pairs)
        return float(
            np.linalg.norm(traj.xyz[:, ij[:, 0], :] - traj.xyz[:, ij[:, 1], :], axis=2).max()
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

        # Frame-derived sample/bbox source: the streaming path already filled
        # _edge_sample/_bbox_lo/_bbox_hi from the RAW startup sweep; the resident
        # path fills them here from the in-RAM _xyz (identical to before).
        if not self._streaming:
            n_sample = min(self.n_frames, PBC_SAMPLE_FRAMES)
            idx = np.linspace(0, self.n_frames - 1, n_sample).astype(int)
            self._edge_sample = self._xyz[idx]
            flat = self._xyz.reshape(-1, 3)
            self._bbox_lo = flat.min(axis=0)
            self._bbox_hi = flat.max(axis=0)

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
        # sampled frame (hard case 2). The sample frames come from either the
        # resident _xyz or the streaming startup sweep — same linspace over T.
        sample = self._edge_sample  # (S, N, 3)
        deltas = sample[:, pairs_arr[:, 0], :] - sample[:, pairs_arr[:, 1], :]
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
        return BBox(
            min=tuple(float(v) for v in self._bbox_lo),
            max=tuple(float(v) for v in self._bbox_hi),
        )

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
        if not self._streaming:
            block = self._xyz[start : start + count]  # (count, N, 3) contiguous LE f4
            return FrameChunk(
                start=start,
                count=count,
                positions=np.ascontiguousarray(block, dtype="<f4").tobytes(),
                channels={},
            )

        # Streaming path (decision D7 — seek every time, no chunk cache): read
        # exactly [start, start+count) from disk through the persistent handle.
        # The serve loop is single-threaded FIFO, so the shared handle needs no
        # lock.
        self._handle.seek(start)
        chunk = self._handle.read_as_traj(self._topology, n_frames=count)
        # --- Phase 2b: per-chunk periodic-image centering (ONE TRUTH restored) --
        # Center the chunk in place, byte-identically to whole-trajectory
        # centering (so the solute never jumps at a chunk boundary), THEN copy out
        # the contiguous LE-f4 block — the same center-then-copy flow the resident
        # path uses. A no-op when the global verdict is centering OFF (streams raw).
        self._apply_centering(chunk)
        xyz = np.ascontiguousarray(chunk.xyz, dtype="<f4")  # (count, N, 3) centered, LE f4
        return FrameChunk(
            start=start,
            count=count,
            positions=xyz.tobytes(),
            channels={},
        )

    def close(self) -> None:
        """Release the streaming file handle. Optional — the serve process is
        single-shot per dataset, so the OS reclaims it on exit; provided for
        callers (tests) that build many sources in one process."""
        handle = getattr(self, "_handle", None)
        if handle is not None:
            try:
                handle.close()
            finally:
                self._handle = None
