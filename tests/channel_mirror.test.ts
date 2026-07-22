/**
 * assert_single_channel_mirror — the tripwire `webview/main.ts` NAMES but that
 * was never written.
 *
 * The comment above `declareProducedChannel` calls `channelScopeByName` "the ONE
 * frozen, derived-once mirror of the channel list the per-flip applier consults
 * (assert_single_channel_mirror in the tests is the tripwire against a second one
 * appearing)". A repo-wide grep found no such test: the guard was described and
 * never built, so for the whole life of the channel feature nothing has been
 * watching. This file is that guard.
 *
 * WHY IT MATTERS. `header.channels` is the truth about which channels exist.
 * Anything else in the webview keyed by channel name is a MIRROR of it, and a
 * mirror that is updated somewhere else drifts. The per-flip applier reads
 * `channelScopeByName` on every frame to decide which bound axes to re-derive
 * (`main.ts` ~2105); a stale entry there means an axis silently stops updating,
 * or updates from a channel whose shape has changed. That is the silent-wrongness
 * class this codebase keeps paying for — the same shape as the `requires-channel`
 * liveness-vs-fitness bug.
 *
 * THE RULE IT ENFORCES, chosen so it needs no annotation anyone can forget:
 *
 *   R1. Every mutation of a channel-keyed mirror happens inside
 *       `declareProducedChannel` — the single point where a channel enters the
 *       viewer. Mirrors are identified by naming convention: an identifier
 *       beginning with `channel`.
 *   R2. Every derived-once construction over `header.channels` is assigned to
 *       such an identifier, so R1 covers it.
 *   R3. At least one mirror exists, so the file cannot pass vacuously if the
 *       naming convention is ever abandoned wholesale.
 *
 * WHAT IT DOES NOT CATCH, stated so it is not mistaken for more than it is: a
 * mirror named without the `channel` prefix, or channel-keyed state held outside
 * `webview/main.ts`. R2 catches the common accident (copying the derived-once
 * line); R1 catches the dangerous one (writing to a mirror from a second site).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MAIN = new URL("../webview/main.ts", import.meta.url);
const SRC = readFileSync(MAIN, "utf-8");

/** Brace-matched body span of `const <name> = (...) => { … }`. */
function closureSpan(src: string, name: string): { start: number; end: number } {
  const decl = src.indexOf(`const ${name} =`);
  assert.notEqual(decl, -1, `${name} not found in webview/main.ts — did it get renamed?`);
  const open = src.indexOf("{", decl);
  assert.notEqual(open, -1, `no body found for ${name}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { start: open, end: i };
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Line number (1-based) of a character offset, for legible failures. */
const lineOf = (offset: number): number => SRC.slice(0, offset).split("\n").length;

const MIRROR_MUTATION = /\b(channel[A-Za-z]*)\.(set|delete|clear)\(/g;
const DERIVED_ONCE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new (?:Map|Set)\(\s*header\.channels\b/g;

test("assert_single_channel_mirror: every channel-keyed mirror is written ONLY where a channel is declared", () => {
  const span = closureSpan(SRC, "declareProducedChannel");
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const m of SRC.matchAll(MIRROR_MUTATION)) {
    const at = m.index ?? 0;
    seen.add(m[1]);
    if (at < span.start || at > span.end) {
      offenders.push(`${m[1]}.${m[2]}() at webview/main.ts:${lineOf(at)}`);
    }
  }
  assert.deepEqual(offenders, [],
    "a channel-keyed mirror is mutated outside declareProducedChannel — that is how a second " +
    "mirror drifts out of sync with header.channels. Move the write into declareProducedChannel " +
    "(thread whatever it needs in as a parameter) so every mirror updates at one point.");
  // R3 — non-vacuity: if the naming convention is abandoned this file would
  // otherwise pass by matching nothing at all.
  assert.ok(seen.size >= 1,
    "no channel-keyed mirror found at all — either the convention changed or this guard has " +
    "silently stopped watching anything.");
});

test("assert_single_channel_mirror: every derived-once mirror of header.channels is channel-named", () => {
  const bad: string[] = [];
  for (const m of SRC.matchAll(DERIVED_ONCE)) {
    if (!/^channel/.test(m[1])) bad.push(`${m[1]} at webview/main.ts:${lineOf(m.index ?? 0)}`);
  }
  assert.deepEqual(bad, [],
    "a Map/Set derived from header.channels is not named channel* — the write-site guard above " +
    "identifies mirrors by that prefix, so an off-convention name is invisible to it.");
});
