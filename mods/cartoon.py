# molaro-mod
# name: cartoon
# kind: analysis
# produces: commands
# requires-channel: ribbon_dir
# param: colorby choice chain ss rainbow bfactor plddt occupancy hydrophobicity sasa rmsf charge polarity flat
# param: color color auto
# param: style choice ribbon tube
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: The cartoon view — the backbone TRACE widened by each stretch's majority secondary structure and coloured by `?colorby`: `chain` (default; one hue per chain, shade per SS class), `ss` (PyMOL's cbss triple), `rainbow` (residue order per chain), `bfactor`, `plddt` (AlphaFold's four published bands; opt-in, never inferred), `occupancy`, `hydrophobicity`, `sasa`, `rmsf`, `charge`, `polarity`, `flat`. Continuous schemes share ONE diverging blue-white-red ramp, HIGH = RED. NUCLEIC residues are drawn too, at ONE uniform width — there is no DSSP for a nucleic acid and none is invented — so a protein/DNA complex gets one coherent picture with the widths carrying the protein's secondary structure and the nucleic backbone a plain cord. The four schemes that are AMINO-ACID concepts (`ss`, `hydrophobicity`, `charge`, `polarity`) colour the protein and leave the nucleic part unscored grey, and refuse outright when there is no protein to colour; the rest work on both. `?color=<c>` REPLACES a scheme's automatic variation — every chain that colour, classes as shades of it, a ramp white->it — and is refused, with a reason, on `plddt` and `rainbow`. `?style=ribbon` (default) binds `ribbon_dir` and draws oriented strips (protein: the carbonyl face; nucleic: the base-plane face); `?style=tube` draws round cords. The cross-section is SCENE-LEVEL, so a mixed complex cannot have protein ribbons and nucleic tubes at once — pick one for the whole picture. These colours are STATIC — one picture for the whole run; for colour that follows the trajectory, run `live_sasa` (or `live_ss`). Band widths are ANGSTROM globals at the top of the file. It writes the TRACE only — no atom, no bond, no camera.

import colorsys
import gzip
import math
import os
import numpy as np
import mdtraj as md
from collections import defaultdict

# ===========================================================================
#  EDIT ME — THE BAND GEOMETRY
#  Set once to taste, then left alone. Widths are FULL widths in ANGSTROM (not
#  radii, not size units): the mod inverts the scene's own bbox scale so the same
#  number gives the same PHYSICAL band on a 2 nm and a 20 nm system.
# ===========================================================================
HELIX_WIDTH_A = 2.2    # full width of a helix band, Angstrom (reference 2.0-2.4)
SHEET_WIDTH_A = 2.0    # full width of a strand band, Angstrom (reference 2.0)
COIL_WIDTH_A = 1.0     # full width of the loop cord, Angstrom (reference 0.4 —
                       #   deliberately wider: a ribbon strip's thickness is a
                       #   fixed fraction of its width, so 0.4 has no edge left)
NUCLEIC_WIDTH_A = 2.6  # full width of a NUCLEIC backbone cord, Angstrom — ONE width,
                       #   there being no DSSP for a nucleic acid. ABOVE the helix
                       #   band deliberately: at the coil width a duplex reads as a
                       #   loop, at a helix/sheet width it reads as protein SS, and
                       #   the object is 3.2x wider (re-measured on frame 0: 18.7 A
                       #   mean over the duplex's 12 Watson-Crick partner anchors vs
                       #   5.9 A across adk's longest helix, the widest anchor span
                       #   perpendicular to its own axis). Under the arrowhead flare.
TAPER = 0.5            # 0..1: how far a WIDE run's boundary residue drops toward
                       #   the narrower neighbour at a junction. 1 = the two
                       #   cross-sections match exactly (MolScript's rule).
ARROW_SCALE = 2.0      # a strand arrowhead's base as a MULTIPLE of SHEET_WIDTH_A
                       #   (ChimeraX arrowScale). 0 turns arrowheads off.
MIN_SS_RUN = 3         # a secondary-structure run shorter than this is ABSORBED
                       #   into its longer neighbour before any width is emitted
                       #   (a 1-residue "strand" is not a strand). 1 = off.

# ===========================================================================
#  EDIT ME — THE PALETTES
#  SS_FIXED, PLDDT_BANDS and the Kyte-Doolittle scale are PUBLISHED conventions,
#  each cited where it is defined below; changing one makes this mod's picture
#  disagree with every other viewer's, so change them knowing that.
# ===========================================================================
# `chain`, and `ss` under a `?color` — the shade each SS class takes of ONE hue.
# Coil < sheet < helix in lightness, so the three read dark -> mid -> bright; the
# coil keeps a moderate saturation because grey washes the hue out of the loops,
# and the loops are where you follow a chain end to end.
SS_SHADE = {
    "H": (0.85, 0.62),      # helix: bright, high-saturation   (saturation, lightness)
    "E": (0.80, 0.50),      # sheet: mid
    "C": (0.45, 0.40),      # coil: darker, moderate saturation
    "N": (0.75, 0.56),      # nucleic: ONE shade, between sheet and helix — it is not
                            #   one of the three SS classes and must not be read as
                            #   one, and its chain hue already tells it apart
}
# A LONE chain has nothing to be told apart from, so it takes one fixed hue rather
# than the degenerate 0/1 = red.
LONE_CHAIN_HUE = 0.58
# `ss` — PyMOL's `util.cbss` triple, at PyMOL's own full-intensity values.
SS_FIXED = {"H": "#ff0000", "E": "#ffff00", "C": "#00ff00"}
# `rainbow` — blue to red through cyan/green/yellow, PyMOL's `rainbow` spectrum.
RAINBOW_HUE_LO, RAINBOW_HUE_HI = 2.0 / 3.0, 0.0
# EVERY continuous scheme (`bfactor`, `sasa`, `rmsf`, `occupancy`) — one DIVERGING
# blue -> white -> red ramp, HIGH = RED: PyMOL's `spectrum b, blue_white_red`, the
# thing people mean by "B-factor colours". Diverging rather than single-hue so the
# ends differ in HUE and not only in lightness — measured, #0053d6 and #d60000 sit
# at hue 0.602 and 0.000 and contrast 6.55:1 and 5.44:1 against the white midpoint,
# where the single-hue blue ramp this replaced ran #1f3e5c -> #7ebffc, one hue.
DIVERGING_RAMP = ((0x00, 0x53, 0xD6), (0xFF, 0xFF, 0xFF), (0xD6, 0x00, 0x00))
# `plddt` — the AlphaFold DB legend, verbatim: >=90 dark blue, 70-90 light blue,
# 50-70 yellow, <50 orange. ABSOLUTE thresholds, which is the point of the scheme
# (a pLDDT is comparable between models; a B-factor is not).
PLDDT_BANDS = ((90.0, "#0053d6"), (70.0, "#65cbf3"), (50.0, "#ffdb13"), (None, "#ff7d45"))
PLDDT_LO, PLDDT_HI = 0.0, 100.0
# `hydrophobicity` — the Kyte & Doolittle index, J Mol Biol 157:105-132 (1982),
# verbatim, on a diverging ramp pinned at 0 (the scale's own neutral point). Already
# diverging, already high = red.
KYTE_DOOLITTLE = {
    "I": 4.5, "V": 4.2, "L": 3.8, "F": 2.8, "C": 2.5,
    "M": 1.9, "A": 1.8, "G": -0.4, "T": -0.7, "S": -0.8,
    "W": -0.9, "Y": -1.3, "P": -1.6, "H": -3.2, "E": -3.5,
    "Q": -3.5, "D": -3.5, "N": -3.5, "K": -3.9, "R": -4.5,
}
KD_LO, KD_HI = -4.5, 4.5
KD_RAMP = ((0x1E, 0x90, 0xFF), (0xFF, 0xFF, 0xFF), (0xFF, 0x45, 0x00))  # dodgerblue/white/orangered
# `charge` — POSITIVE blue, NEGATIVE red, neutral grey: the sign convention every
# molecular viewer uses. Dodgerblue is the KD ramp's own hydrophilic end (measured,
# #1e90ff both), so charge and hydrophobicity do not contradict each other.
CHARGE_COLOR = {1: "dodgerblue", 0: "#dcdcdc", -1: "crimson"}
# `polarity` — the four classes `_classify_sidechain` derives from the bond graph
# below. These colours ARE the KD ramp's two ends (measured, #1e90ff and #ff4500), so
# the two schemes never contradict each other. `charged` is a SUBSET of polar and
# takes a distinct hue so it is tellable from it.
POLARITY_COLOR = {
    "charged": "#c71585",       # mediumvioletred
    "polar": "#1e90ff",         # dodgerblue — the KD ramp's hydrophilic end
    "hydrophobic": "#ff4500",   # orangered  — the KD ramp's hydrophobic end
    "none": "#dcdcdc",          # no side chain (glycine-like): light grey
}
# `?color` — the two in-hue palettes it substitutes for the automatic variation.
TINT_LIGHT_LO, TINT_LIGHT_HI = 0.97, 0.42     # _tint: near-white at 0 to the
TINT_SAT_LO, TINT_SAT_HI = 0.15, 0.95         #   saturated hue at 1 (a ramp)
SHADE_LIGHT_LO, SHADE_LIGHT_HI = 0.24, 0.74   # _shades: n shades of one hue
SHADE_SAT_LO, SHADE_SAT_HI = 0.50, 0.95       #   (a categorical scheme)
# `flat` with `?color=auto` — the lone-chain hue at the sheet shade.
FLAT_DEFAULT_HUE = LONE_CHAIN_HUE
# Off-scale: a residue the scheme genuinely cannot score. NOT tinted by `?color` —
# grey has to keep meaning "no value here".
UNSCORED = "#707070"
# A continuous ramp is quantised to this many levels before emission, and the reason
# is command COUNT, not colour fidelity: one `colortrace` per DISTINCT colour means
# one command per residue on a continuous scalar. Lowering it trades colour steps
# for emitted lines, one for one.
RAMP_STEPS = 64
# The lowest size value this mod will EMIT, in size units — one pixel of full band
# width at the initial framing. The floor has to be on the EMITTED, QUANTISED
# number rather than on a width: `parseSize` takes 0 as a literal zero extent, so
# `tracesize … 0` draws nothing while the mod reports success.
MIN_EMITTED_SIZE = 1.0

# ---------------------------------------------------------------------------
# HONEST LIMITS — a reader who assumed the opposite would be misled.
#
# * `save_rep` CAPTURES ONLY the `shape traces` swap. Widths, colours and the
#   `ribbon_dir` BINDING are edge/trace-vertex state, not `#N`-addressable, and come
#   back as deferred warnings — and a ribbon with no orientation bound draws
#   NOTHING, so replaying such a rep leaves the trace invisible. Re-run this mod.
# * `plddt` IS NOT VALIDATED against real AlphaFold output: there is no AlphaFold
#   model in the corpus, only a hand-built fixture and the 0..100 range gate. That
#   gate is not a detector — a crystallographic B-factor passes it cleanly and gets
#   drawn in confidence bands — which is why the scheme is opt-in, never inferred.
# * `B = 0.00` MEANS UNSET, NOT COLDEST (a B-factor is 8*pi^2/3 times a mean-square
#   displacement, so zero is physically impossible; it is what a writer puts there
#   when it has nothing to write). Such a residue goes unscored grey, and a wholly
#   zero column refuses. OCCUPANCY keeps its zeros — 0.00 is a real measurement —
#   and refuses a CONSTANT column instead.
# * `bfactor` / `plddt` / `occupancy` RE-READ THE ORIGINAL TOPOLOGY FILE, because
#   mdtraj 1.11.1 discards both columns. The path is `data._topology_path`, a
#   PRIVATE producer attribute with no contract, and the file-row -> topology-atom
#   mapping is verified on count, residue number and element before any value is
#   used; a missing attribute, a format without the column and a failed check all
#   REFUSE with the reason named. (The proper fix is a public accessor, or these
#   columns carried as a channel — an engine ask.)
# * `?style=tube` IS ROUND IN CROSS-SECTION BUT ANGULAR IN PATH: the renderer's
#   Catmull-Rom path smoothing is ribbon-only, so the ribbon is the smoother curve
#   and the tube the angle-independent one. Either way the cross-section is
#   SCENE-LEVEL — one for the whole picture, so a round coil cannot coexist with a
#   flat sheet band, and on a MIXED protein/nucleic complex that is the real limit:
#   reference viewers draw a protein SS cartoon and a round nucleic tube AT THE SAME
#   TIME and `shape traces` cannot (per-target assignment is a parked chapter).
#   `?style=ribbon` gives a mixed scene one coherent look with the WIDTHS carrying
#   the protein secondary structure; `?style=tube` gives VMD's all-tube look at the
#   cost of the protein's flat faces.
# * A mod never learns which parameters you TYPED — `resolveParameters` fills
#   `?colorby=chain` whether you wrote it or not — so `cartoon ?color=red` means
#   `?colorby=chain ?color=red`: one red hue at the three SS shades, not one flat
#   red. For literally one colour, `cartoon ?colorby=flat ?color=red`.
# * A NUCLEIC RESIDUE THE PRODUCER THREADS INTO NO POLYLINE IS NOT DRAWN, and that
#   is the drawn-gate doing its job rather than a nucleic-specific hole: measured on
#   10GJ.cif, 293 of its 294 nucleic residues own a trace vertex and the odd one out
#   is the 8-oxoguanine, which the producer files under the `unknown` category. The
#   same gate is why 5DZT's bound AMP — a free nucleotide that passes the atom
#   signature — is never styled as nucleic: it owns no trace vertex.
# ---------------------------------------------------------------------------

# Scene-scale constants, mirrored from webview/geometry.ts (the renderer's single
# source): world-per-size k = FRAME_DISTANCE_FACTOR * S * tan(FOV/2) /
# NOMINAL_VIEWPORT_PX over the bbox's largest extent S, and a ribbon's FULL width is
# 2*k*size. _DEFAULT_SCENE_EXTENT_NM is the renderer's own bbox-less fallback
# (geometry.DEFAULT_SCENE_BOX is [-10,10]^3), so a header with no bbox — bbox is
# Optional in the contract — calibrates to the SAME k the renderer will use;
# _CALIBRATION_EXTENT_NM is adk's extent, a belt used only if the units are not nm,
# where a physical width cannot be derived at all.
_FRAME_DISTANCE_FACTOR = 1.6
_CAMERA_FOV_DEG = 50.0
_NOMINAL_VIEWPORT_PX = 720.0
_DEFAULT_SCENE_EXTENT_NM = 20.0
_CALIBRATION_EXTENT_NM = 6.063388
# Shrake-Rupley cost budget, in atoms^2 x frames: it caps how many frames the mean is
# taken over, keeping the run inside the producer's 5 s mod budget. atoms^2 is a
# PESSIMISTIC ceiling, NOT a scaling law — re-measured the real cost is near-LINEAR
# (log-log slope 1.05 over 758..21616 biopolymer atoms), so this over-charges and
# subsamples harder than it must: adk takes 44 of its 98 frames, 10GJ 3, the membrane
# 1. (`sasa_field` cannot subsample at all, so it MEASURES instead of modelling.)
SASA_N2_BUDGET = 5.0e8

# The full CSS colour vocabulary the viewer's own `parseColor` accepts
# (webview/commands.ts CSS_COLOR_DATA), copied VERBATIM as data so `?color`
# accepts exactly what a `colortrace` command would. TWO LISTS THAT MUST AGREE
# and this file cannot check it itself: the verification harness extracts
# CSS_COLOR_DATA from commands.ts and asserts the two strings are equal.
_CSS_COLOR_DATA = (
    "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,"
    "blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,"
    "cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,"
    "darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,"
    "darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,"
    "dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,"
    "ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,"
    "indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,"
    "lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,"
    "lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,"
    "lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,"
    "mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,"
    "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,"
    "orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,"
    "peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,"
    "royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,"
    "slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,"
    "tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32"
)
_CSS_COLORS = dict(pair.split(":") for pair in _CSS_COLOR_DATA.split(","))

# TWO LISTS THAT MUST AGREE and the mod cannot check the other one: this tuple and
# the option list on the `# param: colorby choice …` header line (the header is
# what the viewer's parser reads; this tuple is what a RAW caller is checked
# against). Keep them identical, `chain` first.
SCHEMES = (
    "chain", "ss", "rainbow", "bfactor", "plddt", "occupancy",
    "hydrophobicity", "sasa", "rmsf", "charge", "polarity", "flat",
)
STYLES = ("ribbon", "tube")
# `?color` means "use THIS colour" — it replaces the scheme's automatic hue
# variation. Two schemes cannot honour that at all, and say so rather than
# ignoring the parameter.
_COLOR_REFUSAL = {
    "plddt": "the four AlphaFold confidence bands are the AlphaFold DB's own "
             "published colours and those four colours ARE the meaning of the "
             "scheme — recolouring them would produce a picture that looks like "
             "a pLDDT figure and is not one",
    "rainbow": "rainbow is a full blue-to-red spectrum BY DEFINITION, so asking "
               "for one colour is a contradiction — pin the hue and there is "
               "nothing left of the scheme",
}
# What to do instead, per refusing scheme.
_COLOR_INSTEAD = {
    "plddt": "Drop ?color to get the real bands, or — if what you want is that "
             "same column ramped in your own colour — `cartoon ?colorby=bfactor "
             "?color={c}`, which is honest about being a temperature-factor ramp.",
    "rainbow": "For one colour over the whole trace use `cartoon ?colorby=flat "
               "?color={c}`; for one colour that still shows secondary structure, "
               "`cartoon ?colorby=ss ?color={c}`. Drop ?color to keep the "
               "spectrum.",
}
# Rank ordering inside a chain, so the emitted colortrace lines come out coil,
# sheet, helix, then nucleic.
_CLASS_RANK = {"C": 0, "E": 1, "H": 2, "N": 3}
# The class code a NUCLEIC residue carries all the way through: width, shade, rank.
NUCLEIC_CLASS = "N"
# The four schemes that are AMINO-ACID concepts, and WHY each cannot score a
# nucleotide. On a mixed target they colour the protein and leave the nucleic part
# UNSCORED grey — the same grey this file already uses for "no value here"; with no
# protein to colour they refuse outright, carrying the matching reason.
_PROTEIN_ONLY_WHY = {
    "ss": "DSSP assigns secondary structure from the PEPTIDE backbone's hydrogen "
          "bonds and there is no such classification for a nucleic acid — the "
          "A/B/Z forms and a sugar pucker are a different vocabulary this mod "
          "does not compute",
    "hydrophobicity": "the Kyte-Doolittle index is a scale over the 20 standard "
                      "AMINO ACIDS and a nucleotide is not on it",
    "charge": "this scheme's charge is the formal SIDE-CHAIN charge of an amino "
              "acid at pH 7; a nucleotide's charge lives on its backbone "
              "phosphate, which is a different quantity and not this one",
    "polarity": "polar / hydrophobic / charged are AMINO-ACID side-chain classes",
}
_NUCLEIC_SCHEMES_HINT = ("On a nucleic backbone use ?colorby=chain, rainbow, "
                         "bfactor, plddt, occupancy, sasa, rmsf or flat.")
# Sorts every off-scale bucket last.
_UNSCORED_RANK = 1.0e9

# --- charge: the formal SIDE-CHAIN charge at pH 7, by residue identity ---------
CHARGE_BY_CODE = {"D": -1, "E": -1, "K": 1, "R": 1}
STANDARD_AA_NAMES = frozenset(
    "ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP "
    "TYR VAL".split()
)
PROTONATION_CHARGE = {
    "ASH": 0, "GLH": 0,                      # protonated carboxylate: neutral
    "LYN": 0, "ARN": 0,                      # deprotonated amine: neutral
    "CYM": -1,                               # thiolate
    "TYM": -1,                               # tyrosinate
}
CODE_ALIAS = {
    "CYM": "C",
    "ASH": "D", "GLH": "E", "LYN": "K", "ARN": "R", "TYM": "Y",
}

# --- polarity: the side-chain classes, derived from the BOND GRAPH -------------
# The protein main chain BY ATOM NAME, because a side-chain split cannot be derived
# from elements alone.
# C-term carboxyl aliases: AMBER/PDB OXT, CHARMM OT1/OT2/OT, GROMACS OC1/OC2.
_PROTEIN_MAIN = frozenset({
    "N", "CA", "C", "O", "OXT", "OT", "OT1", "OT2", "OC1", "OC2",
})

# --- nucleic membership: the ATOM SIGNATURE ------------------------------------
# Derived from the ATOMS, not from mdtraj's 48-name nucleic table, and the reason is
# not fastidiousness: that table has neither CHARMM's GUA/ADE/CYT/THY/URA nor
# AMBER's RA/RG/RC/RU, and it types 8-oxoguanine as non-nucleic (measured on
# 10GJ.cif: mdtraj 293 nucleic residues, the atom signature 294). A (name, element)
# signature — the sugar's two main-chain carbons in either spelling, plus at least
# ONE phosphodiester link atom, because a 5'-TERMINAL RESIDUE HAS NO P and must not
# be dropped (measured on the duplex: 22 of its 24 residues carry a P, and the two
# 5' ends are anchored on C4' instead — all 24 are drawn).
_SUGAR_SIG = (("C4'", "C"), ("C3'", "C"))
_SUGAR_SIG_STAR = (("C4*", "C"), ("C3*", "C"))
_LINK_SIG = (("P", "P"), ("O3'", "O"), ("O5'", "O"), ("O3*", "O"), ("O5*", "O"))


def _named(by_name, sig):
    """The atoms matching a (name, element) signature, or None if any is absent or
    carries the WRONG element — a name alone cannot vouch for an atom. An atom with no
    element at all passes the element half; the topology is not second-guessed."""
    got = []
    for nm, sym in sig:
        a = by_name.get(nm)
        if a is None:
            return None
        e = _elem(a)
        if e and e != sym:
            return None
        got.append(a)
    return got


def _nucleic_residues(top, candidates, pairs):
    """Which of `candidates` (residue indices) carry a NUCLEOTIDE main chain.

    SCOPED on purpose: the caller passes exactly the residues that own a trace vertex
    and are not already protein, since a residue this mod will not draw cannot change
    what it emits. That scoping is what keeps the default protein path free of new
    work — on adk, 5DZT, 1b0c and the membrane the candidate set is EMPTY and this
    returns before touching a bond.

    The BOND BELT (consecutive signature atoms bonded to each other) is kept over an
    adjacency map restricted to the candidates, and skipped for a residue with no
    internal bonds at all: a bond-free topology can only be judged on names.

    `pairs` is the DRAWN edge set, not `top.bonds` (see `_drawn_bonds`), so a residue
    whose bonds only exist because inference found them is judged on its real graph
    rather than scored as bondless.

    MEASURED limit, so nobody re-derives it: this does NOT rescue a modified base.
    10GJ's 8OG13 has 23 atoms and a P, but mdtraj reports `is_nucleic` False, so
    `domain_rules.trace_anchor_indices` gives it no anchor, it owns no trace vertex,
    and it never reaches `candidates` at all — the gate is upstream of this bond
    belt, not in it."""
    if not candidates:
        return set()
    own_all = set()
    for r in candidates:
        own_all.update(a.index for a in top.residue(r).atoms)
    adj = {i: set() for i in own_all}
    for i, j in pairs:
        if i in adj and j in adj:
            adj[i].add(j)
            adj[j].add(i)
    out = set()
    for r in candidates:
        res = top.residue(r)
        own = frozenset(a.index for a in res.atoms)
        has_internal = any(n in own for i in own for n in adj[i])
        by = {}
        for a in res.atoms:
            by.setdefault(a.name, a)
        if not any(_named(by, (link,)) for link in _LINK_SIG):
            continue
        for sugar in (_SUGAR_SIG, _SUGAR_SIG_STAR):
            pair = _named(by, sugar)
            if pair is None:
                continue
            if has_internal and not all(
                    pair[k + 1].index in adj[pair[k].index] for k in range(len(pair) - 1)):
                continue
            out.add(r)
            break
    return out


def _angstrom_per_size_unit(header) -> float:
    """FULL band width in Angstrom per stored size unit, for this scene."""
    if header.units == "nm":
        bbox = header.bbox                      # Optional in the contract
        if bbox is None:
            extent = _DEFAULT_SCENE_EXTENT_NM
        else:
            extent = max(bbox.max[i] - bbox.min[i] for i in range(3))
    else:
        extent = _CALIBRATION_EXTENT_NM
    extent = max(float(extent), 1e-3)           # the renderer's own floor
    k_nm = (
        _FRAME_DISTANCE_FACTOR * extent
        * math.tan(math.radians(_CAMERA_FOV_DEG / 2.0))
        / _NOMINAL_VIEWPORT_PX
    )
    return 2.0 * k_nm * 10.0                    # full width (2*k), nm -> Angstrom


# ============================== colour helpers ==============================
def _hex_rgb(r, g, b) -> str:
    """0..1 floats -> #rrggbb, clamped."""
    def q(v):
        n = int(round(float(v) * 255.0))
        return 0 if n < 0 else (255 if n > 255 else n)
    return "#{:02x}{:02x}{:02x}".format(q(r), q(g), q(b))


def _hex_hls(h, s, ll) -> str:
    r, g, b = colorsys.hls_to_rgb(h % 1.0, ll, s)   # colorsys is (h, l, s)
    return _hex_rgb(r, g, b)


def _parse_color(token):
    """A colour token -> (r, g, b) in 0..1, or None. Mirrors the viewer's parseColor:
    a CSS name from the table above, or #rgb / #rrggbb."""
    t = str(token).strip().lower()
    if t.startswith("#"):
        body = t[1:]
        if len(body) == 3 and all(c in "0123456789abcdef" for c in body):
            body = "".join(c * 2 for c in body)
        elif not (len(body) == 6 and all(c in "0123456789abcdef" for c in body)):
            return None
    else:
        body = _CSS_COLORS.get(t)
        if body is None:
            return None
    return (int(body[0:2], 16) / 255.0, int(body[2:4], 16) / 255.0,
            int(body[4:6], 16) / 255.0)


def _clamp01(t) -> float:
    t = float(t)
    return 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)


