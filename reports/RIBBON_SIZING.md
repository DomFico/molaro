# Sizing the ribbon's remaining work

Two read-only investigations, both settled by measurement. **The headline: the
faceting is neither the clamp nor the segment count, and finishing the ribbon is a
chapter — but a different chapter than the parked note assumed.**

---

## Item B — is the faceting the segment count, or the miter clamp?

### The clamp is not the cause. It essentially never engages.

The shader clamps `denom = max(dot(along, m), 0.25)`, where `m` is the bend
bisector. With turn angle φ between consecutive segments, `dot(along, m) = cos(φ/2)`,
so the clamp binds only when **φ > 151.0°** — a near-reversal.

Measured turn angles on real traces, every junction of every frame:

| system | junctions | median | p90 | p99 | max | **over 151°** |
|---|---|---|---|---|---|---|
| 03_adk | 20,776 | 81.6° | 92.4° | 97.0° | 102.6° | **0.000%** |
| 02_trpcage | 2,700 | 85.8° | 93.6° | 97.9° | 103.7° | **0.000%** |
| 09_nucleic | 2,400 | 35.6° | 52.4° | 62.4° | 69.1° | **0.000%** |

Not "rare" — **none**, with 47° of headroom at the worst junction anywhere.

Confirmed against pixels, holding segment count fixed and varying the threshold:

| clamp | bound ribbon pixels |
|---|---|
| 0.90 (aggressive) | 3500 |
| **0.25 (ships)** | **3549** |
| 0.05 | 3556 |
| 0.001 (effectively off) | 3556 |

