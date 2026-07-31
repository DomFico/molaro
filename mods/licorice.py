# molaro-mod
# name: licorice
# kind: analysis
# produces: commands
# param: color color green
# param: colorby choice off element bfactor chain charge flat hydrophobicity occupancy plddt polarity rainbow rmsf sasa ss
# param: size number 1.0
# param: within number 0
# param: keep boolean false
# author: Molaro assistant
# source: https://github.com/DomFico/molaro
# description: Licorice (stick) representation, PyMOL-style. `licorice <region> ?color=<css/hex> ?size=<multiplier>` sizes the region's atoms and bonds to one uniform stick radius (scaled by `?size`, 1.0 = the built-in radii) and colours it CPK-style: carbon atoms take the chosen colour, every other element takes its CPK colour (N blue, O red, S yellow, P orange, …), and every bond is split into two HALVES, each half taking its endpoint atom's colour — so a C–N bond is half skeleton, half nitrogen-blue, exactly like a PyMOL stick. `?color` COLOURS CARBON, and any element whose CPK colour would be too close to it is moved out of the way — `?color=red` would otherwise make oxygen the same red as the skeleton and a C-O stick would come out solid, defeating the split; oxygen goes magenta instead and everything else keeps its CPK colour. HYDROGENS and the bonds to them are drawn THINNER (see HYDROGEN_SCALE), the way PyMOL draws sticks, so a hydrogen reads as attached rather than as another heavy atom. Bare `licorice` with no target does the whole system. Runs on the region you give it, does NOT touch the backbone trace, and lands in one undo stroke. `?within=<d>` re-targets to the NEIGHBOURHOOD of what you named, whole residues at a time, and `?keep=true` brings the target itself along. THE DISTANCE IS IN THE SCENE'S COORDINATE UNITS — the same number the built-in `create_sele`/`hide` flags take, so one flag name means one thing everywhere; for an mdtraj-backed source that is nanometres, so a 5 A shell is `?within=0.5`.

# WHAT LICORICE IS. The "sticks" look: every atom is a small sphere and every
# bond a cylinder of the SAME radius, so a molecule reads as one connected rod
# system. This is a `produces: commands` mod (a saved, re-runnable look), not a
# per-point-scalar mod, because the colouring is categorical (skeleton one colour,
# each other element its own) which the single built-in colour ramp cannot express.
#
# THE SIZES. world radius = k * size for BOTH spheres and bond tubes (one scale
# factor for every primitive), so equal size NUMBERS give equal world radii — the
# uniform stick. Atoms are set a hair LARGER than bonds (see the constants) so the
# sphere cleanly caps each stick end; at exactly equal radii the tube's end-cap
# z-fights the sphere at the junction. Thickness is not a parameter (the one
# parameter is the colour) — change the two constants below to retune it.
#
# THE COLOURS. The single parameter `color` is the CARBON / skeleton colour: it
# paints the carbon atoms. Every non-carbon element's atoms get their CPK colour.
# Then every bond is split into two HALVES — `bicolorbonds` snapshots each edge's
# two endpoint atom colours into a per-endpoint gradient — so a C-O bond is half
# skeleton, half oxygen-red, a C-N bond half skeleton, half nitrogen-blue, a C-H bond
# half skeleton, half white, exactly like a PyMOL stick. This IS a true split bond:
# the renderer stores TWO colours per edge (edgeColorA / edgeColorB) and interpolates
# along the tube, so the half-and-half is genuine, not the old whole-edge
# approximation. (An explicit DOUBLE-bond rendering is still not expressible — the
# contract's edges are orderless index pairs drawn as single tubes.) `bicolorbonds`
# colours the edges CONTAINED in the region (both endpoints inside), so nothing paints
# outside the target — order matters: the atom colours are set before the snapshot.
#
# IT RUNS ONLY ON THE REGION. A representation is applied where you point it. The
# target is honoured PRECISELY: a subtree the target covers ENTIRELY is addressed by
# its compact label (`polymer.A.*`), and any partially-covered subtree (e.g. a hand-
# picked `@selection` of a few atoms inside a residue) is addressed by explicit atom
# INDEX ranges (`#12-18,#40`), so only those atoms are touched — never the whole
# group they happen to sit in. A category made of very many groups that is wholly
# covered (each solvent molecule its own group) collapses to one category-scope
# command so the list and the undo stroke stay bounded. Empty target = whole system.
#
# VOCABULARY IS DERIVED, NOT FROZEN. The point TYPE the grammar's 4th segment matches
# is exactly the producer's atom type: element.symbol, or the atom name when there is
# no element. This mod reads that same derivation off `data.trajectory.topology`, in
# the SAME header order as `data.labels`, so `<addr>.<type>` addresses match whatever
# elements this system actually has (carbons on a protein, phosphorus on a nucleic
# acid) — never a hardcoded element list. Anything not in the CPK table below (a rare
# metal, a bead with no element) falls back to a visible colour.
#
# INTENDED FOR ATOMISTIC SYSTEMS (elements + bonds). On a source with no topology
# (the synthetic dataset) it fails closed; beads with no elements get the fallback
# colour and, having no bonds, render as sized spheres only.

