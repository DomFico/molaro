/**
 * The TS half of the TS↔Python edge-validation parity test
 * (tests/test_edge_validation_parity.py spawns this under node).
 *
 * stdin:  JSON {"nPoints": number, "cases": unknown[]}
 * stdout: JSON boolean[] — for each case, whether validateModValues' `edges`
 *         arm ACCEPTS it (ok === true).
 *
 * Deliberately a driver, not a .test.ts: the parity property spans two
 * languages, so ONE test (the Python file) owns the assertion and this file
 * only answers "what does the TS validator say" — two half-tests that could
 * silently drift apart would be the two-lists defect this repo keeps killing.
 */
import { readFileSync } from "node:fs";

import { validateModValues } from "../webview/recipes.ts";

const input = JSON.parse(readFileSync(0, "utf-8")) as { nPoints: number; cases: unknown[] };
const verdicts = input.cases.map((c) =>
  validateModValues(c, {
    produces: "edges",
    targetCount: 0,
    frameCount: 1,
    nPoints: input.nPoints,
  }).ok,
);
process.stdout.write(JSON.stringify(verdicts));
