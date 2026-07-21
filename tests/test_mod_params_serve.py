"""P-1: the producer's parameter path — the AUTHORITATIVE arity gate.

The webview parser cannot soundly count Python parameters, so the producer is
the sole gate: a mod that declared parameters must accept a third POSITIONAL
argument, or run_mod fails closed naming the fix. A paramless call stays a
two-arg call, byte-identical. This asserts every arity case Phase 0's adversarial
pass raised — including the `functools.wraps` trap that needs follow_wrapped=False.

Run from viewer/:  python3 tests/test_mod_params_serve.py   (stdlib only)
"""
from __future__ import annotations

import functools
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from producer.serve import _accepts_third_positional, run_mod  # noqa: E402

failures = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def reply(code: str, parameters=None) -> dict:
    """Run compute through run_mod (source ignored by these mods) and parse."""
    return json.loads(run_mod(None, code, [], 1.0, parameters=parameters).decode("utf-8"))


def main() -> int:
    # -- _accepts_third_positional: the pure arity classifier -------------------
    def two(a, b): ...
    def three(a, b, c): ...
    def star(a, b, *args): ...
    def kw(a, b, **k): ...
    def kwonly(a, b, *, c): ...
    def defaulted(a, b, c=None): ...

    check("2 positional → no third", _accepts_third_positional(two) is False)
    check("3 positional → yes", _accepts_third_positional(three) is True)
    check("*args → yes (absorbs a third)", _accepts_third_positional(star) is True)
    check("**kwargs, 2 positional → no third", _accepts_third_positional(kw) is False)
    check("keyword-only third → no (positional contract)", _accepts_third_positional(kwonly) is False)
    check("defaulted third → yes", _accepts_third_positional(defaulted) is True)

    # the functools.wraps trap: a 2-arg wrapper around a 3-arg inner. follow_wrapped
    # MUST be False, else signature() reads the INNER (3) and we'd wrongly accept.
    def deco(f):
        @functools.wraps(f)
        def wrapper(a, b):  # the REAL arity is two
            return f(a, b)
        return wrapper

    @deco
    def wrapped(a, b, c): ...  # inner declares three

    check("wraps-decorated wrapper is read by its OWN arity (2), not the inner (3)",
          _accepts_third_positional(wrapped) is False, "follow_wrapped=False")

    # a non-introspectable callable → None (caller fails closed)
    check("non-introspectable callable → None", _accepts_third_positional(object()) is None)

    # -- run_mod: the intent-gated call ----------------------------------------
    two_arg = "def compute(data, target_indices):\n    return [1.0]\n"
    three_arg = "def compute(data, target_indices, params):\n    return [float(params['k'])]\n"
    star_arg = "def compute(data, target_indices, *args):\n    return [float(args[0]['k'])]\n"
    kw_arg = "def compute(data, target_indices, **kw):\n    return [1.0]\n"
    kwonly_arg = "def compute(data, target_indices, *, params):\n    return [1.0]\n"

    # paramless call stays two-arg, unchanged
    r = reply(two_arg, parameters=None)
    check("paramless mod runs (two-arg path)", r.get("values") == [1.0], str(r)[:120])
    # an EMPTY params dict is treated as no-params (still two-arg — no arity demand)
    r = reply(two_arg, parameters={})
    check("empty params dict → still the two-arg path", r.get("values") == [1.0], str(r)[:120])

    # a declaring mod receives params as the third positional arg
    r = reply(three_arg, parameters={"k": 7})
    check("three-arg mod receives params", r.get("values") == [7.0], str(r)[:120])
    r = reply(star_arg, parameters={"k": 9})
    check("*args mod receives params in args[0]", r.get("values") == [9.0], str(r)[:120])

    # fail CLOSED, naming the fix, when params are passed to a compute that can't take them
    for name, code in [("two-arg", two_arg), ("**kwargs", kw_arg), ("keyword-only", kwonly_arg)]:
        r = reply(code, parameters={"k": 1})
        ok = "error" in r and "third positional" in r["error"]
        check(f"params passed to a {name} compute fails closed by name", ok, str(r)[:140])

    print("ALL PASS" if failures == 0 else f"{failures} FAILURES")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
