/**
 * Length-prefix framing for the producer stdio pipe.
 *
 * Every message on the pipe is a 4-byte little-endian length followed by that
 * many payload bytes. A pipe delivers bytes in arbitrary clumps, so the parser
 * accumulates incoming buffers and emits complete payloads regardless of how
 * they were split — without quadratic re-concatenation (payload bytes are
 * copied exactly once, into the emitted message).
 */

/** Sanity ceiling — a length beyond this means the stream has desynced. */
export const MAX_MESSAGE_BYTES = 1 << 30;

export function frameMessage(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength, true);
  out.set(payload, 4);
  return out;
}

export class FramingError extends Error {}

export class FrameParser {
  private parts: Uint8Array[] = [];
  private offset = 0; // consumed bytes within parts[0]
  private total = 0; // unconsumed bytes across all parts

  /** Feed received bytes; returns every complete payload now available. */
  push(data: Uint8Array): Uint8Array[] {
    if (data.byteLength > 0) {
      this.parts.push(data);
      this.total += data.byteLength;
    }
    const out: Uint8Array[] = [];
    while (this.total >= 4) {
      const len = this.peekLength();
      if (len > MAX_MESSAGE_BYTES) {
        throw new FramingError(`message length ${len} exceeds sanity cap — stream desync?`);
      }
      if (this.total < 4 + len) break;
      this.consume(4, null);
      const payload = new Uint8Array(len);
      this.consume(len, payload);
      out.push(payload);
    }
    return out;
  }

  /** Unconsumed byte count (diagnostics). */
  get pending(): number {
    return this.total;
  }

  private peekLength(): number {
    const four = new Uint8Array(4);
    let got = 0;
    let skip = this.offset;
    for (const part of this.parts) {
      const avail = part.byteLength - skip;
      const take = Math.min(avail, 4 - got);
      four.set(part.subarray(skip, skip + take), got);
      got += take;
      skip = 0;
      if (got === 4) break;
    }
    return new DataView(four.buffer).getUint32(0, true);
  }

  /** Drop n bytes, copying them into `into` (at offset 0) when provided. */
  private consume(n: number, into: Uint8Array | null): void {
    let copied = 0;
    while (copied < n) {
      const part = this.parts[0];
      const avail = part.byteLength - this.offset;
      const take = Math.min(avail, n - copied);
      if (into) into.set(part.subarray(this.offset, this.offset + take), copied);
      copied += take;
      this.offset += take;
      if (this.offset === part.byteLength) {
        this.parts.shift();
        this.offset = 0;
      }
    }
    this.total -= n;
  }
}
