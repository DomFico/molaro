# B-3 PHASE 0 — the produced-channel pipe: the fork, ruled (2026-07-20)

Cited against HEAD = 0bb463b. Nothing in this document is built; this is
the checkpoint the brief requires before the contract moves.

## 0. The site map (what exists, exactly)

- **Channels in the contract**: declared in the Header — `{name, scope,
  dtype: "float32", min?, max?, components?: 1|3}`; `per_point_per_frame`
  channels carry NO data in the header — their values ride FrameChunks as
  one block per declared channel (SPEC.md:58-74, 118-131). The vector
  case is already paved: `components: 3` with "nothing else about the
  wire format changes" (SPEC.md:70).
- **Chunk validation is both-direction strict**: a chunk's channel blocks
  must equal the header's declared set — an extra block and a missing
  block BOTH fail (contract.ts:407-415; contract.py:409-414). Both
  validators compare sorted name SETS and both decoders store blocks by
  NAME (order-insensitive consumption).
- **The transport is strictly FIFO, no ids, no push**: three request
  kinds (`header`, `frames`, `run_mod`); the producer answers 1:1 in
  order; the webview correlates by queue position and THROWS on any
  unsolicited message (transport.ts:5-9, 36-51; serve.py:220-242). The
  producer is a single serial loop — a `frames` request queues behind a
  running mod compute.
- **The header is frozen at both ends**: serve() computes and serializes
  it once before the loop (serve.py:200-207); the viewer parses it once
  at boot into a closure-captured const (main.ts:1271); the host peeks
  and caches it once (extension.ts:292-305).
- **The cache**: Map keyed by chunk index, entries `{payload, bytes,
  lastUsed}` — no shape/epoch tag, never revalidated after arrival, LRU
  eviction outside a protected prefetch window, no invalidation surface,
  duplicate arrivals dropped (playback.ts:40-47, 161-235).
- **The applier**: per-flip, one path for all axes; a bound channel whose
  block is MISSING from the displayed chunk is skipped — the axis buffer
  silently HOLDS the last derived values (main.ts:2049-2050). The bind
  GATE, by contrast, is loud: it refuses to create a bind when the
  displayed chunk lacks the block (channelmap.ts:132-134).
- **Two frozen mirrors of the channel list** (the silent-skip traps):
  `channelScopeByName`, built once at boot (main.ts:2044) and consulted
  per flip; and the host's cached header peek. The command-layer reads
  (`ctx.channels()`, `channelValues()`) are LIVE — they re-read
  `header.channels` per call (main.ts:2416-2426).
- **Mods**: `MOD_PRODUCES = [per-point-scalar, per-frame-series, scatter,
  commands, figure]`, single-sourced with equality guards on the parser,
  the write_mod schema, and the closed typed-result union — a new kind is
  a designed-for one-list change (recipes.ts:45; claudetools.ts:233;
  recipes.test.ts:304; claudebackend.test.ts:240). run_mod's reply is the
  established seam for kind-shaped payloads (figure's dict arm is the
  newest precedent, serve.py:108-128). The producer process holds the
  data source alive across requests.

## 1. THE RULING: (b) in-band runtime declaration — with a different
## shape than the recorded lean sketched

**The conversational property wins, and the code makes it cheaper than
P-7 priced it.** Weighed honestly:

*For (a) declare-at-load*: zero protocol change; registration slots
cleanly into `build_source()` before the header freeze; every consumer
mechanism works untouched. It is genuinely cheap.