def _three_stop(t, stops) -> str:
    """t in [0,1] -> hex on a three-stop ramp (0.5 = the middle stop). `stops` is
    three (r, g, b) triples of 0..255 ints."""
    t = _clamp01(t)
    lo, mid, hi = stops
    if t <= 0.5:
        a, b, u = lo, mid, t / 0.5
    else:
        a, b, u = mid, hi, (t - 0.5) / 0.5
    return "#{:02x}{:02x}{:02x}".format(
        *(int(round(a[k] + (b[k] - a[k]) * u)) for k in range(3))
    )


def _tint(t, hue) -> str:
    """t in [0,1] -> near-white at 0, the given hue saturated at 1. The in-hue
    substitute for the diverging ramp when `?color` pins the hue."""
    t = _clamp01(t)
    return _hex_hls(
        hue,
        TINT_SAT_LO + (TINT_SAT_HI - TINT_SAT_LO) * t,
        TINT_LIGHT_LO + (TINT_LIGHT_HI - TINT_LIGHT_LO) * t,
    )


def _shades(hue, n):
    """n distinguishable shades of ONE hue, darkest and least saturated first.
    The in-hue substitute for a categorical palette when `?color` pins the hue;
    a class's index is its own scheme's rank, so the emitted order is unchanged."""
    if n <= 1:
        return [_hex_hls(hue, SHADE_SAT_HI,
                         0.5 * (SHADE_LIGHT_LO + SHADE_LIGHT_HI))]
    return [_hex_hls(hue,
                     SHADE_SAT_LO + (SHADE_SAT_HI - SHADE_SAT_LO) * i / (n - 1.0),
                     SHADE_LIGHT_LO + (SHADE_LIGHT_HI - SHADE_LIGHT_LO) * i / (n - 1.0))
            for i in range(n)]


