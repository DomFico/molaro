/**
 * Unit tests for the conversation panel's substrate — the frozen message
 * contract's parsers, the transcript reducer, and the scripted stub backend.
 * Pure, no DOM. Run from viewer/:  node --test tests/claude.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addUserMessage,
  applyEvent,
  createTranscript,
  markDecision,
  parseClaudeCommand,
  parseClaudeEvent,
  type AssistantTurn,
  type ClaudeCommand,
  type ClaudeEvent,
} from "../webview/claudemodel.ts";
import { createClaudeStub } from "../webview/claudestub.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -- contract (de)serialization: typed → JSON wire → typed, both directions ------

test("every event round-trips through the JSON wire and the parser", () => {
  const events: ClaudeEvent[] = [
    { type: "auth-status", state: "connected", hint: "stub backend" },
    { type: "auth-status", state: "disconnected" },
    { type: "assistant-text", delta: "Looking at " },
    { type: "tool-proposed", callId: "call-1", toolName: "example_tool_a", argsPreview: '{ target: "group-0", n: 42 }' },
    { type: "approval-required", callId: "call-2", toolName: "example_tool_b", preview: "example_tool_b on subgroup-3" },
    { type: "tool-result", callId: "call-1", ok: true, summary: "example_tool_a completed on group-0" },
    { type: "tool-result", callId: "call-2", ok: false, summary: "denied — example_tool_b did not run" },
    { type: "turn-complete" },
    { type: "error", message: "stub error — triggered by sentinel" },
  ];
  for (const ev of events) {
    assert.deepEqual(parseClaudeEvent(JSON.parse(JSON.stringify(ev))), ev, ev.type);
  }
});

test("every command round-trips through the JSON wire and the parser", () => {
  const commands: ClaudeCommand[] = [
    { type: "user-message", text: "look at group-0" },
    { type: "approval-decision", callId: "call-2", decision: "approve" },
    { type: "approval-decision", callId: "call-2", decision: "deny" },
    { type: "cancel" },
  ];
  for (const cmd of commands) {
    assert.deepEqual(parseClaudeCommand(JSON.parse(JSON.stringify(cmd))), cmd, cmd.type);
  }
});

test("the parsers reject junk, foreign relay types, and cross-set messages", () => {
  const junk: unknown[] = [
    null, undefined, 42, "user-message", {},
    { type: "command", id: 1, text: "view alpha" },          // the command relay's types
    { type: "commandResult", id: 1, status: "ok", message: "x" },
    { type: "assistant-text" },                               // missing delta
    { type: "tool-result", callId: "c", ok: "yes", summary: "s" }, // wrong ok type
    { type: "approval-decision", callId: "c", decision: "maybe" }, // bad decision
    { type: "auth-status", state: "unknown" },                 // bad state
  ];
  for (const x of junk) {
    assert.equal(parseClaudeEvent(x) && parseClaudeCommand(x), null, JSON.stringify(x));
  }
  // the sets are disjoint: an event never parses as a command and vice versa
  assert.equal(parseClaudeCommand({ type: "assistant-text", delta: "x" }), null);
  assert.equal(parseClaudeEvent({ type: "user-message", text: "x" }), null);
});

// -- the transcript reducer -------------------------------------------------------

test("streamed deltas concatenate into ONE assistant turn; input locks until turn-complete", () => {
  const s = createTranscript();
  addUserMessage(s, "look at group-0");
  assert.equal(s.busy, true, "sending disables the input");
  applyEvent(s, { type: "assistant-text", delta: "Looking at " });
  applyEvent(s, { type: "assistant-text", delta: "the target " });
  applyEvent(s, { type: "assistant-text", delta: "now." });
  assert.equal(s.items.length, 2, "one user turn + one assistant turn");
  assert.deepEqual(s.items[0], { kind: "user", text: "look at group-0" });
  assert.equal((s.items[1] as AssistantTurn).text, "Looking at the target now.");
  applyEvent(s, { type: "turn-complete" });
  assert.equal(s.busy, false, "turn-complete re-enables the input");
  // a delta AFTER turn-complete starts a NEW turn, never reopens the old one
  applyEvent(s, { type: "assistant-text", delta: "More." });
  assert.equal(s.items.length, 3);
  assert.equal((s.items[2] as AssistantTurn).text, "More.");
});

test("an auto-approved tool: proposed → result, NO approval block", () => {
  const s = createTranscript();
  addUserMessage(s, "go");
  applyEvent(s, { type: "tool-proposed", callId: "call-1", toolName: "example_tool_a", argsPreview: '{ n: 42 }' });
  applyEvent(s, { type: "tool-result", callId: "call-1", ok: true, summary: "example_tool_a completed" });
  const turn = s.items[1] as AssistantTurn;
  assert.equal(turn.blocks.length, 1);
  assert.equal(turn.blocks[0].approval, null, "no gate ever appeared");
  assert.deepEqual(turn.blocks[0].result, { ok: true, summary: "example_tool_a completed" });
});

test("a gated tool resolves on decision: approve → ok result, deny → error result", () => {
  for (const [decision, ok] of [["approve", true], ["deny", false]] as const) {
    const s = createTranscript();
    addUserMessage(s, "go");
    applyEvent(s, { type: "tool-proposed", callId: "call-2", toolName: "example_tool_b", argsPreview: "{}" });
    applyEvent(s, { type: "approval-required", callId: "call-2", toolName: "example_tool_b", preview: "example_tool_b on subgroup-3" });
    const block = (s.items[1] as AssistantTurn).blocks[0];
    assert.deepEqual(block.approval, { preview: "example_tool_b on subgroup-3", decision: null },
      "the gate renders with live buttons");
    assert.equal(block.result, null, "no result until the decision");
    markDecision(s, "call-2", decision); // the click disables the buttons
    assert.equal(block.approval?.decision, decision);
    applyEvent(s, { type: "tool-result", callId: "call-2", ok, summary: ok ? "ran" : "denied" });
    assert.deepEqual(block.result, { ok, summary: ok ? "ran" : "denied" }, decision);
  }
});

test("error renders an error item; auth-status drives the display state", () => {
  const s = createTranscript();
  assert.equal(s.auth, null);
  applyEvent(s, { type: "auth-status", state: "connected", hint: "stub backend" });
  assert.deepEqual(s.auth, { state: "connected", hint: "stub backend" });
  applyEvent(s, { type: "auth-status", state: "disconnected" });
  assert.deepEqual(s.auth, { state: "disconnected", hint: "" });
  addUserMessage(s, "trigger-error please");
  applyEvent(s, { type: "error", message: "stub error" });
  assert.deepEqual(s.items[1], { kind: "error", message: "stub error" });
  assert.equal(s.busy, true, "error alone does not end the turn");
  applyEvent(s, { type: "turn-complete" });
  assert.equal(s.busy, false);
});

// -- the stub backend (the scripted emitter behind the same boundary) -------------

function collector() {
  const events: ClaudeEvent[] = [];
  const stub = createClaudeStub((ev) => events.push(ev), { delayMs: 1 });
  return { events, stub, types: () => events.map((e) => e.type) };
}

test("stub: emits auth-status at creation, configurably for BOTH states", () => {
  const { events } = collector();
  assert.deepEqual(events[0],
    { type: "auth-status", state: "connected", hint: "stub backend (scripted)" });
  const got: ClaudeEvent[] = [];
  createClaudeStub((ev) => got.push(ev), { auth: "disconnected", authHint: "no backend" });
  assert.deepEqual(got[0], { type: "auth-status", state: "disconnected", hint: "no backend" });
});

test("stub: the scripted turn — deltas, an auto-approved tool, then a WAITING gate", async () => {
  const { events, stub, types } = collector();
  stub.handle({ type: "user-message", text: "look at group-0" });
  await sleep(50);
  assert.deepEqual(types(), [
    "auth-status",
    "assistant-text", "assistant-text", "assistant-text",
    "tool-proposed", "tool-result",       // auto-approved: no approval-required
    "tool-proposed", "approval-required", // gated: …and the script WAITS here
  ]);
  const gate = events[events.length - 1] as { callId: string };
  await sleep(30);
  assert.equal(events.length, 8, "nothing more until the panel decides");
  stub.handle({ type: "approval-decision", callId: gate.callId, decision: "approve" });
  await sleep(30);
  assert.deepEqual(types().slice(8), ["tool-result", "turn-complete"]);
  const result = events[8] as { ok: boolean; callId: string };
  assert.equal(result.ok, true);
  assert.equal(result.callId, gate.callId);
  stub.dispose();
});

test("stub: deny yields ok:false; callIds stay unique across turns", async () => {
  const { events, stub } = collector();
  stub.handle({ type: "user-message", text: "first" });
  await sleep(50);
  const gate1 = events[7] as { callId: string };
  stub.handle({ type: "approval-decision", callId: gate1.callId, decision: "deny" });
  await sleep(30);
  const denied = events[8] as { ok: boolean; summary: string };
  assert.equal(denied.ok, false);
  assert.match(denied.summary, /denied/);
  stub.handle({ type: "user-message", text: "second" });
  await sleep(50);
  const ids = events.filter((e) => e.type === "tool-proposed").map((e) => (e as { callId: string }).callId);
  assert.equal(new Set(ids).size, ids.length, `unique callIds: ${ids.join(",")}`);
  stub.dispose();
});

test("stub: the sentinel word emits error + turn-complete, no tools", async () => {
  const { stub, types } = collector();
  stub.handle({ type: "user-message", text: "please trigger-error now" });
  await sleep(30);
  assert.deepEqual(types().slice(1), ["error", "turn-complete"]);
  stub.dispose();
});

test("stub: cancel stops the script mid-stream and ends the turn", async () => {
  const { events, stub, types } = collector();
  stub.handle({ type: "user-message", text: "go" });
  stub.handle({ type: "cancel" }); // immediately — before the deltas fire
  await sleep(40);
  assert.deepEqual(types().slice(1), ["turn-complete"], "the script never ran");
  const n = events.length;
  await sleep(30);
  assert.equal(events.length, n, "…and stays stopped");
  // cancel when idle is a no-op
  stub.handle({ type: "cancel" });
  await sleep(10);
  assert.equal(events.length, n);
  stub.dispose();
});
