/**
 * `Molaro: Diagnose` — unit tests for the report, driven through an INJECTED
 * probe so no interpreter is spawned.
 *
 * The discipline these follow, learned the hard way on this project: a check
 * that cannot report FAIL is not a check. So every scheme below is asserted in
 * BOTH directions — a healthy environment passes it, and the specific broken
 * environment that motivated it fails it. Asserting only the happy path would
 * pass just as well against a function that returned `ok: true` unconditionally.
 *
 * Run from viewer/:  node --test tests/diagnose.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atLeast, collectChecks, renderReport, type Check } from "../src/diagnose.ts";

const HEALTHY = {
  executable: "/venv/bin/python", version: "3.12.4",
  numpy: "2.4.2", scipy: "1.17.0", mdtraj: "1.11.1.post2", netCDF4: "1.7.4",
  is_nucleic: { answers: true, value: false },
  __stdout_noise: "",
};

// A REAL executable, because the report checks that the interpreter exists and
// is runnable — a made-up path would fail that row and make every "healthy"
// assertion below fail for the wrong reason.
const REAL_EXE = process.execPath;

function deps(probe: Record<string, unknown> | string, modsDir: string) {
  return {
    pythonPath: REAL_EXE,
    pythonSource: "molaro.pythonPath",
    modsDir,
    probe: async () => probe,
  };
}

const find = (cs: Check[], needle: string): Check => {
  const c = cs.find((x) => x.label.includes(needle));
  assert.ok(c, `no check matching ${needle!} — labels: ${cs.map((x) => x.label).join(", ")}`);
  return c!;
};

test("THE VERSION COMPARE IS NUMERIC — '1.9' must not beat '1.11'", () => {
  // The whole point of the floor. String comparison says "1.9" > "1.11", which
  // is precisely backwards for the version that cannot run Molaro.
  assert.equal(atLeast("1.11.1.post2", "1.11"), true);
  assert.equal(atLeast("1.11", "1.11"), true);
  assert.equal(atLeast("1.12.0", "1.11"), true);
  assert.equal(atLeast("2.0", "1.11"), true);
  assert.equal(atLeast("1.10.0", "1.11"), false, "1.10 is the version that raises");
  assert.equal(atLeast("1.9.9", "1.11"), false, "the lexicographic trap");
  assert.equal(atLeast("nonsense", "1.11"), null, "unparseable is UNKNOWN, not failure");
});

test("a healthy environment passes every check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps(HEALTHY, dir));
    const failed = cs.filter((c) => c.ok === false);
    assert.deepEqual(failed.map((c) => c.label), [], "nothing should fail on a good env");
    assert.ok(cs.length >= 8, `expected a real matrix, got ${cs.length} rows`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mdtraj 1.10 FAILS the floor — the version that motivated the check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps({ ...HEALTHY, mdtraj: "1.10.0" }, dir));
    assert.equal(find(cs, "mdtraj >=").ok, false);
    // and the fix names the actual reason, not just "too old"
    assert.match(find(cs, "mdtraj >=").fix ?? "", /is_nucleic|raises/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CAPABILITY beats version: a mdtraj that imports but RAISES is caught", async () => {
  // The load-bearing row. This environment reports a modern version string and
  // imports cleanly — a boolean "mdtraj available" check calls it healthy — yet
  // the call the producer makes on every real dataset throws.
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps({
      ...HEALTHY,
      is_nucleic: { answers: false, error: "NotImplementedError: " },
    }, dir));
    assert.equal(find(cs, "is_nucleic").ok, false);
    assert.equal(find(cs, "mdtraj").ok, true, "…while the plain import check still passes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing required import fails; a missing optional one is UNKNOWN, not failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps({
      ...HEALTHY,
      numpy: { error: "ModuleNotFoundError: No module named 'numpy'" },
      netCDF4: { error: "ImportError: needs mpi4py" },
    }, dir));
    assert.equal(find(cs, "numpy").ok, false, "numpy is required");
    assert.equal(find(cs, "netCDF4").ok, null, "netCDF4 is optional — unknown, not failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stray stdout is reported — it is what corrupts the framed protocol", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps({
      ...HEALTHY, __stdout_noise: "dcdplugin) detected standard 32-bit DCD file",
    }, dir));
    const c = find(cs, "stdout is clean");
    assert.equal(c.ok, false);
    assert.match(c.detail, /dcdplugin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unwritable mods directory FAILS — the bug that blanked the panel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    // absent
    const gone = await collectChecks(deps(HEALTHY, join(dir, "nope")));
    assert.equal(find(gone, "mods directory").ok, false);
    assert.match(find(gone, "mods directory").detail, /does not exist/);
    // present but read-only
    chmodSync(dir, 0o500);
    const ro = await collectChecks(deps(HEALTHY, dir));
    assert.equal(find(ro, "mods directory").ok, false);
    // and the remedy names WHY a foreign path got here
    assert.match(find(ro, "mods directory").fix ?? "", /machine-scoped/);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test("an interpreter that will not run reports that and STOPS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps("could not spawn: ENOENT", dir));
    const c = find(cs, "interpreter runs");
    assert.equal(c.ok, false);
    // Nothing after it can be known, so nothing after it is claimed — a report
    // that guessed at numpy here would be inventing results.
    assert.ok(!cs.some((x) => x.label === "numpy"), "must not report imports it never probed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the rendered report marks failures and names a remedy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "molaro-diag-"));
  try {
    const cs = await collectChecks(deps({ ...HEALTHY, mdtraj: "1.10.0" }, dir));
    const text = renderReport(cs);
    assert.match(text, /FAIL/);
    assert.match(text, /->/, "a failing row must carry its fix");
    assert.match(text, /1 check failed/);
    // and a clean run says so unambiguously
    assert.match(renderReport(await collectChecks(deps(HEALTHY, dir))), /All checks passed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
