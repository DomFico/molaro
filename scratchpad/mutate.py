"""Can the gate actually FAIL? Apply one real mutation at a time and re-run it.

Each mutation is a textual edit to a producer/host file that removes exactly one
rule. The test suite must go red, and the block that goes red must be the one that
owns the rule. Anything a mutation does NOT catch is a hole in the net, and is
reported as such.

    <mdbench-python> scratchpad/mutate.py

RUNS ON A SNAPSHOT, NEVER ON THE LIVE CHECKOUT. This used to rewrite
producer/bond_inference.py and package.json IN PLACE for a 30-45 minute run,
restoring each file in a `finally` that only covered the subprocess. The cost was
not theoretical: two reviewers measuring this branch at the same time recorded a
shredded water graph and 4,681 impossible-element bonds, and watched the same call
return 137,666 then 123,452 then 123,476 within forty minutes, before working out
that a harness was editing the tree underneath them. A tool that corrupts anyone
who reads the repo while it runs is not a tool. Every mutation now lands in a
private copy under the system temp directory, and the working tree is never
opened for writing at all — which also means this can be run against uncommitted
work, since the copy is of the WORKING TREE, not of HEAD.
"""
from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
PY = "/home/dom/miniforge3/envs/mdbench/bin/python"

# Everything `python -m tests.bond_inference` reads. Copied per mutation; the
# heavy directories (node_modules, .git, dist) are not among them.
SNAPSHOT_DIRS = ("producer", "tests", "contract")
SNAPSHOT_FILES = ("package.json",)


