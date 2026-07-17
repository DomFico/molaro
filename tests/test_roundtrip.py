"""Python round-trip test: produce -> serialize -> deserialize -> validate -> equal.

Run from viewer/:  python3 -m tests.test_roundtrip   (or: pytest tests/)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import (  # noqa: E402
    ContractError,
    decode_frame_chunk,
    encode_frame_chunk,
    header_from_json,
    header_to_json,
    validate_frame_chunk,
    validate_header,
)
from producer.synthetic import SyntheticSource  # noqa: E402


def _source() -> SyntheticSource:
    return SyntheticSource(n_points=300, n_frames=20, seed=7)


def test_header_roundtrip() -> None:
    header = _source().give_header()
    validate_header(header)
    text = header_to_json(header)
    parsed = header_from_json(text)  # validates internally
    assert parsed == header


def test_chunk_roundtrip() -> None:
    source = _source()
    header = source.give_header()
    chunk = source.give_frames(5, 4)
    validate_frame_chunk(chunk, header)

    envelope = encode_frame_chunk(chunk, header)
    decoded = decode_frame_chunk(envelope)
    validate_frame_chunk(decoded, header)

    assert decoded.start == chunk.start
    assert decoded.count == chunk.count
    assert decoded.positions == chunk.positions
    assert decoded.channels == chunk.channels


def test_chunking_is_deterministic() -> None:
    """The same frame must serialize identically whatever chunk it arrives in."""
    source = _source()
    n = source.n_points
    whole = source.give_frames(0, 10)
    part = source.give_frames(6, 2)
    frame_bytes = n * 3 * 4
    assert part.positions == whole.positions[6 * frame_bytes : 8 * frame_bytes]
    assert part.channels["energy"] == whole.channels["energy"][6 * n * 4 : 8 * n * 4]
    # the VECTOR channel slices with a ×3 frame stride — the same identity,
    # exercised at the wider element width
    assert part.channels["flow"] == whole.channels["flow"][6 * n * 3 * 4 : 8 * n * 3 * 4]


def test_synthetic_scales() -> None:
    """Arbitrary N and T, including tiny and asymmetric shapes."""
    for n, t in [(1, 1), (2, 3), (997, 5), (50, 250)]:
        source = SyntheticSource(n_points=n, n_frames=t, seed=1)
        header = source.give_header()
        validate_header(header)
        scopes = {c.scope for c in header.channels}
        assert scopes == {"per_point", "per_frame", "per_point_per_frame"}
        chunk = source.give_frames(t - 1, 1)
        validate_frame_chunk(chunk, header)
        assert len(chunk.positions) == n * 3 * 4


def test_validator_rejects_bad_data() -> None:
    source = _source()
    header = source.give_header()
    chunk = source.give_frames(0, 2)
    envelope = encode_frame_chunk(chunk, header)

    def expect_error(fn) -> None:
        try:
            fn()
        except ContractError:
            return
        raise AssertionError("expected ContractError")

    # Header violations.
    bad = _source().give_header()
    bad.points.category[0] = 99
    expect_error(lambda: validate_header(bad))

    bad = _source().give_header()
    bad.edges.append((0, bad.n_points))  # index out of range
    expect_error(lambda: validate_header(bad))

    bad = _source().give_header()
    bad.points.group_id[0] = bad.points.group_id[0] + 1  # subgroup in two groups
    expect_error(lambda: validate_header(bad))

    bad = _source().give_header()
    bad.channels[0].data = bad.channels[0].data[:-1]  # wrong channel length
    expect_error(lambda: validate_header(bad))

    bad = _source().give_header()
    bad.channels[-1].components = 2  # only 1 or 3 are defined
    expect_error(lambda: validate_header(bad))

    bad_chunk = source.give_frames(0, 2)
    # a 3-wide block truncated to width-1 length: fails CLOSED (a wrong
    # stride would otherwise corrupt silently)
    bad_chunk.channels["flow"] = bad_chunk.channels["flow"][: 2 * header.n_points * 4]
    expect_error(lambda: validate_frame_chunk(bad_chunk, header))

    # Chunk violations.
    expect_error(lambda: decode_frame_chunk(b"XXXX" + envelope[4:]))  # bad magic
    expect_error(lambda: decode_frame_chunk(envelope[:-4]))  # truncated
    expect_error(lambda: decode_frame_chunk(envelope + b"\x00" * 4))  # trailing bytes

    bad_chunk = source.give_frames(0, 2)
    bad_chunk.positions = bad_chunk.positions[:-12]
    expect_error(lambda: validate_frame_chunk(bad_chunk, header))

    bad_chunk = source.give_frames(0, 2)
    del bad_chunk.channels["energy"]
    expect_error(lambda: validate_frame_chunk(bad_chunk, header))

    bad_chunk = source.give_frames(0, 2)
    bad_chunk.start = header.n_frames - 1  # range exceeds n_frames
    expect_error(lambda: validate_frame_chunk(bad_chunk, header))

    expect_error(lambda: source.give_frames(19, 2))  # out-of-range request


def main() -> None:
    tests = [
        test_header_roundtrip,
        test_chunk_roundtrip,
        test_chunking_is_deterministic,
        test_synthetic_scales,
        test_validator_rejects_bad_data,
    ]
    for t in tests:
        t()
        print(f"ok   {t.__name__}")
    print(f"\n{len(tests)} tests passed")


if __name__ == "__main__":
    main()
