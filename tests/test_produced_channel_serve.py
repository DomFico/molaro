"""Produced channels — the REAL serve() loop, driven over in-memory pipes.

Covers the producer half of B-3 end to end without a browser: a channel mod
declares through run_mod, the served header GROWS, every SUBSEQUENT frame
chunk carries the new block (and a chunk requested BEFORE the declaration is
old-shape — the request-epoch ordering the S1 seam rests on), re-declaration
replaces vs refuses by shape, the coherence warning fires on an incoherent
vector, and a rejected declaration installs NOTHING.

Needs numpy (the synthetic source needs it too). Run from viewer/:
  python3 tests/test_produced_channel_serve.py
"""
from __future__ import annotations

import io
import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import (  # noqa: E402
    channel_components,
    decode_frame_chunk,
    header_from_json,
    validate_frame_chunk,
)
from producer.serve import serve  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def _framed(reqs: list) -> bytes:
    out = bytearray()
    for r in reqs:
        b = json.dumps(r).encode("utf-8")
        out += struct.pack("<I", len(b)) + b
    return bytes(out)


def _channel_mod(name: str, components: int, expr: str, *, min=None, max=None) -> str:
    """A mod whose per-frame values come from `expr(f, p, c)` — a Python
    expression string over f, p, c evaluated per element."""
    extra = ""
    if min is not None:
        extra += f', "min": {min}'
    if max is not None:
        extra += f', "max": {max}'
    return (
        "def compute(data, target_indices):\n"
        "    h = data.give_header(); N, T = h.n_points, h.n_frames\n"
        f"    C = {components}\n"
        "    vals = []\n"
        "    for f in range(T):\n"
        "        for p in range(N):\n"
        "            for c in range(C):\n"
        f"                vals.append(float({expr}))\n"
        f'    return {{"name": "{name}", "components": {components}, "values": vals{extra}}}\n'
    )


def _run(source, requests: list) -> list:
    """Drive serve() with `requests`; return the list of response payloads
    (bytes). serve() exits when stdin is exhausted."""
    stdin = io.BytesIO(_framed(requests))
    stdout = io.BytesIO()
    serve(source, stdin, stdout)
    stdout.seek(0)
    out = []
    while True:
        prefix = stdout.read(4)
        if len(prefix) < 4:
            break
        (n,) = struct.unpack("<I", prefix)
        out.append(stdout.read(n))
    return out


