/**
 * The durable guard against the system prompt rotting away from the grammar
 * (Part C). Every worked `run_command` example the prompt teaches must actually
 * RESOLVE against the real address resolver — a wrong example is worse than an
 * omitted one, because the assistant will believe it. The commands are rendered
 * INTO the prompt from GRAMMAR_EXAMPLES, so this test verifies the exact strings
 * the model sees.
 *
 * The examples use protein/residue labels (polymer.A.ASP* …), so we resolve them
 * against a residue-structured fixture that mirrors a real system's shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { Header } from "../contract/contract.ts";
import { buildTree } from "../webview/classification.ts";
import { Hierarchy } from "../webview/sets.ts";
import { parseTarget, resolveTarget, type TargetAst } from "../webview/address.ts";
import { GRAMMAR_EXAMPLES } from "../src/claudeprompt.ts";

// A protein-like fixture: chain A of 20 residues (name + resSeq), 3 atoms each
// (N/CA/C), plus 2 waters — enough for every prompt example to resolve.
const RES = ["MET", "ARG", "ASP", "GLU", "LYS", "HIS", "CYS", "ALA", "SER", "THR",
  "VAL", "PHE", "GLY", "LEU", "ILE", "TYR", "TRP", "PRO", "ASN", "GLN"];
function proteinHeader(): Header {
  const type: string[] = [], group_id: number[] = [], subgroup_id: number[] = [], category: number[] = [];
  const subgroups: Record<number, string> = {};
  const edges: [number, number][] = [];
  let atom = 0;
  RES.forEach((name, r) => {
    subgroups[r] = `${name} ${r + 1}`; // "MET 1", "ARG 2", …
    const base = atom;
    for (const t of ["N", "CA", "C"]) { type.push(t); group_id.push(0); subgroup_id.push(r); category.push(0); atom++; }
    edges.push([base, base + 1], [base + 1, base + 2]);            // N-CA, CA-C
    if (r > 0) edges.push([base - 1, base]);                        // prev C - this N (backbone)
  });
  // solvent is category index 3 in the list below (NOT 1 = ligand)
  for (let w = 0; w < 2; w++) { subgroups[20 + w] = `HOH ${100 + w}`; type.push("O"); group_id.push(1); subgroup_id.push(20 + w); category.push(3); atom++; }
  return {
    version: "0.1.0", name: "protein-fixture", n_points: atom, n_frames: 1, units: "nm", bbox: null,
    points: { type, group_id, subgroup_id, category },
    categories: ["polymer", "ligand", "ion", "solvent", "unknown"],
    groups: { 0: "A", 1: "W" }, subgroups,
    edges, polylines: [], channels: [],
  };
}

const header = proteinHeader();
const tree = buildTree(header);
const hier = new Hierarchy(header);
function resolveCount(expr: string): number {
  const ast = parseTarget(expr);
  if (ast.kind !== "target") return -1;
  return resolveTarget(ast as TargetAst, tree, hier, header.points.type, new Map()).length;
}

test("EVERY worked command in the system prompt has a target that RESOLVES non-empty", () => {
  assert.ok(GRAMMAR_EXAMPLES.length >= 6, "the prompt teaches a real set of examples");
  for (const { cmd, target } of GRAMMAR_EXAMPLES) {
    const n = resolveCount(target);
    assert.ok(n > 0, `prompt example \`${cmd}\` — its target "${target}" must resolve (got ${n})`);
  }
});

test("the residue-targeting examples specifically resolve (the Part C substance)", () => {
  assert.ok(resolveCount("polymer.A.ASP*,GLU*") > 0, "acidic-residue glob resolves");
  assert.ok(resolveCount("polymer.A.LYS*,ARG*,HIS*") > 0, "basic-residue glob resolves");
  assert.ok(resolveCount("polymer.A.CYS*") > 0, "single-residue glob resolves");
});

test("targetless commands (e.g. `background`) are taught in prose, NOT as resolved-target examples", () => {
  // GRAMMAR_EXAMPLES' invariant is 'every target resolves non-empty'. A targetless
  // command (background <color>) has no address to resolve, so it CANNOT live here —
  // the 2026-07-23 pass teaches it in prose with an inline example instead. This guards
  // that decision: every example carries a target expression after its verb.
  for (const { cmd } of GRAMMAR_EXAMPLES) {
    assert.ok(!/^\s*background\b/.test(cmd), `\`${cmd}\` is targetless — teach it in prose, keep it out of the resolved-target examples`);
    assert.ok(cmd.trim().split(/\s+/).length >= 2, `\`${cmd}\` must carry a target expression`);
  }
});

test("the prompt's stated nomatch/parse-error self-diagnosis is accurate", () => {
  // the level footgun the prompt warns about: an atom type in the subgroup slot
  assert.equal(resolveCount("polymer.A.CA"), 0, "`polymer.A.CA` is a nomatch (CA is one level too shallow)");
  // a genuine parse error
  assert.equal(resolveCount("polymer..A"), -1, "`polymer..A` is a parse error (empty segment)");
});
