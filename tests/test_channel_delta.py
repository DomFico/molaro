"""Channel deltas — the Python twin's rejection + epoch tests.

The TS side of the same claims lives in tests/contract.test.ts (which also
proves cross-language agreement through the fixtures). THIS file asserts the
Python twin fires every rejection by name and leaves nothing behind, and that
validate_frame_chunk_against implements the request-epoch rule — so a twin
drifting on either would fail its own language's suite, not just the shared
fixtures.

Run from viewer/:  python3 tests/test_channel_delta.py   (stdlib only)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import (  # noqa: E402
    Channel,
    ContractError,
    apply_channel_delta,
    channel_delta_from_obj,
    channel_delta_to_obj,
    decode_frame_chunk,
    header_from_json,
    validate_frame_chunk_against,
)

FIX = os.path.join(os.path.dirname(__file__), "..", "contract", "fixtures")

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def rejects(name: str, fn, needle: str) -> None:
    try:
        fn()
    except ContractError as e:
        check(name, needle in str(e), str(e)[:120])
        return
    check(name, False, "no error raised")


def main() -> int:
    header_text = open(os.path.join(FIX, "header.json"), encoding="utf-8").read()
    header = header_from_json(header_text)
    before = len(header.channels)

    # -- rejections fire by name, nothing half-declared ------------------------
    rejects(
        "collision across scopes rejects by name ('mass' is per_point)",
        lambda: apply_channel_delta(
            header,
            channel_delta_from_obj(
                {"name": "mass", "scope": "per_point_per_frame", "dtype": "float32"}
            ),
        ),
        "already declared",
    )
    check("failed apply left the header untouched", len(header.channels) == before)
    rejects(
        "wrong scope rejects (deltas declare streamed channels only)",
        lambda: channel_delta_from_obj({"name": "x", "scope": "per_point", "dtype": "float32"}),
        "scope must be 'per_point_per_frame'",
    )
    rejects(
        "bad width rejects",
        lambda: channel_delta_from_obj(
            {"name": "x", "scope": "per_point_per_frame", "dtype": "float32", "components": 2}
        ),
        "components must be 1 or 3",
    )
    rejects(
        "min/max on a vector rejects",
        lambda: channel_delta_from_obj(
            {
                "name": "x",
                "scope": "per_point_per_frame",
                "dtype": "float32",
                "components": 3,
                "min": 0,
            }
        ),
        "min/max are not defined for vector channels",
    )
    rejects(
        "inline data on a streamed declaration rejects",
        lambda: channel_delta_from_obj(
            {"name": "x", "scope": "per_point_per_frame", "dtype": "float32", "data": [1.0]}
        ),
        "never carries inline data",
    )
    rejects(
        "bad dtype rejects",
        lambda: channel_delta_from_obj(
            {"name": "x", "scope": "per_point_per_frame", "dtype": "float64"}
        ),
        "unsupported dtype",
    )
    check("no rejection half-declared anything", len(header.channels) == before)

    # -- serialization round-trip (what the producer emits, the viewer parses) --
    delta = Channel(name="rt", scope="per_point_per_frame", components=3)
    check(
        "delta to_obj/from_obj round-trips exactly",
        channel_delta_from_obj(channel_delta_to_obj(delta)) == delta,
    )

    # -- the request-epoch rule, all four quadrants ----------------------------
    pre_capture = list(header.channels)
    pre_chunk = decode_frame_chunk(open(os.path.join(FIX, "chunk.bin"), "rb").read())
    post_chunk = decode_frame_chunk(
        open(os.path.join(FIX, "chunk_post_delta.bin"), "rb").read()
    )
    import json

    apply_channel_delta(
        header, channel_delta_from_obj(json.load(open(os.path.join(FIX, "delta_scalar.json"))))
    )
    apply_channel_delta(
        header, channel_delta_from_obj(json.load(open(os.path.join(FIX, "delta_vector.json"))))
    )
    n_f, n_p = header.n_frames, header.n_points
    validate_frame_chunk_against(pre_chunk, n_f, n_p, pre_capture)  # pre vs pre: ok
    validate_frame_chunk_against(post_chunk, n_f, n_p, header.channels)  # post vs post: ok
    rejects(
        "pre-delta chunk fails the POST set (old shape names the mismatch)",
        lambda: validate_frame_chunk_against(pre_chunk, n_f, n_p, header.channels),
        "do not match declared",
    )
    rejects(
        "post-delta chunk fails the PRE set (never subset-tolerant)",
        lambda: validate_frame_chunk_against(post_chunk, n_f, n_p, pre_capture),
        "do not match declared",
    )
    check("epoch quadrants: the two valid quadrants validated silently above", True)

    print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