# ---- ?colorby palettes, taken VERBATIM from cartoon.py so the two agree ----------
# A residue that is orange in `cartoon ?colorby=plddt` must be orange in
# `licorice ?colorby=plddt`; two mods inventing their own ramps is how a viewer
# stops being readable.
DIVERGING_RAMP = ((0x00, 0x53, 0xD6), (0xFF, 0xFF, 0xFF), (0xD6, 0x00, 0x00))
# `rainbow` and `chain` are HUE schemes and must NOT use the ramp above. They did,
# and the result was that `?colorby=rainbow` had no green, cyan or yellow in it at
# all — a diverging blue/white/red ramp cannot express a spectrum, so the scheme
# could not do the one thing its name promises. These two constants are cartoon's,
# VERBATIM, because a trace and its sticks colouring the same chain by the same
# scheme must agree; licorice having invented its own was the bug.
RAINBOW_HUE_LO, RAINBOW_HUE_HI = 2.0 / 3.0, 0.0   # blue -> red via cyan/green/yellow
LONE_CHAIN_HUE = 0.58     # a lone group has nothing to be told apart from
HUE_SAT, HUE_LIGHT = 1.0, 0.5    # full-intensity hue, cartoon's (s, l)
PLDDT_BANDS = ((90.0, "#0053d6"), (70.0, "#65cbf3"), (50.0, "#ffdb13"), (None, "#ff7d45"))
SS_FIXED = {"H": "#ff0000", "E": "#ffff00", "C": "#00ff00"}
# Continuous schemes are quantised into this many steps, one `colorpoints` command
# each. 12 is enough that a ramp reads as continuous and few enough that the undo
# stroke and the command list stay small.
# Shrake-Rupley is O(n^2)-ish per frame; this budget picks how many evenly spaced
# frames to MEAN over. Same constant and same reasoning as cartoon.
SASA_N2_BUDGET = 5.0e8


# Uniform stick radii, in the viewer's size units. CALIBRATED: these were 5.7/5.5
# and the look people actually wanted was `?size=0.5`, so the constants were
# HALVED to make that the default — `?size=1` is now the good-looking stick and
# the parameter reads as a multiplier of a sensible thing rather than of a thick
# one. Atoms >= bonds so the sphere caps each stick end cleanly (at equal radii
# the tube's end-cap z-fights the sphere at the junction). Retune here to taste.
BOND_RADIUS = 2.75
ATOM_RADIUS = 2.85

# HYDROGEN, drawn smaller — the PyMOL stick convention. A hydrogen is ~1/3 the
# covalent radius of a carbon, and drawing it at full stick width makes a methyl
# read as four heavy atoms. This scales BOTH the H spheres and the bonds that
# touch them. 1.0 disables the effect entirely (uniform sticks, the old look).
HYDROGEN_SCALE = 0.62

# The skeleton (carbon) colour when `?color` is not given. The `?color` parameter's
# own default in the header must match this, and the check at the bottom of compute
# asserts they cannot drift apart.
DEFAULT_SKELETON_COLOR = "green"

# Above this many distinct groups in ONE fully-covered category, address the whole
# category at once instead of per group (keeps a many-molecule solvent category from
# exploding into thousands of commands / a giant undo stroke). Mirrors get_context's
# 24-group display cap.
GROUP_CAP = 24

# CPK / Jmol element colours, keyed by UPPERCASE element symbol, as #hex — the
# colour parser takes both CSS names and hex, and hex is what lets this cover the
# whole periodic table a real system might contain instead of only the ~20 elements
# with a usable CSS name. CARBON is deliberately ABSENT: it is the skeleton and
# takes the `color` parameter.
#
# Anything not listed falls back to FALLBACK — deliberately a LOUD colour, so an
# element this table is missing is visible as a gap rather than blending in. The
# vocabulary is still derived from the data at run time (see `_type_of`); this table
# only decides what a derived symbol is PAINTED, never which symbols exist.
CPK = {
    # Organic set, the ones that decide how a structure reads.
    "H": "#ffffff", "N": "#3050f8", "O": "#ff0d0d", "S": "#ffff30",
    "P": "#ff8000", "F": "#90e050", "CL": "#1ff01f", "BR": "#a62929",
    "I": "#940094", "B": "#ffb5b5", "SI": "#f0c8a0", "SE": "#ffa100",
    "AS": "#bd80e3", "TE": "#d47a00", "AT": "#754f45", "HE": "#d9ffff",
    "NE": "#b3e3f5", "AR": "#80d1e3", "KR": "#5cb8d1", "XE": "#429eb0",
    "RN": "#428296",
    # Biological metals and counter-ions — the ones a real MD box actually holds.
    "NA": "#ab5cf2", "K": "#8f40d4", "LI": "#cc80ff", "RB": "#702eb0",
    "CS": "#57178f", "MG": "#8aff00", "CA": "#3dff00", "SR": "#00ff00",
    "BA": "#00c900", "ZN": "#7d80b0", "FE": "#e06633", "MN": "#9c7ac7",
    "CU": "#c88033", "NI": "#50d050", "CO": "#f090a0", "CD": "#ffd98f",
    "HG": "#b8b8d0", "MO": "#54b5b5", "W": "#2194d6", "V": "#a6a6ab",
    "CR": "#8a99c7", "PT": "#d0d0e0", "AU": "#ffd123", "AG": "#c0c0c0",
    "PD": "#006985", "PB": "#575961", "SN": "#668080", "AL": "#bfa6a6",
    "TI": "#bfc2c7", "GA": "#c28f8f", "GE": "#668f8f", "SB": "#9e63b5",
    "BI": "#9e4fb5", "TL": "#a6544d", "IN": "#a67573", "BE": "#c2ff00",
    "SC": "#e6e6e6", "Y": "#94ffff", "ZR": "#94e0e0", "NB": "#73c2c9",
    "TC": "#3b9e9e", "RU": "#248f8f", "RH": "#0a7d8c", "OS": "#266696",
    "IR": "#175487", "RE": "#267dab", "TA": "#4da6ff", "HF": "#4dc2ff",
    "LA": "#70d4ff", "CE": "#ffffc7", "GD": "#45ffc7", "U": "#008fff",
    "TH": "#00baff", "PU": "#006bff",
}
FALLBACK = "pink"




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
    import gzip, os     # local, like every other import in this file
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
    import os          # local, like every other import in this file
    path = getattr(data, "_topology_path", None)
    if not path or not isinstance(path, str) or not os.path.exists(path):
        raise ValueError(
            f"licorice ?colorby={scheme}: mdtraj discards the {which} column at "
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
            f"licorice ?colorby={scheme}: the {which} column lives in a PDB or "
            f"mmCIF atom record, and this dataset's topology is "
            f"{os.path.basename(path)} — a format that carries no such column. "
            "A PSF, PRMTOP, GRO or TOP topology simply does not have it."
        )
    if len(rows) != top.n_atoms:
        raise ValueError(
            f"licorice ?colorby={scheme}: refusing to map "
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
                f"licorice ?colorby={scheme}: refusing to map "
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
                    f"licorice ?colorby={scheme}: refusing to map "
                    f"{os.path.basename(path)} onto the loaded topology — record "
                    f"{i + 1} is element {elem!r} in the file and {mine!r} in the "
                    "topology."
                )
    slot = _COLUMN_SLOT[which]
    return [r[slot] for r in rows]