def snapshot(dest: pathlib.Path) -> None:
    """Copy the WORKING TREE's Python surface into `dest`."""
    for d in SNAPSHOT_DIRS:
        shutil.copytree(ROOT / d, dest / d,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for f in SNAPSHOT_FILES:
        shutil.copy2(ROOT / f, dest / f)
    # src/extension.ts is READ by block H (the third copy of the mode list).
    (dest / "src").mkdir(exist_ok=True)
    shutil.copy2(ROOT / "src" / "extension.ts", dest / "src" / "extension.ts")

# (label, file, old, new, blocks expected to fail)
MUTATIONS = [
    ("M1  scope 1 becomes GLOBAL (no residue scoping)",
     "producer/bond_inference.py",
     "    res = table.residue_of[atoms]",
     "    res = np.zeros_like(table.residue_of[atoms])",
     "A B C E G"),
    ("M2  monatomic (ion) exclusion removed",
     "producer/bond_inference.py",
     "            res.n_atoms == 1\n            or element is None",
     "            element is None",
     "D"),
    ("M3  virtual-site exclusion removed",
     "producer/bond_inference.py",
     "            or sym in VIRTUAL_SITE_ELEMENTS\n",
     "",
     "C"),
    ("M4  one-partner-per-hydrogen rule removed",
     "producer/bond_inference.py",
     "        h = i if is_h[i] else (j if is_h[j] else None)",
     "        h = None",
     "I"),
    ("M5  H-H guard removed",
     "producer/bond_inference.py",
     "        & ~(is_h[gi] & is_h[gj])\n",
     "",
     "I"),
    ("M6  linkage scope stops distance-checking",
     "producer/bond_inference.py",
     "                        if (\n"
     "                            MIN_COVALENT_BOND_NM\n"
     "                            <= dist\n"
     "                            <= (radius[i] + radius[j]) * COVALENT_BOND_SCALE\n"
     "                        ):\n"
     "                            yield (i, j, dist, SCOPE_LINKAGE)",
     "                        yield (i, j, dist, SCOPE_LINKAGE)",
     "E"),
    ("M7  crosslink scope drops the chalcogen requirement",
     "producer/bond_inference.py",
     "        [i for i in range(len(symbols)) if symbols[i] in CROSSLINK_ELEMENTS and eligible[i]],",
     "        [i for i in range(len(symbols)) if eligible[i]],",
     "B C G"),
    ("M8  'off' infers anyway",
     "producer/bond_inference.py",
     '    if mode == "off":\n'
     "        return InferredBonds(mode, [], 0, 0, 0, 0, 0.0)",
     '    if mode == "off":\n        mode = "full"',
     "F"),
    ("M9  package.json default drifts to 'off'",
     "package.json",
     '"molaro.viewer.inferBonds": {\n          "type": "string",\n          "enum": [\n'
     '            "full",\n            "nonsolvent",\n            "off"\n          ],\n'
     '          "default": "full",',
     '"molaro.viewer.inferBonds": {\n          "type": "string",\n          "enum": [\n'
     '            "full",\n            "nonsolvent",\n            "off"\n          ],\n'
     '          "default": "off",',
     "H"),
    ("M10 inferred pairs PREPENDED instead of appended",
     "producer/mdtraj_source.py",
     "        pairs = declared + self.bond_inference.pairs",
     "        pairs = self.bond_inference.pairs + declared",
     "C F"),
    ("M11 covalent scale 1.2 -> 1.25",
     "producer/domain_rules.py",
     "COVALENT_BOND_SCALE = 1.2",
     "COVALENT_BOND_SCALE = 1.25",
     "A B C"),
    ("M12 KD-tree query radius too small",
     "producer/bond_inference.py",
     "            reach = 2.0 * float(radius[idx].max()) * COVALENT_BOND_SCALE",
     "            reach = 1.0 * float(radius[idx].max()) * COVALENT_BOND_SCALE",
     "I"),
    ("M17 the hydrogen rule stops consulting DECLARED bonds (the 24-bond defect)",
     "producer/bond_inference.py",
     "        if h in taken_hydrogens:\n            continue  # already monovalent by the file's own account\n",
     "",
     "B C I"),
    ("M18 the minimum bond length is removed (a duplicated record self-bonds)",
     "producer/domain_rules.py",
     "MIN_COVALENT_BOND_NM = 0.05",
     "MIN_COVALENT_BOND_NM = 0.0",
     "I"),
    ("M19 scope 3 re-adds the residue-INDEX adjacency gate",
     "producer/bond_inference.py",
     "            same = residue_of[gi] == residue_of[gj]",
     "            same = np.abs(residue_of[gi] - residue_of[gj]) <= 1",
     "J"),
    ("M20 scope 1 goes back to a PER-RECORD Python loop (cost scales with records)",
     "producer/bond_inference.py",
     "        step = max(1, INTRA_PAIR_CHUNK // per_row)",
     "        step = 1",
     "K"),
    ("M21 DENSE_RESIDUE_MAX_ATOMS raised past every real record",
     "producer/bond_inference.py",
     "DENSE_RESIDUE_MAX_ATOMS = 64",
     "DENSE_RESIDUE_MAX_ATOMS = 100000",
     "K"),
    ("M22 boron returns to the radii table",
     "producer/domain_rules.py",
     '    "H": 0.031,\n    "C": 0.076,',
     '    "H": 0.031,\n    "B": 0.084,\n    "C": 0.076,',
     "J"),
    ("M23 the host stops validating the setting (a typo bricks file opening)",
     "src/extension.ts",
     'const INFER_BONDS_MODES = ["full", "nonsolvent", "off"];',
     'const INFER_BONDS_MODES = ["full", "nonsolvent"];',
     "H"),
    ("M13 additive dedupe removed (existing bonds re-proposed)",
     "producer/bond_inference.py",
     "        if key in existing:\n            continue",
     "        pass",
     "A C F"),
    ("M14 nonsolvent mode stops excluding solvent",
     "producer/bond_inference.py",
     '    solvent_mode = mode == "nonsolvent"',
     "    solvent_mode = False",
     "C"),
    # M16 is EXPECTED not to be caught, and is kept to say why: the `len < 2` skip
    # is a fast path, not a rule. A 1-atom residue's upper triangle is empty, so
    # removing the guard cannot change any output — an undetectable mutation here is
    # correct information, not a hole.
    ("M16 residue-size skip removed (len<2 residues still bucketed)",
     "producer/bond_inference.py",
     "        if k < 2:\n            continue",
     "        if k < 1:\n            continue",
     "(expected: NOTHING — an optimisation, not a rule)"),
    ("M15 the PBC cutoff no longer sees inferred pairs",
     "producer/mdtraj_source.py",
     "        self.inferred_edges_kept = int(keep[len(declared):].sum())\n"
     "        return [(int(i), int(j)) for (i, j), k in zip(pairs, keep) if k]",
     "        self.inferred_edges_kept = int(keep[len(declared):].sum())\n"
     "        return ([(int(i), int(j)) for (i, j), k in zip(declared, keep) if k]\n"
     "                + list(self.bond_inference.pairs))",
     "(expected: nothing — see the report)"),
]

FAIL_RE = re.compile(r"^\[FAIL\] (.*)$", re.M)
BLOCK_RE = re.compile(r"^--- ([A-Z])\. ", re.M)


def blocks_that_failed(out: str) -> str:
    """Map each [FAIL] line back to the '--- X.' block heading above it."""
    current = "?"
    failed = []
    for line in out.splitlines():
        m = BLOCK_RE.match(line)
        if m:
            current = m.group(1)
        elif line.startswith("[FAIL]"):
            failed.append(current)
    seen = []
    for b in failed:
        if b not in seen:
            seen.append(b)
    return " ".join(seen)


# Restrict to a subset while iterating; empty means run them all.
ONLY: set = set()


def main() -> int:
    print(f"{len(MUTATIONS)} mutations; each is a real edit, applied then reverted\n")
    holes = []
    for label, rel, old, new, expect in MUTATIONS:
        if ONLY and label.split()[0] not in ONLY:
            continue
        original = (ROOT / rel).read_text()
        if original.count(old) != 1:
            print(f"[SKIP] {label}\n       anchor matched {original.count(old)} times — fix the harness")
            holes.append(label + " (anchor)")
            continue
        t0 = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="molaro-mutate-") as tmp:
            work = pathlib.Path(tmp)
            snapshot(work)
            (work / rel).write_text(original.replace(old, new, 1))
            proc = subprocess.run([PY, "-m", "tests.bond_inference"], cwd=work,
                                  capture_output=True, text=True, timeout=3600)
            out = proc.stdout
        red = "FAILURES PRESENT" in out
        got = blocks_that_failed(out)
        verdict = "CAUGHT" if red else "NOT CAUGHT"
        if not red:
            holes.append(label)
        print(f"[{verdict:10s}] {label}")
        print(f"             blocks red: {got or '(none)':<20} expected: {expect}"
              f"   ({time.perf_counter() - t0:.0f}s)")
        n_fail = len(FAIL_RE.findall(out))
        print(f"             {n_fail} failing check groups")
    print()
    if holes:
        print("MUTATIONS THE NET DID NOT CATCH:")
        for h in holes:
            print(f"  - {h}")
    else:
        print("every mutation was caught")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
