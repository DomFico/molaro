/**
 * StreamingPlayer tests: prefetch window, in-flight cap, bounded LRU cache,
 * wall-clock advance, and the stall policy. Time is injected; requests are
 * recorded, and "arrival" is simulated by calling onChunk.
 *
 * Run from viewer/:  node --test tests/playback.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StreamingPlayer, type PlaybackConfig } from "../webview/playback.ts";

const CFG: PlaybackConfig = {
  nFrames: 100,
  chunkFrames: 10,
  lookaheadChunks: 2,
  maxInFlight: 2,
  maxCacheBytes: 3_000, // 3 chunks of 1000 "bytes"
  fps: 10, // 100ms per frame — easy math
};

function makePlayer(cfg: PlaybackConfig = CFG) {
  const requests: Array<{ start: number; count: number }> = [];
  const player = new StreamingPlayer<string>(cfg, (start, count) =>
    requests.push({ start, count }),
  );
  const deliver = (start: number) => player.onChunk(start, `chunk@${start}`, 1000);
  return { player, requests, deliver };
}

test("start() prefetches within the in-flight cap, then refills on arrival", () => {
  const { player, requests, deliver } = makePlayer();
  player.start();
  // Window is chunks {0,1,2} but only 2 requests may be outstanding.
  assert.deepEqual(requests, [
    { start: 0, count: 10 },
    { start: 10, count: 10 },
  ]);
  deliver(0);
  // Arrival frees a slot; the remaining window chunk goes out.
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], { start: 20, count: 10 });
  assert.equal(player.stats().inFlight, 2);
});

test("last chunk is short when T is not a multiple of chunkFrames", () => {
  const { player, requests } = makePlayer({ ...CFG, nFrames: 95 });
  player.seek(92);
  assert.deepEqual(requests[0], { start: 90, count: 5 });
});

test("wall-clock advance at fps, capped steps per tick", () => {
  const { player, deliver } = makePlayer();
  player.start();
  deliver(0);
  deliver(10);
  player.play();
  player.tick(0); // establishes the clock
  assert.equal(player.tick(100).frame, 1); // 100ms = exactly 1 frame
  assert.equal(player.tick(350).frame, 3); // +250ms = 2 more (0.5 carried)
  const big = player.tick(2350); // +2000ms = 20 frames, capped at 4
  assert.equal(big.advanced, 4);
  assert.equal(big.frame, 7);
});

test("stall policy: hold frame at missing chunk, resume on arrival, no debt", () => {
  const { player, deliver } = makePlayer();
  player.start();
  deliver(0); // only chunk 0 cached; chunk 1 in flight
  player.play();
  player.tick(0);
  player.tick(900); // try to advance 9 frames: 0→9 fine (chunk 0 covers 0..9)…
  assert.equal(player.frame, 4); // …but capped at 4/tick
  player.tick(1400);
  assert.equal(player.frame, 8);
  const r = player.tick(1900); // wants frames 9,10,… — 10 needs missing chunk 1
  assert.equal(r.frame, 9);
  assert.equal(r.stalled, true);
  // Stalled: playhead holds and the clock froze (no accumulated debt).
  assert.equal(player.tick(5000).frame, 9);
  assert.ok(player.stats().stalls >= 2);
  deliver(10);
  // Clock was frozen during the stall, so each 100ms tick advances exactly 1.
  const resumed = player.tick(5100);
  assert.equal(resumed.frame, 10);
  assert.equal(resumed.advanced, 1);
  assert.equal(player.tick(5200).frame, 11);
});

test("cache is bounded: LRU eviction outside the protected window", () => {
  const { player, deliver } = makePlayer();
  player.start();
  // Fill far more than maxCacheBytes (3 chunks) by seeking around.
  for (const chunkStart of [0, 10, 20, 30, 40, 50]) {
    player.seek(chunkStart);
    deliver(chunkStart);
  }
  const s = player.stats();
  assert.ok(s.cacheBytes <= CFG.maxCacheBytes, `cacheBytes ${s.cacheBytes}`);
  assert.ok(s.evictions > 0);
  // Playhead at 50: its own chunk must survive eviction.
  assert.ok(player.getFrame(50) !== null);
});

test("in-flight never exceeds the cap across seeks", () => {
  const { player, requests, deliver } = makePlayer();
  player.start();
  let outstanding = requests.length;
  assert.ok(outstanding <= CFG.maxInFlight);
  player.seek(70); // wants chunks 7,8,9 — but 2 requests already outstanding
  assert.equal(requests.length, 2, "no new requests while at the cap");
  deliver(0);
  deliver(10);
  // Slots freed → prefetch resumes toward the new window.
  outstanding = requests.length - 2;
  assert.ok(outstanding <= CFG.maxInFlight);
  const targets = requests.slice(2).map((r) => r.start / 10);
  for (const t of targets) assert.ok([7, 8, 9].includes(t), `chunk ${t} in new window`);
});

test("prefetch window wraps at the end for looping playback", () => {
  const { player, requests } = makePlayer();
  player.seek(95); // last chunk (9); window = {9, 0, 1}
  const targets = requests.map((r) => r.start / 10);
  assert.deepEqual(targets.slice(0, 2), [9, 0]);
});

test("playhead wraps to frame 0 after the last frame", () => {
  const { player, deliver } = makePlayer({ ...CFG, lookaheadChunks: 1 });
  player.seek(98);
  deliver(90);
  deliver(0);
  player.play();
  player.tick(0);
  player.tick(100);
  assert.equal(player.frame, 99);
  player.tick(200);
  assert.equal(player.frame, 0, "loops back to frame 0");
});

test("duplicate chunk arrivals do not double-count cache bytes", () => {
  const { player, deliver } = makePlayer();
  player.start();
  deliver(0);
  deliver(0);
  assert.equal(player.stats().cacheBytes, 1000);
});
