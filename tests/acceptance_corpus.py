"""Acceptance harness — the definition of done for Increment 3.

For each of the 9 benchmark corpus systems: run the real MdtrajSource, validate
its Header + a FrameChunk against the contract, and cross-check against the
system's manifest (point count, category composition) and against the
authoritative mdtraj topology (chain/residue grouping, connectivity). Prints a
per-system PASS/FAIL table.

Run with an mdtraj-capable interpreter and a local checkout of the benchmark
corpus (an external test asset, not shipped with this repo):
    VIEWER_CORPUS_ROOT=/path/to/benchmark_systems \
    /path/to/mdtraj-python -m tests.acceptance_corpus
"""
from __future__ import annotations

import collections
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mdtraj as md  # noqa: E402

from contract.contract import (  # noqa: E402
    decode_frame_chunk,
    encode_frame_chunk,
    header_from_json,
    header_to_json,
    validate_frame_chunk,
    validate_header,
)
from producer.corpus import corpus_root, resolve_system  # noqa: E402
from producer.mdtraj_source import MdtrajSource  # noqa: E402

SYSTEMS = [
    "01_alanine_dipeptide",
    "02_trpcage_atomistic",
    "03_adk_psf_dcd",
    "04_ligand_custom_solvent",
    "05_macrocycle_disulfide",
    "06_membrane_complex",
    "07_coarse_grain_martini",
    "09_nucleic_duplex",
    "10_tip4p_virtualsites",
]


def check_system(sid: str) -> tuple[bool, list[str], dict]:
    checks: list[tuple[str, bool, str]] = []
    spec = resolve_system(sid)
    manifest = spec["manifest"]

    src = MdtrajSource(
        spec["topology"], spec["trajectory"], spec["name"], spec["ligand_residues"]
    )
    header = src.give_header()

    # 1. Contract validity (Header + JSON round-trip + FrameChunk envelope).
    try:
        validate_header(header)
        header_from_json(header_to_json(header))
        chunk = src.give_frames(0, 1)
        validate_frame_chunk(chunk, header)
        env = encode_frame_chunk(chunk, header)
        validate_frame_chunk(decode_frame_chunk(env), header)
        checks.append(("contract-valid", True, "header+chunk validate & round-trip"))
    except Exception as exc:
        checks.append(("contract-valid", False, str(exc)))

    # 2. Point count == manifest topology atom count.
    man_atoms = manifest["atom_counts"]["topology"]
    checks.append(
        ("point-count", header.n_points == man_atoms, f"{header.n_points} vs manifest {man_atoms}")
    )

    # 3. FrameChunk size + count == manifest n_frames.
    man_frames = manifest["trajectory"]["n_frames"]
    exp_bytes = header.n_points * 3 * 4
    checks.append(
        ("frame-shape", src.n_frames == man_frames and len(chunk.positions) == exp_bytes,
         f"T={src.n_frames} vs {man_frames}, chunk0 {len(chunk.positions)}B vs {exp_bytes}B")
    )

    # 4. Category composition == manifest composition.
    counts = collections.Counter(header.points.category)
    got = {c: 0 for c in header.categories}
    for idx, n in counts.items():
        got[header.categories[idx]] = n
    man_comp = manifest["composition"]
    comp_ok = all(got.get(k, 0) == v for k, v in man_comp.items())
    checks.append(("composition", comp_ok, f"{got} vs manifest {man_comp}"))

    # 4b. Fidelity: our vendored per-atom classifier must equal the corpus's
    # classify_composition exactly (guards domain_rules.py against drift).
    try:
        sys.path.insert(0, os.path.join(corpus_root(), "_lib"))
        from composition import classify_composition  # type: ignore

        ref = classify_composition(
            md.load(spec["topology"]), ligand_overrides=spec["ligand_residues"]
        )
        checks.append(("classifier-fidelity", got == ref, f"ours {got} vs corpus {ref}"))
    except Exception as exc:
        checks.append(("classifier-fidelity", False, f"could not compare: {exc}"))

    # 5. Grouping + connectivity vs the authoritative mdtraj topology.
    top = md.load_topology(spec["topology"])
    n_res = top.n_residues
    grouping_ok = (
        len(header.points.group_id) == header.n_points
        and len(header.points.subgroup_id) == header.n_points
        and len(set(header.points.subgroup_id)) == n_res
    )
    checks.append(("grouping", grouping_ok, f"{len(header.groups)} groups, {len(set(header.points.subgroup_id))} subgroups vs {n_res} residues"))

    # Connectivity: edges are topology bonds minus suppressed cross-box bonds.
    top_bonds = top.n_bonds
    edges = len(header.edges)
    # Every edge index in range, and edge count <= topology bond count.
    edges_in_range = all(0 <= i < header.n_points and 0 <= j < header.n_points for i, j in header.edges)
    conn_ok = edges_in_range and edges <= max(top_bonds, 0)
    checks.append(("connectivity", conn_ok, f"{edges} edges (topology bonds {top_bonds})"))

    detail = {
        "N": header.n_points,
        "T": src.n_frames,
        "groups": len(header.groups),
        "edges": edges,
        "polylines": len(header.polylines),
        "composition": got,
    }
    passed = all(ok for _, ok, _ in checks)
    fail_msgs = [f"{name}: {msg}" for name, ok, msg in checks if not ok]
    return passed, fail_msgs, detail


def main() -> int:
    print(f"corpus root: {corpus_root()}\n")
    results = []
    for sid in SYSTEMS:
        try:
            ok, fails, detail = check_system(sid)
        except Exception as exc:
            ok, fails, detail = False, [f"exception: {exc}"], {}
        results.append((sid, ok, fails, detail))
        status = "PASS" if ok else "FAIL"
        d = detail
        print(
            f"[{status}] {sid:26s} "
            + (f"N={d['N']:>7} T={d['T']:>4} groups={d['groups']:>2} "
               f"edges={d['edges']:>6} polylines={d['polylines']:>2} {d['composition']}"
               if d else "")
        )
        for f in fails:
            print(f"         ! {f}")

    n_pass = sum(1 for _, ok, _, _ in results if ok)
    print(f"\n{n_pass}/{len(results)} systems PASS")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
