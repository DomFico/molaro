/**
 * Cross-language contract test: reads the fixtures emitted by the Python
 * producer (tests/make_fixtures.py), parses them with the TypeScript contract
 * types, validates, and asserts the exact values Python recorded in
 * expected.json. Passing proves both languages agree on the wire format.
 *
 * Run from viewer/:  node --test tests/contract.test.ts
 * (Node >= 22.18 runs TypeScript natively; no dependencies needed.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContractError,
  decodeFrameChunk,
  parseHeader,
  positionIndex,
  channelIndex,
  validateFrameChunk,
  validateHeader,
  type FrameChunk,
  type Header,
} from "../contract/contract.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "contract", "fixtures");

const headerText = readFileSync(join(fixturesDir, "header.json"), "utf-8");
const chunkBytes = new Uint8Array(readFileSync(join(fixturesDir, "chunk.bin")));
const expected = JSON.parse(readFileSync(join(fixturesDir, "expected.json"), "utf-8"));

function load(): { header: Header; chunk: FrameChunk } {
  const header = parseHeader(headerText);
  const chunk = decodeFrameChunk(chunkBytes);
  return { header, chunk };
}

test("header parses, validates, and matches expected values", () => {
  const { header } = load();
  validateHeader(header); // parseHeader already validates; explicit re-check

  assert.equal(header.version, "0.1.0");
  assert.equal(header.n_points, expected.n_points);
  assert.equal(header.n_frames, expected.n_frames);
  assert.equal(header.units, "meters");
  assert.deepEqual(header.categories, expected.categories);
  assert.equal(header.points.type[0], expected.type_0);
  assert.equal(header.points.group_id[150], expected.group_id_150);
  assert.equal(header.points.subgroup_id[150], expected.subgroup_id_150);
  assert.equal(header.points.category[42], expected.category_42);
  assert.equal(header.edges.length, expected.n_edges);
  assert.deepEqual(header.edges[0], expected.edge_0);
  assert.equal(header.polylines[0][0], expected.polyline_0_first);
  assert.equal(header.polylines[0][header.polylines[0].length - 1], expected.polyline_0_last);

  const byName = new Map(header.channels.map((c) => [c.name, c]));
  assert.equal(byName.get("mass")?.scope, "per_point");
  assert.equal(byName.get("mass")?.data?.[3], expected.mass_3);
  assert.equal(byName.get("time")?.scope, "per_frame");
  assert.equal(byName.get("time")?.data?.[19], expected.time_19);
  assert.equal(byName.get("energy")?.scope, "per_point_per_frame");
  assert.equal(byName.get("energy")?.data, undefined);
});

test("frame chunk decodes, validates, and matches expected binary values", () => {
  const { header, chunk } = load();
  validateFrameChunk(chunk, header);

  assert.equal(chunkBytes.byteLength, expected.envelope_bytes);
  assert.equal(chunk.start, expected.chunk_start);
  assert.equal(chunk.count, expected.chunk_count);
  assert.equal(chunk.positions.length, chunk.count * header.n_points * 3);

  // Exact float32 values written by Python, read back byte-for-byte in TS.
  const n = header.n_points;
  for (const [key, [f, p]] of [
    ["position_f6_p7", [6, 7]],
    ["position_f8_p299", [8, 299]],
  ] as const) {
    const base = positionIndex(chunk, n, f, p);
    assert.deepEqual(
      [chunk.positions[base], chunk.positions[base + 1], chunk.positions[base + 2]],
      expected[key],
      key,
    );
  }
  const energy = chunk.channels.get("energy");
  if (!energy) throw new Error("energy channel block missing");
  assert.equal(energy[channelIndex(chunk, n, 8, 123)], expected.energy_f8_p123);
});

test("validators reject violations", () => {
  const { header, chunk } = load();

  // Bad magic.
  const badMagic = new Uint8Array(chunkBytes);
  badMagic[0] = 0x58;
  assert.throws(() => decodeFrameChunk(badMagic), ContractError);
  // Truncated envelope.
  assert.throws(() => decodeFrameChunk(chunkBytes.subarray(0, chunkBytes.byteLength - 4)), ContractError);

  // Chunk range outside header's n_frames.
  assert.throws(() => validateFrameChunk({ ...chunk, start: header.n_frames - 1 }, header), ContractError);
  // Missing declared per_point_per_frame channel.
  assert.throws(
    () => validateFrameChunk({ ...chunk, channels: new Map() }, header),
    ContractError,
  );

  // Header violations.
  const bad1 = parseHeader(headerText);
  bad1.points.category[0] = 99;
  assert.throws(() => validateHeader(bad1), ContractError);
  const bad2 = parseHeader(headerText);
  bad2.edges.push([0, bad2.n_points]);
  assert.throws(() => validateHeader(bad2), ContractError);
  const bad3 = parseHeader(headerText);
  bad3.points.group_id[0] += 1; // puts a subgroup in two groups
  assert.throws(() => validateHeader(bad3), ContractError);
});