def _clamp01(t):
    return 0.0 if t < 0.0 else (1.0 if t > 1.0 else float(t))


def _hex_hls(h, s, ll):
    """(hue, sat, light) -> hex. cartoon's helper, same call and same argument
    order (colorsys is h, l, s), so the two mods produce identical bytes for
    identical hues."""
    import colorsys
    r, g, b = colorsys.hls_to_rgb(h % 1.0, ll, s)
    return "#{:02x}{:02x}{:02x}".format(
        *(min(255, max(0, int(round(v * 255.0)))) for v in (r, g, b)))


def _rainbow(t):
    """Position in [0,1] -> the PyMOL rainbow hue. NOT a three-stop ramp."""
    t = _clamp01(t)
    return _hex_hls(RAINBOW_HUE_LO + (RAINBOW_HUE_HI - RAINBOW_HUE_LO) * t,
                    HUE_SAT, HUE_LIGHT)


def _three_stop(t, stops):
    """t in [0,1] -> hex on a three-stop ramp (0.5 = the middle stop)."""
    t = _clamp01(t)
    lo, mid, hi = stops
    a, b, u = (lo, mid, t / 0.5) if t <= 0.5 else (mid, hi, (t - 0.5) / 0.5)
    return "#{:02x}{:02x}{:02x}".format(
        *(int(round(a[k] + (b[k] - a[k]) * u)) for k in range(3)))


def _plddt_colour(v):
    for lo, hexcol in PLDDT_BANDS:
        if lo is None or v >= lo:
            return hexcol
    return PLDDT_BANDS[-1][1]


def _per_atom_sasa(traj, top, scheme):
    """Shrake-Rupley PER ATOM in nm^2, MEANED over evenly spaced frames.

    PER ATOM, not per residue, because that is the whole point here: a bond takes
    its two endpoints' colours, so per-atom values make the half-and-half of a stick
    carry real information instead of painting both halves of every intra-residue
    bond the same. Verified per-atom on adk: the values vary WITHIN a residue.

    MEANED over frames rather than tracked live — the owner's call, and the simple
    one. Frame 0 alone is the worst possible single sample; `live_sasa` is the mod
    for colour that follows the trajectory.

    OCCLUDERS ARE EVERY NON-SOLVENT ATOM, which is a DELIBERATE difference from
    `cartoon ?colorby=sasa` (biopolymer only). Licorice is pointed at ligands and
    pockets, and a ligand occluded only by protein reads as fully exposed on the
    face where another ligand or a lipid is sitting. Water is still excluded, or a
    solvated system buries its own solute entirely.
    """
    import numpy as np
    import mdtraj as md
    occ = np.asarray(
        [a.index for a in top.atoms
         if not (a.residue.is_water or a.residue.name.upper() in ("HOH", "WAT", "SOL", "TIP3"))],
        dtype=int)
    if occ.size == 0:
        raise ValueError(f"licorice ?colorby={scheme}: nothing but solvent to measure.")
    n_frames = int(traj.n_frames)
    k = max(1, min(n_frames, int(SASA_N2_BUDGET / max(1.0, float(occ.size) ** 2))))
    picks = np.unique(np.linspace(0, n_frames - 1, k).round().astype(int))
    area = md.shrake_rupley(traj.atom_slice(occ)[picks], mode="atom").mean(axis=0)
    out = [None] * top.n_atoms
    for slot, atom_index in enumerate(occ):
        out[int(atom_index)] = float(area[slot])
    return out


