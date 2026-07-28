# Parked — forks declined during the overnight run, each with a lean

## P1 — hold-F gesture semantics — CLOSED: THE GESTURE WAS REMOVED

This entry was stale twice over and is now moot. It read "Parked by the brief… the
build waits… Blocked on: nothing technical" long after every element of its lean had
SHIPPED verbatim (dwell-to-fire, the resolving name shown during the dwell, move-off
cancels, `HOLD_MS` shared with `tree.ts`).

The gesture is now **gone**, at the owner's request, along with the
`molaro.viewer.holdCommand` setting and the two spotlight mods. It was removed not
because the gesture was broken — it demonstrably worked — but because the only thing
worth binding to it did not, and the feature was not mission-critical. See P9.

**What survived the removal, deliberately:** the keydown TEXT-ENTRY guard. That was
never gesture machinery — the one keydown listener also owns Escape, Ctrl+Z and
Ctrl+Shift+Z, and the old `tagName === "INPUT"` form meant clicking the frame scrubber
(an `<input type=range>`) silently killed all of them until you clicked the canvas
again. S49 is now that guard's scenario, asserting BOTH directions: a range input must
not swallow the keys, a text input must still swallow them.

**If it is ever rebuilt**, the recon that preceded the removal measured what to fix
first, and none of it is lost: `{target}` resolved ONLY to a committed selection (so
you could not act on an unselected atom — a `{point}`/`{subgroup}` token was the
cheapest real win); `rm` was reachable from the gesture and armed a real deletion
because the destructive-verb refusal only guarded mod macros; and a gesture-fired mod
that FAILED was indistinguishable from one that worked, because the outcome went only
to the terminal panel (PARKED P3).

## P2 — a guard that every pending-set mutation records an op
`commit()`'s justification rests on strict LIFO covering every mutation of the interim
pending set. B1 pinned the *consequences*; nothing pins the *premise*.
**Lean:** not yet worth it. The premise is currently enforced by there being only a
handful of mutators, all in one file. Revisit if a mutator ever lands outside `sets.ts`.

## P3 — routing mod outcome lines somewhere other than the terminal panel
`asyncLine` posts `commandResult id:-1`, which the host forwards only to the terminal.
Anything triggered from the viewer (a gesture, a future button) would be silent.
**Lean:** mirror non-`ok` statuses to the topbar status line, not just `error` — the
all-nomatch summary is status `nomatch` and is exactly what a non-terminal user must
not miss. Out of scope tonight; it is gesture-adjacent and the gesture is parked.

## P4 — ribbon segment count (subdivision). Written up, not built.

The ribbon draws one quad per polyline vertex, so a bend is exactly as coarse as
the supplied curve. On a tight turn the band is visibly faceted, and the miter only
makes the facets meet cleanly — it cannot add any.

**Subdividing in the PRODUCER sidesteps what killed renderer-side subdivision.** The
renderer's objection was that generating vertices at draw time breaks
slot ≡ header order and forces compaction. A producer that emits a denser polyline
does not: it is still a linear copy, just of more vertices, and every downstream
invariant holds unchanged because the header simply says there are more of them.

**The fork that makes it a chapter is orientation, not geometry.**

`orientation` is a per-point-per-frame channel, and polyline vertices map UP from
points. A subdivided vertex is not a point — nothing in the contract gives it a
channel value. So one of two things has to happen, and they are different projects:

**(a) The producer supplies orientation at the subdivided resolution.**
Clean in the renderer: every vertex has a real supplied value and `drawn ≡ supplied`
holds unmodified. The cost is that the producer must now own the orientation field
for vertices that do not correspond to points — which means either the mod that
computes orientation also computes the subdivision (coupling two concerns that are
currently independent), or the contract grows a per-VERTEX channel scope beside the
per-point one. That second option is a wire change and is out of scope by standing
rule.

