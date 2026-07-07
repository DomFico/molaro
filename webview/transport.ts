/**
 * Webview side of the transport: request/response correlation over the
 * host's postMessage relay.
 *
 * The producer answers strictly FIFO and the host relays in order, so a
 * simple queue of pending promises correlates responses to requests — no ids
 * on the wire. If the producer dies, every pending and future request rejects
 * with the reason the host reported.
 */

export type ProducerRequest =
  | { type: "header" }
  | { type: "frames"; start: number; count: number };

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
