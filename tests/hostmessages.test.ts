/**
 * Host relay routing (Part A). The terminal and viewer are separate webviews;
 * the host is the only path between them. `confirm-answer` — rm's y/n — MUST be
 * relayed to the viewer, or a confirmed delete is dropped and rm fails silently
 * (the exact bug: the in-page test harness masked it by looping the answer back
 * itself, so no committed test caught it). This guard fails if the relay drops
 * confirm-answer again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRODUCER_STATUS_MARKER,
  producerStatusFromLog,
  relaysTerminalMessageToViewer,
  TERMINAL_MESSAGES_TO_VIEWER,
} from "../src/hostmessages.ts";

test("the host relays confirm-answer (rm's y/n) to the viewer", () => {
  assert.ok(relaysTerminalMessageToViewer("confirm-answer"),
    "confirm-answer must be relayed to the viewer — dropping it makes rm fail silently");
  assert.ok(TERMINAL_MESSAGES_TO_VIEWER.includes("confirm-answer"));
});

test("the host relays the other terminal→viewer messages, and nothing else", () => {
  for (const t of ["command", "complete", "claude-bind"]) assert.ok(relaysTerminalMessageToViewer(t), t);
  // claude panel commands go to the backend, not relayed to the viewer
  for (const t of ["user-message", "approval-decision", "cancel", "claude-ready", undefined, "nonsense"]) {
    assert.ok(!relaysTerminalMessageToViewer(t as string | undefined), `${t} is NOT relayed`);
  }
});

test("producerStatusFromLog extracts the loading text the producer emits (big-system not-frozen signal)", () => {
  // The real shape: logging.basicConfig prefixes "producer INFO " before the
  // marker. The parser splits on the marker, so the prefix does not matter.
  const line =
    `producer INFO ${PRODUCER_STATUS_MARKER} loading data source — a large system can take several seconds to parse`;
  assert.equal(
    producerStatusFromLog(line),
    "loading data source — a large system can take several seconds to parse",
  );
  // Marker with only whitespace after it, and lines without the marker, yield null.
  assert.equal(producerStatusFromLog(`producer INFO ${PRODUCER_STATUS_MARKER}   `), null);
  assert.equal(producerStatusFromLog("producer INFO frames [0, 8) -> 1234 bytes"), null);
  assert.equal(producerStatusFromLog(""), null);
});
