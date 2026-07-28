# molaro-mod
# name: index_ramp
# kind: analysis
# produces: per-point-scalar
# axis: color
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — a normalized index ramp over the target

def compute(data, target_indices):
    """One value in [0, 1] per target index, in the given order.

    The simplest possible per-point-scalar mod: position in the resolved
    set, normalized. Proves the color path end to end.
    """
    n = max(len(target_indices) - 1, 1)
    return [i / n for i in range(len(target_indices))]