def _quantise(t):
    """t in [0,1] -> (level, t_at_level). Bounds the emitted command count."""
    lev = int(round(_clamp01(t) * (RAMP_STEPS - 1)))
    return lev, lev / float(RAMP_STEPS - 1)


# ============================== SS run structure ==============================
def _class_runs(codes):
    """[(code, start, stop)] for each maximal run of equal codes."""
    out = []
    start = 0
    for i in range(1, len(codes) + 1):
        if i == len(codes) or codes[i] != codes[start]:
            out.append((codes[start], start, i))
            start = i
    return out


def _absorb_short_runs(codes, min_len):
    """Fold every run shorter than `min_len` into its LONGER neighbour (tie: the
    preceding run), repeatedly. Terminates: each pass merges one run away.

    Emitted literally, DSSP's short bursts pinch the band from the helix width to
    the coil cord and back over one ~3.8 A step, which reads as beads on a string.
    The absorbed residues take the neighbour's SS CLASS too, so colour and width
    never disagree."""
    codes = list(codes)
    if min_len <= 1:
        return codes
    while True:
        runs = _class_runs(codes)
        if len(runs) <= 1:
            return codes
        short = [(i, r) for i, r in enumerate(runs) if (r[2] - r[1]) < min_len]
        if not short:
            return codes
        i, (_code, s, e) = min(short, key=lambda t: (t[1][2] - t[1][1], t[0]))
        prev = runs[i - 1] if i > 0 else None
        nxt = runs[i + 1] if i + 1 < len(runs) else None
        if prev is None:
            take = nxt[0]
        elif nxt is None:
            take = prev[0]
        else:
            take = prev[0] if (prev[2] - prev[1]) >= (nxt[2] - nxt[1]) else nxt[0]
        for k in range(s, e):
            codes[k] = take


def _kind_segments(codes):
    """[(start, stop)] splitting one polyline's codes at every PROTEIN/NUCLEIC
    boundary, because the run machinery must not reach across one: a 2-residue
    peptide fragment must not be absorbed into a nucleic run and a strand arrowhead
    must not point into one. Every polyline in this corpus is single-kind (measured
    on all twelve systems, the mixed 10GJ.cif included), so a protein-only scene
    takes ONE segment and the arithmetic is unchanged."""
    keys = [(NUCLEIC_CLASS if c == NUCLEIC_CLASS else "P") for c in codes]
    out, start = [], 0
    for i in range(1, len(keys) + 1):
        if i == len(keys) or keys[i] != keys[start]:
            out.append((start, i))
            start = i
    return out