def _per_atom_ss(traj, top, scheme):
    """DSSP class per atom, by way of its residue — secondary structure IS a
    per-residue property and inventing a per-atom one would be a lie.

    The MAJORITY class over frames, which is what "average" means for something
    categorical. `live_ss` is the mod for a class that follows the trajectory.

    THE DSSP INDEXING TRAP (copied from cartoon because it is a real one):
    md.compute_dssp returns one column per PROTEIN residue, not per topology
    residue, so a water or ligand between two protein residues shifts every
    assignment past it. Slice to protein first, then map back through that slice's
    own residue order — never a raw index."""
    import numpy as np
    import mdtraj as md
    protein_atoms = np.asarray([a.index for a in top.atoms if a.residue.is_protein], dtype=int)
    protein_residues = [r for r in top.residues if r.is_protein]
    if protein_atoms.size == 0:
        raise ValueError(
            f"licorice ?colorby={scheme}: secondary structure is a protein concept "
            "and this topology holds no protein residues mdtraj recognises.")
    dssp = md.compute_dssp(traj.atom_slice(protein_atoms), simplified=True)
    if len(protein_residues) != dssp.shape[1]:
        raise RuntimeError(
            f"licorice ?colorby={scheme}: DSSP returned {dssp.shape[1]} columns for "
            f"{len(protein_residues)} protein residues — the indexing assumption "
            "this scheme relies on does not hold for this system.")
    out = [None] * top.n_atoms
    for col, res in enumerate(protein_residues):
        classes, counts = np.unique(dssp[:, col], return_counts=True)
        winner = str(classes[int(np.argmax(counts))])
        for a in res.atoms:
            out[a.index] = winner
    return out


def _colorby_commands(data, traj, top, idx, scheme):
    """`colorpoints` commands for a ?colorby scheme, keyed on ATOM INDEX.

    Emitted as buckets — one command per colour, not per atom — so a 3000-atom
    region is a dozen commands rather than three thousand. Atoms the scheme cannot
    score (a ligand under ?colorby=ss, an atom whose file row carried no value) are
    left at whatever colour they already have and REPORTED, never silently painted.
    """
    import numpy as np
    top_atoms = top.n_atoms

    # ---- the value + colour rule for each scheme --------------------------------
    # GRAIN IS STATED, not implied. Five schemes are genuinely PER-ATOM (bfactor,
    # occupancy, plddt, sasa, rmsf); the rest are residue or chain properties
    # BROADCAST to their atoms. A per-residue concept painted per atom is not more
    # precise, it is the same fact repeated, and saying so here stops someone reading
    # a uniform intra-residue bond as a bug.
    ramp = lambda lo, span: (lambda v: _three_stop(
        (min(RAMP_STEPS - 1, int((v - lo) / span * RAMP_STEPS)) + 0.5) / RAMP_STEPS,
        DIVERGING_RAMP))

    def _continuous(values, absolute=None):
        scored = [values[i] for i in idx if values[i] is not None]
        if not scored:
            return values, (lambda v: FALLBACK)
        lo, hi = absolute if absolute else (min(scored), max(scored))
        return values, ramp(lo, (hi - lo) or 1.0)

    if scheme == "flat":
        values = [1.0] * top_atoms
        colour_of = lambda v: FALLBACK
    elif scheme == "chain":
        # One hue per GROUP, taken from data.labels so the name matches what the
        # address grammar shows — never chr(65 + chain.index), which is right only
        # by luck (the banked rule).
        groups = sorted({data.labels[i][1] for i in idx})
        # EVENLY-SPACED HUES, cartoon's rule. A lone group takes the fixed hue
        # rather than the degenerate 0/1 = red. This used to run the hue through
        # the DIVERGING ramp, so two groups came out blue and red and three came
        # out blue, white and red — "white" being a colour no chain should get.
        hue_of = ({groups[0]: LONE_CHAIN_HUE} if len(groups) == 1
                  else {g: k / float(len(groups)) for k, g in enumerate(groups)})
        values = [None] * top_atoms
        for i in idx:
            values[i] = hue_of[data.labels[i][1]]
        colour_of = lambda h: _hex_hls(h, HUE_SAT, HUE_LIGHT)
    elif scheme == "rainbow":
        # Position along the chain, per RESIDUE order within each group.
        #
        # THE DOMAIN IS THE WHOLE GROUP, NOT THE TARGET. It used to be the target,
        # which meant `licorice <5-residue shell> ?colorby=rainbow` re-spread the
        # full sweep across those five residues: pretty, but the colour said
        # nothing about WHERE in the chain you were, and the same residue changed
        # colour depending on what else you happened to select. Now a region's
        # colours are the colours cartoon gives that region, so a stick view and a
        # trace view of the same chain agree and a `?within` shell reads as the
        # SLICE of the spectrum it actually is.
        group_of_atom = {}
        for i in range(top_atoms):
            group_of_atom[i] = data.labels[i][1]
        wanted = {data.labels[i][1] for i in idx}
        per_res = {}
        for g in wanted:
            rs = sorted({top.atom(i).residue.index
                         for i in range(top_atoms) if group_of_atom[i] == g})
            for k, r in enumerate(rs):
                per_res[r] = k / float(len(rs) - 1) if len(rs) > 1 else 0.0
        values = _broadcast(top, per_res)
        colour_of = _rainbow
    elif scheme in ("bfactor", "occupancy"):
        which = "bfactor" if scheme == "bfactor" else "occupancy"
        values = _topology_column(data, top, which, scheme)
        scored = [values[i] for i in idx if values[i] is not None]
        if scored and len(set(scored)) == 1:
            raise ValueError(
                f"licorice ?colorby={scheme}: every targeted atom has {which} "
                f"{scored[0]:g}, so this file carries no {which} to colour by — a "
                "PSF-derived or stripped topology has a constant column.")
        values, colour_of = _continuous(values)
    elif scheme == "plddt":
        values = _topology_column(data, top, "bfactor", scheme)
        scored = [values[i] for i in idx if values[i] is not None]
        if scored and len(set(scored)) == 1:
            raise ValueError(
                f"licorice ?colorby=plddt: every targeted atom has B-factor "
                f"{scored[0]:g}, so this file carries no pLDDT to colour by — a "
                "PSF-derived or stripped topology has a constant column. pLDDT is "
                "written by AlphaFold-class predictors; use ?colorby=sasa or ss here.")
        colour_of = _plddt_colour
    elif scheme == "sasa":
        values, colour_of = _continuous(_per_atom_sasa(traj, top, scheme))
    elif scheme == "rmsf":
        values, colour_of = _continuous(_per_atom_rmsf(traj, top, scheme))
    elif scheme == "ss":
        values = _per_atom_ss(traj, top, scheme)
        colour_of = lambda v: SS_FIXED.get(v, SS_FIXED["C"])
    elif scheme == "hydrophobicity":
        per_res = {}
        for r in top.residues:
            kd = KYTE_DOOLITTLE.get(_aa_code(r))
            if kd is not None:
                per_res[r.index] = kd
        if not per_res:
            raise ValueError(
                f"licorice ?colorby=hydrophobicity: the Kyte-Doolittle scale is an "
                "AMINO-ACID property and none of these residues is a standard one.")
        # ABSOLUTE bounds — the KD scale has its own range, and normalising to the
        # target's spread would make the same residue a different colour in two
        # different selections.
        values, colour_of = _continuous(_broadcast(top, per_res), absolute=(-4.5, 4.5))
    elif scheme in ("charge", "polarity"):
        h_counts, adj = _bonded_h_and_adjacency(data, top)
        protein = [r for r in top.residues if r.is_protein]
        if not protein:
            raise ValueError(
                f"licorice ?colorby={scheme}: {scheme} is an amino-acid concept and "
                "this topology holds no protein residues mdtraj recognises.")
        if scheme == "charge":
            per_res = {}
            for r in protein:
                q = _formal_charge(r, h_counts)
                if q is not None:
                    per_res[r.index] = 1 if q > 0 else (-1 if q < 0 else 0)
            values = _broadcast(top, per_res)
            colour_of = lambda sign: CHARGE_COLOR[sign]
        else:
            xyz0 = np.asarray(traj.xyz[0], dtype=np.float64)
            classes = _polarity_classes(top, protein, adj, h_counts, xyz0)
            values = _broadcast(top, classes)
            POLARITY_COLOR = {"charged": "#e6194b", "polar": "#4363d8",
                              "hydrophobic": "#ffe119", "none": "#a0a0a0"}
            colour_of = lambda c: POLARITY_COLOR.get(c, "#a0a0a0")
    else:
        raise ValueError(f"licorice: unknown ?colorby={scheme}.")

    buckets, unscored = {}, 0
    for i in idx:
        v = values[i] if i < len(values) else None
        if v is None:
            unscored += 1
            continue
        buckets.setdefault(colour_of(v), []).append(i)
    if not buckets:
        raise ValueError(
            f"licorice ?colorby={scheme}: none of the {len(idx)} targeted atoms "
            "could be scored, so nothing would be coloured.")
    cmds = [f"colorpoints {_ranges(sorted(v))} {c}" for c, v in sorted(buckets.items())]
    return cmds, unscored



