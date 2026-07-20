/**
 * Webview side of the transport: request/response correlation over the
 * host's postMessage relay.
 *
 * The producer answers strictly FIFO and the host relays in order, so a
 * simple queue of pending promises correlates responses to requests — no ids
 * on the wire. If the producer dies, every pending and future request rejects
 * with the reason the host reported.
 *
 * LOAD-BEARING INVARIANT — the producer is serial and answers strictly FIFO,
 * ONE reply per request in order (producer/serve.py: a single read-eval-write
 * loop, run_mod's compute holds the loop so frame requests queue behind it).
 * B-3 channel deltas depend on this: a delta rides a run_mod reply, and FIFO
 * ordering is what makes an old-shape FrameChunk unable to arrive AFTER the
 * delta that obsoletes it (contract/SPEC.md "Channel deltas", note; the S1
 * seam in reports/B3_PHASE0.md). If this transport is ever made concurrent /
 * out-of-order (ids on the wire, parallel producer workers), that proof dies
 * and the request-epoch belt (validateFrameChunkAgainst against the set
 * captured per request in main.ts) becomes the SOLE guarantee — it must
 * already be load-bearing before this invariant is relaxed. Do not add
 * out-of-order correlation here without revisiting that seam.
 */

export type ProducerRequest =
  | { type: "header" }
  | { type: "frames"; start: number; count: number }
  | { type: "run_mod"; code: string; target_indices: number[]; timeout_s?: number };

export type HostMessage =
  | { type: "fromProducer"; payload: Uint8Array | ArrayBuffer }
  | { type: "producerExit"; message: string };

export class TransportError extends Error {}

export class Transport {
  private pending: Array<{
    resolve: (bytes: Uint8Array) => void;
    reject: (err: Error) => void;
  }> = [];
  private dead: string | null = null;

  private readonly post: (msg: { type: "toProducer"; request: ProducerRequest }) => void;

  constructor(post: (msg: { type: "toProducer"; request: ProducerRequest }) => void) {
    this.post = post;
  }

  /** Wire this to window "message" events. Ignores unrelated messages. */
  handleMessage(msg: unknown): void {
    const m = msg as HostMessage;
    if (m?.type === "fromProducer") {
      const waiter = this.pending.shift();
      if (!waiter) {
        throw new TransportError("response arrived with no pending request — correlation broken");
      }
      const p = m.payload;
      waiter.resolve(p instanceof Uint8Array ? p : new Uint8Array(p));
    } else if (m?.type === "producerExit") {
      this.dead = m.message;
      const waiting = this.pending;
      this.pending = [];
      for (const w of waiting) w.reject(new TransportError(m.message));
    }
  }

  request(request: ProducerRequest): Promise<Uint8Array> {
    if (this.dead !== null) {
      return Promise.reject(new TransportError(this.dead));
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.post({ type: "toProducer", request });
    });
  }

  get error(): string | null {
    return this.dead;
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

/**
 * A producer response is either binary (FrameChunk envelope) or JSON (Header,
 * or an {"error": ...} refusal). Throws TransportError on the latter.
 */
export function rejectIfErrorPayload(bytes: Uint8Array): void {
  if (bytes.length === 0 || bytes[0] !== 0x7b /* '{' */) return;
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (obj && typeof obj.error === "string") {
      throw new TransportError(`producer refused request: ${obj.error}`);
    }
  } catch (err) {
    if (err instanceof TransportError) throw err;
    // Not parseable as JSON — let the caller's real parser produce the error.
  }
}
