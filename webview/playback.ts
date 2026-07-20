/**
 * StreamingPlayer — playhead, prefetch window, bounded chunk cache, and the
 * backpressure policy. Pure state machine: no DOM, no Three.js, no transport;
 * time is injected. Unit-tested in Node.
 *
 * Backpressure policy (all bounds explicit):
 * - Requests go out in chunk units; at most `maxInFlight` chunk requests are
 *   outstanding at once. The prefetch window is `lookaheadChunks` chunks ahead
 *   of the playhead (wrapping, because playback loops), so at most
 *   `lookaheadChunks + 1` chunks are ever wanted at a time.
 * - The cache is bounded by `maxCacheBytes`: least-recently-used chunks are
 *   evicted first, but chunks inside the current prefetch window are never
 *   evicted — so the effective bound is max(maxCacheBytes, window bytes).
 * - The playhead advances on a wall clock at `fps`, at most `maxStepPerTick`
 *   frames per tick (a slow render loop skips frames rather than accumulating
 *   unbounded time debt). If the next frame's chunk isn't cached, the playhead
 *   STALLS: it holds the current frame and the clock resets, so no debt
 *   accumulates while waiting. It never skips over missing data and never
 *   shows a gap. A stall ends when the chunk arrives (requests are FIFO and
 *   bounded, so arrival is guaranteed while the producer lives; producer death
 *   surfaces as an error through the transport, not a hang here).
 */

export interface PlaybackConfig {
  nFrames: number;
  chunkFrames: number;
  lookaheadChunks: number;
  maxInFlight: number;
  maxCacheBytes: number;
  fps: number;
  maxStepPerTick?: number;
}

export interface TickResult {
  frame: number;
  advanced: number;
  stalled: boolean;
}

interface CacheEntry<P> {
  payload: P;
  bytes: number;
  lastUsed: number;
}

export class StreamingPlayer<P> {
  private readonly cache = new Map<number, CacheEntry<P>>();
  private readonly inFlight = new Set<number>();
  private cacheBytesTotal = 0;
  private useCounter = 0;

  private playheadFrame = 0;
  private playingFlag = false;
  private lastTickMs: number | null = null;
  private accMs = 0;

  private stallTotal = 0;
  private framesAdvancedTotal = 0;
  private evictionsTotal = 0;

  private readonly cfg: PlaybackConfig;
  private readonly requestChunk: (start: number, count: number) => void;

  constructor(cfg: PlaybackConfig, requestChunk: (start: number, count: number) => void) {
    if (cfg.nFrames < 1 || cfg.chunkFrames < 1) throw new Error("bad playback config");
    this.cfg = cfg;
    this.requestChunk = requestChunk;
  }

  // -- geometry of chunks ---------------------------------------------------

  get numChunks(): number {
    return Math.ceil(this.cfg.nFrames / this.cfg.chunkFrames);
  }

  chunkOf(frame: number): number {
    return Math.floor(frame / this.cfg.chunkFrames);
  }

  chunkStart(idx: number): number {
    return idx * this.cfg.chunkFrames;
  }

  chunkCount(idx: number): number {
    return Math.min(this.cfg.chunkFrames, this.cfg.nFrames - this.chunkStart(idx));
  }

  // -- state ----------------------------------------------------------------

  get frame(): number {
    return this.playheadFrame;
  }

  get playing(): boolean {
    return this.playingFlag;
  }

  /** Kick off the initial prefetch (chunk 0 and the lookahead window). */
  start(): void {
    this.ensurePrefetch();
  }

  play(): void {
    this.playingFlag = true;
    this.lastTickMs = null;
    this.accMs = 0;
  }

  pause(): void {
    this.playingFlag = false;
    this.lastTickMs = null;
    this.accMs = 0;
  }

  seek(frame: number): void {
    this.playheadFrame = Math.min(Math.max(0, Math.floor(frame)), this.cfg.nFrames - 1);
    this.accMs = 0;
    this.ensurePrefetch();
  }

