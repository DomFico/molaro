"""Point-series data contract — Python side.

Implements SPEC.md v0.1.0: Header / Channel / FrameChunk types, JSON + binary
(de)serialization, and validation. Stdlib only; no dependency on producer or
renderer code.
"""
from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

VERSION = "0.1.0"
ENVELOPE_VERSION = 1
MAGIC = b"PCFC"

SCOPE_PER_POINT = "per_point"
SCOPE_PER_FRAME = "per_frame"
SCOPE_PER_POINT_PER_FRAME = "per_point_per_frame"
SCOPES = (SCOPE_PER_POINT, SCOPE_PER_FRAME, SCOPE_PER_POINT_PER_FRAME)

DTYPE_FLOAT32 = "float32"


class ContractError(ValueError):
    """Raised when a Header or FrameChunk violates the contract."""


@dataclass
class Channel:
    name: str
    scope: str
    dtype: str = DTYPE_FLOAT32
    min: Optional[float] = None
    max: Optional[float] = None
    # Values per element (None means 1). 3 declares a VECTOR channel — three
    # float32 per element, interleaved (x,y,z per element), riding the same
    # blocks/validation/caching as any channel; every length rule scales by
    # this factor and nothing else about the wire format changes.
    components: Optional[int] = None
    # Present for per_point (length N*components) and per_frame (length
    # T*components); None otherwise.
    data: Optional[List[float]] = None


def channel_components(c: Channel) -> int:
    """A channel's per-element width (components defaults to 1)."""
    return 1 if c.components is None else c.components


@dataclass
class BBox:
    min: Tuple[float, float, float]
    max: Tuple[float, float, float]


@dataclass
class Points:
    """Columnar per-point attributes; every list has length n_points."""

    type: List[str]
    group_id: List[int]
    subgroup_id: List[int]
    category: List[int]  # indices into Header.categories


@dataclass
class Header:
    version: str
    name: str
    n_points: int
    n_frames: int
    units: str
    points: Points
    categories: List[str]
    bbox: Optional[BBox] = None
    groups: Dict[int, str] = field(default_factory=dict)
    subgroups: Dict[int, str] = field(default_factory=dict)
    edges: List[Tuple[int, int]] = field(default_factory=list)
    polylines: List[List[int]] = field(default_factory=list)
    channels: List[Channel] = field(default_factory=list)
    # How the coordinates were PREPARED before streaming — one plain sentence
    # per transformation, or empty when they are the file's own. The viewer and
    # the mods see the same coordinates (there is no display-only transform), so
    # this is what makes that preparation visible instead of implicit.
    provenance: List[str] = field(default_factory=list)

    def per_point_per_frame_channels(self) -> List[Channel]:
        return [c for c in self.channels if c.scope == SCOPE_PER_POINT_PER_FRAME]


@dataclass
class FrameChunk:
    """Frames [start, start+count). Binary payloads are raw LE float32 bytes.

    positions: count * n_points * 3 float32, frame-major (see SPEC.md).
    channels: name -> count * n_points float32, one entry per declared
              per_point_per_frame channel.
    """

    start: int
    count: int
    positions: bytes
    channels: Dict[str, bytes] = field(default_factory=dict)


@dataclass
class HeaderRequest:
    pass


@dataclass
class FrameChunkRequest:
    start: int
    count: int


# ---------------------------------------------------------------------------
# Header JSON (de)serialization
# ---------------------------------------------------------------------------

def header_to_json(header: Header) -> str:
    obj: Dict[str, Any] = {
        "version": header.version,
        "name": header.name,
        "n_points": header.n_points,
        "n_frames": header.n_frames,
        "units": header.units,
        "bbox": (
            {"min": list(header.bbox.min), "max": list(header.bbox.max)}
            if header.bbox is not None
            else None
        ),
        "points": {
            "type": header.points.type,
            "group_id": header.points.group_id,
            "subgroup_id": header.points.subgroup_id,
            "category": header.points.category,
        },
        "categories": header.categories,
        "groups": {str(k): v for k, v in header.groups.items()},
        "subgroups": {str(k): v for k, v in header.subgroups.items()},
        "edges": [list(e) for e in header.edges],
        "polylines": [list(p) for p in header.polylines],
        "channels": [_channel_to_obj(c) for c in header.channels],
        "provenance": list(header.provenance),
    }
    return json.dumps(obj)


