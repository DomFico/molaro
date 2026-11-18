# molaro-mod
# name: toon
# kind: analysis
# produces: commands
# param: outline boolean true
# param: width number 1.5
# param: ink string #1a1a1a
# param: detail choice medium low high
# param: off boolean false
# description: Comic / cel-shaded look in one step — flat shading bands with a hard highlight (the `toon` style) on atoms, bonds and cartoon, plus black ink outlines. `toon` (whole scene) or `toon <target>` (style only that part; outlines are scene-wide). ?width=1.5 line thickness, ?ink=#1a1a1a line colour, ?detail=low|medium|high how many inner lines, ?outline=false bands only, ?off=true back to the normal look. Pastel colours suit it; `screenshot` keeps the lines at any resolution.

# The macro over two built-ins: the `toon` shading style (stylepoints /
# stylebonds / styletrace) and the scene-level `outline` pass. One undo stroke.


def _ranges(indices):
    """Compress atom indices into a `#`-list target: `#12-18,#40` (address.ts)."""
    ids = sorted(set(int(i) for i in indices))
    parts, i = [], 0
    while i < len(ids):
        j = i
        while j + 1 < len(ids) and ids[j + 1] == ids[j] + 1:
            j += 1
        parts.append(f"#{ids[i]}" if i == j else f"#{ids[i]}-{ids[j]}")
        i = j + 1
    return ",".join(parts)


def compute(data, target_indices, params):
    p = params or {}
    target = "all" if not target_indices else _ranges(target_indices)
    off = bool(p.get("off", False))
    style = "matte" if off else "toon"
    cmds = [f"stylepoints {target} {style}", f"stylebonds {target} {style}", f"styletrace {target} {style}"]
    if off:
        cmds.append("outline off")
        return cmds
    if bool(p.get("outline", True)):
        try:
            width = float(p.get("width", 1.5))
        except (TypeError, ValueError):
            raise ValueError(f'toon: width must be a number, got "{p.get("width")}".')
        ink = str(p.get("ink", "#1a1a1a")).strip() or "#1a1a1a"
        detail = str(p.get("detail", "medium"))
        cmds.append(f"outline on ?width={width:g} ?color={ink} ?detail={detail}")
    return cmds
