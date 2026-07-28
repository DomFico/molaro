# molaro-mod
# name: color_ab
# kind: analysis
# produces: commands
# author: Example Author
# source: https://github.com/DomFico/molaro
# description: synthetic example — a saved two-color look via colorbonds (one undo stroke)

def compute(data, target_indices):
    """A `produces: commands` mod: return a flat list[str] of command strings,
    run through the command path as ONE undo stroke.

    This one saves a reusable *look* — color alpha's bonds red and beta's bonds
    steel-blue, leaving everything else its normal color (a representation verb
    writes only its resolved set). It ignores target_indices (a commands mod
    may), so it re-runs identically on any system carrying these labels.

    Because compute() runs in the producer with the trajectory, a commands mod
    can also COMPUTE first and then emit commands — this example just returns
    static strings.
    """
    return [
        "colorbonds alpha.group-0.* red",
        "colorbonds beta.group-0.* steelblue",
    ]