def _channel_to_obj(c: Channel) -> Dict[str, Any]:
    obj: Dict[str, Any] = {"name": c.name, "scope": c.scope, "dtype": c.dtype}
    if c.min is not None:
        obj["min"] = c.min
    if c.max is not None:
        obj["max"] = c.max
    if c.components is not None:
        obj["components"] = c.components
    if c.data is not None:
        obj["data"] = c.data
    return obj


def header_from_json(text: str) -> Header:
    obj = json.loads(text)
    if not isinstance(obj, dict):
        raise ContractError("header: expected a JSON object")
    bbox_obj = obj.get("bbox")
    bbox = None
    if bbox_obj is not None:
        bbox = BBox(min=tuple(bbox_obj["min"]), max=tuple(bbox_obj["max"]))
    pts = obj["points"]
    header = Header(
        version=obj["version"],
        name=obj["name"],
        n_points=obj["n_points"],
        n_frames=obj["n_frames"],
        units=obj["units"],
        bbox=bbox,
        points=Points(
            type=pts["type"],
            group_id=pts["group_id"],
            subgroup_id=pts["subgroup_id"],
            category=pts["category"],
        ),
        categories=obj["categories"],
        groups={int(k): v for k, v in obj.get("groups", {}).items()},
        subgroups={int(k): v for k, v in obj.get("subgroups", {}).items()},
        edges=[(e[0], e[1]) for e in obj["edges"]],
        polylines=[list(p) for p in obj["polylines"]],
        channels=[
            Channel(
                name=c["name"],
                scope=c["scope"],
                dtype=c["dtype"],
                min=c.get("min"),
                max=c.get("max"),
                components=c.get("components"),
                data=c.get("data"),
            )
            for c in obj["channels"]
        ],
    )
    validate_header(header)
    return header


# ---------------------------------------------------------------------------
# FrameChunk binary envelope
# ---------------------------------------------------------------------------

def encode_frame_chunk(chunk: FrameChunk, header: Header) -> bytes:
    """Encode a FrameChunk per SPEC.md. Validates against the header first."""
    validate_frame_chunk(chunk, header)
    blocks: List[Tuple[Dict[str, Any], bytes]] = [
        ({"kind": "positions", "byte_length": len(chunk.positions)}, chunk.positions)
    ]
    for ch in header.per_point_per_frame_channels():
        payload = chunk.channels[ch.name]
        blocks.append(
            ({"kind": "channel", "name": ch.name, "byte_length": len(payload)}, payload)
        )
    descriptor = {
        "start": chunk.start,
        "count": chunk.count,
        "n_points": header.n_points,
        "blocks": [b[0] for b in blocks],
    }
    desc_bytes = json.dumps(descriptor).encode("utf-8")
    if len(desc_bytes) % 4:
        desc_bytes += b" " * (4 - len(desc_bytes) % 4)
    out = bytearray()
    out += MAGIC
    out += struct.pack("<II", ENVELOPE_VERSION, len(desc_bytes))
    out += desc_bytes
    for _, payload in blocks:
        out += payload
    return bytes(out)


