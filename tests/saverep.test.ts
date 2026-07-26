/**
 * save_rep's serializer — the pure state→commands core. A live rep snapshot
 * in, the primitive commands that reproduce it out; and the generated mod
 * file round-trips through parseModFile as a valid `produces: commands` mod.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRepMod,
  formatPointIndices,
  rgbToHex,
  serializeRepCommands,
  SAVE_REP_AUTHOR,
  type RepSnapshot,
} from "../webview/saverep.ts";
import { parseModFile } from "../webview/recipes.ts";
import type { Binding } from "../webview/bindings.ts";
import { DEFAULT_COLOR } from "../webview/representation.ts";

// A pristine N-point snapshot: every buffer at its default, no bindings, no
// shape swaps, background at the scene default. Tests override fields per case.
function baseSnap(n: number, over: Partial<RepSnapshot> = {}): RepSnapshot {
  const color = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    color[p * 3] = DEFAULT_COLOR[0]; color[p * 3 + 1] = DEFAULT_COLOR[1]; color[p * 3 + 2] = DEFAULT_COLOR[2];
  }
  return {
    nPoints: n,
    color,
    size: new Float32Array(n).fill(3),
    opacity: new Float32Array(n).fill(1),
    style: new Float32Array(n),
    styleNames: ["standard", "matte", "glow"],
    bindings: [],
    background: [0x1e / 255, 0x1e / 255, 0x1e / 255],
    backgroundDefault: [0x1e / 255, 0x1e / 255, 0x1e / 255],
    shapes: [
      { domain: "point", names: ["sphere"], active: "sphere" },
      { domain: "edge", names: ["tube"], active: "tube" },
      { domain: "vertex", names: ["tube", "ribbon"], active: "tube" },
    ],
    edgeCustomized: false,
    traceCustomized: false,
    ...over,
  };
}

const bind = (over: Partial<Binding> = {}): Binding => ({
  channel: "energy", axis: "color", points: [0, 1], expr: "all", range: [0, 1], ...over,
});

// -- formatPointIndices: the #N compaction ---------------------------------------

test("formatPointIndices collapses runs and unions with commas", () => {
  assert.equal(formatPointIndices([3, 4, 5, 8, 10, 11, 12]), "#3-5,#8,#10-12");
  assert.equal(formatPointIndices([7]), "#7");
  assert.equal(formatPointIndices([2, 0, 1]), "#0-2"); // unsorted in, sorted out
  assert.equal(formatPointIndices([5, 5, 6]), "#5-6"); // deduped
});

test("rgbToHex round-trips a color token exactly (k/255)", () => {
  assert.equal(rgbToHex([1, 0, 0]), "#ff0000");
  assert.equal(rgbToHex([0x5a / 255, 0x7a / 255, 0x9a / 255]), "#5a7a9a");
  assert.equal(rgbToHex([0, 0, 0]), "#000000");
});

// -- serializeRepCommands: default → empty ---------------------------------------

test("a pristine scene serializes to no commands", () => {
  const r = serializeRepCommands(baseSnap(10));
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.warnings, []);
});

// -- per-point color: bucket by value, compact ranges ----------------------------

test("colored points group by value into one colorpoints per bucket", () => {
  const snap = baseSnap(12);
  const c = snap.color as Float32Array;
  const paint = (p: number, rgb: [number, number, number]): void => {
    c[p * 3] = rgb[0]; c[p * 3 + 1] = rgb[1]; c[p * 3 + 2] = rgb[2];
  };
  for (const p of [3, 4, 5]) paint(p, [1, 0, 0]); // red run
  paint(8, [1, 0, 0]);                            // red singleton (same bucket)
  for (const p of [10, 11]) paint(p, [0, 0, 1]);  // blue run
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, [
    "colorpoints #3-5,#8 #ff0000",
    "colorpoints #10-11 #0000ff",
  ]);
});

test("size / opacity / style capture only non-defaults", () => {
  const snap = baseSnap(6);
  (snap.size as Float32Array)[2] = 5;
  (snap.opacity as Float32Array)[4] = 0.5;
  (snap.style as Float32Array)[1] = 2; // "glow"
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, [
    "pointsize #2 5",
    "pointopacity #4 0.5",
    "stylepoints #1 glow",
  ]);
});

// -- bindings: point axes → bind; the offset/smoothing axis included --------------

test("a color binding is emitted as bind and its points excluded from colorpoints", () => {
  const snap = baseSnap(8, { bindings: [bind({ axis: "color", points: [0, 1, 2], range: [0, 2.5] })] });
  // even if those points hold non-default color values, the bind reproduces
  // them — they must NOT be frozen as per-point colorpoints.
  const c = snap.color as Float32Array;
  for (const p of [0, 1, 2]) { c[p * 3] = 1; c[p * 3 + 1] = 0; c[p * 3 + 2] = 0; }
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, ["bind #0-2 energy color 0 2.5"]);
});

test("a NON-DEFAULT palette rides the replay; the default emits the same line as always", () => {
  // Without the option in the emitted line, a saved look would silently
  // revert to the default ramp on replay — the invisible-loss class.
  const named = serializeRepCommands(baseSnap(8, {
    bindings: [bind({ axis: "color", points: [0, 1, 2], range: [0, 2.5], palette: "bluewhitered" })],
  }));
  assert.deepEqual(named.commands, ["bind #0-2 energy color 0 2.5 ?palette=bluewhitered"]);
  assert.deepEqual(named.warnings, [], "a palette is captured, never deferred");
  // undefined ⟺ the default (Binding.palette is canonical), so the default
  // line is byte-identical to the pre-palette one
  const plain = serializeRepCommands(baseSnap(8, {
    bindings: [bind({ axis: "color", points: [0, 1, 2], range: [0, 2.5] })],
  }));
  assert.deepEqual(plain.commands, ["bind #0-2 energy color 0 2.5"]);
});

test("an offset binding (smoothing) is emitted with no range", () => {
  const snap = baseSnap(8, {
    bindings: [bind({ channel: "smooth_offset", axis: "offset", points: [4, 5, 6, 7], range: null })],
  });
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, ["bind #4-7 smooth_offset offset"]);
});

test("edge/trace axis bindings are deferred with a warning, not emitted", () => {
  const snap = baseSnap(8, {
    bindings: [bind({ channel: "flux", axis: "bondcolor", points: [0, 1], range: [0, 1] })],
  });
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /flux.*bondcolor.*not.*point-index-addressable/);
});

// -- scene state: background + shape swaps ---------------------------------------

test("a changed background and shape swaps are captured; defaults are not", () => {
  const snap = baseSnap(4, {
    background: [0, 0, 1],
    shapes: [
      { domain: "point", names: ["sphere"], active: "sphere" }, // default → skip
      { domain: "edge", names: ["tube", "line"], active: "line" }, // swapped
      { domain: "vertex", names: ["tube", "ribbon"], active: "ribbon" }, // swapped
    ],
  });
  const r = serializeRepCommands(snap);
  assert.deepEqual(r.commands, [
    "background #0000ff",
    "shape bonds line",
    "shape traces ribbon",
  ]);
});

// -- deferral warnings for edge/trace per-element attributes ----------------------

test("edge/trace customization is reported (deferred), never silently dropped", () => {
  const r = serializeRepCommands(baseSnap(4, { edgeCustomized: true, traceCustomized: true }));
  assert.deepEqual(r.commands, []);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings.join("\n"), /header-edge attributes/);
  assert.match(r.warnings.join("\n"), /trace\/polyline attributes/);
});

// -- large replay: count reported, nothing truncated -----------------------------

test("a large replay reports its count and truncates nothing", () => {
  const snap = baseSnap(300);
  const c = snap.color as Float32Array;
  for (let p = 0; p < 300; p++) { c[p * 3] = p / 300; } // 300 distinct-ish colors
  const r = serializeRepCommands(snap);
  assert.ok(r.commands.length >= 200, "no truncation");
  assert.ok(r.warnings.some((w) => /large replay/.test(w)), "count warned");
});

// -- the generated mod file round-trips ------------------------------------------

test("buildRepMod produces a valid `produces: commands` mod that round-trips", () => {
  const commands = ["colorpoints #3-5 #ff0000", "background #0000ff", "shape traces ribbon"];
  const source = buildRepMod("myrep", commands);
  const parsed = parseModFile(source, "workspace");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;
  assert.equal(parsed.mod.name, "myrep");
  assert.equal(parsed.mod.produces, "commands");
  assert.equal(parsed.mod.author, SAVE_REP_AUTHOR);
  // the three command strings survive verbatim in the compute body
  for (const c of commands) assert.ok(parsed.mod.code.includes(c), `code carries ${c}`);
  assert.match(parsed.mod.code, /def compute\(data, target_indices\)/);
});

test("buildRepMod on an empty capture is still a valid mod (returns [])", () => {
  const parsed = parseModFile(buildRepMod("empty_rep", []), "workspace");
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  if (parsed.ok) assert.match(parsed.mod.code, /return \[\]/);
});

// -- SHAPE_DOMAIN_WORD is pinned against a swapped scene (drift guard) ------------

test("the shape domain words match the shape verb's vocabulary", () => {
  // point→points, edge→bonds, vertex→traces — if commands.ts's SHAPE_DOMAINS
  // ever changed, this reproduction would emit an unrunnable verb.
  const snap = baseSnap(2, {
    shapes: [
      { domain: "point", names: ["sphere", "cube"], active: "cube" },
      { domain: "edge", names: ["tube"], active: "tube" },
      { domain: "vertex", names: ["tube"], active: "tube" },
    ],
  });
  assert.deepEqual(serializeRepCommands(snap).commands, ["shape points cube"]);
});