Turning the clamp *off* changes **7 pixels of 3549 — 0.2%** — and 0.05 vs 0.001 is
identical, so nothing at all lies below 0.05. (Raising it to 0.90 *reduces* pixels
because a higher floor shrinks the miter shift everywhere; that direction tests
suppression, not the clamp's activity.)

**Verdict: the clamp is inactive. Changing it is not worth doing, and it explains
none of the faceting.** That half of the parked fork retires.

### But the segment count is not the cause either — and this is the finding

The trace is not a smooth curve sampled too coarsely. **It is genuinely angular**:
median turn 83° per junction on adk. A quad-per-vertex ribbon over a path that turns
83° per step looks faceted because the path *is* faceted.

Which means the parked lean — "subdivide in the producer, it is still a linear copy,
just of more vertices" — **does not work, and the measurement is unambiguous**:

| treatment | vertices | median turn | **max turn** |
|---|---|---|---|
| raw (ships today) | 214 | 83.0° | **97.0°** |
| linear subdivision ×4 | 853 | 0.0° | **97.0°** |
| linear subdivision ×8 | 1705 | 0.0° | **97.0°** |
| Catmull-Rom ×4 | 853 | 19.0° | 59.6° |
| Catmull-Rom ×8 | 1705 | 8.9° | **34.8°** |

**Linear subdivision leaves the worst corner exactly unchanged.** It inserts points
*on* the existing segments, so the new junctions are straight (median → 0°) while
every original corner survives untouched. More quads, same corners. The median
improving to 0° while the max holds at 97° is exactly the shape of a statistic that
flatters a fix that does nothing.

A spline is what moves the max: Catmull-Rom ×8 takes 97° → 34.8°.

### What that changes about the chapter

The fork the parked note identified — *who supplies orientation at the subdivided
resolution* — was posed for **linear subdivision**, which we now know is not the fix.
The real fix is **smoothing**, and smoothing raises a different and larger question:

> **[CORRECTED]** I first wrote that a spline violates `drawn ≡ supplied`. It does
> not, and the distinction matters because it is what gates the chapter.
>
> That invariant is a RENDERER invariant, established for orientation specifically:
> an oriented shape must read `across` from the supplied channel rather than
> computing one. A spline computed in the PRODUCER and sent as a denser polyline
> satisfies it exactly — the renderer still draws precisely what it was handed.
>
> What it actually raises is a **provenance** question, and this codebase already has
> the pattern: the producer images molecules and holds the solute still, transforms
> coordinates, and says so out loud in `Header.provenance`. Smoothing the trace is
> the same class of thing.
>
> The measurement path is untouched. Mods compute on atom coordinates, not on the
> trace polyline — and the polyline is already a derived object, a selected and
> ordered subset, so it was never the data. The imaging ruling ("mods see exactly
> what the viewer shows") was about coordinates, which mods do read; the trace
> polyline is not one of those.
>
> So the honest shape is: **the ribbon displays a smoothed path, mods measure raw
> coordinates, and the smoothing is stated in provenance.** Which is what every
> cartoon renderer does, and for the reason measured above — the trace turns ~85°
> per step, so nobody has ever drawn the raw polyline.

So the chapter is smaller than I first sized it. It is not blocked on a semantic
ruling about what the renderer may draw; it is producer work plus a provenance line,
of the kind already shipped once. What remains genuinely open is orientation: a
smoothed vertex still needs a direction, and interpolating a direction field revives
the sign-ambiguity walk that `ribbon_dir` had to solve along the chain.

**Recommendation: leave the clamp exactly where it is** — it costs nothing and does
nothing. **Do not build linear subdivision at any resolution**; it is measurably not
the fix. If the faceting is worth removing, the work is a producer-side spline with a
provenance line, and the open question is how a smoothed vertex gets its orientation
— not whether the renderer is allowed to draw it.

---

## Item C — can a vertex attribute be freed?

The measured budget is 14 and the ribbon uses 14; per-face normals need one.

### The obvious candidate is a trap

`position` is supplied as 8 zeroed vec3s and **the shader never declares or reads
it**; the objects set `frustumCulled = false`, so nothing needs the bounding sphere
either. Removing it: the ribbon draws **3549 — byte-identical**, all 10 checks pass.
It is genuinely dead weight.

**But it is not a usable slot.** Removing `position` *and* adding one new attribute —
still 14 supplied — draws **zero**. The framework injects `position` whether the
geometry supplies it or not, so dropping it reduces what we upload and frees nothing.

Removing one of **our** attributes and spending the slot does work: swapping
`iVisible` for a new per-vertex attribute draws **3549, identical**. So the budget
counts our declarations, and a slot can be bought — by merging, not by deleting.

### Ranked candidates

| # | candidate | frees | cost | confidence pixels hold |
|---|---|---|---|---|
| 1 | **`iWidthA`+`iWidthB`+`iVisible` → one `vec2 iWidth`, visibility in the sign** | **2** | none — widths are non-negative (`parseSize` clamps), so the sign bit is unused; the shader already treats `max(wA,wB) <= 0` as collapse | **high** — no precision change, arithmetic identical |
| 2 | `iPrevPoint`+`iNextPoint` → two octahedral `vec2` in one `vec4` | 1 | direction precision; both are only ever used normalized, so magnitude is already discarded | medium — the miter shift is small; a coarse direction moves it slightly |
| 3 | `iColorA`+`iColorB` → two packed floats in one `vec2` | 1 | colour to 8-bit per channel | medium-low — pixel scenarios compare colours; 8-bit is what the display holds, but the packing is visible in any exact comparison |
| 4 | `iAcrossA`+`iAcrossB` → octahedral | 1 | **risks `drawn ≡ supplied`** — this *is* the supplied orientation | low; would not do this |
| 5 | drop `position` | **0** | none | measured: frees nothing |

**Lean: candidate 1, and it is cheap.** It frees two slots where one is needed, needs
no precision trade, and touches one fill function plus three lines of shader. The
sign-bit trick is not a hack here — the shader's existing early-out already treats
non-positive width as "draw nothing", so a negative width means "hidden" almost by
construction.

---

## Together: afternoon or chapter?

**Per-face normals are an afternoon.** One attribute merge with no precision cost,
proven to free a usable slot, plus the 16-corner geometry that was already written
and reverted once.

**Removing the faceting is a chapter, and it is not the chapter anyone thought.** It
is not resolution and it is not the clamp — it is whether the drawn backbone is
allowed to stop being the supplied one. That is a ruling, not an implementation.

### What changed the framing

The parked note asked the right question and then leaned on the wrong answer.
"Subdivide in the producer — still a linear copy, just of more vertices" is exactly
the operation that provably does nothing here. It survived as a plan because *median*
turn angle improves dramatically under it while the *maximum* — the thing you
actually see — does not move at all.
