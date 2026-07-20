/**
 * Point-series data contract — TypeScript side.
 *
 * Implements SPEC.md v0.1.0: Header / Channel / FrameChunk types, parsing,
 * binary envelope decoding, and validation. Zero dependencies; no knowledge
 * of rendering or of any data source.
 */

export const VERSION = "0.1.0";
export const ENVELOPE_VERSION = 1;
export const MAGIC = "PCFC";

export type ChannelScope = "per_point" | "per_frame" | "per_point_per_frame";
export const SCOPES: readonly ChannelScope[] = [
  "per_point",
  "per_frame",
  "per_point_per_frame",
];

export interface Channel {
  name: string;
  scope: ChannelScope;
  dtype: "float32";
  min?: number;
  max?: number;
  /** Values per element (default 1). 3 declares a VECTOR channel — three
   * float32 per element, interleaved (x,y,z per element), riding the same
   * blocks/validation/caching as any channel. Every length rule below
   * scales by this factor; nothing else about the wire format changes. */
  components?: 1 | 3;
  /** Present for per_point (length N×components) and per_frame (length
   * T×components); absent otherwise. */
  data?: number[];
}

/** A channel's per-element width (components defaults to 1). */
export function channelComponents(c: Channel): number {
  return c.components ?? 1;
}

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** Columnar per-point attributes; every array has length n_points. */
export interface Points {
  type: string[];
  group_id: number[];
  subgroup_id: number[];
  category: number[]; // indices into Header.categories
}

export interface Header {
  version: string;
  name: string;
  n_points: number;
  n_frames: number;
  units: string;
  bbox: BBox | null;
  points: Points;
  categories: string[];
  groups: Record<string, string>; // group_id (decimal string) -> label
  subgroups: Record<string, string>; // subgroup_id (decimal string) -> label
  edges: [number, number][];
  polylines: number[][];
  channels: Channel[];
}

/**
 * Frames [start, start+count). Typed views over the received buffer (no copy):
 * positions is count*N*3 float32, frame-major; each channel is count*N float32.
 */
export interface FrameChunk {
  start: number;
  count: number;
  positions: Float32Array;
  channels: Map<string, Float32Array>;
}

export interface HeaderRequest {}

export interface FrameChunkRequest {
  start: number;
  count: number;
}

export class ContractError extends Error {}

