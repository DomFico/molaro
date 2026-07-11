/**
 * Unit tests for the terminal's single pending-confirmation slot
 * (webview/prompt.ts). Pure, no DOM. Run from viewer/:
 * node --test tests/prompt.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createPromptGate } from "../webview/prompt.ts";

function armed() {
  const gate = createPromptGate();
  const answers: boolean[] = [];
  gate.arm("delete? y/n", (yes) => answers.push(yes));
  return { gate, answers };
}

test("y and yes (any case) are the ONLY affirmatives", () => {
  for (const input of ["y", "Y", "yes", "YES", " y ", "Yes"]) {
    const { gate, answers } = armed();
    assert.equal(gate.offer(input), true, input);
    assert.deepEqual(answers, [true], input);
  }
});

test("n, no, and ANYTHING else cancel — fail-safe, never executed as a command", () => {
  for (const input of ["n", "no", "NO", "maybe", "view alpha", "clear", "rm all", "yess", ""]) {
    const { gate, answers } = armed();
    assert.equal(gate.offer(input), true, `${input} is CONSUMED (never a command)`);
    assert.deepEqual(answers, [false], input);
  }
});

test("idle gate consumes nothing (inputs flow to the command layer)", () => {
  const gate = createPromptGate();
  assert.equal(gate.pending(), null);
  assert.equal(gate.offer("y"), false, "no pending prompt — 'y' would run as a command");
});

test("single-shot: the slot clears BEFORE the callback; a second input is a command", () => {
  const { gate, answers } = armed();
  assert.equal(gate.pending(), "delete? y/n");
  gate.offer("y");
  assert.equal(gate.pending(), null, "cleared by answering");
  assert.equal(gate.offer("y"), false, "second 'y' is not consumed");
  assert.deepEqual(answers, [true]);
});

test("discard (clear/reset) drops the prompt WITHOUT invoking the callback", () => {
  const { gate, answers } = armed();
  gate.discard();
  assert.equal(gate.pending(), null);
  assert.equal(gate.offer("y"), false, "nothing pending after discard");
  assert.deepEqual(answers, [], "the callback never ran — nothing acted");
});

test("one slot: a newer arm replaces the old, whose callback is dead", () => {
  const gate = createPromptGate();
  const first: boolean[] = [];
  const second: boolean[] = [];
  gate.arm("first?", (yes) => first.push(yes));
  gate.arm("second?", (yes) => second.push(yes));
  assert.equal(gate.pending(), "second?");
  gate.offer("y");
  assert.deepEqual(first, [], "the replaced prompt never fires");
  assert.deepEqual(second, [true]);
});