def _band_widths(codes, width_A, taper, arrow):
    """One same-kind stretch of trace vertices -> (codes after absorption, width per
    vertex). Absorb short runs, taper each width junction, flare each strand's
    C-terminal arrowhead."""
    codes = _absorb_short_runs(codes, int(MIN_SS_RUN))
    w = [width_A[c] for c in codes]
    runs = _class_runs(codes)
    # TAPER: at every junction between runs of different width, the WIDER side's
    # boundary residue drops `taper` of the way down to the narrower width,
    # spreading the change over two segments.
    for i in range(len(runs) - 1):
        _ca, sa, ea = runs[i]
        _cb, sb, eb = runs[i + 1]
        wa, wb = width_A[_ca], width_A[_cb]
        if wa == wb:
            continue
        lo, hi = min(wa, wb), max(wa, wb)
        edge = hi - taper * (hi - lo)
        if wa > wb and (ea - sa) >= 3:
            w[ea - 1] = edge
        elif wb > wa and (eb - sb) >= 3:
            w[sb] = edge
    # ARROWHEAD on each strand run's C-terminal end (the polyline threads residues
    # N->C): flared base at the second-to-last residue, narrowing at the last to the
    # COIL width — not to zero, which would pinch right after the point. Three
    # guards: a run of >= 4, so the flare cannot reach outside the run and a tapered
    # run still has a body left, and a NARROWER following run, because an arrowhead
    # needs somewhere narrow to point into.
    if arrow > 0.0:
        for i, (code, s, e) in enumerate(runs):
            if code != "E" or (e - s) < 4:
                continue
            nxt = runs[i + 1] if i + 1 < len(runs) else None
            if nxt is not None and width_A[nxt[0]] >= width_A["E"]:
                continue
            w[e - 2] = arrow * width_A["E"]
            w[e - 1] = width_A["C"]
    return codes, w


# ======================= the topology file's own columns =======================
_PDB_EXTS = (".pdb", ".ent", ".pdb1")
_CIF_EXTS = (".cif", ".mmcif")


def _cif_tokens(line):
    """One mmCIF loop row -> its tokens, honouring quotes (O5' is routinely quoted)."""
    out, cur, quote = [], "", None
    for ch in line:
        if quote is not None:
            if ch == quote:
                out.append(cur)
                cur = ""
                quote = None
            else:
                cur += ch
        elif ch in "'\"":
            quote = ch
        elif ch.isspace():
            if cur:
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _read_atom_records(path):
    """The topology FILE's atom records, in file order, first MODEL only, as
    [(resseq_token, element_or_None, occupancy_or_None, bfactor_or_None)].

    Handles the two forms that carry the columns at all: PDB fixed columns
    (occupancy 55-60, tempFactor 61-66, element 77-78, resSeq 23-26) and mmCIF's
    `_atom_site` loop by header name. Returns None for a format that has no such
    column, so the caller can refuse with the format named."""
    lower = path.lower()
    if lower.endswith(".gz"):
        lower = lower[:-3]
    opener = (lambda p: gzip.open(p, "rt", errors="replace")) if path.lower().endswith(".gz") \
        else (lambda p: open(p, "r", errors="replace"))

    if lower.endswith(_PDB_EXTS):
        rows = []
        with opener(path) as fh:
            for line in fh:
                if line.startswith("ENDMDL"):
                    break
                if not line.startswith(("ATOM  ", "HETATM")):
                    continue

                def num(a, b):
                    try:
                        return float(line[a:b])
                    except (ValueError, IndexError):
                        return None
                elem = line[76:78].strip() or None
                rows.append((line[22:26].strip(), elem, num(54, 60), num(60, 66)))
        return rows

    if lower.endswith(_CIF_EXTS):
        cols, ncol, in_loop, model0, rows = {}, 0, False, None, []
        with opener(path) as fh:
            for line in fh:
                s = line.strip()
                if s.startswith("_atom_site."):
                    cols[s.split(".", 1)[1]] = ncol
                    ncol += 1
                    in_loop = True
                    continue
                if in_loop and s.startswith(("ATOM", "HETATM")):
                    tok = _cif_tokens(line)
                    if len(tok) < ncol:
                        continue
                    mi = cols.get("pdbx_PDB_model_num")
                    if mi is not None:
                        if model0 is None:
                            model0 = tok[mi]
                        elif tok[mi] != model0:
                            continue

                    def get(key):
                        i = cols.get(key)
                        return tok[i] if i is not None else None

                    def fnum(key):
                        try:
                            return float(get(key))
                        except (TypeError, ValueError):
                            return None
                    seq = get("auth_seq_id") or get("label_seq_id") or ""
                    rows.append((str(seq).strip(), (get("type_symbol") or "").strip() or None,
                                 fnum("occupancy"), fnum("B_iso_or_equiv")))
                elif in_loop and rows and s and not s.startswith(("ATOM", "HETATM", "#", "_atom_site")):
                    break
        return rows

    return None


_COLUMN_SLOT = {"occupancy": 2, "bfactor": 3}


def _topology_column(data, top, which, scheme):
    """[float or None] per TOPOLOGY atom index, read out of the original topology
    file. Refuses — loudly, with the reason — rather than guessing.

    The file-row -> topology-atom mapping is VERIFIED on count, residue number and
    element. The atom NAME and the CHAIN ID are deliberately not used as keys:
    mdtraj rewrites atom names on load (OH2 -> O, HN -> H, HB1 -> HB3 …) and its
    mmCIF reader regroups hetero entities into chains of its own, so either gate
    would refuse the very files that carry the data."""
    path = getattr(data, "_topology_path", None)
    if not path or not isinstance(path, str) or not os.path.exists(path):
        raise ValueError(
            f"cartoon ?colorby={scheme}: mdtraj discards the {which} column at "
            "load (there is no such attribute on Atom, on Trajectory, or in "
            "topology.to_dataframe()), so this scheme has to re-read the "
            "original topology file — and this dataset does not offer one "
            "(data._topology_path is "
            f"{'missing' if not path else 'not a readable path: ' + str(path)}). "
            "The synthetic source and any source not built from a file land here. "
            "Use ?colorby=chain, ss, rainbow, hydrophobicity, sasa, rmsf, charge "
            "or polarity, none of which need the file."
        )
    rows = _read_atom_records(path)
    if rows is None:
        raise ValueError(
            f"cartoon ?colorby={scheme}: the {which} column lives in a PDB or "
            f"mmCIF atom record, and this dataset's topology is "
            f"{os.path.basename(path)} — a format that carries no such column. "
            "A PSF, PRMTOP, GRO or TOP topology simply does not have it."
        )
    if len(rows) != top.n_atoms:
        raise ValueError(
            f"cartoon ?colorby={scheme}: refusing to map "
            f"{os.path.basename(path)}'s {len(rows)} atom records onto the "
            f"topology's {top.n_atoms} atoms — the counts must match for the "
            "mapping to mean anything, and painting real numbers onto the wrong "
            "residues would look perfectly plausible. (Alternate locations, a "
            "multi-model file the reader merges, or an added hydrogen would all "
            "do this.)"
        )
    atoms = list(top.atoms)
    for i, (seq, elem, _occ, _b) in enumerate(rows):
        a = atoms[i]
        if seq != str(a.residue.resSeq):
            raise ValueError(
                f"cartoon ?colorby={scheme}: refusing to map "
                f"{os.path.basename(path)} onto the loaded topology — record "
                f"{i + 1} sits in residue {seq!r} in the file and in residue "
                f"{a.residue.resSeq} ({a.residue.name}) in the topology, so the "
                "two are not in the same order and every value past here would "
                "be attributed to the wrong residue."
            )
        if elem:
            mine = (a.element.symbol if a.element is not None else "") or ""
            if mine.upper() != elem.upper():
                raise ValueError(
                    f"cartoon ?colorby={scheme}: refusing to map "
                    f"{os.path.basename(path)} onto the loaded topology — record "
                    f"{i + 1} is element {elem!r} in the file and {mine!r} in the "
                    "topology."
                )
    slot = _COLUMN_SLOT[which]
    return [r[slot] for r in rows]


def _residue_mean_column(values, top, ridxs, which, scheme, path_hint, zero_is_unset):
    """residue index -> the MEAN of `values` over that residue's atoms that carry one;
    a residue with none is ABSENT and the caller paints it the unscored grey.
    `zero_is_unset` is the B-factor asymmetry — see HONEST LIMITS."""
    out = {}
    for r in ridxs:
        vs = [values[a.index] for a in top.residue(r).atoms
              if values[a.index] is not None
              and not (zero_is_unset and values[a.index] == 0.0)]
        if vs:
            out[r] = float(sum(vs)) / len(vs)
    if not out:
        raise ValueError(
            f"cartoon ?colorby={scheme}: this topology carries no {which} "
            f"information — not one of the {len(ridxs)} residues this would draw "
            f"has a {which} value" + (" (every one is exactly 0.00, which is what "
            "a writer puts in the column when it has nothing to put there — a "
            "B-factor of zero is not a physical value)" if zero_is_unset else "")
            + f". {path_hint} is where the column comes from. Colouring by a "
            "blank would be one flat colour reported as a measurement, so "
            "nothing was drawn."
        )
    return out


def _refuse_constant(value_of, which, scheme, path_hint):
    """A column that IS present but holds one single value carries no gradient,
    and a one-colour ramp reported as a measurement is the same lie."""
    lo, hi = min(value_of.values()), max(value_of.values())
    if hi - lo <= 0.0:
        raise ValueError(
            f"cartoon ?colorby={scheme}: this topology's {which} column is "
            f"CONSTANT — every one of the {len(value_of)} drawn residues that "
            f"carries a value has {which} exactly {lo:g} ({path_hint}). There is "
            "no gradient to draw, and one flat colour reported as a measurement "
            "is not an answer, so nothing was drawn."
        )


# ============================ per-residue chemistry ============================
def _drawn_bonds(data, top):
    """The connectivity the viewer actually DRAWS, as (i, j) index pairs.

    `data.edges` is the header's edge list — the topology's own declared bonds PLUS
    whatever covalent-radius inference added (producer/bond_inference.py), minus the
    cross-box pairs the periodic cutoff drops. `top.bonds` is only "what the file
    said", and the two now disagree by a lot: on the membrane the topology declares
    50,495 bonds while the viewer draws 173,940, and on a bondless custom residue
    (ABU, DHBR, DALA, DMPC, ADP, TPO) `top.bonds` has NOTHING. Every chemistry
    judgement below — bonded-hydrogen counts, side-chain adjacency, the nucleic bond
    belt — was silently reading the smaller set and scoring those residues as if
    they had no bonds.

    Falls back to `top.bonds` for a RAW caller whose `data` predates the accessor,
    the same way `params=None` is tolerated in `compute`."""
    view = getattr(data, "edges", None)
    if view is None:
        return [(b[0].index, b[1].index) for b in top.bonds]
    return [(int(i), int(j)) for i, j in view]


