"""produces: figure — the PRODUCER half, round-tripped for real.

The E2E lane proves the display/mapping hermetically (S45 injects a
hand-made PNG; matplotlib never runs there). THIS test proves the other
half: the shipped template mod renders an actual matplotlib figure through
`run_mod`, and the reply carries mechanically-emitted axes metadata of the
exact shape the viewer-side validator (plotmodel.validateFigure) accepts.

Run from viewer/ with a python that has matplotlib (the analysis env):
  python3 tests/test_figure_roundtrip.py
Skips loudly (exit 0, SKIP line) when matplotlib is unavailable — the
env-gating is itself part of the design (run_mod errors, never hangs).
"""
from __future__ import annotations

import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from producer.serve import run_mod  # noqa: E402
from producer.synthetic import SyntheticSource  # noqa: E402

MOD_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".molaro", "mods", "figure_metric.py"
)

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    try:
        import matplotlib  # noqa: F401
    except ImportError:
        # the env-gate itself: run_mod must ERROR (never hang) — provable
        # only where matplotlib is absent, so here we just skip loudly
        print("SKIP: matplotlib not available in this python — the round-trip needs the analysis env")
        return 0

    n_frames = 30
    src = SyntheticSource(n_points=120, n_frames=n_frames, seed=11)
    code = open(MOD_PATH, encoding="utf-8").read()
    reply = json.loads(run_mod(src, code, [0, 1, 2], 60.0).decode("utf-8"))
    check("run_mod answers with values (no error)", "values" in reply, str(reply.get("error", ""))[:200])
    if "values" not in reply:
        return 1
    v = reply["values"]

    png = base64.b64decode(v["png"])
    check("the payload IS a PNG (magic bytes)", png[:8] == b"\x89PNG\r\n\x1a\n")
    check("decoded size under the 2 MiB cap", len(png) <= 2 * 1024 * 1024, f"{len(png)} bytes")
    check("pixel dimensions are sane integers", isinstance(v["width"], int) and isinstance(v["height"], int)
          and 8 <= v["width"] <= 8192 and 8 <= v["height"] <= 8192, f"{v['width']}x{v['height']}")

    axes = v["axes"]
    check("two axes emitted (one per subplot), mechanically", isinstance(axes, list) and len(axes) == 2)
    frames_axes = [a for a in axes if a["x_is_frames"]]
    static_axes = [a for a in axes if not a["x_is_frames"]]
    check("exactly ONE frames axis + one static", len(frames_axes) == 1 and len(static_axes) == 1)
    fa = frames_axes[0]
    check("the frames axis spans the trajectory exactly",
          fa["xlim"][0] == 0.0 and fa["xlim"][1] == float(n_frames - 1), str(fa["xlim"]))
    for a in axes:
        b = a["bbox"]
        check("bbox within [0,1]² with positive extent",
              len(b) == 4 and b[2] > 0 and b[3] > 0 and 0 <= b[0] and 0 <= b[1]
              and b[0] + b[2] <= 1.0 + 1e-9 and b[1] + b[3] <= 1.0 + 1e-9, str(b))

    # the serve-side structural gate: a figure dict missing width errors
    bad = code.replace('"width": w,', "")
    reply_bad = json.loads(run_mod(src, bad, [0], 60.0).decode("utf-8"))
    check("a figure reply missing width fails CLOSED at the wire",
          "error" in reply_bad and "integer width and height" in reply_bad["error"],
          str(reply_bad)[:120])

    print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
