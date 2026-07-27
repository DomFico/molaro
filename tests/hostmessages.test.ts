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
  DEFAULT_N_FRAMES,
  DEFAULT_N_POINTS,
  PRODUCER_STATUS_MARKER,
  producerOpenArgs,
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

// -- producerOpenArgs (Part B): ONE argv builder for every open entry point ----
//
// The regression this guards: an argument that must reach the producer gets
// threaded onto `viewer.open` and forgotten on `viewer.openFile` — which is the
// path the Explorer context menu takes, and therefore the path a long trajectory
// is actually opened by. The frame cap is the current such argument.

test("producerOpenArgs: the synthetic default (no dataset) is unchanged", () => {
  assert.deepEqual(producerOpenArgs({}), {
    producerArgs: [
      "--n-points", String(DEFAULT_N_POINTS),
      "--n-frames", String(DEFAULT_N_FRAMES),
      "--seed", "7",
    ],
    title: `Point Viewer (N=${DEFAULT_N_POINTS})`,
  });
  assert.deepEqual(producerOpenArgs({ nPoints: 6000, nFrames: 150, seed: 3 }).producerArgs, [
    "--n-points", "6000", "--n-frames", "150", "--seed", "3",
  ]);
});

test("producerOpenArgs: a corpus system, an explicit topology, and a direct file open", () => {
  assert.deepEqual(producerOpenArgs({ system: "03_adk_psf_dcd" }), {
    producerArgs: ["--system", "03_adk_psf_dcd"],
    title: "Point Viewer (03_adk_psf_dcd)",
  });
  assert.deepEqual(
    producerOpenArgs({ topology: "/d/a.pdb", trajectory: "/d/a.dcd", ligandResidues: ["BNZ", "LIG"] }),
    {
      producerArgs: [
        "--dataset", "/d/a.pdb", "--trajectory", "/d/a.dcd",
        "--ligand-residue", "BNZ", "--ligand-residue", "LIG",
      ],
      title: "Point Viewer (a.pdb)",
    },
  );
  assert.deepEqual(producerOpenArgs({ openPath: "/data/BACD_rep9.dcd" }), {
    producerArgs: ["--open", "/data/BACD_rep9.dcd"],
    title: "Point Viewer (BACD_rep9.dcd)",
  });
  // titles survive a Windows separator and a trailing one
  assert.equal(producerOpenArgs({ openPath: "C:\\md\\run.dcd" }).title, "Point Viewer (run.dcd)");
  assert.equal(producerOpenArgs({ topology: "/a/b/" }).title, "Point Viewer (b)");
});

test("producerOpenArgs: the frame cap reaches EVERY real-dataset entry point", () => {
  // The whole point of the shared builder: --open (Explorer), --system and
  // --dataset all carry the cap. A miss on any one of them is the bug.
  for (const spec of [
    { openPath: "/data/long.dcd" },
    { system: "03_adk_psf_dcd" },
    { topology: "/d/a.pdb", trajectory: "/d/a.dcd" },
  ]) {
    const args = producerOpenArgs({ ...spec, maxFrames: 500 }).producerArgs;
    assert.ok(args.includes("--max-frames"), `--max-frames missing for ${JSON.stringify(spec)}`);
    assert.equal(args[args.indexOf("--max-frames") + 1], "500");
  }
  // a negative value (load every frame) is forwarded verbatim — the producer's
  // CLI reads <= 0 as "no cap"
  assert.deepEqual(producerOpenArgs({ openPath: "/x.dcd", maxFrames: -1 }).producerArgs,
    ["--open", "/x.dcd", "--max-frames", "-1"]);
});

test("producerOpenArgs: 0 and undefined send NOTHING, so the producer's default is the one source", () => {
  // The setting's default is 0 = "say nothing". If it were forwarded, the host
  // would have to know the real default (500) and that number would live twice.
  for (const maxFrames of [0, undefined]) {
    assert.deepEqual(producerOpenArgs({ openPath: "/x.dcd", maxFrames }).producerArgs,
      ["--open", "/x.dcd"], `maxFrames=${maxFrames} must not be forwarded`);
  }
  // and it never reaches the synthetic source, whose --n-frames is explicit
  assert.ok(!producerOpenArgs({ nPoints: 100, maxFrames: 500 }).producerArgs.includes("--max-frames"));
});
