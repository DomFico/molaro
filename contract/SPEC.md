# Point-Series Contract — SPEC v0.1.0

This document is the **authoritative** definition of the data contract between the
producer (Python) and the renderer (TypeScript). `contract.py` and `contract.ts`
implement this spec; if they disagree with this document, this document wins.

The contract carries **data, never appearance**: positions, connectivity, grouping,
labels, and named numeric channels. No colors, sizes, styles, or any visual concept.
Numeric channels are the open-ended extensibility slot a future styling layer maps
to visual properties.

## Terms

- **N** = `n_points` — number of points, fixed for the dataset.
- **T** = `n_frames` — number of frames (timesteps).
- A dataset is described by one **Header** (constant metadata, sent once) plus
  **FrameChunk**s (positions and time-varying channel values for contiguous frame
  ranges, streamed on demand). Nothing ever sends all frames at once.

## Logical protocol (message shapes only; no transport in this version)

- `HeaderRequest {}` → `Header`
- `FrameChunkRequest { start: int, count: int }` → `FrameChunk`
  - Constraint: `0 <= start`, `count >= 1`, `start + count <= n_frames`.

---

## Header (JSON, UTF-8)

A single JSON object. Per-point attributes are **columnar**: parallel arrays of
length N, indexed by point index `p ∈ [0, N)`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | string | yes | Contract version. This spec: `"0.1.0"`. |
| `name` | string | yes | Dataset identifier. |
| `n_points` | int ≥ 0 | yes | N. |
| `n_frames` | int ≥ 0 | yes | T. |
| `units` | string | yes | Label for the coordinate unit/scale. Opaque to the renderer; carried through. |
| `bbox` | object or `null` | no (default `null`) | `{ "min": [x,y,z], "max": [x,y,z] }`, min/max over all points and frames, if cheaply known. |
| `points` | object | yes | Columnar per-point attributes, see below. |
| `categories` | string[] | yes | Lookup table for `points.category`. Small fixed set assigned by the producer. |
| `groups` | object | no (default `{}`) | Map `group_id → label`. JSON keys are decimal-integer strings. |
| `subgroups` | object | no (default `{}`) | Map `subgroup_id → label`. JSON keys are decimal-integer strings. |
| `edges` | `[int, int][]` | yes (may be empty) | Unordered point-index pairs to connect. |
| `polylines` | `int[][]` | yes (may be empty) | Ordered index sequences; each traces a path through those points in order. Each has ≥ 2 indices. |
| `channels` | Channel[] | yes (may be empty) | Named numeric channels, see below. |

### `points` (all arrays length N)

| Field | Type | Meaning |
|---|---|---|
| `type` | string[] | Short category-of-point tag per point. |
| `group_id` | int[] | Top-level group per point. |
| `subgroup_id` | int[] | Mid-level subgroup per point. Hierarchy: point → subgroup → group. A subgroup belongs to exactly one group (every point of a subgroup has the same `group_id`). |
| `category` | int[] | Index into `categories`, per point. Every value in `[0, len(categories))`. |

### Channel

```json
{ "name": "...", "scope": "...", "dtype": "float32", "min": 0.0, "max": 1.0, "data": [...] }
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Unique among channels (all scopes share one namespace). |
| `scope` | string | yes | One of `"per_point"`, `"per_frame"`, `"per_point_per_frame"`. |
| `dtype` | string | yes | Only `"float32"` is defined in v0.1.0. |
| `min`, `max` | number | no | Optional range hint for later normalization. If both present, `min <= max`. **Forbidden when `components` is `3`** — a scalar range over a 3-vector has no defined meaning in v0.1.0. |
| `components` | int | no | Values **per element**: `1` (default when absent) or `3`. `3` declares a **vector** channel — three float32 per element, interleaved per element — riding the same blocks, validation, and caching as any channel. Every length rule in this spec scales by `components`; nothing else about the wire format changes. |
| `data` | number[] | scope-dependent | **Required** for `per_point` (length `N × components`) and `per_frame` (length `T × components`); **must be absent** for `per_point_per_frame` (values ship in FrameChunks). |

`per_point_per_frame` channels are *declared* here so the renderer knows what to
expect in every FrameChunk.

---

## FrameChunk (binary envelope)

Positions for a contiguous frame range `[start, start + count)`, plus the values of
every declared `per_point_per_frame` channel for those frames. Positions and channel
values are raw little-endian float32 — never JSON numbers.

### Envelope byte layout

All multi-byte integers are **little-endian**. Offsets in bytes.

```
offset  size  content
0       4     magic: ASCII "PCFC" (0x50 0x43 0x46 0x43)
4       4     uint32 LE: envelope format version = 1
8       4     uint32 LE: D = byte length of the (padded) JSON descriptor
12      D     JSON descriptor, UTF-8, right-padded with ASCII spaces (0x20)
              so that D is a multiple of 4
