/**
 * Parallel E2E runner — test infrastructure, not product code.
 *
 * Runs redesign.ts scenarios CONCURRENTLY, one CHILD PROCESS per scenario:
 * each gets its own Chrome, its own bridge+producer, its own disjoint port
 * range (via E2E_PORT_BASE), and its own module state — true isolation, and
 * per-scenario output that can never braid. Assertion outcomes are byte-for-
 * byte those of a serial run: the scenarios themselves are untouched; only
 * WHEN they run changes.
 *
 *   node tests/run_e2e.ts                 # every scenario, default width
 *   node tests/run_e2e.ts --width 8       # wider pool
 *   node tests/run_e2e.ts S32 S34 S36     # a subset
 *
 * The scenario list and the EXCLUSIVE set come from `redesign.ts --list` —
 * the ONE source, next to the scenario table (never hardcoded here). An
 * exclusive scenario (S29 mutates the shared .molaro/mods on disk) runs
 * ALONE after the pool drains.
 *
 * Output discipline:
 *   - live: one `▶ started` / `✔|✘ finished` line per scenario, plus every
 *     `[FAIL]` line the moment it appears, prefixed with its scenario — the
 *     monitor-on-FAIL workflow survives parallelism.
 *   - end: per-scenario verdicts in CANONICAL order, then the total tally.
 *     Full per-scenario logs land in reports/e2e_runner/<scenario>.log.
 *   - a failure in any scenario fails the run (exit 1); its full output is
 *     preserved and its FAIL lines were already streamed.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = join(root, "reports", "e2e_runner");

// Port layout: stride 400 per job keeps a job's OWN cdp range (base+300..+308)
// inside its stride, so no fold onto any other job's bridge range regardless
// of completion order. ~37 jobs fit well under the ephemeral range.
const PORT_ORIGIN = 21000;
const PORT_STRIDE = 400;

interface Listing {
  scenarios: string[];
  exclusive: string[];
  /** scenario → lane, exhaustive both ways (asserted at the source). */
  tiers: Record<string, "fast" | "full">;
}

interface Result {
  name: string;
  exitCode: number;
  passes: number;
  fails: number;
  seconds: number;
  log: string;
}

function listScenarios(): Promise<Listing> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [join(root, "tests", "redesign.ts"), "--list"], { cwd: root });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`--list exited ${code}`));
      try {
        resolve(JSON.parse(out.trim()) as Listing);
      } catch (e) {
        reject(new Error(`--list output was not JSON: ${e}`));
      }
    });
  });
}

let jobSeq = 0;
function runScenario(name: string): Promise<Result> {
  const portBase = PORT_ORIGIN + PORT_STRIDE * jobSeq++;
  const t0 = performance.now();
  console.log(`▶ ${name} started (ports ${portBase}+)`);
  return new Promise((resolve) => {
    const p = spawn("node", [join(root, "tests", "redesign.ts"), name], {
      cwd: root,
      env: { ...process.env, E2E_PORT_BASE: String(portBase) },
    });
    let log = "";
    let tail = ""; // carry partial lines across chunks so FAIL-streaming never splits
    const onData = (d: Buffer): void => {
      const text = d.toString();
      log += text;
      const lines = (tail + text).split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) {
        // stream failures the moment they appear, attributably
        if (line.includes("[FAIL]")) console.log(`[${name}] ${line.trim()}`);
      }
    };
    p.stdout.on("data", onData);
    p.stderr.on("data", onData);
    p.on("close", (code) => {
      const seconds = (performance.now() - t0) / 1000;
      const passes = (log.match(/\[PASS\]/g) ?? []).length;
      const fails = (log.match(/\[FAIL\]/g) ?? []).length;
      const ok = code === 0 && fails === 0;
      console.log(
        `${ok ? "✔" : "✘"} ${name} finished — ${passes} pass / ${fails} fail · ` +
          `${seconds.toFixed(0)}s · exit ${code}`,
      );
      writeFileSync(join(LOG_DIR, `${name}.log`), log);
      resolve({ name, exitCode: code ?? 1, passes, fails, seconds, log });
    });
  });
}

/** A bounded pool: WIDTH scenarios in flight, next starts as one finishes. */
async function pool(names: string[], width: number): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < names.length) {
      const name = names[next++];
      results.push(await runScenario(name));
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, names.length) }, worker));
  return results;
}

// -- main ---------------------------------------------------------------------
const argv = process.argv.slice(2);
let width = 6; // default from the measured width curve (see the runner commit)
let lane: "fast" | "full" = "full"; // full is the safe default: everything runs
const names: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--width") width = Number(argv[++i]);
  else if (argv[i] === "--lane") {
    const l = argv[++i];
    if (l !== "fast" && l !== "full") {
      console.error(`--lane must be fast or full (got "${l}")`);
      process.exit(2);
    }
    lane = l;
  } else names.push(argv[i]);
}

mkdirSync(LOG_DIR, { recursive: true });
const listing = await listScenarios();
const canonical = listing.scenarios;
// the full LANE runs every scenario (tiering decides WHEN, never WHETHER);
// the fast lane is the iteration subset. Explicit names override the lane.
const laneSet = lane === "full"
  ? canonical
  : canonical.filter((n) => listing.tiers[n] === "fast");
const wanted = names.length ? names : laneSet;
for (const n of wanted) {
  if (!canonical.includes(n)) {
    console.error(`unknown scenario ${n}`);
    process.exit(2);
  }
}
const exclusive = wanted.filter((n) => listing.exclusive.includes(n));
const pooled = wanted.filter((n) => !listing.exclusive.includes(n));

console.log(
  `running ${wanted.length} scenarios — width ${width}` +
    (exclusive.length ? `; exclusive (alone, after the pool): ${exclusive.join(", ")}` : ""),
);
const t0 = performance.now();
const results = await pool(pooled, width);
for (const n of exclusive) results.push(await runScenario(n)); // alone, serially

// canonical-order verdicts, then the tally — deterministic regardless of
// completion order
results.sort((a, b) => canonical.indexOf(a.name) - canonical.indexOf(b.name));
console.log("\n== per-scenario verdicts ==");
let passes = 0;
let fails = 0;
for (const r of results) {
  passes += r.passes;
  fails += r.fails;
  console.log(
    `  ${r.fails === 0 && r.exitCode === 0 ? "PASS" : "FAIL"}  ${r.name}` +
      `  (${r.passes}/${r.passes + r.fails} checks, ${r.seconds.toFixed(0)}s)`,
  );
}
const wall = (performance.now() - t0) / 1000;
const bad = results.filter((r) => r.fails > 0 || r.exitCode !== 0);
console.log(
  `\n${passes} checks passed, ${fails} failed · wall ${(wall / 60).toFixed(1)}min · ` +
    `${bad.length === 0 ? "ALL PASS" : `${bad.length} SCENARIO FAILURES: ${bad.map((r) => r.name).join(", ")}`}`,
);
process.exit(bad.length === 0 ? 0 : 1);
