"""Write the cross-language test fixtures into contract/fixtures/.

Run from viewer/:  python3 -m tests.make_fixtures

Emits:
- header.json    — Header serialized by the Python side.
- chunk.bin      — one FrameChunk binary envelope (frames [5, 9)).
- expected.json  — spot-check values computed by Python; the TypeScript test
                   asserts it reads the exact same values from the two files
                   above. This is the cross-language agreement proof.
"""
from __future__ import annotations

import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import encode_frame_chunk, header_to_json  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "..", "contract", "fixtures")

N_POINTS = 300
N_FRAMES = 20
SEED = 7
CHUNK_START = 5
CHUNK_COUNT = 4


def _f32_at(block: bytes, index: int) -> float:
    """Read the float32 at element `index` of a little-endian float32 block."""
    return struct.unpack_from("<f", block, index * 4)[0]


def main() -> None:
    source = SyntheticSource(n_points=N_POINTS, n_frames=N_FRAMES, seed=SEED)
    header = source.give_header()
    chunk = source.give_frames(CHUNK_START, CHUNK_COUNT)
    envelope = encode_frame_chunk(chunk, header)

    # Spot values, read back from the serialized bytes themselves so the
    # expectation reflects the wire format, not the in-memory arrays.
    def pos(f: int, p: int, c: int) -> float:
        return _f32_at(chunk.positions, (f - CHUNK_START) * N_POINTS * 3 + p * 3 + c)

    def energy(f: int, p: int) -> float:
        return _f32_at(chunk.channels["energy"], (f - CHUNK_START) * N_POINTS + p)

    def flow(f: int, p: int, c: int) -> float:
        # the VECTOR channel (components=3): element stride is 3
        return _f32_at(chunk.channels["flow"], ((f - CHUNK_START) * N_POINTS + p) * 3 + c)

    expected = {
        "n_points": N_POINTS,
        "n_frames": N_FRAMES,
        "chunk_start": CHUNK_START,
        "chunk_count": CHUNK_COUNT,
        "categories": header.categories,
        "type_0": header.points.type[0],
        "group_id_150": header.points.group_id[150],
        "subgroup_id_150": header.points.subgroup_id[150],
        "category_42": header.points.category[42],
        "n_edges": len(header.edges),
        "edge_0": list(header.edges[0]),
        "polyline_0_first": header.polylines[0][0],
        "polyline_0_last": header.polylines[0][-1],
        "mass_3": header.channels[0].data[3],
        "time_19": header.channels[1].data[19],
        "position_f6_p7": [pos(6, 7, 0), pos(6, 7, 1), pos(6, 7, 2)],
        "position_f8_p299": [pos(8, 299, 0), pos(8, 299, 1), pos(8, 299, 2)],
        "energy_f8_p123": energy(8, 123),
        # the vector channel, spot-checked at BOTH ends of the stride math —
        # a wrong stride reads a neighbour's value silently, so the fixture
        # pins full triples at two (frame, element) sites plus unit length
        "flow_f6_p0": [flow(6, 0, 0), flow(6, 0, 1), flow(6, 0, 2)],
        "flow_f8_p123": [flow(8, 123, 0), flow(8, 123, 1), flow(8, 123, 2)],
        "envelope_bytes": len(envelope),
    }

    os.makedirs(FIXTURES_DIR, exist_ok=True)
    with open(os.path.join(FIXTURES_DIR, "header.json"), "w") as f:
        f.write(header_to_json(header))
    with open(os.path.join(FIXTURES_DIR, "chunk.bin"), "wb") as f:
        f.write(envelope)
    with open(os.path.join(FIXTURES_DIR, "expected.json"), "w") as f:
        json.dump(expected, f, indent=2)
    print(f"fixtures written to {os.path.abspath(FIXTURES_DIR)}")


if __name__ == "__main__":
    main()
