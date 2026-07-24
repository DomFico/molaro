"""Load-time edge authoring — the REAL serve() path, driven over in-memory pipes.

Covers the producer half of the `produces: edges` mechanism end to end without a
browser: a synthetic edge-mod's [i, j] pairs are APPENDED to header.edges before
the header is serialized (so they render as ordinary edges on load), bad pairs
are rejected and rolled back fail-closed, the per-mod SIGALRM timeout is enforced,
and — the load-bearing default — `--edge-mods` empty leaves the served header
BYTE-IDENTICAL to the no-arg baseline.

Synthetic data only (producer/synthetic.py). Needs numpy (the synthetic source
does too). Run from viewer/:
  python3 tests/test_edge_mods_serve.py

NOTE ON LOCATION: the task named producer/tests/, but every sibling serve test
lives in tests/ (test_produced_channel_serve.py, test_mod_params_serve.py) and
that is where the mdbench python is pointed — so this joins them there.
"""
from __future__ import annotations

import io
import json
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contract.contract import header_from_json  # noqa: E402
from producer.serve import apply_edge_mods, serve  # noqa: E402
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


def _run(source, requests: list, edge_mods=None) -> list:
    """Drive serve() with `requests` (and optional edge_mods); return the list of
    response payloads (bytes). serve() exits when stdin is exhausted."""
    stdin = io.BytesIO(_framed(requests))
    stdout = io.BytesIO()
    serve(source, stdin, stdout, edge_mods=edge_mods or [])
    stdout.seek(0)
    out = []
    while True:
        prefix = stdout.read(4)
        if len(prefix) < 4:
            break
        (n,) = struct.unpack("<I", prefix)
        out.append(stdout.read(n))
    return out


def _served_header_bytes(source, edge_mods=None) -> bytes:
    """The RAW header payload serve() writes for a single header request."""
    return _run(source, [{"type": "header"}], edge_mods=edge_mods)[0]


def _edge_mod_file(tmp: str, name: str, body: str) -> str:
    """Write a produces:edges mod file whose compute returns `body` (a Python
    expression evaluated with `data` and `target_indices` in scope)."""
    text = (
        "# molaro-mod\n"
        f"# name: {name}\n"
        "# kind: analysis\n"
        "# produces: edges\n"
        "\n"
        "def compute(data, target_indices):\n"
        f"    return {body}\n"
    )
    path = os.path.join(tmp, f"{name}.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def main() -> int:
    N, T = 60, 6

    with tempfile.TemporaryDirectory() as tmp:
        # -- the DEFAULT no-op: served header byte-identical -------------------
        # A fresh source per run (give_frames/give_header are deterministic, but
        # apply_edge_mods mutates header.edges in place, so isolate).
        base = _served_header_bytes(SyntheticSource(n_points=N, n_frames=T, seed=3))
        empty_list = _served_header_bytes(
            SyntheticSource(n_points=N, n_frames=T, seed=3), edge_mods=[])
        empty_none = _served_header_bytes(
            SyntheticSource(n_points=N, n_frames=T, seed=3), edge_mods=None)
        check("--edge-mods EMPTY: served header byte-identical to the no-arg baseline",
              base == empty_list == empty_none,
              f"{len(base)} vs {len(empty_list)} vs {len(empty_none)} bytes")

        base_header = header_from_json(base.decode("utf-8"))
        base_edges = list(base_header.edges)

        # -- a good edge-mod: header.edges grows by EXACTLY those pairs ---------
        # Author two edges between points that the synthetic chain does NOT link:
        # 0<->N-1 (endpoints) and 5<->40. These are in range and distinct.
        good = _edge_mod_file(tmp, "link_good", f"[[0, {N - 1}], [5, 40]]")
        grown = _served_header_bytes(
            SyntheticSource(n_points=N, n_frames=T, seed=3), edge_mods=[good])
        grown_header = header_from_json(grown.decode("utf-8"))
        grown_edges = [tuple(e) for e in grown_header.edges]
        check("a good edge-mod: header.edges grows by exactly the returned pairs",
              grown_edges == base_edges + [(0, N - 1), (5, 40)],
              f"grew {len(grown_edges) - len(base_edges)} (want 2)")
        check("appended edges render as ordinary edges (they pass the header contract)",
              all(0 <= a < N and 0 <= b < N and a != b for a, b in grown_edges))

        # -- bad pairs are rejected + rolled back (fail-closed) ----------------
        bad_cases = {
            "out-of-range (>= n_points)": f"[[0, {N}]]",
            "out-of-range (< 0)": "[[-1, 0]]",
            "self-loop": "[[7, 7]]",
            "wrong shape (a triple)": "[[0, 1, 2]]",
            "wrong shape (a bare int)": "[3]",
            "not a list of pairs": "'nope'",
            "non-integer index": "[[0, 1.5]]",
        }
        for label, body in bad_cases.items():
            bad = _edge_mod_file(tmp, "link_bad", body)
            served = _served_header_bytes(
                SyntheticSource(n_points=N, n_frames=T, seed=3), edge_mods=[bad])
            check(f"bad edge-mod rejected + rolled back ({label}): header byte-identical",
                  served == base, f"{len(served)} vs {len(base)}")

        # -- a mix: one good mod + one bad mod → only the good pairs land -------
        bad = _edge_mod_file(tmp, "link_bad", f"[[0, {N}]]")  # out of range
        good2 = _edge_mod_file(tmp, "link_good2", "[[1, 2]]")
        mixed = header_from_json(
            _served_header_bytes(
                SyntheticSource(n_points=N, n_frames=T, seed=3),
                edge_mods=[good2, bad]).decode("utf-8"))
        check("mixed good+bad: the good mod's pair lands, the bad one is skipped",
              [tuple(e) for e in mixed.edges] == base_edges + [(1, 2)],
              f"{len(mixed.edges) - len(base_edges)} added (want 1)")

        # -- the per-mod SIGALRM timeout is enforced (a runaway mod is skipped) -
        # apply_edge_mods runs each mod under run_mod's SIGALRM budget; a busy
        # loop is aborted mid-flight, the mod skipped, the load unaffected.
        slow = _edge_mod_file(
            tmp, "link_slow",
            "(lambda: ([[0, 1]] if False else __import__('time').sleep(10) or [[0, 1]]))()")
        src = SyntheticSource(n_points=N, n_frames=T, seed=3)
        h = src.give_header()
        before = len(h.edges)
        import time as _t
        t0 = _t.monotonic()
        apply_edge_mods(src, h, [slow], timeout_s=0.3)
        elapsed = _t.monotonic() - t0
        check("a runaway edge-mod is aborted by the timeout and skipped (edges unchanged)",
              len(h.edges) == before, f"{len(h.edges)} vs {before}")
        check("the timeout actually bounded the wall clock (< 10s sleep)",
              elapsed < 5.0, f"{elapsed:.2f}s")

        # -- an unreadable path is skipped fail-closed, not fatal ---------------
        src2 = SyntheticSource(n_points=N, n_frames=T, seed=3)
        h2 = src2.give_header()
        before2 = len(h2.edges)
        apply_edge_mods(src2, h2, [os.path.join(tmp, "does_not_exist.py")])
        check("a missing edge-mod file is skipped fail-closed (edges unchanged)",
              len(h2.edges) == before2)

    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
