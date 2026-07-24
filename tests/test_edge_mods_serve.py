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

from contract.contract import (  # noqa: E402
    VERSION,
    Header,
    Points,
    header_from_json,
    validate_header,
)
from producer.serve import apply_edge_mods, run_mod, serve  # noqa: E402
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


class AliasingSource:
    """A fake DataSource that mirrors the REAL-source aliasing hazard: its
    give_header returns Header(edges=self.edges) — the SAME list object every
    call (never a copy) — and a mod receives the source as `data`, so it can
    MUTATE data.edges in place. apply_edge_mods must trust ONLY a mod's
    validated RETURN, never the in-place header state after it ran."""

    def __init__(self, n_points: int = 20, n_frames: int = 2) -> None:
        self.n_points = n_points
        self.n_frames = n_frames
        # the persistent, aliased edge list (a small valid chain)
        self.edges = [(0, 1), (1, 2)]

    def give_header(self) -> Header:
        n = self.n_points
        return Header(
            version=VERSION,
            name="aliasing",
            n_points=n,
            n_frames=self.n_frames,
            units="meters",
            points=Points(
                type=["t"] * n,
                group_id=[0] * n,
                subgroup_id=[0] * n,
                category=[0] * n,
            ),
            categories=["a"],
            groups={0: "g"},
            subgroups={0: "s"},
            edges=self.edges,  # ALIASED on purpose — the hazard under test
            polylines=[],
            channels=[],
        )


def _aliasing_checks(tmp: str) -> None:
    """The aliasing matrix: in-place mutations of data.edges never reach the
    served header; only validated returns do; the result is always contract-valid."""
    # (a) a mod that MUTATES data.edges with an INVALID pair and returns [] —
    # the tail-only in-place rollback could not see this; the reassignment must
    # discard it (only the validated return, [], lands).
    mutate_bad = _edge_mod_file(
        tmp, "alias_mutate_bad",
        "(data.edges.append([0, 999]) or [])")
    src = AliasingSource()
    h = src.give_header()
    original = [tuple(e) for e in h.edges]
    apply_edge_mods(src, h, [mutate_bad])
    check("aliasing: an in-place INVALID mutation of data.edges never reaches the header",
          [tuple(e) for e in h.edges] == original, str(h.edges))
    try:
        validate_header(h)
        valid = True
    except Exception:
        valid = False
    check("aliasing: ...and the served header is contract-valid", valid)
    check("aliasing: ...header.edges is DE-ALIASED from the source (reassigned, not shared)",
          h.edges is not src.edges)

    # (b) a mod that CLEARS data.edges in place and returns a valid pair — the
    # cleared aliased list must not destroy the original edges; the result is
    # original + the validated return.
    clear_ret = _edge_mod_file(
        tmp, "alias_clear_ret",
        "(data.edges.clear() or [[0, 3]])")
    src2 = AliasingSource()
    h2 = src2.give_header()
    original2 = [tuple(e) for e in h2.edges]
    apply_edge_mods(src2, h2, [clear_ret])
    check("aliasing: a mod that CLEARS data.edges cannot destroy the original (snapshot wins)",
          [tuple(e) for e in h2.edges] == original2 + [(0, 3)], str(h2.edges))

    # (c) a mod whose RETURN is invalid is skipped entirely, even though it also
    # mutated the aliased list — rollback restores the original exactly.
    mutate_and_bad_ret = _edge_mod_file(
        tmp, "alias_bad_ret",
        "(data.edges.append([5, 999]) or [[7, 7]])")  # self-loop return
    src3 = AliasingSource()
    h3 = src3.give_header()
    original3 = [tuple(e) for e in h3.edges]
    apply_edge_mods(src3, h3, [mutate_and_bad_ret])
    check("aliasing: an invalid RETURN is skipped and the mutation rolled back (original restored)",
          [tuple(e) for e in h3.edges] == original3, str(h3.edges))
    try:
        validate_header(h3)
        valid3 = True
    except Exception:
        valid3 = False
    check("aliasing: ...and that header too is contract-valid", valid3)


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

        # -- real-source aliasing: give_header hands out the SAME list object ---
        _aliasing_checks(tmp)

        # -- the INTERACTIVE (mid-session) half: run_mod ECHOES {group, pairs} --
        # The webview threads edge_group on the request (its single source —
        # the mod's `# edge-group:` header or the mod name); the producer only
        # validates the pairs and echoes the token back beside them. The pairs
        # are VIEWER-owned: nothing here mutates the header or the stream.
        good_code = "def compute(data, target_indices):\n    return [[0, 5], [1, 6]]\n"
        reply = json.loads(run_mod(
            None, good_code, [0], 5.0,
            produces="edges", n_points=N, edge_group="contacts").decode("utf-8"))
        check("interactive edges run: the reply echoes {group, pairs}",
              reply.get("values") == {"group": "contacts", "pairs": [[0, 5], [1, 6]]},
              json.dumps(reply))
        # the load path threads NO group — the echo carries None, pairs intact
        reply_load = json.loads(run_mod(
            None, good_code, [0], 5.0,
            produces="edges", n_points=N).decode("utf-8"))
        check("load-path edges run: group None, pairs intact",
              reply_load.get("values") == {"group": None, "pairs": [[0, 5], [1, 6]]},
              json.dumps(reply_load))
        # bad pairs are rejected with the group threaded too (the token cannot
        # rescue an invalid return — fail-closed is shape-independent)
        for label, body in bad_cases.items():
            bad_reply = json.loads(run_mod(
                None, f"def compute(data, target_indices):\n    return {body}\n",
                [0], 5.0, produces="edges", n_points=N,
                edge_group="contacts").decode("utf-8"))
            check(f"interactive edges run rejects bad pairs ({label})",
                  "error" in bad_reply and "values" not in bad_reply,
                  json.dumps(bad_reply))

        # -- and through the REAL serve() loop: edge_group threads request→echo -
        src3 = SyntheticSource(n_points=N, n_frames=T, seed=3)
        served = _run(src3, [{
            "type": "run_mod", "code": good_code, "target_indices": [0],
            "produces": "edges", "edge_group": "wired",
        }])
        loop_reply = json.loads(served[0].decode("utf-8"))
        check("serve() threads edge_group request → echo",
              loop_reply.get("values") == {"group": "wired", "pairs": [[0, 5], [1, 6]]},
              json.dumps(loop_reply))
        # ...and an interactive run leaves the SERVED HEADER byte-identical —
        # produced edges are viewer-owned; the producer stores nothing
        src4 = SyntheticSource(n_points=N, n_frames=T, seed=3)
        h_after = _run(src4, [
            {"type": "run_mod", "code": good_code, "target_indices": [0],
             "produces": "edges", "edge_group": "wired"},
            {"type": "header"},
        ])[1]
        check("an interactive edges run leaves the served header byte-identical",
              h_after == base, f"{len(h_after)} vs {len(base)} bytes")

    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
