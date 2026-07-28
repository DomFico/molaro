# molaro-mod
# name: param_scale
# kind: analysis
# produces: per-point-scalar
# axis: color
# param: gamma number 1.0
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — an even 0→1 ramp shaped by a `gamma` parameter (one file, reusable)

# THE TEMPLATE for `# param:`. A mod declares parameters in its header so ONE
# file is reusable without editing it. Each `# param: <name> <type> [<default>]`
# adds a value to `params` (type is number|string|boolean); a parameter WITH a
# default is optional, one WITHOUT is required. When any parameter is declared,
# compute takes a THIRD argument, `params` — a dict of the resolved, typed values.
#
# Invoke it from the terminal with `?key=value` after the target, e.g.
#   param_scale all ?gamma=2
# omit a parameter to take its default. The values pass through the invocation
# grammar, so a `?` inside a value must be quoted ("…") and a value cannot hold a
# double-quote.


def compute(data, target_indices, params):
    gamma = params["gamma"]  # a number (Python int or float) — the declared type
    n = max(len(target_indices) - 1, 1)
    # an even ramp across the resolved set by POSITION, bent by gamma: 1.0 is
    # linear, >1 pushes weight toward the high end, <1 toward the low. Values
    # stay in [0, 1] (per-point-scalar's contract), rendered through the built-in
    # red→magenta hue ramp.
    return [(i / n) ** gamma for i in range(len(target_indices))]