**(b) Something interpolates between supplied orientations.**
No contract change and no producer coupling. But interpolating a direction field has
its own coherence question, and it is the same one `ribbon_dir` already had to solve
along the chain: two adjacent supplied directions can be near-antiparallel, and the
naive interpolation through the midpoint is undefined exactly where you most need it.
Slerp on the sphere fixes magnitude but not the sign ambiguity; the sign has to be
resolved against a neighbour, which is a walk, which is the thing that made the
frame-to-frame flip-correction subtle. Doing it per frame at draw time also puts a
walk in the render loop.

**My lean: (a), with the producer emitting a denser polyline AND the orientation
values for it, and no contract change** — i.e. subdivision becomes something a mod
opts into by supplying both, rather than a renderer feature. That keeps
`drawn ≡ supplied` literally true, keeps the walk in Python where the existing
flip-correction already lives, and makes the coarseness a property of the data
rather than of the viewer. The cost is that a coarse polyline stays coarse until
someone re-emits it, which is honest: the viewer is not inventing curve that the
data did not contain.

**What I would want measured before building either:** how much of the faceting is
actually the segment count versus the miter limit clamp. The miter clamps at
`dot(along, m) ≥ 0.25`, and a tight enough bend hits that clamp — where more
segments would not help, because each one still meets its neighbour at a clamped
corner. If the visible faceting on real curves is mostly clamp rather than
resolution, this whole item is the wrong fix for the symptom.

