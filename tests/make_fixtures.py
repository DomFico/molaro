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

from contract.contract import (  # noqa: E402
    Channel,
    FrameChunk,
    apply_channel_delta,
    channel_delta_from_obj,
    channel_delta_to_obj,
    encode_frame_chunk,
    header_to_json,
)
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

    # ---- channel-delta fixtures (SPEC.md "Channel deltas") -------------------
    # The cross-language proof for the session extension: Python declares two
    # produced channels (one scalar, one vector), applies them, and builds a
    # POST-delta chunk; TypeScript must (a) parse/apply the same deltas to the
    # same header and agree byte-for-byte with header_post_delta.json, (b)
    # accept the PRE chunk only against the PRE channel set and the POST chunk
    # only against the POST set (the request-epoch rule), and (c) read the
    # exact float32 values Python wrote, at two (frame, element) sites for
    # BOTH widths.
    delta_scalar = Channel(
        name="produced_s", scope="per_point_per_frame", min=0.0, max=160.0
    )
    delta_vector = Channel(name="produced_v", scope="per_point_per_frame", components=3)
    pre_channels_len = len(header.channels)
    apply_channel_delta(header, channel_delta_from_obj(channel_delta_to_obj(delta_scalar)))
    apply_channel_delta(header, channel_delta_from_obj(channel_delta_to_obj(delta_vector)))

    # Deterministic float32-exact produced values (halves/quarters are exact).
    def s_val(f: int, p: int) -> float:
        return f * 0.5 + p * 0.25

    def v_val(f: int, p: int, c: int) -> float:
        return ((p + c) % 7 - 3) * 0.5 if c < 2 else ((f + p) % 5 - 2) * 0.25

    s_block = bytearray()
    v_block = bytearray()
    for f in range(CHUNK_START, CHUNK_START + CHUNK_COUNT):
        for p in range(N_POINTS):
            s_block += struct.pack("<f", s_val(f, p))
            v_block += struct.pack("<3f", v_val(f, p, 0), v_val(f, p, 1), v_val(f, p, 2))
    post_chunk = FrameChunk(
        start=CHUNK_START,
        count=CHUNK_COUNT,
        positions=chunk.positions,
        channels={**chunk.channels, "produced_s": bytes(s_block), "produced_v": bytes(v_block)},
    )
    post_envelope = encode_frame_chunk(post_chunk, header)

    expected_delta = {
        "pre_channels_len": pre_channels_len,
        "post_channels_len": len(header.channels),
        "post_envelope_bytes": len(post_envelope),
        # two (frame, element) sites per width, full triples for the vector
        "produced_s_f5_p0": s_val(5, 0),
        "produced_s_f8_p123": s_val(8, 123),
        "produced_v_f5_p0": [v_val(5, 0, 0), v_val(5, 0, 1), v_val(5, 0, 2)],
        "produced_v_f8_p123": [v_val(8, 123, 0), v_val(8, 123, 1), v_val(8, 123, 2)],
    }
    with open(os.path.join(FIXTURES_DIR, "delta_scalar.json"), "w") as f:
        json.dump(channel_delta_to_obj(delta_scalar), f, indent=2)
    with open(os.path.join(FIXTURES_DIR, "delta_vector.json"), "w") as f:
        json.dump(channel_delta_to_obj(delta_vector), f, indent=2)
    with open(os.path.join(FIXTURES_DIR, "header_post_delta.json"), "w") as f:
        f.write(header_to_json(header))
    with open(os.path.join(FIXTURES_DIR, "chunk_post_delta.bin"), "wb") as f:
        f.write(post_envelope)
    with open(os.path.join(FIXTURES_DIR, "expected_delta.json"), "w") as f:
        json.dump(expected_delta, f, indent=2)
    print(f"fixtures written to {os.path.abspath(FIXTURES_DIR)}")


if __name__ == "__main__":
    main()