def decode_frame_chunk(data: bytes) -> FrameChunk:
    """Decode the binary envelope. Structural checks only; call
    validate_frame_chunk(chunk, header) to check against a Header."""
    if len(data) < 12:
        raise ContractError("frame chunk: envelope shorter than 12 bytes")
    if data[0:4] != MAGIC:
        raise ContractError("frame chunk: bad magic, expected b'PCFC'")
    env_version, desc_len = struct.unpack_from("<II", data, 4)
    if env_version != ENVELOPE_VERSION:
        raise ContractError(f"frame chunk: unsupported envelope version {env_version}")
    if desc_len % 4:
        raise ContractError("frame chunk: descriptor length not a multiple of 4")
    if len(data) < 12 + desc_len:
        raise ContractError("frame chunk: truncated descriptor")
    try:
        desc = json.loads(data[12 : 12 + desc_len].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"frame chunk: bad descriptor JSON: {exc}") from exc

    blocks = desc.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise ContractError("frame chunk: descriptor has no blocks")
    offset = 12 + desc_len
    positions: Optional[bytes] = None
    channels: Dict[str, bytes] = {}
    for i, block in enumerate(blocks):
        length = block.get("byte_length")
        if not isinstance(length, int) or length < 0 or length % 4:
            raise ContractError(f"frame chunk: block {i} has bad byte_length {length!r}")
        if offset + length > len(data):
            raise ContractError(f"frame chunk: block {i} overruns the envelope")
        payload = data[offset : offset + length]
        offset += length
        kind = block.get("kind")
        if kind == "positions":
            if i != 0 or positions is not None:
                raise ContractError("frame chunk: positions must be the single first block")
            positions = payload
        elif kind == "channel":
            name = block.get("name")
            if not isinstance(name, str):
                raise ContractError(f"frame chunk: channel block {i} missing name")
            if name in channels:
                raise ContractError(f"frame chunk: duplicate channel block {name!r}")
            channels[name] = payload
        else:
            raise ContractError(f"frame chunk: unknown block kind {kind!r}")
    if positions is None:
        raise ContractError("frame chunk: missing positions block")
    if offset != len(data):
        raise ContractError("frame chunk: trailing bytes after last block")
    return FrameChunk(
        start=_require_int(desc, "start"),
        count=_require_int(desc, "count"),
        positions=positions,
        channels=channels,
    )


def _require_int(obj: Dict[str, Any], key: str) -> int:
    v = obj.get(key)
    if not isinstance(v, int) or isinstance(v, bool):
        raise ContractError(f"frame chunk: descriptor field {key!r} must be an integer")
    return v


# ---------------------------------------------------------------------------
# Validation (SPEC.md "Validation rules")
# ---------------------------------------------------------------------------