def _hex_rgb(r, g, b) -> str:
    """0..1 floats -> #rrggbb, clamped."""
    def q(v):
        n = int(round(float(v) * 255.0))
        return 0 if n < 0 else (255 if n > 255 else n)
    return "#{:02x}{:02x}{:02x}".format(q(r), q(g), q(b))


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

# ---- keeping the heteroatoms readable under a chosen ?color ---------------------
#
# THE PROBLEM, in the owner's words: "if we change the bonds to red or blue then the
# half bonds will not appear clear according to elements". `?color` paints CARBON,
# which is most of the structure — but CPK already uses red for oxygen, blue for
# nitrogen and yellow for sulfur, so `?color=red` makes a C-O stick uniformly red
# and the split stops carrying information. The whole point of a bicoloured bond is
# that its two halves differ.
#
# THE FIX: when a CPK colour is too close to the chosen skeleton colour, that
# ELEMENT is reassigned from a reserve of loud, mutually distinct colours. Carbon
# keeps what you asked for — it is the thing you were colouring — and the few
# heteroatoms that would have vanished into it move instead.
#
# CALIBRATED, not guessed. Distances are "redmean" weighted RGB (a cheap, decent
# perceptual approximation; no dependency). Measured against real CPK values:
#     COLLIDES        red/O 31.8   white/H 0.0   yellow/S 67.9   blue/N 174.8
#     MUST NOT        red/P 256.0  green/Cl 234.5  cyan/N 357.0  magenta/O 343.2
# and element-vs-element pairs that must stay apart sit at 230 (O/P) to 487 (N/Cl).
# 200 separates the two groups with room on both sides.
COLOR_COLLISION_DISTANCE = 200.0

# Reserve colours for a displaced element, tried in order. Chosen to be loud and
# mutually far apart, so a displaced oxygen is unmistakably not-carbon whatever the
# skeleton is. A candidate is skipped unless it clears the threshold against the
# skeleton AND against every colour already assigned in this run.
RESERVE_COLORS = (
    "#ff00ff",  # magenta
    "#00ffff",  # cyan
    "#00ff00",  # lime
    "#ff8000",  # orange
    "#ffffff",  # white
    "#8000ff",  # violet
    "#00ff80",  # spring green
    "#ff0080",  # rose
)


def _rgb255(token):
    """A colour token (CSS name or #hex) -> (r, g, b) 0..255, or None if unparseable."""
    rgb = _parse_color(str(token).strip())
    return None if rgb is None else tuple(int(round(c * 255)) for c in rgb)


