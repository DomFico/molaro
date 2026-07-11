/**
 * The allow-list EQUALITY assertion — the guarantee the deny-list could not
 * make. This spawns the SDK with our REAL hardened options (a fake key, no
 * network needed — the init message is local) and reads the model's ACTUAL
 * runtime tool surface from the init system message, then asserts it EQUALS
 * exactly our five MCP tools. A deny-list only catches names someone thought to
 * write down; a live run showed `ToolSearch` (and, it turned out, a dozen more
 * managed-agent tools plus the user's claude.ai MCP connectors) sailing past a
 * green deny-list. This test fails the moment ANY tool beyond our five appears
 * — a sixth tool, or a leaked SDK/connector tool, both fail the equality.
 *
 * Runs a subprocess (node + the SDK's JS bridge); ~1s, offline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeRuntimeToolSurface } from "../src/claudebackend.ts";
import { EXPECTED_TOOL_SURFACE, type ToolDeps } from "../src/claudetools.ts";

const stubDeps: ToolDeps = {
  getContext: async () => ({
    system: "x", nAtoms: 0, nFrames: 0, categories: [], groups: [],
    subgroupCount: 0, subgroupKinds: [], subgroupKindsCapped: false,
    pointTypes: [], pointTypesCapped: false,
    targetExamples: [], committedSelections: "", mods: [],
    baseLook: { pointSize: 3, opacity: 1, color: "#e6e6e6" },
  }),
  writeMod: async (s) => ({ name: s.name, file: "x" }),
  deleteMod: async () => ({ ok: true, message: "" }),
  runMod: async () => ({ ok: true, message: "" }),
  runCommand: async () => ({ ok: true, message: "" }),
  analysisModNames: () => [],
};

test("runtime tool surface EQUALS exactly our five MCP tools — nothing else", async () => {
  const { tools, mcpServers } = await probeRuntimeToolSurface(stubDeps);
  const expected = [...EXPECTED_TOOL_SURFACE].sort();
  assert.equal(expected.length, 5, "the surface is exactly five — a sixth (or a leak) fails the equality below");
  const leak = tools.filter((t) => !expected.includes(t));
  assert.deepEqual(
    tools, expected,
    `the runtime surface must be EXACTLY our five MCP tools. Unexpected tool(s) present: ` +
    `${JSON.stringify(leak)} — a leak (a new SDK/managed-agent tool or a config regression). ` +
    `If a tool is genuinely unsuppressible and safe, add it to EXPECTED_TOOL_SURFACE with a comment justifying it.`,
  );
  // and only OUR MCP server — no ambient connectors (Gmail/Drive/Calendar/…)
  assert.deepEqual(mcpServers, ["molaro"], `only the molaro MCP server may be present; got ${JSON.stringify(mcpServers)}`);
});
