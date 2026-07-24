"""TS↔Python edge-validation parity — the two `edges` validators agree rule-for-rule.

The `produces: edges` return is validated in TWO places that must never drift:
  - Python: producer/serve.py run_mod's edges arm (the load-apply gate — what
    --edge-mods actually authors);
  - TypeScript: webview/recipes.ts validateModValues's edges arm (the interactive
    gate — what an in-session run reports).
If they disagreed, an interactive run could accept (and report a count for) a
return that load-apply rejects — or vice versa — making the honest-defer message
untruthful. This differential test feeds the SAME JSON case set to both and
asserts identical accept/reject verdicts.

The case set covers every rule: valid pairs (incl. empty), the hi == n_points
off-by-one, negative index, self-loop, wrong shapes (triple / single / bare
element), non-integer / string / boolean indices, and non-list returns.

REPRESENTATION NOTE: cases travel as JSON so both sides judge the same values.
A Python float that is integral (1.0) is deliberately NOT a case: JS has no
int/float distinction (JSON 1.0 === 1, Number.isInteger(1.0) is true), so the
two languages cannot express the same input — and the real wire (producer JSON →
webview) collapses it the same way, so no reachable input hits the difference.

Run from viewer/ (needs node on PATH for the TS half):
  python3 tests/test_edge_validation_parity.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from producer.serve import run_mod  # noqa: E402

N_POINTS = 10

# Every case is a (label, value) the mod's compute "returned" — JSON-expressible
# so the TS side judges the identical value.
CASES: list[tuple[str, object]] = [
    ("valid: two in-range pairs", [[0, 1], [2, 9]]),
    ("valid: empty list (no new edges)", []),
    ("valid: hi index == n_points - 1", [[0, N_POINTS - 1]]),
    ("reject: hi == n_points (off-by-one)", [[0, N_POINTS]]),
    ("reject: negative index", [[-1, 0]]),
    ("reject: self-loop", [[3, 3]]),
    ("reject: self-loop after a valid pair", [[0, 1], [4, 4]]),
    ("reject: triple, not a pair", [[0, 1, 2]]),
    ("reject: single, not a pair", [[5]]),
    ("reject: bare int element", [3]),
    ("reject: non-integer index (1.5)", [[0, 1.5]]),
    ("reject: string index", [[0, "1"]]),
    ("reject: boolean index", [[0, True]]),
    ("reject: not a list (string)", "nope"),
    ("reject: not a list (dict)", {"x": [0, 1]}),
]

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def python_verdict(case: object) -> bool:
    """Judge `case` through the REAL producer gate: run_mod with produces=edges.
    The compute json.loads an embedded JSON literal so the Python value carries
    exactly the JSON semantics the TS side sees (floats stay float, bools bool)."""
    code = (
        "import json\n"
        "def compute(data, target_indices):\n"
        f"    return json.loads({json.dumps(json.dumps(case))})\n"
    )
    reply = json.loads(
        run_mod(None, code, [0], 5.0, produces="edges", n_points=N_POINTS).decode("utf-8"))
    return "error" not in reply


def ts_verdicts(cases: list[object]) -> list[bool]:
    """Judge every case through the REAL webview gate: validateModValues' edges
    arm, via the one-purpose node driver (stdin JSON in, verdict list out)."""
    driver = os.path.join(os.path.dirname(__file__), "edge_parity_driver.ts")
    proc = subprocess.run(
        ["node", driver],
        input=json.dumps({"nPoints": N_POINTS, "cases": cases}).encode("utf-8"),
        capture_output=True,
        timeout=60,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"TS driver failed: {proc.stderr.decode('utf-8', 'replace')}")
    return json.loads(proc.stdout.decode("utf-8"))


def main() -> int:
    values = [v for _, v in CASES]
    ts = ts_verdicts(values)
    check("the TS driver judged every case", len(ts) == len(CASES), f"{len(ts)}/{len(CASES)}")
    for (label, value), ts_ok in zip(CASES, ts):
        py_ok = python_verdict(value)
        want_ok = label.startswith("valid")
        check(
            f"parity: {label} → both {'accept' if want_ok else 'reject'}",
            py_ok == ts_ok == want_ok,
            f"python={py_ok} ts={ts_ok} want={want_ok}",
        )
    print(f"\n{'ALL PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