  /** Advance the playhead per the wall clock; see the policy at the top. */
  tick(nowMs: number): TickResult {
    if (!this.playingFlag) {
      return { frame: this.playheadFrame, advanced: 0, stalled: false };
    }
    if (this.lastTickMs === null) {
      this.lastTickMs = nowMs;
      return { frame: this.playheadFrame, advanced: 0, stalled: false };
    }
    this.accMs += nowMs - this.lastTickMs;
    this.lastTickMs = nowMs;

    const frameMs = 1000 / this.cfg.fps;
    const maxStep = this.cfg.maxStepPerTick ?? 4;
    let steps = Math.min(Math.floor(this.accMs / frameMs), maxStep);
    let advanced = 0;
    let stalled = false;
    while (steps > 0) {
      const next = (this.playheadFrame + 1) % this.cfg.nFrames;
      if (!this.cache.has(this.chunkOf(next))) {
        stalled = true;
        this.stallTotal++;
        break;
      }
      this.playheadFrame = next;
      advanced++;
      steps--;
    }
    this.framesAdvancedTotal += advanced;
    if (stalled) {
      this.accMs = 0; // freeze the clock: no time debt accumulates while waiting
    } else {
      this.accMs = Math.min(this.accMs - advanced * frameMs, maxStep * frameMs);
    }
    this.ensurePrefetch();
    return { frame: this.playheadFrame, advanced, stalled };
  }

  // -- chunk arrival / cache ------------------------------------------------

  onChunk(start: number, payload: P, bytes: number): void {
    const idx = this.chunkOf(start);
    this.inFlight.delete(idx);
    if (!this.cache.has(idx)) {
      this.cache.set(idx, { payload, bytes, lastUsed: ++this.useCounter });
      this.cacheBytesTotal += bytes;
      this.evict();
    }
    this.ensurePrefetch();
  }

  onChunkFailed(start: number): void {
    this.inFlight.delete(start >= 0 ? this.chunkOf(start) : -1);
  }

  /**
   * Drop every cached chunk and re-prefetch (B-3 channel deltas). A produced
   * channel declared mid-session makes every cached chunk OLD-shape (it lacks
   * the new block); this converges the cache to the new shape by refetching
   * on demand. Accounting is reset exactly (each entry's own bytes were
   * tracked, so the total zeroes cleanly); in-flight requests are left to
   * complete (their replies drop harmlessly if superseded — onChunk only
   * caches when the slot is empty and re-validation happens at the call site).
   * The eager form of the ruled S2/S3 "lazy per-chunk upgrade": simple,
   * bounded (the working set is the prefetch window), and it converges in one
   * round-trip. A per-entry shape tag + read-time staleness check would make
   * it lazier; that machinery is deferred until a cost justifies it.
   */
  invalidateAll(): void {
    this.cache.clear();
    this.cacheBytesTotal = 0;
    this.ensurePrefetch();
  }

  /** Cached payload covering `frame` (touches LRU), or null if not cached. */
  getFrame(frame: number): P | null {
    const entry = this.cache.get(this.chunkOf(frame));
    if (!entry) return null;
    entry.lastUsed = ++this.useCounter;
    return entry.payload;
  }

  stats(): {
    cacheBytes: number;
    cachedChunks: number;
    inFlight: number;
    stalls: number;
    framesAdvanced: number;
    evictions: number;
  } {
    return {
      cacheBytes: this.cacheBytesTotal,
      cachedChunks: this.cache.size,
      inFlight: this.inFlight.size,
      stalls: this.stallTotal,
      framesAdvanced: this.framesAdvancedTotal,
      evictions: this.evictionsTotal,
    };
  }

  // -- internals --------------------------------------------------------------

  /** Chunk indices in the current window [playhead chunk, +lookahead], wrapped. */
  private windowChunks(): Set<number> {
    const out = new Set<number>();
    const cur = this.chunkOf(this.playheadFrame);
    for (let k = 0; k <= this.cfg.lookaheadChunks; k++) {
      out.add((cur + k) % this.numChunks);
    }
    return out;
  }

  private ensurePrefetch(): void {
    for (const idx of this.windowChunks()) {
      if (this.inFlight.size >= this.cfg.maxInFlight) break;
      if (this.cache.has(idx) || this.inFlight.has(idx)) continue;
      this.inFlight.add(idx);
      this.requestChunk(this.chunkStart(idx), this.chunkCount(idx));
    }
  }

  private evict(): void {
    if (this.cacheBytesTotal <= this.cfg.maxCacheBytes) return;
    const protectedChunks = this.windowChunks();
    const candidates = [...this.cache.entries()]
      .filter(([idx]) => !protectedChunks.has(idx))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [idx, entry] of candidates) {
      if (this.cacheBytesTotal <= this.cfg.maxCacheBytes) break;
      this.cache.delete(idx);
      this.cacheBytesTotal -= entry.bytes;
      this.evictionsTotal++;
    }
  }
}