*Against (a)*: a computation authored mid-session cannot surface without
a reload — and a reload here does not just refetch a header, it destroys
the session (selections, bindings, camera, the transcript's context).
The brief's criterion 1 says the conversational property IS the product;
(a) deletes it for exactly the newest thing the session just made. And
criterion 2 is real in this codebase: nothing that ships as "the simple
first step" here has ever been replaced — floors calcify.

*For (b), at its real measured cost*: P-7 priced (b) as "a new additive
message kind + re-request of cached chunks." The site map shrinks both
halves:

1. **No new wire message kind.** The transport forbids unsolicited push
   (correlation would break), but the declaration doesn't need one: it
   rides the REPLY of the very `run_mod` request that computed the
   channel — the same plane `figure` and `commands` results already ride.
   The request vocabulary (`header`/`frames`/`run_mod`) is untouched.
2. **FIFO ordering makes chunk-in-flight impossible by construction**
   (see seam S1 below) — the scary case needs machinery only as a belt,
   not as the mechanism.
3. **"Re-request of cached chunks" becomes lazy per-chunk upgrade** —
   bounded, on demand, no thundering refetch (seam S2).

**What (b) actually touches** (the honest bill):
- Both twins + SPEC (one commit, round-trip-guarded): a `ChannelDelta`
  construct (append-only declarations, validated with the header's own
  channel rules: name uniqueness across ALL scopes, scope, components
  1|3, min/max forbidden at components 3), and chunk validation
  generalized from "the header's set" to "the declared set AS OF THE
  REQUEST" (exact set equality per epoch — never subset-tolerant).
  SPEC 0.1.0 → 0.2.0 (logical schema; envelope untouched).
- Producer: run_mod grows a `channel` arm — it validates the mod's
  values (length N×T×components, finite), installs data + header
  mutation ATOMICALLY (encode_frame_chunk indexes chunk.channels by every
  declared name, so declaration and population must land in one step or
  every later `frames` reply raises), and replies with the declaration.
- Viewer, at the existing mod-run boundary: apply the declaration —
  mutate `header.channels` in place (the live command-layer reads then
  see it), refresh `channelScopeByName` (frozen mirror #1), and add a
  guard test asserting no OTHER derived-once copy of the channel list
  exists. The host's frozen peek (mirror #2) only matters for a future
  context advertisement — noted for the prompt pass, unchanged here.
- playback.ts: an `invalidate(chunkIdx)` surface (drop entry + fix
  accounting) — the one consumer-adjacent change, and it is plumbing the
  new channel needs to REACH the existing applier, not a new consumer.

**What would make this ruling wrong** (watch for these):
- If the producer ever answers out of order or in parallel, the S1
  by-construction proof dies — the per-request captured declaration set
  (the belt) then becomes the mechanism, and it must already be tested.
- If mods routinely produce channels on datasets where N×T×3×4 bytes is
  producer-prohibitive (6000×600×3 ≈ 43 MB is fine; 10⁶ points would not
  be), the producer needs spill-or-recompute — a different brief.
- If the frozen-mirror class keeps growing (a third derived-once copy of
  the channel list appears), the in-place-mutation design becomes
  whack-a-mole — the no-other-mirrors guard test is the tripwire.
- If session-restart semantics surprise users (produced channels DIE with
  the producer; a reload loses them by design — recompute re-declares),
  the honest fix is persistence of the mod invocation, not of the data.

Also ruled: ONE new produces kind, **`channel`**, covering scalar AND
vector through the declared `components` — not a width-specific kind
(generality criterion: the mechanism carries any produced channel).
Scope is `per_point_per_frame` only: that is the contract's channel
model; edge/vertex axes already derive from point channels in the
consumer (endpoint mean), and adding new element-kind channels to the
contract is a different, out-of-scope change. Re-declaring the same name
with the same shape REPLACES the data (recompute-and-see, the
conversational loop); the same name with a DIFFERENT shape is rejected by
name.

## 2. The seams, enumerated — what I can prove, test, and NOT test

**S1 — chunk in flight when the declaration lands: impossible by
construction, and I cannot construct it to test it.** The declaration
rides the run_mod REPLY. Replies are strictly FIFO with requests, and the
producer is one serial loop. Any `frames` request issued BEFORE the
declaring run_mod gets its reply BEFORE the run_mod's reply (old-shape,
validated against the old set — correct). Any `frames` request issued
AFTER queues behind the compute and is built from the post-mutation
header (new-shape — correct). There is no interleaving in which an
old-shape chunk arrives after the viewer applies the declaration.
*What I will test*: the ordering assertion itself (request frames, then
run the declaring mod; assert the chunk validated old-shape and the
declaration applied after) and the belt (validation uses the
request-time set, unit-tested by forging the out-of-order case at the
function level). *What I cannot test*: a true concurrent in-flight
arrival — the transport cannot produce one. I am saying so rather than
manufacturing a fake proof; the belt exists precisely because this proof
is architectural, not exercised.

**S2 — cached chunk read after the declaration: real, and the ruled
behavior must replace today's silent hold.** A pre-declaration chunk in
the cache is never revalidated; the applier's missing-block arm today
HOLDS the last derived values silently (main.ts:2049-2050) — stale, not
zeros. Ruled behavior: on flip to a chunk lacking a BOUND channel's
block, the viewer requests that chunk's upgrade (the new invalidate +
re-request path) and holds the previous derived values ONLY until the
refetch lands — a transient of one round-trip that converges, versus
today's forever-hold. The bind gate already refuses to CREATE a binding
at such a frame, loudly. *Testable end-to-end*: cache frame F, declare,
seek to F, assert the refetch fires, the axis converges to the computed
values, and the accounting reflects the larger envelope. I will also pin
the transient explicitly (the one flip between seek and refetch shows
held values) so the behavior is documented by a test, not discovered.