## P5 — edge-primitives (bicolor + dashed) follow-ups
**Parked by the ship.** The bicolor/dashed edge primitives (incr 51) shipped with a
`clear_to_merge` adversarial pass; the completeness critic surfaced four non-blocking
items, each proven-safe-today, deferred rather than gold-plated into the same merge.
Pick these up when the edges work continues (especially before the "authorable edges"
substrate chapter, which extends this exact code).
- **Redo assertion for the new verbs.** Undo is E2E-proven; redo (Ctrl+Shift+Z)
  through the double-`withBindingClear` stroke for `bicolorbonds`/`bonddash`
  specifically is not asserted. **Lean:** add a redo leg to S54/S55 — cheap, closes an
  inherited-behavior gap. Low risk (no provider boundary in these direct rep writes,
  so the [[viewer-increment-44-d1-d4]] redo-future-drop rule doesn't bite).
- **Alpha-divergence guard.** `min(iColorA.a,iColorB.a)` alpha-pass routing is correct
  only because both halves' alpha always come from the single `edgeOpacity[e]`. That's
  an unguarded convention. **Lean:** add a unit assertion that no writer sets one
  half's alpha alone (a `two-lists-must-agree`-flavored guard), so a future edge writer
  can't silently diverge them.
- **Junction-dash depth.** Dash `discard` at a capped/analytic-trimmed junction isn't
  pixel-proven; only the straight tube is. **Lean:** reasoned safe (a gap reveals the
  sphere behind, not a background hole), so a written note may suffice; add a junction
  pixel spot-check only if the interaction-edge work makes dashed junctions common.
- **Bind-takeover advisory under-count (cosmetic).** `overlapStats` skips the other
  axis, so displacing the OTHER color axis's binding under-reports the element count in
  the advisory message (coverage IS released; message-only). **Lean:** count both color
  axes' coverage in the takeover advisory when the written axis shares the A/B buffer.

## P6 — a PUBLIC accessor for the topology path, or better, B-factor/occupancy as a header channel
**Surfaced 2026-07-26 by the cartoon `?colorby` work.** mdtraj 1.11.1 **discards the B-factor
and occupancy columns entirely** — verified: no attribute on `Atom`, nothing on
`PDBTrajectoryFile`, and the producer carries neither. So three of cartoon's colour schemes
(`bfactor`, `plddt`, `occupancy`) re-read the ORIGINAL topology file and parse the column
themselves, reaching it through **`getattr(data, "_topology_path", None)` — a PRIVATE attribute
of the producer source**. It is guarded and fails closed, but it is a mod depending on an
underscore.

**Two ways to fix it, and the second is better.**
1. *Cheap:* give the source a public accessor (`data.topology_path()`), so the dependency is
   sanctioned rather than tolerated. Does not help any other consumer.
2. *Right:* carry per-atom **B-factor and occupancy in the header as static per-point channels**
   when the topology format supplies them. Then `bake`/`bind` reach them for free, every mod and
   the assistant can use them without parsing anything, and the producer — which already owns
   the file — does the reading once instead of each mod doing it again. This is the same shape as
   the per-point `type` channel that already exists.

**Why it is not urgent:** the guarded private access works, and the schemes refuse honestly where
the data is absent (adk's column is all `0.00` because it is PSF-derived).
**What makes it worth doing:** the parsing is genuinely fiddly and every mod that wants these
values must currently repeat it. Measured traps a second implementer would re-discover:
mdtraj **rewrites atom names on load** (`OH2`→`O` **47,829×** on the membrane, `HN`→`H`, `HB1`→`HB3`;
even adk has 6) and **reassigns chain letters in mmCIF** (184 of 5DZT's rows, 58 of 1b0c's), so
name- and chain-keyed mapping both break — **`resSeq` + element are the keys that hold.** And
`B = 0.00` must be read as *unset*, not as the coldest atom, or a structure whose column is
mostly blank paints a false gradient (on the membrane only 8 of 1472 drawn residues carry a
value, and 3140 of the non-zero atoms are waters).

## P7 — a trace anchor for MODIFIED/NON-STANDARD backbone residues

**Found while closing increment 63 (bond inference), measured, not fixed.**

`domain_rules.trace_anchor_indices` gates on mdtraj's `is_protein` / `is_nucleic`
classification. A residue mdtraj does not recognise gets **no anchor**, owns no trace
vertex, and is skipped by the backbone polyline — even when it carries a complete
backbone. Because the polyline then steps across the missing residue, the distance
usually exceeds `TRACE_GAP_BREAK_NM` and the trace visibly **BREAKS** there.

**Measured, on the owner's own systems:**

| system | residue | evidence |
|---|---|---|
| `BACD_ion.pdb` | ABU42, DHBR43, DHBR48, DALA52, ABU58, DHBR59 (+1) | 27-residue peptide, trace threads only **20**; 7 residues with full `N/CA/C` get no anchor |
| `10GJ.cif` | 8OG13 (8-oxoguanine, 23 atoms, has `P`) | chain 9 splits into **two** polylines, resSeq 1→12 and 14→147 |
| AF cif | — | 0 orphans (mdtraj recognises TPO as protein) |

This is the TRACE half of exactly the complaint that motivated increment 63 — "custom
residues are not drawn properly". Increment 63 fixed the BOND half; the anchor rule was
never in its scope.

**Lean:** derive the anchor from the ATOMS PRESENT rather than from mdtraj's
classification — `CA` when a residue has `N`/`CA`/`C`, `P` (then `C4'`) when it has a
nucleic sugar signature — falling back to the current classification test. That is the
banked Rule #5 (*derive vocabulary at run time, do not trust one system's classification*)
applied to the same function that already encodes the CA / P / C4' vocabulary.

**Blast radius, why it is a separate increment:** it changes `header.polylines`, which
feeds the trace, the ribbon/cartoon, `colortrace`/`tracesize`, and the trace-gap rule from
increment 54. Any system with a modified residue gains vertices, so E2E pixel baselines
and `acceptance_corpus` polyline counts move deliberately. It needs the same treatment
increment 63 got: a negative control proving the derivation is load-bearing, and a check
that a genuinely discontinuous chain still breaks.

**Do not conflate with the gap-break rule.** Increment 54 established that the trace splits
on DISTANCE (`>1.0 nm`), never on `resSeq`. That rule is correct and is doing its job here —
it is breaking because the anchor is genuinely absent, not because the threshold is wrong.

## P8 — covalent bond categories no inference scope reaches

Increment 63's three scopes (intra-residue / named backbone linkage / S-Se crosslink)
deliberately cannot reach these, and nothing in the header or provenance says so:

- **head-to-tail cyclic peptides** (last residue `C` -> first residue `N`) — scope 2 walks
  `zip(rs, rs[1:])` per chain and never wraps. A cyclosporin-class macrocycle renders as an
  open chain. Measured MISSED on a fixture at 1.330 A.
- **glycosidic / N-glycan links** (`ASN.ND2` - `NAG.C1`, measured MISSED at 1.441 A) — a
  sugar tree renders as disconnected monosaccharides.
- **isopeptide bonds** (`LYS.NZ` - `GLY.C`, ubiquitin/SUMO conjugates).
- **non-chalcogen covalent ligand links** (a covalent serine-protease inhibitor).
- **metal-organic bonds** — a heme Fe floats unbonded inside a correctly-bonded porphyrin.
  This one is arguably CORRECT (coordination is not covalent, and PyMOL/VMD also leave it),
  but the other four are real misses.

**Lean:** a scope 4 keyed on a small NAMED linkage table (`ND2`/`C1`, `NZ`/`C`, and a
chain-wrap pass for scope 2) rather than a distance-only rule. The membrane's 1,788
sub-0.05 nm pairs are why a general non-adjacent heavy-atom rule is not safe — that is the
same refutation that forced scoping in the first place, and any scope 4 must survive it.

**Blocked on:** wanting a real file for each case. Every number above is from a synthetic
fixture; none of the 15 real structures in the evidence base contains one.

## P9 — the missing `spotlight` mod, and `hide all + ~@sel` hiding everything

Two findings from the gesture recon, both measured, neither fixed.

**1. The `spotlight` mod both retired files cite DOES NOT EXIST.**
`spotlight_rainbow.py` names a plain `spotlight` repeatedly as the one that "gets this
right" — neighbourhood receding from apparent luminance 0.817 at the rim to 0.268 at the
core, fading toward the base colour `#e6e6e6` and ending 35/255 away from it, i.e. no
visible ring. A filesystem-wide search finds only `spotlight_field` and
`spotlight_rainbow`; it is not in the old `Research/.../lanm_architecture/.molaro/mods`
copy either, and `git log --all --diff-filter=A -- '*spotlight*'` is empty.

So the mod the owner remembers as "the spotlight" is the sibling that was explicitly
written as NOT it. Its own comments: *"it does not spotlight anything… every neighbourhood
atom is fully saturated at full opacity, while the selection is mostly grey and white, so
the eye is pulled to the surroundings and away from the thing they are meant to
highlight… It is a churn viewer."*

**Lean:** write it, and the existing analysis says exactly how. The failure is structural,
not tuning: **every point on the built-in hue ramp is fully saturated, so a bound colour
axis has no low-salience end and nothing bound to it can recede.** Opacity has such an end,
which is why the fade already works. A real spotlight therefore grades the surroundings in
LUMINANCE toward the base colour rather than binding them to hue. Reuse `spotlight_field`
unchanged — the proximity channel is right; only the consumer is wrong.
**Cost note:** this is DOMAIN flavour, and it is a `produces: commands` mod, so it needs no
engine change. It also does not need the per-frame channel at all if it emits static
shells — see P8's cost table for why a per-frame channel on a gesture path is the trap.

**2. `hide all + ~@sel` hides EVERYTHING and reports success.**
Measured during the recon: the `+ ~` negation form silently hid all 6000 points of the
synthetic scene while returning `ok`. The bare-token form errors honestly
(`hide all + ~#100-140` -> `unexpected "..." — terms are joined with "+"`), so this is the
`@name` arm specifically. Untruthful success is the worst failure shape this project has,
and it is squarely the class increment 25 was about.
**Not diagnosed** — nobody traced whether the negation is dropped during parse or applied
to an empty set. Do that before assuming it is a one-liner.
**Consequence for gestures:** it removes the obvious zero-code spotlight template. There is
no way to say "hide everything except this" in ONE command today, which is why the intent
has to be packaged as a `produces: commands` mod.

## P9 addendum — MEASURED: the channel-provider path is broken, two ways

Written before this was measured; the numbers now exist and change the priority.
Reproduced in the real bundle against real adk (3341 atoms, 98 frames), by hand
through the command path with NO gesture involved:

| invocation | result |
|---|---|
| `sasa_field @site` — a SHIPPED provider, alone | **error**: `frame chunk: channel blocks [sasa_field] do not match declared per_point_per_frame channels []` |
| `live_sasa @site` — its consumer, auto-running it | **ok**, "1 binding live", undo depth 2 |
| `spotlight_field @site` — alone | same error |
| `spotlight_rainbow @site` — its consumer, auto-running it | **error**, undo depth 1, nothing landed |

So there are TWO defects, and the first is not spotlight-specific:

1. **Invoking any `produces: channel` mod directly is broken.** The producer emits a
   channel block that the viewer has no matching declaration for. `sasa_field` — which
   ships, and which `live_sasa` drives successfully — fails exactly the same way when
   run by name. This is a live defect in shipped functionality that nothing tests: the
   corpus gates drive providers only through their consumers.
2. **`spotlight_rainbow`'s consumer path fails where `live_sasa`'s succeeds.** The
   structural difference is that `spotlight_field` is TARGET-DEPENDENT — it recomputes
   proximity against the selection you name — while `sasa_field`, `ss_field` and
   `ribbon_dir` all compute whole-system values and ignore the target. That is the same
   path a previous increment reworked ("the viewer now records which target each
   channel's values describe and re-runs the provider when it no longer matches").

**A hypothesis that was TESTED AND REJECTED**, recorded so nobody re-runs it: that
`spotlight_field` returning a boxed Python list (327,418 floats on adk) instead of the
`np.ascontiguousarray(..., dtype="<f4")` the shipped providers all use was the cause.
Converting it to a contiguous `<f4` block changed nothing — identical error.

**Not root-caused.** Defect 1 is the one to chase first: it is shipped functionality,
it is reproducible in one command, and fixing it may well fix defect 2.

## P10 — a mod cannot read an existing channel, so nothing can ACCUMULATE

Found by the owner: "if I ran smooth on another part of the structure is it supposed to
override the other thing?" It is, and it cannot do otherwise today.

MEASURED on adk: `smooth A` moves 19 points; `smooth B` afterwards moves 12 and **A has
stopped**; `smooth A + B` in one command moves 31 and covers both.

**Why it is structural.** A channel is one column and a provider run replaces it. To add
to what is there, a provider would have to READ the current values — and it cannot:
`producer/mdtraj_source.py:1273` hardcodes `channels=[]` ("deferred this increment"), so
`data.give_header().channels` is an empty list for every mod. There is nothing to
accumulate onto.

This is the same family as the two gaps already recorded: **the mod surface is
write-only about derived state.** A mod cannot read a colour, a size, an opacity
(spotlight_rainbow's header says so), the displayed frame (P9), or a channel's current
values (this). Each has produced a user-visible surprise.

**Lean:** expose the declared channels and their values read-only on the mod surface, the
same shape `data.edges` and `data.labels` already have — `data.channel("smoothing")`
returning None when undeclared. That single accessor would unblock accumulate-style mods
generally, not just smoothing, and it is a producer-side addition rather than a wire
change (the values already live producer-side; the header field is what was deferred).

**Not urgent, and there is a correct spelling today**: the address grammar unions with
`+`, so `smooth @a + @b` expresses "both" exactly. Documented in the mod, since the
override is genuinely surprising and was found the hard way.