def _colour_distance(a, b):
    """Redmean weighted-RGB distance — https://www.compuphase.com/cmetric.htm.

    Not CIEDE2000, and deliberately so: this needs to separate "the same colour" from
    "a different colour" on a handful of saturated primaries, which redmean does well
    at zero cost, and a mod should not carry a colour-science library to pick eight
    element colours."""
    if a is None or b is None:
        return float("inf")      # unparseable -> never treated as a collision
    r1, g1, b1 = a
    r2, g2, b2 = b
    rm = (r1 + r2) / 2.0
    return (((2 + rm / 256) * (r1 - r2) ** 2)
            + 4 * (g1 - g2) ** 2
            + ((2 + (255 - rm) / 256) * (b1 - b2) ** 2)) ** 0.5


def _element_palette(member_types, skeleton_color):
    """{element -> colour token} for one run, with collisions against the skeleton
    resolved. Deterministic: elements are considered in sorted order and reserve
    colours are taken in declaration order, so the same system + same ?color always
    produces the same picture."""
    skel = _rgb255(skeleton_color)
    out, used = {}, [skel]
    for t in sorted(member_types):
        sym = t.upper()
        if sym == "C":
            continue                        # carbon IS the skeleton colour
        cpk = CPK.get(sym, FALLBACK)
        if _colour_distance(_rgb255(cpk), skel) >= COLOR_COLLISION_DISTANCE:
            out[t] = cpk
            used.append(_rgb255(cpk))
            continue
        # Displaced: first reserve colour far enough from the skeleton AND from
        # everything already assigned. If none qualifies, keep CPK — a readable-ish
        # collision beats an unreadable duplicate of another element.
        pick = next(
            (r for r in RESERVE_COLORS
             if all(_colour_distance(_rgb255(r), u) >= COLOR_COLLISION_DISTANCE for u in used)),
            cpk,
        )
        out[t] = pick
        used.append(_rgb255(pick))
    return out

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
# `polarity` — the four classes `_classify_sidechain` derives from the bond graph
# below. These colours ARE the KD ramp's two ends (measured, #1e90ff and #ff4500), so
# the two schemes never contradict each other. `charged` is a SUBSET of polar and
# takes a distinct hue so it is tellable from it.
# `?color` — the two in-hue palettes it substitutes for the automatic variation.
TINT_LIGHT_LO, TINT_LIGHT_HI = 0.97, 0.42     # _tint: near-white at 0 to the
TINT_SAT_LO, TINT_SAT_HI = 0.15, 0.95         #   saturated hue at 1 (a ramp)
SHADE_LIGHT_LO, SHADE_LIGHT_HI = 0.24, 0.74   # _shades: n shades of one hue
SHADE_SAT_LO, SHADE_SAT_HI = 0.50, 0.95       #   (a categorical scheme)
# `flat` with `?color=auto` — the lone-chain hue at the sheet shade.
# Off-scale: a residue the scheme genuinely cannot score. NOT tinted by `?color` —
# grey has to keep meaning "no value here".
# A continuous ramp is quantised to this many levels before emission, and the reason
# is command COUNT, not colour fidelity: one `colortrace` per DISTINCT colour means
# one command per residue on a continuous scalar. Lowering it trades colour steps
# for emitted lines, one for one.
# The lowest size value this mod will EMIT, in size units — one pixel of full band
# width at the initial framing. The floor has to be on the EMITTED, QUANTISED
# number rather than on a width: `parseSize` takes 0 as a literal zero extent, so
# `tracesize … 0` draws nothing while the mod reports success.
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


CHARGE_BY_CODE = {"D": -1, "E": -1, "K": 1, "R": 1}

CODE_ALIAS = {
    "CYM": "C",
    "ASH": "D", "GLH": "E", "LYN": "K", "ARN": "R", "TYM": "Y",
}

LONE_CHAIN_HUE = 0.58
# `ss` — PyMOL's `util.cbss` triple, at PyMOL's own full-intensity values.

PROTONATION_CHARGE = {
    "ASH": 0, "GLH": 0,                      # protonated carboxylate: neutral
    "LYN": 0, "ARN": 0,                      # deprotonated amine: neutral
    "CYM": -1,                               # thiolate
    "TYM": -1,                               # tyrosinate
}

STANDARD_AA_NAMES = frozenset(
    "ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP "
    "TYR VAL".split()
)

_PROTEIN_MAIN = frozenset({
    "N", "CA", "C", "O", "OXT", "OT", "OT1", "OT2", "OC1", "OC2",
})


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
    import colorsys    # local, like every other import in this file
    h, ll, s = colorsys.rgb_to_hls(*base_rgb)
    if s < 0.05 or ll <= 0.02 or ll >= 0.98:
        raise ValueError(
            f"cartoon ?colorby={scheme}: this ?color carries no hue (it is "
            "white, black or a grey), and this scheme builds its palette out of "
            "the hue — it would silently take red. If you want a single grey "
            "trace, that is `cartoon ?colorby=flat ?color=<that colour>`."
        )
    return h




def _bonded_h_and_adjacency(data, top):
    """(bonded-hydrogen count per atom, adjacency map) from the DRAWN connectivity.

    `data.edges` and not `top.bonds`: since covalent-radius inference landed, the two
    differ by a lot, and a custom residue whose bonds only exist because inference
    found them would otherwise score as having no side chain at all."""
    view = getattr(data, "edges", None)
    pairs = ([(int(i), int(j)) for i, j in view] if view is not None
             else [(b[0].index, b[1].index) for b in top.bonds])
    counts, adj = {}, {a.index: set() for a in top.atoms}
    for i, j in pairs:
        adj[i].add(j)
        adj[j].add(i)
        for heavy, other in ((i, j), (j, i)):
            e = top.atom(other).element
            if e is not None and (e.symbol or "").upper() == "H":
                counts[heavy] = counts.get(heavy, 0) + 1
    return counts, adj