**S3 — eviction across the boundary: two shapes coexist; the invariant
is per-chunk block presence.** Nothing tags a cached entry's shape; an
entry evicted pre-declaration and refetched post-declaration re-enters
new-shape beside old-shape neighbors. The applier's obligations under a
mixed cache: block presence checked per chunk by name (already true);
missing block has the RULED semantics from S2; present block lengths are
arrival-validated. Entry shape is derivable from the decoded chunk itself
(its block names) — no wire change needed for the cache to know what it
holds. *Testable end-to-end*: force the cache bound, evict F, declare,
re-request F, assert mixed-cache reads on both sides of the boundary and
that accounting never drifts (old entries keep old sizes; the
never-evict prefetch window keeps working).

**Non-seam confirmations from the map**: cache accounting counts a
late-added block correctly today (entries store their own byte size);
the binding registry needs zero change (name-based, coverage-only); undo
(bind/unbind with LWW-clear) is untouched.

## 3. The coherence contract — template and docs (first-class)

The template (`.molaro/mods/`, geometric example) makes the correct case
the lazy case: compute each frame's vectors, then seed continuity from
the previous frame —

```python
# frame-to-frame coherence: the renderer draws exactly what you supply.
# Seed each frame from the last: flip any vector whose direction reverses
# against its predecessor, so the drawn orientation never snaps.
for f in range(1, n_frames):
    for e in range(n_elements):
        if dot(v[f][e], v[f-1][e]) < 0.0:
            v[f][e] = negate(v[f][e])
```

The one docs sentence, where a mod author will read it: **"A producer
emitting a per-element direction owns its frame-to-frame coherence — seed
each frame from the previous frame's result (e.g. flip any vector whose
dot product with its predecessor is negative), because the renderer
faithfully draws exactly what you supply, discontinuities included."**

**The diagnostic: ship it (cheap, warning-only).** At declaration time
the producer runs one O(N×T) pass over adjacent frames; if any element's
vector inverts (negative dot) or swings past a threshold between adjacent
frames, the mod's outcome line carries a WARNING naming the channel and
the count — turning a confusing visual defect into a named data problem.
Never a refusal: coherence is the producer's responsibility, and the
contract's job is to make the breach visible, not to guess intent.

## 4. Validation design (HEAVY, per the brief)

- Cross-language round-trip on the declaration and on chunks BOTH sides
  of a declaration boundary, pinned at two (frame, element) sites for
  BOTH widths — the vector-channel precedent extended by the epoch axis.
- Every rejection fires by name and leaves nothing behind: name
  collision (any scope), bad width, bad scope, bad length, non-finite
  values, min/max on a vector — each asserted to reject with no
  half-declared channel, no producer-side data installed, no header
  mutation (atomicity tested by asserting a follow-up `frames` request
  still validates old-shape).
- The additive invariant: a dataset that never runs a channel mod is
  byte-identical, header and chunks — asserted by hashing both before
  and after a session that exercises everything EXCEPT the new kind.
- The lifecycle end-to-end on the synthetic fixture: a mod declares a
  channel → it lists as bindable → binds to an axis → animates across a
  frame flip → one undo removes the binding (channel remains declared —
  data is data; the binding is the undoable act).
- The three seams as specified in §2, with S1's untestable half stated
  in the report, not papered over.
- MOD_PRODUCES grows to six through the existing single-source; every
  equality guard updated in the same commit that opens the list.
- Full lane before commit; pixel pins byte-identical.

## 5. What the prompt pass will need (noted per §6, not acted on)

A produced channel, once declared, is bound through the SAME machinery as
header channels — the assistant needs only: the new `produces: channel`
kind (declaration fields + the coherence sentence + a pointer at the
template, not the schema), and the fact that channels it produces become
visible to `bake`/`bind` immediately, no reload. The host's frozen header
peek means any future context advertisement of the LIVE channel list
must read it from the viewer, not the host cache.