def validate_header(h: Header) -> None:
    def fail(msg: str) -> None:
        raise ContractError(f"header: {msg}")

    for name, value in (("version", h.version), ("name", h.name), ("units", h.units)):
        if not isinstance(value, str):
            fail(f"{name} must be a string")
    for name, value in (("n_points", h.n_points), ("n_frames", h.n_frames)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            fail(f"{name} must be a non-negative integer")

    n = h.n_points
    cols = {
        "type": h.points.type,
        "group_id": h.points.group_id,
        "subgroup_id": h.points.subgroup_id,
        "category": h.points.category,
    }
    for name, col in cols.items():
        if not isinstance(col, list) or len(col) != n:
            fail(f"points.{name} must be a list of length n_points ({n})")
    if not all(isinstance(t, str) for t in h.points.type):
        fail("points.type entries must be strings")
    for name in ("group_id", "subgroup_id", "category"):
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in cols[name]):
            fail(f"points.{name} entries must be integers")
    if not isinstance(h.categories, list) or not all(isinstance(c, str) for c in h.categories):
        fail("categories must be a list of strings")
    n_cat = len(h.categories)
    for p, c in enumerate(h.points.category):
        if not (0 <= c < n_cat):
            fail(f"points.category[{p}] = {c} out of range [0, {n_cat})")

    subgroup_owner: Dict[int, int] = {}
    for p in range(n):
        sg, g = h.points.subgroup_id[p], h.points.group_id[p]
        if subgroup_owner.setdefault(sg, g) != g:
            fail(f"subgroup {sg} belongs to multiple groups")

    for i, e in enumerate(h.edges):
        if len(e) != 2:
            fail(f"edges[{i}] must be a pair")
        for idx in e:
            if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx < n):
                fail(f"edges[{i}] index {idx!r} out of range [0, {n})")
    for i, poly in enumerate(h.polylines):
        if len(poly) < 2:
            fail(f"polylines[{i}] must have at least 2 indices")
        for idx in poly:
            if not isinstance(idx, int) or isinstance(idx, bool) or not (0 <= idx < n):
                fail(f"polylines[{i}] index {idx!r} out of range [0, {n})")

    if h.bbox is not None:
        if len(h.bbox.min) != 3 or len(h.bbox.max) != 3:
            fail("bbox min/max must have 3 components")
        for k in range(3):
            if h.bbox.min[k] > h.bbox.max[k]:
                fail(f"bbox.min[{k}] > bbox.max[{k}]")

    seen_names = set()
    for ch in h.channels:
        if not isinstance(ch.name, str) or not ch.name:
            fail("channel name must be a non-empty string")
        if ch.name in seen_names:
            fail(f"duplicate channel name {ch.name!r}")
        seen_names.add(ch.name)
        if ch.scope not in SCOPES:
            fail(f"channel {ch.name!r}: unknown scope {ch.scope!r}")
        if ch.dtype != DTYPE_FLOAT32:
            fail(f"channel {ch.name!r}: unsupported dtype {ch.dtype!r}")
        if ch.min is not None and ch.max is not None and ch.min > ch.max:
            fail(f"channel {ch.name!r}: min > max")
        if ch.components is not None and ch.components not in (1, 3):
            fail(f"channel {ch.name!r}: components must be 1 or 3, got {ch.components!r}")
        if channel_components(ch) == 3 and (ch.min is not None or ch.max is not None):
            # A scalar range over a 3-vector has no defined meaning in v0.1.0 —
            # rejecting beats letting producers ship a number consumers would
            # guess at.
            fail(f"channel {ch.name!r}: min/max are not defined for vector channels (components: 3)")
        if ch.scope == SCOPE_PER_POINT_PER_FRAME:
            if ch.data is not None:
                fail(f"channel {ch.name!r}: per_point_per_frame must not carry data in the header")
        else:
            base = n if ch.scope == SCOPE_PER_POINT else h.n_frames
            expected = base * channel_components(ch)
            if ch.data is None or len(ch.data) != expected:
                fail(f"channel {ch.name!r}: data must have length {expected}")


def validate_frame_chunk(chunk: FrameChunk, header: Header) -> None:
    validate_frame_chunk_against(chunk, header.n_frames, header.n_points, header.channels)


def validate_frame_chunk_against(
    chunk: FrameChunk, n_frames: int, n_points: int, channels: List[Channel]
) -> None:
    """Validate a chunk against an EXPLICIT channel list instead of a Header.

    Exists for channel deltas (SPEC.md "Channel deltas"): once the declared
    set can grow mid-session, a chunk must be validated against the set AS OF
    ITS REQUEST — the caller captures ``channels`` when the request is sent
    and validates the reply against that capture, so a reply built before a
    later delta never races the delta's application. Exact set equality is
    preserved per epoch; nothing is subset-tolerant. ``channels`` may be a
    full channel list; only its per_point_per_frame entries participate.
    """

    def fail(msg: str) -> None:
        raise ContractError(f"frame chunk: {msg}")

    if chunk.count < 1:
        fail("count must be >= 1")
    if chunk.start < 0 or chunk.start + chunk.count > n_frames:
        fail(
            f"frame range [{chunk.start}, {chunk.start + chunk.count}) outside "
            f"[0, {n_frames})"
        )
    expected_pos = chunk.count * n_points * 3 * 4
    if len(chunk.positions) != expected_pos:
        fail(f"positions block is {len(chunk.positions)} bytes, expected {expected_pos}")
    streamed = [c for c in channels if c.scope == SCOPE_PER_POINT_PER_FRAME]
    declared = [c.name for c in streamed]
    if sorted(chunk.channels.keys()) != sorted(declared):
        fail(
            f"channel blocks {sorted(chunk.channels.keys())} do not match declared "
            f"per_point_per_frame channels {sorted(declared)}"
        )
    for ch in streamed:
        got = len(chunk.channels[ch.name])
        expected_ch = chunk.count * n_points * channel_components(ch) * 4
        if got != expected_ch:
            fail(f"channel {ch.name!r} block is {got} bytes, expected {expected_ch}")