def _bonded_hydrogen_counts(top, pairs):
    """atom index -> bonded hydrogen count, in ONE pass (a residue exposes no bonds)."""
    counts = {}
    for i, j in pairs:
        a1, a2 = top.atom(i), top.atom(j)
        for heavy, other in ((a1, a2), (a2, a1)):
            e = other.element
            if e is not None and (e.symbol or "").upper() == "H":
                counts[heavy.index] = counts.get(heavy.index, 0) + 1
    return counts


def _adjacency(top, pairs):
    adj = {a.index: set() for a in top.atoms}
    for i, j in pairs:
        adj[i].add(j)
        adj[j].add(i)
    return adj


def _aa_code(res):
    """One-letter amino-acid code, or None. CODE_ALIAS is consulted BEFORE
    `res.is_protein` because mdtraj's protein table contains neither ASH nor ARN nor
    TYM; `is_protein` is then load-bearing because a nucleic DC/DG residue also has a
    `.code`."""
    name = (res.name or "").strip().upper()
    if name in CODE_ALIAS:
        return CODE_ALIAS[name]
    if not res.is_protein:
        return None
    code = res.code
    return code if code else None


def _histidine_charge(res, h_counts):
    """A histidine's charge from its own PROTONS, because every mdtraj reader rewrites
    HSD/HSE/HSP/HID/HIE/HIP to plain HIS and no protonation NAME survives. Two H on
    the ring nitrogens -> +1, one or none -> 0."""
    n_h = 0
    for a in res.atoms:
        e = a.element
        if e is None or (e.symbol or "").upper() != "N":
            continue
        if (a.name or "").strip().upper() == "N":
            continue                             # the backbone amide nitrogen
        n_h += h_counts.get(a.index, 0)
    return 1 if n_h >= 2 else 0


def _formal_charge(res, h_counts):
    """Formal side-chain charge at pH 7.0, restricted to what a protein trace can hold,
    or None when the residue is off-scale. Termini are NOT charged — that charge
    belongs to atoms, not to a residue identity."""
    name = (res.name or "").strip().upper()
    if name in PROTONATION_CHARGE:
        return PROTONATION_CHARGE[name]
    if res.is_protein:
        if name == "HIS":
            return _histidine_charge(res, h_counts)
        if name not in STANDARD_AA_NAMES:
            # A cap (ACE/NME), a modified residue (SEP/TPO/PTR/MSE), or a name
            # nobody here recognises. Unscored rather than scored as its parent:
            # a formal charge is an exact claim and a phosphoserine's is -2.
            return None
        code = _aa_code(res)
        if code is None:
            return None
        return CHARGE_BY_CODE.get(code, 0)
    return None


def _is_hydrogen(atom):
    e = atom.element
    if e is not None:
        return (e.symbol or "").upper() == "H"
    return (atom.name or "").strip().upper().startswith("H")


def _elem(atom):
    e = atom.element
    return ((e.symbol or "").strip().upper() if e is not None else "")


def _split_sidechain(res, adj, xyz0):
    """(main chain, side chain) for one PROTEIN residue.
    backbone = the named main-chain atoms + every hydrogen BONDED to one (from the
    bond graph — an H's name is not trusted); side chain = the complement. An ORPHAN
    hydrogen with no bond at all goes to its nearest heavy atom in its own residue at
    frame 0, which fills a hole in the graph and never overrides it."""
    heavy_main = {a.index for a in res.atoms if a.name in _PROTEIN_MAIN}
    back = set(heavy_main)
    orphans = []
    for a in res.atoms:
        if a.index in back or not _is_hydrogen(a):
            continue
        if adj[a.index]:
            if any(n in heavy_main for n in adj[a.index]):
                back.add(a.index)
        else:
            orphans.append(a.index)
    if orphans and xyz0 is not None:
        heavy = [a.index for a in res.atoms if not _is_hydrogen(a)]
        if heavy:
            hv = np.asarray(heavy, dtype=int)
            for hidx in orphans:
                d = np.linalg.norm(xyz0[hv] - xyz0[hidx], axis=1)
                if int(hv[int(np.argmin(d))]) in heavy_main:
                    back.add(hidx)
    side = [a.index for a in res.atoms if a.index not in back]
    return back, side


def _sidechain_ring(top, side_set, adj):
    """The side-chain heavy atoms on a ring, found by peeling atoms with fewer than
    two neighbours INSIDE the side chain.
    Restricting the graph to the side chain excludes PROLINE for free — its
    pyrrolidine closes through the main-chain N and CA."""
    alive = {i for i in side_set if not _is_hydrogen(top.atom(i))}
    changed = True
    while changed:
        changed = False
        for a in list(alive):
            if sum(1 for b in adj[a] if b in alive) <= 1:
                alive.discard(a)
                changed = True
    return alive


def _is_stub(top, side, h_count):
    """Is this side chain a TRUNCATION rather than a whole side chain? The test is
    VALENCE, not a residue table — a complete alkyl fragment of n carbons carries
    2n+1 hydrogens."""
    heavy = [i for i in side if not _is_hydrogen(top.atom(i))]
    if not heavy or len(heavy) > 2:
        return False
    if any(_elem(top.atom(i)) != "C" for i in heavy):
        return False
    return sum(h_count.get(i, 0) for i in heavy) < 2 * len(heavy) + 1


def _classify_sidechain(top, side, adj, h_count):
    """(polar, charged, aromatic, n_heavy) for ONE residue, from the bond graph.
    `hydrophobic` is deliberately NOT returned — it is exactly "has a side chain and
    is not polar", derived by the caller AFTER the truncation
    repair so the two cannot drift apart. The explicit-hydrogen test is PER SIDE
    CHAIN, which is a correctness fix, not a refinement: asked globally, a solvated
    crystal structure (waters with hydrogens, protein without) takes the
    with-hydrogens path and then loses every lysine."""
    side_set = set(side)
    n_heavy = sum(1 for i in side if not _is_hydrogen(top.atom(i)))
    if not side:
        return False, False, False, 0        # no side chain (glycine-like)
    has_H = any(_is_hydrogen(top.atom(i)) for i in side)
    syms = [_elem(top.atom(i)) for i in side]
    polar = any(s in ("N", "O") for s in syms)
    charged = False

    def heavy_nbrs(i):
        return [n for n in adj[i] if not _is_hydrogen(top.atom(n))]

    for i in side:
        sym = _elem(top.atom(i))
        if sym == "C":
            nbrs = heavy_nbrs(i)
            oxys = [n for n in nbrs if _elem(top.atom(n)) == "O"]
            nits = [n for n in nbrs if _elem(top.atom(n)) == "N"]
            # carboxylate: two terminal oxygens, neither protonated
            if (len(oxys) == 2
                    and all(len(heavy_nbrs(o)) == 1 for o in oxys)
                    and (not has_H or all(h_count.get(o, 0) == 0 for o in oxys))):
                charged = True
                break
            # guanidinium: three nitrogens on one carbon
            if len(nits) >= 3:
                charged = True
                break
        elif sym == "N":
            nbrs = heavy_nbrs(i)
            # primary ammonium: one heavy neighbour, an aliphatic carbon
            if len(nbrs) == 1 and _elem(top.atom(nbrs[0])) == "C":
                others = [n for n in heavy_nbrs(nbrs[0]) if n != i]
                if (all(_elem(top.atom(n)) == "C" for n in others)
                        and (not has_H or h_count.get(i, 0) >= 3)):
                    charged = True
                    break
    ring = _sidechain_ring(top, side_set, adj)
    aromatic = len(ring) >= 3
    if not charged and has_H:
        # imidazolium: every nitrogen in a side-chain ring carries an H. Catches a
        # doubly-protonated histidine whatever the force field named it.
        ring_n = [i for i in ring if _elem(top.atom(i)) == "N"]
        if len(ring_n) >= 2 and all(h_count.get(i, 0) >= 1 for i in ring_n):
            charged = True
    return polar, charged, aromatic, n_heavy


def _polarity_classes(top, protein_residues, adj, h_count, xyz0):
    """residue index -> "charged" | "polar" | "hydrophobic" | "none" | None, with a
    TRUNCATION REPAIR. None means UNRESOLVED — every instance of that residue name in
    the system is a stub, so there is nothing to compare against.

    The repair is not a nicety: a crystal structure routinely models a disordered
    side chain only as far as CB, which read literally holds no N and no O and
    comes out `hydrophobic` — a confident wrong answer. So a stub inherits the
    verdict of the fully-modelled instances of the SAME NAME. The vote is taken
    over every protein residue in the SYSTEM, not just the target."""
    raw, stub, by_name, side_of = {}, {}, {}, {}
    for res in protein_residues:
        _back, side = _split_sidechain(res, adj, xyz0)
        side_of[res.index] = side
        raw[res.index] = _classify_sidechain(top, side, adj, h_count)
        stub[res.index] = _is_stub(top, side, h_count)
        by_name.setdefault(res.name, []).append(res.index)

    fixed = dict(raw)
    repaired, stub_names = set(), set()
    for name, members in by_name.items():
        best = max(raw[r][3] for r in members)
        full = [r for r in members if raw[r][3] == best]
        if all(stub[r] for r in full):
            stub_names.add(name)               # even the fullest instance is a stub
        if len(full) == len(members):
            continue                           # nothing truncated under this name
        votes = []
        for k in range(3):                     # polar, charged, aromatic
            yes = sum(1 for r in full if raw[r][k])
            if yes * 2 > len(full):
                votes.append(True)
            elif yes * 2 < len(full):
                votes.append(False)
            else:
                votes.append(None)             # tie -> keep the residue's own
        for r in members:
            if raw[r][3] >= best:
                continue
            own = raw[r]
            fixed[r] = tuple(own[k] if votes[k] is None else votes[k]
                             for k in range(3)) + (own[3],)
            repaired.add(r)

    unresolved = set()
    if len(stub_names) >= 2:
        for name in stub_names:
            for r in by_name[name]:
                if stub[r] and r not in repaired:
                    unresolved.add(r)

    out = {}
    for r in raw:
        if r in unresolved:
            out[r] = None
            continue
        polar, charged, aromatic, _n = fixed[r]
        has_side = bool(side_of[r]) or polar or charged or aromatic
        # charged is a strict SUBSET of polar, so the precedence is a choice:
        # charged > polar > hydrophobic > none.
        if charged:
            out[r] = "charged"
        elif polar:
            out[r] = "polar"
        elif has_side:
            out[r] = "hydrophobic"
        else:
            out[r] = "none"
    return out