def main() -> int:
    N, T = 40, 8
    scalar_mod = _channel_mod("heat", 1, "f * 0.5 + p * 0.25", min=0.0, max=200.0)
    # a COHERENT vector (constant direction) — no warning expected
    vec_ok = _channel_mod("dir_ok", 3, "(1.0, 0.0, 0.0)[c]")
    # an INCOHERENT vector (x flips sign every frame) — warning expected
    vec_bad = _channel_mod("dir_bad", 3, "((-1.0) ** f, 0.0, 0.0)[c]")

    # -- one session: chunk BEFORE any declaration, then declare, then chunk ---
    src = SyntheticSource(n_points=N, n_frames=T, seed=5)
    resp = _run(src, [
        {"type": "header"},
        {"type": "frames", "start": 0, "count": 4},          # PRE-declaration
        {"type": "run_mod", "code": scalar_mod, "target_indices": [0]},
        {"type": "run_mod", "code": vec_ok, "target_indices": [0]},
        {"type": "header"},                                    # POST-declaration
        {"type": "frames", "start": 0, "count": 4},           # POST-declaration
    ])
    header0 = header_from_json(resp[0].decode("utf-8"))
    pre_chunk = decode_frame_chunk(resp[1])
    scalar_reply = json.loads(resp[2].decode("utf-8"))
    vec_reply = json.loads(resp[3].decode("utf-8"))
    header1 = header_from_json(resp[4].decode("utf-8"))
    post_chunk = decode_frame_chunk(resp[5])

    check("header served ONCE reflects the base channels",
          sorted(c.name for c in header0.channels) == ["energy", "flow", "mass", "time"])
    check("a PRE-declaration chunk is old-shape (no produced blocks)",
          sorted(pre_chunk.channels.keys()) == ["energy", "flow"],
          str(sorted(pre_chunk.channels.keys())))
    check("scalar channel declares (reply carries the declaration + min/max)",
          scalar_reply.get("values", {}).get("channel", {}).get("name") == "heat"
          and scalar_reply["values"]["channel"].get("min") == 0.0
          and scalar_reply["values"]["channel"].get("max") == 200.0,
          str(scalar_reply)[:150])
    check("coherent vector declares with NO warning",
          "channel" in vec_reply.get("values", {}) and "warning" not in vec_reply["values"],
          str(vec_reply)[:150])
    check("the re-served header GREW to include both produced channels",
          sorted(c.name for c in header1.channels)
          == ["dir_ok", "energy", "flow", "heat", "mass", "time"],
          str(sorted(c.name for c in header1.channels)))
    check("dir_ok kept its vector width across the header round-trip",
          channel_components(next(c for c in header1.channels if c.name == "dir_ok")) == 3)
    check("a POST-declaration chunk carries BOTH produced blocks",
          sorted(post_chunk.channels.keys()) == ["dir_ok", "energy", "flow", "heat"],
          str(sorted(post_chunk.channels.keys())))
    validate_frame_chunk(post_chunk, header1)  # exact set + lengths against the grown header
    check("post chunk validates against the grown header (set + lengths)", True)
    check("heat block is scalar-sized, dir_ok block is 3x",
          len(post_chunk.channels["heat"]) == 4 * N * 1 * 4
          and len(post_chunk.channels["dir_ok"]) == 4 * N * 3 * 4)

    # -- coherence WARNING on an incoherent vector -----------------------------
    src2 = SyntheticSource(n_points=N, n_frames=T, seed=5)
    r2 = _run(src2, [{"type": "run_mod", "code": vec_bad, "target_indices": [0]}])
    bad_reply = json.loads(r2[0].decode("utf-8"))
    check("incoherent vector still DECLARES (warning, never refusal)",
          "channel" in bad_reply.get("values", {}))
    check("...and the coherence warning names the channel + a count",
          "warning" in bad_reply.get("values", {})
          and "dir_bad" in bad_reply["values"]["warning"]
          and "inversion" in bad_reply["values"]["warning"],
          bad_reply.get("values", {}).get("warning", "")[:100])

    # -- re-declaration: same shape REPLACES, different shape REFUSES ----------
    src3 = SyntheticSource(n_points=N, n_frames=T, seed=5)
    scalar_mod_v2 = _channel_mod("heat", 1, "9.0", min=0.0, max=10.0)   # same name+shape, new data
    scalar_as_vector = _channel_mod("heat", 3, "1.0")                   # same name, DIFFERENT shape
    r3 = _run(src3, [
        {"type": "run_mod", "code": scalar_mod, "target_indices": [0]},       # declare heat
        {"type": "frames", "start": 0, "count": 2},                            # heat = f*.5+p*.25
        {"type": "run_mod", "code": scalar_mod_v2, "target_indices": [0]},     # re-declare heat = 9
        {"type": "frames", "start": 0, "count": 2},                            # heat now all 9
        {"type": "run_mod", "code": scalar_as_vector, "target_indices": [0]},  # wrong shape → refuse
    ])
    import numpy as np
    heat_before = np.frombuffer(decode_frame_chunk(r3[1]).channels["heat"], dtype="<f4")
    heat_after = np.frombuffer(decode_frame_chunk(r3[3]).channels["heat"], dtype="<f4")
    check("re-declaration REPLACES the data (heat changed to all 9.0)",
          float(heat_before[0]) != 9.0 and np.all(heat_after == 9.0),
          f"before[0]={float(heat_before[0])} after unique={sorted(set(heat_after.tolist()))[:3]}")
    refuse = json.loads(r3[4].decode("utf-8"))
    check("re-declaring a name with a DIFFERENT shape is refused by name",
          "error" in refuse and "different shape" in refuse["error"],
          str(refuse)[:120])

    # -- atomicity: a REJECTED declaration installs nothing ---------------------
    src4 = SyntheticSource(n_points=N, n_frames=T, seed=5)
    short_mod = (
        "def compute(data, target_indices):\n"
        '    return {"name": "bad", "components": 1, "values": [1.0, 2.0]}\n'  # wrong length
    )
    r4 = _run(src4, [
        {"type": "run_mod", "code": short_mod, "target_indices": [0]},
        {"type": "header"},
        {"type": "frames", "start": 0, "count": 2},
    ])
    rej = json.loads(r4[0].decode("utf-8"))
    hdr_after_reject = header_from_json(r4[1].decode("utf-8"))
    chunk_after_reject = decode_frame_chunk(r4[2])
    check("a wrong-length channel is REJECTED with a clean error",
          "error" in rej and "flat frame-major list" in rej["error"], str(rej)[:120])
    check("...the rejected channel left the header UNTOUCHED",
          not any(c.name == "bad" for c in hdr_after_reject.channels))
    check("...and the next frames reply is still old-shape (nothing installed)",
          sorted(chunk_after_reject.channels.keys()) == ["energy", "flow"])
    validate_frame_chunk(chunk_after_reject, hdr_after_reject)

    print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