# ---------------------------------------------------------------------------
# Channel deltas (SPEC.md "Channel deltas" — session extension, wire-format
# compatible: a delta-extended header is a valid 0.1.0 header)
# ---------------------------------------------------------------------------

def channel_delta_to_obj(c: Channel) -> Dict[str, Any]:
    """Serialize a delta declaration (never includes data — streamed only)."""
    obj: Dict[str, Any] = {"name": c.name, "scope": c.scope, "dtype": c.dtype}
    if c.components is not None:
        obj["components"] = c.components
    if c.min is not None:
        obj["min"] = c.min
    if c.max is not None:
        obj["max"] = c.max
    return obj


def channel_delta_from_obj(raw: Any) -> Channel:
    """Parse and validate a channel DELTA: the declaration of ONE additional
    per_point_per_frame channel to append to a header's set mid-session.
    One delta = one channel — atomicity is trivial and a rejection leaves
    nothing half-declared. Fail-closed on shape: only streamed scope, only
    float32, components 1|3, min/max under the header's own channel rules
    (forbidden for vectors), and NEVER inline data (streamed channels carry
    values only in FrameChunks)."""

    def fail(msg: str) -> None:
        raise ContractError(f"channel delta: {msg}")

    if not isinstance(raw, dict):
        fail("expected an object")
    name = raw.get("name")
    if not isinstance(name, str) or not name:
        fail("name must be a non-empty string")
    # A channel is referenced by name in bind/bake, which tokenize on
    # whitespace — a name with a space (or other non-token character) declares
    # fine but can never be bound. Reject it HERE, at declaration (a single
    # token: a letter, then letters/digits/_/-) instead of leaving an
    # unaddressable channel.
    if not re.match(r"^[A-Za-z][A-Za-z0-9_-]*$", name):
        fail(
            f"channel name {name!r} must be a single token — a letter followed by "
            "letters, digits, '_' or '-' (no spaces) — so bind/bake can reference it"
        )
    if raw.get("scope") != SCOPE_PER_POINT_PER_FRAME:
        fail(
            f"channel {name!r}: scope must be 'per_point_per_frame' "
            f"(got {raw.get('scope')!r}) — per_point/per_frame data channels belong in the header"
        )
    if raw.get("dtype") != DTYPE_FLOAT32:
        fail(f"channel {name!r}: unsupported dtype {raw.get('dtype')!r}")
    components = raw.get("components")
    if components is not None and components not in (1, 3):
        fail(f"channel {name!r}: components must be 1 or 3, got {components!r}")
    for k in ("min", "max"):
        v = raw.get(k)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))):
            fail(f"channel {name!r}: {k} must be a number")
    if components == 3 and (raw.get("min") is not None or raw.get("max") is not None):
        fail(f"channel {name!r}: min/max are not defined for vector channels (components: 3)")
    if raw.get("min") is not None and raw.get("max") is not None and raw["min"] > raw["max"]:
        fail(f"channel {name!r}: min > max")
    if raw.get("data") is not None:
        fail(f"channel {name!r}: a streamed channel never carries inline data")
    return Channel(
        name=name,
        scope=SCOPE_PER_POINT_PER_FRAME,
        dtype=DTYPE_FLOAT32,
        min=raw.get("min"),
        max=raw.get("max"),
        components=components,
    )


def apply_channel_delta(header: Header, delta: Channel) -> None:
    """Append a validated delta to a header's channel set. Fail-closed: the
    name must be unique across ALL scopes (the header's one namespace), and
    the post-append header is re-validated as a belt — on ANY failure the
    header is left untouched. Application only ever APPENDS; existing
    declarations are never mutated, removed, or reordered, so every earlier
    channel set is a prefix of every later one."""
    if any(c.name == delta.name for c in header.channels):
        raise ContractError(f"channel delta: channel name {delta.name!r} is already declared")
    header.channels.append(delta)
    try:
        validate_header(header)
    except ContractError:
        header.channels.pop()
        raise