# ================================== schemes ==================================
def _base_hue_or_refuse(base_rgb, scheme):
    """The hue of a supplied `?color`, or a refusal: an achromatic colour has no hue,
    and every scheme below builds its palette out of one — it would take 0 (red)."""
    h, ll, s = colorsys.rgb_to_hls(*base_rgb)
    if s < 0.05 or ll <= 0.02 or ll >= 0.98:
        raise ValueError(
            f"cartoon ?colorby={scheme}: this ?color carries no hue (it is "
            "white, black or a grey), and this scheme builds its palette out of "
            "the hue — it would silently take red. If you want a single grey "
            "trace, that is `cartoon ?colorby=flat ?color=<that colour>`."
        )
    return h


def _scheme_chain(order, group_of, class_of, base_hue):
    """Hue per chain, shade per secondary structure. A `?color` REPLACES the hue
    variation: every chain takes that one hue, so the whole trace is that colour
    at the three SS shades."""
    n = len(order)
    if base_hue is None:
        hue_of = ({g: LONE_CHAIN_HUE for g in order} if n <= 1
                  else {g: i / float(n) for i, g in enumerate(order)})
    else:
        hue_of = {g: base_hue for g in order}
    out = {}
    for ridx, cls in class_of.items():
        sat, light = SS_SHADE[cls]
        out[ridx] = (_CLASS_RANK[cls], _hex_hls(hue_of[group_of[ridx]], sat, light))
    return out


def _scheme_ss(class_of, base_hue):
    """PyMOL's cbss triple, or — with a `?color` — the three SS shades of that one
    hue, which is the only variation the scheme has left once the hue is pinned. A
    NUCLEIC residue has no secondary structure to show and goes UNSCORED grey; the
    caller refuses outright when that leaves nothing coloured."""
    out = {}
    for r, c in class_of.items():
        if c == NUCLEIC_CLASS:
            out[r] = (_UNSCORED_RANK, UNSCORED)
        elif base_hue is None:
            out[r] = (_CLASS_RANK[c], SS_FIXED[c])
        else:
            out[r] = (_CLASS_RANK[c], _hex_hls(base_hue, *SS_SHADE[c]))
    return out


def _refuse_amino_acid_only(scheme, n_styled, n_nucleic, own_reason):
    """The refusal one of the four AMINO-ACID schemes raises when it scored nothing.

    When the whole target is NUCLEIC the nucleic reason LEADS, because the scheme's
    own explanation — truncated side chains, names outside a parent table — would be
    beside the point and would read as if a nucleotide had nearly qualified."""
    if n_styled and n_nucleic == n_styled:
        raise ValueError(
            f"cartoon ?colorby={scheme}: all {n_styled} residues this would draw "
            f"are NUCLEIC, and {_PROTEIN_ONLY_WHY[scheme]}. Nothing was coloured. "
            + _NUCLEIC_SCHEMES_HINT
        )
    raise ValueError(
        own_reason
        + (f" {n_nucleic} of them are NUCLEIC: {_PROTEIN_ONLY_WHY[scheme]}. "
           + _NUCLEIC_SCHEMES_HINT if n_nucleic else "")
    )


def _scheme_rainbow(group_of, ridxs_in_topology_order):
    """Ordinal position along each chain, N->C, over a full spectrum. PER CHAIN, so
    every chain spans the whole spectrum (PyMOL's `spectrum count` over a multi-chain
    selection instead makes chain B continue where A left off). This IS residue-number
    order, so a separate `resnum` scheme would draw the same picture."""
    per_chain = defaultdict(list)
    for r in ridxs_in_topology_order:
        per_chain[group_of[r]].append(r)
    out = {}
    for _g, members in per_chain.items():
        n = len(members)
        for i, r in enumerate(members):
            t = 0.0 if n <= 1 else i / float(n - 1)
            lev, tq = _quantise(t)
            hue = RAINBOW_HUE_LO + (RAINBOW_HUE_HI - RAINBOW_HUE_LO) * tq
            out[r] = (lev, _hex_hls(hue, 1.0, 0.5))
    return out


def _ramp_buckets(value_of, ridxs, colour_at, absolute=None):
    """A per-residue numeric scalar -> {ridx: (rank, colour)}, quantised to
    RAMP_STEPS levels. `absolute` is (lo, hi) for a scale with its own fixed
    endpoints; None normalises over the residues actually being drawn, which makes
    the colours comparable WITHIN one picture and not across systems."""
    scored = {r: value_of[r] for r in ridxs if r in value_of and value_of[r] is not None}
    out = {}
    if scored:
        if absolute is not None:
            lo, hi = absolute
        else:
            lo, hi = min(scored.values()), max(scored.values())
        span = hi - lo
        for r, v in scored.items():
            t = 0.5 if span <= 0.0 else (v - lo) / span
            lev, tq = _quantise(t)
            out[r] = (lev, colour_at(tq))
    for r in ridxs:
        if r not in out:
            out[r] = (_UNSCORED_RANK, UNSCORED)
    if not scored:
        return None
    return out


def _continuous_colour_at(base_hue, default_stops):
    """The ramp a continuous scheme paints with: its own diverging default, or —
    with a `?color` — near-white to that one hue."""
    if base_hue is None:
        return lambda t: _three_stop(t, default_stops)
    return lambda t: _tint(t, base_hue)


def _sasa_per_residue(traj, top, ridxs, scheme, nucleic_res=frozenset()):
    """Shrake-Rupley SASA in nm^2, summed per residue by mdtraj's own mode="residue",
    MEANED over a budgeted set of evenly spaced frames (frame 0 is the worst possible
    one-frame sample). OCCLUSION IS BY THE BIOPOLYMER ONLY, because Shrake-Rupley
    occludes with every atom you hand it and a solvated system would otherwise bury
    its own solute entirely — the real cost of that being that lipids, ligands and
    ions bury nothing here, so a membrane protein's lipid-facing residues read as
    exposed.

    `nucleic_res` widens the occluder set by the residues this mod DRAWS as nucleic
    that mdtraj's name table does not recognise — a drawn residue has to be scored,
    and it also has to occlude. Nothing in this corpus exercises it (5DZT's AMP and
    10GJ's 8OG both pass the atom signature and both own no trace vertex, so neither
    reaches here), which is why the SASA numbers are unchanged everywhere."""
    polymer = [r.index for r in top.residues
               if r.is_protein or r.is_nucleic or r.index in nucleic_res]
    if not polymer:
        raise ValueError(
            f"cartoon ?colorby={scheme}: solvent accessibility is computed on the "
            "biopolymer (protein and nucleic residues) and this topology holds "
            "none that mdtraj recognises."
        )
    sel = np.asarray([a.index for r in polymer for a in top.residue(r).atoms], dtype=int)
    n_frames = int(traj.n_frames)
    budget = SASA_N2_BUDGET / max(1.0, float(len(sel)) ** 2)
    k = max(1, min(n_frames, int(budget)))
    picks = np.unique(np.linspace(0, n_frames - 1, k).round().astype(int))
    sub = traj.atom_slice(sel)[picks]
    if sub.topology.n_residues != len(polymer):
        raise RuntimeError(
            f"cartoon ?colorby={scheme}: slicing to the biopolymer produced "
            f"{sub.topology.n_residues} residues for {len(polymer)} selected — "
            "the residue mapping this scheme relies on does not hold here."
        )
    area = md.shrake_rupley(sub, mode="residue").mean(axis=0)   # nm^2 per residue
    per_res = {orig: float(area[k]) for k, orig in enumerate(polymer)}
    return {r: per_res.get(r) for r in ridxs}, len(picks)


def _rmsf_per_residue(traj, top, header, ridxs, scheme):
    """Per-residue RMS fluctuation in Angstrom: superpose the DRAWN trace anchors onto
    frame 0, then take each anchor's RMS displacement from its own mean position.
    `atom_slice` copies, so the resident dataset the viewer streams is never touched.
    STATIC — one number per residue for the whole run — so it does not change as you
    scrub."""
    if int(traj.n_frames) < 2:
        raise ValueError(
            f"cartoon ?colorby={scheme}: RMS fluctuation is measured ACROSS "
            f"frames and this dataset has {traj.n_frames}. There is nothing to "
            "fluctuate. (RMSF is the per-RESIDUE quantity; an RMSD would be one "
            "number per frame for the whole structure, which cannot colour a "
            "residue at all.) On a single structure try ?colorby=bfactor, which "
            "is the crystallographic stand-in for the same idea."
        )
    anchor_of = {}
    for poly in header.polylines:
        for v in poly:
            anchor_of.setdefault(top.atom(v).residue.index, v)
    anchors = [anchor_of[r] for r in ridxs if r in anchor_of]
    if len(anchors) < 4:
        raise ValueError(
            f"cartoon ?colorby={scheme}: a rigid-body fit removes 6 degrees of "
            f"freedom, so with only {len(anchors)} trace anchors in this target "
            "most of what is left is the fit's own freedom rather than the "
            "molecule's. Target a longer stretch."
        )
    needed = np.asarray(sorted(set(anchors)), dtype=int)
    local = {int(g): k for k, g in enumerate(needed)}
    sub = traj.atom_slice(needed)
    fit = np.asarray([local[v] for v in anchors], dtype=int)
    sub.superpose(sub, frame=0, atom_indices=fit)
    xyz = sub.xyz.astype(np.float64)
    msd = ((xyz - xyz.mean(axis=0)) ** 2).sum(axis=2).mean(axis=0)   # nm^2
    out = {}
    for r in ridxs:
        v = anchor_of.get(r)
        out[r] = float(np.sqrt(msd[local[v]])) * 10.0 if v is not None else None
    return out


