# The alpha-class split — ending view-dependent transparency

Two symptoms, reported a day apart, turned out to be one fault.

1. *"Why aren't the bonds transparent like the atoms are at opacity 0.1? When I
   look through a bond I can't see the trace through it."*
2. *"If I rotate adk around and look at it from behind, the points become more
   opaque."*

## The fault

Every geometry pass was `transparent: true` **and** `depthWrite: true`, with no
depth sorting, and instances are drawn in **header order** — slot ≡ header
index, never sorted by depth.

A fragment therefore survived only if it was nearer than every fragment already
drawn at that pixel. The surviving layers are the *running minima* of an
arbitrary sequence:

- header order running **back → front** → every layer survives and accumulates →
  `1 − 0.85¹⁵ ≈ 0.9` → **opaque**
- header order running **front → back** → the first stamps depth and the rest are
  depth-rejected → **one layer** → **transparent**

Rotating 180° reverses that sequence. adk's atoms are ordered along the chain,
which has a net spatial direction, so the two regimes sit on opposite sides of
the molecule. Same atoms, same alpha, opposite appearance.

The bond symptom is the same mechanism with a different victim: at alpha 0.1 a
bond's own pixels were **99.8% gone** (77334 → 145) while the trace behind it
stayed hidden. It blended *and* still occluded — invisible and opaque at once.

## The measurements

Read from the live GL context, not inferred:

```
draw order   points → edge-tube → traces     (all: depthWrite=true, blend=true)
```

adk, 3341 atoms, frame 0 pinned, `pointsize 20`, `pointopacity 0.15`, camera
rotated 180° — mean brightness of lit pixels:

| | 0° | 180° | front/back gap |
|---|---|---|---|
| before | 106.8 | 98.9 | **7.9** |
| before, depthWrite forced off | 147.8 | 148.0 | 0.2 |
| **after the split** | 151.2 | 148.7 | **2.5** |

The residual 2.5 is not the bug — it is an opaque trace inside a translucent
cloud, which legitimately looks different from the two sides. The tell is that
forcing `depthWrite` on the opaque material now moves nothing (2.5 → 2.5):
translucent instances are no longer drawn by that material at all.

How much of an occluded trace comes back at alpha 0.1:

| trace width | bonds, before | bonds, after | points, before | points, after |
|---|---|---|---|---|
| 1 | 8% | 79% | 93% | 89% |
| 3 | 7% | 90% | 101% | 104% |
| 5 | 10% | 92% | 87% | 98% |
| 9 | 6% | 103% | 109% | 86% |

## The fix

Each geometry pass now draws **twice**:

- **opaque half** — `transparent: false`, `depthWrite: true`. Solid geometry
  still occludes exactly as before.
- **translucent twin** — `transparent: true`, `depthWrite: false`, `depthTest:
  true`. Still *occluded by* solid geometry; never deletes anything itself.

`uAlphaPass` tells a draw which half it is, and instances of the other half
collapse out of the clip volume — the same idiom hidden instances already used,
so no new mechanism. A pass opts in by declaring the uniform it needs anyway;
there is no separate registration to forget.

Ordering comes for free: three.js draws the whole opaque list before the whole
transparent one, so solid always precedes faded regardless of registration
order. No `renderOrder` numbers were invented.

### Three decisions worth naming

- **Not a global `depthWrite: false`.** That would stop opaque geometry
  occluding anything, and the analytic per-fragment depth chosen for correct
  interpenetration (variant 2) would have nothing to write into.
- **Two-ended passes classify on `min(iColorA.a, iColorB.a)`.** A segment
  running 1.0 → 0.4 is translucent material; classifying by either end alone
  would let it stamp depth and re-create the bug.
- **The twin shares its opaque half's uniform *objects*.** `material.clone()`
  deep-copies uniforms through UniformsUtils, which would give the twin private
  copies of `k`, the projection row and the style array — it would silently stop
  tracking zoom, resize and style writes, and the symptom ("the faded half is the
  wrong size") would point nowhere near the cause.

## What guards it

- `shaders.test.ts` — the chunk is embedded once per geometry pass, is a
  **partition** (`alpha >= 1` vs `alpha < 1`, complementary over one boundary,
  so nothing is drawn twice or dropped), is actually *called* in each pass, and
  the two-ended passes classify on their dimmest end.
- `S32` — C2 now pins **both** halves: `depthWrite === true` on all three
  geometry materials, `=== false` on all three twins, and all three twins exist.

## Cost

Doubled draw calls and vertex work per pass; geometry and buffers are shared, so
no extra uploads. Not measured against a frame-rate budget — if it ever matters,
the opaque half of a fully-translucent scene (and vice versa) is a wholly
collapsed draw that could be skipped with an instance count.

## What this is not

Not order-independent transparency. Translucent fragments still blend in draw
order, so two overlapping *translucent* surfaces composite in an arbitrary order.
What is fixed is that they no longer **delete** each other. Real OIT remains the
recorded follow-up.