12+D    ...   binary blocks, concatenated in descriptor order, no gaps
```

Because 12 is a multiple of 4, D is a multiple of 4, and every block's byte length
is a multiple of 4, **every block starts at a 4-byte-aligned offset** — the renderer
can create `Float32Array` views directly over the received buffer with no copy.

### JSON descriptor

```json
{
  "start": 5,
  "count": 4,
  "n_points": 300,
  "blocks": [
    { "kind": "positions", "byte_length": 14400 },
    { "kind": "channel", "name": "energy", "byte_length": 4800 }
  ]
}
```

- `start`, `count`: the frame range (see protocol constraints above).
- `n_points`: must equal the Header's `n_points` (redundant, for validation).
- `blocks`: exactly one `positions` block, which must come **first**, followed by
  one `channel` block per declared `per_point_per_frame` channel, in the **same
  order** the channels are declared in the Header.

### Block payloads

- **positions**: `count × N × 3` float32 LE, `byte_length = count * N * 12`.
  **Frame-major** order: for each frame `f = start .. start+count-1`, for each point
  `p = 0 .. N-1`: `x, y, z`. The float32 for coordinate `c` (0=x, 1=y, 2=z) of point
  `p` at frame `f` begins at block-relative byte offset
  `((f - start) * N * 3 + p * 3 + c) * 4`.
- **channel** (per_point_per_frame): `count × N × components` float32 LE,
  `byte_length = count * N * components * 4` (`components` from the channel's
  declaration; 1 when absent). Frame-major: for each frame, N elements in point
  order, each element's `components` values consecutive. Element `p`'s first
  value at frame `f` begins at block-relative byte offset
  `((f - start) * N + p) * components * 4` (component `c` of the element is
  `c` float32s further on).

---

## Validation rules (both languages implement all of these)

Header:
1. `version`, `name`, `units` are strings; `n_points >= 0`, `n_frames >= 0` integers.
2. `points.type`, `points.group_id`, `points.subgroup_id`, `points.category` all
   have length N; ids are integers; every `category[p] ∈ [0, len(categories))`.
3. Every subgroup maps to exactly one group (no `subgroup_id` appears with two
   different `group_id`s).
4. Every edge is a pair `[i, j]` with `i, j ∈ [0, N)`. Every polyline has length
   ≥ 2 and every index in `[0, N)`.
5. `bbox`, if present, has 3-element numeric `min`/`max` with `min[k] <= max[k]`.
6. Channel names unique; scope is one of the three values; dtype is `"float32"`;
   `data` present with length N (`per_point`) / T (`per_frame`), absent for
   `per_point_per_frame`; if `min` and `max` both present, `min <= max`.

FrameChunk (envelope + against a Header):
1. Magic, version, descriptor padding/length as specified; total byte length equals
   `12 + D + sum(block byte_lengths)`.
2. `count >= 1`, `start >= 0`, `start + count <= n_frames`;
   descriptor `n_points == header.n_points`.
3. First block is `positions` with `byte_length == count * n_points * 12`.
4. The remaining blocks are exactly the Header's declared `per_point_per_frame`
   channels, in declaration order, each with `byte_length == count * n_points * 4`.

## Channel deltas (session extension — wire-format compatible)

A session's declared channel set may **grow** after the Header is served: a
**channel delta** declares ONE additional `per_point_per_frame` channel. The
wire format does not change — a delta-extended header is a valid `0.1.0`
header (just more channels), the envelope is untouched, and a dataset that
never applies a delta is byte-identical in every message.

Rules (both languages implement all of these):

1. A delta is a JSON object with the Channel fields `name`, `scope`, `dtype`,
   and optionally `components`, `min`, `max`. `scope` MUST be
   `per_point_per_frame` (data-carrying scopes belong in the Header);
   `dtype` MUST be `"float32"`; `data` MUST be absent. `components`, `min`,
   `max` follow the Header's channel rules (min/max forbidden for vectors).
2. One delta = one channel. Application is atomic: the name must be unique
   across the FULL current set (all scopes share one namespace); a rejected
   delta leaves the header untouched — nothing half-declared.
3. Application only ever APPENDS. Existing declarations are never mutated,
   removed, or reordered, so every earlier channel set is a prefix of every
   later one.
4. **A FrameChunk is validated against the channel set as of its REQUEST**,
   with exact set equality (never subset-tolerant). A reply built before a
   delta is valid against the pre-delta set; every chunk requested after a
   delta carries the new channel's block. Served chunks are never mutated.
5. A `HeaderRequest` answered after a delta reflects the current set —
   producers must not serve a stale cached serialization across a delta.
6. Deltas do not survive the producer: they are session state. A consumer
   that must persist a produced channel persists the computation that
   declared it, not the data.

The transport this repo ships is strictly FIFO request/response with a
serial producer, so a delta (which rides a reply) is totally ordered
against every chunk reply — an old-shape chunk can never arrive after the
delta that obsoletes it is applied. Implementations on a different
transport must preserve rule 4 by capturing the declared set per request.

## Versioning

`Header.version` versions the logical schema; the envelope carries its own format
version integer. Consumers must reject a Header whose major version they do not
understand. This spec defines `0.1.0` / envelope version `1`. Channel deltas
are a wire-compatible session extension of `0.1.0`, not a schema bump: every
header and chunk they produce validates under the `0.1.0` rules above (with
rule 4 of "Channel deltas" governing WHICH channel set a chunk is validated
against).
