/**
 * `Molaro: Diagnose` — print the whole chain that has to hold, in order.
 *
 * WHY THIS EXISTS. A field install on an HPC cluster hit seven distinct
 * failures, and SIX of them presented as a blank panel or an empty error
 * message. Not one of them said what was wrong. The install took hours; with
 * this command it would have taken minutes, because every row below is a
 * failure that actually happened and cost real time:
 *
 *   - a `modsDir` from another machine, unwritable here      -> blank panel
 *   - an interpreter that exists but has no numpy            -> blank panel
 *   - mdtraj 1.10, whose Residue.is_nucleic RAISES           -> empty error
 *   - a producer whose stdout is polluted by a C extension   -> framing error
 *   - an installed build older than the repo                 -> silent staleness
 *
 * THE DESIGN RULE, learned from those failures: report a CAPABILITY MATRIX, not
 * a boolean. "mdtraj available" is not the question — the producer imported
 * mdtraj fine and then died, because the question was "mdtraj >= 1.11". A check
 * that can pass while the thing it guards is broken is not a check.
 *
 * Everything here is READ-ONLY: it spawns a short-lived probe, writes nothing,
 * and changes no state.
 *
 * NO `vscode` IMPORT, deliberately — the report is pure data, so it is unit
 * testable without an extension host. The command registration lives in
 * extension.ts, which is the only part that needs the editor.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";

/** One row of the report. `ok: null` = "could not determine", which is a third
 * state on purpose — reporting unknown as failure is how a working setup gets
 * blamed for a probe's own limitation. */
export interface Check {
  label: string;
  ok: boolean | null;
  detail: string;
  /** What to do about it. Only meaningful when ok !== true. */
  fix?: string;
}

const MDTRAJ_FLOOR = "1.11";

/** The Python side, probed in ONE spawn: interpreter identity, the imports that
 * matter, and — the part a version string cannot answer — whether the capability
 * the producer actually calls RESPONDS rather than raising. */
const PROBE = `
import json, sys
out = {"executable": sys.executable, "version": sys.version.split()[0]}
def mod(name):
    try:
        m = __import__(name)
        return getattr(m, "__version__", "?")
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
out["numpy"] = mod("numpy")
out["scipy"] = mod("scipy")
out["mdtraj"] = mod("mdtraj")
out["netCDF4"] = mod("netCDF4")
# CAPABILITY, not version. mdtraj 1.10 ships Residue.is_nucleic as a bare
# \`raise NotImplementedError\`, and the producer calls it unconditionally on
# every real dataset — so "mdtraj imported" is true while Molaro cannot run.
try:
    import mdtraj as md
    t = md.Topology()
    c = t.add_chain()
    r = t.add_residue("ALA", c)
    t.add_atom("CA", md.element.carbon, r)
    out["is_nucleic"] = {"answers": True, "value": bool(r.is_nucleic)}
except Exception as e:
    out["is_nucleic"] = {"answers": False, "error": f"{type(e).__name__}: {e}"}
print("MOLARO_PROBE " + json.dumps(out))
`;

function runProbe(python: string, timeoutMs = 20000): Promise<Record<string, unknown> | string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (v: Record<string, unknown> | string): void => {
      if (!done) { done = true; resolve(v); }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, ["-c", PROBE], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish(`could not spawn: ${(e as Error).message}`);
      return;
    }
    const timer = setTimeout(() => { child.kill(); finish("probe timed out"); }, timeoutMs);
    child.stdout?.on("data", (b) => { out += String(b); });
    child.stderr?.on("data", (b) => { err += String(b); });
    child.on("error", (e) => { clearTimeout(timer); finish(`could not spawn: ${e.message}`); });
    child.on("close", () => {
      clearTimeout(timer);
      // The probe prints ONE marked line. Anything else on stdout is noise from
      // a C extension or a chatty site-packages — which is itself worth knowing,
      // so it is reported rather than silently tolerated.
      const line = out.split("\n").find((l) => l.startsWith("MOLARO_PROBE "));
      if (!line) { finish(err.trim() || out.trim() || "no output"); return; }
      try {
        const parsed = JSON.parse(line.slice("MOLARO_PROBE ".length)) as Record<string, unknown>;
        parsed.__stdout_noise = out.replace(line, "").trim();
        finish(parsed);
      } catch (e) { finish(`unparseable probe output: ${(e as Error).message}`); }
    });
  });
}

/** `1.11.1.post2` >= `1.11`, compared numerically rather than as a string —
 * "1.9" > "1.11" lexicographically, which is exactly the wrong answer here. */
