/**
 * Framing tests: the parser must reassemble length-prefixed messages no
 * matter how the pipe splits the bytes.
 *
 * Run from viewer/:  node --test tests/framing.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { FrameParser, FramingError, frameMessage } from "../src/framing.ts";

function payload(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

test("frameMessage prepends a 4-byte LE length", () => {
  const framed = frameMessage(new Uint8Array([9, 8, 7]));
  assert.deepEqual([...framed], [3, 0, 0, 0, 9, 8, 7]);
});

test("whole messages in one push", () => {
  const parser = new FrameParser();
  const a = payload(10, 1);
  const b = payload(5, 2);
  const wire = new Uint8Array([...frameMessage(a), ...frameMessage(b)]);
  const out = parser.push(wire);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
  assert.equal(parser.pending, 0);
});

test("one byte at a time", () => {
  const parser = new FrameParser();
  const msgs = [payload(3, 5), payload(0, 0), payload(17, 9)];
  const wire = new Uint8Array(msgs.flatMap((m) => [...frameMessage(m)]));
  const out: Uint8Array[] = [];
  for (const byte of wire) out.push(...parser.push(new Uint8Array([byte])));
  assert.equal(out.length, 3);
  msgs.forEach((m, i) => assert.deepEqual(out[i], m));
  assert.equal(parser.pending, 0);
});

test("every possible split point of a two-message stream", () => {
  const a = payload(37, 3);
  const b = payload(11, 4);
  const wire = new Uint8Array([...frameMessage(a), ...frameMessage(b)]);
  for (let cut = 0; cut <= wire.length; cut++) {
    const parser = new FrameParser();
    const out = [
      ...parser.push(wire.subarray(0, cut)),
      ...parser.push(wire.subarray(cut)),
    ];
    assert.equal(out.length, 2, `cut at ${cut}`);
    assert.deepEqual(out[0], a, `cut at ${cut}`);
    assert.deepEqual(out[1], b, `cut at ${cut}`);
  }
});

test("length prefix split across pushes", () => {
  const parser = new FrameParser();
  const msg = payload(300, 7);
  const wire = frameMessage(msg);
  assert.deepEqual(parser.push(wire.subarray(0, 2)), []);
  assert.deepEqual(parser.push(wire.subarray(2, 3)), []);
  const out = parser.push(wire.subarray(3));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], msg);
});

test("random adversarial splits over many messages", () => {
  const msgs: Uint8Array[] = [];
  for (let i = 0; i < 50; i++) msgs.push(payload(1 + ((i * 37) % 200), i % 256));
  const wire = new Uint8Array(msgs.flatMap((m) => [...frameMessage(m)]));
  let seed = 12345;
  const rand = (max: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % max;
  const parser = new FrameParser();
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < wire.length) {
    const n = Math.min(1 + rand(97), wire.length - pos);
    out.push(...parser.push(wire.subarray(pos, pos + n)));
    pos += n;
  }
  assert.equal(out.length, msgs.length);
  msgs.forEach((m, i) => assert.deepEqual(out[i], m));
  assert.equal(parser.pending, 0);
});

test("absurd length prefix throws (desync guard)", () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(new Uint8Array([255, 255, 255, 255])), FramingError);
});
