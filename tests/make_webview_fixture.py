"""Write the webview fixture: header.json + chunk0.bin (frame 0 only).

The webview reads these two files as local resources — this stands in for the
live producer transport that arrives in a later increment.

Run from viewer/:
    python3 tests/make_webview_fixture.py                     # default N=5000
    python3 tests/make_webview_fixture.py --n-points 300000   # scale check
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import encode_frame_chunk, header_to_json  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "..", "media", "fixtures")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n-points", type=int, default=5000)
    ap.add_argument("--n-frames", type=int, default=100)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    source = SyntheticSource(n_points=args.n_points, n_frames=args.n_frames, seed=args.seed)
    header = source.give_header()
    chunk = source.give_frames(0, 1)
    envelope = encode_frame_chunk(chunk, header)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "header.json"), "w") as f:
        f.write(header_to_json(header))
    with open(os.path.join(args.out, "chunk0.bin"), "wb") as f:
        f.write(envelope)
    print(
        f"webview fixture written to {os.path.abspath(args.out)}: "
        f"N={args.n_points}, frame 0 of {args.n_frames}, "
        f"{len(header.edges)} edges, {len(header.polylines)} polylines, "
        f"{len(envelope)} chunk bytes"
    )


if __name__ == "__main__":
    main()
