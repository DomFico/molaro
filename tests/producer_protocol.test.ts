/**
 * Integration test: spawns the real Python producer (producer/serve.py) via
 * the real ProducerBroker — the exact host code path — and checks:
 * FIFO responses, contract-valid payloads, error replies, stdout purity
 * (every stdout byte is consumed by framing), and clean termination.
 *
 * Run from viewer/:  node --test tests/producer_protocol.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { ProducerBroker } from "../src/broker.ts";
import {
  decodeFrameChunk,
  parseHeader,
  validateFrameChunk,
} from "../contract/contract.ts";

const SERVE = join(dirname(fileURLToPath(import.meta.url)), "..", "producer", "serve.py");

interface Session {
  broker: ProducerBroker;
  next(): Promise<Uint8Array>;
  logs: string[];
  exitReason: string | null;
}

function startSession(args: string[]): Session {
  const waiting: Array<(b: Uint8Array) => void> = [];
  const queued: Uint8Array[] = [];
  const session: Partial<Session> & { logs: string[]; exitReason: string | null } = {
    logs: [],
    exitReason: null,
  };
  const broker = new ProducerBroker(
    { serveScript: SERVE, producerArgs: args },
    {
      onMessage: (payload) => {
        const w = waiting.shift();
        if (w) w(payload);
        else queued.push(payload);
      },
      onExit: (reason) => {
        session.exitReason = reason;
      },
      onLog: (line) => session.logs.push(line),
    },
  );
  broker.start();
  session.broker = broker;
  session.next = () =>
    new Promise<Uint8Array>((resolve, reject) => {
      const q = queued.shift();
      if (q) return resolve(q);
      const timer = setTimeout(() => reject(new Error("timed out waiting for response")), 30_000);
      waiting.push((b) => {
        clearTimeout(timer);
        resolve(b);
      });
    });
  return session as Session;
}

test("live producer: header, pipelined FIFO chunks, error reply, clean shutdown", async () => {
  const s = startSession(["--n-points", "500", "--n-frames", "40", "--log-level", "DEBUG"]);
  try {
    s.broker.send({ type: "header" });
    const header = parseHeader(new TextDecoder().decode(await s.next()));
    assert.equal(header.n_points, 500);
    assert.equal(header.n_frames, 40);

    // Pipeline several requests before reading anything — responses must come
    // back FIFO and decode against the header.
    const ranges = [
      { start: 0, count: 8 },
      { start: 8, count: 8 },
      { start: 32, count: 8 },
      { start: 16, count: 8 },
    ];
    for (const r of ranges) s.broker.send({ type: "frames", ...r });
    for (const r of ranges) {
      const chunk = decodeFrameChunk(await s.next());
      validateFrameChunk(chunk, header);
      assert.equal(chunk.start, r.start, "FIFO order preserved");
      assert.equal(chunk.count, r.count);
    }

    // Invalid request → JSON error response, in order, and the process lives on.
    s.broker.send({ type: "frames", start: 39, count: 5 });
    const err = JSON.parse(new TextDecoder().decode(await s.next()));
    assert.match(err.error, /outside/);

    s.broker.send({ type: "frames", start: 39, count: 1 });
    const last = decodeFrameChunk(await s.next());
    assert.equal(last.start, 39);

    // stdout purity: with DEBUG logging active, log lines went to stderr…
    assert.ok(s.logs.some((l) => l.includes("frames [")), "producer logged to stderr");
    // …and every stdout byte was consumed as framed protocol (a stray byte
    // would desync the parser and the last decode above would have failed).
    assert.equal(s.exitReason, null, "no framing/desync error");
  } finally {
    const pid = s.broker.pid;
    s.broker.dispose();
    assert.ok(pid, "producer had a pid");
    // Poll until the process is gone — dispose must not orphan it.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        execSync(`kill -0 ${pid} 2>/dev/null`);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "producer process terminated on dispose");
  }
});

test("producer crash surfaces as onExit, not a hang", async () => {
  const s = startSession(["--n-points", "-5", "--n-frames", "10"]); // invalid: init fails
  const deadline = Date.now() + 10_000;
  while (s.exitReason === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(s.exitReason, "exit surfaced");
  assert.match(s.exitReason!, /exited unexpectedly/);
  s.broker.dispose();
});

test("run_mod: exec against the resident dataset — values, errors, tracebacks, timeout", async () => {
  const s = startSession(["--n-points", "60", "--n-frames", "12"]);
  try {
    const runMod = async (code: string, target_indices: number[], timeout_s?: number) => {
      s.broker.send({ type: "run_mod", code, target_indices, ...(timeout_s ? { timeout_s } : {}) });
      return JSON.parse(new TextDecoder().decode(await s.next())) as {
        values?: number[]; error?: string; traceback?: string;
      };
    };

    // a valid compute: sees the EXACT indices, in order, and the dataset handle
    const ok = await runMod(
      "def compute(data, target_indices):\n" +
      "    n = data.give_header().n_frames\n" +
      "    return [i / 10 for i in target_indices] + [float(n)]\n",
      [3, 1, 4],
    );
    assert.deepEqual(ok.values, [0.3, 0.1, 0.4, 12],
      "indices arrive verbatim + the resident header is reachable");

    // a raising compute answers a structured error WITH the traceback text
    const boom = await runMod(
      "def compute(data, target_indices):\n    raise ValueError('synthetic failure')\n", []);
    assert.match(boom.error!, /ValueError: synthetic failure/);
    assert.match(boom.traceback!, /Traceback[\s\S]*ValueError: synthetic failure/);

    // exec-time errors (bad syntax), a missing compute, and a bad return shape
    assert.match((await runMod("def compute(:\n", [])).error!, /SyntaxError/);
    assert.match((await runMod("x = 1\n", [])).error!, /must define compute/);
    assert.match((await runMod(
      "def compute(data, target_indices):\n    return 'nope'\n", [])).error!,
      /flat list of finite floats/);
    assert.match((await runMod(
      "def compute(data, target_indices):\n    return [float('nan')]\n", [])).error!,
      /flat list of finite floats/);

    // the wall-clock timeout aborts a runaway compute and the producer LIVES ON
    const slow = await runMod(
      "def compute(data, target_indices):\n" +
      "    while True:\n        pass\n",
      [], 0.5);
    assert.match(slow.error!, /timed out after 0.5s/);
    const after = await runMod(
      "def compute(data, target_indices):\n    return [1.0]\n", []);
    assert.deepEqual(after.values, [1], "the producer still answers after a timeout");

    // FIFO integrity: a frames request queued behind a mod still round-trips
    s.broker.send({ type: "run_mod", code: "def compute(d, t):\n    return []\n", target_indices: [] });
    s.broker.send({ type: "frames", start: 0, count: 1 });
    const modReply = JSON.parse(new TextDecoder().decode(await s.next()));
    assert.deepEqual(modReply.values, []);
    const frameBytes = await s.next();
    assert.ok(frameBytes.length > 100, "the frames response follows in order");
  } finally {
    s.broker.dispose();
  }
});