function fail(msg: string): never {
  throw new ContractError(msg);
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** Parse and validate a Header from its JSON text. */
export function parseHeader(text: string): Header {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(`header: invalid JSON: ${e}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("header: expected a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const header: Header = {
    version: o.version as string,
    name: o.name as string,
    n_points: o.n_points as number,
    n_frames: o.n_frames as number,
    units: o.units as string,
    bbox: (o.bbox ?? null) as BBox | null,
    points: o.points as Points,
    categories: o.categories as string[],
    groups: (o.groups ?? {}) as Record<string, string>,
    subgroups: (o.subgroups ?? {}) as Record<string, string>,
    edges: o.edges as [number, number][],
    polylines: o.polylines as number[][],
    channels: o.channels as Channel[],
  };
  validateHeader(header);
  return header;
}

export function perPointPerFrameChannels(header: Header): Channel[] {
  return header.channels.filter((c) => c.scope === "per_point_per_frame");
}

// ---------------------------------------------------------------------------
// FrameChunk binary envelope decoding
// ---------------------------------------------------------------------------

interface BlockDescriptor {
  kind: "positions" | "channel";
  name?: string;
  byte_length: number;
}

/**
 * Decode the binary envelope (SPEC.md). Structural checks only; call
 * validateFrameChunk(chunk, header) to check against a Header.
 *
 * The returned Float32Arrays are zero-copy views into `data`'s buffer
 * (the 4-byte alignment of every block is guaranteed by the spec).
 */
// Blocks are consumed as zero-copy Float32Array views, which use platform byte
// order; the wire format is little-endian, so refuse to run on BE platforms.
const PLATFORM_IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function decodeFrameChunk(data: Uint8Array): FrameChunk {
  if (!PLATFORM_IS_LE) {
    fail("frame chunk: platform is big-endian; zero-copy float32 views would misread LE data");
  }
  if (data.byteLength < 12) fail("frame chunk: envelope shorter than 12 bytes");
  if (data.byteOffset % 4 !== 0) {
    // Float32Array views need 4-byte alignment within the underlying buffer;
    // re-copy the rare unaligned input (e.g. a slice of Node's Buffer pool).
    data = new Uint8Array(data);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (magic !== MAGIC) fail("frame chunk: bad magic, expected 'PCFC'");
  const envVersion = view.getUint32(4, true);
  if (envVersion !== ENVELOPE_VERSION) {
    fail(`frame chunk: unsupported envelope version ${envVersion}`);
  }
  const descLen = view.getUint32(8, true);
  if (descLen % 4 !== 0) fail("frame chunk: descriptor length not a multiple of 4");
  if (data.byteLength < 12 + descLen) fail("frame chunk: truncated descriptor");

  let desc: {
    start?: unknown;
    count?: unknown;
    n_points?: unknown;
    blocks?: BlockDescriptor[];
  };
  try {
    desc = JSON.parse(new TextDecoder().decode(data.subarray(12, 12 + descLen)));
  } catch (e) {
    fail(`frame chunk: bad descriptor JSON: ${e}`);
  }
  const blocks = desc.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    fail("frame chunk: descriptor has no blocks");
  }
  if (!Number.isInteger(desc.start)) fail("frame chunk: descriptor field 'start' must be an integer");
  if (!Number.isInteger(desc.count)) fail("frame chunk: descriptor field 'count' must be an integer");

  let offset = data.byteOffset + 12 + descLen;
  let positions: Float32Array | null = null;
  const channels = new Map<string, Float32Array>();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const length = block.byte_length;
    if (!Number.isInteger(length) || length < 0 || length % 4 !== 0) {
      fail(`frame chunk: block ${i} has bad byte_length ${length}`);
    }
    if (offset + length > data.byteOffset + data.byteLength) {
      fail(`frame chunk: block ${i} overruns the envelope`);
    }
    // Alignment: 12 + descLen is a multiple of 4 and so is every block length,
    // so this offset is 4-byte aligned relative to a 4-byte-aligned data view.
    const payload = new Float32Array(data.buffer, offset, length / 4);
    offset += length;
    if (block.kind === "positions") {
      if (i !== 0 || positions !== null) {
        fail("frame chunk: positions must be the single first block");
      }
      positions = payload;
    } else if (block.kind === "channel") {
      if (typeof block.name !== "string") fail(`frame chunk: channel block ${i} missing name`);
      if (channels.has(block.name)) fail(`frame chunk: duplicate channel block '${block.name}'`);
      channels.set(block.name, payload);
    } else {
      fail(`frame chunk: unknown block kind '${(block as { kind: string }).kind}'`);
    }
  }
  if (positions === null) fail("frame chunk: missing positions block");
  if (offset !== data.byteOffset + data.byteLength) {
    fail("frame chunk: trailing bytes after last block");
  }
  return {
    start: desc.start as number,
    count: desc.count as number,
    positions,
    channels,
  };
}

/**
 * Total byte size the envelope claims for itself (12 + descriptor + blocks),
 * or null if `data` does not start like a FrameChunk envelope. Lets a
 * transport cheaply cross-check its outer message length against the
 * envelope's self-described size to detect stream desync.
 */
export function frameChunkEnvelopeSize(data: Uint8Array): number | null {
  if (data.byteLength < 12) return null;
  if (String.fromCharCode(data[0], data[1], data[2], data[3]) !== MAGIC) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const descLen = view.getUint32(8, true);
  if (descLen % 4 !== 0 || data.byteLength < 12 + descLen) return null;
  try {
    const desc = JSON.parse(new TextDecoder().decode(data.subarray(12, 12 + descLen)));
    if (!Array.isArray(desc.blocks)) return null;
    let size = 12 + descLen;
    for (const block of desc.blocks) {
      if (!Number.isInteger(block?.byte_length) || block.byte_length < 0) return null;
      size += block.byte_length;
    }
    return size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation (SPEC.md "Validation rules")
// ---------------------------------------------------------------------------

function isInt(v: unknown): v is number {
  return Number.isInteger(v);
}

export function validateHeader(h: Header): void {
  for (const [name, value] of [
    ["version", h.version],
    ["name", h.name],
    ["units", h.units],
  ] as const) {
    if (typeof value !== "string") fail(`header: ${name} must be a string`);
  }
  for (const [name, value] of [
    ["n_points", h.n_points],
    ["n_frames", h.n_frames],
  ] as const) {
    if (!isInt(value) || value < 0) {
      fail(`header: ${name} must be a non-negative integer`);
    }
  }

  const n = h.n_points;
  if (typeof h.points !== "object" || h.points === null) fail("header: points must be an object");
  const cols: [string, unknown[]][] = [
    ["type", h.points.type],
    ["group_id", h.points.group_id],
    ["subgroup_id", h.points.subgroup_id],
    ["category", h.points.category],
  ];
  for (const [name, col] of cols) {
    if (!Array.isArray(col) || col.length !== n) {
      fail(`header: points.${name} must be a list of length n_points (${n})`);
    }
  }
  if (!h.points.type.every((t) => typeof t === "string")) {
    fail("header: points.type entries must be strings");
  }
  for (const name of ["group_id", "subgroup_id", "category"] as const) {
    if (!h.points[name].every(isInt)) fail(`header: points.${name} entries must be integers`);
  }
  if (!Array.isArray(h.categories) || !h.categories.every((c) => typeof c === "string")) {
    fail("header: categories must be a list of strings");
  }
  const nCat = h.categories.length;
  for (let p = 0; p < n; p++) {
    const c = h.points.category[p];
    if (c < 0 || c >= nCat) {
      fail(`header: points.category[${p}] = ${c} out of range [0, ${nCat})`);
    }
  }

  const subgroupOwner = new Map<number, number>();
  for (let p = 0; p < n; p++) {
    const sg = h.points.subgroup_id[p];
    const g = h.points.group_id[p];
    const owner = subgroupOwner.get(sg);
    if (owner === undefined) subgroupOwner.set(sg, g);
    else if (owner !== g) fail(`header: subgroup ${sg} belongs to multiple groups`);
  }

  if (!Array.isArray(h.edges)) fail("header: edges must be a list");
  h.edges.forEach((e, i) => {
    if (!Array.isArray(e) || e.length !== 2) fail(`header: edges[${i}] must be a pair`);
    for (const idx of e) {
      if (!isInt(idx) || idx < 0 || idx >= n) {
        fail(`header: edges[${i}] index ${idx} out of range [0, ${n})`);
      }
    }
  });
  if (!Array.isArray(h.polylines)) fail("header: polylines must be a list");
  h.polylines.forEach((poly, i) => {
    if (!Array.isArray(poly) || poly.length < 2) {
      fail(`header: polylines[${i}] must have at least 2 indices`);
    }
    for (const idx of poly) {
      if (!isInt(idx) || idx < 0 || idx >= n) {
        fail(`header: polylines[${i}] index ${idx} out of range [0, ${n})`);
      }
    }
  });

  if (h.bbox !== null && h.bbox !== undefined) {
    if (
      !Array.isArray(h.bbox.min) ||
      !Array.isArray(h.bbox.max) ||
      h.bbox.min.length !== 3 ||
      h.bbox.max.length !== 3
    ) {
      fail("header: bbox min/max must have 3 components");
    }
    for (let k = 0; k < 3; k++) {
      if (h.bbox.min[k] > h.bbox.max[k]) fail(`header: bbox.min[${k}] > bbox.max[${k}]`);
    }
  }

  if (!Array.isArray(h.channels)) fail("header: channels must be a list");
  const seen = new Set<string>();
  for (const ch of h.channels) {
    if (typeof ch.name !== "string" || ch.name === "") {
      fail("header: channel name must be a non-empty string");
    }
    if (seen.has(ch.name)) fail(`header: duplicate channel name '${ch.name}'`);
    seen.add(ch.name);
    if (!SCOPES.includes(ch.scope)) fail(`header: channel '${ch.name}': unknown scope '${ch.scope}'`);
    if (ch.dtype !== "float32") fail(`header: channel '${ch.name}': unsupported dtype '${ch.dtype}'`);
    if (ch.min !== undefined && ch.max !== undefined && ch.min > ch.max) {
      fail(`header: channel '${ch.name}': min > max`);
    }
    if (ch.components !== undefined && ch.components !== 1 && ch.components !== 3) {
      fail(`header: channel '${ch.name}': components must be 1 or 3, got ${ch.components}`);
    }
    if (channelComponents(ch) === 3 && (ch.min !== undefined || ch.max !== undefined)) {
      // A scalar range over a 3-vector has no defined meaning in v0.1.0 —
      // rejecting beats letting producers ship a number consumers would guess at.
      fail(`header: channel '${ch.name}': min/max are not defined for vector channels (components: 3)`);
    }
    if (ch.scope === "per_point_per_frame") {
      if (ch.data !== undefined) {
        fail(`header: channel '${ch.name}': per_point_per_frame must not carry data in the header`);
      }
    } else {
      const expected = (ch.scope === "per_point" ? n : h.n_frames) * channelComponents(ch);
      if (!Array.isArray(ch.data) || ch.data.length !== expected) {
        fail(`header: channel '${ch.name}': data must have length ${expected}`);
      }
    }
  }
}

export function validateFrameChunk(chunk: FrameChunk, header: Header): void {
  validateFrameChunkAgainst(chunk, header.n_frames, header.n_points, header.channels);
}

/**
 * Validate a chunk against an EXPLICIT channel list instead of a Header.
 *
 * This exists for channel deltas (see SPEC.md "Channel deltas"): once the
 * declared set can grow mid-session, a chunk must be validated against the
 * set AS OF ITS REQUEST — the caller captures `channels` when the request
 * is sent and validates the reply against that capture, so a reply built
 * before a later delta never races the delta's application. Exact set
 * equality is preserved per epoch; nothing is subset-tolerant.
 * `channels` may be a full channel list; only its per_point_per_frame
 * entries participate.
 */
export function validateFrameChunkAgainst(
  chunk: FrameChunk,
  nFrames: number,
  nPoints: number,
  channels: Channel[],
): void {
  if (!isInt(chunk.count) || chunk.count < 1) fail("frame chunk: count must be >= 1");
  if (!isInt(chunk.start) || chunk.start < 0 || chunk.start + chunk.count > nFrames) {
    fail(
      `frame chunk: frame range [${chunk.start}, ${chunk.start + chunk.count}) ` +
        `outside [0, ${nFrames})`,
    );
  }
  const expectedPos = chunk.count * nPoints * 3;
  if (chunk.positions.length !== expectedPos) {
    fail(
      `frame chunk: positions block has ${chunk.positions.length} floats, expected ${expectedPos}`,
    );
  }
  const streamed = channels.filter((c) => c.scope === "per_point_per_frame");
  const got = [...chunk.channels.keys()].sort();
  const want = streamed.map((c) => c.name).sort();
  if (got.length !== want.length || got.some((name, i) => name !== want[i])) {
    fail(
      `frame chunk: channel blocks [${got}] do not match declared ` +
        `per_point_per_frame channels [${want}]`,
    );
  }
  for (const ch of streamed) {
    const arr = chunk.channels.get(ch.name) as Float32Array;
    const expectedCh = chunk.count * nPoints * channelComponents(ch);
    if (arr.length !== expectedCh) {
      fail(
        `frame chunk: channel '${ch.name}' block has ${arr.length} floats, expected ${expectedCh}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Channel deltas (SPEC.md "Channel deltas" — session extension, wire-format
// compatible: a delta-extended header is a valid 0.1.0 header)
// ---------------------------------------------------------------------------

/**
 * Parse and validate a channel DELTA: the declaration of ONE additional
 * `per_point_per_frame` channel to append to a header's set mid-session.
 * One delta = one channel — atomicity is trivial and a rejection leaves
 * nothing half-declared. Fail-closed on shape: only streamed scope, only
 * float32, components 1|3, min/max under the header's own channel rules
 * (forbidden for vectors), and NEVER inline data (streamed channels carry
 * values only in FrameChunks).
 */
export function parseChannelDelta(raw: unknown): Channel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("channel delta: expected an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name === "") {
    fail("channel delta: name must be a non-empty string");
  }
  // A channel is referenced by name in `bind`/`bake`, which tokenize on
  // whitespace — a name with a space (or other non-token character) declares
  // fine but can never be bound. Reject it HERE, loudly, at declaration
  // (a single token: a letter, then letters/digits/_/-) instead of leaving a
  // channel that exists but is unaddressable.
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(o.name)) {
    fail(
      `channel delta: channel name '${o.name}' must be a single token — a letter ` +
        `followed by letters, digits, '_' or '-' (no spaces) — so bind/bake can reference it`,
    );
  }
  if (o.scope !== "per_point_per_frame") {
    fail(
      `channel delta: channel '${o.name}': scope must be 'per_point_per_frame' ` +
        `(got '${o.scope}') — per_point/per_frame data channels belong in the header`,
    );
  }
  if (o.dtype !== "float32") {
    fail(`channel delta: channel '${o.name}': unsupported dtype '${o.dtype}'`);
  }
  if (o.components !== undefined && o.components !== 1 && o.components !== 3) {
    fail(`channel delta: channel '${o.name}': components must be 1 or 3, got ${o.components}`);
  }
  const components = (o.components as 1 | 3 | undefined) ?? undefined;
  for (const k of ["min", "max"] as const) {
    if (o[k] !== undefined && typeof o[k] !== "number") {
      fail(`channel delta: channel '${o.name}': ${k} must be a number`);
    }
  }
  if (components === 3 && (o.min !== undefined || o.max !== undefined)) {
    fail(
      `channel delta: channel '${o.name}': min/max are not defined for vector channels (components: 3)`,
    );
  }
  if (o.min !== undefined && o.max !== undefined && (o.min as number) > (o.max as number)) {
    fail(`channel delta: channel '${o.name}': min > max`);
  }
  if (o.data !== undefined) {
    fail(`channel delta: channel '${o.name}': a streamed channel never carries inline data`);
  }
  const delta: Channel = { name: o.name, scope: "per_point_per_frame", dtype: "float32" };
  if (components !== undefined) delta.components = components;
  if (o.min !== undefined) delta.min = o.min as number;
  if (o.max !== undefined) delta.max = o.max as number;
  return delta;
}

/**
 * Append a validated delta to a header's channel set. Fail-closed: the name
 * must be unique across ALL scopes (the header's one namespace), and the
 * post-append header is re-validated as a belt — on ANY failure the header
 * is left untouched. Application only ever APPENDS; existing declarations
 * are never mutated, removed, or reordered, so every earlier channel set is
 * a prefix of every later one.
 */
export function applyChannelDelta(header: Header, delta: Channel): void {
  if (header.channels.some((c) => c.name === delta.name)) {
    fail(`channel delta: channel name '${delta.name}' is already declared`);
  }
  header.channels.push(delta);
  try {
    validateHeader(header);
  } catch (e) {
    header.channels.pop();
    throw e;
  }
}

/**
 * Index helpers for the frame-major layouts (SPEC.md "Block payloads").
 * `f` is an absolute frame index within [chunk.start, chunk.start + chunk.count).
 */
export function positionIndex(chunk: FrameChunk, nPoints: number, f: number, p: number): number {
  return ((f - chunk.start) * nPoints + p) * 3;
}

/** Index of element p's FIRST value at frame f in a channel block. For a
 * scalar channel this is the value; for a vector channel (components = 3)
 * the element's values are the `components` consecutive floats from here. */
export function channelIndex(
  chunk: FrameChunk,
  nPoints: number,
  f: number,
  p: number,
  components = 1,
): number {
  return ((f - chunk.start) * nPoints + p) * components;
}
