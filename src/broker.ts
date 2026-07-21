/**
 * ProducerBroker — owns the producer child process and the framed stdio pipe.
 *
 * The extension host is the only participant that can spawn processes, so this
 * is the middle hop of: webview ⇄ (postMessage) ⇄ host ⇄ (framed stdio) ⇄
 * producer. The broker is deliberately vscode-free so tests can drive the real
 * producer through the exact code path the extension uses.
 *
 * Responses are FIFO with requests (the producer guarantees order); the broker
 * just relays payloads. For FrameChunk payloads it cross-checks the outer
 * frame length against the envelope's self-described size — a cheap desync
 * detector for the binary stream.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { frameChunkEnvelopeSize } from "../contract/contract.ts";
import { FrameParser, frameMessage } from "./framing.ts";

export interface ProducerRequest {
  type: "header" | "frames" | "run_mod";
  start?: number;
  count?: number;
  /** run_mod: the mod's Python source + resolved element indices. */
  code?: string;
  target_indices?: number[];
  timeout_s?: number;
  /** run_mod: effective parameters (defaults filled), name → typed scalar.
   * Additive — absent when the mod declares no parameters. */
  parameters?: Record<string, number | string | boolean>;
  /** run_mod: a produces:channel mod's declared channel name (the header single
   * source). Present ⟺ a channel run; the return then carries no name. */
  channel_name?: string;
}

export interface BrokerOptions {
  pythonPath?: string; // default "python3"
  serveScript: string; // absolute path to producer/serve.py
  producerArgs?: string[]; // e.g. ["--n-points", "20000"]
}

export interface BrokerEvents {
  /** One complete response payload (Header JSON, FrameChunk envelope, or error JSON). */
  onMessage(payload: Uint8Array): void;
  /** Producer ended or the stream broke. Not fired on an intentional dispose(). */
  onExit(reason: string): void;
  /** A line of producer stderr (logging/diagnostics). */
  onLog?(line: string): void;
}

export class ProducerBroker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly parser = new FrameParser();
  private disposed = false;
  private stderrTail: string[] = [];

  private readonly options: BrokerOptions;
  private readonly events: BrokerEvents;

  constructor(options: BrokerOptions, events: BrokerEvents) {
    this.options = options;
    this.events = events;
  }

  start(): void {
    if (this.child) throw new Error("broker already started");
    const child = spawn(
      this.options.pythonPath ?? "python3",
      [this.options.serveScript, ...(this.options.producerArgs ?? [])],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;

    child.stdout.on("data", (data: Buffer) => {
      let payloads: Uint8Array[];
      try {
        payloads = this.parser.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (err) {
        this.fail(`framing error: ${err instanceof Error ? err.message : err}`);
        return;
      }
      for (const payload of payloads) {
        const claimed = frameChunkEnvelopeSize(payload);
        if (claimed !== null && claimed !== payload.byteLength) {
          this.fail(
            `stream desync: outer frame is ${payload.byteLength} bytes but the ` +
              `FrameChunk envelope describes ${claimed}`,
          );
          return;
        }
        this.events.onMessage(payload);
      }
    });

    let stderrBuf = "";
    child.stderr.on("data", (data: Buffer) => {
      stderrBuf += data.toString("utf-8");
      let nl;
      while ((nl = stderrBuf.indexOf("\n")) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) {
          this.stderrTail = [...this.stderrTail.slice(-4), line];
          this.events.onLog?.(line);
        }
      }
    });

    child.on("error", (err) => this.fail(`failed to spawn producer: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (this.disposed) return;
      const tail = this.stderrTail.length ? ` — recent stderr: ${this.stderrTail.join(" | ")}` : "";
      this.fail(`producer exited unexpectedly (code=${code}, signal=${signal})${tail}`);
    });
  }

  send(request: ProducerRequest): void {
    const child = this.child;
    if (!child || this.disposed || child.exitCode !== null) {
      throw new Error("producer is not running");
    }
    child.stdin.write(frameMessage(new TextEncoder().encode(JSON.stringify(request))));
  }

  /** Terminate the producer. Safe to call repeatedly; suppresses exit events. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    if (child && child.exitCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000);
      child.on("exit", () => clearTimeout(hardKill));
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private fail(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.child?.kill("SIGKILL");
    this.events.onExit(reason);
  }
}