# ================================== the mod ==================================
def compute(data, target_indices, params=None):
    # `params` is None for a RAW caller (a harness invoking compute directly); the
    # viewer always forwards the complete effective set with every declared default
    # filled in, which is why `?color` needs the literal `auto` sentinel for "unset".
    params = params or {}
    scheme = str(params.get("colorby", SCHEMES[0])).strip().lower()
    style = str(params.get("style", STYLES[0])).strip().lower()
    color_tok = str(params.get("color", "auto")).strip()

    if scheme not in SCHEMES:
        raise ValueError(
            "cartoon: ?colorby must be one of %s (got %r)."
            % (", ".join(SCHEMES), params.get("colorby"))
        )
    if style not in STYLES:
        raise ValueError(
            f"cartoon: ?style must be 'ribbon' or 'tube' (got {style!r}). ribbon "
            "draws an oriented flat strip whose face shows a sheet's facing; "
            "tube draws a round camera-facing cord that needs no orientation."
        )

    # `?color` REPLACES the scheme's automatic variation. Two schemes cannot
    # honour that at all and refuse, naming the reason and the alternative.
    base_rgb, base_hue = None, None
    if color_tok.lower() != "auto":
        base_rgb = _parse_color(color_tok)
        if base_rgb is None:
            raise ValueError(
                f'cartoon: ?color={color_tok!r} is not a colour — use a CSS name '
                "(red, steelblue, dodgerblue) or a hex literal (#ff8800, #f80), "
                "the same vocabulary every colour command takes. `auto` means "
                "\"this scheme's own palette\"."
            )
        if scheme in _COLOR_REFUSAL:
            raise ValueError(
                f"cartoon: ?colorby={scheme} cannot take a ?color — "
                f"{_COLOR_REFUSAL[scheme]}. "
                + _COLOR_INSTEAD[scheme].format(c=color_tok)
            )
        if scheme != "flat":
            base_hue = _base_hue_or_refuse(base_rgb, scheme)

    traj = data.trajectory
    if traj is None:
        raise ValueError(
            "cartoon needs coordinates to assign secondary structure, but this "
            "source has no trajectory (data.trajectory is None). The synthetic "
            "source has no chemistry at all — there is no backbone here to draw."
        )
    top = traj.topology
    header = data.give_header()
    # The connectivity the viewer DRAWS, not just what the file declared — every
    # chemistry judgement below reads this. See `_drawn_bonds`.
    drawn_bonds = _drawn_bonds(data, top)

    # A residue is DRAWN only if it owns a trace vertex: a colortrace/tracesize line
    # for a residue with no vertex would match nothing while the mod reported success.
    anchor_res = set()
    for poly in header.polylines:
        for v in poly:
            anchor_res.add(top.atom(v).residue.index)

    protein_atoms = top.select("protein")
    # NUCLEIC, from the ATOMS — see `_nucleic_residues`. Scoped to residues that own
    # a trace vertex and are not already protein, which is both all this mod can draw
    # and the reason a protein-only system pays nothing for this.
    nucleic_res = _nucleic_residues(
        top, sorted(r for r in anchor_res if not top.residue(r).is_protein),
        drawn_bonds)
    if len(protein_atoms) == 0 and not nucleic_res:
        raise ValueError(
            "cartoon found neither a protein nor a nucleic backbone to draw: of the "
            f"{len(anchor_res)} residue(s) that own a trace vertex here (the "
            f"producer drew {len(header.polylines)} polyline(s)), none carries a "
            "peptide main chain and none carries a nucleotide's sugar-phosphate "
            "main chain. There is no backbone here to draw as a cartoon."
        )

    # THE DSSP INDEXING TRAP: md.compute_dssp returns one column per PROTEIN residue,
    # not per topology residue, so a water or ligand sitting between two protein
    # residues shifts every assignment past it. Slice to protein first, then map the
    # columns back through that slice's own residue order — never a raw index.
    protein_residues = [r for r in top.residues if r.is_protein]
    dssp = None
    if len(protein_atoms) > 0:
        sub = traj.atom_slice(protein_atoms)
        dssp = md.compute_dssp(sub, simplified=True)  # (n_frames, n_protein_residues)
        if len(protein_residues) != dssp.shape[1]:
            raise RuntimeError(
                f"cartoon: DSSP returned {dssp.shape[1]} columns for "
                f"{len(protein_residues)} protein residues — the indexing assumption "
                "this mod relies on does not hold for this system."
            )

    # Respect the target: style only residues the caller asked for. (The `shape
    # traces` swap below is scene-level by nature, so it stays whole-system.)
    if target_indices:
        wanted = set()
        for i in target_indices:
            if 0 <= i < top.n_atoms:
                wanted.add(top.atom(i).residue.index)
    else:
        wanted = None

    def majority(codes):
        vals, counts = np.unique(codes, return_counts=True)
        return vals[np.argmax(counts)]

    # The MAJORITY simplified DSSP code over ALL FRAMES, so a mostly-helical residue
    # does not flicker; anything not H or E folds into coil. Voted over EVERY protein
    # residue — run structure belongs to the structure, not the selection, so only
    # the EMISSION is restricted to the target. A NUCLEIC residue takes ONE class of
    # its own and no DSSP is invented for it; protein wins where both would apply,
    # because DSSP already handed that residue a column.
    class_all = {}
    for col, res in enumerate(protein_residues):
        code = majority(dssp[:, col])
        class_all[res.index] = code if code in ("H", "E") else "C"
    for r in nucleic_res:
        class_all.setdefault(r, NUCLEIC_CLASS)

    # The polymer residues in TOPOLOGY order — N->C for every standard biopolymer
    # file, which `rainbow` and the chain ordinal both depend on.
    polymer_order = [res.index for res in top.residues
                     if res.is_protein or res.index in nucleic_res]

    drawn = [r for r in polymer_order
             if r in anchor_res and (wanted is None or r in wanted)]
    if not drawn:
        in_target = sum(1 for r in class_all if wanted is None or r in wanted)
        raise ValueError(
            "cartoon styles the backbone TRACE, and nothing in this target draws "
            f"one: {in_target} protein/nucleic residue(s) are in scope and none of "
            f"them owns a trace vertex (the producer drew {len(header.polylines)} "
            "polyline(s) over this system). Three things land here, and all three "
            "are in the corpus: a residue with no CA anchor; a stretch too short "
            "for the producer to draw a line through at all (a capped dipeptide); "
            "and a coarse-grained bead model whose residues mdtraj's name table "
            "calls protein while their atoms are not a peptide main chain."
        )
    drawn_set = set(drawn)

    # ---- run structure along each DRAWN polyline: absorb, taper, arrowhead ----
    # header.polylines is already split at chain/segment boundaries and at >1.0 nm
    # missing-residue gaps, so none of this reaches across a break the trace
    # itself does not draw.
    width_A = {"H": HELIX_WIDTH_A, "E": SHEET_WIDTH_A, "C": COIL_WIDTH_A,
               NUCLEIC_CLASS: NUCLEIC_WIDTH_A}
    for key, val in width_A.items():
        if not (isinstance(val, (int, float)) and math.isfinite(val) and val > 0.0):
            raise ValueError(
                f"cartoon: the module global for the {key} band width is {val!r}; "
                "it has to be a positive, finite width in Angstrom. Edit the "
                "EDIT ME block at the top of this file."
            )
    taper = min(1.0, max(0.0, float(TAPER)))
    arrow = max(0.0, float(ARROW_SCALE))

    width_of, class_of = {}, {}
    for poly in header.polylines:
        vertex_res = [top.atom(v).residue.index for v in poly]
        raw_codes = [class_all.get(r, "C") for r in vertex_res]
        out_codes, out_w = [], []
        for s, e in _kind_segments(raw_codes):
            seg_codes, seg_w = _band_widths(raw_codes[s:e], width_A, taper, arrow)
            out_codes.extend(seg_codes)
            out_w.extend(seg_w)
        for r, c, wv in zip(vertex_res, out_codes, out_w):
            width_of[r] = wv
            class_of[r] = c

    # residue index -> (category, group, residue number) from the viewer's own labels,
    # so this works whatever the chains are called: the trailing integer of a subgroup
    # label ("ASP 33" -> 33) is what the grammar's range predicate matches. ONE
    # DISCLOSED HOLE — if two DRAWN residues in one chain carry the SAME number
    # (duplicate numbering, or a PDB insertion code, which mdtraj discards) the second
    # silently takes the first's colour and width.
    res_key = {}
    for atom in top.atoms:
        ridx = atom.residue.index
        if ridx in res_key or ridx not in drawn_set:
            continue
        if atom.index >= len(data.labels):
            continue
        category, group, subgroup = data.labels[atom.index]
        try:
            res_key[ridx] = (category, group, int(str(subgroup).split()[-1]))
        except (ValueError, IndexError):
            continue                                  # no trailing number; skip

    if not res_key:
        raise ValueError(
            "cartoon: could not address any residue through data.labels — no "
            "subgroup label of a drawn residue carried a trailing residue "
            "number, which is what the grammar's range predicate matches."
        )
    # Emission order is TOPOLOGY order throughout, which is N->C for every standard
    # biopolymer file — `rainbow` depends on it and so does the chain ordinal.
    styled = [r for r in polymer_order if r in res_key]
    drawn_class = {r: class_of.get(r, class_all.get(r, "C")) for r in styled}
    n_nucleic = sum(1 for r in styled if drawn_class[r] == NUCLEIC_CLASS)

    # The distinct POLYMER chains present IN THE TARGET, in first-appearance order,
    # derived at RUN TIME from the labels — a hardcoded {A,B,C,…} would mis-hue a
    # system whose chains are named otherwise. Keyed by the GROUP label alone.
    group_of = {r: res_key[r][1] for r in styled}
    chain_order, seen = [], set()
    for r in styled:
        g = group_of[r]
        if g not in seen:
            seen.add(g)
            chain_order.append(g)

    # ------------------------------- the colours -------------------------------
    if scheme == "chain":
        color_of = _scheme_chain(chain_order, group_of, drawn_class, base_hue)
    elif scheme == "ss":
        color_of = _scheme_ss(drawn_class, base_hue)
        if all(color_of[r][0] == _UNSCORED_RANK for r in styled):
            _refuse_amino_acid_only(
                "ss", len(styled), n_nucleic,
                "cartoon ?colorby=ss: not one of the "
                f"{len(styled)} residues this would draw has a "
                "secondary-structure class.")
    elif scheme == "rainbow":
        color_of = _scheme_rainbow(group_of, styled)
    elif scheme == "flat":
        if base_rgb is not None:
            flat = _hex_rgb(*base_rgb)
        else:
            flat = _hex_hls(FLAT_DEFAULT_HUE, *SS_SHADE["E"])
        color_of = {r: (0, flat) for r in styled}
    elif scheme in ("bfactor", "plddt", "occupancy"):
        which = "occupancy" if scheme == "occupancy" else "bfactor"
        raw = _topology_column(data, top, which, scheme)
        path_hint = os.path.basename(getattr(data, "_topology_path", "the topology"))
        value_of = _residue_mean_column(raw, top, styled, which, scheme, path_hint,
                                        zero_is_unset=(which == "bfactor"))
        if scheme == "plddt":
            bad = [(r, v) for r, v in value_of.items()
                   if not (PLDDT_LO - 1e-9 <= v <= PLDDT_HI + 1e-9)]
            if bad:
                r0, v0 = bad[0]
                raise ValueError(
                    f"cartoon ?colorby=plddt: a pLDDT is a per-residue confidence "
                    f"on a 0-100 scale, and {len(bad)} of the {len(value_of)} "
                    f"drawn residues in {path_hint} are outside it (residue "
                    f"{top.residue(r0).name} {top.residue(r0).resSeq} is "
                    f"{v0:.2f}). This column is not a pLDDT. If it is a "
                    "crystallographic temperature factor, ?colorby=bfactor is "
                    "the scheme for it."
                )
            color_of = {}
            for r in styled:
                v = value_of.get(r)
                if v is None:
                    color_of[r] = (_UNSCORED_RANK, UNSCORED)
                    continue
                for band, (cut, hexcol) in enumerate(PLDDT_BANDS):
                    if cut is None or v >= cut:
                        color_of[r] = (band, hexcol)
                        break
        else:
            _refuse_constant(value_of, which, scheme, path_hint)
            # bfactor normalises over the target's own min..max (so its colours are
            # comparable WITHIN one picture, not across systems); occupancy has an
            # absolute 0..1 scale of its own.
            color_of = _ramp_buckets(
                value_of, styled, _continuous_colour_at(base_hue, DIVERGING_RAMP),
                absolute=((0.0, 1.0) if scheme == "occupancy" else None))
    elif scheme == "hydrophobicity":
        # A residue the scale does not cover is UNSCORED, not 0 — a nucleobase is not
        # "neutrally hydrophobic", it is off-scale. A MODIFIED residue scores as its
        # parent, on mdtraj's own `res.code` (verified: SEP -> S, MSE -> M, TPO -> T,
        # PTR -> Y). CODE_ALIAS covers only the names that table has no code for.
        value_of = {}
        for r in styled:
            value_of[r] = KYTE_DOOLITTLE.get(_aa_code(top.residue(r)) or "")
        color_of = _ramp_buckets(
            value_of, styled, _continuous_colour_at(base_hue, KD_RAMP),
            absolute=(KD_LO, KD_HI))
        if color_of is None:
            _refuse_amino_acid_only(
                "hydrophobicity", len(styled), n_nucleic,
                "cartoon ?colorby=hydrophobicity: the Kyte-Doolittle index is a "
                "scale over the 20 standard AMINO ACIDS and not one of the "
                f"{len(styled)} residues this would draw is on it (caps, "
                "modified residues outside mdtraj's parent table and "
                "unrecognised names are all off-scale). Nothing was coloured.")
    elif scheme == "sasa":
        value_of, _nf = _sasa_per_residue(traj, top, styled, scheme, nucleic_res)
        color_of = _ramp_buckets(value_of, styled,
                                 _continuous_colour_at(base_hue, DIVERGING_RAMP))
    elif scheme == "rmsf":
        value_of = _rmsf_per_residue(traj, top, header, styled, scheme)
        color_of = _ramp_buckets(value_of, styled,
                                 _continuous_colour_at(base_hue, DIVERGING_RAMP))
    elif scheme == "charge":
        h_counts = _bonded_hydrogen_counts(top, drawn_bonds)
        shades = _shades(base_hue, 3) if base_hue is not None else None
        color_of, scored = {}, 0
        for r in styled:
            q = _formal_charge(top.residue(r), h_counts)
            if q is None:
                color_of[r] = (_UNSCORED_RANK, UNSCORED)
            else:
                sign = 1 if q > 0 else (-1 if q < 0 else 0)
                colour = CHARGE_COLOR[sign] if shades is None else shades[sign + 1]
                color_of[r] = (sign, colour)
                scored += 1
        if scored == 0:
            _refuse_amino_acid_only(
                "charge", len(styled), n_nucleic,
                "cartoon ?colorby=charge: formal side-chain charge is assigned to "
                f"the standard amino acids and none of the {len(styled)} residues "
                "this would draw is one (caps and modified residues are unscored "
                "on purpose — a formal charge is an exact integer and a "
                "phosphoserine's is -2, not serine's 0). Nothing was coloured.")
    else:                                          # polarity
        adj = _adjacency(top, drawn_bonds)
        h_counts = _bonded_hydrogen_counts(top, drawn_bonds)
        xyz0 = np.asarray(traj.xyz[0], dtype=np.float64)
        classes = _polarity_classes(top, protein_residues, adj, h_counts, xyz0)
        rank_of = {"charged": 0, "polar": 1, "hydrophobic": 2, "none": 3}
        shades = _shades(base_hue, 4) if base_hue is not None else None
        color_of, scored = {}, 0
        for r in styled:
            cls = classes.get(r)
            if cls is None:
                color_of[r] = (_UNSCORED_RANK, UNSCORED)
            else:
                rank = rank_of[cls]
                colour = POLARITY_COLOR[cls] if shades is None else shades[rank]
                color_of[r] = (rank, colour)
                scored += 1
        if scored == 0:
            _refuse_amino_acid_only(
                "polarity", len(styled), n_nucleic,
                "cartoon ?colorby=polarity: not one of the "
                f"{len(styled)} residues this would draw has a side chain "
                "modelled far enough to classify, and every residue NAME in this "
                "system is in the same state, so there is nothing to compare "
                "against — a reduced N/CA/C/O/CB model looks exactly like this. "
                "Read literally such a side chain holds no N and no O and would "
                "come out `hydrophobic`, which is a confident wrong answer, so "
                "nothing was coloured.")
    if color_of is None:
        raise ValueError(
            f"cartoon ?colorby={scheme}: nothing in this target is on the scale, "
            "so nothing was coloured."
        )

    # -------------------------------- emission --------------------------------
    a_per_size = _angstrom_per_size_unit(header)

    def ranges(nums):
        nums = sorted(set(nums))
        out, start, prev = [], None, None
        for n in nums:
            if start is None:
                start = prev = n
            elif n == prev + 1:
                prev = n
            else:
                out.append((start, prev))
                start = prev = n
        if start is not None:
            out.append((start, prev))
        # always a-b, even for a single residue, so it is unambiguously the range
        # predicate and never mistaken for a subgroup name
        return ",".join(f"{a}-{b}" for a, b in out)

    color_buckets = defaultdict(list)      # (cat, grp, rank, color) -> res numbers
    size_buckets = defaultdict(list)       # (cat, grp, size string) -> res numbers
    styled_chains = set()                  # (cat, grp), for the orientation bind
    floored = 0
    for r in styled:
        category, group, num = res_key[r]
        drawn_A = width_of.get(r, width_A[drawn_class[r]])
        size = drawn_A / a_per_size
        if size < MIN_EMITTED_SIZE:
            size = MIN_EMITTED_SIZE
            floored += 1
        rank, colour = color_of[r]
        color_buckets[(category, group, rank, colour)].append(num)
        size_buckets[(category, group, f"{size:.3f}")].append(num)
        styled_chains.add((category, group))

    # THE FLATTEN TEST IS ON THE THREE CLASS WIDTHS, not on every emitted size: an
    # ARROWHEAD at 2x the sheet width can still clear the floor after all three
    # class widths have landed on it, so a test on the emitted SET stays silent
    # about a band that no longer carries any secondary structure.
    class_widths = sorted({width_A[c] for c in drawn_class.values()})
    class_sizes = {f"{max(w / a_per_size, MIN_EMITTED_SIZE):.3f}" for w in class_widths}
    if len(class_widths) > 1 and len(class_sizes) == 1:
        raise ValueError(
            f"cartoon cannot draw a secondary-structure band on this scene: its "
            f"bbox gives {a_per_size:.4f} A of band width per size unit, so the "
            f"{min(class_widths):g}-{max(class_widths):g} A class widths this mod "
            f"asks for all land on the same emitted size "
            f"({next(iter(class_sizes))}) once the one-pixel floor is applied "
            f"— {floored} of {len(styled)} residues were floored — and the band "
            "would carry no secondary structure at all. The widths are physical "
            "and this scene is simply too large for them. Widen HELIX_WIDTH_A / "
            "SHEET_WIDTH_A / COIL_WIDTH_A / NUCLEIC_WIDTH_A at the top of this "
            "file, or run cartoon on a subsystem."
        )

    cmds = []
    for key in sorted(size_buckets):
        category, group, size = key
        cmds.append(f"tracesize {category}.{group}."
                    f"{ranges(size_buckets[key])} {size}")
    for key in sorted(color_buckets):
        category, group, _rank, colour = key
        cmds.append(f"colortrace {category}.{group}."
                    f"{ranges(color_buckets[key])} {colour}")

    if style == "ribbon":
        # Bind the orientation over exactly the categories we styled — derived from
        # the labels, so no category name is assumed to exist. Bind BEFORE the
        # shape swap: an unbound ribbon has a zero facing vector and draws nothing.
        for category in sorted({cat for cat, _grp in styled_chains}):
            cmds.append(f"bind {category} ribbon_dir orientation")
        cmds.append("shape traces ribbon")
    else:
        # The tube is camera-facing and needs no orientation, so NO bind here;
        # ribbon_dir still ran (the header is static) and its channel goes unused.
        cmds.append("shape traces tube")

    return cmds