export function atLeast(version: string, floor: string): boolean | null {
  const nums = (v: string): number[] =>
    (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const a = nums(version), b = nums(floor);
  if (a.length === 0) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export interface DiagnoseDeps {
  pythonPath: string;
  pythonSource: string;
  modsDir: string;
  probe?: (python: string) => Promise<Record<string, unknown> | string>;
}

/** The report, as data — so it can be tested without an editor. */
export async function collectChecks(deps: DiagnoseDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const { pythonPath, pythonSource, modsDir } = deps;

  checks.push({
    label: "interpreter setting",
    ok: true,
    detail: `${pythonPath}  (from ${pythonSource})`,
  });

  const resolvable = pythonPath.includes("/");
  if (resolvable) {
    const there = existsSync(pythonPath);
    let executable = false;
    if (there) { try { accessSync(pythonPath, constants.X_OK); executable = true; } catch { /* no */ } }
    checks.push({
      label: "interpreter exists and is executable",
      ok: there && executable,
      detail: there ? (executable ? pythonPath : `${pythonPath} is not executable`)
                    : `${pythonPath} does not exist`,
      fix: there ? "chmod +x, or point molaro.pythonPath at a different interpreter"
                 : "set molaro.pythonPath to a Python that exists ON THIS MACHINE",
    });
  }

  const probe = await (deps.probe ?? runProbe)(pythonPath);
  if (typeof probe === "string") {
    checks.push({
      label: "producer interpreter runs",
      ok: false,
      detail: probe,
      fix: "set molaro.pythonPath to a working interpreter (a venv is fine)",
    });
    return checks;
  }

  checks.push({
    label: "producer interpreter runs",
    ok: true,
    detail: `python ${String(probe.version)} at ${String(probe.executable)}`,
  });

  const dep = (name: string, required: boolean, why: string): void => {
    const v = probe[name];
    if (typeof v === "string") {
      checks.push({ label: `${name}`, ok: true, detail: v });
    } else {
      const e = (v as { error?: string })?.error ?? "not importable";
      checks.push({
        label: `${name}`,
        ok: required ? false : null,
        detail: e,
        fix: required ? `pip install ${name}  (into the interpreter above)` : `optional — ${why}`,
      });
    }
  };
  dep("numpy", true, "");
  dep("mdtraj", true, "");
  dep("scipy", false, "used by some neighbour searches");
  dep("netCDF4", false, "the supported backend for .nc trajectories");

  const mdv = probe.mdtraj;
  if (typeof mdv === "string") {
    const okVer = atLeast(mdv, MDTRAJ_FLOOR);
    checks.push({
      label: `mdtraj >= ${MDTRAJ_FLOOR}`,
      ok: okVer,
      detail: okVer === null ? `could not parse version ${mdv!}` : `${mdv}`,
      fix: `mdtraj ${MDTRAJ_FLOOR} or newer is required — 1.10's Residue.is_nucleic raises`,
    });
  }

  // THE CAPABILITY CHECK, which is the one that matters: a version can be
  // patched, vendored or mis-reported, and what breaks the producer is the call
  // itself. This is the difference between "mdtraj available" (true, and useless)
  // and "Molaro can run" (the actual question).
  const nuc = probe.is_nucleic as { answers?: boolean; error?: string } | undefined;
  if (nuc) {
    checks.push({
      label: "mdtraj capability: Residue.is_nucleic answers",
      ok: nuc.answers === true,
      detail: nuc.answers ? "answers" : (nuc.error ?? "raises"),
      fix: "upgrade mdtraj — the producer calls this on every real dataset",
    });
  }

  const noise = String(probe.__stdout_noise ?? "");
  checks.push({
    label: "interpreter stdout is clean",
    ok: noise === "",
    detail: noise === "" ? "no stray output" : `stray stdout: ${noise.slice(0, 160)}`,
    fix: "stray stdout from a C extension can corrupt the length-framed protocol",
  });

  let writable: boolean | null = null;
  let modsDetail = modsDir;
  if (existsSync(modsDir)) {
    try { accessSync(modsDir, constants.W_OK); writable = true; }
    catch { writable = false; modsDetail = `${modsDir} — exists but is not writable`; }
  } else {
    writable = false;
    modsDetail = `${modsDir} — does not exist`;
  }
  checks.push({
    label: "mods directory writable",
    ok: writable,
    detail: modsDetail,
    fix: "set molaro.modsDir to a path on THIS machine (it is machine-scoped, so it " +
         "does not sync from another one)",
  });

  return checks;
}

export function renderReport(checks: Check[]): string {
  const mark = (ok: boolean | null): string => (ok === true ? "ok  " : ok === false ? "FAIL" : "?   ");
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = ["Molaro diagnostics", "=".repeat(60)];
  for (const c of checks) {
    lines.push(`  ${mark(c.ok)}  ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.ok !== true && c.fix) lines.push(`        ${" ".repeat(width)}  -> ${c.fix}`);
  }
  const bad = checks.filter((c) => c.ok === false).length;
  lines.push("=".repeat(60));
  lines.push(bad === 0
    ? "All checks passed. If the viewer still misbehaves, the Producer output channel has the detail."
    : `${bad} check${bad === 1 ? "" : "s"} failed — the first FAIL above is usually the cause.`);
  return lines.join("\n");
}
