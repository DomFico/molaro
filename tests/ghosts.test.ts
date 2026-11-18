/** ghosts.ts — the `ghost` verb's parsing and handler (the drawing is e2e). */
import assert from "node:assert";
import test from "node:test";

import { GHOST_DEFAULT_OPACITY, GHOST_MAX, type GhostState, makeGhostHandler, parseGhostArgs } from "../webview/ghosts.ts";
import { StreamingPlayer } from "../webview/playback.ts";

test("parseGhostArgs: frames, ranges with steps, commas, opacity", () => {
  assert.deepEqual(parseGhostArgs("40 12,77 12", 100), { kind: "set", state: { frames: [12, 40, 77], opacity: GHOST_DEFAULT_OPACITY } });
  assert.deepEqual(parseGhostArgs("0-90:30 opacity 0.3", 100), { kind: "set", state: { frames: [0, 30, 60, 90], opacity: 0.3 } });
  assert.deepEqual(parseGhostArgs("5-7", 100), { kind: "set", state: { frames: [5, 6, 7], opacity: GHOST_DEFAULT_OPACITY } });
  assert.deepEqual(parseGhostArgs("", 100), { kind: "show" });
  assert.deepEqual(parseGhostArgs("off", 100), { kind: "off" });
});

test("parseGhostArgs: fails closed with a reason", () => {
  for (const [args, re] of [
    ["1000", /out of range/], ["7-3", /backwards/], ["1 opacity 1", /between 0 and 1/],
    ["1 opacity", /between 0 and 1/], ["abc", /not a frame/], ["0-9:0", /step/],
    ["opacity 0.2", /no frames/], [`0-${GHOST_MAX}`, /too many/],
  ] as const) {
    const r = parseGhostArgs(args, 1000);
    assert.equal(r.kind, "error", args);
    assert.match((r as { message: string }).message, re, args);
  }
});

test("handler: set / show / off through the context; validation context writes nothing", () => {
  let state: GhostState | null = null;
  const h = makeGhostHandler({ nFrames: () => 50, get: () => state, set: (s) => { state = s; } });
  assert.equal(h("3 9").status, "ok");
  assert.deepEqual(state, { frames: [3, 9], opacity: GHOST_DEFAULT_OPACITY });
  assert.match(h("").message, /2 ghost frames/);
  assert.equal(h("off").status, "ok");
  assert.equal(state, null);
  assert.equal(h("off").status, "nomatch");
  const v = makeGhostHandler({ nFrames: () => 50, get: () => null });
  assert.equal(v("3 9").status, "ok"); // validates, no setter → no write
  assert.equal(makeGhostHandler({ nFrames: () => 1, get: () => null })("0").status, "nomatch");
});

test("playback: pinned frames are fetched and never evicted; [] restores the old policy", () => {
  const asked: number[] = [];
  const p = new StreamingPlayer<number>(
    { nFrames: 100, chunkFrames: 10, lookaheadChunks: 0, maxInFlight: 8, maxCacheBytes: 10, fps: 10 },
    (start) => asked.push(start));
  p.start();
  p.setPinnedFrames([75]);
  assert.ok(asked.includes(70), "the pinned chunk is requested");
  for (const s of asked.splice(0)) p.onChunk(s, s, 10);
  // walk the playhead across other chunks: the cache bound (10 bytes) forces eviction
  for (const f of [20, 40, 60]) { p.seek(f); for (const s of asked.splice(0)) p.onChunk(s, s, 10); }
  assert.equal(p.getFrame(75), 70, "pinned chunk survived eviction");
  p.setPinnedFrames([]);
  p.seek(90); for (const s of asked.splice(0)) p.onChunk(s, s, 10);
  assert.equal(p.getFrame(75), null, "released → evictable again");
});
