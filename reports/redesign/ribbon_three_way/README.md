# Ribbon three-way comparison — the rendered evidence for the thickness + conditioning increments

Isolates ONLY `webview/shaders.ts`: same mods (by sha256), same camera to 6 decimal places,
one file swapped per state, `03_adk_psf_dcd` through the real mdtraj producer.

- **A** = `7de842d` shader — pre-thickness, pre-conditioning (`RIBBON_THICKNESS = 0.15`, facing
  slerped raw then projected per sub-sample). The TRUE prior shader: it typechecks and builds
  against current main, so this is not a reconstruction.
- **B** = `e7c2f63` shader — thickness only (0.30).
- **C** = `0586b32` shader — shipped (thickness + anchor-conditioning + transported-frame sign).

## What the images show

| file | shows |
|---|---|
| `cmp_helix_zoom1.png` | the money shot for the owner's original "stringy" complaint — A/B sharp V-folds and a pinched strip, C one continuously curving strap |
| `cmp_fold143_zoomA.png` | the band presenting its narrow face at the camera. Rim height measured column-by-column at x=894..934: **A 6-7 px → B 12-13 px, exactly 2x**, as 0.15→0.30 predicts |
| `cmp_fold143_zoomB.png` | the worst fold in the scene at frame 0 (GLU143→GLY144, sub-facet 164.9°). A and B carry a bright knife-edge crease across the U-turn; C has none |
| `cmp_fold143.png` | the same site, full frame |
| `cmp_worse_helix1.png` | an honest residual: C's specular is hotter/tighter on broad faces. This is a highlight roll-off, NOT a fold — it is what the crease metric miscounted as "worse" in 13 of 208 blocks |
| `cmp_stipple.png` (9x) | the other residual: a stippled depth-buffer seam where two ribbon surfaces meet at grazing angles. **PRE-EXISTING in all three states** — C did not introduce it, but C presents more grazing surface so the dotted run is longer. The natural next ribbon follow-up |
| `C_shipped_log.txt` | the shipped run's terminal transcript + mod provenance, incl. `orientation vectors NON-ZERO: 214/214` (proof the ribbon was really drawing, not an empty scene) |

## Metrics, so the pictures are not the only evidence

- Interior Sobel-gradient hits above 40/255 per interior band pixel (a crease measure):
  full 0.90 → 0.82 → 0.83, helix 0.25 → 0.25 → **0.19**, fold143 0.25 → 0.23 → **0.20** (A/B/C).
  On fold143, **0 of 208 blocks are worse in C than in B**.
- Ink coverage RISES at each step (11.94 → 12.93 → 13.04% full; 55.54 → 60.00 → 60.40% helix) —
  the un-pinched facing presents more wide face, so the band grew while creases fell.
- Enclosed pinholes fall monotonically A→B→C: full 34 → 31 → 27, helix 14 → 14 → 8.

Full set (9 states + 13 montages + per-state logs) was written to `viewer/scratchpad/three_way/`,
which is untracked and temporary; the decisive subset is preserved here.
