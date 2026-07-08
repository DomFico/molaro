"""Long-lived producer process — Increment 2 live transport.

Serves the logical protocol over stdio:
- stdin:  length-framed requests — 4-byte little-endian length prefix, then that
  many bytes of UTF-8 JSON: {"type": "header"} or
  {"type": "frames", "start": int, "count": int}.
- stdout: length-framed responses, strictly FIFO with requests. Payload is the
  Header JSON (UTF-8), a FrameChunk binary envelope, or — if a request was
  invalid — a JSON object {"error": "..."}.

stdout is the protocol channel and carries nothing else. All logging goes to
stderr; sys.stdout is rebound to stderr after the protocol stream is captured,
so even a stray print() cannot corrupt the byte stream.

Run from anywhere:  python3 producer/serve.py --n-points 20000 --n-frames 600
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import struct
import sys
from typing import BinaryIO, Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import ContractError, encode_frame_chunk, header_to_json  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

log = logging.getLogger("producer")


def read_exact(stream: BinaryIO, n: int) -> Optional[bytes]:
    """Read exactly n bytes; None on clean EOF, error on mid-message EOF."""
    buf = bytearray()
    while len(buf) < n:
        piece = stream.read(n - len(buf))
        if not piece:
            if buf:
                raise EOFError(f"stream ended mid-message ({len(buf)}/{n} bytes)")
            return None
        buf += piece
    return bytes(buf)


def write_framed(stream: BinaryIO, payload: bytes) -> None:
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def serve(source: SyntheticSource, stdin: BinaryIO, stdout: BinaryIO) -> None:
    header = source.give_header()
    header_json = header_to_json(header).encode("utf-8")
    log.info(
        "serving %s: N=%d T=%d (%d header bytes)",
        header.name, header.n_points, header.n_frames, len(header_json),
    )
    while True:
        prefix = read_exact(stdin, 4)
        if prefix is None:
            log.info("stdin closed, exiting")
            return
        (length,) = struct.unpack("<I", prefix)
        body = read_exact(stdin, length)
        if body is None:
            raise EOFError("stream ended between length prefix and body")
        try:
            request = json.loads(body.decode("utf-8"))
            rtype = request.get("type")
            if rtype == "header":
                payload = header_json
            elif rtype == "frames":
                start, count = request["start"], request["count"]
                if not isinstance(start, int) or not isinstance(count, int):
                    raise ContractError("frames request: start/count must be integers")
                chunk = source.give_frames(start, count)
                payload = encode_frame_chunk(chunk, header)
                log.debug("frames [%d, %d) -> %d bytes", start, start + count, len(payload))
            else:
                raise ContractError(f"unknown request type {rtype!r}")
        except Exception as exc:  # keep FIFO 1:1 — every request gets a response
            log.warning("request %r failed: %s", body[:200], exc)
            payload = json.dumps({"error": str(exc)}).encode("utf-8")
        write_framed(stdout, payload)


def build_source(args: argparse.Namespace):
    """Pick the DataSource. --dataset (a topology file) or --system (a benchmark
    system directory) selects the real mdtraj source; otherwise synthetic.

    mdtraj is imported lazily so synthetic-only runs need no molecular stack.
    """
    if args.system:
        from producer.corpus import resolve_system  # lazy
        from producer.mdtraj_source import MdtrajSource

        spec = resolve_system(args.system)
        log.info("loading corpus system %s from %s", spec["name"], spec["topology"])
        return MdtrajSource(
            topology_path=spec["topology"],
            trajectory_path=spec["trajectory"],
            name=spec["name"],
            ligand_residues=spec["ligand_residues"],
        )
    if args.dataset:
        from producer.mdtraj_source import MdtrajSource  # lazy

        log.info("loading dataset topology=%s trajectory=%s", args.dataset, args.trajectory)
        return MdtrajSource(
            topology_path=args.dataset,
            trajectory_path=args.trajectory,
            name=args.dataset_name,
            ligand_residues=args.ligand_residue or (),
        )
    if args.open:
        # Open a file directly (Increment 4.6): resolve a companion topology for
        # trajectory files; structure files open standalone. Frame count decides
        # static vs playback downstream.
        from producer.file_resolve import resolve_open_target  # lazy
        from producer.mdtraj_source import MdtrajSource

        resolved = resolve_open_target(args.open)
        log.info(
            "opening %s -> topology=%s trajectory=%s",
            args.open, resolved["topology"], resolved["trajectory"],
        )
        return MdtrajSource(
            topology_path=resolved["topology"],
            trajectory_path=resolved["trajectory"],
            name=None,
            ligand_residues=args.ligand_residue or (),
        )
    return SyntheticSource(n_points=args.n_points, n_frames=args.n_frames, seed=args.seed)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n-points", type=int, default=20000)
    ap.add_argument("--n-frames", type=int, default=600)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dataset", help="path to a topology file (real mdtraj source)")
    ap.add_argument("--trajectory", help="path to a trajectory file (with --dataset)")
    ap.add_argument("--dataset-name", help="display name for --dataset")
    ap.add_argument("--ligand-residue", action="append", help="residue name(s) to tag as ligand")
    ap.add_argument("--system", help="benchmark system id or directory (real mdtraj source)")
    ap.add_argument("--open", help="path to a structure or trajectory file to open directly")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        stream=sys.stderr,
        level=args.log_level.upper(),
        format="producer %(levelname)s %(message)s",
    )
    stdout = sys.stdout.buffer  # capture the protocol channel...
    sys.stdout = sys.stderr  # ...then make any stray print() harmless
    stdin = sys.stdin.buffer

    try:
        source = build_source(args)
    except Exception as exc:
        log.error("failed to build data source: %s", exc)
        sys.exit(1)
    try:
        serve(source, stdin, stdout)
    except (BrokenPipeError, KeyboardInterrupt):
        log.info("pipe closed / interrupted, exiting")
    except EOFError as exc:
        log.error("protocol stream error: %s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
