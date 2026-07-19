"""Long-lived producer process — Increment 2 live transport.

Serves the logical protocol over stdio:
- stdin:  length-framed requests — 4-byte little-endian length prefix, then that
  many bytes of UTF-8 JSON: {"type": "header"},
  {"type": "frames", "start": int, "count": int}, or
  {"type": "run_mod", "code": str, "target_indices": [int], "timeout_s"?: float}
  (execute a mod's compute(data, target_indices) against the resident dataset;
  answers {"values": [float]} or {"error": str, "traceback"?: str}).
- stdout: length-framed responses, strictly FIFO with requests. Payload is the
  Header JSON (UTF-8), a FrameChunk binary envelope, a run_mod JSON reply, or —
  if a request was invalid — a JSON object {"error": "..."}.

stdout is the protocol channel and carries nothing else. All logging goes to
stderr; sys.stdout is rebound to stderr after the protocol stream is captured,
so even a stray print() cannot corrupt the byte stream.

Run from anywhere:  python3 producer/serve.py --n-points 20000 --n-frames 600
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import signal
import struct
import sys
import traceback
from typing import BinaryIO, Optional

# figure mods render headless — never a display, never a hang on one
os.environ.setdefault("MPLBACKEND", "Agg")

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


DEFAULT_MOD_TIMEOUT_S = 5.0


class ModTimeout(Exception):
    pass


def run_mod(source, code: str, target_indices, timeout_s: float) -> bytes:
    """Execute a mod's `compute(data, target_indices)` against the RESIDENT
    dataset handle and return the response payload (JSON bytes).

    Deliberately NOT a sandbox — mods are user-approved code (the approval
    gate lives upstream); the requirement here is robust error handling and
    a wall-clock timeout so a runaway mod can't hang the producer. The
    timeout uses SIGALRM/setitimer (serve() runs in the main thread), which
    genuinely aborts the compute mid-flight; frame requests queue behind a
    running compute (single FIFO process), bounded by this timeout.

    Any failure — exec error, a raising compute, a timeout, a non-list
    return — answers {"error", "traceback"} and binds NOTHING downstream.
    """
    if not isinstance(code, str) or not code.strip():
        return json.dumps({"error": "run_mod: empty code"}).encode("utf-8")
    if not isinstance(target_indices, list) or not all(isinstance(i, int) for i in target_indices):
        return json.dumps({"error": "run_mod: target_indices must be a list of ints"}).encode("utf-8")

    def on_alarm(_sig, _frame):
        raise ModTimeout(f"mod timed out after {timeout_s}s")

    prev_handler = signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(timeout_s, 0.01))
    try:
        namespace: dict = {}
        exec(compile(code, "<mod>", "exec"), namespace)  # noqa: S102 — deliberate, see docstring
        fn = namespace.get("compute")
        if not callable(fn):
            return json.dumps({"error": "the code must define compute(data, target_indices)"}).encode("utf-8")
        values = fn(source, target_indices)

        def finite_floats(seq):
            return isinstance(seq, list) and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))
                for v in seq
            )

        if isinstance(values, dict) and isinstance(values.get("png"), str):
            # a FIGURE reply: {png, width, height, axes} — a light structural
            # pass keeps the wire well-formed; the client runs THE deep
            # validator (plotmodel.validateFigure) against the declared
            # `produces` before anything displays.
            axes = values.get("axes")
            if not isinstance(values.get("width"), int) or not isinstance(values.get("height"), int):
                return json.dumps(
                    {"error": "a figure return must carry integer width and height"}
                ).encode("utf-8")
            if not isinstance(axes, list):
                return json.dumps(
                    {"error": "a figure return must carry axes as a list (one entry per subplot)"}
                ).encode("utf-8")
            out = {
                "png": values["png"],
                "width": values["width"],
                "height": values["height"],
                "axes": axes,
            }
            return json.dumps({"values": out}).encode("utf-8")
        if isinstance(values, dict):
            # the OTHER widened return shape: a scatter's {x, y, frames?,
            # xLabel?, yLabel?}. The client re-validates against the mod's
            # declared `produces`; this pass keeps the wire well-formed.
            if not (finite_floats(values.get("x")) and finite_floats(values.get("y"))):
                return json.dumps(
                    {"error": "a dict return must carry x and y as flat lists of finite floats"}
                ).encode("utf-8")
            out = {
                "x": [float(v) for v in values["x"]],
                "y": [float(v) for v in values["y"]],
            }
            if "frames" in values:
                if not finite_floats(values["frames"]):
                    return json.dumps(
                        {"error": "frames must be a flat list of frame indices"}
                    ).encode("utf-8")
                out["frames"] = [int(v) for v in values["frames"]]
            for key in ("xLabel", "yLabel"):
                if isinstance(values.get(key), str):
                    out[key] = values[key]
            return json.dumps({"values": out}).encode("utf-8")
        # a `produces: commands` mod returns a flat list[str] — pass it through
        # for the client to validate + run through the command path (the client
        # re-validates against the mod's declared produces).
        if isinstance(values, list) and all(isinstance(v, str) for v in values):
            return json.dumps({"values": list(values)}).encode("utf-8")
        if not finite_floats(values):
            return json.dumps(
                {"error": "compute must return a flat list of finite floats (or a list of command strings)"}
            ).encode("utf-8")
        return json.dumps({"values": [float(v) for v in values]}).encode("utf-8")
    except ModTimeout as exc:
        return json.dumps({"error": str(exc)}).encode("utf-8")
    except ModuleNotFoundError as exc:
        # A missing scientific package (typically mdtraj) is a SETUP problem, not
        # a bug in the mod — say so actionably instead of a bare traceback (the
        # Python preflight for the "first mod run" path).
        return json.dumps({
            "error": (
                f"{exc.msg}. Analysis mods run in the producer's Python "
                f"({sys.executable}); this interpreter is missing a required package. "
                "Point the extension at an interpreter that has it (mdtraj etc.) via the "
                "VIEWER_PYTHON environment variable — see README.md (Python for analysis mods)."
            ),
            "traceback": traceback.format_exc(),
        }).encode("utf-8")
    except Exception as exc:
        return json.dumps(
            {"error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
        ).encode("utf-8")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev_handler)


def log_mdtraj_preflight() -> None:
    """Report at startup whether analysis mods will be able to run: mdtraj must be
    importable in THIS interpreter. Logged (not fatal) — the synthetic source and
    the viewer work without it; only analysis mods need it."""
    try:
        import mdtraj  # noqa: F401
        log.info("preflight: mdtraj available (analysis mods can run) — interpreter %s", sys.executable)
    except ModuleNotFoundError:
        log.warning(
            "preflight: mdtraj NOT importable in %s — analysis mods will fail. "
            "Set VIEWER_PYTHON to an interpreter that has mdtraj (see README.md).",
            sys.executable,
        )


def serve(source: SyntheticSource, stdin: BinaryIO, stdout: BinaryIO) -> None:
    log_mdtraj_preflight()
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
            elif rtype == "run_mod":
                timeout_s = request.get("timeout_s", DEFAULT_MOD_TIMEOUT_S)
                if not isinstance(timeout_s, (int, float)) or timeout_s <= 0:
                    timeout_s = DEFAULT_MOD_TIMEOUT_S
                payload = run_mod(
                    source, request.get("code"), request.get("target_indices"), float(timeout_s)
                )
                log.debug("run_mod -> %d bytes", len(payload))
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