def _per_atom_rmsf(traj, top, scheme):
    """Root-mean-square fluctuation PER ATOM, in nm, about the mean structure.

    Genuinely per-atom — RMSF is defined per particle — so a stick from a rigid
    backbone atom to a flapping side-chain tip carries the change along its length.
    Superposed first, or the number measures the box drifting rather than the
    molecule flexing."""
    import numpy as np
    if traj.n_frames < 2:
        raise ValueError(
            f"licorice ?colorby={scheme}: RMSF needs a trajectory; this dataset has "
            f"{traj.n_frames} frame.")
    sup = traj[:]
    sup.superpose(sup, 0)
    xyz = np.asarray(sup.xyz, dtype=np.float64)
    return [float(v) for v in np.sqrt(((xyz - xyz.mean(axis=0)) ** 2).sum(axis=2).mean(axis=0))]


def _broadcast(top, per_residue):
    """{residue index -> value} -> [value per ATOM], unscored atoms left None.

    The honest name for what happens to a per-RESIDUE concept in a per-atom mod: it
    is BROADCAST, not refined. Secondary structure, hydrophobicity, formal charge and
    polarity are residue properties; painting every atom of a residue the same colour
    is the truthful rendering of that, and both halves of an intra-residue bond come
    out identical because they genuinely are."""
    out = [None] * top.n_atoms
    for r, v in per_residue.items():
        for a in top.residue(r).atoms:
            out[a.index] = v
    return out


def _type_of(atom):
    """The exact point type the grammar's 4th segment matches: element.symbol, or
    the atom name when there is no element (mirrors the producer's atom_type)."""
    sym = atom.element.symbol if atom.element is not None else None
    return sym if sym else atom.name


def _color_for(point_type, skeleton_color):
    """Carbon (the skeleton) takes the chosen colour; every other element its CPK.

    KEPT for the plain case and as the reference the collision resolver falls back
    to; `_element_palette` is what the command path uses, because it also has to
    keep the heteroatoms distinct FROM the skeleton colour."""
    if point_type.upper() == "C":
        return skeleton_color
    return CPK.get(point_type.upper(), FALLBACK)


def _seg(label):
    """Quote a grammar segment token only if it needs it (chain ids are normally
    bare like `A`, but never assume the data)."""
    label = str(label)
    return f'"{label}"' if (label == "" or " " in label) else label


def _ranges(indices):
    """Compress a set of atom indices into a `#`-list target: `#12-18,#40`.
    Contiguous runs become `#lo-hi`, singletons `#N` (grammar: address.ts)."""
    ids = sorted(set(indices))
    parts, i = [], 0
    while i < len(ids):
        j = i
        while j + 1 < len(ids) and ids[j + 1] == ids[j] + 1:
            j += 1
        parts.append(f"#{ids[i]}" if i == j else f"#{ids[i]}-{ids[j]}")
        i = j + 1
    return ",".join(parts)


def _stick_commands(target, elem_target, member_types, top, color, scale, cpk=True):
    """The licorice commands for ONE addressed region:
      - size its atoms and bonds to the uniform stick radii,
      - colour each element's atoms (carbon = the skeleton colour, else CPK),
      - split every bond into two HALVES, each taking its endpoint atom's colour.
    `target` addresses the whole region; `elem_target(t)` addresses just the atoms
    of type `t` within it. Nothing here touches the trace.

    ORDER MATTERS. The atom colours are set FIRST, then `bicolorbonds` SNAPSHOTS
    them into per-endpoint bond-half colours — so a C-N bond ends up half skeleton,
    half nitrogen-blue, exactly like a PyMOL stick. `bicolorbonds` colours the edges
    CONTAINED in the region (both endpoints inside), so a bond never paints outside
    the target. The whole thing lands as ONE undo stroke."""
    atom_r = round(ATOM_RADIUS * scale, 4)
    bond_r = round(BOND_RADIUS * scale, 4)
    cmds = [
        f"pointsize {target} {atom_r}",
        f"bondsize {target} {bond_r}",
    ]
    # HYDROGENS THINNER, after the uniform pass so the later write wins.
    #
    # `bondsizeOF` and not `bondsize`: the contained form needs BOTH endpoints in
    # the target, and an X-H bond has only one H, so contained would match nothing
    # (H-H bonds do not exist). The incident form is what reaches every bond that
    # TOUCHES a hydrogen, which is exactly the set PyMOL draws thin.
    if HYDROGEN_SCALE != 1.0 and "H" in member_types:
        h_target = elem_target("H")
        cmds.append(f"pointsize {h_target} {round(atom_r * HYDROGEN_SCALE, 4)}")
        cmds.append(f"bondsizeof {h_target} {round(bond_r * HYDROGEN_SCALE, 4)}")
    # CPK is the DEFAULT colouring; a ?colorby scheme replaces it wholesale (the two
    # cannot coexist — an atom has one colour). Sizes are unaffected either way.
    if cpk:
        # ONE palette for the whole run, resolved against the chosen skeleton colour
        # so a heteroatom can never come out the same colour as carbon — which would
        # make the bicoloured stick a solid one and defeat the point.
        palette = _element_palette(member_types, color)
        for t in sorted(member_types):
            cmds.append(f"colorpoints {elem_target(t)} "
                        f"{color if t.upper() == 'C' else palette[t]}")
    cmds.append(f"bicolorbonds {target}")
    return cmds


def _label_commands(prefix, member_indices, top, color, scale, cpk=True):
    """A region the target covers ENTIRELY, addressed by its compact label prefix
    (three grammar segments, e.g. `polymer.A.*` or `solvent.*.*`)."""
    types = {_type_of(top.atom(i)) for i in member_indices}
    return _stick_commands(prefix, lambda t: f"{prefix}.{t}", types, top, color, scale, cpk)


def _index_commands(atom_indices, top, color, scale, cpk=True):
    """A partially-covered region, addressed by explicit atom index ranges so ONLY
    the targeted atoms are touched."""
    by_elem = {}
    for i in atom_indices:
        by_elem.setdefault(_type_of(top.atom(i)), []).append(i)
    whole = _ranges(atom_indices)
    return _stick_commands(whole, lambda t: _ranges(by_elem[t]), set(by_elem), top, color, scale, cpk)


def compute(data, target_indices, params):
    traj = data.trajectory
    if traj is None:
        raise RuntimeError(
            "licorice needs a trajectory-backed dataset with a topology "
            "(elements and bonds); the synthetic source has neither."
        )

    color = str(params["color"]).strip()
    if not color or any(c.isspace() for c in color):
        raise ValueError(
            f'licorice: color must be one colour token (a CSS name or #hex), '
            f'got "{params["color"]}".'
        )

    # `?size` multiplies BOTH radii, so the stick stays uniform at any thickness —
    # scaling only one would reintroduce the sphere/tube z-fight the two constants
    # exist to avoid. Refused rather than clamped: a silently-ignored 0 or -1 would
    # look like the mod failing to run.
    try:
        scale = float(params.get("size", 1.0))
    except (TypeError, ValueError):
        raise ValueError(f'licorice: size must be a number, got "{params.get("size")}".')
    if not (scale > 0) or scale != scale or scale in (float("inf"), float("-inf")):
        raise ValueError(f"licorice: size must be a positive number, got {scale}.")

    top = traj.topology
    n = traj.n_atoms

    # `?within=N` retargets to the NEIGHBOURHOOD, whole residues at a time.
    try:
        within = float(params.get("within", 0.0))
    except (TypeError, ValueError):
        raise ValueError(f'licorice: around must be a distance in scene coordinate units, got "{params.get("around")}".')
    if within < 0:
        raise ValueError(f"licorice: around must be a positive distance in scene coordinate units, got {within}.")
    keep = params.get("keep", False)
    if not isinstance(keep, bool):
        raise ValueError(f'licorice: keep must be true or false, got "{keep}".')
    if within > 0:
        target_indices = data.neighborhood(target_indices, within, keep)

    idx = list(target_indices) if target_indices else list(range(n))

    # Full system membership per (category, group), and each category's group set.
    full_members = {}
    for i in range(n):
        category, group, _sub = data.labels[i]
        full_members.setdefault((category, group), []).append(i)
    groups_of_cat = {}
    for (category, group) in full_members:
        groups_of_cat.setdefault(category, set()).add(group)

    # Target membership per (category, group).
    target_members = {}
    for i in idx:
        category, group, _sub = data.labels[i]
        target_members.setdefault((category, group), []).append(i)

    # Split the target: subtrees it covers ENTIRELY -> compact label address; atoms
    # in partially-covered subtrees -> precise atom-index address (honours the
    # target exactly, never widening a selection to its whole group).
    full_by_cat = {}
    partial = []
    for (category, group), members in target_members.items():
        if len(members) == len(full_members[(category, group)]):
            full_by_cat.setdefault(category, []).append(group)
        else:
            partial.extend(members)

    # SHOW WHAT WE ARE ABOUT TO DRAW. Sticks on a region you had faded out with
    # `hide_res` would style invisible atoms and look like the mod doing nothing, so
    # licorice lifts its own target to full opacity first — points AND the bonds
    # incident to them, the same pair `show_res` writes. One command each however
    # large the region, and it rides the same single undo stroke as the styling.
    scheme = str(params.get("colorby", "off")).strip().lower()
    if scheme not in ("off", "element", "bfactor", "chain", "charge", "flat",
                      "hydrophobicity", "occupancy", "plddt", "polarity",
                      "rainbow", "rmsf", "sasa", "ss"):
        raise ValueError(
            f'licorice: colorby must be off, plddt, sasa or ss (got "{scheme}").')
    # `element` is the honest NAME for what `off` does — CPK by element — and both
    # are accepted so nobody has to remember which one this mod calls it.
    cpk = scheme in ("off", "element")

    shown = "all" if len(idx) == n else _ranges(idx)
    cmds = [
        f"pointopacity {shown} 1.0",
        f"bondopacityof {shown} 1.0",
    ]
    # ORDER: the scheme's colours must land BEFORE any `bicolorbonds`, which
    # snapshots each endpoint's CURRENT colour into the two bond halves. That is
    # what makes a stick carry the gradient — a bond between a buried atom and an
    # exposed one comes out half blue, half red, with the change at the midpoint.
    unscored = 0
    if not cpk:
        scheme_cmds, unscored = _colorby_commands(data, traj, top, idx, scheme)
        cmds += scheme_cmds
    for category, groups in full_by_cat.items():
        # Collapse a wholly-covered, many-group category (e.g. solvent) to one
        # category-scope styling so the command count and undo stroke stay bounded.
        if len(groups) > GROUP_CAP and set(groups) == groups_of_cat[category]:
            members = [i for g in groups for i in full_members[(category, g)]]
            cmds += _label_commands(f"{category}.*.*", members, top, color, scale, cpk)
        else:
            for group in groups:
                cmds += _label_commands(
                    f"{category}.{_seg(group)}.*", full_members[(category, group)], top, color, scale, cpk
                )

    if partial:
        cmds += _index_commands(partial, top, color, scale, cpk)

    return cmds
